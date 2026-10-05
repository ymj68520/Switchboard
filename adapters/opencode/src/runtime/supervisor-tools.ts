/**
 * Execution Supervisor tool surface — v0.2.0 Phase 7A (directive §22-§26/§62-§64).
 *
 * The EXECUTION-ONLY operation set a Supervisor model may call. Every entry
 * maps onto an already-frozen Core domain operation — there are NO raw state
 * setters (§23: no setLifecycle/setAcceptedHead/setCandidateRevision/…).
 *
 * Boundary mechanics (prompt-independent):
 * - TRUSTED AUTHORITY (§24): sessionID/workspace/generation are injected by
 *   the runtime adapter per call; the model payload can never supply them.
 *   The trusted capability ceiling is injected the same way — a Directive can
 *   only narrow it, never elevate it (§33).
 * - ONE MUTATION PER TURN (§25): the surface refuses a second authoritative
 *   mutation after the first succeeds (`supervisor_turn_already_mutated`) —
 *   the turn must end and the next turn rebuilds context from the Store.
 * - STRUCTURED ERRORS (§62): domain failures cross the boundary as
 *   {code, message, retryable} — never as prose to re-parse.
 * - READ OPERATIONS (§20) expose exact durable records only; there is no
 *   Plan-mutation API on this surface.
 *
 * The surface is provider-neutral; the OpenCode adapters bind it into their
 * model/tool loop. It is DORMANT: nothing in the production plugin registers
 * or invokes it (§71/§72).
 */
import { UltraPlanError, isUltraPlanError } from "../core/errors.js";
import type { PlanStore } from "../memory/store.js";
import type { ExecutionSupervisorOperation } from "../core/execution-supervisor-context.js";
import type { TrustedExecutionAuthority } from "./execution-runtime.js";
import type { ExecutionCapabilityCeiling } from "../core/execution-directive.js";
import type { ExecutionPlanRef } from "../core/execution-stage.js";
import type { ExecutionRunID } from "../core/ids.js";

/** The stale-CAS domain codes the adapter maps onto the `stale_context` outcome (§63). */
const STALE_CODES = new Set(["stale_execution_run", "stale_execution_stage", "stale_candidate_revision", "stale_execution_head", "assessment_stale"]);
/** The fencing codes that immediately end writable control (§64) — never an auto-takeover. */
export const FENCING_CODES = new Set(["stale_supervisor_binding", "supervisor_session_mismatch", "workspace_mismatch", "takeover_requires_authorization"]);

export interface SupervisorToolDescriptor {
  name: ExecutionSupervisorOperation;
  description: string;
  /** TRUE = pure read; FALSE = authoritative mutation (one per turn). */
  readonly: boolean;
  /** The exact-argument contract the model must send (field → type description). */
  args: Record<string, string>;
}

export interface SupervisorToolCallResult {
  ok: boolean;
  /** JSON-serializable projection of the read record / mutation identity. */
  result?: unknown;
  error?: { code: string; message: string; retryable: boolean };
}

export interface ExecutionSupervisorToolDeps {
  store: PlanStore;
  /** TRUSTED host/user + execution-policy ceiling — injected per call (§24/§33). */
  trustedCeiling: ExecutionCapabilityCeiling;
}

const READ_ONLY = true;
const MUTATING = false;

/** The frozen §22 operation table. Names follow the existing `execution_*` runtime convention. */
const TOOL_TABLE: readonly (Omit<SupervisorToolDescriptor, "name"> & { name: ExecutionSupervisorOperation })[] = [
  { name: "execution_get_state", description: "Read the current compact execution state (run, binding, active Stage, open Window, recovery projection).", readonly: READ_ONLY, args: {} },
  { name: "execution_get_stage", description: "Read one exact ExecutionStage record by id.", readonly: READ_ONLY, args: { stageID: "string" } },
  { name: "execution_get_window", description: "Read one exact VerificationWindow record by id.", readonly: READ_ONLY, args: { windowID: "string" } },
  { name: "execution_get_directive", description: "Read one exact ExecutionDirective by logical id (newest revision unless revision given).", readonly: READ_ONLY, args: { directiveID: "string", revision: "number?" } },
  { name: "execution_get_report", description: "Read one exact durable ExecutionReport by id.", readonly: READ_ONLY, args: { reportID: "string" } },
  { name: "execution_get_commit", description: "Read one exact ExecutionCommit by id.", readonly: READ_ONLY, args: { commitID: "string" } },
  { name: "execution_get_conflict", description: "Read one exact VerificationConflict by id.", readonly: READ_ONLY, args: { conflictID: "string" } },
  { name: "execution_get_issue", description: "Read the run's ExecutionIssue (replan record), if any.", readonly: READ_ONLY, args: {} },
  { name: "execution_read_plan_ref", description: "Read one exact FinalPlan-reachable plan ref (final_plan/section_revision/decision/constraint/implementation_step).", readonly: READ_ONLY, args: { ref: "ExecutionPlanRef" } },
  { name: "execution_create_stages", description: "Create a Stage decomposition batch under the active run (mandatory dependsOn DAG, explicit completion obligations).", readonly: MUTATING, args: { drafts: "ExecutionStageDraft[]" } },
  { name: "execution_activate_stage", description: "Activate one pending Stage (CAS on run/stage revisions).", readonly: MUTATING, args: { stageID: "string", expectedRunRevision: "number", expectedStageRevision: "number" } },
  { name: "execution_open_window", description: "Open the single candidate VerificationWindow for the active Stage (CAS).", readonly: MUTATING, args: { stageID: "string", expectedRunRevision: "number", expectedStageRevision: "number" } },
  { name: "execution_issue_directive", description: "Issue an immutable ExecutionDirective to the current window (CAS). The capability ceiling is host-injected; the draft may only narrow it.", readonly: MUTATING, args: { stageID: "string", windowID: "string", expectedRunRevision: "number", expectedStageRevision: "number", expectedWindowRevision: "number", draft: "ExecutionDirectiveDraft" } },
  { name: "execution_submit_assessment", description: "Submit the immutable SupervisorAssessment for the exact window candidate (accept runs the Core acceptance gate).", readonly: MUTATING, args: { stageID: "string", windowID: "string", candidateRevision: "number", draft: "SupervisorAssessmentDraft" } },
  { name: "execution_create_verification_conflict", description: "Create ONE disputed-fact record from exact current-candidate evidence (blinded one-resolver protocol).", readonly: MUTATING, args: { stageID: "string", windowID: "string", candidateRevision: "number", evidenceA: "VerificationEvidenceRef", evidenceB: "VerificationEvidenceRef", claimA: "string", claimB: "string", resolutionQuestion: "string" } },
  { name: "execution_record_reconciliation", description: "Record the durable AttemptReconciliation over the COMPLETE unresolved side-effecting indeterminate set after a successful inspection report.", readonly: MUTATING, args: { stageID: "string", windowID: "string", targetAttemptIDs: "string[]", inspectionDirective: "{id, revision}" } },
  { name: "execution_transition_replan", description: "Transition the run to terminal replan_required behind a request_replan assessment (atomic ExecutionIssue).", readonly: MUTATING, args: { sourceAssessmentID: "string", reason: "string", affectedPlanRefs: "ExecutionPlanRef[]", expectedRunRevision: "number" } },
  { name: "execution_prepare_final_closure", description: "Prepare the ONE final_closure Stage when all ordinary Stages are complete (explicit obligations covering the FinalPlan and all hard Constraints).", readonly: MUTATING, args: { expectedRunRevision: "number", title: "string", objective: "string", completionObligations: "{description, planRefs}[]" } },
  { name: "execution_complete_run", description: "Run the ExecutionCompletionGate (durable ExecutionCompletionRecord; idempotent).", readonly: MUTATING, args: { completionID: "string?", expectedFinalCommitID: "string?" } },
];

/** §88 — the model-facing operation specs (surfaced verbatim in the context). */
export const EXECUTION_SUPERVISOR_OPERATION_SPECS: readonly SupervisorToolDescriptor[] = TOOL_TABLE;


export function executionSupervisorToolTable(): readonly SupervisorToolDescriptor[] {
  return TOOL_TABLE.map(({ name, description, readonly: readonlyTool, args }) => ({ name, description, readonly: readonlyTool, args }));
}

/** One Supervisor control turn's tool executor. */
export class ExecutionSupervisorToolSurface {
  private mutated = false;

  constructor(private readonly deps: ExecutionSupervisorToolDeps) {}

  /** TRUE once an authoritative mutation has succeeded in THIS turn (§25). */
  get hasMutated(): boolean {
    return this.mutated;
  }

  get tools(): readonly SupervisorToolDescriptor[] {
    return executionSupervisorToolTable();
  }

  private fail(code: string, message: string): SupervisorToolCallResult {
    return { ok: false, error: { code, message, retryable: STALE_CODES.has(code) } };
  }

  private domainError(error: unknown): SupervisorToolCallResult {
    if (isUltraPlanError(error)) {
      return { ok: false, error: { code: error.code, message: error.message, retryable: STALE_CODES.has(error.code) } };
    }
    return { ok: false, error: { code: "invalid_tool_arguments", message: error instanceof Error ? error.message : String(error), retryable: false } };
  }

  private assertNotMutated(): void {
    if (this.mutated) {
      throw new UltraPlanError(
        "supervisor_turn_already_mutated",
        "This Supervisor turn already performed its ONE authoritative mutation; the turn must end and a fresh turn must rebuild context from the Store (§25)",
        {},
      );
    }
  }

  /** Runtime-boundary ids are plain strings; Core inputs are branded. */
  private runID(args: Record<string, unknown>): ExecutionRunID {
    return this.requireRunID(args) as ExecutionRunID;
  }

  /**
   * Execute one tool call with INJECTED authority. `args` is the model
   * payload — it may carry business fields only; authority fields on it are
   * ignored by construction (they are never read).
   */
  async execute(
    name: string,
    args: Record<string, unknown>,
    authority: TrustedExecutionAuthority,
  ): Promise<SupervisorToolCallResult> {
    const tool = TOOL_TABLE.find((entry) => entry.name === name);
    if (!tool) {
      return this.fail("unknown_execution_tool", `"${name}" is not an Execution Supervisor operation`);
    }
    if (typeof args !== "object" || args === null || Array.isArray(args)) {
      return this.fail("invalid_tool_arguments", "Tool arguments must be a JSON object");
    }
    try {
      const result = await this.dispatch(tool.name, args, authority);
      if (!tool.readonly) this.mutated = true;
      return { ok: true, result };
    } catch (error) {
      return this.domainError(error);
    }
  }

  private requireString(args: Record<string, unknown>, field: string): string {
    const value = args[field];
    if (typeof value !== "string" || value.length === 0) {
      throw new UltraPlanError("invalid_tool_arguments", `Tool argument "${field}" must be a non-empty string`, { field });
    }
    return value;
  }

  private requireNumber(args: Record<string, unknown>, field: string): number {
    const value = args[field];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new UltraPlanError("invalid_tool_arguments", `Tool argument "${field}" must be a number`, { field });
    }
    return value;
  }

  private auth(authority: TrustedExecutionAuthority) {
    return { sessionID: authority.sessionID, workspace: authority.workspace, generation: authority.generation };
  }

  private async dispatch(
    name: ExecutionSupervisorOperation,
    args: Record<string, unknown>,
    authority: TrustedExecutionAuthority,
  ): Promise<unknown> {
    const store = this.deps.store;
    switch (name) {
      // -- reads (§20) -------------------------------------------------------
      case "execution_get_state": {
        const run = await store.getExecutionRun(this.runID(args));
        if (!run) throw new UltraPlanError("execution_run_not_found", "no such run", {});
        const binding = await store.findSupervisorBinding(run.id);
        const stage = run.activeStage !== undefined ? await store.getExecutionStage(run.activeStage) : undefined;
        const window = run.openWindow !== undefined ? await store.getVerificationWindow(run.openWindow) : undefined;
        const recovery = await store.buildExecutionRecoveryContext(run.id, { sessionID: authority.sessionID });
        return { run, binding, stage, window, recovery };
      }
      case "execution_get_stage":
        return store.getExecutionStage(this.requireString(args, "stageID") as never);
      case "execution_get_window":
        return store.getVerificationWindow(this.requireString(args, "windowID") as never);
      case "execution_get_directive": {
        const revision = args["revision"];
        return store.getExecutionDirective(this.requireString(args, "directiveID") as never, typeof revision === "number" ? revision : undefined);
      }
      case "execution_get_report":
        return store.getExecutionReport(this.requireString(args, "reportID") as never);
      case "execution_get_commit":
        return store.getExecutionCommit(this.requireString(args, "commitID") as never);
      case "execution_get_conflict":
        return store.getVerificationConflict(this.requireString(args, "conflictID") as never);
      case "execution_get_issue":
        return store.findExecutionIssueForRun(this.runID(args));
      case "execution_read_plan_ref": {
        const ref = args["ref"];
        if (typeof ref !== "object" || ref === null) {
          throw new UltraPlanError("invalid_tool_arguments", 'Tool argument "ref" must be an ExecutionPlanRef object', {});
        }
        return this.readPlanRef(ref as ExecutionPlanRef);
      }
      // -- control (frozen domain operations only, §23) ----------------------
      case "execution_create_stages": {
        this.assertNotMutated();
        const drafts = args["drafts"];
        if (!Array.isArray(drafts)) {
          throw new UltraPlanError("invalid_tool_arguments", 'Tool argument "drafts" must be an array', {});
        }
        const stages = await store.createExecutionStages({
          executionRunID: this.runID(args),
          ...this.auth(authority),
          drafts: drafts as never[],
        });
        return { stages: stages.map((stage) => ({ id: stage.id, title: stage.title, status: stage.status })) };
      }
      case "execution_activate_stage": {
        this.assertNotMutated();
        const { stage } = await store.activateExecutionStage({
          executionRunID: this.runID(args),
          stageID: this.requireString(args, "stageID") as never,
          ...this.auth(authority),
          expectedRunRevision: this.requireNumber(args, "expectedRunRevision"),
          expectedStageRevision: this.requireNumber(args, "expectedStageRevision"),
        });
        return { stage: { id: stage.id, status: stage.status } };
      }
      case "execution_open_window": {
        this.assertNotMutated();
        const { window } = await store.openVerificationWindow({
          executionRunID: this.runID(args),
          stageID: this.requireString(args, "stageID") as never,
          ...this.auth(authority),
          expectedRunRevision: this.requireNumber(args, "expectedRunRevision"),
          expectedStageRevision: this.requireNumber(args, "expectedStageRevision"),
        });
        return { window: { id: window.id, candidateRevision: window.candidateRevision } };
      }
      case "execution_issue_directive": {
        this.assertNotMutated();
        const directive = await store.issueExecutionDirective({
          executionRunID: this.runID(args),
          stageID: this.requireString(args, "stageID") as never,
          windowID: this.requireString(args, "windowID") as never,
          ...this.auth(authority),
          ceiling: this.deps.trustedCeiling,
          expectedRunRevision: this.requireNumber(args, "expectedRunRevision"),
          expectedStageRevision: this.requireNumber(args, "expectedStageRevision"),
          expectedWindowRevision: this.requireNumber(args, "expectedWindowRevision"),
          draft: this.requireObject(args, "draft") as never,
        });
        return { directive: { id: directive.id, revision: directive.revision, hash: directive.hash, kind: directive.kind } };
      }
      case "execution_submit_assessment": {
        this.assertNotMutated();
        const outcome = await store.submitSupervisorAssessment({
          executionRunID: this.runID(args),
          stageID: this.requireString(args, "stageID") as never,
          windowID: this.requireString(args, "windowID") as never,
          candidateRevision: this.requireNumber(args, "candidateRevision"),
          ...this.auth(authority),
          draft: this.requireObject(args, "draft") as never,
        });
        return {
          assessment: { id: outcome.assessment.id, disposition: outcome.assessment.disposition },
          ...(outcome.commit ? { commit: { id: outcome.commit.id } } : {}),
        };
      }
      case "execution_create_verification_conflict": {
        this.assertNotMutated();
        const { conflict } = await store.createVerificationConflict({
          executionRunID: this.runID(args),
          stageID: this.requireString(args, "stageID") as never,
          windowID: this.requireString(args, "windowID") as never,
          candidateRevision: this.requireNumber(args, "candidateRevision"),
          evidenceA: this.requireObject(args, "evidenceA") as never,
          evidenceB: this.requireObject(args, "evidenceB") as never,
          claimA: this.requireString(args, "claimA"),
          claimB: this.requireString(args, "claimB"),
          resolutionQuestion: this.requireString(args, "resolutionQuestion"),
          ...this.auth(authority),
        });
        return { conflict: { id: conflict.id, status: conflict.status } };
      }
      case "execution_record_reconciliation": {
        this.assertNotMutated();
        const inspection = this.requireObject(args, "inspectionDirective");
        const { reconciliation, created } = await store.recordAttemptReconciliation({
          executionRunID: this.runID(args),
          stageID: this.requireString(args, "stageID") as never,
          windowID: this.requireString(args, "windowID") as never,
          ...this.auth(authority),
          targetAttemptIDs: this.requireStringArray(args, "targetAttemptIDs") as never,
          inspectionDirective: { id: inspection["id"] as never, revision: inspection["revision"] as number },
        });
        return {
          created,
          ...(reconciliation
            ? { reconciliation: { id: reconciliation.id, observation: reconciliation.observation, resultingCandidateRevision: reconciliation.resultingCandidateRevision } }
            : {}),
        };
      }
      case "execution_transition_replan": {
        this.assertNotMutated();
        const { issue } = await store.transitionExecutionRunToReplanRequired({
          executionRunID: this.runID(args),
          ...this.auth(authority),
          sourceAssessmentID: this.requireString(args, "sourceAssessmentID") as never,
          reason: this.requireString(args, "reason"),
          affectedPlanRefs: this.requireArray(args, "affectedPlanRefs") as never,
          expectedRunRevision: this.requireNumber(args, "expectedRunRevision"),
          ...(typeof args["summary"] === "string" ? { summary: args["summary"] as string } : {}),
        });
        return { issue: { id: issue.id }, lifecycle: "replan_required" };
      }
      case "execution_prepare_final_closure": {
        this.assertNotMutated();
        const { stage } = await store.prepareFinalClosureStage({
          executionRunID: this.runID(args),
          ...this.auth(authority),
          expectedRunRevision: this.requireNumber(args, "expectedRunRevision"),
          title: this.requireString(args, "title"),
          objective: this.requireString(args, "objective"),
          completionObligations: this.requireArray(args, "completionObligations") as never,
        });
        return { stage: { id: stage.id, status: stage.status } };
      }
      case "execution_complete_run": {
        this.assertNotMutated();
        const { record } = await store.completeExecutionRunThroughGate({
          executionRunID: this.runID(args),
          ...this.auth(authority),
          ...(typeof args["completionID"] === "string" ? { completionID: args["completionID"] as never } : {}),
          ...(typeof args["expectedFinalCommitID"] === "string" ? { expectedFinalCommitID: args["expectedFinalCommitID"] as never } : {}),
        });
        return { completion: { id: record.id }, lifecycle: "completed" };
      }
    }
  }

  private requireObject(args: Record<string, unknown>, field: string): Record<string, unknown> {
    const value = args[field];
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new UltraPlanError("invalid_tool_arguments", `Tool argument "${field}" must be an object`, { field });
    }
    return value as Record<string, unknown>;
  }

  private requireArray(args: Record<string, unknown>, field: string): unknown[] {
    const value = args[field];
    if (!Array.isArray(value)) {
      throw new UltraPlanError("invalid_tool_arguments", `Tool argument "${field}" must be an array`, { field });
    }
    return value;
  }

  private requireStringArray(args: Record<string, unknown>, field: string): string[] {
    return this.requireArray(args, field).map((entry) => {
      if (typeof entry !== "string") {
        throw new UltraPlanError("invalid_tool_arguments", `Tool argument "${field}" must be an array of strings`, { field });
      }
      return entry;
    });
  }

  private requireRunID(args: Record<string, unknown>): string {
    // executionRunID defaults to the injected runtime's run when the tool set
    // is bound to one run; explicit ids are still accepted (exact reads).
    const value = args["executionRunID"];
    if (typeof value === "string" && value.length > 0) return value;
    if (this.boundRunID) return this.boundRunID;
    throw new UltraPlanError("invalid_tool_arguments", 'Tool argument "executionRunID" is required', {});
  }

  private boundRunID: string | undefined;

  /** Bind the surface to one ExecutionRun (the runtime adapter does this per turn). */
  bindRun(executionRunID: string): void {
    this.boundRunID = executionRunID;
  }

  /** §20 — exact plan-ref resolution (read-only; never "latest"). */
  private async readPlanRef(ref: ExecutionPlanRef): Promise<unknown> {
    const store = this.deps.store;
    switch (ref.kind) {
      case "final_plan": {
        // planID comes from the bound run's binding — resolve the run first.
        const runID = this.boundRunID;
        if (!runID) throw new UltraPlanError("invalid_tool_arguments", "executionRunID is required", {});
        const run = await store.getExecutionRun(runID as never);
        if (!run) throw new UltraPlanError("execution_run_not_found", "no such run", {});
        const finalPlan = await store.getCurrentFinalPlan(run.planID);
        if (!finalPlan || finalPlan.id !== ref.id || finalPlan.revision !== ref.revision) {
          throw new UltraPlanError("unknown_reference", `FinalPlan ${ref.id}@${ref.revision} does not resolve as the run's bound FinalPlan`, {});
        }
        return finalPlan;
      }
      case "section_revision": {
        const runID = this.boundRunID;
        if (!runID) throw new UltraPlanError("invalid_tool_arguments", "executionRunID is required", {});
        const run = await store.getExecutionRun(runID as never);
        if (!run) throw new UltraPlanError("execution_run_not_found", "no such run", {});
        const content = await store.getSectionRevision(run.planID, { id: ref.id, revision: ref.revision });
        if (!content) throw new UltraPlanError("unknown_reference", `SectionRevision ${ref.id}@${ref.revision} does not resolve`, {});
        return content;
      }
      case "decision": {
        const runID = this.boundRunID;
        if (!runID) throw new UltraPlanError("invalid_tool_arguments", "executionRunID is required", {});
        const run = await store.getExecutionRun(runID as never);
        if (!run) throw new UltraPlanError("execution_run_not_found", "no such run", {});
        const content = await store.getDecision(run.planID, { id: ref.id, revision: ref.revision });
        if (!content) throw new UltraPlanError("unknown_reference", `Decision ${ref.id}@${ref.revision} does not resolve`, {});
        return content;
      }
      case "constraint": {
        const runID = this.boundRunID;
        if (!runID) throw new UltraPlanError("invalid_tool_arguments", "executionRunID is required", {});
        const run = await store.getExecutionRun(runID as never);
        if (!run) throw new UltraPlanError("execution_run_not_found", "no such run", {});
        const finalPlan = await store.getCurrentFinalPlan(run.planID);
        const constraint = finalPlan?.constraints.find((entry) => entry.id === ref.id);
        if (!constraint) throw new UltraPlanError("unknown_reference", `Constraint ${ref.id} does not resolve in the bound FinalPlan`, {});
        return constraint;
      }
      case "implementation_step": {
        const runID = this.boundRunID;
        if (!runID) throw new UltraPlanError("invalid_tool_arguments", "executionRunID is required", {});
        const run = await store.getExecutionRun(runID as never);
        if (!run) throw new UltraPlanError("execution_run_not_found", "no such run", {});
        const finalPlan = await store.getCurrentFinalPlan(run.planID);
        const step = finalPlan?.implementationOrder.find((entry) => entry.order === ref.order);
        if (!step) throw new UltraPlanError("unknown_reference", `Implementation step #${ref.order} does not resolve in the bound FinalPlan`, {});
        return step;
      }
    }
  }
}
