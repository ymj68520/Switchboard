/**
 * Migration 15 → 16 — execution-structure-foundation (v0.2.0 E3 §22/§30-T22):
 * a real schema-15 store carrying the full E2 world (active ExecutionRun,
 * attached SupervisorBinding, delivered handoff, completed PlanningRun)
 * migrates with every old row unchanged, NO fabricated Stage/Window rows and
 * NO fabricated accepted progress; a failing 016 rolls back to a valid
 * schema-15 store; a too-new writer is fenced. The migrated active run
 * bootstraps its structure deterministically afterwards (E3 §23).
 */
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { createProductionMigrations, type StoreMigration } from "../src/store/migrations/index.js";
import { SUPPORTED_SCHEMA_VERSION } from "../src/store/constants.js";
import { initializePlanStore, type PlanStore } from "../src/store/sqlite-store.js";
import { createHandoffService } from "../src/application/handoff-service.js";
import { createExecutionStructureService, getExecutionStructureInTx } from "../src/application/execution-structure-service.js";
import { callHandoff, makeApprovedFinalPlanFixture, type ApprovedFinalPlanFixture } from "./phase14-helpers.js";
import { getPlanningRunRecord } from "../src/store/planning-runs.js";
import { fixedClock, makeTempPluginDataRoot, publishedBackups, rawConnection, removeTempPluginDataRoot, storePathsFor, dropSchema16Objects } from "./store-helpers.js";
import type { PhasePlanToolContext } from "../src/mcp/tools.js";

function pluginDataRootOf(store: PlanStore): string {
  return path.dirname(path.dirname(store.path));
}

/** Force a v16+ store back to a genuine schema-15 state (drop the v16 domain). */
function rewindToSchema15(databasePath: string): void {
  const raw = rawConnection(databasePath, 5000);
  try {
    dropSchema16Objects(raw);
    raw.exec("DELETE FROM schema_migrations WHERE version >= 16");
    raw.exec("PRAGMA user_version = 15");
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

interface E3World {
  f: ApprovedFinalPlanFixture;
  ctx: PhasePlanToolContext;
  executionRunId: string;
}

async function makeActiveExecutionWorld(sessionId = "S1"): Promise<E3World> {
  const { f, ctx } = await makeApprovedFinalPlanFixture(sessionId);
  const prepared = callHandoff(ctx, f, { toolUseId: `${sessionId}-DELIVER` });
  createHandoffService(ctx.store, ctx.clock).finalizeDelivery({
    runId: f.runId,
    sessionId: f.sessionId,
    toolUseId: `${sessionId}-DELIVER`,
    responseHandoffId: prepared.handoff_id,
    responseHandoffHash: prepared.handoff_hash,
  });
  expect(getPlanningRunRecord(ctx.store, f.runId)!.lifecycle).toBe("completed");
  return { f, ctx, executionRunId: prepared.execution_run.id };
}

describe("migration 15 → 16 execution-structure-foundation (E3 §22/§30-T22)", () => {
  it("migrates the active E2 world: old rows unchanged, structure tables EMPTY (no fabricated progress), history [1..16]; bootstrap then converges idempotently", async () => {
    const w = await makeActiveExecutionWorld();
    const root = pluginDataRootOf(w.ctx.store);
    try {
      const databasePath = storePathsFor(root).databasePath;
      const before = {
        runs: w.ctx.store.withRead((tx) => tx.prepare("SELECT run_id AS id, lifecycle, stage, revision FROM planning_runs ORDER BY run_id").all()),
        executionRuns: w.ctx.store.withRead((tx) => tx.prepare("SELECT * FROM execution_runs ORDER BY run_id").all()),
        executionRunEvents: w.ctx.store.withRead((tx) => tx.prepare("SELECT * FROM execution_run_events ORDER BY execution_run_id, event_seq").all()),
        finalPlans: w.ctx.store.withRead((tx) => tx.prepare("SELECT final_plan_id, final_plan_hash, canonical_json FROM final_plans ORDER BY final_plan_id").all()),
        handoffs: w.ctx.store.withRead((tx) => tx.prepare("SELECT handoff_id, handoff_hash, canonical_json FROM execution_handoffs ORDER BY handoff_id").all()),
        bindings: w.ctx.store.withRead((tx) => tx.prepare("SELECT * FROM execution_bindings ORDER BY run_id").all()),
        supervisorBindings: w.ctx.store.withRead((tx) => tx.prepare("SELECT * FROM supervisor_bindings ORDER BY execution_run_id").all()),
        supervisorEvents: w.ctx.store.withRead((tx) => tx.prepare("SELECT * FROM supervisor_binding_events ORDER BY execution_run_id, event_seq").all()),
      };
      w.ctx.store.close();
      rewindToSchema15(databasePath);

      const store = await initializePlanStore({ pluginDataRoot: root });
      try {
        expect(store.getSchemaVersion()).toBe(SUPPORTED_SCHEMA_VERSION);
        const same = <T>(a: T, b: T) => expect(b).toEqual(a);
        same(before.runs, store.withRead((tx) => tx.prepare("SELECT run_id AS id, lifecycle, stage, revision FROM planning_runs ORDER BY run_id").all()));
        same(before.executionRuns, store.withRead((tx) => tx.prepare("SELECT * FROM execution_runs ORDER BY run_id").all()));
        same(before.executionRunEvents, store.withRead((tx) => tx.prepare("SELECT * FROM execution_run_events ORDER BY execution_run_id, event_seq").all()));
        same(before.finalPlans, store.withRead((tx) => tx.prepare("SELECT final_plan_id, final_plan_hash, canonical_json FROM final_plans ORDER BY final_plan_id").all()));
        same(before.handoffs, store.withRead((tx) => tx.prepare("SELECT handoff_id, handoff_hash, canonical_json FROM execution_handoffs ORDER BY handoff_id").all()));
        same(before.bindings, store.withRead((tx) => tx.prepare("SELECT * FROM execution_bindings ORDER BY run_id").all()));
        same(before.supervisorBindings, store.withRead((tx) => tx.prepare("SELECT * FROM supervisor_bindings ORDER BY execution_run_id").all()));
        same(before.supervisorEvents, store.withRead((tx) => tx.prepare("SELECT * FROM supervisor_binding_events ORDER BY execution_run_id, event_seq").all()));
        // No fabricated accepted progress and no fabricated structure.
        expect((store.withRead((tx) => tx.prepare("SELECT COUNT(*) AS n FROM execution_stages").get()) as { n: number }).n).toBe(0);
        expect((store.withRead((tx) => tx.prepare("SELECT COUNT(*) AS n FROM verification_windows").get()) as { n: number }).n).toBe(0);
        // E3 §23 — deterministic bootstrap materializes the migrated run's
        // structure from its exact FinalPlan, idempotently.
        const service = createExecutionStructureService(store, fixedClock());
        const first = service.ensureExecutionStructure({ executionRunId: w.executionRunId });
        const second = service.ensureExecutionStructure({ executionRunId: w.executionRunId });
        expect(first.stages.map((s) => s.id)).toEqual(second.stages.map((s) => s.id));
        expect(first.stages.length).toBeGreaterThan(0);
        expect(first.activeStage!.status).toBe("active");
        expect(first.openWindow!.candidateRevision).toBe(0);
        // Provenance: every materialized stage cites its exact approved step.
        for (const stage of first.stages) {
          expect(stage.sourceStepId).not.toBeNull();
          expect(stage.sourceRefs.length).toBeGreaterThan(0);
        }
        // The recovery projection reflects the bootstrapped structure.
        const structure = store.withRead((tx) => getExecutionStructureInTx(tx, w.executionRunId));
        expect(structure.activeStage!.id).toBe(first.activeStage!.id);
      } finally {
        store.close();
      }
      const raw = rawConnection(databasePath, 5000);
      try {
        const rows = raw.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>;
        expect(rows.map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26]);
      } finally {
        raw.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("failing-016 rolls back to a fully valid schema-15 store — no partial structure objects", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { databasePath, backupsDir } = storePathsFor(root);
      const probe = await initializePlanStore({ pluginDataRoot: root });
      probe.close();
      rewindToSchema15(databasePath);

      const clock = fixedClock();
      const failing: StoreMigration = {
        from: 15,
        to: 16,
        name: "execution-structure-foundation",
        apply(tx) {
          tx.exec("CREATE TABLE half_created_structure (x TEXT)");
          throw new Error("injected 016 failure");
        },
      };
      const production = createProductionMigrations({ generateStoreId: clock.newId, nowIso: clock.nowIso });
      await expect(
        initializePlanStore({
          pluginDataRoot: root,
          // The truncated chain must still reach the supported schema: the real
          // 16→17 step follows the injected 15→16 failure.
          migrations: [...production.filter((m) => m.to <= 15), failing, ...production.filter((m) => m.to >= 17)],
        }),
      ).rejects.toMatchObject({ code: "STORE_MIGRATION_FAILED", causeText: expect.stringContaining("injected 016 failure") });

      expect(rawSchemaVersion(databasePath)).toBe(15);
      const raw = rawConnection(databasePath, 5000);
      try {
        const names = (raw.prepare("SELECT name FROM sqlite_master").all() as Array<{ name: string }>).map((r) => r.name);
        expect(names).not.toContain("execution_stages");
        expect(names).not.toContain("verification_windows");
        expect(names).not.toContain("execution_stages_provenance_immutable");
        expect(names).not.toContain("half_created_structure");
      } finally {
        raw.close();
      }
      // A normal open migrates it forward again.
      const store = await initializePlanStore({ pluginDataRoot: root });
      try {
        expect(store.getSchemaVersion()).toBe(26);
      } finally {
        store.close();
      }
      expect(publishedBackups(backupsDir).length).toBeGreaterThan(0);
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("a newer-than-supported store is fenced with zero writes", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { databasePath } = storePathsFor(root);
      const probe = await initializePlanStore({ pluginDataRoot: root });
      probe.close();
      const raw = rawConnection(databasePath, 5000);
      try {
        raw.exec(`PRAGMA user_version = ${SUPPORTED_SCHEMA_VERSION + 1}`);
      } finally {
        raw.close();
      }
      await expect(initializePlanStore({ pluginDataRoot: root })).rejects.toMatchObject({
        code: "STORE_SCHEMA_TOO_NEW",
      });
      expect(rawSchemaVersion(databasePath)).toBe(SUPPORTED_SCHEMA_VERSION + 1);
    } finally {
      removeTempPluginDataRoot(root);
    }
  });
});
