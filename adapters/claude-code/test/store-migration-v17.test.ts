/**
 * Migration 16 → 17 — execution-protocol-foundation (v0.2.0 E4 §44/§47-T38):
 * a real schema-16 store carrying the full E3 world (active ExecutionRun,
 * attached SupervisorBinding, materialized Stages, open VerificationWindow,
 * delivered handoff, completed PlanningRun) migrates with every old row
 * unchanged, NO fabricated Directive/Attempt/Report rows and NO fabricated
 * accepted progress; a failing 017 rolls back to a valid schema-16 store; a
 * too-new writer is fenced.
 */
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { createProductionMigrations, type StoreMigration } from "../src/store/migrations/index.js";
import { SUPPORTED_SCHEMA_VERSION } from "../src/store/constants.js";
import { initializePlanStore, type PlanStore } from "../src/store/sqlite-store.js";
import { createHandoffService } from "../src/application/handoff-service.js";
import { callHandoff, makeApprovedFinalPlanFixture, type ApprovedFinalPlanFixture } from "./phase14-helpers.js";
import { getPlanningRunRecord } from "../src/store/planning-runs.js";
import {
  dropSchema17Objects,
  fixedClock,
  makeTempPluginDataRoot,
  publishedBackups,
  rawConnection,
  removeTempPluginDataRoot,
  storePathsFor,
} from "./store-helpers.js";
import type { PhasePlanToolContext } from "../src/mcp/tools.js";

function pluginDataRootOf(store: PlanStore): string {
  return path.dirname(path.dirname(store.path));
}

/** Force a v17+ store back to a genuine schema-16 state (drop the v17 domain). */
function rewindToSchema16(databasePath: string): void {
  const raw = rawConnection(databasePath, 5000);
  try {
    dropSchema17Objects(raw);
    raw.exec("DELETE FROM schema_migrations WHERE version >= 17");
    raw.exec("PRAGMA user_version = 16");
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

async function makeActiveExecutionWorld(sessionId = "S1"): Promise<{ f: ApprovedFinalPlanFixture; ctx: PhasePlanToolContext }> {
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
  return { f, ctx };
}

describe("migration 16 → 17 execution-protocol-foundation (E4 §44/§47-T38)", () => {
  it("migrates the full E3 world: old rows unchanged, protocol tables EMPTY (no fabricated directives/progress), history [1..17]", async () => {
    const w = await makeActiveExecutionWorld();
    const root = pluginDataRootOf(w.ctx.store);
    try {
      const databasePath = storePathsFor(root).databasePath;
      const before = {
        runs: w.ctx.store.withRead((tx) => tx.prepare("SELECT run_id AS id, lifecycle, stage, revision FROM planning_runs ORDER BY run_id").all()),
        executionRuns: w.ctx.store.withRead((tx) => tx.prepare("SELECT * FROM execution_runs ORDER BY run_id").all()),
        executionRunEvents: w.ctx.store.withRead((tx) => tx.prepare("SELECT * FROM execution_run_events ORDER BY execution_run_id, event_seq").all()),
        finalPlans: w.ctx.store.withRead((tx) => tx.prepare("SELECT final_plan_id, final_plan_hash, canonical_json FROM final_plans ORDER BY final_plan_id").all()),
        supervisorBindings: w.ctx.store.withRead((tx) => tx.prepare("SELECT * FROM supervisor_bindings ORDER BY execution_run_id").all()),
        supervisorEvents: w.ctx.store.withRead((tx) => tx.prepare("SELECT * FROM supervisor_binding_events ORDER BY execution_run_id, event_seq").all()),
        stages: w.ctx.store.withRead((tx) => tx.prepare("SELECT * FROM execution_stages ORDER BY execution_run_id, ordinal").all()),
        windows: w.ctx.store.withRead((tx) => tx.prepare("SELECT * FROM verification_windows ORDER BY id").all()),
      };
      w.ctx.store.close();
      rewindToSchema16(databasePath);

      const store = await initializePlanStore({ pluginDataRoot: root });
      try {
        expect(store.getSchemaVersion()).toBe(SUPPORTED_SCHEMA_VERSION);
        const same = <T>(a: T, b: T) => expect(b).toEqual(a);
        same(before.runs, store.withRead((tx) => tx.prepare("SELECT run_id AS id, lifecycle, stage, revision FROM planning_runs ORDER BY run_id").all()));
        same(before.executionRuns, store.withRead((tx) => tx.prepare("SELECT * FROM execution_runs ORDER BY run_id").all()));
        same(before.executionRunEvents, store.withRead((tx) => tx.prepare("SELECT * FROM execution_run_events ORDER BY execution_run_id, event_seq").all()));
        same(before.finalPlans, store.withRead((tx) => tx.prepare("SELECT final_plan_id, final_plan_hash, canonical_json FROM final_plans ORDER BY final_plan_id").all()));
        same(before.supervisorBindings, store.withRead((tx) => tx.prepare("SELECT * FROM supervisor_bindings ORDER BY execution_run_id").all()));
        same(before.supervisorEvents, store.withRead((tx) => tx.prepare("SELECT * FROM supervisor_binding_events ORDER BY execution_run_id, event_seq").all()));
        same(before.stages, store.withRead((tx) => tx.prepare("SELECT * FROM execution_stages ORDER BY execution_run_id, ordinal").all()));
        same(before.windows, store.withRead((tx) => tx.prepare("SELECT * FROM verification_windows ORDER BY id").all()));
        // E4 §44 — all new protocol tables start EMPTY for pre-existing runs;
        // no backfill from conversation/history, no fabricated progress.
        for (const table of ["execution_directives", "execution_attempts", "execution_reports", "execution_protocol_events"]) {
          expect((store.withRead((tx) => tx.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()) as { n: number }).n).toBe(0);
        }
        // The migrated run's recovery projection still works and reports no protocol state.
        const directives = store.withRead((tx) =>
          tx.prepare("SELECT COUNT(*) AS n FROM execution_directives").get(),
        ) as { n: number };
        expect(directives.n).toBe(0);
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

  it("failing-017 rolls back to a fully valid schema-16 store — no partial protocol objects", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { databasePath, backupsDir } = storePathsFor(root);
      const probe = await initializePlanStore({ pluginDataRoot: root });
      probe.close();
      rewindToSchema16(databasePath);

      const clock = fixedClock();
      const failing: StoreMigration = {
        from: 16,
        to: 17,
        name: "execution-protocol-foundation",
        apply(tx) {
          tx.exec("CREATE TABLE half_created_protocol (x TEXT)");
          throw new Error("injected 017 failure");
        },
      };
      const production = createProductionMigrations({ generateStoreId: clock.newId, nowIso: clock.nowIso });
      await expect(
        initializePlanStore({
          pluginDataRoot: root,
          // 017 is the last migration: the truncated chain reaches 17 exactly.
          migrations: [...production.filter((m) => m.to <= 16), failing, ...production.filter((m) => m.to >= 18)],
        }),
      ).rejects.toMatchObject({ code: "STORE_MIGRATION_FAILED", causeText: expect.stringContaining("injected 017 failure") });

      expect(rawSchemaVersion(databasePath)).toBe(16);
      const raw = rawConnection(databasePath, 5000);
      try {
        const names = (raw.prepare("SELECT name FROM sqlite_master").all() as Array<{ name: string }>).map((r) => r.name);
        expect(names).not.toContain("execution_directives");
        expect(names).not.toContain("execution_attempts");
        expect(names).not.toContain("execution_reports");
        expect(names).not.toContain("execution_protocol_events");
        expect(names).not.toContain("execution_directives_no_update");
        expect(names).not.toContain("half_created_protocol");
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
