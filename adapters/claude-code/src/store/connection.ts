/**
 * Centralized SQLite connection factory (frozen plan §8). Every production
 * connection goes through openDatabase so the Store PRAGMA policy is applied
 * in exactly one place:
 *
 *   journal_mode = WAL          (write connections; readers inherit the WAL)
 *   foreign_keys  = ON
 *   synchronous   = FULL
 *   busy_timeout  = bounded (STORE_BUSY_TIMEOUT_MS unless overridden)
 *
 * A header-validating probe read happens at open time so a non-SQLite file
 * fails immediately with STORE_CORRUPT instead of surprising later readers.
 * Callers never construct DatabaseSync directly (frozen plan §41).
 */

import { DatabaseSync, backup as sqliteBackup } from "node:sqlite";

import { STORE_BUSY_TIMEOUT_MS } from "./constants.js";
import { storeError, toStoreError } from "./errors.js";

export interface OpenDatabaseOptions {
  /** Open read-only: no WAL/journal mutation, header probe still enforced. */
  readonly?: boolean;
  /** Per-connection bounded lock wait override (tests); production default
   * stays STORE_BUSY_TIMEOUT_MS. */
  busyTimeoutMs?: number;
}

/** Structural surface of an open SQLite connection used across the store. */
export type StoreConnection = DatabaseSync;

export function openDatabase(databasePath: string, options: OpenDatabaseOptions = {}): StoreConnection {
  const busyTimeoutMs = options.busyTimeoutMs ?? STORE_BUSY_TIMEOUT_MS;
  let db: StoreConnection;
  try {
    db = new DatabaseSync(databasePath, { readOnly: options.readonly === true });
  } catch (err) {
    throw toStoreError(err, `cannot open Plan Store database: ${databasePath}`);
  }
  try {
    // The busy handler must be installed FIRST so every subsequent
    // statement — including journal-mode conversion — honors the bounded
    // wait under multi-process contention.
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))}`);
    if (options.readonly !== true) {
      ensureWalJournal(db, busyTimeoutMs);
      db.exec("PRAGMA synchronous = FULL");
    }
    db.exec("PRAGMA foreign_keys = ON");
    // Header probe: forces SQLite to actually read the database header so a
    // junk file surfaces as STORE_CORRUPT right here, deterministically.
    db.prepare("PRAGMA user_version").get();
    return db;
  } catch (err) {
    try {
      db.close();
    } catch {
      // best-effort close on the failure path
    }
    throw toStoreError(err, `cannot initialize Plan Store connection: ${databasePath}`);
  }
}

/**
 * Ensure WAL journal mode. Concurrent initializers may race on the
 * DELETE → WAL conversion; the read-first check avoids taking locks when
 * the mode is already WAL, and a bounded retry absorbs a concurrent
 * conversion that still holds the exclusive lock. Never unbounded.
 */
function ensureWalJournal(db: StoreConnection, busyTimeoutMs: number): void {
  const attemptBudgetMs = Math.max(busyTimeoutMs, 1);
  const startedAt = Date.now();
  for (;;) {
    if (readPragmaText(db, "journal_mode") === "wal") {
      return;
    }
    try {
      db.exec("PRAGMA journal_mode = WAL");
      return;
    } catch (err) {
      if (Date.now() - startedAt >= attemptBudgetMs) {
        throw err;
      }
      sleepBlocking(50);
    }
  }
}

function sleepBlocking(ms: number): void {
  // Synchronous sleep for the sync open path; SharedArrayBuffer/Atomics is
  // the standard primitive that actually parks the thread.
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

/** Read a PRAGMA-integer through a connection (thin helper, no caching). */
export function readPragmaInt(db: StoreConnection, pragma: string): number {
  const row = db.prepare(`PRAGMA ${pragma}`).get() as Record<string, unknown> | undefined;
  const value = row ? Object.values(row)[0] : undefined;
  if (typeof value !== "number") {
    throw storeError("STORE_OPEN_FAILED", `unreadable PRAGMA ${pragma}`);
  }
  return value;
}

/** Read a PRAGMA-text (e.g. journal_mode) through a connection. */
export function readPragmaText(db: StoreConnection, pragma: string): string {
  const row = db.prepare(`PRAGMA ${pragma}`).get() as Record<string, unknown> | undefined;
  const value = row ? Object.values(row)[0] : undefined;
  if (typeof value !== "string") {
    throw storeError("STORE_OPEN_FAILED", `unreadable PRAGMA ${pragma}`);
  }
  return value;
}

/**
 * Whether this Node build exposes the node:sqlite module-level backup API
 * (required for SQLite-consistent pre-migration backups). Checked at runtime
 * so the store can fail closed with a stable code instead of crashing.
 */
export function sqliteBackupAvailable(): boolean {
  return typeof sqliteBackup === "function";
}

/** Typed accessor for the module-level backup(sourceDb, destination). */
export function readBackupFn(): (sourceDb: StoreConnection, destination: string) => Promise<unknown> {
  if (typeof sqliteBackup !== "function") {
    throw storeError(
      "STORE_BACKUP_FAILED",
      "node:sqlite backup() is unavailable on this Node build; refusing filesystem-copy fallback",
    );
  }
  return sqliteBackup;
}
