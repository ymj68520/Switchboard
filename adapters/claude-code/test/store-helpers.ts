/**
 * Shared helpers for the Plan Store test suite (Phase 2).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { openDatabase, type StoreConnection } from "../src/store/connection.js";
import { resolveStorePaths } from "../src/store/paths.js";
import type { StoreClock } from "../src/store/migration-runner.js";

/** Temp plugin-data root with the frozen layout NOT yet created. */
export function makeTempPluginDataRoot(prefix = "phase-plan-store-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function removeTempPluginDataRoot(root: string): void {
  // Windows can transiently EPERM/EBUSY on freshly written files (AV/indexer
  // scan); rm's built-in bounded retry absorbs that without hiding real
  // retention bugs (retries are exhausted → the error still throws).
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

/** Deterministic clock for injected seams (frozen plan §29). */
export function fixedClock(options: { nowIso?: string; ids?: string[] } = {}): StoreClock & {
  calls: { now: number; id: number };
} {
  let nowCalls = 0;
  let idCalls = 0;
  return {
    calls: {
      get now(): number {
        return nowCalls;
      },
      get id(): number {
        return idCalls;
      },
    },
    nowIso: () => {
      nowCalls += 1;
      return options.nowIso ?? "2026-09-24T12:00:00.000Z";
    },
    newId: () => {
      const id = options.ids?.[idCalls] ?? `id-${idCalls}`;
      idCalls += 1;
      return id;
    },
  };
}

/**
 * Create an "existing schema 0" database (frozen plan §13): a real SQLite
 * file with pre-store sentinel data and user_version left at 0.
 */
export function createSchema0Database(databasePath: string, sentinel = "legacy-sentinel"): void {
  const db = openDatabase(databasePath);
  try {
    db.exec("CREATE TABLE legacy_marker (id INTEGER PRIMARY KEY, note TEXT)");
    db.prepare("INSERT INTO legacy_marker (note) VALUES (?)").run(sentinel);
  } finally {
    db.close();
  }
}

/** Raw test-only connection for simulating other processes (§18/§35). */
export function rawConnection(databasePath: string, busyTimeoutMs = 500): StoreConnection {
  return openDatabase(databasePath, { busyTimeoutMs });
}

/** Read user_version through a throwaway raw connection. */
export function rawSchemaVersion(databasePath: string): number {
  const db = rawConnection(databasePath);
  try {
    const row = db.prepare("PRAGMA user_version").get() as Record<string, unknown>;
    return Object.values(row)[0] as number;
  } finally {
    db.close();
  }
}

/** Overwrite user_version through a throwaway raw connection (test-only). */
export function rawSetSchemaVersion(databasePath: string, version: number): void {
  const db = rawConnection(databasePath);
  try {
    db.exec(`PRAGMA user_version = ${version}`);
  } finally {
    db.close();
  }
}

export function tableNames(databasePath: string): string[] {
  const db = rawConnection(databasePath);
  try {
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[];
    return rows.map((row) => row.name);
  } finally {
    db.close();
  }
}

export function storePathsFor(root: string): { databasePath: string; backupsDir: string; storeDir: string } {
  const paths = resolveStorePaths(root);
  return { databasePath: paths.databasePath, backupsDir: paths.backupsDir, storeDir: paths.storeDir };
}

/** Create the store directory so a canonical pre-store database can exist. */
export function ensureStoreDir(root: string): { databasePath: string; backupsDir: string; storeDir: string } {
  const paths = storePathsFor(root);
  fs.mkdirSync(paths.storeDir, { recursive: true });
  fs.mkdirSync(paths.backupsDir, { recursive: true });
  return paths;
}

/** List published (non-pending) backup file names in a backups dir. */
export function publishedBackups(backupsDir: string): string[] {
  if (!fs.existsSync(backupsDir)) return [];
  return fs
    .readdirSync(backupsDir)
    .filter((name) => name.endsWith(".sqlite3") && !name.startsWith(".pending-"))
    .sort();
}

export function pendingBackups(backupsDir: string): string[] {
  if (!fs.existsSync(backupsDir)) return [];
  return fs.readdirSync(backupsDir).filter((name) => name.startsWith(".pending-"));
}

/**
 * Phase 15 — surgically remove the schema-12 execution-issue /
 * successor-baseline objects (children before parents; foreign_keys are ON
 * even on raw test connections) so legacy-store fixtures can present a genuine
 * pre-v12 world after a full initialization.
 */
/**
 * Phase 16 — surgically remove the schema-13 run-control objects so
 * legacy-store fixtures can present a genuine pre-v13 world after a full
 * initialization.
 */
/**
 * A rewind to a pre-A1 version re-runs migrations whose child tables declare
 * FOREIGN KEY (run_id) REFERENCES execution_runs(run_id) — legal only while
 * execution_runs(run_id) is UNIQUE. Post-26 the PK moved to execution_run_id,
 * so the rewind path restores a run_id uniqueness index (single-world rewind
 * fixtures always satisfy it). No-op on pre-26 shapes and best-effort.
 */
function restoreLegacyExecutionRunKeyUniqueness(raw: StoreConnection): void {
  const hasExecutionRunId = (raw.prepare("PRAGMA table_info('execution_runs')").all() as Array<{ name: string }>)
    .some((column) => column.name === "execution_run_id");
  if (!hasExecutionRunId) return;
  const hasRunIdUniqueIndex = (raw.prepare("PRAGMA index_list('execution_runs')").all() as Array<{ name: string; unique: number }>)
    .some((index) => {
      if (!index.unique) return false;
      const columns = raw.prepare(`PRAGMA index_info('${index.name.replace(/'/g, "''")}')`).all() as Array<{ name: string }>;
      return columns.length === 1 && columns[0]?.name === "run_id";
    });
  if (hasRunIdUniqueIndex) return;
  try {
    raw.exec("CREATE UNIQUE INDEX idx_rewind_execution_runs_run_id ON execution_runs (run_id)");
  } catch {
    // Non-unique provenance values (multi-world store): the re-run chain
    // cannot replay pre-A1 FKs over this store regardless.
  }
}

/**
 * A1-I rewind support — the v026 rebuild re-keyed every execution child table
 * to the canonical execution_run_id. Rewinding below 26 replays migrations
 * 016–025 whose SQL is written against the legacy run_id scope, so the rewind
 * path maps each still-canonical table back: clone its DDL with the scope
 * column renamed, copy rows through the execution_runs root map (whose run_id
 * is the legacy planning provenance), and swap the tables. Idempotent —
 * already-legacy tables are skipped.
 */
const LEGACY_SCOPE_TABLES = [
  "execution_run_events",
  "execution_protocol_events",
  "execution_acceptance_events",
  "supervisor_bindings",
  "supervisor_binding_events",
  "execution_stages",
  "verification_windows",
  "execution_attempts",
  "execution_reports",
  "execution_worker_invocations",
  "supervisor_assessments",
  "execution_commits",
  "verification_conflicts",
  "execution_attempt_reconciliation_bindings",
  "execution_attempt_reconciliations",
  "execution_abort_records",
  // A1-I — the issue ref/extension tables re-keyed to execution_run_id scope
  // without gaining a legacy provenance column, so the rewind maps them back
  // exactly like the pure re-key children (migration 026's issue-family copy
  // joins them through execution_runs.run_id).
  "execution_issue_refs",
  "execution_issue_adoptions",
];

export function rebuildExecutionTablesToLegacyScope(raw: StoreConnection): void {
  const fkWasOn = (raw.prepare("PRAGMA foreign_keys").get() as Record<string, unknown>);
  const fkEnabled = Object.values(fkWasOn)[0] === 1;
  if (fkEnabled) raw.exec("PRAGMA foreign_keys = OFF");
  try {
    rebuildAll(raw);
  } finally {
    if (fkEnabled) raw.exec("PRAGMA foreign_keys = ON");
  }
}

function rebuildAll(raw: StoreConnection): void {
  for (const table of LEGACY_SCOPE_TABLES) {
    const columns = raw.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>;
    if (columns.length === 0) continue;
    // Class-1 dual tables (directives/issues) already carry the legacy run_id
    // provenance column — the replay expects it and no swap is needed.
    if (columns.some((column) => column.name === "run_id")) continue;
    if (!columns.some((column) => column.name === "execution_run_id")) continue;
    const ddlRow = raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as
      | { sql: string }
      | undefined;
    if (ddlRow === undefined) continue;
    // Triggers and indexes die with the table — capture their SQL so the
    // legacy-shape copies can be restored after the swap (the replayed
    // migrations only recreate objects from their OWN version onward).
    const attached = raw
      .prepare(
        "SELECT type, name, sql FROM sqlite_master "
        + "WHERE sql IS NOT NULL AND tbl_name = ? AND type IN ('trigger', 'index') AND name NOT LIKE 'sqlite_%'",
      )
      .all(table) as Array<{ type: string; name: string; sql: string }>;
    const legacyName = `${table}_legacy_scope`;
    raw.exec(`DROP TABLE IF EXISTS ${legacyName}`);
    const legacyDdl = ddlRow.sql
      .replace(new RegExp(`CREATE TABLE "${table}"`), `CREATE TABLE "${legacyName}"`)
      .replace(new RegExp(`CREATE TABLE ${table}$`), `CREATE TABLE ${legacyName}`)
      .replace(/execution_run_id/g, "run_id")
      // The v026 rebuild bodies still name their siblings "_new" (the rename
      // happened after creation) — the rewind clone must reference the
      // canonical post-rename names instead.
      .replace(/([A-Za-z_]+)_new/g, "$1")
      // The rewind clone carries NO foreign keys: the replayed migrations
      // drop and recreate these tables, and cloned FKs over the swapped
      // scope column record drop-time deferred violations the replay can
      // never satisfy. Data integrity is re-established by the replay.
      .replace(/,\s*FOREIGN KEY\s*\([^)]*\)\s*REFERENCES\s+("([^"]+)"|\w+)(\s*\([^)]*\))?/g, "");
    raw.exec(legacyDdl);
    const carried = columns.map((column) => column.name).filter((name) => name !== "execution_run_id");
    const quoted = carried.map((name) => `"${name}"`).join(", ");
    const sourced = carried.map((name) => `c."${name}"`).join(", ");
    raw.exec(
      `INSERT INTO "${legacyName}" (run_id, ${quoted}) `
      + `SELECT m.run_id, ${sourced} FROM "${table}" c JOIN execution_runs m ON m.execution_run_id = c.execution_run_id`,
    );
    raw.exec(`DROP TABLE "${table}"`);
    raw.exec(`ALTER TABLE "${legacyName}" RENAME TO "${table}"`);
    for (const object of attached) {
      try {
        raw.exec(object.sql.replace(/execution_run_id/g, "run_id").replace(/([A-Za-z_]+)_new/g, "$1"));
      } catch {
        // An object the legacy shape cannot carry (A1-only additions) is not
        // restorable — the replay recreates what its own era owns.
      }
    }
  }
}

export function dropSchema13Objects(raw: StoreConnection): void {
  // v0.2.0 E1: rewinding below 13 must also strip everything NEWER than 13,
  // otherwise re-running migration 014 collides with leftover v14 objects.
  // v0.2.0 E2: the same holds for the v15 supervision objects.
  dropSchema15Objects(raw);
  dropSchema14Objects(raw);
  raw.exec("DROP TABLE IF EXISTS run_control_authorizations");
  raw.exec("DROP TRIGGER IF EXISTS run_control_authorizations_no_update");
  raw.exec("DROP TRIGGER IF EXISTS run_control_authorizations_no_delete");
  raw.exec("DROP INDEX IF EXISTS idx_run_control_authorizations_run");
}

/**
 * v0.2.0 E1 — surgically remove the schema-14 execution-run objects so
 * legacy-store fixtures can present a genuine pre-v14 world after a full
 * initialization.
 */
export function dropSchema14Objects(raw: StoreConnection): void {
  // v0.2.0 E2: rewinding below 14 must also strip everything NEWER than 14,
  // otherwise re-running migration 015 collides with leftover v15 objects.
  dropSchema15Objects(raw);
  raw.exec("DROP TABLE IF EXISTS execution_run_events");
  raw.exec("DROP TABLE IF EXISTS execution_runs");
  raw.exec("DROP TRIGGER IF EXISTS execution_runs_binding_immutable");
  raw.exec("DROP TRIGGER IF EXISTS execution_runs_no_delete");
  raw.exec("DROP TRIGGER IF EXISTS execution_run_events_no_update");
  raw.exec("DROP TRIGGER IF EXISTS execution_run_events_no_delete");
  raw.exec("DROP INDEX IF EXISTS idx_execution_run_events_run");
}

/**
 * v0.2.0 E2 — surgically remove the schema-15 supervision objects so
 * legacy-store fixtures can present a genuine pre-v15 world after a full
 * initialization.
 */
export function dropSchema15Objects(raw: StoreConnection): void {
  restoreLegacyExecutionRunKeyUniqueness(raw);
  rebuildExecutionTablesToLegacyScope(raw);
  // v0.2.0 E3: rewinding below 15 must also strip everything NEWER than 15,
  // otherwise re-running migration 016 collides with leftover v16 objects.
  dropSchema16Objects(raw);
  raw.exec("DROP TABLE IF EXISTS supervisor_binding_events");
  raw.exec("DROP TABLE IF EXISTS supervisor_bindings");
  raw.exec("DROP TRIGGER IF EXISTS supervisor_bindings_identity_immutable");
  raw.exec("DROP TRIGGER IF EXISTS supervisor_bindings_no_delete");
  raw.exec("DROP TRIGGER IF EXISTS supervisor_binding_events_no_update");
  raw.exec("DROP TRIGGER IF EXISTS supervisor_binding_events_no_delete");
  raw.exec("DROP INDEX IF EXISTS idx_supervisor_bindings_active_session");
  raw.exec("DROP INDEX IF EXISTS idx_supervisor_bindings_session");
  raw.exec("DROP INDEX IF EXISTS idx_supervisor_binding_events_run");
}

/**
 * v0.2.0 E5 — surgically remove the schema-18 worker-invocation objects so
 * legacy-store fixtures can present a genuine pre-v18 world after a full
 * initialization.
 */
export function dropSchema18Objects(raw: StoreConnection): void {
  restoreLegacyExecutionRunKeyUniqueness(raw);
  rebuildExecutionTablesToLegacyScope(raw);
  // v0.2.0 E6: rewinding below 18 must also strip everything NEWER than 18,
  // otherwise re-running migration 019 collides with leftover v19 objects.
  dropSchema19Objects(raw);
  raw.exec("DROP TABLE IF EXISTS execution_worker_invocation_events");
  raw.exec("DROP TABLE IF EXISTS execution_worker_invocations");
  for (const trigger of [
    "execution_worker_invocations_identity_immutable",
    "execution_worker_invocations_session_immutable",
    "execution_worker_invocations_finished_terminal",
    "execution_worker_invocations_no_delete",
    "execution_worker_invocation_events_no_update",
    "execution_worker_invocation_events_no_delete",
  ]) {
    raw.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
  }
  for (const index of [
    "idx_worker_invocations_claimed_session",
    "idx_worker_invocations_run",
    "idx_worker_invocation_events_attempt",
  ]) {
    raw.exec(`DROP INDEX IF EXISTS ${index}`);
  }
}

/**
 * v0.2.0 E9 — surgically remove the schema-22 replan-required objects
 * (closure_kind column, rebuilt issue/event tables) so legacy-store fixtures
 * can present a genuine pre-v22 world after a full initialization. The issue
 * and event tables are rebuilt by migration 022, so the rewind restores the
 * pre-022 shapes by dropping and letting the rewound version stand.
 */
export function dropSchema22Objects(raw: StoreConnection): void {
  restoreLegacyExecutionRunKeyUniqueness(raw);
  rebuildExecutionTablesToLegacyScope(raw);
  // v0.2.0 E10: rewinding below 22 must also strip everything NEWER than 22
  // (the v23 scope objects), otherwise re-running migration 022's successors
  // collides with leftover v23 objects.
  dropSchema23Objects(raw);
  // Reverse of migration 022: rebuild the touched tables BACK to their v21
  // shapes, preserving every row (children before the parent), and drop the
  // pure v22 additions. Tables absent at the rewind depth stay absent —
  // migration 022 creates any missing pre-022 shape when the chain re-runs.
  for (const trigger of ["verification_windows_closure_shape", "verification_windows_closure_insert_shape"]) {
    raw.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
  }
  raw.exec("DROP INDEX IF EXISTS idx_execution_issues_replan_per_run");
  const tableExists = (name: string): boolean =>
    raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
  // The trio's FKs name planning_runs/final_plans/execution_handoffs — at
  // rewind depths below those parents' creation versions the tables must stay
  // absent (the re-run chain creates them in order; 022's create-if-missing
  // covers any remaining gap).
  const parentsReady =
    tableExists("planning_runs") && tableExists("final_plans") && tableExists("execution_handoffs");
  if (parentsReady && tableExists("execution_issues")) {
    const hasBaselineIssues = tableExists("planning_run_baseline_issues");
    const baselineIssueRows = hasBaselineIssues
      ? (raw.prepare("SELECT baseline_id AS baselineId, issue_id AS issueId, position FROM planning_run_baseline_issues").all() as Array<{
          baselineId: string;
          issueId: string;
          position: number;
        }>)
      : [];
    raw.exec(`
      CREATE TABLE execution_issues_new (
        run_id TEXT NOT NULL, issue_id TEXT NOT NULL, final_plan_id TEXT NOT NULL, final_plan_hash TEXT NOT NULL,
        handoff_id TEXT NOT NULL, handoff_hash TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('hard_constraint','invariant','approved_interface','section_contract','approved_decision','explicit_dependency','architecture_choice','critical_repository_assumption','missing_design_obligation')),
        summary TEXT NOT NULL, detail TEXT NOT NULL, canonical_json TEXT NOT NULL, issue_hash TEXT NOT NULL,
        repository_kind TEXT NOT NULL CHECK (repository_kind IN ('git','directory')), repository_revision TEXT,
        operation_id TEXT NOT NULL, session_id TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY (run_id, issue_id), UNIQUE (run_id, operation_id),
        FOREIGN KEY (run_id) REFERENCES planning_runs(run_id),
        FOREIGN KEY (run_id, final_plan_id) REFERENCES final_plans(run_id, final_plan_id),
        FOREIGN KEY (run_id, handoff_id) REFERENCES execution_handoffs(run_id, handoff_id)
      )
    `);
    raw.exec(
      "INSERT INTO execution_issues_new (run_id, issue_id, final_plan_id, final_plan_hash, handoff_id, handoff_hash, kind, "
      + "summary, detail, canonical_json, issue_hash, repository_kind, repository_revision, operation_id, session_id, created_at) "
      + "SELECT run_id, issue_id, final_plan_id, final_plan_hash, handoff_id, handoff_hash, kind, "
      + "summary, detail, canonical_json, issue_hash, repository_kind, repository_revision, operation_id, session_id, created_at "
      + "FROM execution_issues",
    );
    raw.exec("DROP TABLE IF EXISTS planning_run_baseline_issues");
    raw.exec("DROP TABLE IF EXISTS execution_issue_refs");
    raw.exec("DROP TABLE IF EXISTS execution_issue_adoptions");
    raw.exec("DROP TABLE execution_issues");
    raw.exec("ALTER TABLE execution_issues_new RENAME TO execution_issues");
    raw.exec(`
      CREATE TABLE execution_issue_refs (
        run_id TEXT NOT NULL, issue_id TEXT NOT NULL, position INTEGER NOT NULL CHECK (position >= 1),
        ref_type TEXT NOT NULL CHECK (ref_type IN ('architecture','section','section_contract','decision','constraint')),
        artifact_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK (revision >= 1),
        PRIMARY KEY (run_id, issue_id, position),
        FOREIGN KEY (run_id, issue_id) REFERENCES execution_issues(run_id, issue_id)
      )
    `);
    raw.exec(`
      CREATE TABLE execution_issue_adoptions (
        issue_id TEXT NOT NULL, run_id TEXT NOT NULL, successor_run_id TEXT NOT NULL, baseline_id TEXT NOT NULL,
        position INTEGER NOT NULL CHECK (position >= 1), created_at TEXT NOT NULL,
        PRIMARY KEY (issue_id), UNIQUE (issue_id),
        FOREIGN KEY (run_id, issue_id) REFERENCES execution_issues(run_id, issue_id),
        FOREIGN KEY (successor_run_id) REFERENCES planning_runs(run_id)
      )
    `);
    for (const table of ["execution_issues", "execution_issue_refs", "execution_issue_adoptions"]) {
      raw.exec(`CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, '${table} is immutable'); END`);
      raw.exec(`CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, '${table} is immutable'); END`);
    }
    raw.exec("CREATE INDEX idx_execution_issue_refs_issue ON execution_issue_refs (run_id, issue_id, position)");
    raw.exec("CREATE INDEX idx_execution_issue_adoptions_successor ON execution_issue_adoptions (successor_run_id)");
    if (hasBaselineIssues) {
      raw.exec(`
        CREATE TABLE planning_run_baseline_issues_new (
          baseline_id TEXT NOT NULL, issue_id TEXT NOT NULL, position INTEGER NOT NULL CHECK (position >= 1),
          PRIMARY KEY (baseline_id, issue_id),
          FOREIGN KEY (baseline_id) REFERENCES planning_run_baselines(baseline_id),
          FOREIGN KEY (issue_id) REFERENCES execution_issue_adoptions(issue_id)
        )
      `);
      // FK enforcement is ON: the adoptions rows were preserved by the rebuild
      // above with identical issue_ids, so inserts satisfy the FK. Any orphaned
      // legacy binding (issue no longer present) is dropped — the re-run chain
      // re-materializes bindings through 012/015's own adoption machinery.
      for (const row of baselineIssueRows) {
        const adopted = raw
          .prepare("SELECT count(*) AS n FROM execution_issue_adoptions WHERE issue_id = ?")
          .get(row.issueId) as { n: number };
        if (adopted.n === 0) continue;
        raw.prepare("INSERT INTO planning_run_baseline_issues_new (baseline_id, issue_id, position) VALUES (?, ?, ?)").run(
          row.baselineId,
          row.issueId,
          row.position,
        );
      }
      raw.exec("ALTER TABLE planning_run_baseline_issues_new RENAME TO planning_run_baseline_issues");
      raw.exec(`CREATE TRIGGER planning_run_baseline_issues_no_update BEFORE UPDATE ON planning_run_baseline_issues BEGIN SELECT RAISE(ABORT, 'planning_run_baseline_issues is immutable'); END`);
      raw.exec(`CREATE TRIGGER planning_run_baseline_issues_no_delete BEFORE DELETE ON planning_run_baseline_issues BEGIN SELECT RAISE(ABORT, 'planning_run_baseline_issues is immutable'); END`);
      raw.exec("CREATE INDEX idx_planning_run_baseline_issues_baseline ON planning_run_baseline_issues (baseline_id, position)");
    }
  }
  if (tableExists("execution_runs") && tableExists("execution_run_events")) {
    raw.exec(`
      CREATE TABLE execution_run_events_new (
        run_id TEXT NOT NULL, event_seq INTEGER NOT NULL CHECK (event_seq >= 1),
        event_type TEXT NOT NULL CHECK (event_type IN ('PREPARED','ACTIVATED')),
        session_id TEXT, tool_use_id TEXT, detail_json TEXT, created_at TEXT NOT NULL,
        PRIMARY KEY (run_id, event_seq)
      )
    `);
    raw.exec("INSERT INTO execution_run_events_new SELECT run_id, event_seq, event_type, session_id, tool_use_id, detail_json, created_at FROM execution_run_events WHERE event_type IN ('PREPARED','ACTIVATED')");
    raw.exec("DROP TABLE execution_run_events");
    raw.exec("ALTER TABLE execution_run_events_new RENAME TO execution_run_events");
    raw.exec(`CREATE TRIGGER execution_run_events_no_update BEFORE UPDATE ON execution_run_events BEGIN SELECT RAISE(ABORT, 'execution_run_events is immutable'); END`);
    raw.exec(`CREATE TRIGGER execution_run_events_no_delete BEFORE DELETE ON execution_run_events BEGIN SELECT RAISE(ABORT, 'execution_run_events is immutable'); END`);
    raw.exec("CREATE INDEX idx_execution_run_events_run ON execution_run_events (run_id, event_seq)");
  }
  if (tableExists("verification_windows")) {
    const columns = raw.prepare("PRAGMA table_info('verification_windows')").all() as Array<{ name: string }>;
    if (columns.some((candidate) => candidate.name === "closure_kind")) {
      raw.exec("ALTER TABLE verification_windows DROP COLUMN closure_kind");
    }
  }
}

/**
 * v0.2.0 E11 — surgically remove the schema-24 attempt-reconciliation objects
 * so legacy-store fixtures can present a genuine pre-v24 world after a full
 * initialization. Pure additions: two immutable tables + the ROTATED event
 * vocabulary.
 */
export function dropSchema24Objects(raw: StoreConnection): void {
  restoreLegacyExecutionRunKeyUniqueness(raw);
  rebuildExecutionTablesToLegacyScope(raw);
  dropDirectivesCanonicalColumnViaClone(raw);
  raw.exec("DROP TABLE IF EXISTS execution_attempt_reconciliations");
  raw.exec("DROP TABLE IF EXISTS execution_attempt_reconciliation_bindings");
  for (const trigger of [
    "execution_attempt_reconciliations_no_update",
    "execution_attempt_reconciliations_no_delete",
    "execution_attempt_reconciliation_bindings_no_update",
    "execution_attempt_reconciliation_bindings_no_delete",
  ]) {
    raw.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
  }
  raw.exec("DROP INDEX IF EXISTS idx_attempt_reconciliations_run");
  raw.exec("DROP INDEX IF EXISTS idx_attempt_reconciliation_bindings_directive");
  if (tableExists(raw, "execution_worker_invocation_events")) {
    const hasRotated = (
      raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'execution_worker_invocation_events'").get() !== undefined
    ) && (
      raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'execution_worker_invocation_events'").get() as { sql: string } | undefined
    )?.sql?.includes("'ROTATED'");
    if (hasRotated) {
      raw.exec(`
        CREATE TABLE execution_worker_invocation_events_new (
          attempt_id TEXT NOT NULL,
          event_seq INTEGER NOT NULL CHECK (event_seq >= 1),
          event_type TEXT NOT NULL CHECK (event_type IN ('PREPARED', 'CLAIMED', 'FINISHED')),
          worker_session_id TEXT,
          created_at TEXT NOT NULL,
          PRIMARY KEY (attempt_id, event_seq),
          FOREIGN KEY (attempt_id) REFERENCES execution_worker_invocations(attempt_id)
        )
      `);
      raw.exec(
        "INSERT INTO execution_worker_invocation_events_new "
        + "SELECT attempt_id, event_seq, event_type, worker_session_id, created_at "
        + "FROM execution_worker_invocation_events WHERE event_type IN ('PREPARED', 'CLAIMED', 'FINISHED')",
      );
      raw.exec("DROP TABLE execution_worker_invocation_events");
      raw.exec("ALTER TABLE execution_worker_invocation_events_new RENAME TO execution_worker_invocation_events");
      raw.exec(`CREATE TRIGGER execution_worker_invocation_events_no_update BEFORE UPDATE ON execution_worker_invocation_events BEGIN SELECT RAISE(ABORT, 'execution_worker_invocation_events is immutable'); END`);
      raw.exec(`CREATE TRIGGER execution_worker_invocation_events_no_delete BEFORE DELETE ON execution_worker_invocation_events BEGIN SELECT RAISE(ABORT, 'execution_worker_invocation_events is immutable'); END`);
      raw.exec("CREATE INDEX idx_worker_invocation_events_attempt ON execution_worker_invocation_events (attempt_id, event_seq)");
    }
  }
}

/**
 * v0.2.0 E10 — surgically remove the schema-23 execution-scope objects so
 * legacy-store fixtures can present a genuine pre-v23 world after a full
 * initialization. The four scope tables keep their (now nullable) stage_id —
 * migration 023's rebuild re-imposes the frozen shapes; only the pure v23
 * additions are stripped here.
 */
export function dropSchema23Objects(raw: StoreConnection): void {
  restoreLegacyExecutionRunKeyUniqueness(raw);
  rebuildExecutionTablesToLegacyScope(raw);
  dropSchema24Objects(raw);
  for (const trigger of [
    "execution_runs_completion_insert_shape",
    "execution_runs_completion_shape",
    "execution_runs_terminal_lifecycle",
  ]) {
    raw.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
  }
  const columnExists = (table: string, column: string): boolean =>
    (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined)
    && (raw.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>).some(
      (candidate) => candidate.name === column,
    );
  if (columnExists("execution_runs", "completion_commit_id")) {
    raw.exec("ALTER TABLE execution_runs DROP COLUMN completion_commit_id");
  }
  // The scope-shape triggers reference scope_kind; they must go before the
  // column or DROP COLUMN refuses. The v23 windows identity trigger mentions
  // scope_kind too — restore the v22 body (drop + recreate) before the drop.
  // At deep rewind depths the table itself is absent; the re-run chain
  // recreates it (migration 023 builds it at v23 shape directly).
  if (tableExists(raw, "verification_windows")) {
    raw.exec("DROP TRIGGER IF EXISTS verification_windows_identity_immutable");
    // The identity trigger body must match the table's actual scope column:
    // pre-A1 stores scope windows by run_id, A1 (v26+) stores by the
    // canonical execution_run_id — a body naming an absent column would break
    // the DROP COLUMN below and every later UPDATE.
    const windowScopeColumn = columnExists("verification_windows", "execution_run_id")
      ? "execution_run_id"
      : "run_id";
    raw.exec(`
      CREATE TRIGGER verification_windows_identity_immutable BEFORE UPDATE ON verification_windows
      BEGIN
        SELECT RAISE(ABORT, 'verification window identity is immutable')
        WHERE OLD.${windowScopeColumn} IS NOT NEW.${windowScopeColumn}
           OR OLD.stage_id IS NOT NEW.stage_id
           OR OLD.opened_at IS NOT NEW.opened_at;
      END
    `);
  }
  for (const table of ["verification_windows", "execution_directives", "supervisor_assessments", "execution_commits"]) {
    for (const trigger of [`${table}_scope_insert_shape`, `${table}_scope_update_shape`]) {
      raw.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
    }
    if (columnExists(table, "scope_kind")) {
      raw.exec(`ALTER TABLE ${table} DROP COLUMN scope_kind`);
    }
  }
}

/**
 * v0.2.0 E8 — surgically remove the schema-21 verification-policy/conflict
 * objects (including the added directive-policy columns) so legacy-store
 * fixtures can present a genuine pre-v21 world after a full initialization.
 */
export function dropSchema21Objects(raw: StoreConnection): void {
  restoreLegacyExecutionRunKeyUniqueness(raw);
  rebuildExecutionTablesToLegacyScope(raw);
  // v0.2.0 E9/E10: rewinding below 21 must also strip everything NEWER than
  // 21 — dropSchema22Objects chains the v23 strip itself.
  dropSchema22Objects(raw);
  raw.exec("DROP TABLE IF EXISTS verification_conflicts");
  for (const trigger of ["verification_conflicts_identity_immutable", "verification_conflicts_no_delete"]) {
    raw.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
  }
  raw.exec("DROP INDEX IF EXISTS idx_verification_conflicts_window");
  if (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'execution_directives'").get() !== undefined) {
    const columns = raw.prepare("PRAGMA table_info('execution_directives')").all() as Array<{ name: string }>;
    for (const column of ["verification_conflict_id", "verification_purpose", "verification_requirement", "protocol_version"]) {
      if (columns.some((candidate) => candidate.name === column)) {
        raw.exec(`ALTER TABLE execution_directives DROP COLUMN ${column}`);
      }
    }
  }
}

/**
 * v0.2.0 E7 — surgically remove the schema-20 stage-completion provenance
 * objects so legacy-store fixtures can present a genuine pre-v20 world after
 * a full initialization.
 */
export function dropSchema20Objects(raw: StoreConnection): void {
  restoreLegacyExecutionRunKeyUniqueness(raw);
  rebuildExecutionTablesToLegacyScope(raw);
  // v0.2.0 E8: rewinding below 20 must also strip everything NEWER than 20,
  // otherwise re-running migration 021 collides with leftover v21 objects.
  dropSchema21Objects(raw);
  // Triggers first: the column cannot drop while the consistency triggers
  // reference it.
  raw.exec("DROP TRIGGER IF EXISTS execution_stages_completion_insert_shape");
  raw.exec("DROP TRIGGER IF EXISTS execution_stages_completion_consistent");
  if (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'execution_stages'").get() !== undefined) {
    const columns = raw.prepare("PRAGMA table_info('execution_stages')").all() as Array<{ name: string }>;
    if (columns.some((candidate) => candidate.name === "completed_by_commit_id")) {
      raw.exec("ALTER TABLE execution_stages DROP COLUMN completed_by_commit_id");
    }
  }
}

/**
 * v0.2.0 E6 — surgically remove the schema-19 acceptance objects (including
 * the added accepted-head / window-base columns) so legacy-store fixtures can
 * present a genuine pre-v19 world after a full initialization.
 */
export function dropSchema19Objects(raw: StoreConnection): void {
  restoreLegacyExecutionRunKeyUniqueness(raw);
  rebuildExecutionTablesToLegacyScope(raw);
  // v0.2.0 E7: rewinding below 19 must also strip everything NEWER than 19,
  // otherwise re-running migration 020 collides with leftover v20 objects.
  dropSchema20Objects(raw);
  // Window triggers first: base columns cannot drop while triggers reference
  // them; the acceptance tables each carry their own no_update/no_delete
  // triggers, which drop with the tables.
  raw.exec("DROP TRIGGER IF EXISTS verification_windows_base_shape");
  raw.exec("DROP TRIGGER IF EXISTS verification_windows_base_immutable");
  raw.exec("DROP TABLE IF EXISTS execution_acceptance_events");
  raw.exec("DROP TABLE IF EXISTS supervisor_assessment_report_judgments");
  raw.exec("DROP TABLE IF EXISTS execution_commits");
  raw.exec("DROP TABLE IF EXISTS supervisor_assessments");
  for (const index of [
    "idx_supervisor_assessments_window",
    "idx_supervisor_assessment_report_judgments_report",
    "idx_execution_commits_run",
    "idx_execution_acceptance_events_run",
  ]) {
    raw.exec(`DROP INDEX IF EXISTS ${index}`);
  }
  // The added columns exist only when the base tables exist AND migration 019
  // ran; rewinds below v16/v14 must tolerate their absence.
  const dropColumnIfPresent = (table: string, column: string): void => {
    const columns = raw.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>;
    if (columns.some((candidate) => candidate.name === column)) {
      raw.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    }
  };
  if (tableExists(raw, "verification_windows")) {
    dropColumnIfPresent("verification_windows", "base_kind");
    dropColumnIfPresent("verification_windows", "base_commit_id");
  }
  if (tableExists(raw, "execution_runs")) {
    dropColumnIfPresent("execution_runs", "accepted_head_commit_id");
  }
}

function tableExists(raw: StoreConnection, table: string): boolean {
  const row = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as
    | { name: string }
    | undefined;
  return row !== undefined;
}

/**
 * v0.2.0 E4 — surgically remove the schema-17 execution-protocol objects so
 * legacy-store fixtures can present a genuine pre-v17 world after a full
 * initialization.
 */
export function dropSchema17Objects(raw: StoreConnection): void {
  restoreLegacyExecutionRunKeyUniqueness(raw);
  rebuildExecutionTablesToLegacyScope(raw);
  // v0.2.0 E5: rewinding below 17 must also strip everything NEWER than 17,
  // otherwise re-running migration 018 collides with leftover v18 objects.
  dropSchema18Objects(raw);
  raw.exec("DROP TABLE IF EXISTS execution_protocol_events");
  raw.exec("DROP TABLE IF EXISTS execution_reports");
  raw.exec("DROP TABLE IF EXISTS execution_attempts");
  raw.exec("DROP TABLE IF EXISTS execution_directives");
  for (const trigger of [
    "execution_directives_no_update",
    "execution_directives_no_delete",
    "execution_attempts_identity_immutable",
    "execution_attempts_no_delete",
    "execution_reports_no_update",
    "execution_reports_no_delete",
    "execution_protocol_events_no_update",
    "execution_protocol_events_no_delete",
  ]) {
    raw.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
  }
  for (const index of [
    "idx_execution_attempts_running_run",
    "idx_execution_directives_run",
    "idx_execution_attempts_run",
    "idx_execution_protocol_events_run",
  ]) {
    raw.exec(`DROP INDEX IF EXISTS ${index}`);
  }
}

/**
 * v0.2.0 E3 — surgically remove the schema-16 execution-structure objects so
 * legacy-store fixtures can present a genuine pre-v16 world after a full
 * initialization.
 */
export function dropSchema16Objects(raw: StoreConnection): void {
  restoreLegacyExecutionRunKeyUniqueness(raw);
  rebuildExecutionTablesToLegacyScope(raw);
  // v0.2.0 E4: rewinding below 16 must also strip everything NEWER than 16,
  // otherwise re-running migration 017 collides with leftover v17 objects.
  dropSchema17Objects(raw);
  raw.exec("DROP TABLE IF EXISTS verification_windows");
  raw.exec("DROP TABLE IF EXISTS execution_stages");
  raw.exec("DROP TRIGGER IF EXISTS execution_stages_provenance_immutable");
  raw.exec("DROP TRIGGER IF EXISTS execution_stages_no_delete");
  raw.exec("DROP TRIGGER IF EXISTS verification_windows_identity_immutable");
  raw.exec("DROP TRIGGER IF EXISTS verification_windows_no_delete");
  raw.exec("DROP INDEX IF EXISTS idx_execution_stages_active_run");
  raw.exec("DROP INDEX IF EXISTS idx_verification_windows_open_run");
  raw.exec("DROP INDEX IF EXISTS idx_execution_stages_run");
  raw.exec("DROP INDEX IF EXISTS idx_verification_windows_run");
}

export function dropSchema12Objects(raw: StoreConnection): void {
  // Phase 16: rewinding below 12 must also strip everything NEWER than 12,
  // otherwise re-running migration 013 collides with leftover v13 objects.
  dropSchema13Objects(raw);
  for (const table of [
    "planning_run_baseline_materializations",
    "planning_run_baseline_scopes",
    "planning_run_baseline_issues",
    "execution_issue_adoptions",
    "planning_run_baselines",
    "execution_issue_refs",
    "execution_issues",
  ]) {
    raw.exec(`DROP TABLE IF EXISTS ${table}`);
    raw.exec(`DROP TRIGGER IF EXISTS ${table}_no_update`);
    raw.exec(`DROP TRIGGER IF EXISTS ${table}_no_delete`);
  }
  for (const index of [
    "idx_execution_issue_refs_issue",
    "idx_execution_issue_adoptions_successor",
    "idx_planning_run_baseline_issues_baseline",
    "idx_planning_run_baseline_scopes_state",
  ]) {
    raw.exec(`DROP INDEX IF EXISTS ${index}`);
  }
}

/**
 * A1-I §46 labelled legacy mechanism — the Class-1 directives table keeps its
 * byte-stable legacy run_id but carries the v26-only canonical column;
 * DROP COLUMN refuses (the column participates in an FK), so clone-swap:
 * the same DDL minus the execution_run_id column and its FK, rows copied by
 * name, attached triggers/indexes restored with the rename treatment.
 */
function dropDirectivesCanonicalColumnViaClone(raw: StoreConnection): void {
  if (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'execution_directives'").get() === undefined) return;
  const columns = raw.prepare("PRAGMA table_info('execution_directives')").all() as Array<{ name: string }>;
  if (!columns.some((candidate) => candidate.name === "execution_run_id")) return;
  // The Class-1 directives table is skipped by the scope swap (it keeps its
  // byte-stable legacy run_id), so its v26-only canonical column must leave
  // for migration 025's identical-order cluster copies. DROP COLUMN refuses
  // (the column participates in an FK), so clone-swap instead: same DDL minus
  // the execution_run_id column and its FK, rows copied by name.
  if (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'execution_directives'").get() !== undefined) {
    const columns = raw.prepare("PRAGMA table_info('execution_directives')").all() as Array<{ name: string }>;
    if (columns.some((candidate) => candidate.name === "execution_run_id")) {
      const ddlRow = raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'execution_directives'").get() as { sql: string };
      const attached = raw
        .prepare(
          "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND tbl_name = 'execution_directives' "
          + "AND type IN ('trigger', 'index') AND name NOT LIKE 'sqlite_%'",
        )
        .all() as Array<{ type: string; name: string; sql: string }>;
      const legacyDdl = ddlRow.sql
        .replace('CREATE TABLE "execution_directives"', 'CREATE TABLE "execution_directives_legacy_scope"')
        .replace(/,\s*execution_run_id TEXT NOT NULL/, "")
        // The clone is a throwaway legacy representation for the replay: at
        // deep rewind depths its FK parents (final_plans, execution_runs)
        // may not exist yet, so strip EVERY table-level FK clause (the same
        // contract the scope-swap clones use).
        .replace(/,\s*FOREIGN KEY\s*\([^)]*\)\s*REFERENCES\s+("([^"]+)"|\w+)(\s*\([^)]*\))?/g, "");
      raw.exec("DROP TABLE IF EXISTS execution_directives_legacy_scope");
      raw.exec(legacyDdl);
      const carried = columns.map((column) => column.name).filter((name) => name !== "execution_run_id");
      raw.exec(
        `INSERT INTO execution_directives_legacy_scope (${carried.map((name) => `"${name}"`).join(", ")}) `
        + `SELECT ${carried.map((name) => `"${name}"`).join(", ")} FROM execution_directives`,
      );
      raw.exec("DROP TABLE execution_directives");
      raw.exec("ALTER TABLE execution_directives_legacy_scope RENAME TO execution_directives");
      for (const object of attached) {
        try {
          // Same rename treatment as the scope swap: the restored triggers and
          // indexes must address the legacy clone's column names, and any
          // `_new` sibling reference from the v26 rebuild DDL rewrites to the
          // canonical post-rename name.
          raw.exec(object.sql.replace(/execution_run_id/g, "run_id").replace(/([A-Za-z_]+)_new/g, "$1"));
        } catch {
          // an attached object whose body cannot map onto the legacy clone
          // dies with the swap; the replayed migrations recreate their own.
        }
      }
    }
  }
}

/** E13-T59 — rewind a v25 store to the v24 shape: drop the abort-provenance
 * objects only (the v25 CHECK extensions live inside tables migration 025
 * rebuilds idempotently, so re-running the chain from 24 is safe). */
export function dropSchema25Objects(raw: StoreConnection): void {
  restoreLegacyExecutionRunKeyUniqueness(raw);
  rebuildExecutionTablesToLegacyScope(raw);
  dropDirectivesCanonicalColumnViaClone(raw);
  raw.exec("DROP TABLE IF EXISTS execution_abort_records");
  for (const trigger of ["execution_abort_records_no_update", "execution_abort_records_no_delete"]) {
    raw.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
  }
}

/** A1-I §46 — rewind a v26 store to the v25 shape: 026 rebuilt tables in
 * place, so the rewind restores the legacy run_id scope on every re-keyed
 * child (dual Class-1 tables keep their frozen provenance columns and are
 * skipped by the swap; run-control keeps its typed columns — migration 026's
 * replay re-classifies rows deterministically). */
export function dropSchema26Objects(raw: StoreConnection): void {
  restoreLegacyExecutionRunKeyUniqueness(raw);
  rebuildExecutionTablesToLegacyScope(raw);
}
