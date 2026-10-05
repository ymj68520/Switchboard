/**
 * ExecutionCommit domain shape (v0.2.0 architecture spec, E6 §22–§28).
 *
 * PURE core: canonical shape, row validation. No SQLite, no host, no MCP.
 *
 * ExecutionCommit is the ONLY object that advances authoritative accepted
 * execution progress (E6 §1/§22). It is created exclusively inside the Core
 * acceptance-gate transaction (E6 §21) — never by a model-facing tool, never
 * by an assessment alone, never by a Report (E6-I14/§I15).
 *
 * Genesis semantics (E6 §23): there is NO EC-000. The pre-commit accepted base
 * is the ExecutionRun's persisted executionStartBaseline; the first commit has
 * parentCommitId = null and sequence = 1. The chain is strictly linear (E6
 * §24): parent == acceptedHead, sequence == parent.sequence + 1, no DAG, no
 * merge, no branch.
 *
 * Provenance (E6 §27): directiveRefs/reportRefs are derived by Core from the
 * Store — ALL immutable Directive revisions of the accepted Window and ALL
 * Reports of the Window's attempts, in deterministic protocol order. The
 * assessment stores semantic classifications; the commit stores complete
 * Window provenance, so adverse historical evidence cannot be omitted.
 *
 * E6 §47: an ExecutionCommit is Harness acceptance state — invoking `git
 * commit` is NOT part of its creation and git state remains workspace reality.
 */

import { RuntimeError } from "../runtime/errors.js";
import type { CoveredObligation } from "./supervisor-assessment.js";

/** One exact Directive revision in a commit's Window provenance (E6 §27). */
export interface ExecutionDirectiveRef {
  directiveId: string;
  revision: number;
  hash: string;
}

/** One exact Report in a commit's Window provenance (E6 §27). */
export interface ExecutionReportRef {
  reportId: string;
  attemptId: string;
  workerRole: string;
  result: string;
}

export interface ExecutionCommit {
  commitId: string;
  executionRunId: string;
  /** 1-based linear position within the run's commit chain. */
  sequence: number;
  /** Null exactly for the first commit (E6 §23 — no fabricated genesis). */
  parentCommitId: string | null;
  /**
   * E10 §34 — the explicit execution scope. Ordinary commits carry the exact
   * Stage; the Final ExecutionCommit carries null (scope final_closure).
   */
  scopeKind: "stage" | "final_closure";
  stageId: string | null;
  windowId: string;
  /** The exact (final, frozen) candidate revision of the accepted Window. */
  candidateRevision: number;
  /** The exactly-one accept assessment that gated this commit (E6 §41). */
  supervisorAssessmentId: string;
  directiveRefs: ExecutionDirectiveRef[];
  reportRefs: ExecutionReportRef[];
  /** Structured acceptance provenance (E6 §16) — never Stage completion. */
  satisfiedObligations: CoveredObligation[];
  createdAt: string;
}

/**
 * Validate a raw database row into an ExecutionCommit. A non-positive
 * sequence, a first commit with a parent, a later commit without one, or
 * broken identity is store corruption — STORE_SCHEMA_INVALID.
 */
export function parseExecutionCommitRow(row: Record<string, unknown>): ExecutionCommit {
  const problems: string[] = [];
  if (typeof row.commitId !== "string" || row.commitId === "") problems.push("commit_id");
  if (typeof row.executionRunId !== "string" || row.executionRunId === "") problems.push("execution_run_id");
  if (typeof row.sequence !== "number" || !Number.isInteger(row.sequence) || row.sequence < 1) problems.push("sequence");
  if (row.parentCommitId !== null && typeof row.parentCommitId !== "string") problems.push("parent_commit_id");
  // E10 §34/§6 — scope shape: stage ↔ non-null stage id, final_closure ↔ null.
  if (typeof row.scopeKind !== "string" || (row.scopeKind !== "stage" && row.scopeKind !== "final_closure")) {
    problems.push("scope_kind");
  }
  if (row.stageId !== null && typeof row.stageId !== "string") problems.push("stage_id");
  if (typeof row.stageId === "string" && row.stageId === "") problems.push("stage_id");
  if (typeof row.scopeKind === "string" && (row.scopeKind === "stage" || row.scopeKind === "final_closure")) {
    if (row.scopeKind === "stage" && typeof row.stageId !== "string") problems.push("scope_shape");
    if (row.scopeKind === "final_closure" && row.stageId !== null) problems.push("scope_shape");
  }
  if (typeof row.windowId !== "string" || row.windowId === "") problems.push("window_id");
  if (typeof row.candidateRevision !== "number" || !Number.isInteger(row.candidateRevision) || row.candidateRevision < 0) {
    problems.push("candidate_revision");
  }
  if (typeof row.supervisorAssessmentId !== "string" || row.supervisorAssessmentId === "") {
    problems.push("supervisor_assessment_id");
  }
  if (typeof row.createdAt !== "string" || row.createdAt === "") problems.push("created_at");
  if (!Array.isArray(row.directiveRefs) || !Array.isArray(row.reportRefs) || !Array.isArray(row.satisfiedObligations)) {
    problems.push("provenance");
  }
  if (problems.length === 0) {
    if (row.sequence === 1 && row.parentCommitId !== null) problems.push("genesis_parent");
    if (typeof row.sequence === "number" && row.sequence > 1 && typeof row.parentCommitId !== "string") {
      problems.push("missing_parent");
    }
  }
  if (problems.length > 0) {
    throw new RuntimeError("STORE_SCHEMA_INVALID", "execution_commits row is corrupt", {
      detail: { fields: problems },
    });
  }
  return {
    commitId: row.commitId as string,
    executionRunId: row.executionRunId as string,
    sequence: row.sequence as number,
    parentCommitId: (row.parentCommitId as string | null) ?? null,
    scopeKind: row.scopeKind as ExecutionCommit["scopeKind"],
    stageId: (row.stageId as string | null) ?? null,
    windowId: row.windowId as string,
    candidateRevision: row.candidateRevision as number,
    supervisorAssessmentId: row.supervisorAssessmentId as string,
    directiveRefs: row.directiveRefs as ExecutionDirectiveRef[],
    reportRefs: row.reportRefs as ExecutionReportRef[],
    satisfiedObligations: row.satisfiedObligations as CoveredObligation[],
    createdAt: row.createdAt as string,
  };
}
