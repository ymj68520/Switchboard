/**
 * Production supervised-execution pump — v0.2.0 Phase 7B (§25-§29/§53-§59).
 *
 * The MECHANICAL control loop that drives one durable supervised ExecutionRun
 * from the production controller (the /ultra-plan entry and the session.idle
 * recovery hook). It makes NO normative decisions (§26): every semantic
 * judgment belongs to the Supervisor (through the closed Phase 7A turn-outcome
 * vocabulary) and every business gate belongs to the frozen Core operations —
 * the pump only sequences canonical reads, bounded Supervisor turns, Worker
 * dispatches, and context refreshes.
 *
 * Budgets (§27) are explicit runtime configuration, NOT lifecycle facts
 * (§57): exhaustion yields a resumable outcome and leaves the ExecutionRun
 * durable-active with a fresh budget on the next pump entry. A pump never
 * aborts, fails, replans, or completes because a budget ran out.
 */
import type { PlanStore } from "../memory/store.js";
import type { ExecutionRun } from "../core/execution-run.js";
import type { WorkspaceIdentity } from "../core/execution-run.js";
import { buildExecutionRecoveryContext } from "../core/execution-recovery.js";
import { ExecutionOrchestrator } from "./execution-orchestrator.js";
import type {
  ExecutionRuntimeTracer,
  ExecutionSupervisorRuntime,
  WorkerLivenessProbe,
  ExecutionWorkerRuntime,
} from "./execution-runtime.js";
import type { ResolvedExecutionModelPolicy } from "./execution-model-policy.js";

/** §27 — the explicit runtime budgets (all required; safe defaults below). */
export interface ProductionExecutionBudgets {
  maxSupervisorTurnsPerPump: number;
  maxWorkerDispatchesPerPump: number;
  maxSupervisorReadOpsPerTurn: number;
  supervisorTimeoutMs: number;
  workerTimeoutMs: number;
  maxConsecutiveSupervisorProtocolFailures: number;
}

export const DEFAULT_PRODUCTION_EXECUTION_BUDGETS: ProductionExecutionBudgets = {
  maxSupervisorTurnsPerPump: 25,
  maxWorkerDispatchesPerPump: 25,
  maxSupervisorReadOpsPerTurn: 8,
  supervisorTimeoutMs: 5 * 60_000,
  workerTimeoutMs: 10 * 60_000,
  maxConsecutiveSupervisorProtocolFailures: 3,
};

/** §59 — startup validation fails closed; a bad value never silently degrades. */
export function validateProductionExecutionBudgets(
  budgets: ProductionExecutionBudgets,
): void {
  const integerBudgets: [keyof ProductionExecutionBudgets, number][] = [
    ["maxSupervisorTurnsPerPump", budgets.maxSupervisorTurnsPerPump],
    ["maxWorkerDispatchesPerPump", budgets.maxWorkerDispatchesPerPump],
    ["maxSupervisorReadOpsPerTurn", budgets.maxSupervisorReadOpsPerTurn],
    ["maxConsecutiveSupervisorProtocolFailures", budgets.maxConsecutiveSupervisorProtocolFailures],
  ];
  for (const [name, value] of integerBudgets) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`Invalid production execution budget ${name}=${value}: a positive integer is required`);
    }
  }
  for (const [name, value] of [
    ["supervisorTimeoutMs", budgets.supervisorTimeoutMs],
    ["workerTimeoutMs", budgets.workerTimeoutMs],
  ] as [keyof ProductionExecutionBudgets, number][]) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`Invalid production execution budget ${name}=${value}: a positive integer millisecond timeout is required`);
    }
  }
}

/** §58 — model refs are runtime policy ("provider/model"); validate the format. */
export function validateModelRef(value: string | undefined, role: string): void {
  if (value === undefined) return;
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1 || value.length === 0) {
    throw new Error(`Invalid ${role} model ref "${value}": expected a non-empty "provider/model" pair`);
  }
}

/**
 * The production runtime bundle: everything the controller needs to run the
 * mechanical pump for THIS project. Built once per project instance (from the
 * host client + adapter configuration); tests substitute port-level fakes.
 */
export interface SupervisedExecutionBundle {
  supervisor: ExecutionSupervisorRuntime;
  worker: ExecutionWorkerRuntime;
  /** The trusted project workspace identity — never model-supplied. */
  workspace: WorkspaceIdentity;
  policy: ResolvedExecutionModelPolicy;
  /** §24/§33 — the TRUSTED host/user capability ceiling, injected per call. */
  trustedCeiling: import("../core/execution-directive.js").ExecutionCapabilityCeiling;
  budgets: ProductionExecutionBudgets;
  tracer?: ExecutionRuntimeTracer;
  /**
   * §12 — the HOST's execution-start workspace observation, invoked at the
   * moment the supervised handoff prepares the initial ExecutionRun. Absent →
   * preparation fails closed (`execution_baseline_unavailable`); the
   * approval-time state is never silently reused.
   */
  executionStartBaseline?: () => Promise<import("../repository/evidence.js").RepositoryRevision>;
  /** §37/§60 — prove a running Attempt's worker is still alive; default fail-closed. */
  livenessProbe?: WorkerLivenessProbe;
}

/**
 * §48/§91 — the compact user-facing projection, built ENTIRELY from durable
 * execution state (never hidden reasoning): run identity + lifecycle, stages,
 * the open window's candidateRevision, the accepted commit head, the latest
 * report per worker role, verification/reconciliation state, and the terminal
 * record (CompletionRecord / ExecutionIssue) when present.
 */
export interface SupervisedExecutionSummary {
  executionRunID: string;
  planID: string;
  lifecycle: ExecutionRun["lifecycle"];
  finalPlan: { id: string; revision: number };
  acceptedHead?: string;
  stages: { id: string; title: string; status: string }[];
  activeStageID?: string;
  openWindow?: { id: string; candidateRevision: number };
  latestReportPerRole: { workerRole: string; result: string; directive: string }[];
  reconciliationRequired?: boolean;
  unresolvedSideEffectingAttempts?: number;
  completionRecordID?: string;
  issue?: { id: string; reason: string };
}

/** Build the §48/§91 summary from canonical Store state only. */
export async function buildSupervisedExecutionSummary(
  store: PlanStore,
  executionRunID: import("../core/ids.js").ExecutionRunID,
): Promise<SupervisedExecutionSummary> {
  const run = (await store.getExecutionRun(executionRunID))!;
  const [binding, stages, windows, commits, reports, attempts] = await Promise.all([
    store.findSupervisorBinding(executionRunID),
    store.listExecutionStagesForRun(executionRunID),
    store.listVerificationWindowsForRun(executionRunID),
    store.listExecutionCommitsForRun(executionRunID),
    store.listExecutionReportsForRun(executionRunID),
    store.listExecutionAttemptsForRun(executionRunID),
  ]);
  const recovery = buildExecutionRecoveryContext(
    run,
    binding,
    stages.find((stage) => stage.status === "active"),
    windows.find((window) => window.state === "open"),
    { sessionID: binding?.ownerSessionID ?? "" },
  )!;
  const lastDirectiveByAttempt = new Map<string, { id: string; revision: number }>();
  for (const attempt of attempts) {
    lastDirectiveByAttempt.set(attempt.id, { id: attempt.directive.id, revision: attempt.directive.revision });
  }
  const latestReportPerRole: SupervisedExecutionSummary["latestReportPerRole"] = [];
  const seenRoles = new Set<string>();
  for (const report of [...reports].reverse()) {
    const attempt = attempts.find((candidate) => candidate.id === report.attemptID);
    const role = report.workerRole;
    if (seenRoles.has(role)) continue;
    seenRoles.add(role);
    latestReportPerRole.push({
      workerRole: role,
      result: report.result,
      directive: attempt ? `${attempt.directive.id}@${attempt.directive.revision}` : "unknown",
    });
  }
  const completion = await store.findExecutionCompletionForRun(executionRunID);
  const issue = await store.findExecutionIssueForRun(executionRunID);
  const activeStage = stages.find((stage) => stage.status === "active");
  const openWindow = windows.find((window) => window.state === "open");
  return {
    executionRunID: run.id,
    planID: run.planID,
    lifecycle: run.lifecycle,
    finalPlan: { id: run.finalPlan.id, revision: run.finalPlan.revision },
    ...(commits.length > 0 ? { acceptedHead: commits[commits.length - 1]!.id } : {}),
    stages: stages.map((stage) => ({ id: stage.id, title: stage.title, status: stage.status })),
    ...(activeStage ? { activeStageID: activeStage.id } : {}),
    ...(openWindow ? { openWindow: { id: openWindow.id, candidateRevision: openWindow.candidateRevision } } : {}),
    latestReportPerRole,
    reconciliationRequired: recovery.reconciliationRequired,
    unresolvedSideEffectingAttempts: recovery.unresolvedSideEffectingAttempts.length,
    ...(completion ? { completionRecordID: completion.id } : {}),
    ...(issue ? { issue: { id: issue.id, reason: issue.reason } } : {}),
  };
}

/** §91 — compact progress lines for the existing OpenCode UI/log surface. */
export function renderSupervisedExecutionSummary(summary: SupervisedExecutionSummary): string {
  const lines = [
    `Supervised execution ${summary.executionRunID}: ${summary.lifecycle}`,
    `FinalPlan: ${summary.finalPlan.id}@${summary.finalPlan.revision}`,
  ];
  if (summary.acceptedHead) lines.push(`Accepted head: ${summary.acceptedHead}`);
  const active = summary.stages.filter((stage) => stage.status === "active");
  const done = summary.stages.filter((stage) => stage.status === "completed").length;
  lines.push(
    `Stages: ${done}/${summary.stages.length} completed` +
      (active.length > 0 ? `; active: ${active.map((stage) => `${stage.id} (${stage.title})`).join(", ")}` : ""),
  );
  if (summary.openWindow) {
    lines.push(`Open window: ${summary.openWindow.id} (candidateRevision ${summary.openWindow.candidateRevision})`);
  }
  for (const report of summary.latestReportPerRole) {
    lines.push(`Latest ${report.workerRole} report (${report.directive}): ${report.result}`);
  }
  if (summary.reconciliationRequired) {
    lines.push(
      `Reconciliation required: ${summary.unresolvedSideEffectingAttempts ?? 0} unresolved side-effecting indeterminate attempt(s)`,
    );
  }
  if (summary.completionRecordID) lines.push(`Completion record: ${summary.completionRecordID}`);
  if (summary.issue) lines.push(`ExecutionIssue ${summary.issue.id}: ${summary.issue.reason}`);
  return lines.join("\n");
}

/**
 * The closed pump-outcome vocabulary. Everything except `terminal` is
 * RESUMABLE: the ExecutionRun stays durable-active and the next pump entry
 * (same or new process, §29) continues from canonical Store state with a
 * fresh budget. Terminal outcomes are the frozen lifecycle facts.
 */
export type ProductionPumpResult =
  | {
      outcome: "terminal";
      terminal: "completed" | "replan_required" | "aborted";
      executionRunID: string;
      summary: SupervisedExecutionSummary;
    }
  | { outcome: "yielded"; reason: string; executionRunID: string; summary: SupervisedExecutionSummary }
  | { outcome: "requires_takeover"; executionRunID: string; ownerSessionID: string; summary: SupervisedExecutionSummary }
  | { outcome: "ambiguous_execution_run"; candidateRunIDs: string[] }
  | { outcome: "unbound_execution_run"; executionRunID: string }
  | { outcome: "not_recoverable"; reason: string };

/**
 * §25 — the mechanical production loop. `sessionID` is the trusted caller
 * identity; generation is resolved from the durable binding (same-session
 * resume never bumps it).
 */
export async function runProductionSupervisedExecution(
  store: PlanStore,
  bundle: SupervisedExecutionBundle,
  input: { executionRunID: string; sessionID: string },
): Promise<ProductionPumpResult> {
  const executionRunID = input.executionRunID as import("../core/ids.js").ExecutionRunID;
  const existing = await store.getExecutionRun(executionRunID);
  if (!existing) {
    return { outcome: "not_recoverable", reason: `ExecutionRun ${input.executionRunID} does not exist` };
  }
  if (existing.lifecycle === "completed" || existing.lifecycle === "replan_required" || existing.lifecycle === "aborted") {
    return { outcome: "terminal", terminal: existing.lifecycle, executionRunID: existing.id, summary: await buildSupervisedExecutionSummary(store, executionRunID) };
  }

  const orchestrator = new ExecutionOrchestrator({
    store,
    supervisor: bundle.supervisor,
    worker: bundle.worker,
    policy: bundle.policy,
    workspace: bundle.workspace,
    trustedCeiling: bundle.trustedCeiling,
    ...(bundle.tracer ? { tracer: bundle.tracer } : {}),
    ...(bundle.livenessProbe ? { livenessProbe: bundle.livenessProbe } : {}),
  });

  // Deterministic recovery entry (§57-§61): the only takeover path is the
  // controller's explicit user action, never this pump.
  const recovery = await orchestrator.recoverSupervisedExecution({ sessionID: input.sessionID });
  if (recovery.status === "none") {
    return { outcome: "not_recoverable", reason: "No recoverable ExecutionRun in this workspace" };
  }
  if (recovery.status === "ambiguous") {
    return { outcome: "ambiguous_execution_run", candidateRunIDs: recovery.candidateRunIDs };
  }
  if (recovery.status === "requires_takeover") {
    return {
      outcome: "requires_takeover",
      executionRunID: recovery.executionRunID,
      ownerSessionID: recovery.ownerSessionID,
      summary: await buildSupervisedExecutionSummary(store, recovery.executionRunID as import("../core/ids.js").ExecutionRunID),
    };
  }
  if (recovery.status === "unbound") {
    return { outcome: "unbound_execution_run", executionRunID: recovery.executionRunID };
  }
  const binding = (await store.findSupervisorBinding(executionRunID))!;
  const generation = binding.generation;

  let turns = 0;
  let dispatches = 0;
  let consecutiveProtocolFailures = 0;
  const budgets = bundle.budgets;

  for (;;) {
    const run = (await store.getExecutionRun(executionRunID))!;
    if (run.lifecycle !== "active") {
      return { outcome: "terminal", terminal: run.lifecycle as "completed" | "replan_required" | "aborted", executionRunID: run.id, summary: await buildSupervisedExecutionSummary(store, executionRunID) };
    }
    if (turns >= budgets.maxSupervisorTurnsPerPump || dispatches >= budgets.maxWorkerDispatchesPerPump) {
      // §28 — exhaustion NEVER mutates lifecycle: a resumable yield.
      return { outcome: "yielded", reason: "budget_exhausted", executionRunID: run.id, summary: await buildSupervisedExecutionSummary(store, executionRunID) };
    }
    turns += 1;
    const turn = await bundle.supervisor.runExecutionSupervisorTurn({
      executionRunID,
      trustedAuthority: { sessionID: input.sessionID, workspace: bundle.workspace, generation },
    });
    switch (turn.outcome) {
      case "directive_issued": {
        dispatches += 1;
        consecutiveProtocolFailures = 0;
        const dispatch = await orchestrator.dispatchIssuedDirective({
          executionRunID: run.id,
          directive: turn.directive,
          sessionID: input.sessionID,
          generation,
        });
        void dispatch; // the dispatch is durable (Report/indeterminate); the loop refreshes from the store.
        continue;
      }
      case "state_mutated":
        consecutiveProtocolFailures = 0;
        continue;
      case "stale_context":
        // §53 — refresh and retry with fresh context; still a bounded turn.
        continue;
      case "awaiting_supervisor":
      case "blocked_runtime": {
        // §54/§55 — no business mutation happened; repeated non-progress
        // turns yield to the user instead of looping forever. The run stays
        // active and fully resumable.
        consecutiveProtocolFailures += 1;
        if (consecutiveProtocolFailures >= budgets.maxConsecutiveSupervisorProtocolFailures) {
          return {
            outcome: "yielded",
            reason: turn.outcome === "awaiting_supervisor" ? "awaiting_supervisor" : `blocked_runtime:${turn.code ?? turn.reason}`,
            executionRunID: run.id,
            summary: await buildSupervisedExecutionSummary(store, executionRunID),
          };
        }
        continue;
      }
      case "fencing_failure":
        // §64 — writable control ended for this session; never an auto-takeover.
        return { outcome: "yielded", reason: "fencing_failure", executionRunID: run.id, summary: await buildSupervisedExecutionSummary(store, executionRunID) };
      case "replan_required":
        return { outcome: "terminal", terminal: "replan_required", executionRunID: run.id, summary: await buildSupervisedExecutionSummary(store, executionRunID) };
      case "completed":
        return { outcome: "terminal", terminal: "completed", executionRunID: run.id, summary: await buildSupervisedExecutionSummary(store, executionRunID) };
    }
  }
}
