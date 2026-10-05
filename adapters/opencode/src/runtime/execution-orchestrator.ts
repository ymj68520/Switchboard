/**
 * ExecutionOrchestrator — v0.2.0 Phase 7A (directive §27/§28/§41/§49/§57-§61).
 *
 * The DORMANT host orchestration service. It performs MECHANICAL sequencing
 * only — dispatch, persist, refresh, route control (§49/§50). It makes NO
 * normative decision: no rework choices, no acceptance judgments, no
 * verification scheduling (§51), no complexity classification (§52). Every
 * semantic judgment belongs to the Supervisor (through Core transactions);
 * every acceptance belongs to Core gates.
 *
 * Flow per cycle (§49):
 *   supervisor turn ── directive_issued ──► mechanical Worker dispatch (§27/§28)
 *        │                                       │ valid Report → host-owned submission (§41)
 *        │                                       └ no usable Report → Attempt indeterminate (§37-§39)
 *        ├ state_mutated / awaiting_supervisor / stale_context ──► refresh ──► next supervisor turn
 *        ├ replan_required / completed ──► terminal stop
 *        └ fencing_failure / blocked_runtime ──► stop (recovery resumes from the Store later)
 *
 * Recovery (§57-§61): deterministic on the trusted workspace + session —
 * same owner resumes WITHOUT a generation bump (§59); a different session
 * sees `requires_takeover` and NEVER auto-takes over (§58); an orphaned
 * running Attempt whose worker process cannot be PROVEN alive is failed
 * closed to indeterminate (§60/§89 — the Store stays the authority, §61).
 */
import { UltraPlanError } from "../core/errors.js";
import type { PlanStore } from "../memory/store.js";
import type { ExecutionRun, WorkspaceIdentity } from "../core/execution-run.js";
import type { ExecutionAttempt } from "../core/execution-attempt.js";
import type { ExecutionDirective, ExecutionCapabilityCeiling } from "../core/execution-directive.js";
import type { ExecutionReport } from "../core/execution-report.js";
import { assembleExecutionWorkerContext } from "../worker/context.js";
import type {
  ConflictResolutionContext,
  ExecutionWorkerContext,
  ReconciliationInspectionContext,
} from "../worker/execution-worker.js";
import type {
  ExecutionSupervisorRuntime,
  ExecutionSupervisorTurnResult,
  ExecutionWorkerRuntime,
  WorkerLivenessProbe,
  ExecutionRuntimeTracer,
  TrustedExecutionAuthority,
} from "./execution-runtime.js";
import type { ResolvedExecutionModelPolicy } from "./execution-model-policy.js";

export interface ExecutionOrchestratorDeps {
  store: PlanStore;
  supervisor: ExecutionSupervisorRuntime;
  worker: ExecutionWorkerRuntime;
  policy: ResolvedExecutionModelPolicy;
  /** §24/§33 — the TRUSTED host ceiling, injected into every dispatch. */
  trustedCeiling: ExecutionCapabilityCeiling;
  /** The trusted workspace identity of this runtime instance. */
  workspace: WorkspaceIdentity;
  tracer?: ExecutionRuntimeTracer;
  /** §60/§89 — prove a running Attempt's worker is STILL alive; unprovable → indeterminate. */
  livenessProbe?: WorkerLivenessProbe;
}

/** §57 — the deterministic recovery outcome. Never an auto-takeover (§58). */
export type SupervisedRecoveryOutcome =
  | { status: "none" }
  | { status: "ambiguous"; candidateRunIDs: string[] }
  | { status: "unbound"; executionRunID: string }
  | { status: "resumed"; executionRunID: string; orphanedAttemptMarkedIndeterminate?: string }
  | { status: "requires_takeover"; executionRunID: string; ownerSessionID: string };

export interface DispatchIssuedDirectiveInput {
  executionRunID: string;
  /** The EXACT issued directive ref (from the supervisor turn outcome). */
  directive: { id: string; revision: number; hash: string };
  sessionID: string;
  generation?: number;
}

export type DispatchIssuedDirectiveResult =
  | { kind: "reported"; attempt: ExecutionAttempt; report: ExecutionReport }
  | { kind: "indeterminate"; attempt: ExecutionAttempt; reason: string }
  | { kind: "already_consumed"; attempt: ExecutionAttempt; report?: ExecutionReport }
  | { kind: "submission_failed"; attempt: ExecutionAttempt; code: string; message: string };

export interface RunSupervisedLoopInput {
  executionRunID: string;
  sessionID: string;
  generation?: number;
  /** Bounded loop — the dormant harness never runs unbounded. */
  maxSteps?: number;
  /** Mechanical dispatch visibility for the harness/tests (§72). */
  onDispatch?: (result: DispatchIssuedDirectiveResult) => void;
}

export type SupervisedLoopResult =
  | { stopped: "terminal"; outcome: "replan_required" | "completed"; completionID?: string; steps: number }
  | { stopped: "fencing" | "blocked_runtime" | "budget"; outcome: ExecutionSupervisorTurnResult; steps: number };

export class ExecutionOrchestrator {
  constructor(private readonly deps: ExecutionOrchestratorDeps) {}

  private authority(sessionID: string, generation?: number): TrustedExecutionAuthority {
    return { sessionID, workspace: this.deps.workspace, generation: generation ?? 1 };
  }

  // -------------------------------------------------------------------------
  // §57-§61 — deterministic recovery entry.
  // -------------------------------------------------------------------------
  async recoverSupervisedExecution(input: { sessionID: string; generation?: number }): Promise<SupervisedRecoveryOutcome> {
    const candidates = await this.deps.store.listRecoverableExecutionRuns(this.deps.workspace);
    if (candidates.length === 0) return { status: "none" };
    if (candidates.length > 1) {
      return { status: "ambiguous", candidateRunIDs: candidates.map((run) => run.id) };
    }
    const run = candidates[0]!;
    const binding = await this.deps.store.findSupervisorBinding(run.id);
    if (!binding) return { status: "unbound", executionRunID: run.id };
    if (binding.ownerSessionID !== input.sessionID) {
      // §58 — a different session NEVER auto-takes over.
      return { status: "requires_takeover", executionRunID: run.id, ownerSessionID: binding.ownerSessionID };
    }
    // §59 — same authoritative session: resume WITHOUT bumping the generation.
    let orphanedAttemptMarkedIndeterminate: string | undefined;
    const running = await this.deps.store.findRunningExecutionAttempt(run.id);
    if (running) {
      const alive = this.deps.livenessProbe ? await this.deps.livenessProbe(running) : false;
      if (!alive) {
        // §60/§89 — the worker process cannot be proven alive: fail closed.
        await this.deps.store.markExecutionAttemptIndeterminate({
          executionRunID: run.id,
          attemptID: running.id,
          ...this.authority(input.sessionID, input.generation),
        });
        orphanedAttemptMarkedIndeterminate = running.id;
      }
    }
    return { status: "resumed", executionRunID: run.id, ...(orphanedAttemptMarkedIndeterminate ? { orphanedAttemptMarkedIndeterminate } : {}) };
  }

  // -------------------------------------------------------------------------
  // §27/§28 — Directive issuance is the Worker dispatch boundary. Mechanical:
  // validate exact ref → start the ONE Attempt → assemble context → invoke.
  // -------------------------------------------------------------------------
  async dispatchIssuedDirective(input: DispatchIssuedDirectiveInput): Promise<DispatchIssuedDirectiveResult> {
    const authority = this.authority(input.sessionID, input.generation);
    // Exact-ref validation BEFORE anything mechanical happens (§28).
    const directive = await this.deps.store.getExecutionDirective(input.directive.id as never, input.directive.revision);
    if (!directive || directive.hash !== input.directive.hash) {
      throw new UltraPlanError(
        "directive_hash_mismatch",
        `Directive ${input.directive.id}@${input.directive.revision} does not resolve with the presented hash; refusing to dispatch`,
        { directive: `${input.directive.id}@${input.directive.revision}` },
      );
    }
    // §88/§90 — an already-consumed Directive revision is never re-dispatched.
    const existing = await this.deps.store.findExecutionAttemptForDirective(input.executionRunID as never, {
      id: input.directive.id as never,
      revision: input.directive.revision,
    });
    if (existing) {
      const report = await this.deps.store.findExecutionReportForAttempt(existing.id);
      return { kind: "already_consumed", attempt: existing, ...(report ? { report } : {}) };
    }
    const run = (await this.deps.store.getExecutionRun(input.executionRunID as never))!;
    const { attempt } = await this.deps.store.startExecutionAttempt({
      executionRunID: input.executionRunID as never,
      directive: { id: input.directive.id as never, revision: input.directive.revision },
      sessionID: input.sessionID,
      workspace: this.deps.workspace,
      generation: authority.generation,
      ceiling: this.deps.trustedCeiling,
    });

    // §29 — the frozen Phase 4 context assembly (fail-closed on purpose).
    const context = await this.assembleContext(run, directive, attempt);
    let invocation: Awaited<ReturnType<ExecutionWorkerRuntime["invokeWorker"]>>;
    try {
      invocation = await this.deps.worker.invokeWorker({
        attempt,
        directive,
        context,
        effectiveCapabilities: context.effectiveCapabilities,
      });
    } catch (error) {
      // §54 — a Worker RUNTIME crash is not an execution failure: no usable
      // Report exists, so the Attempt fails closed to indeterminate (never a
      // fabricated failed Report).
      void error;
      const marked = await this.deps.store.markExecutionAttemptIndeterminate({
        executionRunID: input.executionRunID as never,
        attemptID: attempt.id,
        sessionID: input.sessionID,
        workspace: this.deps.workspace,
        generation: authority.generation,
      });
      return { kind: "indeterminate", attempt: marked, reason: "host_lost_result" };
    }
    if (invocation.kind === "indeterminate") {
      // §37-§39 — no fabricated Report. The Attempt becomes indeterminate;
      // follow-up semantics key on candidateEffect (P0 correction).
      const marked = await this.deps.store.markExecutionAttemptIndeterminate({
        executionRunID: input.executionRunID as never,
        attemptID: attempt.id,
        sessionID: input.sessionID,
        workspace: this.deps.workspace,
        generation: authority.generation,
      });
      return { kind: "indeterminate", attempt: marked, reason: invocation.reason };
    }
    // §41 — submission is HOST-OWNED: trusted attempt/directive/role identity.
    try {
      const { report } = await this.deps.store.submitExecutionReport({
        executionRunID: input.executionRunID as never,
        attemptID: attempt.id,
        report: invocation.payload,
        sessionID: input.sessionID,
        workspace: this.deps.workspace,
        generation: authority.generation,
      });
      return { kind: "reported", attempt: await this.deps.store.getExecutionAttempt(attempt.id) as ExecutionAttempt, report };
    } catch (error) {
      // A submission failure after a consumed Attempt leaves NO usable report
      // — fail closed to indeterminate (runtime failure, §54), never retry
      // the whole invocation (the revision is consumed).
      const marked = await this.deps.store.markExecutionAttemptIndeterminate({
        executionRunID: input.executionRunID as never,
        attemptID: attempt.id,
        sessionID: input.sessionID,
        workspace: this.deps.workspace,
        generation: authority.generation,
      });
      const code = error instanceof UltraPlanError ? error.code : "invalid_tool_arguments";
      const message = error instanceof Error ? error.message : String(error);
      return { kind: "submission_failed", attempt: marked, code, message };
    }
  }

  /** §29 — deterministic worker context (conflict/reconciliation contexts included exactly when the Directive requires them). */
  private async assembleContext(run: ExecutionRun, directive: ExecutionDirective, attempt: ExecutionAttempt): Promise<ExecutionWorkerContext> {
    const store = this.deps.store;
    const stage = (await store.getExecutionStage(attempt.stageID))!;
    const window = (await store.getVerificationWindow(attempt.windowID))!;
    const finalPlan = (await store.getCurrentFinalPlan(run.planID))!;
    const planningRun = await store.getRun(run.planID);
    let conflictResolutionContext: ConflictResolutionContext | undefined;
    let reconciliationContext: ReconciliationInspectionContext | undefined;
    if (directive.verificationPurpose === "conflict_resolution" && directive.conflictID !== undefined) {
      const conflict = await store.getVerificationConflict(directive.conflictID);
      if (!conflict) {
        throw new UltraPlanError("verification_conflict_not_found", `Directive ${directive.id}@${directive.revision} resolves a missing conflict`, {
          conflictID: directive.conflictID,
        });
      }
      conflictResolutionContext = {
        conflictID: conflict.id,
        resolutionQuestion: conflict.resolutionQuestion,
        claimA: conflict.claimA,
        claimB: conflict.claimB,
      };
    }
    if (directive.reconciliationTargets !== undefined) {
      const targets = [];
      for (const targetID of directive.reconciliationTargets) {
        const target = await store.getExecutionAttempt(targetID);
        if (!target) {
          throw new UltraPlanError("execution_attempt_not_found", `Reconciliation target ${targetID} does not resolve`, {});
        }
        targets.push({
          attemptID: target.id,
          directive: { ...target.directive },
          candidateEffect: target.candidateEffect,
          startedAt: target.startedAt,
        });
      }
      reconciliationContext = {
        objective: directive.objective,
        knownCandidateRevision: window.candidateRevision,
        baseAcceptedState: window.baseAcceptedState,
        targets,
      };
    }
    return assembleExecutionWorkerContext(store, directive, {
      planID: run.planID,
      finalPlan: run.finalPlan,
      finalPlanRecord: finalPlan,
      goal: planningRun?.goal?.statement ?? "",
      executionRunID: run.id,
      stage: { id: stage.id, title: stage.title, objective: stage.objective },
      window: { id: window.id, baseAcceptedState: window.baseAcceptedState },
      role: attempt.workerRole,
      trustedCeiling: this.deps.trustedCeiling,
      ...(conflictResolutionContext ? { conflictResolutionContext } : {}),
      ...(reconciliationContext ? { reconciliationContext } : {}),
    });
  }

  // -------------------------------------------------------------------------
  // §49 — the dormant supervised loop. Mechanical routing ONLY (§50).
  // -------------------------------------------------------------------------
  async runSupervisedLoop(input: RunSupervisedLoopInput): Promise<SupervisedLoopResult> {
    const maxSteps = input.maxSteps ?? 32;
    let steps = 0;
    while (steps < maxSteps) {
      steps++;
      const turn = await this.deps.supervisor.runExecutionSupervisorTurn({
        executionRunID: input.executionRunID as never,
        trustedAuthority: this.authority(input.sessionID, input.generation),
      });
      switch (turn.outcome) {
        case "directive_issued": {
          // §27 — the issuance ended the supervisor turn; the host dispatches.
          const dispatch = await this.dispatchIssuedDirective({
            executionRunID: input.executionRunID as never,
            directive: turn.directive,
            sessionID: input.sessionID,
            generation: input.generation,
          });
          input.onDispatch?.(dispatch);
          continue; // back to the Supervisor with fresh durable state
        }
        case "state_mutated":
        case "awaiting_supervisor":
        case "stale_context":
          continue; // refresh happens inside the next turn's context build (§26)
        case "replan_required":
          return { stopped: "terminal", outcome: "replan_required", steps };
        case "completed":
          return { stopped: "terminal", outcome: "completed", completionID: turn.completionID, steps };
        case "fencing_failure":
        case "blocked_runtime":
          return { stopped: turn.outcome === "fencing_failure" ? "fencing" : "blocked_runtime", outcome: turn, steps };
      }
    }
    return { stopped: "budget", outcome: { outcome: "awaiting_supervisor", note: "loop budget exhausted" }, steps };
  }
}
