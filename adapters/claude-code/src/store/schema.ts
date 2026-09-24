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
 * Validate full schema state. For version 0 the store may legitimately have
 * no tables at all (fresh or legacy pre-store database); for version N >= 1
 * the migration history must contain exactly rows 1..N and store_metadata
 * must exist as a singleton.
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
