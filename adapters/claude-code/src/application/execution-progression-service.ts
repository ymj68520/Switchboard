/**
 * Execution progression application service (v0.2.0 E7 §17–§26/§39).
 *
 * Authority model: after an accepted ExecutionCommit the Supervisor decides —
 * explicitly — whether the same Stage continues (continue_execution_stage) or
 * a completed Stage hands off to the next eligible one
 * (activate_execution_stage). Core derives the canonical progression state and
 * validates the legality of each decision; Core never chooses architecture or
 * sequencing for the Supervisor (E7 §17), never auto-opens a successor window
 * at commit/SessionStart/compaction/get_state/recovery time (E7 §21/§26), and
 * never lets a progression operation touch the acceptedHead (E7 §39 — only an
 * ExecutionCommit advances accepted state).
 *
 * Eligibility (E7 §15/§16) is derived ONLY from the approved explicit
 * dependsOn step ids: a pending Stage is eligible iff every explicit
 * predecessor maps to a materialized same-Run Stage AND that Stage is
 * completed. Ordinal is the DEFAULT order, never a dependency. Unknown or
 * ambiguous predecessor mapping fails closed (ineligible, predecessor listed)
 * and is flagged as store corruption by the schema-v20 validator.
 *
 * Completion itself lives in the acceptance gate (E7 §7/§11): completion and
 * activation are separate transactions — Core never completes Stage A and
 * activates Stage B in one atomic step (E7 §25).
 */

import type { ExecutionRun } from "../core/execution-run.js";
import type { ExecutionStage } from "../core/execution-stage.js";
import type { VerificationWindow } from "../core/verification-window.js";
import { RuntimeError } from "../runtime/errors.js";
import { getExecutionRunInTx } from "../store/execution-runs.js";
import {
  activateExecutionStageInTx as activateStagePendingToActiveInTx,
  getActiveExecutionStageInTx,
  getExecutionStageInTx,
  getOpenWindowInTx,
  listExecutionStagesInTx,
} from "../store/execution-structure.js";
import {
  getAcceptedHeadCommitIdInTx,
  getExecutionCommitInTx,
  listRunCommitsInTx,
} from "../store/execution-commits.js";
import { getRunningAttemptInTx } from "../store/execution-attempts.js";
import { requireCurrentSupervisorAuthorityInTx } from "../store/supervisor-bindings.js";
import {
  buildLayeredSupervisorContextInTx,
  type LayeredSupervisorContext,
} from "../context/execution-evolution-ledger.js";
import { openNextWindowForActiveStageInTx } from "./acceptance-service.js";
import { requireNoUnresolvedIndeterminateFenceInTx } from "./recovery-fence.js";
import type { StoreClock } from "../store/migration-runner.js";
import type { PlanStore } from "../store/sqlite-store.js";
import type { StoreTx } from "../store/transaction.js";

function progressionError(
  code:
    | "EXECUTION_PROGRESSION_BOUNDARY_INVALID"
    | "NO_ACTIVE_STAGE"
    | "STAGE_CONTINUATION_NOT_ALLOWED"
    | "ALL_STAGES_COMPLETED"
    | "STAGE_ALREADY_COMPLETED"
    | "EXECUTION_STAGE_REQUIRED"
    | "EXECUTION_STAGE_NOT_ELIGIBLE"
    | "EXECUTION_STAGE_ALREADY_ACTIVE"
    | "VERIFICATION_WINDOW_ALREADY_OPEN"
    | "ACCEPTANCE_ATTEMPT_RUNNING",
  message: string,
  detail?: Record<string, unknown>,
): RuntimeError {
  return new RuntimeError(code, message, { detail, recoverable: false });
}

// ---------------------------------------------------------------------------
// Progression context (E7 §18/§19) — read-only Supervisor surface.
// ---------------------------------------------------------------------------

export type ProgressionBoundary =
  | "active_candidate"
  | "post_commit_same_stage"
  | "between_stages"
  | "all_stages_completed";

export interface ExecutionProgressionContext {
  executionRun: Pick<ExecutionRun, "executionRunId" | "lifecycle">;
  /** The current accepted head (null only before the first commit). */
  acceptedHead: { commitId: string; sequence: number } | null;
  activeStage: { id: string; ordinal: number; objective: string } | null;
  openWindow: {
    id: string;
    candidateRevision: number;
    baseKind: VerificationWindow["baseKind"];
    baseCommitId: string | null;
  } | null;
  lastExecutionCommit: { commitId: string; sequence: number; stageId: string | null } | null;
  pendingStages: Array<{
    id: string;
    ordinal: number;
    objective: string;
    sourceStepId: string | null;
    dependsOn: string[];
  }>;
  completedStages: Array<{
    id: string;
    ordinal: number;
    objective: string;
    completedByCommitId: string | null;
  }>;
  eligibleStages: Array<{ id: string; ordinal: number }>;
  ineligibleStages: Array<{ id: string; ordinal: number; unsatisfiedPredecessors: string[] }>;
  /** UX-only default (lowest eligible ordinal); never authority (E7 §17). */
  defaultSuggestedStageId: string | null;
  progressionBoundary: ProgressionBoundary;
  /** P3 — The three-layer (L0/L1/L2) Execution Evolution Ledger projection */
  evolutionLedger?: LayeredSupervisorContext;
}

/** The explicit dependency facts of one pending Stage (E7 §15/§16). */
function deriveEligibility(
  stages: ExecutionStage[],
): Map<string, { eligible: boolean; unsatisfiedPredecessors: string[] }> {
  const stageByStep = new Map(
    stages.filter((stage) => stage.sourceStepId !== null).map((stage) => [stage.sourceStepId as string, stage]),
  );
  const eligibility = new Map<string, { eligible: boolean; unsatisfiedPredecessors: string[] }>();
  for (const stage of stages) {
    if (stage.status !== "pending") {
      continue;
    }
    const unsatisfiedPredecessors = stage.dependsOn.filter((dependency) => {
      const predecessor = stageByStep.get(dependency);
      return predecessor === undefined || predecessor.status !== "completed";
    });
    eligibility.set(stage.id, { eligible: unsatisfiedPredecessors.length === 0, unsatisfiedPredecessors });
  }
  return eligibility;
}

/**
 * The shared §19 boundary derivation — one deterministic classifier for the
 * progression context AND the recovery capsule. `eligibleStageIds` follows the
 * explicit dependsOn mapping only (E7 §15/§16); ordinal never decides.
 */
export function deriveProgressionState(
  stages: ExecutionStage[],
  openWindow: VerificationWindow | null,
  acceptedHeadCommitId: string | null,
): { boundary: ProgressionBoundary; eligibleStageIds: string[] } {
  const activeStage = stages.find((stage) => stage.status === "active") ?? null;
  const pending = stages
    .filter((stage) => stage.status === "pending")
    .sort((a, b) => a.ordinal - b.ordinal);
  const eligibility = deriveEligibility(stages);
  let boundary: ProgressionBoundary;
  if (activeStage !== null) {
    if (openWindow !== null) {
      boundary = "active_candidate";
    } else if (acceptedHeadCommitId !== null) {
      boundary = "post_commit_same_stage";
    } else {
      // Unreachable through every production path: the E3 genesis bootstrap
      // opens a window for the active stage whenever no head exists (E6 §34).
      throw progressionError(
        "EXECUTION_PROGRESSION_BOUNDARY_INVALID",
        `an active stage exists with no open window and no accepted head — corrupt execution structure`,
        { activeStageId: activeStage.id },
      );
    }
  } else if (pending.length > 0) {
    boundary = "between_stages";
  } else {
    boundary = "all_stages_completed";
  }
  return {
    boundary,
    eligibleStageIds: pending
      .filter((stage) => eligibility.get(stage.id)?.eligible === true)
      .map((stage) => stage.id),
  };
}

export function loadExecutionProgressionContextInTx(
  tx: StoreTx,
  executionRunId: string,
): ExecutionProgressionContext {
  const run = getExecutionRunInTx(tx, executionRunId);
  if (run === null) {
    throw progressionError(
      "EXECUTION_PROGRESSION_BOUNDARY_INVALID",
      `no ExecutionRun exists for '${executionRunId}'`,
      { executionRunId },
    );
  }
  if (run.lifecycle !== "active") {
    throw progressionError(
      "EXECUTION_PROGRESSION_BOUNDARY_INVALID",
      `ExecutionRun '${executionRunId}' is ${run.lifecycle}; progression context projects an active run`,
      { executionRunId, lifecycle: run.lifecycle },
    );
  }
  const stages = listExecutionStagesInTx(tx, executionRunId);
  const activeStage = stages.find((stage) => stage.status === "active") ?? null;
  const openWindow = getOpenWindowInTx(tx, executionRunId);
  const headCommitId = getAcceptedHeadCommitIdInTx(tx, executionRunId);
  const headCommit = headCommitId === null ? null : getExecutionCommitInTx(tx, headCommitId);
  const commits = listRunCommitsInTx(tx, executionRunId);
  const lastCommit = commits.length === 0 ? null : commits[commits.length - 1]!;

  const eligibility = deriveEligibility(stages);
  const pending = stages
    .filter((stage) => stage.status === "pending")
    .sort((a, b) => a.ordinal - b.ordinal);
  const eligible = pending.filter((stage) => eligibility.get(stage.id)?.eligible === true);
  const ineligible = pending.filter((stage) => eligibility.get(stage.id)?.eligible === false);

  const progressionBoundary = deriveProgressionState(stages, openWindow, headCommitId).boundary;

  return {
    executionRun: { executionRunId: run.executionRunId, lifecycle: run.lifecycle },
    acceptedHead:
      headCommit === null ? null : { commitId: headCommit.commitId, sequence: headCommit.sequence },
    activeStage:
      activeStage === null ? null : { id: activeStage.id, ordinal: activeStage.ordinal, objective: activeStage.objective },
    openWindow:
      openWindow === null
        ? null
        : {
            id: openWindow.id,
            candidateRevision: openWindow.candidateRevision,
            baseKind: openWindow.baseKind,
            baseCommitId: openWindow.baseCommitId,
          },
    lastExecutionCommit:
      lastCommit === null ? null : { commitId: lastCommit.commitId, sequence: lastCommit.sequence, stageId: lastCommit.stageId },
    pendingStages: pending.map((stage) => ({
      id: stage.id,
      ordinal: stage.ordinal,
      objective: stage.objective,
      sourceStepId: stage.sourceStepId,
      dependsOn: stage.dependsOn,
    })),
    completedStages: stages
      .filter((stage) => stage.status === "completed")
      .map((stage) => ({
        id: stage.id,
        ordinal: stage.ordinal,
        objective: stage.objective,
        completedByCommitId: stage.completedByCommitId,
      })),
    eligibleStages: eligible.map((stage) => ({ id: stage.id, ordinal: stage.ordinal })),
    ineligibleStages: ineligible.map((stage) => ({
      id: stage.id,
      ordinal: stage.ordinal,
      unsatisfiedPredecessors: eligibility.get(stage.id)?.unsatisfiedPredecessors ?? [],
    })),
    defaultSuggestedStageId: eligible.length === 0 ? null : (eligible[0]?.id ?? null),
    progressionBoundary,
    evolutionLedger: buildLayeredSupervisorContextInTx(tx, executionRunId, {
      activeStageId: activeStage?.id ?? undefined,
    }),
  };
}

// ---------------------------------------------------------------------------
// Shared Supervisor-operation fences (E7 §20/§22).
// ---------------------------------------------------------------------------

interface SupervisorOperationAuthority {
  executionRunId: string;
  /** Signed HostContext session — never model-supplied authority (E7 §22). */
  sessionId: string;
  workspaceId: string;
  generation: number;
}

/**
 * The fences BOTH progression operations share (E7 §20/§22): the E2 supervisor
 * fence, an active run, no open window, no running Attempt, and an existing
 * acceptedHead. Progression applies only after accepted execution begins
 * (E7 §23 — the genesis bootstrap owns the pre-commit world).
 */
function requireProgressionBoundaryInTx(
  tx: StoreTx,
  authority: SupervisorOperationAuthority,
): { activeStage: ExecutionStage | null; headCommitId: string } {
  requireCurrentSupervisorAuthorityInTx(tx, {
    executionRunId: authority.executionRunId,
    workspaceId: authority.workspaceId,
    sessionId: authority.sessionId,
    generation: authority.generation,
  });
  const activeStage = getActiveExecutionStageInTx(tx, authority.executionRunId);
  const openWindow = getOpenWindowInTx(tx, authority.executionRunId);
  const headCommitId = getAcceptedHeadCommitIdInTx(tx, authority.executionRunId);
  if (headCommitId === null) {
    throw progressionError(
      "EXECUTION_PROGRESSION_BOUNDARY_INVALID",
      `execution run '${authority.executionRunId}' has no accepted head; the genesis bootstrap owns the pre-commit world (E7 §23)`,
      { executionRunId: authority.executionRunId },
    );
  }
  if (openWindow !== null) {
    throw progressionError(
      "VERIFICATION_WINDOW_ALREADY_OPEN",
      `ExecutionRun '${authority.executionRunId}' still has open verification window '${openWindow.id}'; progression is a post-commit decision (E7 §20/§22)`,
      { executionRunId: authority.executionRunId, windowId: openWindow.id },
    );
  }
  const running = getRunningAttemptInTx(tx, authority.executionRunId);
  if (running !== null) {
    throw progressionError(
      "ACCEPTANCE_ATTEMPT_RUNNING",
      `attempt '${running.attemptId}' is still running; no progression while Worker work is in progress (E7 §20/§22)`,
      { attemptId: running.attemptId },
    );
  }
  return { activeStage, headCommitId };
}

// ---------------------------------------------------------------------------
// Continue the same Stage (E7 §20/§21/§30) — explicit Supervisor decision.
// ---------------------------------------------------------------------------

export interface ContinueExecutionStageResult {
  stage: ExecutionStage;
  window: VerificationWindow;
  baseCommitId: string;
}

export function continueExecutionStageInTx(
  tx: StoreTx,
  input: SupervisorOperationAuthority,
  clock: StoreClock,
  now: string,
): ContinueExecutionStageResult {
  // E11 §13 — the recovery fence precedes every boundary classification.
  requireNoUnresolvedIndeterminateFenceInTx(tx, input.executionRunId);
  const { activeStage } = requireProgressionBoundaryInTx(tx, input);
  // E11 §13 — no Stage continuation layers new work on unresolved reality.
  requireNoUnresolvedIndeterminateFenceInTx(tx, input.executionRunId);
  if (activeStage === null) {
    throw progressionError(
      "NO_ACTIVE_STAGE",
      `ExecutionRun '${input.executionRunId}' has no active stage to continue (E7 §20)`,
      { executionRunId: input.executionRunId },
    );
  }
  // E7 §20 — continuation continues THIS Stage's accepted work: the latest
  // accepted Commit must belong to the active Stage (the intermediate-commit
  // boundary). A commit from another Stage under an active Stage is not a
  // continuable state.
  const commits = listRunCommitsInTx(tx, input.executionRunId);
  const lastCommit = commits.length === 0 ? null : commits[commits.length - 1]!;
  if (lastCommit === null || lastCommit.stageId !== activeStage.id) {
    throw progressionError(
      "STAGE_CONTINUATION_NOT_ALLOWED",
      lastCommit === null
        ? `stage '${activeStage.id}' has no accepted commit; continuation requires accepted execution (E7 §20)`
        : `the latest accepted commit '${lastCommit.commitId}' belongs to stage '${lastCommit.stageId}', not the active stage '${activeStage.id}' (E7 §20)`,
      { executionRunId: input.executionRunId, activeStageId: activeStage.id, lastCommitStageId: lastCommit?.stageId ?? null },
    );
  }
  // E7 §20/§30 — the E6 §35 successor primitive opens the new window at
  // candidateRevision 0 rooted in the exact acceptedHead; the Stage remains
  // active and the acceptedHead is untouched (E7 §39).
  const { window, baseCommitId } = openNextWindowForActiveStageInTx(
    tx,
    { executionRunId: input.executionRunId },
    clock,
    now,
  );
  return { stage: activeStage, window, baseCommitId };
}

// ---------------------------------------------------------------------------
// Activate a Supervisor-selected pending Stage (E7 §22/§25/§26).
// ---------------------------------------------------------------------------

export interface ActivateExecutionStageResult {
  stage: ExecutionStage;
  window: VerificationWindow;
  baseCommitId: string;
}

export function activateExecutionStageInTx(
  tx: StoreTx,
  input: SupervisorOperationAuthority & { targetStageId: string },
  clock: StoreClock,
  now: string,
): ActivateExecutionStageResult {
  requireCurrentSupervisorAuthorityInTx(tx, {
    executionRunId: input.executionRunId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    generation: input.generation,
  });
  // E11 §13 — the recovery fence precedes every boundary classification.
  requireNoUnresolvedIndeterminateFenceInTx(tx, input.executionRunId);
  const activeStage = getActiveExecutionStageInTx(tx, input.executionRunId);
  // E11 §13 — no Stage activation layers new work on unresolved reality.
  requireNoUnresolvedIndeterminateFenceInTx(tx, input.executionRunId);
  if (activeStage !== null) {
    throw progressionError(
      "EXECUTION_STAGE_ALREADY_ACTIVE",
      `ExecutionRun '${input.executionRunId}' already has an active stage ('${activeStage.id}'); activation is a between-stages decision (E7 §22)`,
      { executionRunId: input.executionRunId, activeStageId: activeStage.id },
    );
  }
  const stages = listExecutionStagesInTx(tx, input.executionRunId);
  if (stages.every((stage) => stage.status !== "pending")) {
    throw progressionError(
      "ALL_STAGES_COMPLETED",
      `ExecutionRun '${input.executionRunId}' has no pending stage to activate — awaiting final execution closure (E7 §27)`,
      { executionRunId: input.executionRunId },
    );
  }
  // The shared post-commit boundary fences: no open window, no running
  // attempt, acceptedHead exists. (No active stage is this operation's own
  // precondition, checked above.)
  requireProgressionBoundaryInTx(tx, input);

  const target = getExecutionStageInTx(tx, input.targetStageId);
  if (target === null) {
    throw progressionError(
      "EXECUTION_STAGE_REQUIRED",
      `no ExecutionStage exists for '${input.targetStageId}'`,
      { stageId: input.targetStageId },
    );
  }
  if (target.executionRunId !== input.executionRunId) {
    throw progressionError(
      "EXECUTION_STAGE_NOT_ELIGIBLE",
      `stage '${input.targetStageId}' belongs to run '${target.executionRunId}', not '${input.executionRunId}'`,
      { stageId: input.targetStageId, targetRunId: target.executionRunId },
    );
  }
  if (target.status === "completed") {
    throw progressionError(
      "STAGE_ALREADY_COMPLETED",
      `stage '${input.targetStageId}' is already completed (E7 §22)`,
      { stageId: input.targetStageId },
    );
  }
  if (target.status !== "pending") {
    throw progressionError(
      "EXECUTION_STAGE_NOT_ELIGIBLE",
      `stage '${input.targetStageId}' is ${target.status}; only a pending stage can be activated (E7 §22)`,
      { stageId: input.targetStageId, status: target.status },
    );
  }
  // E7 §15/§16 — eligibility is derived fail-closed from the explicit
  // dependsOn mapping (unknown predecessor = unsatisfied, never satisfied).
  const eligibility = deriveEligibility(stages).get(target.id);
  if (eligibility === undefined || !eligibility.eligible) {
    throw progressionError(
      "EXECUTION_STAGE_NOT_ELIGIBLE",
      `stage '${input.targetStageId}' has unsatisfied mandatory predecessors: [${eligibility?.unsatisfiedPredecessors.join(", ") ?? ""}] (E7 §15/§16)`,
      { stageId: input.targetStageId, unsatisfiedPredecessors: eligibility?.unsatisfiedPredecessors ?? [] },
    );
  }
  // E7 §22 — pending → active (the E3 Core transition re-validates legality
  // under the write lock), then the Stage's FIRST window opens at
  // candidateRevision 0 rooted in the exact acceptedHead. One transaction: a
  // window failure rolls the activation back. The acceptedHead is untouched
  // (E7 §39).
  const stage = activateStagePendingToActiveInTx(tx, input.targetStageId, now);
  const { window, baseCommitId } = openNextWindowForActiveStageInTx(
    tx,
    { executionRunId: input.executionRunId },
    clock,
    now,
  );
  return { stage, window, baseCommitId };
}

// ---------------------------------------------------------------------------
// Service wrapper.
// ---------------------------------------------------------------------------

export function createExecutionProgressionService(store: PlanStore, clock: StoreClock) {
  return {
    /** Read-only progression context (E7 §18/§19). */
    getExecutionProgressionContext(input: { executionRunId: string }): ExecutionProgressionContext {
      return store.withRead((tx) => loadExecutionProgressionContextInTx(tx, input.executionRunId));
    },

    /** E7 §20 — explicit same-Stage continuation (opens the successor window). */
    continueExecutionStage(input: SupervisorOperationAuthority): ContinueExecutionStageResult {
      return store.withWrite((tx) => continueExecutionStageInTx(tx, input, clock, clock.nowIso()));
    },

    /** E7 §22 — explicit next-Stage activation (transition + first window). */
    activateExecutionStage(
      input: SupervisorOperationAuthority & { targetStageId: string },
    ): ActivateExecutionStageResult {
      return store.withWrite((tx) => activateExecutionStageInTx(tx, input, clock, clock.nowIso()));
    },
  };
}
