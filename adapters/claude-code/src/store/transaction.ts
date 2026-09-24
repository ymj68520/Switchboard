/**
 * Store transaction primitives (frozen plan §16/§17).
 *
 * withWrite is the ONLY entry point for mutating store work — now and for
 * every future domain phase:
 *
 *   BEGIN IMMEDIATE                  (bounded wait; SQLITE_BUSY → STORE_BUSY)
 *   re-read PRAGMA user_version      (schema fencing INSIDE the reservation)
 *   operation
 *   COMMIT                           (ROLLBACK on any failure)
 *
 * The in-transaction fence is what fails an old process closed after a newer
 * binary advanced the schema: a cached pre-transaction version is never
 * trusted. Plain `BEGIN`/`COMMIT` from domain code is not available — this
 * module is the single transaction boundary abstraction.
 */

import { readSchemaVersion } from "./schema.js";
import { storeError, toStoreError } from "./errors.js";
import type { SUPPORTED_SCHEMA_VERSION } from "./constants.js";

/** Narrow surface handed to operations inside a store transaction. */
export interface StoreTx {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

/** Minimal structural view of an open connection for transaction control. */
export type TransactionHost = StoreTx & { exec(sql: string): void };

export interface FenceOptions {
  supportedSchemaVersion: typeof SUPPORTED_SCHEMA_VERSION;
  databasePath: string;
}

/**
 * Schema compatibility fence evaluated INSIDE an open write transaction:
 * too new fails closed, too old must return through the migration path —
 * business writes never migrate implicitly.
 */
export function assertWriteCompat(db: StoreTx, options: FenceOptions): number {
  const current = readSchemaVersion(db);
  if (current > options.supportedSchemaVersion) {
    throw storeError("STORE_SCHEMA_TOO_NEW", "Plan Store schema is newer than this binary supports", {
      cause: `store schema ${current} > supported ${options.supportedSchemaVersion}`,
      recoverable: false,
      detail: {
        supported: options.supportedSchemaVersion,
        detected: current,
        path: options.databasePath,
      },
    });
  }
  if (current < options.supportedSchemaVersion) {
    throw storeError("STORE_SCHEMA_TOO_OLD", "Plan Store schema is older than this binary supports; run store initialization first", {
      cause: `store schema ${current} < supported ${options.supportedSchemaVersion}`,
      recoverable: true,
      detail: {
        supported: options.supportedSchemaVersion,
        detected: current,
        path: options.databasePath,
      },
    });
  }
  return current;
}

export function runRead<T>(db: TransactionHost, operation: (tx: StoreTx) => T): T {
  try {
    db.exec("BEGIN DEFERRED");
  } catch (err) {
    throw toStoreError(err, "cannot start store read transaction");
  }
  try {
    const result = operation(db);
    db.exec("COMMIT");
    return result;
  } catch (err) {
    rollbackQuietly(db);
    throw err;
  }
}

export function runWrite<T>(db: TransactionHost, operation: (tx: StoreTx) => T, options: FenceOptions): T {
  try {
    db.exec("BEGIN IMMEDIATE");
  } catch (err) {
    throw toStoreError(err, "cannot acquire store write reservation");
  }
  try {
    assertWriteCompat(db, options);
    const result = operation(db);
    db.exec("COMMIT");
    return result;
  } catch (err) {
    rollbackQuietly(db);
    throw err;
  }
}

function rollbackQuietly(db: TransactionHost): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // The transaction may already be resolved by the failure itself.
  }
}
