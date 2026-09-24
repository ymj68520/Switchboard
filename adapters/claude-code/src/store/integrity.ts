/**
 * Backup integrity validation (frozen plan §21). A backup only counts as a
 * recovery artifact once it can be opened read-only, passes
 * PRAGMA integrity_check, and exposes the expected schema version.
 */

import { openDatabase, type StoreConnection } from "./connection.js";
import { storeError } from "./errors.js";

/** Run PRAGMA integrity_check on an open connection; must return 'ok'. */
export function integrityCheck(db: StoreConnection): string {
  const row = db.prepare("PRAGMA integrity_check").get() as Record<string, unknown> | undefined;
  const value = row ? Object.values(row)[0] : undefined;
  return typeof value === "string" ? value : "unknown";
}

export interface BackupValidation {
  schemaVersion: number;
  integrity: string;
}

/**
 * Validate a backup file: opens it (header probe included), checks
 * integrity, and verifies the recorded schema version matches the source
 * state that was backed up. The connection is read-write on purpose: it is
 * our own unpublished artifact, and a clean read-write close folds/removes
 * any SQLite WAL sidecars so the published backup stays ONE self-contained
 * file (a read-only open would create -shm/-wal litter around the pending
 * copy). Throws STORE_BACKUP_FAILED on any violation — the caller must then
 * refuse to migrate.
 */
export function validateBackupDatabase(
  backupPath: string,
  expectedSchemaVersion: number,
  options: { busyTimeoutMs?: number } = {},
): BackupValidation {
  let db: StoreConnection;
  try {
    db = openDatabase(backupPath, { busyTimeoutMs: options.busyTimeoutMs });
  } catch (err) {
    throw storeError("STORE_BACKUP_FAILED", `backup file cannot be opened: ${backupPath}`, {
      cause: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    const integrity = integrityCheck(db);
    const versionRow = db.prepare("PRAGMA user_version").get() as Record<string, unknown> | undefined;
    const version = versionRow ? Object.values(versionRow)[0] : undefined;
    if (integrity !== "ok") {
      throw storeError("STORE_BACKUP_FAILED", `backup failed integrity_check: ${backupPath}`, {
        cause: `integrity_check returned ${integrity}`,
      });
    }
    if (typeof version !== "number" || version !== expectedSchemaVersion) {
      throw storeError("STORE_BACKUP_FAILED", `backup schema version mismatch: ${backupPath}`, {
        cause: `expected ${expectedSchemaVersion}, found ${String(version)}`,
      });
    }
    return { schemaVersion: version, integrity };
  } finally {
    try {
      db.close();
    } catch {
      // best-effort close on the failure path
    }
  }
}
