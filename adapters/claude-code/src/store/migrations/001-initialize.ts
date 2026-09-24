/**
 * Migration 001 — initialize-plan-store (frozen plan §11/§12).
 *
 * Creates the schema v1 Store-infrastructure tables and the singleton store
 * identity. Runs inside the migration write transaction; the runner records
 * the history row afterwards within the same transaction.
 */

import type { StoreTx } from "../transaction.js";
import { STORE_PROTOCOL_VERSION } from "../constants.js";
import type { StoreMigration } from "./index.js";

export interface InitializeMigrationDeps {
  generateStoreId: () => string;
  nowIso: () => string;
}

export function createInitializeMigration(deps: InitializeMigrationDeps): StoreMigration {
  return {
    from: 0,
    to: 1,
    name: "initialize-plan-store",
    apply(tx: StoreTx): void {
      tx.exec(`
        CREATE TABLE store_metadata (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          store_id TEXT NOT NULL UNIQUE,
          protocol_version INTEGER NOT NULL,
          created_at TEXT NOT NULL
        )
      `);
      tx.exec(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL,
          runtime_version TEXT NOT NULL
        )
      `);
      tx.prepare(
        "INSERT INTO store_metadata (id, store_id, protocol_version, created_at) VALUES (1, ?, ?, ?)",
      ).run(deps.generateStoreId(), STORE_PROTOCOL_VERSION, deps.nowIso());
    },
  };
}
