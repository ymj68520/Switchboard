/**
 * Migration runner (frozen plan §13/§15/§22/§23).
 *
 * Choreography (the "no writer slips between backup and migration" invariant):
 *
 *   fast-path read user_version (outside any transaction)
 *     → BEGIN IMMEDIATE (writer reservation, bounded wait)
 *     → re-read user_version INSIDE the transaction (authoritative decision;
 *       a concurrent initializer may have finished while we waited)
 *     → [existing database] consistent backup from a second idle connection
 *       (WAL reader snapshot) → validate → publish
 *     → apply pending migrations + history rows
 *     → PRAGMA user_version = target
 *     → validate schema state INSIDE the transaction
 *     → COMMIT                              (any failure → full ROLLBACK)
 *
 * SQLite locking is the only cross-process coordinator — no lock files.
 */

import { openDatabase, type StoreConnection } from "./connection.js";
import { STORE_BUSY_TIMEOUT_MS } from "./constants.js";
import { RuntimeError, storeError, toStoreError } from "./errors.js";
import { assertSchemaState, readSchemaVersion, setSchemaVersion } from "./schema.js";
import type { StoreMigration } from "./migrations/index.js";
import type { StoreTx } from "./transaction.js";
import { createConsistentBackup, type BackupResult } from "./backup.js";

export interface StoreClock {
  nowIso(): string;
  newId(): string;
}

export interface MigrationRunOptions {
  /** Store connection (already open, PRAGMA policy applied). */
  db: StoreConnection;
  databasePath: string;
  backupsDir: string;
  migrations: readonly StoreMigration[];
  targetVersion: number;
  runtimeVersion: string;
  clock: StoreClock;
  /** Whether the database file existed before this process first opened it. */
  existedBefore: boolean;
  /** Test override for the bounded lock wait (default STORE_BUSY_TIMEOUT_MS). */
  busyTimeoutMs?: number;
  /** Test seam replacing the default backup executor (failure injection). */
  backupExecutor?: (fromVersion: number) => Promise<BackupResult>;
  /** Test seam replacing node:sqlite backup() inside the default executor. */
  backupFn?: (sourceConnection: StoreConnection, destination: string) => Promise<unknown>;
}

export interface MigrationOutcome {
  migrated: boolean;
  from: number;
  to: number;
  backup?: BackupResult;
}

export async function runMigrations(options: MigrationRunOptions): Promise<MigrationOutcome> {
  const { db, migrations, targetVersion } = options;
  const busyTimeoutMs = options.busyTimeoutMs ?? STORE_BUSY_TIMEOUT_MS;

  // Fast path: already current (or beyond — handled as fencing below).
  const fastVersion = readSchemaVersion(db);
  if (fastVersion === targetVersion) {
    return { migrated: false, from: fastVersion, to: targetVersion };
  }
  if (fastVersion > targetVersion) {
    throw storeError("STORE_SCHEMA_TOO_NEW", "Plan Store schema is newer than this binary supports", {
      cause: `store schema ${fastVersion} > supported ${targetVersion}`,
      detail: { supported: targetVersion, detected: fastVersion, path: options.databasePath },
    });
  }

  try {
    db.exec("BEGIN IMMEDIATE");
  } catch (err) {
    throw toStoreError(err, "cannot acquire the migration writer reservation");
  }

  try {
    // Authoritative re-read while holding the writer reservation: a
    // concurrent process may have migrated the store while we waited.
    const current = readSchemaVersion(db);
    if (current === targetVersion) {
      db.exec("COMMIT");
      return { migrated: false, from: current, to: targetVersion };
    }
    if (current > targetVersion) {
      throw storeError("STORE_SCHEMA_TOO_NEW", "Plan Store schema advanced concurrently beyond this binary", {
        cause: `store schema ${current} > supported ${targetVersion}`,
        detail: { supported: targetVersion, detected: current, path: options.databasePath },
      });
    }

    // Existing databases get a SQLite-consistent, validated backup first.
    // A brand-new empty file does not (frozen plan §12).
    let backup: BackupResult | undefined;
    if (options.existedBefore) {
      const runBackup =
        options.backupExecutor ??
        (async (fromVersion: number): Promise<BackupResult> => {
          const backupConnection = openDatabase(options.databasePath, {
            readonly: true,
            busyTimeoutMs,
          });
          try {
            return await createConsistentBackup({
              sourceConnection: backupConnection,
              backupsDir: options.backupsDir,
              fromVersion,
              toVersion: targetVersion,
              nowIso: options.clock.nowIso,
              newId: options.clock.newId,
              busyTimeoutMs,
              ...(options.backupFn === undefined ? {} : { backupFn: options.backupFn }),
            });
          } finally {
            try {
              backupConnection.close();
            } catch {
              // best-effort close on the failure path
            }
          }
        });
      try {
        backup = await runBackup(current);
      } catch (err) {
        if (err instanceof RuntimeError) {
          throw err;
        }
        throw storeError("STORE_BACKUP_FAILED", "pre-migration backup failed", {
          cause: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const pending = migrations.filter((migration) => migration.from >= current);
    for (const migration of pending) {
      try {
        migration.apply(db as unknown as StoreTx);
      } catch (err) {
        if (err instanceof RuntimeError) {
          throw err;
        }
        throw storeError(
          "STORE_MIGRATION_FAILED",
          `migration ${migration.from} → ${migration.to} (${migration.name}) failed; store rolled back`,
          { cause: err instanceof Error ? `${err.name}: ${err.message}` : String(err) },
        );
      }
      db.prepare(
        "INSERT INTO schema_migrations (version, name, applied_at, runtime_version) VALUES (?, ?, ?, ?)",
      ).run(migration.to, migration.name, options.clock.nowIso(), options.runtimeVersion);
    }

    setSchemaVersion(db, targetVersion);

    // Final consistency gate INSIDE the migration transaction: an
    // inconsistent store can never commit (history ↔ user_version).
    assertSchemaState(db, options.databasePath);

    db.exec("COMMIT");
    return { migrated: true, from: current, to: targetVersion, ...(backup ? { backup } : {}) };
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The failure may have resolved the transaction already.
    }
    throw err;
  }
}
