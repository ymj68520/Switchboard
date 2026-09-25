import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { openDatabase } from "../src/store/connection.js";
import { SUPPORTED_SCHEMA_VERSION } from "../src/store/constants.js";
import {
  createInitializeMigration,
} from "../src/store/migrations/001-initialize.js";
import { createWorkspaceBindingMigration } from "../src/store/migrations/002-workspace-session-binding.js";
import { createPlanningRunMigration } from "../src/store/migrations/003-planning-run-foundation.js";
import { createPlanMemoryMigration } from "../src/store/migrations/004-plan-memory-foundation.js";
import type { StoreMigration } from "../src/store/migrations/index.js";
import { runWrite } from "../src/store/transaction.js";
import { initializePlanStore, inspectPlanStore } from "../src/store/sqlite-store.js";
import { discoverAndRegisterWorkspace } from "../src/workspace/identity.js";
import { createPlanningRunService } from "../src/application/planning-run-service.js";
import { createInternalPlanMemoryWriter } from "../src/store/plan-memory.js";
import { fixedClock, makeTempPluginDataRoot, publishedBackups, rawConnection, removeTempPluginDataRoot, storePathsFor } from "./store-helpers.js";

/**
 * Surgically rebuild a genuine schema-4 store (Phase 5 output): v5 working
 * tables removed, plan_heads rebuilt in its v4 shape (snapshot-only), v5
 * history rows removed. Memory data and any legacy HEAD survive verbatim.
 */
function makeSchema4Store(root: string, options: { keepLegacyHead?: boolean } = {}): void {
  const { databasePath } = storePathsFor(root);
  const raw = rawConnection(databasePath, 5000);
  try {
    for (const table of ["audit_events", "plan_commits", "approvals", "proposal_states", "proposal_revisions", "proposals"]) {
      raw.exec(`DROP TABLE IF EXISTS ${table}`);
    }
    // Rebuild plan_heads in the v4 (snapshot-only) shape, preserving rows.
    // The v5 pair triggers drop automatically with the table.
    const headRows = raw.prepare("SELECT run_id, head_snapshot_id, updated_at FROM plan_heads").all() as {
      run_id: string;
      head_snapshot_id: string;
      updated_at: string;
    }[];
    raw.exec("DROP TABLE plan_heads");
    raw.exec(`
      CREATE TABLE plan_heads (
        run_id TEXT PRIMARY KEY REFERENCES planning_runs(run_id),
        head_snapshot_id TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (run_id, head_snapshot_id)
          REFERENCES plan_snapshots(run_id, snapshot_id)
      )
    `);
    for (const row of headRows) {
      raw.prepare("INSERT INTO plan_heads (run_id, head_snapshot_id, updated_at) VALUES (?, ?, ?)").run(
        row.run_id,
        row.head_snapshot_id,
        row.updated_at,
      );
    }
    raw.exec("DELETE FROM schema_migrations WHERE version >= 5");
    raw.exec("PRAGMA user_version = 4");
    raw.exec("CREATE TABLE phase5_sentinel (note TEXT NOT NULL)");
    raw.prepare("INSERT INTO phase5_sentinel (note) VALUES (?)").run("pre-v5-sentinel");
    void options;
  } finally {
    raw.close();
  }
}

function ensureDirs(root: string): { backupsDir: string } {
  const paths = storePathsFor(root);
  fs.mkdirSync(paths.storeDir, { recursive: true });
  fs.mkdirSync(paths.backupsDir, { recursive: true });
  return { backupsDir: paths.backupsDir };
}

interface V4World {
  runId: string;
  decisionId: string;
  snapshotId: string | null;
}

/** Build REAL Phase 5 state: workspace, run, memory revision, optional snapshot-only HEAD. */
async function makeV4World(root: string, withLegacyHead: boolean): Promise<V4World> {
  const store = await initializePlanStore({ pluginDataRoot: root });
  try {
    const dir = path.join(root, "project");
    fs.mkdirSync(dir, { recursive: true });
    const { registration } = await discoverAndRegisterWorkspace(store, dir, fixedClock({ ids: ["r", "w"] }));
    const runs = createPlanningRunService(store, fixedClock({ ids: ["x"] }));
    const { run } = runs.createPlanningRun({
      workspaceId: registration.workspace.workspaceId,
      sessionId: "S1",
      goal: "pre-v5 run",
    });
    const memory = createInternalPlanMemoryWriter(store, fixedClock({ ids: ["snap0"] }));
    memory.insertArtifactIdentity({ runId: run.runId, kind: "decision", artifactId: "DEC-1" });
    memory.insertMemoryRevision({
      runId: run.runId,
      kind: "decision",
      artifactId: "DEC-1",
      content: {
        title: "Use WAL",
        statement: "Use WAL journal mode",
        rationale: "concurrency",
        alternatives: [],
        consequences: [],
        scope: "storage",
        supportingRefs: [],
      },
      compactProjection: "DEC-1 Use WAL",
    });
    let snapshotId: string | null = null;
    if (withLegacyHead) {
      const snapshot = memory.insertSnapshot({ runId: run.runId, refs: [{ runId: run.runId, kind: "decision", id: "DEC-1", revision: 1 }] });
      snapshotId = snapshot.snapshotId;
      memory.setHeadSnapshot({ runId: run.runId, expectedHeadSnapshotId: null, nextSnapshotId: snapshot.snapshotId });
    }
    return { runId: run.runId, decisionId: "DEC-1", snapshotId };
  } finally {
    store.close();
  }
}

describe("migration 4 → 5 proposal-approval-plan-commit (E1/§85)", () => {
  it("preserves schema-4 data, adds empty proposal tables, history [1,2,3,4,5], consistent backup", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { backupsDir } = ensureDirs(root);
      const world = await makeV4World(root, false);
      makeSchema4Store(root);

      const inspection4 = inspectPlanStore(root);
      expect(inspection4.status).toBe("too_old");
      expect(inspection4.schemaVersion).toBe(4);

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
          { version: 4, name: "plan-memory-foundation" },
          { version: 5, name: "proposal-approval-plan-commit" },
        ]);
        // Old data fully preserved.
        expect(store.withRead((tx) => tx.prepare("SELECT count(*) AS n FROM planning_runs").get())).toEqual({ n: 1 });
        expect(store.withRead((tx) => tx.prepare("SELECT count(*) AS n FROM memory_revisions WHERE artifact_id = ?").get(world.decisionId))).toEqual({ n: 1 });
        const sentinel = store.withRead((tx) => tx.prepare("SELECT note FROM phase5_sentinel").all()) as { note: string }[];
        expect(sentinel[0]?.note).toBe("pre-v5-sentinel");
        // New proposal machinery starts empty.
        for (const table of ["proposals", "proposal_revisions", "proposal_states", "approvals", "plan_commits", "audit_events"]) {
          expect(store.withRead((tx) => tx.prepare(`SELECT count(*) AS n FROM ${table}`).get())).toEqual({ n: 0 });
        }
      } finally {
        store.close();
      }

      const backups = publishedBackups(backupsDir);
      expect(backups).toHaveLength(1);
      expect(backups[0]).toMatch(/^phase-plan-pre-schema-4-5-\d{8}T\d{6}(\.\d+)?Z?-[0-9a-f-]{8,}\.sqlite3$/);
      const backupDb = openDatabase(path.join(backupsDir, backups[0]!), { readonly: true });
      try {
        const row = backupDb.prepare("PRAGMA user_version").get() as Record<string, unknown>;
        expect(Object.values(row)[0]).toBe(4);
        // The backup is readable as schema 4 (its proposal tables do not exist).
        const names = (backupDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((n) => n.name);
        expect(names).not.toContain("proposals");
      } finally {
        backupDb.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("preserves a legacy snapshot-only HEAD with head_commit_id NULL — no fabricated commits (E47)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      ensureDirs(root);
      const world = await makeV4World(root, true);
      makeSchema4Store(root);

      const store = await initializePlanStore({ pluginDataRoot: root });
      try {
        const head = store.withRead((tx) =>
          tx.prepare("SELECT head_snapshot_id AS snapshotId, head_commit_id AS commitId FROM plan_heads WHERE run_id = ?").get(world.runId),
        ) as { snapshotId: string; commitId: string | null };
        expect(head.snapshotId).toBe(world.snapshotId);
        expect(head.commitId).toBeNull();
        expect(store.withRead((tx) => tx.prepare("SELECT count(*) AS n FROM plan_commits").get())).toEqual({ n: 0 });
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("rolls back a failing v5 migration to a fully valid schema-4 store (E49/§86)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      ensureDirs(root);
      const world = await makeV4World(root, true);
      makeSchema4Store(root);

      const failing: StoreMigration = {
        from: 4,
        to: 5,
        name: "deliberately-failing-v5",
        apply(tx) {
          tx.exec("CREATE TABLE proposals (run_id TEXT)");
          tx.exec("CREATE TABLE half_v5 (x TEXT)");
          throw new Error("injected v5 failure");
        },
      };
      const clock = fixedClock();

      await expect(
        initializePlanStore({
          pluginDataRoot: root,
          migrations: [
            createInitializeMigration({ generateStoreId: clock.newId, nowIso: clock.nowIso }),
            createWorkspaceBindingMigration(),
            createPlanningRunMigration(),
            createPlanMemoryMigration(),
            failing,
          ],
        }),
      ).rejects.toMatchObject({ code: "STORE_MIGRATION_FAILED" });

      const raw = rawConnection(storePathsFor(root).databasePath, 500);
      try {
        const versionRow = raw.prepare("PRAGMA user_version").get() as Record<string, unknown>;
        expect(Object.values(versionRow)[0]).toBe(4);
        const names = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
        expect(names).toContain("phase5_sentinel");
        expect(names).not.toContain("proposals");
        expect(names).not.toContain("half_v5");
        const history = (raw.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as { version: number }[]).map((h) => h.version);
        expect(history).toEqual([1, 2, 3, 4]);
        // plan_heads kept its v4 shape and data (legacy head preserved).
        const head = raw.prepare("SELECT head_snapshot_id FROM plan_heads WHERE run_id = ?").get(world.runId) as { head_snapshot_id: string };
        expect(head.head_snapshot_id).toBe(world.snapshotId);
      } finally {
        raw.close();
      }
      const retry = await initializePlanStore({ pluginDataRoot: root });
      expect(retry.getSchemaVersion()).toBe(5);
      retry.close();
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("fences a real schema-4 writer after the Phase 6 migration (E50/§87)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      ensureDirs(root);
      await makeV4World(root, false);
      makeSchema4Store(root);
      const store = await initializePlanStore({ pluginDataRoot: root });
      store.close();

      const oldWriterDb = openDatabase(storePathsFor(root).databasePath, { busyTimeoutMs: 500 });
      try {
        expect(() =>
          runWrite(
            oldWriterDb,
            (tx) => {
              tx.exec("CREATE TABLE smuggled_by_schema4_process (x TEXT)");
              return undefined;
            },
            { supportedSchemaVersion: 4, databasePath: storePathsFor(root).databasePath },
          ),
        ).toThrowError(expect.objectContaining({ code: "STORE_SCHEMA_TOO_NEW" }));
        const probe = openDatabase(storePathsFor(root).databasePath, { readonly: true });
        try {
          const names = (probe.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
          expect(names).not.toContain("smuggled_by_schema4_process");
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

  it("structural v5 validation flags missing constraint triggers and indexes (§98)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const store = await initializePlanStore({ pluginDataRoot: root });
      store.close();
      const raw = rawConnection(storePathsFor(root).databasePath, 500);
      try {
        raw.exec("DROP TRIGGER approvals_no_delete");
      } finally {
        raw.close();
      }
      const inspection = inspectPlanStore(root);
      expect(inspection.status).toBe("invalid");
      expect((inspection.problems ?? []).join(" ")).toContain("approvals_no_delete missing");

      const root2 = makeTempPluginDataRoot();
      try {
        const store2 = await initializePlanStore({ pluginDataRoot: root2 });
        store2.close();
        const raw2 = rawConnection(storePathsFor(root2).databasePath, 500);
        try {
          raw2.exec("DROP INDEX idx_plan_commits_run_sequence");
        } finally {
          raw2.close();
        }
        const inspection2 = inspectPlanStore(root2);
        expect(inspection2.status).toBe("invalid");
        expect((inspection2.problems ?? []).join(" ")).toContain("idx_plan_commits_run_sequence missing");
      } finally {
        removeTempPluginDataRoot(root2);
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });
});
