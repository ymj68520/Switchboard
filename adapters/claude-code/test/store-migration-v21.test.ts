/**
 * Migration 20 → 21 — verification-policy-conflict-foundation (v0.2.0 E8 §45/§46):
 * a real schema-20 store migrates with every directive_hash byte-identical and
 * every policy column NULL (no backfilled batchable/immediate/normal onto
 * history, E8 §46), no fabricated conflicts, all accepted state untouched; the
 * v21 triggers enforce the conflict lifecycle; a failing migration rolls back;
 * the pre-migration backup is named for the transition.
 */
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { SUPPORTED_SCHEMA_VERSION } from "../src/store/constants.js";
import { initializePlanStore } from "../src/store/sqlite-store.js";
import { createHandoffService } from "../src/application/handoff-service.js";
import { callHandoff, makeApprovedFinalPlanFixture, type ApprovedFinalPlanFixture } from "./phase14-helpers.js";
import { getPlanningRunRecord } from "../src/store/planning-runs.js";
import {
  dropSchema21Objects,
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

function rewindToSchema20(databasePath: string): void {
  const raw = rawConnection(databasePath, 5000);
  try {
    dropSchema21Objects(raw);
    raw.exec("DELETE FROM schema_migrations WHERE version >= 21");
    raw.exec("PRAGMA user_version = 20");
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

async function makeE7World(sessionId = "S1"): Promise<{ f: ApprovedFinalPlanFixture; ctx: PhasePlanToolContext; executionRunId: string }> {
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

describe("migration 20 → 21 verification-policy-conflict-foundation (E8 §45/§46)", () => {
  it("migrates a real world: directive hashes byte-identical, policy NULL, no conflicts, history [1..21]", async () => {
    const w = await makeE7World();
    const root = pluginDataRootOf(w.ctx.store);
    try {
      const databasePath = storePathsFor(root).databasePath;
      const beforeDirectives = w.ctx.store.withRead(
        (tx) => tx.prepare("SELECT directive_id AS id, revision, directive_hash AS hash, kind FROM execution_directives ORDER BY directive_id, revision").all(),
      );
      w.ctx.store.close();
      rewindToSchema20(databasePath);

      const store = await initializePlanStore({ pluginDataRoot: root });
      try {
        expect(store.getSchemaVersion()).toBe(SUPPORTED_SCHEMA_VERSION);
        // E8 §46 — directive hashes are unchanged; every migrated row is v1
        // with NULL policy (never backfilled).
        const afterDirectives = store.withRead(
          (tx) =>
            tx.prepare("SELECT directive_id AS id, revision, directive_hash AS hash, kind, protocol_version AS protocolVersion, verification_requirement AS requirement FROM execution_directives ORDER BY directive_id, revision").all() as Array<{
              id: string;
              revision: number;
              hash: string;
              kind: string;
              protocolVersion: number;
              requirement: string | null;
            }>,
        );
        expect(afterDirectives.map(({ id, revision, hash, kind }) => ({ id, revision, hash, kind }))).toEqual(
          beforeDirectives,
        );
        expect(afterDirectives.every((row) => row.protocolVersion === 1 && row.requirement === null)).toBe(true);
        // No conflict is fabricated; accepted state is untouched.
        expect(store.withRead((tx) => tx.prepare("SELECT count(*) AS n FROM verification_conflicts").get())).toEqual({ n: 0 });
        const history = store.withRead((tx) => tx.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all()) as Array<{
          version: number;
          name: string;
        }>;
        expect(history.map((row) => row.version)).toEqual(Array.from({ length: 26 }, (_, i) => i + 1));
        expect(history[20]).toEqual({ version: 21, name: "verification-policy-conflict-foundation" });
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("the v21 triggers enforce conflict immutability, lifecycle legality, and settlement provenance", async () => {
    const w = await makeE7World();
    const root = pluginDataRootOf(w.ctx.store);
    try {
      const insert = (sql: string, ...args: unknown[]): string => {
        try {
          w.ctx.store.withWrite((tx) => tx.prepare(sql).run(...args));
          return "no-error";
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }
      };
      const windowId = w.ctx.store.withRead(
        (tx) =>
          (tx.prepare("SELECT id FROM verification_windows WHERE execution_run_id = ? AND closed_at IS NULL").get(w.executionRunId) as { id: string }).id,
      );
      const base =
        "INSERT INTO verification_conflicts (conflict_id, execution_run_id, window_id, candidate_revision, fact, claims_json, status, "
        + "resolution_directive_id, resolution_directive_revision, resolution_report_id, fingerprint, rationale, created_at, resolved_at) ";
      // Illegal lifecycle shape: open with a resolver → CHECK refuses.
      expect(
        insert(
          base + "VALUES ('vc_bad', ?, ?, 0, 'f', '[{\"variant\":\"A\",\"statement\":\"a\",\"sourceReportIds\":[\"r1\"]},{\"variant\":\"B\",\"statement\":\"b\",\"sourceReportIds\":[\"r2\"]}]', 'open', 'dir_x', 1, NULL, 'fp_bad_1', NULL, 'now', NULL)",
          w.executionRunId,
          windowId,
        ),
      ).toContain("CHECK");
      // Legal open row.
      expect(
        insert(
          base + "VALUES ('vc_ok', ?, ?, 0, 'f', '[{\"variant\":\"A\",\"statement\":\"a\",\"sourceReportIds\":[\"r1\"]},{\"variant\":\"B\",\"statement\":\"b\",\"sourceReportIds\":[\"r2\"]}]', 'open', NULL, NULL, NULL, 'fp_ok_1', NULL, 'now', NULL)",
          w.executionRunId,
          windowId,
        ),
      ).toBe("no-error");
      // The binding is immutable.
      expect(insert("UPDATE verification_conflicts SET fact = 'rewritten' WHERE conflict_id = 'vc_ok'")).toContain(
        "verification conflict binding is immutable",
      );
      // open → resolved directly is an illegal transition (E8 §30/§31 — a
      // conflict must pass through resolving on its ONE dedicated Directive).
      expect(
        insert(
          "UPDATE verification_conflicts SET status = 'resolved', resolution_directive_id = 'dir_x', resolution_directive_revision = 1, "
          + "resolution_report_id = NULL, rationale = 'r', resolved_at = 'now' WHERE conflict_id = 'vc_ok'",
        ),
      ).toContain("illegal verification conflict status transition");
      // Deleting a conflict is impossible.
      expect(insert("DELETE FROM verification_conflicts WHERE conflict_id = 'vc_ok'")).toContain(
        "verification_conflicts is immutable",
      );
    } finally {
      w.ctx.store.close();
      removeTempPluginDataRoot(root);
    }
  });

  it("failing-021 rolls back to a valid schema-20 store", async () => {
    const root = makeTempPluginDataRoot("E8-MIG-FAIL");
    try {
      const { databasePath } = storePathsFor(root);
      const probe = await initializePlanStore({ pluginDataRoot: root });
      probe.close();
      rewindToSchema20(databasePath);

      const { fixedClock } = await import("./store-helpers.js");
      const clock = fixedClock();
      const failing = {
        from: 20,
        to: 21,
        name: "verification-policy-conflict-foundation",
        apply(tx: { exec: (sql: string) => void }) {
          tx.exec("CREATE TABLE half_created_v21 (x TEXT)");
          throw new Error("injected 021 failure");
        },
      };
      const production = createProductionMigrations({ generateStoreId: clock.newId, nowIso: clock.nowIso });
      await expect(
        initializePlanStore({
          pluginDataRoot: root,
          migrations: [...production.filter((m) => m.to <= 20), failing, ...production.filter((m) => m.to >= 22)],
        }),
      ).rejects.toMatchObject({ code: "STORE_MIGRATION_FAILED", causeText: expect.stringContaining("injected 021 failure") });
      expect(rawSchemaVersion(databasePath)).toBe(20);
      const raw = rawConnection(databasePath, 5000);
      try {
        const names = (raw.prepare("SELECT name FROM sqlite_master").all() as Array<{ name: string }>).map((r) => r.name);
        expect(names).not.toContain("verification_conflicts");
        expect(names).not.toContain("half_created_v21");
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

  it("the pre-migration backup is named for the 20 → 21 transition", async () => {
    const root = makeTempPluginDataRoot("E8-MIG-BACKUP");
    try {
      const store = await initializePlanStore({ pluginDataRoot: root });
      store.close();
      rewindToSchema20(storePathsFor(root).databasePath);
      const reopened = await initializePlanStore({ pluginDataRoot: root });
      reopened.close();
      const backups = publishedBackups(storePathsFor(root).backupsDir).map((p) => path.basename(p));
      expect(backups.some((name) => name.includes("pre-schema-20-"))).toBe(true);
    } finally {
      removeTempPluginDataRoot(root);
    }
  });
});
