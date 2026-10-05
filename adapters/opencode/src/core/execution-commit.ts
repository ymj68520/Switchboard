/**
 * ExecutionCommit — v0.2.0 Phase 5 (authoritative accepted execution state).
 *
 * The ONLY object whose creation constitutes accepted execution progress
 * (SPEC v0.2.0 §12): workspace mutation ≠ accepted progress, reports ≠
 * accepted progress, verifier clean reports ≠ accepted progress, a
 * Supervisor "accept" ≠ accepted progress — Core's ExecutionCommit
 * transaction = accepted progress.
 *
 * LINEAR CHAIN (§7): execution_start → EC-001 → EC-002 → … — never a DAG.
 * Each commit's `parentAcceptedState` is copied from the committed window's
 * own `baseAcceptedState`, and the commit gate refuses anything but the
 * run's current accepted state as parent (stale parent → fail closed), so
 * the chain can never branch.
 *
 * COMPLETE WINDOW PROVENANCE (§36): a commit records ALL Directives and ALL
 * Reports of the committed window — including negative/rework reports — not
 * merely the Supervisor-selected positives.
 *
 * `resultingRepositoryState?` is deliberately optional and NEVER fabricated
 * in v0.2.0 (no ExecutionObservation exists; absence is legal).
 */
import { UltraPlanError } from "./errors.js";
import type {
  ExecutionCommitID,
  ExecutionDirectiveID,
  ExecutionReportID,
  ExecutionRunID,
  ExecutionStageID,
  StageCompletionObligationID,
  SupervisorAssessmentID,
  VerificationWindowID,
} from "./ids.js";
import type { Timestamp } from "./refs.js";
import type { AcceptedExecutionStateRef } from "./execution-run.js";

/** The immutable accepted-progress record. */
export interface ExecutionCommit {
  id: ExecutionCommitID;

  executionRunID: ExecutionRunID;
  stageID: ExecutionStageID;
  windowID: VerificationWindowID;
  /** The accepted candidate revision — equals the assessment's and the closed window's. */
  candidateRevision: number;

  /** Copied from the committed window's baseAcceptedState (linear-chain parent). */
  parentAcceptedState: AcceptedExecutionStateRef;

  /** COMPLETE window provenance — every Directive issued in the window. */
  directiveRefs: ExecutionDirectiveID[];
  /** COMPLETE window provenance — every Report produced in the window (negative ones included). */
  reportRefs: ExecutionReportID[];

  supervisorAssessmentID: SupervisorAssessmentID;

  /** The Stage obligations this commit's evidence satisfied (subset of Stage obligations). */
  satisfiedObligations: StageCompletionObligationID[];

  /**
   * Phase 6A §90 — the AttemptReconciliations of this window (up to the
   * committed candidate revision). Indeterminate history is NEVER hidden:
   * the uncertainty and its resolution ride the accepted provenance.
   */
  reconciliationRefs?: import("./ids.js").AttemptReconciliationID[];

  /** True iff this commit closed the Stage (stage-scope acceptance). */
  stageCompleted: boolean;

  /**
   * Optional repository-state witness. NEVER fabricated in v0.2.0 — there is
   * no ExecutionObservation yet; absence is the legal state.
   */
  resultingRepositoryState?: unknown;

  createdAt: Timestamp;
}

export function assertExecutionCommit(value: unknown): asserts value is ExecutionCommit {
  if (typeof value !== "object" || value === null) {
    throw new UltraPlanError("execution_commit_not_found", "An ExecutionCommit record must be an object");
  }
}
