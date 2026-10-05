/**
 * ExecutionIssue — v0.2.0 Phase 6A Part A (REPLAN_REQUIRED control plane).
 *
 * The durable, immutable record of WHY an ExecutionRun can no longer continue
 * inside its immutable FinalPlan authority. It is EXECUTION EVIDENCE / formal
 * replan input — never approved Plan Memory: not a Decision, not a
 * PlanCommit, not a Constraint, not a new FinalPlan (§6). A future planning
 * integration may consume it as the formal input of a NEW PlanningRun, but
 * Phase 6A deliberately creates no PlanningRun and touches no Plan Memory.
 *
 * SOURCE ASSESSMENT REQUIREMENT (§7): the replan transition can only be
 * triggered by a durable semantic judgment — a SupervisorAssessment with
 * disposition=request_replan that belongs to the same run and binds the exact
 * current Stage/Window/candidateRevision. There is no bare "mark replan"
 * primitive: an ExecutionRun can only reach replan_required THROUGH this
 * issue transaction, so "run terminal but issue absent" is unrepresentable.
 *
 * CONTEXT CAPTURE (§9/§10): the issue freezes the accepted execution history
 * (acceptedHead + the full accepted commit chain) and the current UNACCEPTED
 * candidate context (active Stage / open Window / candidateRevision, plus any
 * unresolved verification conflicts and unresolved indeterminate Attempts) so
 * a future PlanningRun can distinguish already-accepted work from unaccepted
 * candidate work without ever promoting the latter.
 *
 * IDEMPOTENCY (§17): the Harness-assigned ExecutionIssueID is the stable
 * retry identity — same id + same content returns the existing issue and the
 * (now terminal) run with no duplicate events; same id + different content is
 * `execution_issue_conflict`.
 */
import { createHash } from "node:crypto";

import type {
  ExecutionAttemptID,
  ExecutionCommitID,
  ExecutionIssueID,
  ExecutionReportID,
  ExecutionRunID,
  ExecutionStageID,
  FinalPlanID,
  SupervisorAssessmentID,
  VerificationConflictID,
  VerificationWindowID,
} from "./ids.js";
import type { Timestamp } from "./refs.js";
import { stableStringify } from "./invariants.js";
import type { ExecutionPlanRef } from "./execution-stage.js";

/** The immutable replan justification. */
export interface ExecutionIssue {
  id: ExecutionIssueID;

  executionRunID: ExecutionRunID;
  /** The exact bound FinalPlan identity the run could not finish under. */
  finalPlanRef: { id: FinalPlanID; revision: number };

  /** The request_replan SupervisorAssessment that authorizes this transition. */
  sourceAssessmentID: SupervisorAssessmentID;

  /** Why the current FinalPlan authority is insufficient (Supervisor prose). */
  reason: string;

  /** The normative scope that needs re-planning — exact FinalPlan-reachable refs only. */
  affectedPlanRefs: ExecutionPlanRef[];
  /** Reports relevant to the escalation (provenance pointers, never authority). */
  reportRefs: ExecutionReportID[];

  /** Accepted execution history at escalation (§9) — the chain tip, absent when nothing was accepted. */
  acceptedHead?: ExecutionCommitID;
  /** The complete accepted ExecutionCommit chain at escalation. */
  acceptedCommitRefs: ExecutionCommitID[];

  /** Current candidate context (§10) — frozen as-was; never mutated by the transition. */
  activeStageID?: ExecutionStageID;
  openWindowID?: VerificationWindowID;
  candidateRevision?: number;

  /** Unresolved verification conflicts at escalation. */
  verificationConflictRefs: VerificationConflictID[];
  /** Unresolved indeterminate Attempts at escalation. */
  unresolvedIndeterminateAttemptRefs: ExecutionAttemptID[];

  /** Optional Supervisor prose — never a substitute for the exact refs above. */
  summary?: string;
  limitations?: string[];
  repositoryContextSummary?: string;

  /** Canonical content hash (idempotency identity) — excludes createdAt. */
  hash: string;
  createdAt: Timestamp;
}

export type ExecutionIssueHashPayload = Omit<ExecutionIssue, "createdAt" | "hash">;

export function executionIssueHashPayload(issue: ExecutionIssue): ExecutionIssueHashPayload {
  const { createdAt: _createdAt, hash: _hash, ...payload } = issue;
  void _createdAt;
  void _hash;
  return payload;
}

export function computeExecutionIssueHash(payload: ExecutionIssueHashPayload): string {
  const digest = createHash("sha256");
  digest.update(stableStringify(payload));
  return digest.digest("hex");
}

export function computeExecutionIssueHashFromRecord(record: ExecutionIssue): string {
  return computeExecutionIssueHash(executionIssueHashPayload(record));
}

/** Deep content equality for the idempotent-retry check (§17). */
export function executionIssueContentEquals(a: ExecutionIssue, b: ExecutionIssue): boolean {
  return stableStringify(executionIssueHashPayload(a)) === stableStringify(executionIssueHashPayload(b));
}
