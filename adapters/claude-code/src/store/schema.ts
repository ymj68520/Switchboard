/**
 * Schema version authority and consistency validation (frozen plan §10/§26).
 *
 * `PRAGMA user_version` is the ONE authoritative schema version. The
 * `schema_migrations` table is an audit history, never a second authority —
 * the two must agree exactly (rows 1..N for user_version N) or the store is
 * STORE_SCHEMA_INVALID, which is never auto-repaired.
 */

import type { StoreConnection } from "./connection.js";
import { storeError } from "./errors.js";
import type { StoreTx } from "./transaction.js";
import { executionHandoffHash, type ExecutionHandoffV1 } from "../core/execution-handoff.js";
import { executionIssueHash, type ExecutionIssueV1 } from "../core/execution-issue.js";
import { planningRunBaselineHash, type PlanningRunBaselineV1 } from "../core/successor-baseline.js";

/** Read the authoritative schema version (live read, never cached). */
export function readSchemaVersion(db: StoreConnection | StoreTx): number {
  const row = db.prepare("PRAGMA user_version").get() as Record<string, unknown> | undefined;
  const value = row ? Object.values(row)[0] : undefined;
  if (typeof value !== "number") {
    throw storeError("STORE_SCHEMA_INVALID", "PRAGMA user_version is unreadable");
  }
  return value;
}

export function setSchemaVersion(db: StoreConnection | StoreTx, version: number): void {
  if (!Number.isInteger(version) || version < 0) {
    throw storeError("STORE_SCHEMA_INVALID", `invalid schema version: ${version}`);
  }
  db.exec(`PRAGMA user_version = ${version}`);
}

export interface MigrationHistoryRow {
  version: number;
  name: string;
  appliedAt: string;
  runtimeVersion: string;
}

export interface SchemaState {
  version: number;
  history: MigrationHistoryRow[];
  /** True when user_version and the migration history agree exactly. */
  consistent: boolean;
  problems: string[];
}

interface TableRow {
  name: string;
}

/** Infrastructure tables required once the store has reached schema v2. */
const SCHEMA_V2_TABLES = ["repositories", "workspaces", "session_bindings"] as const;

/** Planning-domain tables required once the store has reached schema v3. */
const SCHEMA_V3_TABLES = ["planning_runs"] as const;

/** Plan Memory tables required once the store has reached schema v4. */
const SCHEMA_V4_TABLES = [
  "memory_artifacts",
  "memory_revisions",
  "plan_snapshots",
  "snapshot_members",
  "plan_heads",
] as const;

/** Immutability triggers required once the store has reached schema v4. */
const SCHEMA_V4_IMMUTABILITY_TRIGGERS = [
  "memory_artifacts_no_update",
  "memory_artifacts_no_delete",
  "memory_revisions_no_update",
  "memory_revisions_no_delete",
  "plan_snapshots_no_update",
  "plan_snapshots_no_delete",
  "snapshot_members_no_update",
  "snapshot_members_no_delete",
] as const;

/** Proposal/Approval/Commit tables required once the store has reached v5. */
const SCHEMA_V5_TABLES = [
  "proposals",
  "proposal_revisions",
  "proposal_states",
  "approvals",
  "plan_commits",
  "audit_events",
] as const;

/** Immutability + constraint triggers required once the store has reached v5. */
const SCHEMA_V5_TRIGGERS = [
  "proposal_revisions_no_update",
  "proposal_revisions_no_delete",
  "approvals_no_update",
  "approvals_no_delete",
  "plan_commits_no_update",
  "plan_commits_no_delete",
  "audit_events_no_update",
  "audit_events_no_delete",
  "proposal_states_insert_awaiting",
  "proposal_states_transition_guard",
  "approvals_hash_match",
  "plan_heads_commit_pair_insert",
  "plan_heads_commit_pair_update",
] as const;

/** Constraint indexes backing the v5 uniqueness invariants. */
const SCHEMA_V5_INDEXES = [
  "idx_proposals_request",
  "idx_proposal_states_one_awaiting",
  "idx_approvals_request",
  "idx_approvals_proposal_revision",
  "idx_plan_commits_run_sequence",
  "idx_plan_commits_one_root",
  "idx_plan_commits_one_child",
  "idx_plan_commits_run_commit",
  "idx_plan_commits_approval",
] as const;

/** Observation/Evidence tables required once the store has reached v6 (Phase 9 §4). */
const SCHEMA_V6_TABLES = [
  "observations",
  "evidence_artifacts",
  "evidence_revisions",
  "evidence_observation_refs",
  "evidence_derived_refs",
] as const;

/** Immutability triggers required once the store has reached v6 (§6/§52). */
const SCHEMA_V6_TRIGGERS = [
  "observations_no_update",
  "observations_no_delete",
  "evidence_artifacts_no_update",
  "evidence_artifacts_no_delete",
  "evidence_revisions_no_update",
  "evidence_revisions_no_delete",
  "evidence_observation_refs_no_update",
  "evidence_observation_refs_no_delete",
  "evidence_derived_refs_no_update",
  "evidence_derived_refs_no_delete",
] as const;

/** Constraint index backing the deterministic ledger order (§20). */
const SCHEMA_V6_INDEXES = [
  "idx_observations_run_seq",
] as const;

/** Freshness/Proposal-V2 tables required once the store has reached v7 (Phase 10 §4). */
const SCHEMA_V7_TABLES = [
  "evidence_validation_events",
  "evidence_current_states",
  "proposal_evidence_refs",
] as const;

/** Immutability + terminal-state triggers required once the store has reached v7.
 * evidence_current_states is the materialized projection — UPDATE is its normal
 * operation (§7), so only its deletion is fenced. */
const SCHEMA_V7_TRIGGERS = [
  "evidence_validation_events_no_update",
  "evidence_validation_events_no_delete",
  "evidence_current_states_no_delete",
  "proposal_evidence_refs_no_update",
  "proposal_evidence_refs_no_delete",
  "evidence_validation_events_no_revival",
] as const;

/** Constraint indexes backing v7 freshness/derived lookups. */
const SCHEMA_V7_INDEXES = [
  "idx_evidence_validation_events_revision",
  "idx_evidence_derived_refs_upstream",
] as const;

/** Section workflow tables required once the store has reached v8 (Phase 11 §3). */
const SCHEMA_V8_TABLES = [
  "section_workflow_events",
  "section_workflow_states",
  "planning_active_work",
] as const;

/** Immutability triggers required once the store has reached v8. The
 * materialized state is a projection (UPDATE is its normal operation), so
 * only its deletion is fenced. planning_active_work is ordinary mutable
 * workflow state and carries no immutability triggers. */
const SCHEMA_V8_TRIGGERS = [
  "section_workflow_events_no_update",
  "section_workflow_events_no_delete",
  "section_workflow_states_no_delete",
] as const;

/** Constraint index backing the deterministic per-Section workflow history. */
const SCHEMA_V8_INDEXES = [
  "idx_section_workflow_events_section",
] as const;

/** Synthesis/validation tables required once the store has reached v9 (Phase 12 §11). */
const SCHEMA_V9_TABLES = [
  "synthesis_inputs",
  "synthesis_input_refs",
  "synthesis_input_evidence",
  "synthesis_manifests",
  "synthesis_manifest_refs",
  "semantic_validation_reports",
  "semantic_validation_findings",
] as const;

/** Immutability triggers required once the store has reached v9: every
 * synthesis/validation record is append-only history (§14/§36/§46). */
const SCHEMA_V9_TRIGGERS = [
  "synthesis_inputs_no_update",
  "synthesis_inputs_no_delete",
  "synthesis_input_refs_no_update",
  "synthesis_input_refs_no_delete",
  "synthesis_input_evidence_no_update",
  "synthesis_input_evidence_no_delete",
  "synthesis_manifests_no_update",
  "synthesis_manifests_no_delete",
  "synthesis_manifest_refs_no_update",
  "synthesis_manifest_refs_no_delete",
  "semantic_validation_reports_no_update",
  "semantic_validation_reports_no_delete",
  "semantic_validation_findings_no_update",
  "semantic_validation_findings_no_delete",
] as const;

/** Constraint indexes backing the v9 synthesis/validation lookups. */
const SCHEMA_V9_INDEXES = [
  "idx_synthesis_inputs_run",
  "idx_synthesis_manifests_input",
  "idx_validation_reports_manifest",
] as const;

/** Finalization/final-plan tables required once the store has reached v10 (Phase 13 §4). */
const SCHEMA_V10_TABLES = [
  "evidence_audit_snapshots",
  "evidence_audit_entries",
  "final_plan_candidates",
  "final_plan_candidate_refs",
  "proposal_final_plan_refs",
  "final_plans",
] as const;

/** Immutability triggers required once the store has reached v10: every
 * finalization record is append-only history (§6/§21/§22/§48/§55). */
const SCHEMA_V10_TRIGGERS = [
  "evidence_audit_snapshots_no_update",
  "evidence_audit_snapshots_no_delete",
  "evidence_audit_entries_no_update",
  "evidence_audit_entries_no_delete",
  "final_plan_candidates_no_update",
  "final_plan_candidates_no_delete",
  "final_plan_candidate_refs_no_update",
  "final_plan_candidate_refs_no_delete",
  "proposal_final_plan_refs_no_update",
  "proposal_final_plan_refs_no_delete",
  "final_plans_no_update",
  "final_plans_no_delete",
] as const;

/** Constraint indexes backing the v10 finalization lookups. */
const SCHEMA_V10_INDEXES = [
  "idx_evidence_audit_entries_audit",
  "idx_final_plan_candidates_run",
  "idx_proposal_final_plan_refs_candidate",
] as const;

/** Execution handoff/binding tables required once the store has reached v11 (Phase 14 §11). */
const SCHEMA_V11_TABLES = [
  "execution_handoffs",
  "execution_handoff_events",
  "execution_handoff_states",
  "execution_bindings",
] as const;

/** Immutability triggers required once the store has reached v11: the handoff
 * contract and its event log are append-only history (§13/§16). The operational
 * state and binding tables are deliberately mutable (§14/§20). */
const SCHEMA_V11_TRIGGERS = [
  "execution_handoffs_no_update",
  "execution_handoffs_no_delete",
  "execution_handoff_events_no_update",
  "execution_handoff_events_no_delete",
] as const;

/** Constraint indexes backing the v11 execution lookups. */
const SCHEMA_V11_INDEXES = [
  "idx_execution_handoff_events_handoff",
  "idx_execution_bindings_active_session",
  "idx_execution_bindings_session",
] as const;

/** ExecutionIssue + successor baseline tables required at schema v12 (Phase 15 §5). */
const SCHEMA_V12_TABLES = [
  "execution_issues",
  "execution_issue_refs",
  "execution_issue_adoptions",
  "planning_run_baselines",
  "planning_run_baseline_issues",
  "planning_run_baseline_scopes",
  "planning_run_baseline_materializations",
] as const;

/** Immutability triggers required at schema v12: the ENTIRE v12 domain is
 * append-only history (§4/§7/§17/§26/§31/§53) — no mutable table exists. */
const SCHEMA_V12_TRIGGERS = [
  "execution_issues_no_update",
  "execution_issues_no_delete",
  "execution_issue_refs_no_update",
  "execution_issue_refs_no_delete",
  "execution_issue_adoptions_no_update",
  "execution_issue_adoptions_no_delete",
  "planning_run_baselines_no_update",
  "planning_run_baselines_no_delete",
  "planning_run_baseline_issues_no_update",
  "planning_run_baseline_issues_no_delete",
  "planning_run_baseline_scopes_no_update",
  "planning_run_baseline_scopes_no_delete",
  "planning_run_baseline_materializations_no_update",
  "planning_run_baseline_materializations_no_delete",
] as const;

/** Constraint indexes backing the v12 issue/baseline lookups. */
const SCHEMA_V12_INDEXES = [
  "idx_execution_issue_refs_issue",
  "idx_execution_issue_adoptions_successor",
  "idx_planning_run_baseline_issues_baseline",
  "idx_planning_run_baseline_scopes_state",
] as const;

function tableNames(db: StoreConnection | StoreTx): Set<string> {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as TableRow[];
  return new Set(rows.map((row) => row.name));
}

function readHistory(db: StoreConnection | StoreTx): MigrationHistoryRow[] {
  const rows = db
    .prepare(
      "SELECT version, name, applied_at AS appliedAt, runtime_version AS runtimeVersion FROM schema_migrations ORDER BY version",
    )
    .all() as unknown as MigrationHistoryRow[];
  return rows;
}

/**
 * Structural checks for the v2 infrastructure tables (frozen plan §42).
 * Uniqueness/CHECK constraints are DDL-enforced; the validator re-derives
 * the invariant facts from DATA so a hand-mangled or partially-written store
 * cannot pass on `user_version = 2` alone.
 */
function validateSchemaV2(db: StoreConnection | StoreTx, tables: Set<string>, problems: string[]): void {
  for (const table of SCHEMA_V2_TABLES) {
    if (!tables.has(table)) {
      problems.push(`${table} table missing for schema version >= 2`);
    }
  }
  if (SCHEMA_V2_TABLES.some((table) => !tables.has(table))) {
    return; // further queries would just cascade errors
  }
  const badGenerations = db
    .prepare("SELECT count(*) AS n FROM session_bindings WHERE generation < 1")
    .get() as { n: number } | undefined;
  if ((badGenerations?.n ?? 0) > 0) {
    problems.push("session_bindings contains generation < 1 rows");
  }
  const badStates = db
    .prepare(
      "SELECT count(*) AS n FROM session_bindings WHERE state NOT IN ('attached', 'detached')",
    )
    .get() as { n: number } | undefined;
  if ((badStates?.n ?? 0) > 0) {
    problems.push("session_bindings contains unknown state values");
  }
  const duplicateActiveSessions = db
    .prepare(
      "SELECT session_id, count(*) AS n FROM session_bindings WHERE state = 'attached' GROUP BY session_id HAVING n > 1 LIMIT 1",
    )
    .get() as { session_id?: string; n: number } | undefined;
  if (duplicateActiveSessions !== undefined) {
    problems.push(
      `session '${duplicateActiveSessions.session_id}' holds multiple attached bindings`,
    );
  }
  const orphanWorkspaces = db
    .prepare(
      "SELECT count(*) AS n FROM workspaces w WHERE NOT EXISTS (SELECT 1 FROM repositories r WHERE r.repository_id = w.repository_id)",
    )
    .get() as { n: number } | undefined;
  if ((orphanWorkspaces?.n ?? 0) > 0) {
    problems.push("workspaces reference missing repositories");
  }
  const orphanBindings = db
    .prepare(
      "SELECT count(*) AS n FROM session_bindings b WHERE NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.workspace_id = b.workspace_id)",
    )
    .get() as { n: number } | undefined;
  if ((orphanBindings?.n ?? 0) > 0) {
    problems.push("session bindings reference missing workspaces");
  }
}

/**
 * PlanningRun data-integrity checks for schema v3 (frozen plan §40). Legacy
 * opaque bindings (run_id with no planning_runs row) are legal and skipped —
 * schema-2 history is preserved, never fabricated into runs.
 */
function validateSchemaV3(db: StoreConnection | StoreTx, tables: Set<string>, problems: string[]): void {
  for (const table of SCHEMA_V3_TABLES) {
    if (!tables.has(table)) {
      problems.push(`${table} table missing for schema version >= 3`);
    }
  }
  if (SCHEMA_V3_TABLES.some((table) => !tables.has(table))) {
    return;
  }
  const badVocabulary = db
    .prepare(
      "SELECT count(*) AS n FROM planning_runs WHERE lifecycle NOT IN ('active','completed','aborted') OR stage NOT IN ('discovery','architecture','detail','synthesis','validation','final')",
    )
    .get() as { n: number } | undefined;
  if ((badVocabulary?.n ?? 0) > 0) {
    problems.push("planning_runs contains illegal lifecycle/stage values");
  }
  const badRevisions = db
    .prepare("SELECT count(*) AS n FROM planning_runs WHERE revision < 1")
    .get() as { n: number } | undefined;
  if ((badRevisions?.n ?? 0) > 0) {
    problems.push("planning_runs contains revision < 1 rows");
  }
  const badGoals = db
    .prepare("SELECT count(*) AS n FROM planning_runs WHERE length(trim(goal)) = 0")
    .get() as { n: number } | undefined;
  if ((badGoals?.n ?? 0) > 0) {
    problems.push("planning_runs contains empty goals");
  }
  const badCompleted = db
    .prepare(
      "SELECT count(*) AS n FROM planning_runs WHERE lifecycle = 'completed' AND stage != 'final'",
    )
    .get() as { n: number } | undefined;
  if ((badCompleted?.n ?? 0) > 0) {
    problems.push("completed planning runs must be at stage final");
  }
  const terminalAttached = db
    .prepare(
      "SELECT count(*) AS n FROM planning_runs r JOIN session_bindings b ON b.run_id = r.run_id WHERE r.lifecycle != 'active' AND b.state = 'attached'",
    )
    .get() as { n: number } | undefined;
  if ((terminalAttached?.n ?? 0) > 0) {
    problems.push("terminal runs still hold attached bindings");
  }
  const workspaceDrift = db
    .prepare(
      "SELECT count(*) AS n FROM session_bindings b JOIN planning_runs r ON r.run_id = b.run_id WHERE b.workspace_id != r.workspace_id",
    )
    .get() as { n: number } | undefined;
  if ((workspaceDrift?.n ?? 0) > 0) {
    problems.push("bindings disagree with their planning run's workspace");
  }
  const orphanRuns = db
    .prepare(
      "SELECT count(*) AS n FROM planning_runs r WHERE NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.workspace_id = r.workspace_id)",
    )
    .get() as { n: number } | undefined;
  if ((orphanRuns?.n ?? 0) > 0) {
    problems.push("planning runs reference missing workspaces");
  }
}

/**
 * Structural Plan Memory checks for schema v4 (frozen plan §50/§E37): table
 * presence, immutability triggers, and supporting indexes. Cheap sqlite_
 * master lookups only — semantic snapshot validation (DAG, contract rules,
 * JSON shape) runs at snapshot creation/read time in the memory primitives,
 * so store open never scans history.
 */
function validateSchemaV4(db: StoreConnection | StoreTx, problems: string[]): void {
  const objectNames = new Set(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','trigger','index')").all() as {
        name: string;
      }[]
    ).map((row) => row.name),
  );
  for (const table of SCHEMA_V4_TABLES) {
    if (!objectNames.has(table)) {
      problems.push(`${table} table missing for schema version >= 4`);
    }
  }
  for (const trigger of SCHEMA_V4_IMMUTABILITY_TRIGGERS) {
    if (!objectNames.has(trigger)) {
      problems.push(`immutability trigger ${trigger} missing for schema version >= 4`);
    }
  }
}

/**
 * Structural Proposal/Approval/PlanCommit checks for schema v5 (frozen plan
 * Phase 6 §98): table presence, immutability + constraint triggers, and the
 * unique indexes that pin one-awaiting-per-run, approval exactness, and the
 * linear commit chain. Cheap sqlite_master lookups plus a PRAGMA column
 * check on the upgraded plan_heads — NO O(history) commit-chain scan (the
 * chain validator runs at commit time and via the explicit read API).
 */
function validateSchemaV5(db: StoreConnection | StoreTx, problems: string[]): void {
  const objectNames = new Set(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','trigger','index')").all() as {
        name: string;
      }[]
    ).map((row) => row.name),
  );
  for (const table of SCHEMA_V5_TABLES) {
    if (!objectNames.has(table)) {
      problems.push(`${table} table missing for schema version >= 5`);
    }
  }
  for (const trigger of SCHEMA_V5_TRIGGERS) {
    if (!objectNames.has(trigger)) {
      problems.push(`constraint trigger ${trigger} missing for schema version >= 5`);
    }
  }
  for (const index of SCHEMA_V5_INDEXES) {
    if (!objectNames.has(index)) {
      problems.push(`constraint index ${index} missing for schema version >= 5`);
    }
  }
  // The upgraded plan_heads must carry the commit side of the HEAD pair.
  const headColumns = db.prepare("PRAGMA table_info(plan_heads)").all() as { name?: unknown }[];
  const columnNames = new Set(headColumns.map((column) => (typeof column.name === "string" ? column.name : "")));
  if (!columnNames.has("head_commit_id")) {
    problems.push("plan_heads is missing head_commit_id for schema version >= 5");
  }
}

/**
 * Structural Observation/Evidence checks for schema v6 (Phase 9 §4/§6/§52):
 * table presence, immutability triggers, and the ledger order + capture
 * idempotency indexes. Cheap sqlite_master lookups only.
 */
function validateSchemaV6(db: StoreConnection | StoreTx, problems: string[]): void {
  const objectNames = new Set(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','trigger','index')").all() as {
        name: string;
      }[]
    ).map((row) => row.name),
  );
  for (const table of SCHEMA_V6_TABLES) {
    if (!objectNames.has(table)) {
      problems.push(`${table} table missing for schema version >= 6`);
    }
  }
  for (const trigger of SCHEMA_V6_TRIGGERS) {
    if (!objectNames.has(trigger)) {
      problems.push(`constraint trigger ${trigger} missing for schema version >= 6`);
    }
  }
  for (const index of SCHEMA_V6_INDEXES) {
    if (!objectNames.has(index)) {
      problems.push(`constraint index ${index} missing for schema version >= 6`);
    }
  }
}

/**
 * Structural freshness/Proposal-V2 checks for schema v7 (Phase 10 §4/§5/§7):
 * table presence, immutability + terminal-state triggers, and the validation
 * history / derived-upstream lookup indexes. Cheap sqlite_master lookups only.
 */
function validateSchemaV7(db: StoreConnection | StoreTx, problems: string[]): void {
  const objectNames = new Set(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','trigger','index')").all() as {
        name: string;
      }[]
    ).map((row) => row.name),
  );
  for (const table of SCHEMA_V7_TABLES) {
    if (!objectNames.has(table)) {
      problems.push(`${table} table missing for schema version >= 7`);
    }
  }
  for (const trigger of SCHEMA_V7_TRIGGERS) {
    if (!objectNames.has(trigger)) {
      problems.push(`constraint trigger ${trigger} missing for schema version >= 7`);
    }
  }
  for (const index of SCHEMA_V7_INDEXES) {
    if (!objectNames.has(index)) {
      problems.push(`constraint index ${index} missing for schema version >= 7`);
    }
  }
}

/**
 * Structural + data checks for schema v8 (Phase 11 §69): table/trigger/index
 * presence plus the workflow-invariant facts — materialized state matches its
 * last event, every Section identity has a workflow state, completion
 * provenance references real Section revisions, and active work points at a
 * Section in the run's current HEAD snapshot. Targeted LIMIT-1 queries only —
 * never a full-history replay at store open.
 */
function validateSchemaV8(db: StoreConnection | StoreTx, version: number, problems: string[]): void {
  const objectNames = new Set(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','trigger','index')").all() as {
        name: string;
      }[]
    ).map((row) => row.name),
  );
  for (const table of SCHEMA_V8_TABLES) {
    if (!objectNames.has(table)) {
      problems.push(`${table} table missing for schema version >= 8`);
    }
  }
  for (const trigger of SCHEMA_V8_TRIGGERS) {
    if (!objectNames.has(trigger)) {
      problems.push(`constraint trigger ${trigger} missing for schema version >= 8`);
    }
  }
  for (const index of SCHEMA_V8_INDEXES) {
    if (!objectNames.has(index)) {
      problems.push(`constraint index ${index} missing for schema version >= 8`);
    }
  }
  if (SCHEMA_V8_TABLES.some((table) => !objectNames.has(table))) {
    return; // further queries would just cascade errors
  }
  // The data-level checks below also read Plan Memory base tables; when an
  // earlier-version validator has already flagged those as missing, skip
  // instead of cascading SQL errors.
  const baseWorldPresent =
    objectNames.has("memory_artifacts") && objectNames.has("memory_revisions") && objectNames.has("plan_heads") && objectNames.has("snapshot_members");
  if (!baseWorldPresent) {
    return;
  }
  // Materialized state must equal its last workflow event's target state (§7/§69).
  const stateEventDrift = db
    .prepare(
      "SELECT s.run_id AS runId, s.section_id AS sectionId FROM section_workflow_states s "
      + "JOIN section_workflow_events e ON e.run_id = s.run_id AND e.event_seq = s.last_event_seq "
      + "WHERE e.to_state != s.status LIMIT 1",
    )
    .get() as { runId?: string; sectionId?: string } | undefined;
  if (stateEventDrift !== undefined) {
    problems.push(
      `section workflow state '${stateEventDrift.sectionId}' in run '${stateEventDrift.runId}' does not match its last workflow event`,
    );
  }
  // Every Section identity has a workflow state row (backfill completeness).
  // Phase 15: an inherited_completed Section of a successor baseline stays
  // row-less BY DESIGN (§28 — completion comes from the baseline merge, never
  // a fabricated local row), so those identities are exempt from v12 on.
  const missingState = db
    .prepare(
      version >= 12
        ? "SELECT a.run_id AS runId, a.artifact_id AS sectionId FROM memory_artifacts a "
          + "WHERE a.kind = 'section' AND NOT EXISTS ("
          + "SELECT 1 FROM section_workflow_states s WHERE s.run_id = a.run_id AND s.section_id = a.artifact_id) "
          + "AND NOT EXISTS ("
          + "SELECT 1 FROM planning_run_baselines b "
          + "JOIN planning_run_baseline_scopes bs ON bs.baseline_id = b.baseline_id "
          + "WHERE b.successor_run_id = a.run_id AND bs.section_id = a.artifact_id "
          + "AND bs.scope_state = 'inherited_completed') LIMIT 1"
        : "SELECT a.run_id AS runId, a.artifact_id AS sectionId FROM memory_artifacts a "
          + "WHERE a.kind = 'section' AND NOT EXISTS ("
          + "SELECT 1 FROM section_workflow_states s WHERE s.run_id = a.run_id AND s.section_id = a.artifact_id) LIMIT 1",
    )
    .get() as { runId?: string; sectionId?: string } | undefined;
  if (missingState !== undefined) {
    problems.push(`section '${missingState.sectionId}' in run '${missingState.runId}' has no workflow state`);
  }
  // A workflow state without a real Section identity is corruption.
  const orphanState = db
    .prepare(
      "SELECT s.run_id AS runId, s.section_id AS sectionId FROM section_workflow_states s "
      + "WHERE NOT EXISTS ("
      + "SELECT 1 FROM memory_artifacts a WHERE a.run_id = s.run_id AND a.kind = 'section' AND a.artifact_id = s.section_id) LIMIT 1",
    )
    .get() as { runId?: string; sectionId?: string } | undefined;
  if (orphanState !== undefined) {
    problems.push(
      `section workflow state '${orphanState.sectionId}' in run '${orphanState.runId}' references a missing section identity`,
    );
  }
  // completed_revision must reference a real Section revision (§69).
  const badCompletedRevision = db
    .prepare(
      "SELECT s.run_id AS runId, s.section_id AS sectionId, s.completed_revision AS revision FROM section_workflow_states s "
      + "WHERE s.completed_revision IS NOT NULL AND NOT EXISTS ("
      + "SELECT 1 FROM memory_revisions m WHERE m.run_id = s.run_id AND m.kind = 'section' "
      + "AND m.artifact_id = s.section_id AND m.revision = s.completed_revision) LIMIT 1",
    )
    .get() as { runId?: string; sectionId?: string; revision?: number } | undefined;
  if (badCompletedRevision !== undefined) {
    problems.push(
      `completed revision ${badCompletedRevision.revision} for section '${badCompletedRevision.sectionId}' in run '${badCompletedRevision.runId}' references a missing section revision`,
    );
  }
  // Active work must point at a Section in the run's current HEAD snapshot
  // (§69) — OR, for a Phase 15 successor whose baseline is not yet
  // materialized (HEAD intentionally absent until the first authorized
  // commit), at a needs_review Section of that baseline. The exemption needs
  // the v12 baseline tables, so it applies only from schema version 12 on.
  const badActiveWork = db
    .prepare(
      version >= 12
        ? "SELECT w.run_id AS runId, w.section_id AS sectionId FROM planning_active_work w "
          + "WHERE NOT EXISTS ("
          + "SELECT 1 FROM plan_heads h JOIN snapshot_members sm ON sm.snapshot_id = h.head_snapshot_id "
          + "WHERE h.run_id = w.run_id AND sm.run_id = w.run_id AND sm.kind = 'section' AND sm.artifact_id = w.section_id) "
          + "AND NOT EXISTS ("
          + "SELECT 1 FROM planning_run_baselines b "
          + "JOIN planning_run_baseline_scopes bs ON bs.baseline_id = b.baseline_id "
          + "WHERE b.successor_run_id = w.run_id AND bs.section_id = w.section_id "
          + "AND bs.scope_state = 'needs_review' AND NOT EXISTS ("
          + "SELECT 1 FROM planning_run_baseline_materializations m WHERE m.baseline_id = b.baseline_id)) LIMIT 1"
        : "SELECT w.run_id AS runId, w.section_id AS sectionId FROM planning_active_work w "
          + "WHERE NOT EXISTS ("
          + "SELECT 1 FROM plan_heads h JOIN snapshot_members sm ON sm.snapshot_id = h.head_snapshot_id "
          + "WHERE h.run_id = w.run_id AND sm.run_id = w.run_id AND sm.kind = 'section' AND sm.artifact_id = w.section_id) LIMIT 1",
    )
    .get() as { runId?: string; sectionId?: string } | undefined;
  if (badActiveWork !== undefined) {
    problems.push(
      `active section '${badActiveWork.sectionId}' in run '${badActiveWork.runId}' is not present in the current HEAD snapshot`,
    );
  }
}

/**
 * Structural + data checks for schema v9 (Phase 12 §90): table/trigger/index
 * presence plus the synthesis-domain identity facts — an input's base
 * snapshot belongs to its run and its base commit produced exactly that
 * snapshot, input refs are exact members of the base snapshot, manifests bind
 * the exact input (hash included) and only cite input refs, reports bind the
 * exact manifest/input, finding refs stay inside the frozen bundle, clean is
 * exclusive, and the immutability triggers exist. Targeted LIMIT-1 queries —
 * never a full-history replay at store open.
 */
function validateSchemaV9(db: StoreConnection | StoreTx, problems: string[]): void {
  const objectNames = new Set(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','trigger','index')").all() as {
        name: string;
      }[]
    ).map((row) => row.name),
  );
  for (const table of SCHEMA_V9_TABLES) {
    if (!objectNames.has(table)) {
      problems.push(`${table} table missing for schema version >= 9`);
    }
  }
  for (const trigger of SCHEMA_V9_TRIGGERS) {
    if (!objectNames.has(trigger)) {
      problems.push(`constraint trigger ${trigger} missing for schema version >= 9`);
    }
  }
  for (const index of SCHEMA_V9_INDEXES) {
    if (!objectNames.has(index)) {
      problems.push(`constraint index ${index} missing for schema version >= 9`);
    }
  }
  if (SCHEMA_V9_TABLES.some((table) => !objectNames.has(table))) {
    return; // further queries would just cascade errors
  }
  // The data-level checks below also read earlier base tables; when an
  // earlier-version validator has already flagged those as missing, skip
  // instead of cascading SQL errors.
  const baseWorldPresent =
    objectNames.has("plan_commits") && objectNames.has("snapshot_members") && objectNames.has("memory_revisions") && objectNames.has("evidence_revisions");
  if (!baseWorldPresent) {
    return;
  }
  // Input base commit must produce the input's base snapshot (§90).
  const basePairDrift = db
    .prepare(
      "SELECT i.run_id AS runId, i.input_id AS inputId FROM synthesis_inputs i "
      + "JOIN plan_commits c ON c.run_id = i.run_id AND c.commit_id = i.base_head_commit_id "
      + "WHERE c.resulting_snapshot_id != i.base_head_snapshot_id LIMIT 1",
    )
    .get() as { runId?: string; inputId?: string } | undefined;
  if (basePairDrift !== undefined) {
    problems.push(
      `synthesis input '${basePairDrift.inputId}' in run '${basePairDrift.runId}' has a base commit whose resulting snapshot is not the base snapshot`,
    );
  }
  // Input refs must be exact members of the base snapshot (§16/§90).
  const refOutsideSnapshot = db
    .prepare(
      "SELECT r.run_id AS runId, r.input_id AS inputId, r.artifact_id AS artifactId FROM synthesis_input_refs r "
      + "JOIN synthesis_inputs i ON i.run_id = r.run_id AND i.input_id = r.input_id "
      + "WHERE NOT EXISTS (SELECT 1 FROM snapshot_members sm WHERE sm.snapshot_id = i.base_head_snapshot_id "
      + "AND sm.run_id = r.run_id AND sm.kind = r.kind AND sm.artifact_id = r.artifact_id AND sm.revision = r.revision) LIMIT 1",
    )
    .get() as { runId?: string; inputId?: string; artifactId?: string } | undefined;
  if (refOutsideSnapshot !== undefined) {
    problems.push(
      `synthesis input '${refOutsideSnapshot.inputId}' in run '${refOutsideSnapshot.runId}' references '${refOutsideSnapshot.artifactId}' outside its base snapshot`,
    );
  }
  // A manifest must carry the exact input hash of its input (§35/§90).
  const manifestHashDrift = db
    .prepare(
      "SELECT m.run_id AS runId, m.manifest_id AS manifestId FROM synthesis_manifests m "
      + "JOIN synthesis_inputs i ON i.run_id = m.run_id AND i.input_id = m.input_id "
      + "WHERE m.input_hash != i.input_hash LIMIT 1",
    )
    .get() as { runId?: string; manifestId?: string } | undefined;
  if (manifestHashDrift !== undefined) {
    problems.push(
      `synthesis manifest '${manifestHashDrift.manifestId}' in run '${manifestHashDrift.runId}' does not bind its input's exact hash`,
    );
  }
  // Manifest supporting refs must be a subset of the input refs (§38/§90).
  const manifestRefOutsideInput = db
    .prepare(
      "SELECT r.run_id AS runId, r.manifest_id AS manifestId, r.kind AS kind, r.artifact_id AS artifactId "
      + "FROM synthesis_manifest_refs r JOIN synthesis_manifests m ON m.run_id = r.run_id AND m.manifest_id = r.manifest_id "
      + "WHERE NOT EXISTS (SELECT 1 FROM synthesis_input_refs ir WHERE ir.run_id = r.run_id AND ir.input_id = m.input_id "
      + "AND ir.kind = (CASE r.kind WHEN 'section_contract' THEN 'section' ELSE r.kind END) "
      + "AND ir.artifact_id = r.artifact_id AND ir.revision = r.revision) "
      + "AND NOT EXISTS (SELECT 1 FROM synthesis_input_evidence ie WHERE ie.run_id = r.run_id AND ie.input_id = m.input_id "
      + "AND r.kind = 'evidence' AND ie.evidence_id = r.artifact_id AND ie.evidence_revision = r.revision) LIMIT 1",
    )
    .get() as { runId?: string; manifestId?: string; kind?: string; artifactId?: string } | undefined;
  if (manifestRefOutsideInput !== undefined) {
    problems.push(
      `synthesis manifest '${manifestRefOutsideInput.manifestId}' in run '${manifestRefOutsideInput.runId}' cites '${manifestRefOutsideInput.artifactId}' (${manifestRefOutsideInput.kind}) outside its frozen input`,
    );
  }
  // A report must reference the exact manifest AND the manifest's exact input
  // with matching hashes (§46/§90).
  const reportBindingDrift = db
    .prepare(
      "SELECT r.run_id AS runId, r.report_id AS reportId FROM semantic_validation_reports r "
      + "JOIN synthesis_manifests m ON m.run_id = r.run_id AND m.manifest_id = r.manifest_id "
      + "WHERE r.input_id != m.input_id OR r.manifest_hash != m.manifest_hash "
      + "OR r.input_hash != (SELECT i.input_hash FROM synthesis_inputs i WHERE i.run_id = r.run_id AND i.input_id = m.input_id) LIMIT 1",
    )
    .get() as { runId?: string; reportId?: string } | undefined;
  if (reportBindingDrift !== undefined) {
    problems.push(
      `validation report '${reportBindingDrift.reportId}' in run '${reportBindingDrift.runId}' does not bind its manifest/input exactly`,
    );
  }
  // Finding refs must belong to the frozen validation bundle (§37/§90) —
  // subject and supporting refs alike. Refs are JSON projections
  // ({kind,id,revision}); json_extract keeps the check inside SQL.
  const findingRefQueries = [
    "f.subject_refs_json",
    "f.supporting_refs_json",
  ];
  for (const column of findingRefQueries) {
    const findingRefOutsideBundle = db
      .prepare(
        `SELECT f.run_id AS runId, f.finding_id AS findingId, je.value AS ref FROM semantic_validation_findings f `
        + `JOIN json_each(${column}) je WHERE json_valid(je.value) AND NOT EXISTS (`
        + "SELECT 1 FROM semantic_validation_reports r JOIN synthesis_input_refs ir ON ir.run_id = r.run_id AND ir.input_id = r.input_id "
        + "WHERE r.run_id = f.run_id AND r.report_id = f.report_id "
        + "AND ir.kind = (CASE json_extract(je.value,'$.kind') WHEN 'section_contract' THEN 'section' ELSE json_extract(je.value,'$.kind') END) "
        + "AND ir.artifact_id = json_extract(je.value,'$.id') AND ir.revision = json_extract(je.value,'$.revision') "
        + ") AND NOT EXISTS ("
        + "SELECT 1 FROM semantic_validation_reports r2 JOIN synthesis_input_evidence ie ON ie.run_id = r2.run_id AND ie.input_id = r2.input_id "
        + "WHERE r2.run_id = f.run_id AND r2.report_id = f.report_id AND json_extract(je.value,'$.kind') = 'evidence' "
        + "AND ie.evidence_id = json_extract(je.value,'$.id') AND ie.evidence_revision = json_extract(je.value,'$.revision') "
        + ") LIMIT 1",
      )
      .get() as { runId?: string; findingId?: string; ref?: string } | undefined;
    if (findingRefOutsideBundle !== undefined) {
      problems.push(
        `validation finding '${findingRefOutsideBundle.findingId}' in run '${findingRefOutsideBundle.runId}' cites a ref outside the frozen bundle (${column})`,
      );
    }
  }
  // clean exclusivity (§48): is_clean=1 ⇔ findings are exactly [clean].
  const badCleanReport = db
    .prepare(
      "SELECT r.run_id AS runId, r.report_id AS reportId FROM semantic_validation_reports r "
      + "WHERE (r.is_clean = 1 AND ((SELECT COUNT(*) FROM semantic_validation_findings f "
      + "WHERE f.run_id = r.run_id AND f.report_id = r.report_id AND f.kind = 'clean') != 1 "
      + "OR (SELECT COUNT(*) FROM semantic_validation_findings f "
      + "WHERE f.run_id = r.run_id AND f.report_id = r.report_id AND f.kind != 'clean') != 0)) "
      + "OR (r.is_clean = 0 AND ((SELECT COUNT(*) FROM semantic_validation_findings f "
      + "WHERE f.run_id = r.run_id AND f.report_id = r.report_id AND f.kind = 'clean') != 0 "
      + "OR (SELECT COUNT(*) FROM semantic_validation_findings f "
      + "WHERE f.run_id = r.run_id AND f.report_id = r.report_id) = 0)) LIMIT 1",
    )
    .get() as { runId?: string; reportId?: string } | undefined;
  if (badCleanReport !== undefined) {
    problems.push(
      `validation report '${badCleanReport.reportId}' in run '${badCleanReport.runId}' violates clean exclusivity`,
    );
  }
}

/**
 * Structural + data checks for schema v10 (Phase 13 §91): finalization tables
 * and immutability triggers exist; audit entries point to exact same-run
 * Evidence revisions; candidate base HEAD/commit pairs are valid and the
 * synthesis chain is exact; candidate refs belong to the frozen synthesis
 * world; the proposal↔candidate binding carries the exact candidate hash; a
 * FinalPlan references its exact candidate and its approval/proposal/commit
 * all correspond, with the Final PlanCommit's resulting snapshot in the same
 * run; FinalPlan stays unique per run. Store-open NEVER re-runs the
 * FinalizationGate (§91) — only these identity facts.
 */
function validateSchemaV10(db: StoreConnection | StoreTx, problems: string[]): void {
  const objectNames = new Set(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','trigger','index')").all() as {
        name: string;
      }[]
    ).map((row) => row.name),
  );
  for (const table of SCHEMA_V10_TABLES) {
    if (!objectNames.has(table)) {
      problems.push(`${table} table missing for schema version >= 10`);
    }
  }
  for (const trigger of SCHEMA_V10_TRIGGERS) {
    if (!objectNames.has(trigger)) {
      problems.push(`constraint trigger ${trigger} missing for schema version >= 10`);
    }
  }
  for (const index of SCHEMA_V10_INDEXES) {
    if (!objectNames.has(index)) {
      problems.push(`constraint index ${index} missing for schema version >= 10`);
    }
  }
  if (SCHEMA_V10_TABLES.some((table) => !objectNames.has(table))) {
    return;
  }
  const baseWorldPresent =
    objectNames.has("plan_commits") && objectNames.has("snapshot_members") && objectNames.has("proposals") && objectNames.has("synthesis_inputs");
  if (!baseWorldPresent) {
    return;
  }
  // Audit entries must point to exact same-run Evidence revisions (§91).
  const auditEntryDrift = db
    .prepare(
      "SELECT e.run_id AS runId, e.audit_id AS auditId, e.evidence_id AS evidenceId FROM evidence_audit_entries e "
      + "WHERE NOT EXISTS (SELECT 1 FROM evidence_revisions r WHERE r.run_id = e.run_id "
      + "AND r.evidence_id = e.evidence_id AND r.revision = e.evidence_revision) LIMIT 1",
    )
    .get() as { runId?: string; auditId?: string; evidenceId?: string } | undefined;
  if (auditEntryDrift !== undefined) {
    problems.push(
      `evidence audit '${auditEntryDrift.auditId}' in run '${auditEntryDrift.runId}' references missing evidence revision '${auditEntryDrift.evidenceId}'`,
    );
  }
  // Candidate base HEAD/commit pair must be a real commit-chain pair (§91).
  const candidateBaseDrift = db
    .prepare(
      "SELECT c.run_id AS runId, c.candidate_id AS candidateId FROM final_plan_candidates c "
      + "JOIN plan_commits p ON p.run_id = c.run_id AND p.commit_id = c.base_head_commit_id "
      + "WHERE p.resulting_snapshot_id != c.base_head_snapshot_id LIMIT 1",
    )
    .get() as { runId?: string; candidateId?: string } | undefined;
  if (candidateBaseDrift !== undefined) {
    problems.push(
      `final plan candidate '${candidateBaseDrift.candidateId}' in run '${candidateBaseDrift.runId}' has a base commit whose resulting snapshot is not the base snapshot`,
    );
  }
  // The candidate's synthesis chain must be exact (§17/§91).
  const candidateChainDrift = db
    .prepare(
      "SELECT c.run_id AS runId, c.candidate_id AS candidateId FROM final_plan_candidates c "
      + "JOIN synthesis_inputs i ON i.run_id = c.run_id AND i.input_id = c.input_id "
      + "JOIN synthesis_manifests m ON m.run_id = c.run_id AND m.manifest_id = c.manifest_id "
      + "JOIN semantic_validation_reports r ON r.run_id = c.run_id AND r.report_id = c.report_id "
      + "WHERE c.input_hash != i.input_hash OR m.input_id != c.input_id OR m.input_hash != c.input_hash "
      + "OR m.manifest_hash != c.manifest_hash OR r.manifest_id != c.manifest_id OR r.manifest_hash != c.manifest_hash "
      + "OR r.input_id != c.input_id OR r.input_hash != c.input_hash OR r.is_clean != 1 LIMIT 1",
    )
    .get() as { runId?: string; candidateId?: string } | undefined;
  if (candidateChainDrift !== undefined) {
    problems.push(
      `final plan candidate '${candidateChainDrift.candidateId}' in run '${candidateChainDrift.runId}' does not bind an exact clean synthesis chain`,
    );
  }
  // Candidate refs must belong to the frozen synthesis world (§91).
  const candidateRefOutsideInput = db
    .prepare(
      "SELECT r.run_id AS runId, r.candidate_id AS candidateId, r.family AS family, r.artifact_id AS artifactId "
      + "FROM final_plan_candidate_refs r JOIN final_plan_candidates c ON c.run_id = r.run_id AND c.candidate_id = r.candidate_id "
      + "WHERE r.family != 'evidence' AND NOT EXISTS (SELECT 1 FROM synthesis_input_refs ir WHERE ir.run_id = r.run_id "
      + "AND ir.input_id = c.input_id AND ir.kind = r.family AND ir.artifact_id = r.artifact_id AND ir.revision = r.revision) LIMIT 1",
    )
    .get() as { runId?: string; candidateId?: string; family?: string; artifactId?: string } | undefined;
  if (candidateRefOutsideInput !== undefined) {
    problems.push(
      `final plan candidate '${candidateRefOutsideInput.candidateId}' in run '${candidateRefOutsideInput.runId}' references '${candidateRefOutsideInput.artifactId}' (${candidateRefOutsideInput.family}) outside its frozen input`,
    );
  }
  const candidateEvidenceOutsideInput = db
    .prepare(
      "SELECT r.run_id AS runId, r.candidate_id AS candidateId, r.artifact_id AS artifactId "
      + "FROM final_plan_candidate_refs r JOIN final_plan_candidates c ON c.run_id = r.run_id AND c.candidate_id = r.candidate_id "
      + "WHERE r.family = 'evidence' AND NOT EXISTS (SELECT 1 FROM synthesis_input_evidence ie WHERE ie.run_id = r.run_id "
      + "AND ie.input_id = c.input_id AND ie.evidence_id = r.artifact_id AND ie.evidence_revision = r.revision) LIMIT 1",
    )
    .get() as { runId?: string; candidateId?: string; artifactId?: string } | undefined;
  if (candidateEvidenceOutsideInput !== undefined) {
    problems.push(
      `final plan candidate '${candidateEvidenceOutsideInput.candidateId}' in run '${candidateEvidenceOutsideInput.runId}' references evidence '${candidateEvidenceOutsideInput.artifactId}' outside its frozen input`,
    );
  }
  // The proposal↔candidate binding must carry the candidate's exact hash (§91).
  const proposalRefHashDrift = db
    .prepare(
      "SELECT p.run_id AS runId, p.proposal_id AS proposalId FROM proposal_final_plan_refs p "
      + "JOIN final_plan_candidates c ON c.run_id = p.run_id AND c.candidate_id = p.candidate_id "
      + "WHERE p.candidate_hash != c.candidate_hash LIMIT 1",
    )
    .get() as { runId?: string; proposalId?: string } | undefined;
  if (proposalRefHashDrift !== undefined) {
    problems.push(
      `final plan proposal '${proposalRefHashDrift.proposalId}' in run '${proposalRefHashDrift.runId}' binds a stale candidate hash`,
    );
  }
  // A FinalPlan must reference its exact candidate and correspond to its
  // approval/proposal/commit chain, with the commit's snapshot in-run (§91).
  const finalPlanDrift = db
    .prepare(
      "SELECT f.run_id AS runId, f.final_plan_id AS finalPlanId FROM final_plans f "
      + "LEFT JOIN final_plan_candidates c ON c.run_id = f.run_id AND c.candidate_id = f.candidate_id AND c.candidate_hash = f.candidate_hash "
      + "LEFT JOIN proposals pr ON pr.run_id = f.run_id AND pr.proposal_id = f.proposal_id "
      + "LEFT JOIN proposal_states ps ON ps.run_id = f.run_id AND ps.proposal_id = f.proposal_id AND ps.revision = f.proposal_revision AND ps.status = 'approved' "
      + "LEFT JOIN approvals a ON a.approval_id = f.approval_id AND a.run_id = f.run_id AND a.proposal_id = f.proposal_id "
      + "LEFT JOIN plan_commits pc ON pc.commit_id = f.commit_id AND pc.run_id = f.run_id AND pc.approval_id = f.approval_id "
      + "LEFT JOIN plan_snapshots s ON s.run_id = f.run_id AND s.snapshot_id = f.snapshot_id "
      + "WHERE c.candidate_id IS NULL OR pr.proposal_id IS NULL OR ps.proposal_id IS NULL "
      + "OR a.approval_id IS NULL OR pc.commit_id IS NULL OR s.snapshot_id IS NULL "
      + "OR pc.resulting_snapshot_id != f.snapshot_id LIMIT 1",
    )
    .get() as { runId?: string; finalPlanId?: string } | undefined;
  if (finalPlanDrift !== undefined) {
    problems.push(
      `final plan '${finalPlanDrift.finalPlanId}' in run '${finalPlanDrift.runId}' has broken candidate/proposal/approval/commit/snapshot provenance`,
    );
  }
  // Final PlanCommit must reference the final proposal revision exactly.
  const finalCommitDrift = db
    .prepare(
      "SELECT f.run_id AS runId, f.final_plan_id AS finalPlanId FROM final_plans f "
      + "JOIN plan_commits pc ON pc.run_id = f.run_id AND pc.commit_id = f.commit_id "
      + "WHERE pc.proposal_id != f.proposal_id OR pc.proposal_revision != f.proposal_revision LIMIT 1",
    )
    .get() as { runId?: string; finalPlanId?: string } | undefined;
  if (finalCommitDrift !== undefined) {
    problems.push(
      `final plan '${finalCommitDrift.finalPlanId}' in run '${finalCommitDrift.runId}' has a Final PlanCommit that does not reference its final proposal`,
    );
  }
}

/**
 * Structural + data checks for schema v11 (Phase 14 §97/§136): execution
 * tables and immutability triggers exist; a handoff binds the same-run
 * approved FinalPlan and its stored hash matches its canonical payload; one
 * canonical handoff per run/FinalPlan; the materialized delivery state points
 * at the newest event with a coherent status; DELIVERED has PREPARED lineage;
 * an ExecutionBinding belongs to the run's own workspace; a completed run
 * carrying a Phase-14 handoff has that handoff delivered, and a delivered
 * handoff has its approved FinalPlan in place. Store-open NEVER replays the
 * handoff history (§136) — only these bounded facts.
 */
function validateSchemaV11(db: StoreConnection | StoreTx, problems: string[]): void {
  const objectNames = new Set(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','trigger','index')").all() as {
        name: string;
      }[]
    ).map((row) => row.name),
  );
  for (const table of SCHEMA_V11_TABLES) {
    if (!objectNames.has(table)) {
      problems.push(`${table} table missing for schema version >= 11`);
    }
  }
  for (const trigger of SCHEMA_V11_TRIGGERS) {
    if (!objectNames.has(trigger)) {
      problems.push(`constraint trigger ${trigger} missing for schema version >= 11`);
    }
  }
  for (const index of SCHEMA_V11_INDEXES) {
    if (!objectNames.has(index)) {
      problems.push(`constraint index ${index} missing for schema version >= 11`);
    }
  }
  if (SCHEMA_V11_TABLES.some((table) => !objectNames.has(table))) {
    return;
  }
  const baseWorldPresent = objectNames.has("final_plans") && objectNames.has("planning_runs");
  if (!baseWorldPresent) {
    return;
  }
  // A handoff must bind the same-run approved FinalPlan (§97).
  const handoffFinalPlanDrift = db
    .prepare(
      "SELECT h.run_id AS runId, h.handoff_id AS handoffId FROM execution_handoffs h "
      + "LEFT JOIN final_plans f ON f.run_id = h.run_id AND f.final_plan_id = h.final_plan_id "
      + "WHERE f.final_plan_id IS NULL OR f.final_plan_hash != h.final_plan_hash LIMIT 1",
    )
    .get() as { runId?: string; handoffId?: string } | undefined;
  if (handoffFinalPlanDrift !== undefined) {
    problems.push(
      `execution handoff '${handoffFinalPlanDrift.handoffId}' in run '${handoffFinalPlanDrift.runId}' does not bind its run's approved FinalPlan`,
    );
  }
  // The stored handoff hash must match the canonical payload (§97).
  const handoffRows = db
    .prepare("SELECT run_id AS runId, handoff_id AS handoffId, canonical_json AS canonicalJson, handoff_hash AS handoffHash FROM execution_handoffs")
    .all() as Array<{ runId: string; handoffId: string; canonicalJson: string; handoffHash: string }>;
  for (const row of handoffRows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.canonicalJson);
    } catch {
      problems.push(`execution handoff '${row.handoffId}' in run '${row.runId}' has unparsable canonical payload`);
      continue;
    }
    if (
      parsed === null
      || typeof parsed !== "object"
      || executionHandoffHash(parsed as ExecutionHandoffV1) !== row.handoffHash
    ) {
      problems.push(`execution handoff '${row.handoffId}' in run '${row.runId}' hash does not match its canonical payload`);
    }
  }
  // One canonical handoff per run and per FinalPlan is DDL-enforced; probe the
  // materialized state coherence (§97): last_event_seq is the newest event and
  // the status matches the last event's type.
  const stateDrift = db
    .prepare(
      "SELECT s.run_id AS runId, s.handoff_id AS handoffId FROM execution_handoff_states s "
      + "WHERE s.last_event_seq != (SELECT COALESCE(MAX(e.event_seq), 0) FROM execution_handoff_events e "
      + "WHERE e.run_id = s.run_id AND e.handoff_id = s.handoff_id) "
      + "OR (s.status = 'delivered' AND (SELECT e.event_type FROM execution_handoff_events e "
      + "WHERE e.run_id = s.run_id AND e.handoff_id = s.handoff_id AND e.event_seq = s.last_event_seq) != 'DELIVERED') "
      + "OR (s.status = 'prepared' AND (SELECT e.event_type FROM execution_handoff_events e "
      + "WHERE e.run_id = s.run_id AND e.handoff_id = s.handoff_id AND e.event_seq = s.last_event_seq) = 'DELIVERED') LIMIT 1",
    )
    .get() as { runId?: string; handoffId?: string } | undefined;
  if (stateDrift !== undefined) {
    problems.push(
      `execution handoff state for '${stateDrift.handoffId}' in run '${stateDrift.runId}' is not coherent with its event history`,
    );
  }
  // Every DELIVERED must descend from a PREPARED of the same handoff (§97).
  const deliveredWithoutPrepared = db
    .prepare(
      "SELECT d.run_id AS runId, d.handoff_id AS handoffId FROM execution_handoff_events d "
      + "WHERE d.event_type = 'DELIVERED' AND NOT EXISTS (SELECT 1 FROM execution_handoff_events p "
      + "WHERE p.run_id = d.run_id AND p.handoff_id = d.handoff_id AND p.event_type = 'PREPARED' "
      + "AND p.event_seq < d.event_seq) LIMIT 1",
    )
    .get() as { runId?: string; handoffId?: string } | undefined;
  if (deliveredWithoutPrepared !== undefined) {
    problems.push(
      `execution handoff '${deliveredWithoutPrepared.handoffId}' in run '${deliveredWithoutPrepared.runId}' has a DELIVERED event without PREPARED lineage`,
    );
  }
  // An ExecutionBinding must belong to its run's own workspace (§97).
  const bindingWorkspaceDrift = db
    .prepare(
      "SELECT b.final_plan_id AS finalPlanId FROM execution_bindings b "
      + "JOIN planning_runs r ON r.run_id = b.run_id "
      + "WHERE r.workspace_id != b.workspace_id LIMIT 1",
    )
    .get() as { finalPlanId?: string } | undefined;
  if (bindingWorkspaceDrift !== undefined) {
    problems.push(
      `execution binding for FinalPlan '${bindingWorkspaceDrift.finalPlanId}' does not belong to its run's workspace`,
    );
  }
  // A completed run with a Phase-14 handoff must have it delivered, and a
  // delivered handoff must have its approved FinalPlan in place (§97).
  const completedUndelivered = db
    .prepare(
      "SELECT h.run_id AS runId, h.handoff_id AS handoffId FROM execution_handoffs h "
      + "JOIN planning_runs r ON r.run_id = h.run_id "
      + "LEFT JOIN execution_handoff_states s ON s.run_id = h.run_id AND s.handoff_id = h.handoff_id "
      + "WHERE r.lifecycle = 'completed' AND (s.status IS NULL OR s.status != 'delivered') LIMIT 1",
    )
    .get() as { runId?: string; handoffId?: string } | undefined;
  if (completedUndelivered !== undefined) {
    problems.push(
      `completed run '${completedUndelivered.runId}' still carries undelivered execution handoff '${completedUndelivered.handoffId}'`,
    );
  }
  const deliveredWithoutApproval = db
    .prepare(
      "SELECT h.run_id AS runId, h.handoff_id AS handoffId FROM execution_handoffs h "
      + "JOIN execution_handoff_states s ON s.run_id = h.run_id AND s.handoff_id = h.handoff_id "
      + "LEFT JOIN final_plans f ON f.run_id = h.run_id AND f.final_plan_id = h.final_plan_id "
      + "LEFT JOIN proposal_states ps ON ps.run_id = f.run_id AND ps.proposal_id = f.proposal_id "
      + "AND ps.revision = f.proposal_revision AND ps.status = 'approved' "
      + "WHERE s.status = 'delivered' AND (f.final_plan_id IS NULL OR ps.proposal_id IS NULL) LIMIT 1",
    )
    .get() as { runId?: string; handoffId?: string } | undefined;
  if (deliveredWithoutApproval !== undefined) {
    problems.push(
      `delivered execution handoff '${deliveredWithoutApproval.handoffId}' in run '${deliveredWithoutApproval.runId}' has no approved FinalPlan`,
    );
  }
}

/**
 * Structural + data checks for schema v12 (Phase 15 §5/§83/§E67): the
 * execution-issue / successor-baseline tables and immutability triggers
 * exist; an issue binds its run's exact approved FinalPlan and delivered
 * handoff and its stored hash matches the canonical payload; an adoption
 * points at a real baseline of the same successor; a baseline binds the
 * predecessor's exact FinalPlan hash, delivered handoff hash, and issue-set
 * hash, and its scope rows name exact predecessor FinalPlan sections; a
 * materialization row belongs to its successor's own commit chain. Legacy
 * runs are verified UNTOUCHED: no v12 row may exist without its Phase-14
 * execution world. Store open never re-derives scopes (§83) — only these
 * bounded identity facts.
 */
function validateSchemaV12(db: StoreConnection | StoreTx, problems: string[]): void {
  const objectNames = new Set(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','trigger','index')").all() as {
        name: string;
      }[]
    ).map((row) => row.name),
  );
  for (const table of SCHEMA_V12_TABLES) {
    if (!objectNames.has(table)) {
      problems.push(`${table} table missing for schema version >= 12`);
    }
  }
  for (const trigger of SCHEMA_V12_TRIGGERS) {
    if (!objectNames.has(trigger)) {
      problems.push(`constraint trigger ${trigger} missing for schema version >= 12`);
    }
  }
  for (const index of SCHEMA_V12_INDEXES) {
    if (!objectNames.has(index)) {
      problems.push(`constraint index ${index} missing for schema version >= 12`);
    }
  }
  if (SCHEMA_V12_TABLES.some((table) => !objectNames.has(table))) {
    return;
  }
  const baseWorldPresent = objectNames.has("final_plans") && objectNames.has("execution_handoffs") && objectNames.has("plan_commits");
  if (!baseWorldPresent) {
    return;
  }
  // An issue must bind its run's exact approved FinalPlan and its delivered
  // handoff (§E3), and the stored hash must match the canonical payload (§8).
  const issueBindingDrift = db
    .prepare(
      "SELECT i.run_id AS runId, i.issue_id AS issueId FROM execution_issues i "
      + "LEFT JOIN final_plans f ON f.run_id = i.run_id AND f.final_plan_id = i.final_plan_id AND f.final_plan_hash = i.final_plan_hash "
      + "LEFT JOIN execution_handoffs h ON h.run_id = i.run_id AND h.handoff_id = i.handoff_id AND h.handoff_hash = i.handoff_hash "
      + "WHERE f.final_plan_id IS NULL OR h.handoff_id IS NULL LIMIT 1",
    )
    .get() as { runId?: string; issueId?: string } | undefined;
  if (issueBindingDrift !== undefined) {
    problems.push(
      `execution issue '${issueBindingDrift.issueId}' in run '${issueBindingDrift.runId}' does not bind its run's approved FinalPlan and delivered handoff`,
    );
  }
  const issueRows = db
    .prepare("SELECT run_id AS runId, issue_id AS issueId, canonical_json AS canonicalJson, issue_hash AS issueHash FROM execution_issues")
    .all() as Array<{ runId: string; issueId: string; canonicalJson: string; issueHash: string }>;
  for (const row of issueRows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.canonicalJson);
    } catch {
      problems.push(`execution issue '${row.issueId}' in run '${row.runId}' has unparsable canonical payload`);
      continue;
    }
    if (parsed === null || typeof parsed !== "object" || executionIssueHash(parsed as ExecutionIssueV1) !== row.issueHash) {
      problems.push(`execution issue '${row.issueId}' in run '${row.runId}' hash does not match its canonical payload`);
    }
  }
  // An adoption must point at the baseline that adopted the issue, in the
  // same successor run (§17/§74).
  const adoptionDrift = db
    .prepare(
      "SELECT a.issue_id AS issueId FROM execution_issue_adoptions a "
      + "LEFT JOIN planning_run_baselines b ON b.baseline_id = a.baseline_id AND b.successor_run_id = a.successor_run_id "
      + "WHERE b.baseline_id IS NULL LIMIT 1",
    )
    .get() as { issueId?: string } | undefined;
  if (adoptionDrift !== undefined) {
    problems.push(`execution issue adoption '${adoptionDrift.issueId}' does not point at its successor's baseline`);
  }
  // A baseline must bind its predecessor's exact FinalPlan hash and delivered
  // handoff hash (§E21/§E19).
  const baselineBindingDrift = db
    .prepare(
      "SELECT b.baseline_id AS baselineId FROM planning_run_baselines b "
      + "LEFT JOIN final_plans f ON f.run_id = b.predecessor_run_id AND f.final_plan_id = b.final_plan_id AND f.final_plan_hash = b.final_plan_hash "
      + "LEFT JOIN execution_handoffs h ON h.run_id = b.predecessor_run_id AND h.handoff_id = b.execution_handoff_id AND h.handoff_hash = b.execution_handoff_hash "
      + "WHERE f.final_plan_id IS NULL OR h.handoff_id IS NULL LIMIT 1",
    )
    .get() as { baselineId?: string } | undefined;
  if (baselineBindingDrift !== undefined) {
    problems.push(`planning run baseline '${baselineBindingDrift.baselineId}' does not bind its predecessor's FinalPlan and handoff`);
  }
  // The stored baseline hash must match the canonical payload (§E20).
  const baselineRows = db
    .prepare(
      "SELECT baseline_id AS baselineId, canonical_json AS canonicalJson, baseline_hash AS baselineHash, successor_run_id AS successorRunId FROM planning_run_baselines",
    )
    .all() as Array<{ baselineId: string; canonicalJson: string; baselineHash: string; successorRunId: string }>;
  for (const row of baselineRows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.canonicalJson);
    } catch {
      problems.push(`planning run baseline '${row.baselineId}' has unparsable canonical payload`);
      continue;
    }
    if (
      parsed === null
      || typeof parsed !== "object"
      || planningRunBaselineHash(parsed as PlanningRunBaselineV1) !== row.baselineHash
    ) {
      problems.push(`planning run baseline '${row.baselineId}' hash does not match its canonical payload`);
    }
    // The successor run must exist and the baseline must be its only one
    // (UNIQUE(successor_run_id) enforces cardinality; probe run existence).
    const run = db
      .prepare("SELECT 1 AS one FROM planning_runs WHERE run_id = ?")
      .get(row.successorRunId) as { one?: number } | undefined;
    if (run === undefined) {
      problems.push(`planning run baseline '${row.baselineId}' names a missing successor run`);
    }
  }
  // A materialization must belong to its successor's own commit chain (§53).
  const materializationDrift = db
    .prepare(
      "SELECT m.baseline_id AS baselineId FROM planning_run_baseline_materializations m "
      + "JOIN planning_run_baselines b ON b.baseline_id = m.baseline_id "
      + "LEFT JOIN plan_commits c ON c.commit_id = m.materialized_commit_id AND c.run_id = b.successor_run_id "
      + "WHERE c.commit_id IS NULL LIMIT 1",
    )
    .get() as { baselineId?: string } | undefined;
  if (materializationDrift !== undefined) {
    problems.push(`baseline materialization '${materializationDrift.baselineId}' does not point at its successor's commit`);
  }
}

/**
 * Validate full schema state. For version 0 the store may legitimately have
 * no tables at all (fresh or legacy pre-store database); for version N >= 1
 * the migration history must contain exactly rows 1..N and store_metadata
 * must exist as a singleton. From version 2 the infrastructure-table
 * integrity checks apply as well; from version 4 the structural Plan Memory
 * checks apply; from version 5 the Proposal/Approval/PlanCommit structural
 * checks apply; from version 6 the Observation/Evidence structural checks
 * apply; from version 7 the Evidence freshness structural checks apply;
 * from version 8 the Section workflow structural checks apply.
 */
export function inspectSchemaState(db: StoreConnection | StoreTx): SchemaState {
  const version = readSchemaVersion(db);
  const tables = tableNames(db);
  const problems: string[] = [];
  let history: MigrationHistoryRow[] = [];

  if (version >= 1) {
    if (!tables.has("schema_migrations")) {
      problems.push("schema_migrations table missing for schema version >= 1");
    } else {
      history = readHistory(db);
      const versions = history.map((row) => row.version).sort((a, b) => a - b);
      const expected = Array.from({ length: version }, (_, i) => i + 1);
      if (versions.length !== expected.length || versions.some((v, i) => v !== expected[i])) {
        problems.push(
          `migration history [${versions.join(",")}] does not match user_version ${version}`,
        );
      }
    }
    if (!tables.has("store_metadata")) {
      problems.push("store_metadata table missing for schema version >= 1");
    }
  }
  if (version >= 2) {
    validateSchemaV2(db, tables, problems);
  }
  if (version >= 3) {
    validateSchemaV3(db, tables, problems);
  }
  if (version >= 4) {
    validateSchemaV4(db, problems);
  }
  if (version >= 5) {
    validateSchemaV5(db, problems);
  }
  if (version >= 6) {
    validateSchemaV6(db, problems);
  }
  if (version >= 7) {
    validateSchemaV7(db, problems);
  }
  if (version >= 8) {
    validateSchemaV8(db, version, problems);
  }
  if (version >= 9) {
    validateSchemaV9(db, problems);
  }
  if (version >= 10) {
    validateSchemaV10(db, problems);
  }
  if (version >= 11) {
    validateSchemaV11(db, problems);
  }
  if (version >= 12) {
    validateSchemaV12(db, problems);
  }

  return { version, history, consistent: problems.length === 0, problems };
}

/** Throwing variant used on write/open paths. */
export function assertSchemaState(db: StoreConnection | StoreTx, databasePath: string): SchemaState {
  const state = inspectSchemaState(db);
  if (!state.consistent) {
    throw storeError("STORE_SCHEMA_INVALID", "Plan Store schema state is inconsistent", {
      cause: state.problems.join("; "),
      detail: {
        detected: state.version,
        path: databasePath,
        problems: [...state.problems],
      },
    });
  }
  return state;
}
