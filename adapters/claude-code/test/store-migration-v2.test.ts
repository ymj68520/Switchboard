import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { openDatabase } from "../src/store/connection.js";
import { SUPPORTED_SCHEMA_VERSION } from "../src/store/constants.js";
import { createInitializeMigration } from "../src/store/migrations/001-initialize.js";
import { createPlanningRunMigration } from "../src/store/migrations/003-planning-run-foundation.js";
import type { StoreMigration } from "../src/store/migrations/index.js";
import { runWrite } from "../src/store/transaction.js";
import { initializePlanStore, inspectPlanStore, openPlanStore } from "../src/store/sqlite-store.js";
import { createBindingService } from "../src/session/binding-service.js";
import { discoverWorkspace, registerWorkspace } from "../src/workspace/identity.js";
import {
  createSchema0Database,
  ensureStoreDir,
  fixedClock,
  makeTempPluginDataRoot,
  publishedBackups,
  rawConnection,
  removeTempPluginDataRoot,
  storePathsFor,
} from "./store-helpers.js";

/**
 * Build a GENUINE schema-1 store: initialize at v2, then surgically remove
 * the v2 tables/history row and set user_version back to 1. The remaining
 * store is byte-for-byte what Phase 2 produced (001's DDL + one history row).
 */
function makeSchema1Store(root: string): void {
  const { databasePath } = storePathsFor(root);
  const raw = rawConnection(databasePath, 5000);
  try {
    raw.exec("DROP TABLE IF EXISTS planning_runs");
    raw.exec("DROP TABLE session_bindings");
    raw.exec("DROP TABLE workspaces");
    raw.exec("DROP TABLE repositories");
    raw.exec("DELETE FROM schema_migrations WHERE version >= 2");
    raw.exec("DROP INDEX IF EXISTS idx_session_bindings_active_session");
    raw.exec("PRAGMA user_version = 1");
    // Sentinel data from the schema-1 era must survive the migration.
    raw.exec("CREATE TABLE phase2_sentinel (note TEXT NOT NULL)");
    raw.prepare("INSERT INTO phase2_sentinel (note) VALUES (?)").run("pre-v2-sentinel");
  } finally {
    raw.close();
  }
}

describe("migration 1 → 2 (E1/E26/§43)", () => {
  it("migrates a real schema-1 store with a consistent validated backup and exact history", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { backupsDir } = ensureStoreDir(root);
      const first = await initializePlanStore({ pluginDataRoot: root });
      first.close();
      makeSchema1Store(root);

      const inspection1 = inspectPlanStore(root);
      expect(inspection1.status).toBe("too_old");
      expect(inspection1.schemaVersion).toBe(1);

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
        const sentinel = store.withRead((tx) =>
          tx.prepare("SELECT note FROM phase2_sentinel").all(),
        ) as { note: string }[];
        expect(sentinel[0]?.note).toBe("pre-v2-sentinel");
      } finally {
        store.close();
      }

      const backups = publishedBackups(backupsDir);
      expect(backups).toHaveLength(1);
      expect(backups[0]).toMatch(/^phase-plan-pre-schema-1-3-\d{8}T\d{6}(\.\d+)?Z?-[0-9a-f-]{8,}\.sqlite3$/);
      // The backup captures the SOURCE state (schema 1 + sentinel).
      const backupDb = openDatabase(path.join(backupsDir, backups[0]!), { readonly: true });
      try {
        const row = backupDb.prepare("PRAGMA user_version").get() as Record<string, unknown>;
        expect(Object.values(row)[0]).toBe(1);
        const sentinel = backupDb.prepare("SELECT note FROM phase2_sentinel").all() as { note: string }[];
        expect(sentinel[0]?.note).toBe("pre-v2-sentinel");
      } finally {
        backupDb.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("rolls back a failing v2 migration to a fully valid schema-1 store (E25/§43)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      ensureStoreDir(root);
      const first = await initializePlanStore({ pluginDataRoot: root });
      first.close();
      makeSchema1Store(root);

      const failing: StoreMigration = {
        from: 1,
        to: 2,
        name: "deliberately-failing-v2",
        apply(tx) {
          tx.exec("CREATE TABLE half_v2 (x TEXT)");
          throw new Error("injected v2 failure");
        },
      };

      await expect(
        initializePlanStore({
          pluginDataRoot: root,
          migrations: [
            createInitializeMigration({ generateStoreId: fixedClock().newId, nowIso: fixedClock().nowIso }),
            failing,
            createPlanningRunMigration(),
          ],
        }),
      ).rejects.toMatchObject({ code: "STORE_MIGRATION_FAILED" });

      // Source remains a complete, valid schema-1 store — no partial v2 DDL.
      const raw = rawConnection(storePathsFor(root).databasePath, 500);
      try {
        const versionRow = raw.prepare("PRAGMA user_version").get() as Record<string, unknown>;
        expect(Object.values(versionRow)[0]).toBe(1);
        const tables = (
          raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]
        ).map((t) => t.name);
        expect(tables).toContain("phase2_sentinel");
        expect(tables).not.toContain("half_v2");
        expect(tables).not.toContain("repositories");
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

  it("fences a real schema-1 writer after the Phase 3 migration (E27/§44)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      ensureStoreDir(root);
      const first = await initializePlanStore({ pluginDataRoot: root });
      first.close();
      makeSchema1Store(root);
      const store = await initializePlanStore({ pluginDataRoot: root });
      try {
        expect(store.getSchemaVersion()).toBe(3);
      } finally {
        store.close();
      }

      // An "old Phase 2 process": a real store connection whose binary
      // supports schema 1 (the fence parameter is exactly what the old
      // binary's runWrite passed). No user_version manipulation here.
      const oldWriterDb = openDatabase(storePathsFor(root).databasePath, { busyTimeoutMs: 500 });
      try {
        expect(() =>
          runWrite(
            oldWriterDb,
            (tx) => {
              tx.exec("CREATE TABLE smuggled_by_old_process (x TEXT)");
              return undefined;
            },
            { supportedSchemaVersion: 1, databasePath: storePathsFor(root).databasePath },
          ),
        ).toThrowError(expect.objectContaining({ code: "STORE_SCHEMA_TOO_NEW" }));
        const probe = openDatabase(storePathsFor(root).databasePath, { readonly: true });
        try {
          const names = (
            probe.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
          ).map((t) => t.name);
          expect(names).not.toContain("smuggled_by_old_process");
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

  it("a legacy schema-0 database still upgrades through the full chain with one backup", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { databasePath, backupsDir } = ensureStoreDir(root);
      createSchema0Database(databasePath, "chain-sentinel");
      const store = await initializePlanStore({ pluginDataRoot: root });
      try {
        expect(store.getSchemaVersion()).toBe(3);
        const history = store.withRead((tx) =>
          tx.prepare("SELECT version FROM schema_migrations ORDER BY version").all(),
        ) as { version: number }[];
        expect(history.map((h) => h.version)).toEqual([1, 2, 3]);
        const sentinel = store.withRead((tx) =>
          tx.prepare("SELECT note FROM legacy_marker").all(),
        ) as { note: string }[];
        expect(sentinel[0]?.note).toBe("chain-sentinel");
      } finally {
        store.close();
      }
      expect(publishedBackups(backupsDir)).toHaveLength(1);
      expect(publishedBackups(backupsDir)[0]).toMatch(/^phase-plan-pre-schema-0-3-/);
    } finally {
      removeTempPluginDataRoot(root);
    }
  });
});

describe("schema v2 integrity validation (E24/§42)", () => {
  it("flags orphaned bindings and missing tables instead of trusting user_version", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const store = await initializePlanStore({ pluginDataRoot: root });
      const { databasePath } = storePathsFor(root);
      store.close();
      const raw = rawConnection(databasePath, 500);
      try {
        raw.exec("DROP TABLE repositories");
        // user_version still claims 2 — the validator must not be fooled.
        const inspection = inspectPlanStore(root);
        expect(inspection.status).toBe("invalid");
        expect((inspection.problems ?? []).join(" ")).toContain("repositories table missing");
      } finally {
        raw.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("flags a duplicate attached session even if the unique index were dropped", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const store = await initializePlanStore({ pluginDataRoot: root });
      const { databasePath } = storePathsFor(root);
      const dir = path.join(root, "project");
      fs.mkdirSync(dir, { recursive: true });
      const registration = registerWorkspace(store, await discoverWorkspace(dir), fixedClock({ ids: ["r", "w"] }));
      const bindings = createBindingService(store, fixedClock({ ids: ["x"] }));
      bindings.bind({ runId: "RUN-A", workspaceId: registration.workspace.workspaceId, sessionId: "S1" });
      bindings.bind({ runId: "RUN-B", workspaceId: registration.workspace.workspaceId, sessionId: "S2" });
      store.close();

      const raw = rawConnection(databasePath, 500);
      try {
        // Simulate a corrupted store whose uniqueness enforcement vanished.
        raw.exec("DROP INDEX idx_session_bindings_active_session");
        raw.exec(
          "INSERT INTO session_bindings (run_id, workspace_id, session_id, state, generation, created_at, updated_at) VALUES ('RUN-C', '" +
            registration.workspace.workspaceId +
            "', 'S1', 'attached', 1, '2026-01-01', '2026-01-01')",
        );
      } finally {
        raw.close();
      }
      const inspection = inspectPlanStore(root);
      expect(inspection.status).toBe("invalid");
      expect((inspection.problems ?? []).join(" ")).toContain("multiple attached bindings");
      expect(() => openPlanStore({ pluginDataRoot: root })).toThrowError(
        expect.objectContaining({ code: "STORE_SCHEMA_INVALID" }),
      );
    } finally {
      removeTempPluginDataRoot(root);
    }
  });
});
