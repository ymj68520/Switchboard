/**
 * Store error mapping (frozen plan §25). Raw SQLite failures are normalized
 * into stable machine-readable RuntimeErrors so callers (MCP bootstrap,
 * doctor, tests) never branch on exception text.
 */

import { RuntimeError } from "../runtime/errors.js";

export { RuntimeError };

export type StoreErrorCode =
  | "STORE_SCHEMA_TOO_NEW"
  | "STORE_SCHEMA_TOO_OLD"
  | "STORE_SCHEMA_INVALID"
  | "STORE_CORRUPT"
  | "STORE_OPEN_FAILED"
  | "STORE_BUSY"
  | "STORE_BACKUP_FAILED"
  | "STORE_MIGRATION_FAILED";

/** The set of store codes that exist in the runtime error union (exit 5). */
export const STORE_ERROR_CODES: readonly StoreErrorCode[] = [
  "STORE_SCHEMA_TOO_NEW",
  "STORE_SCHEMA_TOO_OLD",
  "STORE_SCHEMA_INVALID",
  "STORE_CORRUPT",
  "STORE_OPEN_FAILED",
  "STORE_BUSY",
  "STORE_BACKUP_FAILED",
  "STORE_MIGRATION_FAILED",
];

export function isStoreErrorCode(code: string): code is StoreErrorCode {
  return (STORE_ERROR_CODES as readonly string[]).includes(code);
}

export function storeError(
  code: StoreErrorCode,
  message: string,
  options?: { cause?: string; detail?: Record<string, unknown>; recoverable?: boolean },
): RuntimeError {
  return new RuntimeError(code, message, options);
}

/**
 * Map a raw node:sqlite / filesystem failure onto a stable store code.
 *
 * node:sqlite surfaces `ERR_SQLITE_ERROR` with errcode/errstr plus a message;
 * busy and corruption are recognized by their canonical texts so mapping
 * stays independent of Node's error-shape evolution.
 */
export function toStoreError(value: unknown, fallbackMessage: string): RuntimeError {
  if (value instanceof RuntimeError && isStoreErrorCode(value.code)) {
    return value;
  }
  const err = value as Partial<Error> & { errcode?: number | string; errstr?: string; code?: string };
  const text = `${err?.message ?? String(value)} ${err?.errstr ?? ""}`.toLowerCase();
  if (text.includes("database is locked") || text.includes("database table is locked") || text.includes("sqlite_busy")) {
    return storeError("STORE_BUSY", fallbackMessage, {
      cause: err?.message ?? String(value),
    });
  }
  if (
    text.includes("file is not a database") ||
    text.includes("not a database") ||
    text.includes("malformed") ||
    text.includes("encrypted") ||
    text.includes("sqlite_notadb")
  ) {
    return storeError("STORE_CORRUPT", fallbackMessage, {
      cause: err?.message ?? String(value),
    });
  }
  if (
    text.includes("unable to open") ||
    text.includes("cannot open") ||
    text.includes("no such file") ||
    text.includes("sqlite_cantopen") ||
    text.includes("eacces") ||
    text.includes("eperm") ||
    text.includes("enoent") ||
    text.includes("enotdir") ||
    text.includes("eexist") ||
    text.includes("eisdir")
  ) {
    return storeError("STORE_OPEN_FAILED", fallbackMessage, {
      cause: err?.message ?? String(value),
    });
  }
  return storeError("STORE_OPEN_FAILED", fallbackMessage, {
    cause: err?.message ?? String(value),
  });
}
