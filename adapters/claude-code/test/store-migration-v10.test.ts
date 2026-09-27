/**
 * Migration 10 → 11 — execution-handoff-foundation (Phase 14 §99–§102,
 * E73–E76): a real schema-10 store carrying an APPROVED FinalPlan migrates
 * with the run preserved active/final and handoffPending derived (no
 * fabricated handoff/binding); legacy completed runs are never given
 * fabricated execution rows; failing-011 rolls back to a valid schema-10
 * store; the migrated seam accepts a real handoff.
 */
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { createProductionMigrations, type StoreMigration } from "../src/store/migrations/index.js";
import { SUPPORTED_SCHEMA_VERSION } from "../src/store/constants.js";
import { initializePlanStore, inspectPlanStore, type PlanStore } from "../src/store/sqlite-store.js";
import { getPlanningRunRecord } from "../src/store/planning-runs.js";
import { getFinalPlanInTx } from "../src/store/finalization.js";
import { getExecutionBindingInTx, getExecutionHandoffInTx, getExecutionHandoffStateInTx } from "../src/store/execution.js";
import { callHandoff, makeApprovedFinalPlanFixture } from "./phase14-helpers.js";
import { fixedClock, makeTempPluginDataRoot, publishedBackups, rawConnection, removeTempPluginDataRoot, storePathsFor } from "./store-helpers.js";

function pluginDataRootOf(store: PlanStore): string {
  // <pluginDataRoot>/store/phase-plan.sqlite3 → <pluginDataRoot>
  return path.dirname(path.dirname(store.path));
}

/** Force a v11+ store back to a genuine schema-10 state (drop the v11 domain). */
function rewindToSchema10(databasePath: string): void {
  const raw = rawConnection(databasePath, 5000);
  try {
    for (const table of ["execution_handoff_states", "execution_handoff_events", "execution_handoffs", "execution_bindings"]) {
      raw.exec(`DROP TABLE IF EXISTS ${table}`);
    }
    raw.exec("DROP INDEX IF EXISTS idx_execution_handoff_events_handoff");
    raw.exec("DROP INDEX IF EXISTS idx_execution_bindings_active_session");
    raw.exec("DROP INDEX IF EXISTS idx_execution_bindings_session");
    for (const kind of ["update", "delete"]) {
      for (const table of ["execution_handoffs", "execution_handoff_events"]) {
        raw.exec(`DROP TRIGGER IF EXISTS ${table}_no_${kind}`);
      }
    }
    raw.exec("DELETE FROM schema_migrations WHERE version >= 11");
    raw.exec("PRAGMA user_version = 10");
  } finally {
    raw.close();
  }
}

function rawSchemaVersion(databasePath: string): number {
  const raw = rawConnection(databasePath, 5000);
  try {
    const row = raw.prepare("PRAGMA user_version").get() as Record<string, unknown>;
    return Object.values(row)[0] as number;
  } finally {
    raw.close();
  }
}

function rawTableNames(databasePath: string): string[] {
  const raw = rawConnection(databasePath, 5000);
  try {
    return (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name);
  } finally {
    raw.close();
  }
}

describe("migration 10 → 11 execution-handoff-foundation (§99–§102, E73–E76)", () => {
  it("migrates a real schema-10 store with an approved FinalPlan: rows unchanged, run stays active/final, no fabricated handoff, seam live (§99/E73)", async () => {
    const { f, ctx } = await makeApprovedFinalPlanFixture();
    const root = pluginDataRootOf(ctx.store);
    try {
      const databasePath = storePathsFor(root).databasePath;
      const canonicalBefore = ctx.store.withRead((tx) => getFinalPlanInTx(tx, f.runId)!.canonicalJson);
      rewindToSchema10(databasePath);

      const inspection10 = inspectPlanStore(root);
      expect(inspection10.status).toBe("too_old");
      expect(inspection10.schemaVersion).toBe(10);

      const store = await initializePlanStore({ pluginDataRoot: root });
      try {
        expect(store.getSchemaVersion()).toBe(SUPPORTED_SCHEMA_VERSION);
        // The approved FinalPlan and its provenance survive byte-identical.
        const finalPlan = store.withRead((tx) => getFinalPlanInTx(tx, f.runId));
        expect(finalPlan).not.toBeNull();
        expect(finalPlan!.finalPlanId).toBe(f.finalPlanId);
        expect(finalPlan!.finalPlanHash).toBe(f.finalPlanHash);
        expect(finalPlan!.canonicalJson).toBe(canonicalBefore);
        // The run is preserved active/final — the Phase 14 seam (§99).
        expect(getPlanningRunRecord(store, f.runId)).toMatchObject({ lifecycle: "active", stage: "final" });
        // Handoff tables are empty; nothing fabricated (§100).
        expect(store.withRead((tx) => getExecutionHandoffInTx(tx, f.runId))).toBeNull();
        expect(store.withRead((tx) => getExecutionHandoffStateInTx(tx, f.runId))).toBeNull();
        expect(store.withRead((tx) => getExecutionBindingInTx(tx, f.runId))).toBeNull();
        // The seam is live: a real handoff derives on the migrated store.
        ctx.store.close();
        ctx.store = store;
        const prepared = callHandoff(ctx, f, { toolUseId: "TU-SEAM-1" });
        expect(prepared.status).toBe("ok");
        expect(store.withRead((tx) => getExecutionHandoffInTx(tx, f.runId))!.handoffId).toBe(prepared.handoff_id);
      } finally {
        store.close();
        void ctx;
      }
      const history = (rawConnection(databasePath, 5000));
      try {
        const rows = history.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>;
        expect(rows.map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
      } finally {
        history.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("legacy completed runs are never given fabricated execution rows (§98/E74)", async () => {
    const { f, ctx } = await makeApprovedFinalPlanFixture();
    const root = pluginDataRootOf(ctx.store);
    try {
      const databasePath = storePathsFor(root).databasePath;
      ctx.store.close();
      const raw = rawConnection(databasePath, 5000);
      try {
        raw
          .prepare(
            "INSERT INTO planning_runs (run_id, workspace_id, lifecycle, stage, revision, goal, created_at, updated_at) "
            + "SELECT 'plan_legacy-done', workspace_id, 'completed', 'final', 7, 'legacy goal', '2026-01-01', '2026-01-01' "
            + "FROM planning_runs WHERE run_id = ?",
          )
          .run(f.runId);
      } finally {
        raw.close();
      }
      rewindToSchema10(databasePath);

      const store = await initializePlanStore({ pluginDataRoot: root });
      try {
        expect(store.getSchemaVersion()).toBe(SUPPORTED_SCHEMA_VERSION);
        // No fabricated handoff/binding/state for the legacy completed run (§98).
        expect(store.withRead((tx) => getExecutionHandoffInTx(tx, "plan_legacy-done"))).toBeNull();
        expect(store.withRead((tx) => getExecutionHandoffStateInTx(tx, "plan_legacy-done"))).toBeNull();
        expect(store.withRead((tx) => getExecutionBindingInTx(tx, "plan_legacy-done"))).toBeNull();
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("failing-011 rolls back to a fully valid schema-10 store — no partial execution tables (§101/E76)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { databasePath, backupsDir } = storePathsFor(root);
      const probe = await initializePlanStore({ pluginDataRoot: root });
      probe.close();
      rewindToSchema10(databasePath);

      const clock = fixedClock();
      const failing: StoreMigration = {
        from: 10,
        to: 11,
        name: "execution-handoff-foundation",
        apply(tx) {
          tx.exec("CREATE TABLE half_created_execution (x TEXT)");
          throw new Error("injected 011 failure");
        },
      };
      await expect(
        initializePlanStore({
          pluginDataRoot: root,
          migrations: [
            ...createProductionMigrations({ generateStoreId: clock.newId, nowIso: clock.nowIso }).filter((m) => m.to <= 10),
            failing,
          ],
        }),
      ).rejects.toMatchObject({ code: "STORE_MIGRATION_FAILED", causeText: expect.stringContaining("injected 011 failure") });

      // The store is still a VALID schema-10 store with no partial tables.
      expect(rawSchemaVersion(databasePath)).toBe(10);
      const names = rawTableNames(databasePath);
      expect(names).not.toContain("execution_handoffs");
      expect(names).not.toContain("execution_bindings");
      expect(names).not.toContain("half_created_execution");
      // A normal open migrates it forward again.
      const store = await initializePlanStore({ pluginDataRoot: root });
      try {
        expect(store.getSchemaVersion()).toBe(11);
      } finally {
        store.close();
      }
      expect(publishedBackups(backupsDir).length).toBeGreaterThan(0);
    } finally {
      removeTempPluginDataRoot(root);
    }
  });
});
