/**
 * ExecutionCompletionRecord — v0.2.0 Phase 6B Part D (ExecutionCompletionGate
 * provenance).
 *
 * The durable, immutable record that makes `ExecutionRun.completed` more than
 * a bare enum change: the gate's SUCCESS PROVENANCE, binding the exact final
 * closure Stage, final VerificationWindow, final SupervisorAssessment, and
 * final ExecutionCommit of the run it completes — the terminal-provenance
 * counterpart of ExecutionIssue for REPLAN_REQUIRED (§31).
 *
 * It is EXECUTION MEMORY only (§32): it never modifies the FinalPlan, never
 * creates planning approvals, never writes the repository.
 *
 * LEGACY DISTINCTION (§50-§53): pre-6B completed ExecutionRuns (Phase 1
 * fixtures / persisted stores) carry NO completion record and remain
 * loadable as `legacy` completion provenance. Every NEW completion through
 * the ExecutionCompletionGate MUST produce a record; no normal API can
 * create a completed run without one.
 *
 * IDEMPOTENCY (§47/§48): the Harness-assigned ExecutionCompletionID is the
 * stable retry identity — same id + same semantic request returns the same
 * record and the same completed run with no duplicate events; a conflicting
 * belief about the final commit is `execution_completion_conflict`.
 */
import { createHash } from "node:crypto";

import type {
  ExecutionCommitID,
  ExecutionCompletionID,
  ExecutionReportID,
  ExecutionRunID,
  ExecutionStageID,
  FinalPlanID,
  SupervisorAssessmentID,
  VerificationWindowID,
} from "./ids.js";
import type { Timestamp } from "./refs.js";
import { stableStringify } from "./invariants.js";

/** The immutable completion provenance record. */
export interface ExecutionCompletionRecord {
  id: ExecutionCompletionID;

  executionRunID: ExecutionRunID;
  /** The exact bound FinalPlan identity the run executed and closed under. */
  finalPlanRef: { id: FinalPlanID; revision: number };

  finalClosureStageID: ExecutionStageID;
  finalWindowID: VerificationWindowID;
  finalCommitID: ExecutionCommitID;
  finalAssessmentID: SupervisorAssessmentID;
  /** The accepted-head tip at completion — copied, never rewritten by the gate. */
  acceptedHead: ExecutionCommitID;

  completedAt: Timestamp;

  /** Optional compact pointers — never a duplicate of the Commit provenance. */
  finalCandidateRevision?: number;
  finalVerificationReportRefs?: ExecutionReportID[];

  /** Canonical content hash — over every field (completedAt included). */
  hash: string;
}

export type ExecutionCompletionHashPayload = Omit<ExecutionCompletionRecord, "hash">;

export function executionCompletionHashPayload(record: ExecutionCompletionRecord): ExecutionCompletionHashPayload {
  const { hash: _hash, ...payload } = record;
  void _hash;
  return payload;
}

export function computeExecutionCompletionHash(payload: ExecutionCompletionHashPayload): string {
  const digest = createHash("sha256");
  digest.update(stableStringify(payload));
  return digest.digest("hex");
}

export function computeExecutionCompletionHashFromRecord(record: ExecutionCompletionRecord): string {
  return computeExecutionCompletionHash(executionCompletionHashPayload(record));
}

/**
 * §47/§48 deep retry equality: the REQUEST-derived content (everything
 * except the completion timestamp and the hash — a retry after response loss
 * replays the same semantic completion, not the same wall clock).
 */
export function executionCompletionRequestEquals(a: ExecutionCompletionRecord, b: ExecutionCompletionRecord): boolean {
  const strip = (record: ExecutionCompletionRecord): string => {
    const { completedAt: _completedAt, hash: _hash, ...rest } = record;
    void _completedAt;
    void _hash;
    return stableStringify(rest);
  };
  return strip(a) === strip(b);
}
