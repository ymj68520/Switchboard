/**
 * Migration registry (frozen plan §14). Migrations are an ordered, validated
 * chain — never scattered `if (version === N)` branching. Phase 3 will append
 * a `1 → 2` entry here without touching the runner.
 */

import type { StoreTx } from "../transaction.js";
import { createInitializeMigration } from "./001-initialize.js";
import { createWorkspaceBindingMigration } from "./002-workspace-session-binding.js";
import { createPlanningRunMigration } from "./003-planning-run-foundation.js";

export interface StoreMigration {
  /** Authoritative `PRAGMA user_version` this migration starts from. */
  from: number;
  /** Authoritative version after this migration commits. */
  to: number;
  /** Stable human-readable name recorded in the migration history. */
  name: string;
  /**
   * Apply the migration. Runs INSIDE the migration write transaction on the
   * store connection — DDL and DML join the same atomic commit as the
   * user_version bump and history row.
   */
  apply(tx: StoreTx): void;
}

/**
 * Validate a registry for use by the runner:
 * no gaps, no duplicate from/to versions, strictly increasing one-step chain
 * starting at 0. Structure violations are programming errors and throw plain
 * Errors at registration time, before any database is touched.
 */
export function validateMigrationRegistry(migrations: readonly StoreMigration[]): void {
  let expectedFrom = 0;
  const seenTargets = new Set<number>();
  for (const migration of migrations) {
    if (migration.from !== expectedFrom) {
      throw new Error(
        `migration registry gap: expected from=${expectedFrom}, got ${migration.from} (${migration.name})`,
      );
    }
    if (migration.to !== migration.from + 1) {
      throw new Error(
        `migration must step exactly one version: ${migration.from} → ${migration.to} (${migration.name})`,
      );
    }
    if (seenTargets.has(migration.to)) {
      throw new Error(`duplicate migration target version: ${migration.to}`);
    }
    seenTargets.add(migration.to);
    expectedFrom = migration.to;
  }
}

export interface ProductionMigrationDeps {
  /** Injectable id generator for the singleton store_id (frozen plan §29). */
  generateStoreId: () => string;
  /** Injectable clock for created_at (ISO string). */
  nowIso: () => string;
}

/**
 * The production registry: `0→1 initialize-plan-store`,
 * `1→2 workspace-and-session-binding`, `2→3 planning-run-foundation`.
 */
export function createProductionMigrations(deps: ProductionMigrationDeps): StoreMigration[] {
  return [createInitializeMigration(deps), createWorkspaceBindingMigration(), createPlanningRunMigration()];
}
