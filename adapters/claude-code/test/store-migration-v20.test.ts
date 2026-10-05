/**
 * Migration 19 → 20 — stage-completion-provenance (v0.2.0 E7 §42/§43):
 * a real schema-19 store carrying the full E6 acceptance world migrates with
 * every old row unchanged and completed_by_commit_id NULL for every Stage (no
 * pre-E7 path could complete a Stage — no provenance is fabricated); the v20
 * triggers enforce the completed↔provenance coupling and terminality; a
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
  dropSchema20Objects,
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

function rewindToSchema19(databasePath: string): void {
  const raw = rawConnection(databasePath, 5000);
  try {
    dropSchema20Objects(raw);
    raw.exec("DELETE FROM schema_migrations WHERE version >= 20");
    raw.exec("PRAGMA user_version = 19");
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

async function makeE6World(sessionId = "S1"): Promise<{ f: ApprovedFinalPlanFixture; ctx: PhasePlanToolContext; executionRunId: string }> {
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

describe("migration 19 → 20 stage-completion-provenance (E7 §42/§43)", () => {
  it("migrates the full E6 world: rows unchanged, provenance NULL everywhere, history [1..20]", async () => {
    const w = await makeE6World();
    const root = pluginDataRootOf(w.ctx.store);
    try {
      const databasePath = storePathsFor(root).databasePath;
      const before = {
        stages: w.ctx.store.withRead((tx) => tx.prepare("SELECT * FROM execution_stages ORDER BY execution_run_id, ordinal").all()),
        commits: w.ctx.store.withRead((tx) => tx.prepare("SELECT count(*) AS n FROM execution_commits").get()),
        head: w.ctx.store.withRead((tx) => tx.prepare("SELECT count(*) AS n FROM execution_runs WHERE accepted_head_commit_id IS NOT NULL").get()),
        windows: w.ctx.store.withRead((tx) => tx.prepare("SELECT * FROM verification_windows ORDER BY id").all()),
      };
      w.ctx.store.close();
      rewindToSchema19(databasePath);

      const store = await initializePlanStore({ pluginDataRoot: root });
      try {
        expect(store.getSchemaVersion()).toBe(SUPPORTED_SCHEMA_VERSION);
        // E7 §43 — Stage rows keep every pre-E7 column byte-identical; the new
        // column is NULL for all of them (no fabricated completion provenance).
        const strip = (rows: unknown[]): Array<Record<string, unknown>> =>
          (rows as Array<Record<string, unknown>>).map((row) => {
            const copy = { ...row };
            delete copy.completed_by_commit_id;
            return copy;
          });
        expect(strip(store.withRead((tx) => tx.prepare("SELECT * FROM execution_stages ORDER BY execution_run_id, ordinal").all()))).toEqual(
          strip(before.stages),
        );
        expect(
          store.withRead((tx) => tx.prepare("SELECT count(*) AS n FROM execution_stages WHERE completed_by_commit_id IS NOT NULL").get()),
        ).toEqual({ n: 0 });
        // Accepted state is untouched.
        expect(store.withRead((tx) => tx.prepare("SELECT count(*) AS n FROM execution_commits").get())).toEqual(before.commits);
        expect(
          store.withRead((tx) => tx.prepare("SELECT count(*) AS n FROM execution_runs WHERE accepted_head_commit_id IS NOT NULL").get()),
        ).toEqual(before.head);
        expect(store.withRead((tx) => tx.prepare("SELECT * FROM verification_windows ORDER BY id").all())).toEqual(before.windows);
        const history = store.withRead((tx) => tx.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all()) as Array<{
          version: number;
          name: string;
        }>;
        expect(history.map((row) => row.version)).toEqual(Array.from({ length: 26 }, (_, i) => i + 1));
        expect(history[19]).toEqual({ version: 20, name: "stage-completion-provenance" });
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("the v20 triggers enforce the completed↔provenance coupling, creation shape, and terminality", async () => {
    const w = await makeE6World();
    const root = pluginDataRootOf(w.ctx.store);
    try {
      const stageId = w.ctx.store.withRead(
        (tx) =>
          (tx.prepare("SELECT id FROM execution_stages WHERE execution_run_id = ? AND status = 'active'").get(w.executionRunId) as { id: string }).id,
      );
      // INSERT: a Stage can never be created completed or with provenance.
      expect(
        (() => {
          try {
            w.ctx.store.withWrite((tx) => {
              tx.prepare(
                "INSERT INTO execution_stages (id, execution_run_id, ordinal, status, objective, source_step_id, depends_on_json, "
                + "source_refs_json, completed_by_commit_id, revision, created_at, updated_at) "
                + "VALUES ('stage_bad', ?, 99, 'pending', 'x', NULL, '[]', '[]', 'ec_x', 1, 'now', 'now')",
              ).run(w.executionRunId);
            });
            return "no-error";
          } catch (err) {
            return err instanceof Error ? err.message : String(err);
          }
        })(),
      ).toContain("cannot be created completed");
      // UPDATE: provenance requires the completed status…
      expect(
        (() => {
          try {
            w.ctx.store.withWrite((tx) => {
              tx.prepare("UPDATE execution_stages SET completed_by_commit_id = 'ec_x' WHERE id = ?").run(stageId);
            });
            return "no-error";
          } catch (err) {
            return err instanceof Error ? err.message : String(err);
          }
        })(),
      ).toContain("completion provenance requires the completed status");
      // …a completed status requires provenance…
      expect(
        (() => {
          try {
            w.ctx.store.withWrite((tx) => {
              tx.prepare("UPDATE execution_stages SET status = 'completed' WHERE id = ?").run(stageId);
            });
            return "no-error";
          } catch (err) {
            return err instanceof Error ? err.message : String(err);
          }
        })(),
      ).toContain("requires its completion commit provenance");
      // …completed is terminal…
      w.ctx.store.withWrite((tx) => {
        // Complete it honestly through the coupled update (provenance FK needs
        // a commit row; fabricate the minimal legal one for the trigger probe).
        tx.prepare(
          "INSERT INTO supervisor_assessments (assessment_id, execution_run_id, stage_id, window_id, candidate_revision, "
          + "disposition, supervisor_session_id, supervisor_generation, plan_refs_json, covered_obligations_json, "
          + "rationale, created_at) VALUES ('sa_p20', ?, ?, (SELECT id FROM verification_windows WHERE execution_run_id = ? AND closed_at IS NULL), 0, "
          + "'rework', 'S-P20', 1, '[]', '[]', 'probe', 'now')",
        ).run(w.executionRunId, stageId, w.executionRunId);
        tx.prepare(
          "INSERT INTO execution_commits (commit_id, execution_run_id, sequence, parent_commit_id, stage_id, window_id, "
          + "candidate_revision, supervisor_assessment_id, directive_refs_json, report_refs_json, "
          + "satisfied_obligations_json, created_at) VALUES ('ec_p20', ?, 1, NULL, ?, "
          + "(SELECT id FROM verification_windows WHERE execution_run_id = ? AND closed_at IS NULL), 0, 'sa_p20', '[]', '[]', '[]', 'now')",
        ).run(w.executionRunId, stageId, w.executionRunId);
        tx.prepare(
          "UPDATE execution_stages SET status = 'completed', completed_by_commit_id = 'ec_p20' WHERE id = ?",
        ).run(stageId);
      });
      expect(
        (() => {
          try {
            w.ctx.store.withWrite((tx) => {
              tx.prepare("UPDATE execution_stages SET status = 'active' WHERE id = ?").run(stageId);
            });
            return "no-error";
          } catch (err) {
            return err instanceof Error ? err.message : String(err);
          }
        })(),
      ).toContain("completed stage is terminal");
      // …and provenance never changes once set.
      expect(
        (() => {
          try {
            w.ctx.store.withWrite((tx) => {
              tx.prepare("UPDATE execution_stages SET completed_by_commit_id = 'ec_other' WHERE id = ?").run(stageId);
            });
            return "no-error";
          } catch (err) {
            return err instanceof Error ? err.message : String(err);
          }
        })(),
      ).toContain("completion provenance is immutable once set");
    } finally {
      w.ctx.store.close();
      removeTempPluginDataRoot(root);
    }
  });

  it("failing-020 rolls back to a valid schema-19 store", async () => {
    const root = makeTempPluginDataRoot("E7-MIG-FAIL");
    try {
      const { databasePath } = storePathsFor(root);
      const probe = await initializePlanStore({ pluginDataRoot: root });
      probe.close();
      rewindToSchema19(databasePath);

      const { fixedClock } = await import("./store-helpers.js");
      const clock = fixedClock();
      const failing = {
        from: 19,
        to: 20,
        name: "stage-completion-provenance",
        apply(tx: { exec: (sql: string) => void }) {
          tx.exec("CREATE TABLE half_created_completion (x TEXT)");
          throw new Error("injected 020 failure");
        },
      };
      const production = createProductionMigrations({ generateStoreId: clock.newId, nowIso: clock.nowIso });
      await expect(
        initializePlanStore({
          pluginDataRoot: root,
          migrations: [...production.filter((m) => m.to <= 19), failing, ...production.filter((m) => m.to >= 21)],
        }),
      ).rejects.toMatchObject({ code: "STORE_MIGRATION_FAILED", causeText: expect.stringContaining("injected 020 failure") });
      expect(rawSchemaVersion(databasePath)).toBe(19);
      const raw = rawConnection(databasePath, 5000);
      try {
        const names = (raw.prepare("SELECT name FROM sqlite_master").all() as Array<{ name: string }>).map((r) => r.name);
        expect(names).not.toContain("execution_stages_completion_consistent");
        expect(names).not.toContain("half_created_completion");
        const columns = raw.prepare("PRAGMA table_info('execution_stages')").all() as Array<{ name: string }>;
        expect(columns.some((column) => column.name === "completed_by_commit_id")).toBe(false);
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

  it("the pre-migration backup is named for the rewind transition (19 → supported)", async () => {
    const root = makeTempPluginDataRoot("E7-MIG-BACKUP");
    try {
      const store = await initializePlanStore({ pluginDataRoot: root });
      store.close();
      rewindToSchema19(storePathsFor(root).databasePath);
      const reopened = await initializePlanStore({ pluginDataRoot: root });
      reopened.close();
      const backups = publishedBackups(storePathsFor(root).backupsDir).map((p) => path.basename(p));
      // The runner names the backup for the whole chain jump (from → supported),
      // which now extends past 20.
      expect(backups.some((name) => name.includes("pre-schema-19-"))).toBe(true);
    } finally {
      removeTempPluginDataRoot(root);
    }
  });
});
