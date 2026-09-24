/**
 * Plan Store public API (frozen plan §6).
 *
 *   inspectPlanStore      read-only; never migrates, never writes
 *   openPlanStore         strict open of an existing store AT the supported
 *                         schema — the old-process entry point that fails
 *                         closed on TOO_NEW/TOO_OLD
 *   initializePlanStore   create/migrate to the supported schema, then hand
 *                         out a working store (the MCP bootstrap entry)
 *
 * The canonical database path is always
 * `${pluginDataRoot}/store/phase-plan.sqlite3` — callers pass the plugin data
 * root, never a hardcoded user directory.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import * as fs from "node:fs";

import {
  openDatabase,
  type OpenDatabaseOptions,
  type StoreConnection,
} from "./connection.js";
import { RUNTIME_VERSION } from "../runtime/version.js";
import { SUPPORTED_SCHEMA_VERSION } from "./constants.js";
import { storeError, toStoreError } from "./errors.js";
import { validateMigrationRegistry, createProductionMigrations, type StoreMigration } from "./migrations/index.js";
import { runMigrations, type StoreClock } from "./migration-runner.js";
import { resolveStorePaths, type StorePaths } from "./paths.js";
import {
  assertSchemaState,
  inspectSchemaState,
  readSchemaVersion,
} from "./schema.js";
import type { StoreTx } from "./transaction.js";
import { runRead, runWrite } from "./transaction.js";

export interface StoreMetadata {
  schemaVersion: number;
  storeId: string;
  protocolVersion: number;
  createdAt: string;
}

export interface PlanStore {
  readonly path: string;
  /** Live read of the authoritative `PRAGMA user_version`. */
  getSchemaVersion(): number;
  getStoreMetadata(): StoreMetadata;
  withRead<T>(operation: (tx: StoreTx) => T): T;
  /** The only mutation entry point; fences schema compatibility in-tx. */
  withWrite<T>(operation: (tx: StoreTx) => T): T;
  close(): void;
}

export interface PlanStoreOptions {
  /** Plugin data root; the canonical layout is resolved from it. */
  pluginDataRoot: string;
  /** Bounded lock wait override (tests); default STORE_BUSY_TIMEOUT_MS. */
  busyTimeoutMs?: number;
  /** Injectable clock/id seams (frozen plan §29). */
  clock?: StoreClock;
  /** Test-only registry override; production always uses the real chain. */
  migrations?: readonly StoreMigration[];
  /** Test seam replacing the backup executor (failure injection). */
  backupExecutor?: (fromVersion: number) => Promise<{ path: string; name: string }>;
  /** Test seam replacing node:sqlite backup() (validation-failure injection). */
  backupFn?: (sourceConnection: StoreConnection, destination: string) => Promise<unknown>;
}

export function defaultStoreClock(): StoreClock {
  return {
    nowIso: () => new Date().toISOString(),
    newId: () => randomUUID(),
  };
}

export class SqlitePlanStore implements PlanStore {
  readonly path: string;
  private readonly db: StoreConnection;
  private closed = false;

  constructor(db: StoreConnection, databasePath: string) {
    this.db = db;
    this.path = databasePath;
  }

  getSchemaVersion(): number {
    this.assertOpen();
    return readSchemaVersion(this.db);
  }

  getStoreMetadata(): StoreMetadata {
    this.assertOpen();
    return runRead(this.db, (tx) => {
      const row = tx.prepare(
        "SELECT store_id AS storeId, protocol_version AS protocolVersion, created_at AS createdAt FROM store_metadata WHERE id = 1",
      ).get() as Partial<StoreMetadata> | undefined;
      if (!row || typeof row.storeId !== "string" || typeof row.protocolVersion !== "number" || typeof row.createdAt !== "string") {
        throw storeError("STORE_SCHEMA_INVALID", "store_metadata singleton is missing or malformed", {
          detail: { path: this.path },
        });
      }
      return {
        schemaVersion: readSchemaVersion(tx),
        storeId: row.storeId,
        protocolVersion: row.protocolVersion,
        createdAt: row.createdAt,
      };
    });
  }

  withRead<T>(operation: (tx: StoreTx) => T): T {
    this.assertOpen();
    return runRead(this.db, operation);
  }

  withWrite<T>(operation: (tx: StoreTx) => T): T {
    this.assertOpen();
    return runWrite(this.db, operation, {
      supportedSchemaVersion: SUPPORTED_SCHEMA_VERSION,
      databasePath: this.path,
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.close();
    } catch (err) {
      throw storeError("STORE_OPEN_FAILED", `cannot close Plan Store: ${this.path}`, {
        cause: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw storeError("STORE_OPEN_FAILED", "Plan Store connection is closed", {
        detail: { path: this.path },
      });
    }
  }
}

function openConnection(paths: StorePaths, options: PlanStoreOptions, readonly = false): StoreConnection {
  const openOptions: OpenDatabaseOptions = {
    readonly,
    ...(options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs }),
  };
  return openDatabase(paths.databasePath, openOptions);
}

/**
 * Open an existing store strictly AT the supported schema — no migration,
 * no backup, no write side effects. Used by long-lived processes that were
 * not the initializer and must fail closed on any version drift.
 */
export function openPlanStore(options: PlanStoreOptions): PlanStore {
  const paths = resolveStorePaths(options.pluginDataRoot);
  const db = openConnection(paths, options);
  try {
    // Version gates first: a store beyond this binary is TOO_NEW even if its
    // history looks "inconsistent" against the newer user_version, and a
    // store behind this binary is TOO_OLD (initialization migrates it).
    const version = readSchemaVersion(db);
    if (version > SUPPORTED_SCHEMA_VERSION) {
      throw storeError("STORE_SCHEMA_TOO_NEW", "Plan Store schema is newer than this binary supports", {
        cause: `store schema ${version} > supported ${SUPPORTED_SCHEMA_VERSION}`,
        detail: { supported: SUPPORTED_SCHEMA_VERSION, detected: version, path: paths.databasePath },
      });
    }
    if (version < SUPPORTED_SCHEMA_VERSION) {
      throw storeError("STORE_SCHEMA_TOO_OLD", "Plan Store schema is older than this binary supports; initialize the store first", {
        cause: `store schema ${version} < supported ${SUPPORTED_SCHEMA_VERSION}`,
        detail: { supported: SUPPORTED_SCHEMA_VERSION, detected: version, path: paths.databasePath },
      });
    }
    assertSchemaState(db, paths.databasePath);
    return new SqlitePlanStore(db, paths.databasePath);
  } catch (err) {
    try {
      db.close();
    } catch {
      // best-effort close on the failure path
    }
    throw err;
  }
}

/**
 * Create the store when absent, migrate when behind (with pre-migration
 * backup for existing databases), and return a ready store. Idempotent and
 * safe to run concurrently — SQLite serializes via BEGIN IMMEDIATE.
 */
export async function initializePlanStore(options: PlanStoreOptions): Promise<PlanStore> {
  const paths = resolveStorePaths(options.pluginDataRoot);
  const clock = options.clock ?? defaultStoreClock();
  const migrations = options.migrations ?? createProductionMigrations({
    generateStoreId: clock.newId,
    nowIso: clock.nowIso,
  });
  validateMigrationRegistry(migrations);
  const registryTarget = migrations[migrations.length - 1]?.to ?? 0;
  if (registryTarget !== SUPPORTED_SCHEMA_VERSION) {
    // Programming/configuration error: refuse to build a store this binary
    // cannot actually bring to the supported schema.
    throw storeError("STORE_MIGRATION_FAILED", "migration registry does not reach the supported schema version", {
      cause: `registry target ${registryTarget} != supported ${SUPPORTED_SCHEMA_VERSION}`,
    });
  }

  const existedBefore = existsSync(paths.databasePath);
  try {
    fs.mkdirSync(paths.storeDir, { recursive: true });
    fs.mkdirSync(paths.backupsDir, { recursive: true });
  } catch (err) {
    throw toStoreError(err, `cannot create Plan Store directories under ${paths.pluginDataRoot}`);
  }

  const db = openConnection(paths, options);
  try {
    const preState = inspectSchemaState(db);
    if (preState.version > SUPPORTED_SCHEMA_VERSION) {
      throw storeError("STORE_SCHEMA_TOO_NEW", "Plan Store schema is newer than this binary supports", {
        cause: `store schema ${preState.version} > supported ${SUPPORTED_SCHEMA_VERSION}`,
        detail: { supported: SUPPORTED_SCHEMA_VERSION, detected: preState.version, path: paths.databasePath },
      });
    }
    if (preState.version >= 1 && !preState.consistent) {
      throw storeError("STORE_SCHEMA_INVALID", "Plan Store schema state is inconsistent", {
        cause: preState.problems.join("; "),
        detail: { detected: preState.version, path: paths.databasePath, problems: [...preState.problems] },
      });
    }

    if (preState.version !== SUPPORTED_SCHEMA_VERSION) {
      await runMigrations({
        db,
        databasePath: paths.databasePath,
        backupsDir: paths.backupsDir,
        migrations,
        targetVersion: SUPPORTED_SCHEMA_VERSION,
        runtimeVersion: RUNTIME_VERSION,
        clock,
        existedBefore,
        ...(options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs }),
        ...(options.backupExecutor === undefined ? {} : { backupExecutor: options.backupExecutor }),
        ...(options.backupFn === undefined ? {} : { backupFn: options.backupFn }),
      });
    }

    // Post-initialization gate: only a consistent, current store is returned.
    const state = assertSchemaState(db, paths.databasePath);
    if (state.version !== SUPPORTED_SCHEMA_VERSION) {
      throw storeError("STORE_MIGRATION_FAILED", "store did not reach the supported schema", {
        cause: `version ${state.version} after migration`,
      });
    }

    return new SqlitePlanStore(db, paths.databasePath);
  } catch (err) {
    try {
      db.close();
    } catch {
      // best-effort close on the failure path
    }
    throw err;
  }
}

export type PlanStoreInspectionStatus =
  | "absent"
  | "uninitialized"
  | "ready"
  | "too_new"
  | "too_old"
  | "invalid";

export interface PlanStoreInspection {
  status: PlanStoreInspectionStatus;
  schemaVersion?: number;
  supported: number;
  databasePath: string;
  storeId?: string;
  problems?: string[];
}

/**
 * Read-only inspection (frozen plan §33): reports what the store IS without
 * creating, migrating, or writing anything. Used by the doctor.
 */
export function inspectPlanStore(
  pluginDataRoot: string,
  options: { busyTimeoutMs?: number } = {},
): PlanStoreInspection {
  const paths = resolveStorePaths(pluginDataRoot);
  const base: PlanStoreInspection = {
    status: "absent",
    supported: SUPPORTED_SCHEMA_VERSION,
    databasePath: paths.databasePath,
  };
  if (!existsSync(paths.databasePath)) {
    return base;
  }
  const db = openDatabase(paths.databasePath, {
    readonly: true,
    ...(options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs }),
  });
  try {
    const state = inspectSchemaState(db);
    if (state.version === 0) {
      return { ...base, status: "uninitialized", schemaVersion: 0 };
    }
    // Newer-than-binary takes precedence over history consistency: a store
    // migrated beyond this binary legitimately has "mismatching" history.
    if (state.version > SUPPORTED_SCHEMA_VERSION) {
      return { ...base, status: "too_new", schemaVersion: state.version };
    }
    if (!state.consistent) {
      return {
        ...base,
        status: "invalid",
        schemaVersion: state.version,
        problems: [...state.problems],
      };
    }
    if (state.version < SUPPORTED_SCHEMA_VERSION) {
      return { ...base, status: "too_old", schemaVersion: state.version };
    }
    const metadata = db.prepare(
      "SELECT store_id AS storeId FROM store_metadata WHERE id = 1",
    ).get() as { storeId?: unknown } | undefined;
    return {
      ...base,
      status: "ready",
      schemaVersion: state.version,
      ...(typeof metadata?.storeId === "string" ? { storeId: metadata.storeId } : {}),
    };
  } finally {
    try {
      db.close();
    } catch {
      // best-effort close on the failure path
    }
  }
}
