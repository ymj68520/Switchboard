/**
 * Migration 18 → 19 — acceptance-foundation (v0.2.0 E6 §55/§56):
 * a real schema-18 store carrying the full E4 world migrates with every old
 * row unchanged, NO fabricated assessments/commits, acceptedHead absent, and
 * every pre-E6 window backfilled to base = execution_start (no commit could
 * exist before schema 19); a failing migration rolls back to a valid v18
 * store; a too-new writer is fenced.
 */
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { SUPPORTED_SCHEMA_VERSION } from "../src/store/constants.js";
import { initializePlanStore, type PlanStore } from "../src/store/sqlite-store.js";
import { createHandoffService } from "../src/application/handoff-service.js";
import { callHandoff, makeApprovedFinalPlanFixture, type ApprovedFinalPlanFixture } from "./phase14-helpers.js";
import { getPlanningRunRecord } from "../src/store/planning-runs.js";
import {
  dropSchema19Objects,
  makeTempPluginDataRoot,
  publishedBackups,
  rawConnection,
  removeTempPluginDataRoot,
  storePathsFor,
} from "./store-helpers.js";
import { createProductionMigrations } from "../src/store/migrations/index.js";
import type { PhasePlanToolContext } from "../src/mcp/tools.js";

function pluginDataRootOf(store: PlanStore): string {
  return path.dirname(path.dirname(store.path));
}

function rewindToSchema18(databasePath: string): void {
  const raw = rawConnection(databasePath, 5000);
  try {
    dropSchema19Objects(raw);
    raw.exec("DELETE FROM schema_migrations WHERE version >= 19");
    raw.exec("PRAGMA user_version = 18");
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

describe("migration 18 → 19 acceptance-foundation (E6 §55/§56)", () => {
  it("migrates the full E4 world: rows unchanged, acceptance tables EMPTY, windows backfilled execution_start, head absent, history [1..19]", async () => {
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
        invocations: w.ctx.store.withRead((tx) => tx.prepare("SELECT * FROM execution_worker_invocations ORDER BY attempt_id").all()),
      };
      w.ctx.store.close();
      rewindToSchema18(databasePath);

      const store = await initializePlanStore({ pluginDataRoot: root });
      try {
        expect(store.getSchemaVersion()).toBe(SUPPORTED_SCHEMA_VERSION);
        // Byte/logical identity of every pre-E6 family (E6 §56) — the new
        // accepted-head/base columns are additive defaults.
        const strip = (rows: unknown[], drop: string[]): Array<Record<string, unknown>> =>
          (rows as Array<Record<string, unknown>>).map((row) => {
            const copy = { ...row };
            for (const column of drop) delete copy[column];
            return copy;
          });
        expect(
          strip(store.withRead((tx) => tx.prepare("SELECT * FROM execution_runs ORDER BY run_id").all()), ["accepted_head_commit_id", "revision", "updated_at"]),
        ).toEqual(strip(before.executionRuns, ["accepted_head_commit_id", "revision", "updated_at"]));
        expect(store.withRead((tx) => tx.prepare("SELECT * FROM verification_windows ORDER BY id").all())).toEqual(
          before.windows,
        );
        expect(store.withRead((tx) => tx.prepare("SELECT * FROM execution_directives ORDER BY directive_id, revision").all())).toEqual(
          before.directives,
        );
        expect(store.withRead((tx) => tx.prepare("SELECT * FROM execution_attempts ORDER BY attempt_id").all())).toEqual(before.attempts);
        expect(store.withRead((tx) => tx.prepare("SELECT * FROM execution_reports ORDER BY report_id").all())).toEqual(before.reports);
        expect(store.withRead((tx) => tx.prepare("SELECT * FROM execution_worker_invocations ORDER BY attempt_id").all())).toEqual(
          before.invocations,
        );
        // E6 §56 — nothing fabricated: acceptance tables empty, no head.
        expect(store.withRead((tx) => tx.prepare("SELECT count(*) AS n FROM supervisor_assessments").get())).toEqual({ n: 0 });
        expect(store.withRead((tx) => tx.prepare("SELECT count(*) AS n FROM supervisor_assessment_report_judgments").get())).toEqual({ n: 0 });
        expect(store.withRead((tx) => tx.prepare("SELECT count(*) AS n FROM execution_commits").get())).toEqual({ n: 0 });
        expect(store.withRead((tx) => tx.prepare("SELECT count(*) AS n FROM execution_acceptance_events").get())).toEqual({ n: 0 });
        expect(store.withRead((tx) => tx.prepare("SELECT count(*) AS n FROM execution_runs WHERE accepted_head_commit_id IS NOT NULL").get())).toEqual({ n: 0 });
        // E6 §30 — every pre-E6 window backfilled to base = execution_start.
        expect(store.withRead((tx) => tx.prepare("SELECT count(*) AS n FROM verification_windows WHERE base_kind != 'execution_start' OR base_commit_id IS NOT NULL").get())).toEqual({ n: 0 });
        // History is complete and includes the new migrations.
        const history = store.withRead((tx) => tx.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all()) as Array<{
          version: number;
          name: string;
        }>;
        expect(history.map((row) => row.version)).toEqual(Array.from({ length: 26 }, (_, i) => i + 1));
        expect(history[18]).toEqual({ version: 19, name: "acceptance-foundation" });
        expect(history[19]).toEqual({ version: 20, name: "stage-completion-provenance" });
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("failing-019 rolls back to a fully valid schema-18 store — no partial acceptance objects", async () => {
    const root = makeTempPluginDataRoot("E6-MIG-FAIL");
    try {
      const { databasePath } = storePathsFor(root);
      const probe = await initializePlanStore({ pluginDataRoot: root });
      probe.close();
      rewindToSchema18(databasePath);

      const { fixedClock } = await import("./store-helpers.js");
      const clock = fixedClock();
      const failing = {
        from: 18,
        to: 19,
        name: "acceptance-foundation",
        apply(tx: { exec: (sql: string) => void }) {
          tx.exec("CREATE TABLE half_created_acceptance (x TEXT)");
          throw new Error("injected 019 failure");
        },
      };
      const production = createProductionMigrations({ generateStoreId: clock.newId, nowIso: clock.nowIso });
      await expect(
        initializePlanStore({
          pluginDataRoot: root,
          // The chain still reaches the supported schema around the injected
          // 18→19 failure (later steps follow it).
          migrations: [...production.filter((m) => m.to <= 18), failing, ...production.filter((m) => m.to >= 20)],
        }),
      ).rejects.toMatchObject({ code: "STORE_MIGRATION_FAILED", causeText: expect.stringContaining("injected 019 failure") });

      expect(rawSchemaVersion(databasePath)).toBe(18);
      const raw = rawConnection(databasePath, 5000);
      try {
        const names = (raw.prepare("SELECT name FROM sqlite_master").all() as Array<{ name: string }>).map((r) => r.name);
        expect(names).not.toContain("supervisor_assessments");
        expect(names).not.toContain("execution_commits");
        expect(names).not.toContain("execution_acceptance_events");
        expect(names).not.toContain("half_created_acceptance");
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
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("the pre-migration backup is named for the rewind transition (18 → supported)", async () => {
    const root = makeTempPluginDataRoot("E6-MIG-BACKUP");
    try {
      const store = await initializePlanStore({ pluginDataRoot: root });
      store.close();
      rewindToSchema18(storePathsFor(root).databasePath);
      const reopened = await initializePlanStore({ pluginDataRoot: root });
      reopened.close();
      const backups = publishedBackups(storePathsFor(root).backupsDir).map((p) => path.basename(p));
      expect(backups.some((name) => name.includes("pre-schema-18-"))).toBe(true);
    } finally {
      removeTempPluginDataRoot(root);
    }
  });
});
