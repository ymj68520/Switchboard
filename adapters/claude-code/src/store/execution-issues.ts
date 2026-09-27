/**
 * ExecutionIssue persistence (Phase 15 §5/§7/§15/§17/§18).
 *
 * Cardinality laws are DDL-enforced, never commented into existence:
 *
 *   XI-01  one immutable issue row per (run, issue_id) and one operation
 *          identity per run (UNIQUE(run_id, operation_id) — the signed
 *          toolUseId is the idempotency fence, §15)
 *   XI-02  the issue and its refs are append-only history (no_update/
 *          no_delete triggers) — NO UPDATE and NO DELETE exist (§7)
 *   XI-03  "open" is DERIVED, never stored (§18): an issue is open exactly
 *          while no execution_issue_adoptions row exists for it
 *   XI-04  adoption is append-only with UNIQUE(issue_id) as the DB fence for
 *          the one-successor-only rule (§17/§74) — never an application
 *          pre-check alone
 *
 * The single production caller is the execution-issue application service and
 * the successor-run creation transaction.
 */

import type { PlanStore } from "./sqlite-store.js";
import type { StoreTx } from "./transaction.js";

export interface ExecutionIssueRow {
  runId: string;
  issueId: string;
  finalPlanId: string;
  finalPlanHash: string;
  handoffId: string;
  handoffHash: string;
  kind: string;
  summary: string;
  detail: string;
  canonicalJson: string;
  issueHash: string;
  repositoryKind: "git" | "directory";
  repositoryRevision: string | null;
  operationId: string;
  sessionId: string;
  createdAt: string;
}

export interface ExecutionIssueRefRow {
  position: number;
  refType: "architecture" | "section" | "section_contract" | "decision" | "constraint";
  artifactId: string;
  revision: number;
}

export interface ExecutionIssueAdoptionRow {
  issueId: string;
  runId: string;
  successorRunId: string;
  baselineId: string;
  position: number;
  createdAt: string;
}

const ISSUE_COLUMNS =
  "run_id AS runId, issue_id AS issueId, final_plan_id AS finalPlanId, final_plan_hash AS finalPlanHash, "
  + "handoff_id AS handoffId, handoff_hash AS handoffHash, kind, summary, detail, canonical_json AS canonicalJson, "
  + "issue_hash AS issueHash, repository_kind AS repositoryKind, repository_revision AS repositoryRevision, "
  + "operation_id AS operationId, session_id AS sessionId, created_at AS createdAt";

const ADOPTION_COLUMNS =
  "issue_id AS issueId, run_id AS runId, successor_run_id AS successorRunId, baseline_id AS baselineId, "
  + "position, created_at AS createdAt";

export function insertExecutionIssueInTx(
  tx: StoreTx,
  issue: Omit<ExecutionIssueRow, "createdAt">,
  refs: ExecutionIssueRefRow[],
  now: string,
): void {
  tx.prepare(
    `INSERT INTO execution_issues (
       run_id, issue_id, final_plan_id, final_plan_hash, handoff_id, handoff_hash, kind, summary, detail,
       canonical_json, issue_hash, repository_kind, repository_revision, operation_id, session_id, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    issue.runId,
    issue.issueId,
    issue.finalPlanId,
    issue.finalPlanHash,
    issue.handoffId,
    issue.handoffHash,
    issue.kind,
    issue.summary,
    issue.detail,
    issue.canonicalJson,
    issue.issueHash,
    issue.repositoryKind,
    issue.repositoryRevision,
    issue.operationId,
    issue.sessionId,
    now,
  );
  for (const ref of refs) {
    tx.prepare(
      `INSERT INTO execution_issue_refs (run_id, issue_id, position, ref_type, artifact_id, revision)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(issue.runId, issue.issueId, ref.position, ref.refType, ref.artifactId, ref.revision);
  }
}

export function getExecutionIssueInTx(tx: StoreTx, runId: string, issueId: string): ExecutionIssueRow | null {
  const row = tx
    .prepare(`SELECT ${ISSUE_COLUMNS} FROM execution_issues WHERE run_id = ? AND issue_id = ?`)
    .get(runId, issueId) as ExecutionIssueRow | undefined;
  return row ?? null;
}

/** §15 — the idempotency lookup by the signed operation identity. */
export function findExecutionIssueByOperationInTx(
  tx: StoreTx,
  runId: string,
  operationId: string,
): ExecutionIssueRow | null {
  const row = tx
    .prepare(`SELECT ${ISSUE_COLUMNS} FROM execution_issues WHERE run_id = ? AND operation_id = ?`)
    .get(runId, operationId) as ExecutionIssueRow | undefined;
  return row ?? null;
}

export function listExecutionIssueRefsInTx(tx: StoreTx, runId: string, issueId: string): ExecutionIssueRefRow[] {
  return tx
    .prepare(
      "SELECT position, ref_type AS refType, artifact_id AS artifactId, revision "
      + "FROM execution_issue_refs WHERE run_id = ? AND issue_id = ? ORDER BY position",
    )
    .all(runId, issueId) as ExecutionIssueRefRow[];
}

/** §18 — open = no adoption row. Deterministic issue_id order. */
export function listOpenExecutionIssuesInTx(tx: StoreTx, runId: string): ExecutionIssueRow[] {
  return tx
    .prepare(
      `SELECT ${ISSUE_COLUMNS} FROM execution_issues i
       WHERE i.run_id = ? AND NOT EXISTS (
         SELECT 1 FROM execution_issue_adoptions a WHERE a.issue_id = i.issue_id
       )
       ORDER BY i.issue_id`,
    )
    .all(runId) as ExecutionIssueRow[];
}

export function countOpenExecutionIssuesInTx(tx: StoreTx, runId: string): number {
  const row = tx
    .prepare(
      "SELECT COUNT(*) AS n FROM execution_issues i "
      + "WHERE i.run_id = ? AND NOT EXISTS (SELECT 1 FROM execution_issue_adoptions a WHERE a.issue_id = i.issue_id)",
    )
    .get(runId) as { n: number };
  return row.n;
}

/**
 * §73 — every open issue of this run that is already adopted, with its
 * adoption row (used to name the existing successor on a raced re-entry).
 */
export function listExecutionIssuesInTx(tx: StoreTx, runId: string): ExecutionIssueRow[] {
  return tx
    .prepare(`SELECT ${ISSUE_COLUMNS} FROM execution_issues WHERE run_id = ? ORDER BY issue_id`)
    .all(runId) as ExecutionIssueRow[];
}

export function getExecutionIssueAdoptionInTx(tx: StoreTx, issueId: string): ExecutionIssueAdoptionRow | null {
  const row = tx
    .prepare(`SELECT ${ADOPTION_COLUMNS} FROM execution_issue_adoptions WHERE issue_id = ?`)
    .get(issueId) as ExecutionIssueAdoptionRow | undefined;
  return row ?? null;
}

/**
 * §17/§74 — the append-only adoption insert. UNIQUE(issue_id) is the
 * correctness fence: a racing second adoption fails on the same law the
 * index enforces, never on an application pre-check alone.
 */
export function insertExecutionIssueAdoptionInTx(
  tx: StoreTx,
  adoption: Omit<ExecutionIssueAdoptionRow, "createdAt">,
  now: string,
): void {
  tx.prepare(
    `INSERT INTO execution_issue_adoptions (issue_id, run_id, successor_run_id, baseline_id, position, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(adoption.issueId, adoption.runId, adoption.successorRunId, adoption.baselineId, adoption.position, now);
}

// ---------------------------------------------------------------------------
// Store-transaction wrappers (single-domain reads)
// ---------------------------------------------------------------------------

export function countOpenExecutionIssues(store: PlanStore, runId: string): number {
  return store.withRead((tx) => countOpenExecutionIssuesInTx(tx, runId));
}

export function listOpenExecutionIssues(store: PlanStore, runId: string): ExecutionIssueRow[] {
  return store.withRead((tx) => listOpenExecutionIssuesInTx(tx, runId));
}
