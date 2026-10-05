/**
 * ExecutionCommit persistence (v0.2.0 E6 §22–§28).
 *
 * Commit rows are PERMANENT accepted history (migration 019): the no-update/
 * no-delete triggers make amend/re-parent/replace impossible (E6 §46). The
 * DDL uniquenesses carry the cardinality laws:
 *
 *   EC-01  one commit per Window (UNIQUE(window_id)) — once committed, a
 *          Window is historical and can never be recommitted (E6 §28)
 *   EC-02  one commit per accept assessment (UNIQUE(supervisor_assessment_id))
 *   EC-03  linear chain per run (UNIQUE(execution_run_id, sequence)) — no DAG, no
 *          merge, no branch (E6 §24)
 *
 * The accepted head lives on execution_runs.accepted_head_commit_id (E6 §25)
 * and moves ONLY through advanceAcceptedHeadInTx's compare-and-swap here —
 * there is deliberately no setAcceptedHead path anywhere (E6 §25).
 */

import { parseExecutionCommitRow, type ExecutionCommit } from "../core/execution-commit.js";
import { RuntimeError } from "../runtime/errors.js";
import type { StoreTx } from "./transaction.js";

const COMMIT_COLUMNS =
  "commit_id AS commitId, execution_run_id AS executionRunId, sequence, parent_commit_id AS parentCommitId, "
  + "scope_kind AS scopeKind, stage_id AS stageId, window_id AS windowId, candidate_revision AS candidateRevision, "
  + "supervisor_assessment_id AS supervisorAssessmentId, "
  + "directive_refs_json AS directiveRefs, report_refs_json AS reportRefs, "
  + "satisfied_obligations_json AS satisfiedObligations, created_at AS createdAt";

function parseJsonField(raw: Record<string, unknown>, field: string): unknown {
  try {
    return JSON.parse(String(raw[field]));
  } catch {
    throw new RuntimeError("STORE_SCHEMA_INVALID", "execution_commits row is corrupt", {
      detail: { fields: [field] },
    });
  }
}

/** Reassemble the canonical row shape parseExecutionCommitRow expects. */
function mapCommitRow(raw: Record<string, unknown>): ExecutionCommit {
  const row: Record<string, unknown> = { ...raw };
  row.directiveRefs = parseJsonField(raw, "directiveRefs");
  row.reportRefs = parseJsonField(raw, "reportRefs");
  row.satisfiedObligations = parseJsonField(raw, "satisfiedObligations");
  return parseExecutionCommitRow(row);
}

export function getExecutionCommitInTx(tx: StoreTx, commitId: string): ExecutionCommit | null {
  const raw = tx
    .prepare(`SELECT ${COMMIT_COLUMNS} FROM execution_commits WHERE commit_id = ?`)
    .get(commitId) as Record<string, unknown> | undefined;
  return raw === undefined ? null : mapCommitRow(raw);
}

/** E6 §28 — the (at most one) commit of a Window; null while open/pre-commit. */
export function getCommitForWindowInTx(tx: StoreTx, windowId: string): ExecutionCommit | null {
  const raw = tx
    .prepare(`SELECT ${COMMIT_COLUMNS} FROM execution_commits WHERE window_id = ?`)
    .get(windowId) as Record<string, unknown> | undefined;
  return raw === undefined ? null : mapCommitRow(raw);
}

/** The run's full commit chain, sequence order (deterministic history). */
export function listRunCommitsInTx(tx: StoreTx, executionRunId: string): ExecutionCommit[] {
  return (tx
    .prepare(`SELECT ${COMMIT_COLUMNS} FROM execution_commits WHERE execution_run_id = ? ORDER BY sequence`)
    .all(executionRunId) as Record<string, unknown>[]).map(mapCommitRow);
}

/**
 * Persist the immutable commit (E6 §21, inside the gate transaction). The
 * UNIQUE constraints reject a second commit for the same window, a second
 * commit for the same assessment, and a broken linear sequence — surfacing as
 * EXECUTION_COMMIT_ALREADY_EXISTS / EXECUTION_COMMIT_CONFLICT.
 */
export function insertExecutionCommitInTx(tx: StoreTx, commit: ExecutionCommit): void {
  try {
    tx.prepare(
      `INSERT INTO execution_commits (
         commit_id, execution_run_id, sequence, parent_commit_id, scope_kind, stage_id, window_id,
         candidate_revision, supervisor_assessment_id,
         directive_refs_json, report_refs_json, satisfied_obligations_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      commit.commitId,
      commit.executionRunId,
      commit.sequence,
      commit.parentCommitId,
      commit.stageId === null ? "final_closure" : "stage",
      commit.stageId,
      commit.windowId,
      commit.candidateRevision,
      commit.supervisorAssessmentId,
      JSON.stringify(commit.directiveRefs),
      JSON.stringify(commit.reportRefs),
      JSON.stringify(commit.satisfiedObligations),
      commit.createdAt,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("UNIQUE constraint failed: execution_commits.window_id")) {
      throw new RuntimeError(
        "EXECUTION_COMMIT_ALREADY_EXISTS",
        `verification window '${commit.windowId}' already carries an execution commit (E6 §28)`,
        { detail: { windowId: commit.windowId }, recoverable: false },
      );
    }
    if (message.includes("UNIQUE constraint failed: execution_commits.supervisor_assessment_id")) {
      throw new RuntimeError(
        "EXECUTION_COMMIT_ALREADY_EXISTS",
        `assessment '${commit.supervisorAssessmentId}' already gated an execution commit`,
        { detail: { supervisorAssessmentId: commit.supervisorAssessmentId }, recoverable: false },
      );
    }
    if (message.includes("UNIQUE constraint failed: execution_commits.execution_run_id, execution_commits.sequence")) {
      throw new RuntimeError(
        "EXECUTION_COMMIT_CONFLICT",
        `execution run '${commit.executionRunId}' already has a commit at sequence ${commit.sequence}`,
        { detail: { executionRunId: commit.executionRunId, sequence: commit.sequence }, recoverable: false },
      );
    }
    throw err;
  }
}

/**
 * THE acceptedHead compare-and-swap (E6 §26) — the ONLY acceptedHead
 * advancement mechanism. expected=null admits exactly the first commit;
 * expected=<commitId> admits exactly the successor. Any concurrent/stale head
 * movement leaves changes=0 and fails closed as STALE_EXECUTION_HEAD, rolling
 * back the entire accept transaction.
 */
export function advanceAcceptedHeadInTx(
  tx: StoreTx,
  input: { executionRunId: string; expectedHeadCommitId: string | null; commitId: string },
  now: string,
): void {
  const updated =
    input.expectedHeadCommitId === null
      ? (tx
          .prepare(
            "UPDATE execution_runs SET accepted_head_commit_id = ?, revision = revision + 1, updated_at = ? "
            + "WHERE execution_run_id = ? AND accepted_head_commit_id IS NULL",
          )
          .run(input.commitId, now, input.executionRunId) as { changes?: number | bigint })
      : (tx
          .prepare(
            "UPDATE execution_runs SET accepted_head_commit_id = ?, revision = revision + 1, updated_at = ? "
            + "WHERE execution_run_id = ? AND accepted_head_commit_id = ?",
          )
          .run(input.commitId, now, input.executionRunId, input.expectedHeadCommitId) as { changes?: number | bigint });
  if (Number(updated.changes ?? 0) !== 1) {
    throw new RuntimeError(
      "STALE_EXECUTION_HEAD",
      input.expectedHeadCommitId === null
        ? `execution run '${input.executionRunId}' already has an accepted head; a first commit can no longer be created`
        : `stale accepted head ${input.expectedHeadCommitId}; the run's head moved during assessment`,
      { detail: { executionRunId: input.executionRunId, expected: input.expectedHeadCommitId, detected: input.commitId }, recoverable: false },
    );
  }
}

/** The authoritative accepted head of one run (null = execution_start base). */
export function getAcceptedHeadCommitIdInTx(tx: StoreTx, executionRunId: string): string | null {
  const row = tx
    .prepare("SELECT accepted_head_commit_id AS commitId FROM execution_runs WHERE execution_run_id = ?")
    .get(executionRunId) as { commitId: string | null } | undefined;
  return row?.commitId ?? null;
}

/** E10 §43 — the terminal completion provenance (non-null iff completed). */
export function getCompletionCommitIdInTx(tx: StoreTx, executionRunId: string): string | null {
  const row = tx
    .prepare("SELECT completion_commit_id AS commitId FROM execution_runs WHERE execution_run_id = ?")
    .get(executionRunId) as { commitId: string | null } | undefined;
  return row?.commitId ?? null;
}
