/**
 * Migration 17 → 18 — worker-invocation-foundation (v0.2.0 E5 §45/§48):
 * a real schema-17 store carrying the full E4 world migrates with every old
 * row unchanged, NO fabricated worker invocations (pre-E5 running attempts
 * stay unbound), NO retroactive claims; a failing 018 rolls back to a valid
 * schema-17 store; a too-new writer is fenced.
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
  dropSchema18Objects,
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

function rewindToSchema17(databasePath: string): void {
  const raw = rawConnection(databasePath, 5000);
  try {
    dropSchema18Objects(raw);
    raw.exec("DELETE FROM schema_migrations WHERE version >= 18");
    raw.exec("PRAGMA user_version = 17");
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

async function makeE4World(sessionId = "S1"): Promise<{ f: ApprovedFinalPlanFixture; ctx: PhasePlanToolContext }> {
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

describe("migration 17 → 18 worker-invocation-foundation (E5 §45/§48)", () => {
  it("migrates the full E4 world: old rows unchanged, invocation tables EMPTY (no fabricated claims), history [1..18]", async () => {
    const w = await makeE4World();
    const root = pluginDataRootOf(w.ctx.store);
    try {
      const databasePath = storePathsFor(root).databasePath;
      const before = {
        runs: w.ctx.store.withRead((tx) => tx.prepare("SELECT run_id AS id, lifecycle, stage, revision FROM planning_runs ORDER BY run_id").all()),
        executionRuns: w.ctx.store.withRead((tx) => tx.prepare("SELECT * FROM execution_runs ORDER BY run_id").all()),
        bindings: w.ctx.store.withRead((tx) => tx.prepare("SELECT * FROM supervisor_bindings ORDER BY execution_run_id").all()),
        stages: w.ctx.store.withRead((tx) => tx.prepare("SELECT * FROM execution_stages ORDER BY execution_run_id, ordinal").all()),
        windows: w.ctx.store.withRead((tx) => tx.prepare("SELECT * FROM verification_windows ORDER BY id").all()),
        directives: w.ctx.store.withRead((tx) => tx.prepare("SELECT * FROM execution_directives ORDER BY directive_id, revision").all()),
        attempts: w.ctx.store.withRead((tx) => tx.prepare("SELECT * FROM execution_attempts ORDER BY attempt_id").all()),
        reports: w.ctx.store.withRead((tx) => tx.prepare("SELECT * FROM execution_reports ORDER BY report_id").all()),
      };
      w.ctx.store.close();
      rewindToSchema17(databasePath);

      const store = await initializePlanStore({ pluginDataRoot: root });
      try {
        expect(store.getSchemaVersion()).toBe(SUPPORTED_SCHEMA_VERSION);
        const same = <T>(a: T, b: T) => expect(b).toEqual(a);
        same(before.runs, store.withRead((tx) => tx.prepare("SELECT run_id AS id, lifecycle, stage, revision FROM planning_runs ORDER BY run_id").all()));
        same(before.executionRuns, store.withRead((tx) => tx.prepare("SELECT * FROM execution_runs ORDER BY run_id").all()));
        same(before.bindings, store.withRead((tx) => tx.prepare("SELECT * FROM supervisor_bindings ORDER BY execution_run_id").all()));
        same(before.stages, store.withRead((tx) => tx.prepare("SELECT * FROM execution_stages ORDER BY execution_run_id, ordinal").all()));
        same(before.windows, store.withRead((tx) => tx.prepare("SELECT * FROM verification_windows ORDER BY id").all()));
        same(before.directives, store.withRead((tx) => tx.prepare("SELECT * FROM execution_directives ORDER BY directive_id, revision").all()));
        same(before.attempts, store.withRead((tx) => tx.prepare("SELECT * FROM execution_attempts ORDER BY attempt_id").all()));
        same(before.reports, store.withRead((tx) => tx.prepare("SELECT * FROM execution_reports ORDER BY report_id").all()));
        // E5 §48 — the new tables start EMPTY: no retroactive worker claims,
        // no fabricated session identity for pre-E5 running attempts.
        for (const table of ["execution_worker_invocations", "execution_worker_invocation_events"]) {
          expect((store.withRead((tx) => tx.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()) as { n: number }).n).toBe(0);
        }
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

  it("failing-018 rolls back to a fully valid schema-17 store — no partial invocation objects", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { databasePath, backupsDir } = storePathsFor(root);
      const probe = await initializePlanStore({ pluginDataRoot: root });
      probe.close();
      rewindToSchema17(databasePath);

      const clock = fixedClock();
      const failing: StoreMigration = {
        from: 17,
        to: 18,
        name: "worker-invocation-foundation",
        apply(tx) {
          tx.exec("CREATE TABLE half_created_worker (x TEXT)");
          throw new Error("injected 018 failure");
        },
      };
      const production = createProductionMigrations({ generateStoreId: clock.newId, nowIso: clock.nowIso });
      await expect(
        initializePlanStore({
          pluginDataRoot: root,
          // 018 is the last migration: the truncated chain reaches 18 exactly.
          migrations: [...production.filter((m) => m.to <= 17), failing, ...production.filter((m) => m.to >= 19)],
        }),
      ).rejects.toMatchObject({ code: "STORE_MIGRATION_FAILED", causeText: expect.stringContaining("injected 018 failure") });

      expect(rawSchemaVersion(databasePath)).toBe(17);
      const raw = rawConnection(databasePath, 5000);
      try {
        const names = (raw.prepare("SELECT name FROM sqlite_master").all() as Array<{ name: string }>).map((r) => r.name);
        expect(names).not.toContain("execution_worker_invocations");
        expect(names).not.toContain("execution_worker_invocation_events");
        expect(names).not.toContain("execution_worker_invocations_identity_immutable");
        expect(names).not.toContain("half_created_worker");
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
