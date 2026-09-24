/**
 * SQLite-consistent backup (frozen plan §19/§20/§23).
 *
 * Backups use the node:sqlite module-level `backup()` API — never filesystem
 * copies of the database or its WAL/SHM sidecars. Publication is two-phase:
 * the backup is written to a pending path, VALIDATED (open + integrity_check
 * + schema version), and only then renamed to its final name, so a failed
 * backup can never masquerade as a valid one.
 *
 * node:sqlite cannot run backup() on a connection that holds an open write
 * transaction. The migration choreography therefore takes the writer
 * reservation on the store connection and snapshots via a second, idle
 * connection — in WAL mode the reader gets the last committed state without
 * blocking, and the reservation guarantees no concurrent writer can slip in
 * between the snapshot and the migration commit.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { openDatabase, readBackupFn, type StoreConnection } from "./connection.js";
import { storeError } from "./errors.js";
import { RuntimeError } from "../runtime/errors.js";
import { validateBackupDatabase } from "./integrity.js";

export interface BackupRequest {
  /** Idle connection used as the backup source (see module doc). */
  sourceConnection: StoreConnection;
  backupsDir: string;
  fromVersion: number;
  toVersion: number;
  nowIso: () => string;
  newId: () => string;
  busyTimeoutMs?: number;
  /** Test seam replacing node:sqlite backup() (e.g. failure injection). */
  backupFn?: (sourceConnection: StoreConnection, destination: string) => Promise<unknown>;
}

export interface BackupResult {
  /** Final published backup path (validated). */
  path: string;
  name: string;
}

/** `phase-plan-pre-schema-0-1-20260924T223045123-ab12cd34.sqlite3` */
export function backupFileName(
  fromVersion: number,
  toVersion: number,
  nowIso: string,
  uniqueSuffix: string,
): string {
  const stamp = nowIso.replace(/[-:]/g, "").replace(/\..+$/, "");
  return `phase-plan-pre-schema-${fromVersion}-${toVersion}-${stamp}-${uniqueSuffix}.sqlite3`;
}

/**
 * Create, validate, and publish one consistent backup. Throws
 * STORE_BACKUP_FAILED (cleaning up the pending file) on any failure — a
 * failed backup never leaves a final-name artifact behind.
 */
export async function createConsistentBackup(request: BackupRequest): Promise<BackupResult> {
  const backup = request.backupFn ?? readBackupFn();
  const name = backupFileName(request.fromVersion, request.toVersion, request.nowIso(), request.newId());
  const finalPath = path.join(request.backupsDir, name);
  const pendingPath = path.join(request.backupsDir, `.pending-${name}`);
  try {
    try {
      await backup(request.sourceConnection, pendingPath);
    } catch (err) {
      throw storeError("STORE_BACKUP_FAILED", `backup() failed for ${finalPath}`, {
        cause: err instanceof Error ? err.message : String(err),
      });
    }
    // The backup artifact may carry SQLite WAL sidecars from the copy. Fold
    // them into the main file (checkpoint) and let a clean close remove
    // them, so the published backup is ONE self-contained file whose bytes
    // are exactly the state that gets validated below.
    checkpointPendingBackup(pendingPath, request.busyTimeoutMs);
    validateBackupDatabase(pendingPath, request.fromVersion, {
      busyTimeoutMs: request.busyTimeoutMs,
    });
    fs.renameSync(pendingPath, finalPath);
    return { path: finalPath, name };
  } catch (err) {
    try {
      fs.rmSync(pendingPath, { force: true });
    } catch {
      // best-effort cleanup of the unpublished artifact
    }
    if (err instanceof RuntimeError) {
      throw err;
    }
    throw storeError("STORE_BACKUP_FAILED", `cannot publish backup ${finalPath}`, {
      cause: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Fold WAL sidecars of a pending backup copy into the main file and remove
 * them via a clean close. This touches ONLY our own unpublished artifact —
 * live store sidecars remain SQLite-managed (frozen plan §9).
 */
function checkpointPendingBackup(pendingPath: string, busyTimeoutMs?: number): void {
  let db: StoreConnection;
  try {
    db = openDatabase(pendingPath, { busyTimeoutMs });
  } catch (err) {
    throw storeError("STORE_BACKUP_FAILED", `backup copy cannot be opened for checkpoint: ${pendingPath}`, {
      cause: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch (err) {
    throw storeError("STORE_BACKUP_FAILED", `backup checkpoint failed: ${pendingPath}`, {
      cause: err instanceof Error ? err.message : String(err),
    });
  } finally {
    try {
      db.close();
    } catch {
      // best-effort close on the failure path
    }
  }
}
