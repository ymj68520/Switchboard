/**
 * ExecutionIssue v2 — the replan_required contract (v0.2.0 E9 §11–§15).
 *
 * PURE core: canonical payload, hash, snapshot shapes. The issue is a SNAPSHOT
 * (E9 §12): planning correctness never re-queries mutable execution state —
 * Core derives the accepted history (E9 §12: the Supervisor can never omit an
 * accepted Commit) and freezes the compact execution context (E9 §13).
 *
 * Trust boundary (E9 §14/§15): the issue and its referenced execution facts
 * are planning CONTEXT/provenance only — never approved Plan Memory and never
 * Planning Evidence. No E9 operation promotes them.
 *
 * Legacy v0.1 issues (kind vocabulary of build defects, issue_version 1) stay
 * exactly as they are; only E9 terminal issues carry the v2 provenance
 * contract (E9 §45).
 */

import { createHash } from "node:crypto";

import { canonicalJson } from "./canonical-json.js";
import type { ExecutionIssueAffectedRef } from "./execution-issue.js";
import type { ExecutionCommit } from "./execution-commit.js";
import type { RepositoryBaseline } from "./execution-handoff.js";

export const EXECUTION_ISSUE_VERSION_2 = 2;
export const REPLAN_ISSUE_KIND = "replan_required";

/** E9 §12 — the Core-derived accepted execution history snapshot. */
export interface AcceptedExecutionHistorySnapshot {
  acceptedHead: { commitId: string; sequence: number } | null;
  /** The ordered linear commit chain up to the head — never Supervisor-picked. */
  commits: Array<{
    commitId: string;
    sequence: number;
    parentCommitId: string | null;
    /** E10 — null for the final-closure ExecutionCommit (scope final_closure). */
    stageId: string | null;
    windowId: string;
    candidateRevision: number;
    createdAt: string;
  }>;
}

export function deriveAcceptedHistorySnapshot(commits: ExecutionCommit[], headCommitId: string | null): AcceptedExecutionHistorySnapshot {
  const head = commits.find((commit) => commit.commitId === headCommitId) ?? null;
  return {
    acceptedHead: head === null ? null : { commitId: head.commitId, sequence: head.sequence },
    commits: commits.map((commit) => ({
      commitId: commit.commitId,
      sequence: commit.sequence,
      parentCommitId: commit.parentCommitId,
      stageId: commit.stageId,
      windowId: commit.windowId,
      candidateRevision: commit.candidateRevision,
      createdAt: commit.createdAt,
    })),
  };
}

/** E9 §13 — the compact exact execution context frozen at transition time. */
export interface ExecutionIssueContextSnapshot {
  lifecycleBefore: "active";
  activeStage: { id: string; status: string } | null;
  openWindow: {
    id: string;
    candidateRevision: number;
    baseKind: "execution_start" | "execution_commit";
    baseCommitId: string | null;
  } | null;
  verificationPolicy: {
    required: boolean;
    reason: string | null;
    unverifiedMutationSpan: number;
    maxUnverifiedMutations: number;
    latestVerifiedRevision: number;
  } | null;
  currentConflicts: Array<{ conflictId: string; status: string; candidateRevision: number }>;
  runningAttemptId: null;
  /** E11 §38 — UNRESOLVED indeterminate Attempts at the terminal transition. */
  indeterminateAttemptIds: string[];
  /** E11 §38 — reconciled indeterminate history with its resolution provenance. */
  reconciledIndeterminateRefs: Array<{ attemptId: string; resolution: string }>;
  latestAssessment: { assessmentId: string; disposition: string; candidateRevision: number } | null;
  workspaceId: string;
  repositoryAtTransition: RepositoryBaseline | null;
}

/**
 * ExecutionIssueV2 (E9 §11) — the canonical replan payload. Hash excludes the
 * issue id and createdAt (the immutable-artifact convention, matching the v1
 * issue hash); affectedNormativeRefs are deterministically sorted.
 */
export interface ExecutionIssueV2 {
  version: typeof EXECUTION_ISSUE_VERSION_2;
  kind: typeof REPLAN_ISSUE_KIND;
  executionRunId: string;
  runId: string;
  finalPlanRef: { id: string; hash: string };
  reason: string;
  affectedNormativeRefs: ExecutionIssueAffectedRef[];
  relevantReportRefs: string[];
  triggerAssessmentId: string | null;
  acceptedHistory: AcceptedExecutionHistorySnapshot;
  executionContext: ExecutionIssueContextSnapshot;
}

export function executionIssueV2Hash(issue: ExecutionIssueV2): string {
  const canonical = {
    ...issue,
    affectedNormativeRefs: [...issue.affectedNormativeRefs].sort(
      (a, b) => a.type.localeCompare(b.type) || a.id.localeCompare(b.id) || a.revision - b.revision,
    ),
    relevantReportRefs: [...issue.relevantReportRefs].sort(),
  };
  return `sha256:${createHash("sha256").update(canonicalJson(canonical), "utf8").digest("hex")}`;
}
