/**
 * PlanningRunBaseline persistence (Phase 15 §5/§26/§31/§32–§34/§53).
 *
 * Cardinality laws are DDL-enforced, never commented into existence:
 *
 *   PB-01  exactly one immutable baseline per successor run
 *          (baseline_id PK + UNIQUE(successor_run_id), §26)
 *   PB-02  the baseline, its issue bindings, its scope rows, and its
 *          materialization record are append-only history (no_update/
 *          no_delete triggers) — the baseline is NEVER revised (§26)
 *   PB-03  the adopted issue set is exactly the baseline_issues rows, in
 *          deterministic position order, hashed into issue_set_hash (§30/§31)
 *   PB-04  scope rows carry ONLY inherited_completed | needs_review (§55/§56)
 *          with the exact origin predecessor MemoryRef (§52)
 *   PB-05  at most one materialization per baseline (PRIMARY KEY, §53):
 *          created by the FIRST authorized successor PlanCommit, never earlier
 *          (§43/§51)
 */

import type { PlanStore } from "./sqlite-store.js";
import type { StoreTx } from "./transaction.js";

export interface PlanningRunBaselineRow {
  baselineId: string;
  successorRunId: string;
  predecessorRunId: string;
  finalPlanId: string;
  finalPlanHash: string;
  finalSnapshotId: string;
  finalCommitId: string;
  executionHandoffId: string;
  executionHandoffHash: string;
  issueSetHash: string;
  repositoryKind: "git" | "directory";
  repositoryRevision: string | null;
  canonicalJson: string;
  baselineHash: string;
  createdAt: string;
}

export interface BaselineIssueBindingRow {
  baselineId: string;
  issueId: string;
  position: number;
}

export interface BaselineScopeRow {
  baselineId: string;
  sectionId: string;
  scopeState: "inherited_completed" | "needs_review";
  originRunId: string;
  originSectionId: string;
  originRevision: number;
}

export interface BaselineMaterializationRow {
  baselineId: string;
  materializedCommitId: string;
  materializedSnapshotId: string;
  originManifestJson: string;
  createdAt: string;
}

const BASELINE_COLUMNS =
  "baseline_id AS baselineId, successor_run_id AS successorRunId, predecessor_run_id AS predecessorRunId, "
  + "final_plan_id AS finalPlanId, final_plan_hash AS finalPlanHash, final_snapshot_id AS finalSnapshotId, "
  + "final_commit_id AS finalCommitId, execution_handoff_id AS executionHandoffId, "
  + "execution_handoff_hash AS executionHandoffHash, issue_set_hash AS issueSetHash, "
  + "repository_kind AS repositoryKind, repository_revision AS repositoryRevision, "
  + "canonical_json AS canonicalJson, baseline_hash AS baselineHash, created_at AS createdAt";

export function insertPlanningRunBaselineInTx(
  tx: StoreTx,
  baseline: Omit<PlanningRunBaselineRow, "createdAt">,
  issues: BaselineIssueBindingRow[],
  scopes: BaselineScopeRow[],
  now: string,
): void {
  tx.prepare(
    `INSERT INTO planning_run_baselines (
       baseline_id, successor_run_id, predecessor_run_id, final_plan_id, final_plan_hash,
       final_snapshot_id, final_commit_id, execution_handoff_id, execution_handoff_hash,
       issue_set_hash, repository_kind, repository_revision, canonical_json, baseline_hash, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    baseline.baselineId,
    baseline.successorRunId,
    baseline.predecessorRunId,
    baseline.finalPlanId,
    baseline.finalPlanHash,
    baseline.finalSnapshotId,
    baseline.finalCommitId,
    baseline.executionHandoffId,
    baseline.executionHandoffHash,
    baseline.issueSetHash,
    baseline.repositoryKind,
    baseline.repositoryRevision,
    baseline.canonicalJson,
    baseline.baselineHash,
    now,
  );
  for (const issue of issues) {
    tx.prepare(
      "INSERT INTO planning_run_baseline_issues (baseline_id, issue_id, position) VALUES (?, ?, ?)",
    ).run(issue.baselineId, issue.issueId, issue.position);
  }
  for (const scope of scopes) {
    tx.prepare(
      `INSERT INTO planning_run_baseline_scopes (
         baseline_id, section_id, scope_state, origin_run_id, origin_section_id, origin_revision
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(scope.baselineId, scope.sectionId, scope.scopeState, scope.originRunId, scope.originSectionId, scope.originRevision);
  }
}

export function getPlanningRunBaselineForSuccessorInTx(
  tx: StoreTx,
  successorRunId: string,
): PlanningRunBaselineRow | null {
  const row = tx
    .prepare(`SELECT ${BASELINE_COLUMNS} FROM planning_run_baselines WHERE successor_run_id = ?`)
    .get(successorRunId) as PlanningRunBaselineRow | undefined;
  return row ?? null;
}

export function getPlanningRunBaselineForPredecessorInTx(
  tx: StoreTx,
  predecessorRunId: string,
): PlanningRunBaselineRow | null {
  const row = tx
    .prepare(`SELECT ${BASELINE_COLUMNS} FROM planning_run_baselines WHERE predecessor_run_id = ?`)
    .get(predecessorRunId) as PlanningRunBaselineRow | undefined;
  return row ?? null;
}

export function listBaselineIssuesInTx(tx: StoreTx, baselineId: string): BaselineIssueBindingRow[] {
  return tx
    .prepare(
      "SELECT baseline_id AS baselineId, issue_id AS issueId, position "
      + "FROM planning_run_baseline_issues WHERE baseline_id = ? ORDER BY position",
    )
    .all(baselineId) as BaselineIssueBindingRow[];
}

export function listBaselineScopesInTx(tx: StoreTx, baselineId: string): BaselineScopeRow[] {
  return tx
    .prepare(
      "SELECT baseline_id AS baselineId, section_id AS sectionId, scope_state AS scopeState, "
      + "origin_run_id AS originRunId, origin_section_id AS originSectionId, origin_revision AS originRevision "
      + "FROM planning_run_baseline_scopes WHERE baseline_id = ? ORDER BY section_id",
    )
    .all(baselineId) as BaselineScopeRow[];
}

/**
 * §56 — the baseline scope of ONE section of a successor run (null when the
 * run has no baseline or the section is outside the baseline scope). The
 * effective-state resolver merges this with the local workflow rows: local
 * state always wins (§58 — once amended, inheritance ceases).
 */
export function getBaselineScopeForSectionInTx(
  tx: StoreTx,
  successorRunId: string,
  sectionId: string,
): BaselineScopeRow | null {
  const row = tx
    .prepare(
      "SELECT s.baseline_id AS baselineId, s.section_id AS sectionId, s.scope_state AS scopeState, "
      + "s.origin_run_id AS originRunId, s.origin_section_id AS originSectionId, s.origin_revision AS originRevision "
      + "FROM planning_run_baseline_scopes s "
      + "JOIN planning_run_baselines b ON b.baseline_id = s.baseline_id "
      + "WHERE b.successor_run_id = ? AND s.section_id = ?",
    )
    .get(successorRunId, sectionId) as BaselineScopeRow | undefined;
  return row ?? null;
}

/** §53 — materialized ⟺ such a row exists. */
export function getBaselineMaterializationInTx(
  tx: StoreTx,
  baselineId: string,
): BaselineMaterializationRow | null {
  const row = tx
    .prepare(
      "SELECT baseline_id AS baselineId, materialized_commit_id AS materializedCommitId, "
      + "materialized_snapshot_id AS materializedSnapshotId, origin_manifest_json AS originManifestJson, "
      + "created_at AS createdAt FROM planning_run_baseline_materializations WHERE baseline_id = ?",
    )
    .get(baselineId) as BaselineMaterializationRow | undefined;
  return row ?? null;
}

/**
 * §51/§53 — the unique first-commit materialization record. The PRIMARY KEY
 * is the fence: a racing second materialization of the same baseline fails on
 * the same law the index enforces.
 */
export function insertBaselineMaterializationInTx(
  tx: StoreTx,
  materialization: Omit<BaselineMaterializationRow, "createdAt">,
  now: string,
): void {
  tx.prepare(
    `INSERT INTO planning_run_baseline_materializations (
       baseline_id, materialized_commit_id, materialized_snapshot_id, origin_manifest_json, created_at
     ) VALUES (?, ?, ?, ?, ?)`,
  ).run(
    materialization.baselineId,
    materialization.materializedCommitId,
    materialization.materializedSnapshotId,
    materialization.originManifestJson,
    now,
  );
}

// ---------------------------------------------------------------------------
// Store-transaction wrappers (single-domain reads)
// ---------------------------------------------------------------------------

export function getPlanningRunBaselineForSuccessor(store: PlanStore, successorRunId: string): PlanningRunBaselineRow | null {
  return store.withRead((tx) => getPlanningRunBaselineForSuccessorInTx(tx, successorRunId));
}

export function getPlanningRunBaselineForPredecessor(store: PlanStore, predecessorRunId: string): PlanningRunBaselineRow | null {
  return store.withRead((tx) => getPlanningRunBaselineForPredecessorInTx(tx, predecessorRunId));
}
