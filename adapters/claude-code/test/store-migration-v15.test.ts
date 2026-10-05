/**
 * Migration 14 → 15 — supervisor-binding-foundation (v0.2.0 E2 §16/§24-T15):
 * a real schema-14 store carrying the full E1 world (delivered handoff, active
 * ExecutionRun, ExecutionBinding, completed predecessor PlanningRun) migrates
 * with every old row unchanged and NO fabricated Supervisor owner; the first
 * legitimate takeover establishes binding authority for the unbound run; a
 * failing 015 rolls back to a valid schema-14 store; a too-new writer is
 * fenced.
 */
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { createProductionMigrations, type StoreMigration } from "../src/store/migrations/index.js";
import { SUPPORTED_SCHEMA_VERSION } from "../src/store/constants.js";
import { initializePlanStore, type PlanStore } from "../src/store/sqlite-store.js";
import { createRunControlService } from "../src/application/run-control-service.js";
import { callHandoff, makeApprovedFinalPlanFixture, type ApprovedFinalPlanFixture } from "./phase14-helpers.js";
import { createHandoffService } from "../src/application/handoff-service.js";
import { getPlanningRunRecord } from "../src/store/planning-runs.js";
import { fixedClock, makeTempPluginDataRoot, publishedBackups, rawConnection, removeTempPluginDataRoot, storePathsFor, dropSchema15Objects } from "./store-helpers.js";
import type { PhasePlanToolContext } from "../src/mcp/tools.js";

function pluginDataRootOf(store: PlanStore): string {
  return path.dirname(path.dirname(store.path));
}

/** Force a v15+ store back to a genuine schema-14 state (drop the v15 domain). */
function rewindToSchema14(databasePath: string): void {
  const raw = rawConnection(databasePath, 5000);
  try {
    dropSchema15Objects(raw);
    raw.exec("DELETE FROM schema_migrations WHERE version >= 15");
    raw.exec("PRAGMA user_version = 14");
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

interface E2World {
  f: ApprovedFinalPlanFixture;
  ctx: PhasePlanToolContext;
}

/** The E1 end state: delivered handoff, activated ExecutionRun, planning run completed. */
async function makeActiveExecutionWorld(sessionId = "S1"): Promise<E2World> {
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

describe("migration 14 → 15 supervisor-binding-foundation (E2 §16/§24-T15)", () => {
  it("migrates the active E1 world: old rows unchanged, supervisor_bindings EMPTY (no fabricated owner), history [1..15]", async () => {
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
        sessions: w.ctx.store.withRead((tx) => tx.prepare("SELECT * FROM session_bindings ORDER BY run_id").all()),
      };
      w.ctx.store.close();
      rewindToSchema14(databasePath);

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
        same(before.sessions, store.withRead((tx) => tx.prepare("SELECT * FROM session_bindings ORDER BY run_id").all()));
        // E2-I16 — the migrated active run has NO fabricated current owner.
        expect((store.withRead((tx) => tx.prepare("SELECT COUNT(*) AS n FROM supervisor_bindings").get()) as { n: number }).n).toBe(0);
        // E2 §16 — the first legitimate takeover establishes binding authority
        // for the unbound run (generation 1, null previous identity).
        const result = createRunControlService(store, fixedClock()).takeoverRun({
          runId: w.f.runId,
          workspaceId: w.f.workspaceId,
          callerSessionId: "S2-RECOVERY",
          expectedBindingGeneration: 1,
          authorization: {
            authorizationRequestId: "mcp-control:TU-RECOVER",
            operationId: "takeover:TU-RECOVER",
            requestHash: "recover-unbound",
          },
        });
        expect(result.supervisor).toBeDefined();
        expect(result.supervisor!.generation).toBe(1);
        expect(result.supervisor!.unboundAttach).toBe(true);
        expect((store.withRead((tx) => tx.prepare("SELECT COUNT(*) AS n FROM supervisor_bindings").get()) as { n: number }).n).toBe(1);
        const binding = store.withRead((tx) => tx.prepare("SELECT session_id AS s, state, generation AS g FROM supervisor_bindings WHERE execution_run_id = (SELECT execution_run_id FROM execution_runs WHERE run_id = ?)").get(w.f.runId)) as { s: string; state: string; g: number };
        expect(binding).toEqual({ s: "S2-RECOVERY", state: "attached", g: 1 });
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

  it("failing-015 rolls back to a fully valid schema-14 store — no partial supervision objects", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { databasePath, backupsDir } = storePathsFor(root);
      const probe = await initializePlanStore({ pluginDataRoot: root });
      probe.close();
      rewindToSchema14(databasePath);

      const clock = fixedClock();
      const failing: StoreMigration = {
        from: 14,
        to: 15,
        name: "supervisor-binding-foundation",
        apply(tx) {
          tx.exec("CREATE TABLE half_created_supervision (x TEXT)");
          throw new Error("injected 015 failure");
        },
      };
      const production = createProductionMigrations({ generateStoreId: clock.newId, nowIso: clock.nowIso });
      await expect(
        initializePlanStore({
          pluginDataRoot: root,
          // 015 is the last migration: the truncated chain reaches 15 exactly.
          migrations: [...production.filter((m) => m.to <= 14), failing, ...production.filter((m) => m.to >= 16)],
        }),
      ).rejects.toMatchObject({ code: "STORE_MIGRATION_FAILED", causeText: expect.stringContaining("injected 015 failure") });

      expect(rawSchemaVersion(databasePath)).toBe(14);
      const raw = rawConnection(databasePath, 5000);
      try {
        const names = (raw.prepare("SELECT name FROM sqlite_master").all() as Array<{ name: string }>).map((r) => r.name);
        expect(names).not.toContain("supervisor_bindings");
        expect(names).not.toContain("supervisor_binding_events");
        expect(names).not.toContain("supervisor_bindings_identity_immutable");
        expect(names).not.toContain("half_created_supervision");
      } finally {
        raw.close();
      }
      // A normal open migrates it forward again (through the real 016).
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
