/**
 * AttemptReconciliation — v0.2.0 Phase 6A Part C (indeterminate Attempt
 * reconciliation).
 *
 * The indeterminate Attempt state is TERMINAL immutable history (frozen Phase
 * 4 semantics — there is no indeterminate → reported/failed transition and
 * none is added). Reconciliation is a SEPARATE durable artifact: an explicit,
 * non-mutating inspection that re-establishes repository reality and records
 * what it found, so the uncertainty is resolved by EVIDENCE, never by
 * forgetting.
 *
 * OBSERVATION SEMANTICS (§47/§51/§52): `unchanged` means the candidate still
 * corresponds to the known candidateRevision N (base = resulting = N, no
 * revision advance); `changed` means interrupted work moved candidate reality,
 * so the window's candidateRevision advances N → N+1 EXACTLY ONCE per
 * reconciliation (the revision is "new known candidate state", not a
 * side-effect counter). `unresolved` observations NEVER create a
 * reconciliation record — the uncertainty stays open (§50).
 *
 * COVERAGE (§41): the canonical unresolved-indeterminate set is deterministic
 * — an indeterminate Attempt is unresolved until a SUCCESSFUL
 * AttemptReconciliation covers it. There is no "latest event" shortcut.
 *
 * TARGETING (§43): a reconciliation inspection Directive must target the
 * COMPLETE canonical unresolved set — resolving half the uncertainty and
 * pretending the workspace is known is exactly what this artifact forbids.
 */
import type {
  AttemptReconciliationID,
  ExecutionAttemptID,
  ExecutionDirectiveID,
  ExecutionReportID,
  ExecutionRunID,
  ExecutionStageID,
  VerificationWindowID,
} from "./ids.js";
import type { Timestamp } from "./refs.js";

/** Report-level observation vocabulary of a reconciliation inspection (§47). */
export const RECONCILIATION_OBSERVATIONS = ["unchanged", "changed", "unresolved"] as const;
export type ReconciliationObservation = (typeof RECONCILIATION_OBSERVATIONS)[number];

/** Observation values that may appear on a SUCCESSFUL AttemptReconciliation (§49). */
export const SUCCESSFUL_RECONCILIATION_OBSERVATIONS = ["unchanged", "changed"] as const;
export type SuccessfulReconciliationObservation = (typeof SUCCESSFUL_RECONCILIATION_OBSERVATIONS)[number];

/** The immutable reconciliation record (§49). */
export interface AttemptReconciliation {
  id: AttemptReconciliationID;

  executionRunID: ExecutionRunID;
  stageID: ExecutionStageID;
  windowID: VerificationWindowID;

  /** The COMPLETE canonical unresolved set this reconciliation covers (§43). */
  targetAttemptIDs: ExecutionAttemptID[];

  /** The exact reconciliation inspection Directive revision. */
  inspectionDirectiveRef: { id: ExecutionDirectiveID; revision: number; hash: string };
  inspectionAttemptID: ExecutionAttemptID;
  inspectionReportID: ExecutionReportID;

  observation: SuccessfulReconciliationObservation;

  /** The known candidate revision the inspection ran against. */
  baseCandidateRevision: number;
  /** unchanged → base; changed → base + 1 (advanced exactly once, §52). */
  resultingCandidateRevision: number;

  createdAt: Timestamp;
}
