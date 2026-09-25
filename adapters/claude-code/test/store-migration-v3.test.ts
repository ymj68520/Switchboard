import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { openDatabase } from "../src/store/connection.js";
import { SUPPORTED_SCHEMA_VERSION } from "../src/store/constants.js";
import { createInitializeMigration } from "../src/store/migrations/001-initialize.js";
import { createWorkspaceBindingMigration } from "../src/store/migrations/002-workspace-session-binding.js";
import type { StoreMigration } from "../src/store/migrations/index.js";
import { runWrite } from "../src/store/transaction.js";
import { initializePlanStore, inspectPlanStore } from "../src/store/sqlite-store.js";
import { discoverAndRegisterWorkspace } from "../src/workspace/identity.js";
import { createPlanningRunService } from "../src/application/planning-run-service.js";
import { fixedClock, makeTempPluginDataRoot, publishedBackups, rawConnection, removeTempPluginDataRoot, storePathsFor } from "./store-helpers.js";

/**
 * Build a GENUINE schema-2 store: initialize at v3, then surgically remove
 * the v3 table/history row and set user_version back to 2. What remains is
 * exactly what Phase 3 produced (repositories/workspaces/bindings + history
 * rows 1..2).
 */
function makeSchema2Store(root: string): void {
  const { databasePath } = storePathsFor(root);
  const raw = rawConnection(databasePath, 5000);
  try {
    raw.exec("DROP TABLE planning_runs");
    raw.exec("DELETE FROM schema_migrations WHERE version = 3");
    raw.exec("PRAGMA user_version = 2");
    // Sentinel data from the schema-2 era must survive the migration.
    raw.exec("CREATE TABLE phase3_sentinel (note TEXT NOT NULL)");
    raw.prepare("INSERT INTO phase3_sentinel (note) VALUES (?)").run("pre-v3-sentinel");
  } finally {
    raw.close();
  }
}

describe("migration 2 → 3 planning-run-foundation (E1/E2/E31/§42)", () => {
  it("migrates a real schema-2 store: Phase 3 data preserved, planning_runs empty, history [1,2,3]", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { backupsDir } = ensureStore(root);
      // Build genuine Phase 3 state: workspace catalog + a binding.
      const store3 = await initializePlanStore({ pluginDataRoot: root });
      let workspaceId: string;
      try {
        const dir = path.join(root, "project");
        fs.mkdirSync(dir, { recursive: true });
        const { registration } = await discoverAndRegisterWorkspace(store3, dir, fixedClock({ ids: ["r", "w"] }));
        workspaceId = registration.workspace.workspaceId;
        store3.withWrite((tx) => {
          tx.prepare(
            "INSERT INTO session_bindings (run_id, workspace_id, session_id, state, generation, created_at, updated_at) VALUES (?, ?, ?, 'attached', 1, '2026-01-01', '2026-01-01')",
          ).run("LEGACY-OPAQUE-RUN", workspaceId, "LEGACY-SESSION");
        });
      } finally {
        store3.close();
      }
      makeSchema2Store(root);

      const inspection2 = inspectPlanStore(root);
      expect(inspection2.status).toBe("too_old");
      expect(inspection2.schemaVersion).toBe(2);

      const store = await initializePlanStore({ pluginDataRoot: root });
      try {
        expect(store.getSchemaVersion()).toBe(SUPPORTED_SCHEMA_VERSION);
        const history = store.withRead((tx) =>
          tx.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all(),
        ) as { version: number; name: string }[];
        expect(history).toEqual([
          { version: 1, name: "initialize-plan-store" },
          { version: 2, name: "workspace-and-session-binding" },
          { version: 3, name: "planning-run-foundation" },
        ]);
        const runs = store.withRead((tx) => tx.prepare("SELECT count(*) AS n FROM planning_runs").get()) as { n: number };
        expect(runs.n).toBe(0);
        const sentinel = store.withRead((tx) => tx.prepare("SELECT note FROM phase3_sentinel").all()) as { note: string }[];
        expect(sentinel[0]?.note).toBe("pre-v3-sentinel");
        // Legacy opaque binding preserved untouched — never fabricated into a run.
        const legacy = store.withRead((tx) =>
          tx.prepare("SELECT run_id, session_id, state FROM session_bindings WHERE run_id = 'LEGACY-OPAQUE-RUN'").get(),
        ) as { run_id: string; session_id: string; state: string } | undefined;
        expect(legacy).toMatchObject({ run_id: "LEGACY-OPAQUE-RUN", session_id: "LEGACY-SESSION", state: "attached" });
      } finally {
        store.close();
      }

      const backups = publishedBackups(backupsDir);
      expect(backups).toHaveLength(1);
      expect(backups[0]).toMatch(/^phase-plan-pre-schema-2-3-\d{8}T\d{6}(\.\d+)?Z?-[0-9a-f-]{8,}\.sqlite3$/);
      const backupDb = openDatabase(path.join(backupsDir, backups[0]!), { readonly: true });
      try {
        const row = backupDb.prepare("PRAGMA user_version").get() as Record<string, unknown>;
        expect(Object.values(row)[0]).toBe(2);
        const legacy = backupDb
          .prepare("SELECT count(*) AS n FROM session_bindings WHERE run_id = 'LEGACY-OPAQUE-RUN'")
          .get() as { n: number };
        expect(legacy.n).toBe(1);
      } finally {
        backupDb.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("rolls back a failing v3 migration to a fully valid schema-2 store (E30/§43)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      ensureStore(root);
      const first = await initializePlanStore({ pluginDataRoot: root });
      first.close();
      makeSchema2Store(root);

      const failing: StoreMigration = {
        from: 2,
        to: 3,
        name: "deliberately-failing-v3",
        apply(tx) {
          tx.exec("CREATE TABLE planning_runs (run_id TEXT PRIMARY KEY)");
          tx.exec("CREATE TABLE half_v3 (x TEXT)");
          throw new Error("injected v3 failure");
        },
      };

      await expect(
        initializePlanStore({
          pluginDataRoot: root,
          migrations: [
            createInitializeMigration({ generateStoreId: fixedClock().newId, nowIso: fixedClock().nowIso }),
            createWorkspaceBindingMigration(),
            failing,
          ],
        }),
      ).rejects.toMatchObject({ code: "STORE_MIGRATION_FAILED" });

      const raw = rawConnection(storePathsFor(root).databasePath, 500);
      try {
        const versionRow = raw.prepare("PRAGMA user_version").get() as Record<string, unknown>;
        expect(Object.values(versionRow)[0]).toBe(2);
        const tables = (
          raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]
        ).map((t) => t.name);
        expect(tables).toContain("phase3_sentinel");
        expect(tables).not.toContain("planning_runs");
        expect(tables).not.toContain("half_v3");
        const history = (
          raw.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as { version: number }[]
        ).map((h) => h.version);
        expect(history).toEqual([1, 2]);
      } finally {
        raw.close();
      }
      // And the store still migrates cleanly afterwards.
      const retry = await initializePlanStore({ pluginDataRoot: root });
      expect(retry.getSchemaVersion()).toBe(3);
      retry.close();
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("fences a real schema-2 writer after the Phase 4 migration (E32/§44)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      ensureStore(root);
      const first = await initializePlanStore({ pluginDataRoot: root });
      first.close();
      makeSchema2Store(root);
      const store = await initializePlanStore({ pluginDataRoot: root });
      store.close();

      const oldWriterDb = openDatabase(storePathsFor(root).databasePath, { busyTimeoutMs: 500 });
      try {
        expect(() =>
          runWrite(
            oldWriterDb,
            (tx) => {
              tx.exec("CREATE TABLE smuggled_by_schema2_process (x TEXT)");
              return undefined;
            },
            { supportedSchemaVersion: 2, databasePath: storePathsFor(root).databasePath },
          ),
        ).toThrowError(expect.objectContaining({ code: "STORE_SCHEMA_TOO_NEW" }));
        const probe = openDatabase(storePathsFor(root).databasePath, { readonly: true });
        try {
          const names = (
            probe.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
          ).map((t) => t.name);
          expect(names).not.toContain("smuggled_by_schema2_process");
        } finally {
          probe.close();
        }
      } finally {
        oldWriterDb.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("legacy opaque binding sessions still block creation after migration (fail-closed, §41)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const store3 = await initializePlanStore({ pluginDataRoot: root });
      let workspaceId: string;
      try {
        const dir = path.join(root, "project");
        fs.mkdirSync(dir, { recursive: true });
        const { registration } = await discoverAndRegisterWorkspace(store3, dir, fixedClock({ ids: ["r", "w"] }));
        workspaceId = registration.workspace.workspaceId;
        store3.withWrite((tx) => {
          tx.prepare(
            "INSERT INTO session_bindings (run_id, workspace_id, session_id, state, generation, created_at, updated_at) VALUES (?, ?, ?, 'attached', 1, '2026-01-01', '2026-01-01')",
          ).run("LEGACY-OPAQUE-RUN", workspaceId, "LEGACY-SESSION");
        });
      } finally {
        store3.close();
      }
      makeSchema2Store(root);
      const store = await initializePlanStore({ pluginDataRoot: root });
      try {
        const runs = createPlanningRunService(store, fixedClock({ ids: ["x"] }));
        expect(() =>
          runs.createPlanningRun({ workspaceId, sessionId: "LEGACY-SESSION", goal: "blocked" }),
        ).toThrowError(expect.objectContaining({ code: "SESSION_ALREADY_BOUND" }));
        expect(runs.getPlanningRun("LEGACY-OPAQUE-RUN")).toBeNull();
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });
});

function ensureStore(root: string): { databasePath: string; backupsDir: string } {
  const paths = storePathsFor(root);
  fs.mkdirSync(paths.storeDir, { recursive: true });
  fs.mkdirSync(paths.backupsDir, { recursive: true });
  return { databasePath: paths.databasePath, backupsDir: paths.backupsDir };
}
