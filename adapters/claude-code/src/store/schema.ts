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
 * Validate full schema state. For version 0 the store may legitimately have
 * no tables at all (fresh or legacy pre-store database); for version N >= 1
 * the migration history must contain exactly rows 1..N and store_metadata
 * must exist as a singleton. From version 2 the infrastructure-table
 * integrity checks apply as well; from version 4 the structural Plan Memory
 * checks apply; from version 5 the Proposal/Approval/PlanCommit structural
 * checks apply; from version 6 the Observation/Evidence structural checks
 * apply; from version 7 the Evidence freshness structural checks apply.
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
