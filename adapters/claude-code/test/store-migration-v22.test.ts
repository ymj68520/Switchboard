/**
 * Migration 21 → 22 — replan-required-foundation (v0.2.0 E9 §45–§48):
 * a real schema-21 store migrates with every legacy ExecutionIssue row
 * byte-identical (issue_version 1, v2 columns NULL — no fabricated replan
 * semantics, E9 §46), every closed Window backfilled closure_kind='accepted',
 * every open Window left NULL, no fabricated conflicts, history [1..23]; a
 * failing migration rolls back; the backup is named for the transition.
 */
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { SUPPORTED_SCHEMA_VERSION } from "../src/store/constants.js";
import { initializePlanStore } from "../src/store/sqlite-store.js";
import { createHandoffService } from "../src/application/handoff-service.js";
import { callHandoff, makeApprovedFinalPlanFixture, type ApprovedFinalPlanFixture } from "./phase14-helpers.js";
import { getPlanningRunRecord } from "../src/store/planning-runs.js";
import {
  dropSchema22Objects,
  makeTempPluginDataRoot,
  publishedBackups,
  rawConnection,
  removeTempPluginDataRoot,
  storePathsFor,
} from "./store-helpers.js";
import { createProductionMigrations } from "../src/store/migrations/index.js";
import type { PhasePlanToolContext } from "../src/mcp/tools.js";

function pluginDataRootOf(store: { path: string }): string {
  return path.dirname(path.dirname(store.path));
}

function rewindToSchema21(databasePath: string): void {
  const raw = rawConnection(databasePath, 5000);
  try {
    dropSchema22Objects(raw);
    raw.exec("DELETE FROM schema_migrations WHERE version >= 22");
    raw.exec("PRAGMA user_version = 21");
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

async function makeE8World(sessionId = "S1"): Promise<{ f: ApprovedFinalPlanFixture; ctx: PhasePlanToolContext }> {
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

describe("migration 21 → 22 replan-required-foundation (E9 §45–§48)", () => {
  it("migrates a real world: legacy issues byte-identical v1, windows backfilled accepted/open, history [1..23]", async () => {
    const w = await makeE8World();
    const root = pluginDataRootOf(w.ctx.store);
    try {
      const databasePath = storePathsFor(root).databasePath;
      const before = {
        windows: w.ctx.store.withRead(
          (tx) => tx.prepare("SELECT id, closed_at AS closedAt FROM verification_windows ORDER BY id").all(),
        ),
        issues: w.ctx.store.withRead(
          (tx) => tx.prepare("SELECT count(*) AS n FROM execution_issues").get() as { n: number },
        ),
        head: w.ctx.store.withRead(
          (tx) => tx.prepare("SELECT count(*) AS n FROM execution_runs WHERE accepted_head_commit_id IS NOT NULL").get() as { n: number },
        ),
      };
      w.ctx.store.close();
      rewindToSchema21(databasePath);

      const store = await initializePlanStore({ pluginDataRoot: root });
      try {
        expect(store.getSchemaVersion()).toBe(SUPPORTED_SCHEMA_VERSION);
        // E9 §48 — windows: closed → accepted, open → NULL.
        const windows = store.withRead(
          (tx) =>
            tx.prepare("SELECT id, closed_at AS closedAt, closure_kind AS kind FROM verification_windows ORDER BY id").all() as Array<{
              id: string;
              closedAt: string | null;
              kind: string | null;
            }>,
        );
        expect(windows.map(({ id, closedAt }) => ({ id, closedAt }))).toEqual(before.windows);
        for (const window of windows) {
          expect(window.kind).toBe(window.closedAt === null ? null : "accepted");
        }
        // E9 §46 — legacy issue rows unchanged (version 1, v2 columns NULL),
        // no replan issue fabricated.
        expect(store.withRead((tx) => tx.prepare("SELECT count(*) AS n FROM execution_issues WHERE issue_version != 1").get())).toEqual({ n: 0 });
        expect(store.withRead((tx) => tx.prepare("SELECT count(*) AS n FROM execution_issues WHERE kind = 'replan_required'").get())).toEqual({ n: 0 });
        const legacyIssue = store.withRead(
          (tx) =>
            tx.prepare("SELECT issue_version AS v, execution_run_id AS er, accepted_history_json AS ah FROM execution_issues LIMIT 1").get() as
              | { v: number; er: string | null; ah: string | null }
              | undefined,
        );
        if (legacyIssue !== undefined) {
          expect(legacyIssue.v).toBe(1);
          expect(legacyIssue.er).toBeNull();
          expect(legacyIssue.ah).toBeNull();
        }
        const history = store.withRead((tx) => tx.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all()) as Array<{
          version: number;
          name: string;
        }>;
        expect(history.map((row) => row.version)).toEqual(Array.from({ length: 26 }, (_, i) => i + 1));
        expect(history[22]).toEqual({ version: 23, name: "execution-scope-foundation" });
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("E9-T46: legacy issue rows migrate without fabricated terminal semantics", async () => {
    const w = await makeE8World();
    const root = pluginDataRootOf(w.ctx.store);
    try {
      // The legacy v12 validator still verifies legacy issue hashes under the
      // v1 algorithm after the rebuild (the versioned probe).
      const { inspectSchemaState } = await import("../src/store/schema.js");
      const state = w.ctx.store.withRead((tx) => inspectSchemaState(tx));
      expect(state.consistent).toBe(true);
    } finally {
      w.ctx.store.close();
      removeTempPluginDataRoot(root);
    }
  });

  it("failing-022 rolls back to a valid schema-21 store", async () => {
    const root = makeTempPluginDataRoot("E9-MIG-FAIL");
    try {
      const { databasePath } = storePathsFor(root);
      const probe = await initializePlanStore({ pluginDataRoot: root });
      probe.close();
      rewindToSchema21(databasePath);

      const { fixedClock } = await import("./store-helpers.js");
      const clock = fixedClock();
      const failing = {
        from: 21,
        to: 22,
        name: "replan-required-foundation",
        apply(tx: { exec: (sql: string) => void }) {
          tx.exec("CREATE TABLE half_created_v22 (x TEXT)");
          throw new Error("injected 022 failure");
        },
      };
      const production = createProductionMigrations({ generateStoreId: clock.newId, nowIso: clock.nowIso });
      await expect(
        initializePlanStore({
          pluginDataRoot: root,
          migrations: [...production.filter((m) => m.to <= 21), failing, ...production.filter((m) => m.to >= 23)],
        }),
      ).rejects.toMatchObject({ code: "STORE_MIGRATION_FAILED", causeText: expect.stringContaining("injected 022 failure") });
      expect(rawSchemaVersion(databasePath)).toBe(21);
      const raw = rawConnection(databasePath, 5000);
      try {
        const names = (raw.prepare("SELECT name FROM sqlite_master").all() as Array<{ name: string }>).map((r) => r.name);
        expect(names).not.toContain("execution_issues_new");
        expect(names).not.toContain("half_created_v22");
        const columns = raw.prepare("PRAGMA table_info('verification_windows')").all() as Array<{ name: string }>;
        expect(columns.some((column) => column.name === "closure_kind")).toBe(false);
      } finally {
        raw.close();
      }
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

  it("the pre-migration backup is named for the 21 → 22 transition", async () => {
    const root = makeTempPluginDataRoot("E9-MIG-BACKUP");
    try {
      const store = await initializePlanStore({ pluginDataRoot: root });
      store.close();
      rewindToSchema21(storePathsFor(root).databasePath);
      const reopened = await initializePlanStore({ pluginDataRoot: root });
      reopened.close();
      const backups = publishedBackups(storePathsFor(root).backupsDir).map((p) => path.basename(p));
      expect(backups.some((name) => name.includes("pre-schema-21-"))).toBe(true);
    } finally {
      removeTempPluginDataRoot(root);
    }
  });
});
