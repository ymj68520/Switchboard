/**
 * Final execution closure application service (v0.2.0 E10 §9–§10/§38–§44/
 * §48/§55–§56).
 *
 * Authority model: the final closure is RUN-LEVEL execution validation, never
 * another Stage (E10 §4). It reuses the ordinary execution protocol —
 * VerificationWindow → Directive → Attempt → Worker → Report →
 * SupervisorAssessment → ExecutionCommit — under scope = final_closure
 * (E10 §1/§5). Only the Supervisor may BEGIN it, explicitly, at the E7
 * all_stages_completed boundary; nothing auto-opens the Final Closure Window
 * at completion/SessionStart/compaction/get_state/recovery time (E10 §10).
 *
 * The ExecutionCompletionGate (E10 §38) is the ONE active → completed
 * authority: it runs INSIDE the final accept transaction, after the Final
 * ExecutionCommit, the accepted window close, and the acceptedHead CAS, and
 * every condition must hold before completeExecutionRunByFinalCommitInTx
 * transitions the run. Any failure rolls back the whole transaction (E10 §42) —
 * no accept assessment, no Final Commit, no window close, no head movement,
 * no binding change (E10-T47..T49).
 */

import type { ExecutionRun } from "../core/execution-run.js";
import type { ExecutionStage } from "../core/execution-stage.js";
import type { VerificationWindow } from "../core/verification-window.js";
import {
  deriveExecutionCompletionValidationRequirement,
  directiveCarriesExecutionCompletionVerification,
  executionRunCompletionObligation,
  EXECUTION_RUN_COMPLETION_REQUIREMENT,
  type CompletedStageProvenance,
  type ExecutionCompletionSemantics,
} from "../core/execution-completion.js";
import { stageObjectiveHash } from "../core/stage-completion.js";
import { isAttemptUnresolvedIndeterminateInTx } from "./recovery-fence.js";
import { RuntimeError } from "../runtime/errors.js";
import { getExecutionRunInTx, completeExecutionRunByFinalCommitInTx } from "../store/execution-runs.js";
import {
  getActiveExecutionStageInTx,
  getOpenWindowInTx,
  getWindowByIdInTx,
  insertFinalClosureWindowInTx,
  listExecutionStagesInTx,
} from "../store/execution-structure.js";
import {
  getAcceptedHeadCommitIdInTx,
  getCompletionCommitIdInTx,
  getExecutionCommitInTx,
} from "../store/execution-commits.js";
import { listWindowDirectivesInTx } from "../store/execution-directives.js";
import { getRunningAttemptInTx, listRunAttemptsInTx, getAttemptForDirectiveInTx } from "../store/execution-attempts.js";
import { getReportForAttemptInTx } from "../store/execution-reports.js";
import { getFinalPlanInTx } from "../store/finalization.js";
import { requireCurrentSupervisorAuthorityInTx } from "../store/supervisor-bindings.js";
import { listBlockingConflictsInTx } from "./verification-conflict-service.js";
import { loadVerificationPolicyStateInTx } from "./verification-policy-service.js";
import type { StoreClock } from "../store/migration-runner.js";
import type { PlanStore } from "../store/sqlite-store.js";
import type { StoreTx } from "../store/transaction.js";

function finalClosureError(
  code:
    | "FINAL_CLOSURE_NOT_READY"
    | "FINAL_CLOSURE_ALREADY_OPEN"
    | "FINAL_CLOSURE_REQUIRED"
    | "EXECUTION_COMPLETION_OBLIGATION_REQUIRED"
    | "EXECUTION_COMPLETION_OBLIGATION_INVALID"
    | "EXECUTION_COMPLETION_VERIFICATION_REQUIRED"
    | "EXECUTION_COMPLETION_ATTEMPT_RUNNING"
    | "EXECUTION_COMPLETION_INDETERMINATE_WORK"
    | "EXECUTION_COMPLETION_GATE_FAILED"
    | "EXECUTION_ALREADY_COMPLETED"
    | "EXECUTION_SCOPE_INVALID",
  message: string,
  detail?: Record<string, unknown>,
): RuntimeError {
  return new RuntimeError(code, message, { detail, recoverable: false });
}

// ---------------------------------------------------------------------------
// Core-derived completion semantics (E10 §22–§25) — shared by the context
// surface, the begin result, and the CompletionGate. The Supervisor copies
// this identity; Core re-derives and compares it at the gate.
// ---------------------------------------------------------------------------

/**
 * E10 §23 — every non-superseded ordinary Stage with its exact accepted
 * provenance, canonical (ordinal) order. A Stage without completed_by_commit
 * provenance can never be part of a completable run (E10 §38).
 */
export function loadCompletedStageProvenanceInTx(tx: StoreTx, executionRunId: string): CompletedStageProvenance[] {
  const stages = listExecutionStagesInTx(tx, executionRunId);
  const incomplete = stages.filter((stage) => stage.status !== "completed");
  const unprovened = stages.filter((stage) => stage.status === "completed" && stage.completedByCommitId === null);
  if (incomplete.length > 0 || unprovened.length > 0) {
    throw finalClosureError(
      "FINAL_CLOSURE_NOT_READY",
      incomplete.length > 0
        ? `ExecutionRun '${executionRunId}' still has non-completed stages: [${incomplete.map((stage) => `${stage.id}:${stage.status}`).join(", ")}] (E10 §9)`
        : `completed stage(s) [${unprovened.map((stage) => stage.id).join(", ")}] carry no completed_by_commit provenance (E10 §9/§38)`,
      {
        executionRunId,
        incompleteStages: incomplete.map((stage) => ({ id: stage.id, status: stage.status })),
        unprovenedStages: unprovened.map((stage) => stage.id),
      },
    );
  }
  return stages.map((stage) => ({
    id: stage.id,
    executionRunId: stage.executionRunId,
    sourceStepId: stage.sourceStepId,
    objective: stage.objective,
    sourceRefs: stage.sourceRefs,
    dependsOn: stage.dependsOn,
    completedByCommitId: stage.completedByCommitId as string,
  }));
}

/** The Core-derived completion semantics for one run at its current head. */
export function loadExecutionCompletionSemanticsInTx(
  tx: StoreTx,
  executionRunId: string,
  baseAcceptedHeadCommitId: string,
): ExecutionCompletionSemantics {
  const run = getExecutionRunInTx(tx, executionRunId);
  if (run === null) {
    throw finalClosureError("FINAL_CLOSURE_NOT_READY", `no ExecutionRun exists for '${executionRunId}'`, {
      executionRunId,
    });
  }
  return {
    executionRunId: run.executionRunId,
    finalPlanRef: run.finalPlan,
    baseAcceptedHeadCommitId,
    completedStages: loadCompletedStageProvenanceInTx(tx, executionRunId),
  };
}

// ---------------------------------------------------------------------------
// Final-closure context (E10 §55) — read-only Supervisor surface.
// ---------------------------------------------------------------------------

export interface ExecutionFinalClosureContext {
  executionRun: Pick<ExecutionRun, "executionRunId" | "lifecycle">;
  finalPlan: { id: string; revision: number; hash: string };
  acceptedHead: { commitId: string; sequence: number } | null;
  /** E10 §55 — the ordinary Stage summary: all completed, with provenance. */
  stages: Array<{
    id: string;
    ordinal: number;
    objective: string;
    objectiveHash: string;
    completedByCommitId: string | null;
  }>;
  allStagesCompleted: boolean;
  /** E10 §55 — absent | open, with the exact candidate revision. */
  finalClosureWindow:
    | { state: "absent" }
    | { state: "open"; windowId: string; candidateRevision: number; baseCommitId: string };
  /** E10 §22/§25 — the Core-derived obligation + verifier requirement. */
  completionObligation: ReturnType<typeof executionRunCompletionObligation> | null;
  completionVerificationRequirement: { requirement: string; detail: string } | null;
  verificationPolicy: ReturnType<typeof loadVerificationPolicyStateInTx>;
  currentConflicts: Array<{ conflictId: string; status: string; candidateRevision: number }>;
  /** E10 §55 — what currently blocks completion. */
  completionBlockers: {
    activeStageId: string | null;
    pendingStageIds: string[];
    runningAttemptId: string | null;
    indeterminateAttemptIds: string[];
  };
}

export function loadExecutionFinalClosureContextInTx(
  tx: StoreTx,
  executionRunId: string,
): ExecutionFinalClosureContext {
  const run = getExecutionRunInTx(tx, executionRunId);
  if (run === null) {
    throw finalClosureError("FINAL_CLOSURE_NOT_READY", `no ExecutionRun exists for '${executionRunId}'`, {
      executionRunId,
    });
  }
  const stages = listExecutionStagesInTx(tx, executionRunId);
  const activeStage = stages.find((stage) => stage.status === "active") ?? null;
  const pendingStages = stages.filter((stage) => stage.status === "pending");
  const headCommitId = getAcceptedHeadCommitIdInTx(tx, executionRunId);
  const headCommit = headCommitId === null ? null : getExecutionCommitInTx(tx, headCommitId);
  const openWindow = getOpenWindowInTx(tx, executionRunId);
  const finalWindow = openWindow !== null && openWindow.scopeKind === "final_closure" ? openWindow : null;

  // E10 §55 — the obligation is derived against the CURRENT head; it is
  // exposed only at a completable boundary (all stages completed with
  // provenance + an acceptedHead to close over). Elsewhere the context names
  // the blockers instead of fabricating an identity.
  const completable =
    headCommit !== null && activeStage === null && pendingStages.length === 0 && stages.length > 0;
  let completionObligation: ExecutionFinalClosureContext["completionObligation"] = null;
  let requirement: ExecutionFinalClosureContext["completionVerificationRequirement"] = null;
  if (completable) {
    const semantics = loadExecutionCompletionSemanticsInTx(tx, executionRunId, headCommit.commitId);
    completionObligation = executionRunCompletionObligation(semantics);
    requirement = deriveExecutionCompletionValidationRequirement(semantics);
  }

  const runningAttempt = getRunningAttemptInTx(tx, executionRunId);
  const indeterminateAttempts = listRunAttemptsInTx(tx, executionRunId).filter(
    (attempt) => attempt.state === "indeterminate",
  );
  const policyState = loadVerificationPolicyStateInTx(tx, executionRunId);
  const conflicts = finalWindow === null
    ? listBlockingConflictsInTx(tx, executionRunId)
    : listBlockingConflictsInTx(tx, executionRunId).filter((conflict) => conflict.windowId === finalWindow.id);

  return {
    executionRun: { executionRunId: run.executionRunId, lifecycle: run.lifecycle },
    finalPlan: run.finalPlan,
    acceptedHead: headCommit === null ? null : { commitId: headCommit.commitId, sequence: headCommit.sequence },
    stages: stages.map((stage) => ({
      id: stage.id,
      ordinal: stage.ordinal,
      objective: stage.objective,
      objectiveHash: stageObjectiveHashOf(stage),
      completedByCommitId: stage.completedByCommitId,
    })),
    allStagesCompleted: activeStage === null && pendingStages.length === 0 && stages.length > 0,
    finalClosureWindow:
      finalWindow === null
        ? { state: "absent" }
        : {
            state: "open",
            windowId: finalWindow.id,
            candidateRevision: finalWindow.candidateRevision,
            baseCommitId: finalWindow.baseCommitId ?? headCommitId ?? "",
          },
    completionObligation,
    completionVerificationRequirement: requirement,
    verificationPolicy: policyState,
    currentConflicts: conflicts.map((conflict) => ({
      conflictId: conflict.conflictId,
      status: conflict.status,
      candidateRevision: conflict.candidateRevision,
    })),
    completionBlockers: {
      activeStageId: activeStage?.id ?? null,
      pendingStageIds: pendingStages.map((stage) => stage.id),
      runningAttemptId: runningAttempt?.attemptId ?? null,
      indeterminateAttemptIds: indeterminateAttempts.map((attempt) => attempt.attemptId),
    },
  };
}

// Local objectiveHash derivation for the stage summary (the stage-completion
// core is hash-only; the context stays identical to the E7 surface).
function stageObjectiveHashOf(stage: ExecutionStage): string {
  return stageObjectiveHash(stage);
}

// ---------------------------------------------------------------------------
// begin_execution_final_closure (E10 §9/§10/§56) — explicit Supervisor start.
// ---------------------------------------------------------------------------

export interface BeginFinalClosureResult {
  window: VerificationWindow;
  baseAcceptedHeadCommitId: string;
  candidateRevision: 0;
  /** E10 §56 — the Core-derived obligation + verifier requirement. */
  completionObligation: ReturnType<typeof executionRunCompletionObligation>;
  completionVerificationRequirement: { requirement: string; detail: string };
}

export interface FinalClosureAuthority {
  executionRunId: string;
  sessionId: string;
  workspaceId: string;
  generation: number;
}

/**
 * E10 §9 — the explicit start gate. Requires: run active, valid supervisor
 * fence, acceptedHead exists, no active Stage, no pending Stage, every
 * ordinary Stage completed with exact completed_by_commit provenance, no open
 * VerificationWindow, no running Attempt. Then atomically creates the Final
 * Closure Window (scope final_closure, stage NULL, base = current acceptedHead,
 * candidateRevision 0). The run is NEVER completed merely by opening it
 * (E10 §9) — completion flows only through the final accept + gate.
 */
export function beginExecutionFinalClosureInTx(
  tx: StoreTx,
  input: FinalClosureAuthority,
  clock: StoreClock,
  now: string,
): BeginFinalClosureResult {
  requireCurrentSupervisorAuthorityInTx(tx, {
    executionRunId: input.executionRunId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    generation: input.generation,
  });
  const run = getExecutionRunInTx(tx, input.executionRunId);
  if (run === null) {
    throw finalClosureError("FINAL_CLOSURE_NOT_READY", `no ExecutionRun exists for '${input.executionRunId}'`, {
      executionRunId: input.executionRunId,
    });
  }
  if (run.lifecycle === "completed") {
    throw finalClosureError(
      "EXECUTION_ALREADY_COMPLETED",
      `ExecutionRun '${run.executionRunId}' is already completed; completion is terminal (E10 §45)`,
      { executionRunId: run.executionRunId, completionCommitId: getCompletionCommitIdInTx(tx, run.executionRunId) },
    );
  }
  if (run.lifecycle !== "active") {
    throw finalClosureError(
      "FINAL_CLOSURE_NOT_READY",
      `ExecutionRun '${run.executionRunId}' is ${run.lifecycle}; final closure begins only on an active run (E10 §9)`,
      { executionRunId: run.executionRunId, lifecycle: run.lifecycle },
    );
  }
  const openWindow = getOpenWindowInTx(tx, input.executionRunId);
  if (openWindow !== null) {
    throw finalClosureError(
      openWindow.scopeKind === "final_closure" ? "FINAL_CLOSURE_ALREADY_OPEN" : "FINAL_CLOSURE_NOT_READY",
      openWindow.scopeKind === "final_closure"
        ? `the Final Closure Window '${openWindow.id}' is already open; resume it (E10 §48)`
        : `stage window '${openWindow.id}' is still open; finish the Stage protocol first (E10 §9)`,
      { executionRunId: input.executionRunId, windowId: openWindow.id, scopeKind: openWindow.scopeKind },
    );
  }
  const stages = listExecutionStagesInTx(tx, input.executionRunId);
  const activeStage = getActiveExecutionStageInTx(tx, input.executionRunId);
  const pendingStages = stages.filter((stage) => stage.status === "pending");
  if (activeStage !== null || pendingStages.length > 0) {
    throw finalClosureError(
      "FINAL_CLOSURE_NOT_READY",
      `final closure requires the all_stages_completed boundary (active: ${activeStage?.id ?? "none"}, pending: [${pendingStages.map((stage) => stage.id).join(", ")}]) (E10 §9)`,
      { executionRunId: input.executionRunId, activeStageId: activeStage?.id ?? null, pendingStageIds: pendingStages.map((stage) => stage.id) },
    );
  }
  const running = getRunningAttemptInTx(tx, input.executionRunId);
  if (running !== null) {
    throw finalClosureError(
      "EXECUTION_COMPLETION_ATTEMPT_RUNNING",
      `attempt '${running.attemptId}' is still running; no final-closure start while Worker work is in progress (E10 §9)`,
      { attemptId: running.attemptId },
    );
  }
  const headCommitId = getAcceptedHeadCommitIdInTx(tx, input.executionRunId);
  if (headCommitId === null) {
    throw finalClosureError(
      "FINAL_CLOSURE_NOT_READY",
      `execution run '${input.executionRunId}' has no acceptedHead; there is no accepted execution to close over (E10 §9)`,
      { executionRunId: input.executionRunId },
    );
  }
  // E10 §9 — every non-superseded ordinary Stage completed WITH exact
  // provenance (throws FINAL_CLOSURE_NOT_READY otherwise).
  loadCompletedStageProvenanceInTx(tx, input.executionRunId);
  const semantics = loadExecutionCompletionSemanticsInTx(tx, input.executionRunId, headCommitId);
  const obligation = executionRunCompletionObligation(semantics);
  const window = insertFinalClosureWindowInTx(
    tx,
    { executionRunId: input.executionRunId, windowId: `win_${clock.newId()}`, baseCommitId: headCommitId },
    now,
  );
  return {
    window,
    baseAcceptedHeadCommitId: headCommitId,
    candidateRevision: 0,
    completionObligation: obligation,
    completionVerificationRequirement: deriveExecutionCompletionValidationRequirement(semantics),
  };
}

// ---------------------------------------------------------------------------
// The ExecutionCompletionGate (E10 §38–§44) — the sole active→completed
// authority. Runs INSIDE the final accept transaction; re-derives every
// condition from the Store so a fabricated assessment can never complete a run.
// ---------------------------------------------------------------------------

export interface CompletionGateInput {
  executionRunId: string;
  /** The Final ExecutionCommit (already persisted by the accept path). */
  finalCommitId: string;
  /** The Final Closure Window id. */
  windowId: string;
  /** The acceptance transaction's timestamp (stamps the completion). */
  now: string;
}

/**
 * E10 §38 — all conditions must hold. Any failure throws and rolls back the
 * whole final accept transaction (E10 §42): no assessment, no Final Commit, no
 * window close, no head movement, run stays active, binding unchanged.
 */
export function runExecutionCompletionGateInTx(tx: StoreTx, input: CompletionGateInput): ExecutionRun {
  const run = getExecutionRunInTx(tx, input.executionRunId);
  if (run === null) {
    throw finalClosureError("EXECUTION_COMPLETION_GATE_FAILED", `no ExecutionRun exists for '${input.executionRunId}'`, {
      executionRunId: input.executionRunId,
    });
  }
  if (run.lifecycle === "completed") {
    throw finalClosureError(
      "EXECUTION_ALREADY_COMPLETED",
      `ExecutionRun '${run.executionRunId}' is already completed (E10 §45)`,
      { executionRunId: run.executionRunId },
    );
  }
  if (run.lifecycle !== "active") {
    throw finalClosureError(
      "EXECUTION_COMPLETION_GATE_FAILED",
      `ExecutionRun '${run.executionRunId}' is ${run.lifecycle}; only an active run completes (E10 §38)`,
      { executionRunId: run.executionRunId, lifecycle: run.lifecycle },
    );
  }
  // A1 §16 — the bound FinalPlan is planning-scoped; resolve it through the
  // execution run's source-planning provenance.
  const finalPlanRow = getFinalPlanInTx(tx, run.runId);
  if (
    finalPlanRow === null
    || finalPlanRow.finalPlanId !== run.finalPlan.id
    || finalPlanRow.finalPlanHash !== run.finalPlan.hash
  ) {
    throw finalClosureError(
      "EXECUTION_COMPLETION_GATE_FAILED",
      `FinalPlan binding changed or is missing; the run completes only under its exact bound FinalPlan (E10 §38)`,
      { executionRunId: run.executionRunId, expected: run.finalPlan },
    );
  }
  const workspaceRow = tx
    .prepare("SELECT workspace_id FROM workspaces WHERE workspace_id = ?")
    .get(run.workspaceId);
  if (workspaceRow === undefined) {
    throw finalClosureError(
      "EXECUTION_COMPLETION_GATE_FAILED",
      `workspace '${run.workspaceId}' no longer exists; WorkspaceIdentity must be unchanged (E10 §38)`,
      { executionRunId: run.executionRunId, workspaceId: run.workspaceId },
    );
  }

  // E10 §38 — the Final Closure Window is exact/current and closed accepted.
  const window = getWindowByIdInTx(tx, input.windowId);
  if (window === null || window.executionRunId !== input.executionRunId) {
    throw finalClosureError(
      "EXECUTION_COMPLETION_GATE_FAILED",
      `final-closure window '${input.windowId}' is missing or foreign (E10 §38)`,
      { executionRunId: input.executionRunId, windowId: input.windowId },
    );
  }
  if (window.scopeKind !== "final_closure" || window.stageId !== null) {
    throw finalClosureError(
      "EXECUTION_SCOPE_INVALID",
      `window '${window.id}' is not a final-closure window (E10 §7/§38)`,
      { windowId: window.id, scopeKind: window.scopeKind, stageId: window.stageId },
    );
  }
  if (window.closureKind !== "accepted" || window.closedAt === null) {
    throw finalClosureError(
      "EXECUTION_COMPLETION_GATE_FAILED",
      `final-closure window '${window.id}' is not accepted-closed; the gate runs after the E6 window close (E10 §37/§38)`,
      { windowId: window.id, closureKind: window.closureKind },
    );
  }

  // E10 §35/§38 — the Final ExecutionCommit: exact scope, exact window, exact
  // obligation identity re-derived from the Store.
  const commit = getExecutionCommitInTx(tx, input.finalCommitId);
  if (commit === null || commit.executionRunId !== input.executionRunId) {
    throw finalClosureError(
      "EXECUTION_COMPLETION_GATE_FAILED",
      `final commit '${input.finalCommitId}' is missing or foreign (E10 §35)`,
      { executionRunId: input.executionRunId, finalCommitId: input.finalCommitId },
    );
  }
  if (commit.scopeKind !== "final_closure" || commit.stageId !== null || commit.windowId !== window.id) {
    throw finalClosureError(
      "EXECUTION_COMPLETION_GATE_FAILED",
      `commit '${commit.commitId}' is not the final-closure commit of window '${window.id}' (E10 §35/§38)`,
      { commitId: commit.commitId, scopeKind: commit.scopeKind, stageId: commit.stageId, windowId: commit.windowId },
    );
  }
  if (commit.parentCommitId !== window.baseCommitId) {
    throw finalClosureError(
      "EXECUTION_COMPLETION_GATE_FAILED",
      `final commit parent '${commit.parentCommitId}' does not equal the final-closure base '${window.baseCommitId}' (E10 §38)`,
      { commitId: commit.commitId, parent: commit.parentCommitId, base: window.baseCommitId },
    );
  }

  // E10 §38 — no active/pending ordinary Stage; exact completion provenance.
  loadCompletedStageProvenanceInTx(tx, input.executionRunId);

  // E10 §38 — no running Attempt anywhere in the run (E10 §40).
  const running = getRunningAttemptInTx(tx, input.executionRunId);
  if (running !== null) {
    throw finalClosureError(
      "EXECUTION_COMPLETION_ATTEMPT_RUNNING",
      `attempt '${running.attemptId}' is still running (E10 §40)`,
      { attemptId: running.attemptId },
    );
  }
  // E10 §39 — E10 implements NO indeterminate reconciliation, so ANY
  // unresolved indeterminate Attempt anywhere in the run fails the gate
  // closed (never ignored because its window is historical).
  // E11 §37 — only UNRESOLVED indeterminate Attempts block final completion:
  // every indeterminate Attempt in a completed Run must carry an exact
  // reconciliation resolution, and unresolved uncertainty may never survive it.
  const indeterminate = listRunAttemptsInTx(tx, input.executionRunId).filter(
    (attempt) => isAttemptUnresolvedIndeterminateInTx(tx, attempt),
  );
  if (indeterminate.length > 0) {
    throw finalClosureError(
      "EXECUTION_COMPLETION_INDETERMINATE_WORK",
      `attempt '${indeterminate[0]!.attemptId}' is indeterminate; unresolved indeterminate work blocks final completion (E10 §39)`,
      { attemptIds: indeterminate.map((attempt) => attempt.attemptId) },
    );
  }
  // E10 §30/§38 — no current unresolved VerificationConflict.
  const blockingConflicts = listBlockingConflictsInTx(tx, input.executionRunId);
  if (blockingConflicts.length > 0) {
    throw finalClosureError(
      "EXECUTION_COMPLETION_GATE_FAILED",
      `verification conflict '${blockingConflicts[0]!.conflictId}' is ${blockingConflicts[0]!.status} (E10 §30/§38)`,
      { conflictIds: blockingConflicts.map((conflict) => conflict.conflictId) },
    );
  }

  // E10 §24/§32/§38 — the commit carries EXACTLY the current completion
  // obligation, re-derived from the Store (never trusted from the assessment).
  const claims = commit.satisfiedObligations.filter((obligation) => obligation.source === "execution_run_completion");
  if (claims.length === 0) {
    throw finalClosureError(
      "EXECUTION_COMPLETION_OBLIGATION_REQUIRED",
      `the final commit carries no execution_run_completion obligation (E10 §32/§38)`,
      { commitId: commit.commitId },
    );
  }
  if (claims.length > 1) {
    throw finalClosureError(
      "EXECUTION_COMPLETION_OBLIGATION_INVALID",
      `the final commit carries ${claims.length} execution_run_completion obligations (E10 §32)`,
      { commitId: commit.commitId },
    );
  }
  const semantics = loadExecutionCompletionSemanticsInTx(tx, input.executionRunId, window.baseCommitId as string);
  const expected = executionRunCompletionObligation(semantics);
  const claim = claims[0]!;
  if (
    claim.executionRunId !== expected.executionRunId
    || claim.finalPlanHash !== expected.finalPlanHash
    || claim.baseAcceptedHeadCommitId !== expected.baseAcceptedHeadCommitId
    || claim.completedStageSetHash !== expected.completedStageSetHash
    || claim.contentHash !== expected.contentHash
  ) {
    throw finalClosureError(
      "EXECUTION_COMPLETION_OBLIGATION_INVALID",
      `the final commit's execution_run_completion identity does not match the re-derived obligation — stale or fabricated (E10 §32/§38)`,
      {
        commitId: commit.commitId,
        claimedContentHash: claim.contentHash,
        expectedContentHash: expected.contentHash,
      },
    );
  }

  // E10 §26/§38 — a fresh final completion verifier exists: a current-candidate
  // non-mutating completed verifier Report whose immutable Directive carries
  // the exact verify_execution_completion requirement. A generic verifier is
  // insufficient (E10-T31).
  const directives = listWindowDirectivesInTx(tx, window.id);
  const completionVerifiers = directives.filter(
    (directive) => directiveCarriesExecutionCompletionVerification(directive, semantics),
  );
  const freshCompletionVerification = completionVerifiers.some((directive) => {
    if (directive.kind !== "verification" || directive.baseCandidateRevision !== commit.candidateRevision) {
      return false;
    }
    if (directive.verificationPolicy?.verificationPurpose !== "normal") {
      return false;
    }
    const attempt = getAttemptForDirectiveInTx(tx, directive.directiveId, directive.revision);
    if (attempt === null || attempt.workerRole !== "verifier" || attempt.state !== "reported") {
      return false;
    }
    const report = getReportForAttemptInTx(tx, attempt.attemptId);
    return report !== null && report.result === "completed" && !report.candidateMutated;
  });
  if (!freshCompletionVerification) {
    throw finalClosureError(
      "EXECUTION_COMPLETION_VERIFICATION_REQUIRED",
      `no fresh final completion verification covers the exact candidate; the verification directive must carry the exact requirement '${EXECUTION_RUN_COMPLETION_REQUIREMENT}' binding ${expected.contentHash} (E10 §26/§28/§38)`,
      {
        windowId: window.id,
        candidateRevision: commit.candidateRevision,
        requiredVerificationRequirement: deriveExecutionCompletionValidationRequirement(semantics),
      },
    );
  }

  // E10 §42 — the atomic transition: active → completed with exact provenance.
  // The conditional UPDATE is CAS-guarded on acceptedHead == final commit.
  return completeExecutionRunByFinalCommitInTx(
    tx,
    { executionRunId: input.executionRunId, finalCommitId: input.finalCommitId },
    input.now,
  );
}

// Service wrapper.
export function createFinalClosureService(store: PlanStore, clock: StoreClock) {
  return {
    /** E10 §55 — read-only final-closure context. */
    getExecutionFinalClosureContext(input: { executionRunId: string }): ExecutionFinalClosureContext {
      return store.withRead((tx) => loadExecutionFinalClosureContextInTx(tx, input.executionRunId));
    },

    /** E10 §9 — the explicit Supervisor start of the Final Closure Window. */
    beginExecutionFinalClosure(input: FinalClosureAuthority): BeginFinalClosureResult {
      return store.withWrite((tx) => beginExecutionFinalClosureInTx(tx, input, clock, clock.nowIso()));
    },
  };
}
