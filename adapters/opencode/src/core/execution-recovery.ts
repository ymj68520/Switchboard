/**
 * ExecutionRecoveryContext — v0.2.0 Phase 2 (directive §21-§23).
 *
 * A DETERMINISTIC PROJECTION, rebuilt from canonical durable Store state —
 * never from conversation summary, and never persisted as a second mutable
 * execution truth (§22: cached copies may exist, but the Store always wins).
 *
 * Phase 2 honesty boundary: the execution protocol below the run (Stage,
 * Window, Directive, Report, acceptedHead) does not exist yet, so the
 * context deliberately has NO such fields. It projects exactly what the
 * Store can prove today: the run, its bindings, and the caller's current
 * authority status.
 */
import type { ExecutionRun, ExecutionLifecycle, PlanningBaselineRef, WorkspaceIdentity } from "./execution-run.js";
import type { SupervisorBinding, SupervisorBindingState } from "./supervisor-binding.js";
import type { ExecutionStage } from "./execution-stage.js";
import type { VerificationWindow } from "./verification-window.js";
import type { FinalPlanID, ExecutionRunID, PlanID } from "./ids.js";

/** The caller's deterministic authority status for a recovered run (§23). */
export interface ExecutionAuthorityStatus {
  /** The viewer's trusted session is the binding's current owner. */
  sessionIsCurrentOwner: boolean;
  /** The binding's current generation; undefined when no binding exists. */
  currentGeneration: number | undefined;
  /** A non-terminal run with a binding owned by ANOTHER session. */
  requiresTakeover: boolean;
  /** The viewer can resume with idempotent authority (attached + owner). */
  canResume: boolean;
  /** prepared run + attached binding owned by the viewer → can activate. */
  canActivate: boolean;
}

/** §21 — the recovery projection over exactly the existing durable state. */
export interface ExecutionRecoveryContext {
  executionRunID: ExecutionRunID;
  planID: PlanID;
  finalPlan: { id: FinalPlanID; revision: number };
  lifecycle: ExecutionLifecycle;
  workspace: WorkspaceIdentity;
  planningBaseline: PlanningBaselineRef;
  executionStartBaseline: ExecutionRun["executionStartBaseline"];
  /** Present only when a SupervisorBinding exists. */
  binding?: {
    ownerSessionID: string;
    generation: number;
    state: SupervisorBindingState;
  };
  /**
   * v0.2.0 Phase 3 — present only when the run carries an active Stage
   * (frozen history included for terminal runs). Compact projection of the
   * canonical Stage record; still NO Directive/Attempt/Report/acceptedHead
   * exists, and none is fabricated here.
   */
  activeStage?: {
    id: ExecutionStage["id"];
    title: string;
    objective: string;
    status: ExecutionStage["status"];
  };
  /** v0.2.0 Phase 3 — present only when the run carries an open Window. */
  openWindow?: {
    id: VerificationWindow["id"];
    stage: VerificationWindow["stageID"];
    candidateRevision: number;
    baseAcceptedState: VerificationWindow["baseAcceptedState"];
  };
  /**
   * v0.2.0 Phase 4 — the run's running Attempt, if any (at most one exists).
   * Recovery-reasoning projection only: every mutation still uses exact
   * Directive ids/revisions, never this projection.
   */
  runningAttempt?: {
    id: string;
    directive: { id: string; revision: number; hash: string };
    workerRole: string;
    startedAt: string;
  };
  /** Unresolved indeterminate Attempts — durable facts awaiting explicit reconciliation (never auto-cleared). */
  indeterminateAttempts: {
    id: string;
    directive: { id: string; revision: number; hash: string };
    startedAt: string;
  }[];
  /**
   * v0.2.0 Phase 6A §65 — the CANONICAL unresolved subset: indeterminate
   * Attempts NOT covered by a successful AttemptReconciliation (BOTH candidate
   * effects). Phase 7A P0: this is the full uncertainty history — the
   * reconciliation/commit BLOCKING set is the side-effecting subset below.
   */
  unresolvedIndeterminateAttempts: {
    id: string;
    directive: { id: string; revision: number; hash: string };
    startedAt: string;
  }[];
  /**
   * v0.2.0 Phase 7A §3 — the BLOCKING subset of the unresolved set: only
   * indeterminate Attempts whose Directive could mutate the candidate make
   * repository reality uncertain. This is the set that forces reconciliation
   * mode and blocks acceptance/completion.
   */
  unresolvedSideEffectingAttempts: {
    id: string;
    directive: { id: string; revision: number; hash: string };
    startedAt: string;
  }[];
  /**
   * v0.2.0 Phase 7A §3 — indeterminate Attempts whose Directive could NOT
   * mutate the candidate (interrupted verifier/inspection work): immutable
   * history that provides no acceptance evidence but NEVER forces
   * reconciliation; a fresh Directive may replace the lost work.
   */
  nonMutatingInterruptedAttempts: {
    id: string;
    directive: { id: string; revision: number; hash: string };
    startedAt: string;
  }[];
  /** v0.2.0 Phase 6A §65 — the run's durable reconciliations (full provenance history). */
  attemptReconciliations: {
    id: string;
    windowID: string;
    targetAttemptIDs: string[];
    observation: string;
    baseCandidateRevision: number;
    resultingCandidateRevision: number;
  }[];
  /** v0.2.0 Phase 6A §65 — current-candidate verification conflicts, newest conflict last. */
  currentVerificationConflicts: {
    id: string;
    windowID: string;
    candidateRevision: number;
    status: string;
    claimA: string;
    claimB: string;
    resolutionQuestion: string;
  }[];
  /** v0.2.0 Phase 6A §65 — the aggregate verification condition of the current candidate. */
  verificationCondition: "clear" | "conflict_open" | "verification_blocked";
  /**
   * True iff the canonical unresolved SIDE-EFFECTING indeterminate set is
   * non-empty (Phase 7A §4) — displayed, never self-healed. A non-mutating
   * interrupted Attempt never sets this.
   */
  reconciliationRequired: boolean;
  /**
   * v0.2.0 Phase 6A §65 — present only on a replan_required run: the terminal
   * ExecutionIssue that justifies the terminal state (projection of the
   * canonical record; never correctness authority).
   */
  executionIssue?: {
    id: string;
    reason: string;
    sourceAssessmentID: string;
    acceptedHead?: string;
    affectedPlanRefs: unknown[];
    unresolvedIndeterminateAttemptRefs: string[];
    verificationConflictRefs: string[];
  };
  /**
   * v0.2.0 Phase 6B §54 — the final-closure lifecycle projection:
   * absent (no closure Stage) / pending / active / committed (a
   * stage-completing Commit exists but the Stage record… completed status
   * covers it — `committed` is the completed-Stage state as seen before
   * completion) / completed.
   */
  finalClosure: "absent" | "pending" | "active" | "completed";
  /** v0.2.0 Phase 6B §54 — compact projection of the final closure Stage. */
  finalClosureStage?: {
    id: string;
    title: string;
    status: string;
    obligationCount: number;
  };
  /** v0.2.0 Phase 6B §54 — the Commit that completed the final closure Stage. */
  finalClosureCommit?: {
    id: string;
    windowID: string;
    candidateRevision: number;
  };
  /**
   * v0.2.0 Phase 6B §55 — TRUE only when the run sits at the recovery point
   * after the final closure Commit: the ExecutionCompletionGate may run
   * without repeating verification/assessment/commit. PROJECTION ONLY — the
   * actual mutation still goes through the gate.
   */
  completionReady: boolean;
  /** v0.2.0 Phase 6B §54 — deterministic reasons completion is not ready (empty when ready). */
  completionBlockers: string[];
  /**
   * v0.2.0 Phase 6B §52 — the completion provenance projection: v0.2 (with
   * the exact record) or legacy (pre-6B completed run without a record).
   */
  executionCompletion?:
    | { protocol: "v0.2"; id: string; completedAt: string }
    | { protocol: "legacy" };
  /** Informational pointers to the latest durable artifacts (NOT correctness authority). */
  latestDirective?: { id: string; revision: number; hash: string; kind: string };
  latestReport?: { id: string; attemptID: string; result: string; candidateMutation: string };
  /** v0.2.0 Phase 5 — the authoritative accepted progress (absent = execution-start baseline). */
  acceptedHead?: string;
  /** The unified accepted-state anchor (execution_start until the first commit). */
  currentAcceptedState:
    | { kind: "execution_start"; executionRunID: string }
    | { kind: "execution_commit"; executionCommitID: string };
  /** Summary of the accepted-head commit, when one exists. */
  latestCommit?: {
    id: string;
    windowID: string;
    candidateRevision: number;
    satisfiedObligations: string[];
    stageCompleted: boolean;
  };
  /** Stage obligations already accepted (derived from canonical commits). */
  stageAcceptedObligations: string[];
  /** Stage obligations not yet accepted (all minus accepted; legacy stage without obligations = none claimable). */
  stageRemainingObligations: string[];
  authority: ExecutionAuthorityStatus;
}

/**
 * Build the projection from canonical records. Pure — the store owns the
 * reads; this function owns NO policy beyond the status derivation below.
 */
export function buildExecutionRecoveryContext(
  run: ExecutionRun,
  binding: SupervisorBinding | undefined,
  stage: ExecutionStage | undefined,
  window: VerificationWindow | undefined,
  viewer: { sessionID: string },
): ExecutionRecoveryContext {
  const nonTerminal = run.lifecycle === "prepared" || run.lifecycle === "active";
  const sessionIsCurrentOwner = binding !== undefined && binding.ownerSessionID === viewer.sessionID;
  const attachedToViewer = nonTerminal && binding !== undefined && binding.state === "attached" && sessionIsCurrentOwner;
  return {
    executionRunID: run.id,
    planID: run.planID,
    finalPlan: { id: run.finalPlan.id, revision: run.finalPlan.revision },
    lifecycle: run.lifecycle,
    workspace: run.workspace,
    planningBaseline: run.planningBaseline,
    executionStartBaseline: run.executionStartBaseline,
    ...(binding
      ? {
          binding: {
            ownerSessionID: binding.ownerSessionID,
            generation: binding.generation,
            state: binding.state,
          },
        }
      : {}),
    ...(run.activeStage !== undefined && stage !== undefined && stage.id === run.activeStage
      ? {
          activeStage: {
            id: stage.id,
            title: stage.title,
            objective: stage.objective,
            status: stage.status,
          },
        }
      : {}),
    ...(run.openWindow !== undefined && window !== undefined && window.id === run.openWindow
      ? {
          openWindow: {
            id: window.id,
            stage: window.stageID,
            candidateRevision: window.candidateRevision,
            baseAcceptedState: window.baseAcceptedState,
          },
        }
      : {}),
    indeterminateAttempts: [],
    unresolvedIndeterminateAttempts: [],
    unresolvedSideEffectingAttempts: [],
    nonMutatingInterruptedAttempts: [],
    attemptReconciliations: [],
    currentVerificationConflicts: [],
    verificationCondition: "clear",
    reconciliationRequired: false,
    finalClosure: "absent",
    completionReady: false,
    completionBlockers: [],
    currentAcceptedState:
      run.acceptedHead !== undefined
        ? { kind: "execution_commit", executionCommitID: run.acceptedHead }
        : { kind: "execution_start", executionRunID: run.id },
    stageAcceptedObligations: [],
    stageRemainingObligations: [],
    authority: {
      sessionIsCurrentOwner,
      currentGeneration: binding?.generation,
      requiresTakeover: nonTerminal && binding !== undefined && !sessionIsCurrentOwner,
      canResume: attachedToViewer,
      canActivate: run.lifecycle === "prepared" && attachedToViewer,
    },
  };
}
