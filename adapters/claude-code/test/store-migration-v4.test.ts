import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { openDatabase } from "../src/store/connection.js";
import { SUPPORTED_SCHEMA_VERSION } from "../src/store/constants.js";
import { createInitializeMigration } from "../src/store/migrations/001-initialize.js";
import { createWorkspaceBindingMigration } from "../src/store/migrations/002-workspace-session-binding.js";
import { createPlanningRunMigration } from "../src/store/migrations/003-planning-run-foundation.js";
import { createProposalApprovalCommitMigration } from "../src/store/migrations/005-proposal-approval-plan-commit.js";
import { createObservationEvidenceMigration } from "../src/store/migrations/006-observation-evidence-foundation.js";
import type { StoreMigration } from "../src/store/migrations/index.js";
import { runWrite } from "../src/store/transaction.js";
import { initializePlanStore, inspectPlanStore } from "../src/store/sqlite-store.js";
import { discoverAndRegisterWorkspace } from "../src/workspace/identity.js";
import { createPlanningRunService } from "../src/application/planning-run-service.js";
import { fixedClock, makeTempPluginDataRoot, publishedBackups, rawConnection, removeTempPluginDataRoot, storePathsFor } from "./store-helpers.js";

/** Surgically rebuild a genuine schema-3 store (Phase 4 output). */
function makeSchema3Store(root: string): void {
  const { databasePath } = storePathsFor(root);
  const raw = rawConnection(databasePath, 5000);
  try {
    for (const table of ["evidence_validation_events", "evidence_current_states", "proposal_evidence_refs", "evidence_derived_refs", "evidence_observation_refs", "evidence_revisions", "evidence_artifacts", "observations", "audit_events", "plan_commits", "approvals", "proposal_states", "proposal_revisions", "proposals", "plan_heads", "snapshot_members", "plan_snapshots", "memory_revisions", "memory_artifacts"]) {
      raw.exec(`DROP TABLE IF EXISTS ${table}`);
    }
    for (const kind of ["update", "delete"]) {
      for (const table of ["observations", "evidence_artifacts", "evidence_revisions", "evidence_observation_refs", "evidence_validation_events", "evidence_current_states", "proposal_evidence_refs", "evidence_derived_refs", "audit_events"]) {
        raw.exec(`DROP TRIGGER IF EXISTS ${table}_no_${kind}`);
      }
    }
for (const kind of ["update", "delete"]) {
      for (const table of ["memory_artifacts", "memory_revisions", "plan_snapshots", "snapshot_members"]) {
        raw.exec(`DROP TRIGGER IF EXISTS ${table}_no_${kind}`);
      }
    }
    raw.exec("DROP TRIGGER IF EXISTS evidence_validation_events_no_update");
    raw.exec("DROP TRIGGER IF EXISTS evidence_validation_events_no_delete");
    raw.exec("DROP TRIGGER IF EXISTS evidence_validation_events_no_revival");
    raw.exec("DROP TRIGGER IF EXISTS evidence_current_states_no_delete");
    raw.exec("DROP TRIGGER IF EXISTS proposal_evidence_refs_no_update");
    raw.exec("DROP TRIGGER IF EXISTS proposal_evidence_refs_no_delete");
    raw.exec("DROP INDEX IF EXISTS idx_evidence_validation_events_revision");
    raw.exec("DROP INDEX IF EXISTS idx_evidence_derived_refs_upstream");
    raw.exec("DELETE FROM schema_migrations WHERE version >= 4");
    raw.exec("PRAGMA user_version = 3");
    raw.exec("CREATE TABLE phase4_sentinel (note TEXT NOT NULL)");
    raw.prepare("INSERT INTO phase4_sentinel (note) VALUES (?)").run("pre-v4-sentinel");
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

describe("migration 3 → 4 plan-memory-foundation (E1/E2/E35/§51)", () => {
  it("preserves all Phase 1–4 rows, adds empty memory tables, no HEAD, history [1,2,3,4]", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { backupsDir } = ensureDirs(root);
      const store4 = await initializePlanStore({ pluginDataRoot: root });
      let runId: string;
      try {
        const dir = path.join(root, "project");
        fs.mkdirSync(dir, { recursive: true });
        const { registration } = await discoverAndRegisterWorkspace(store4, dir, fixedClock({ ids: ["r", "w"] }));
        runId = createPlanningRunService(store4, fixedClock({ ids: ["x"] })).createPlanningRun({
          workspaceId: registration.workspace.workspaceId,
          sessionId: "S1",
          goal: "pre-v4 run",
        }).run.runId;
      } finally {
        store4.close();
      }
      makeSchema3Store(root);

      const inspection3 = inspectPlanStore(root);
      expect(inspection3.status).toBe("too_old");
      expect(inspection3.schemaVersion).toBe(3);

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
          { version: 6, name: "observation-evidence-foundation" },
          { version: 7, name: "evidence-freshness-foundation" },
        ]);
        expect(store.withRead((tx) => tx.prepare("SELECT count(*) AS n FROM planning_runs").get())).toEqual({ n: 1 });
        expect(store.withRead((tx) => tx.prepare("SELECT count(*) AS n FROM planning_runs WHERE run_id = ?").get(runId))).toEqual({ n: 1 });
        expect(store.withRead((tx) => tx.prepare("SELECT count(*) AS n FROM session_bindings").get())).toEqual({ n: 1 });
        expect(store.withRead((tx) => tx.prepare("SELECT count(*) AS n FROM memory_artifacts").get())).toEqual({ n: 0 });
        expect(store.withRead((tx) => tx.prepare("SELECT count(*) AS n FROM plan_heads").get())).toEqual({ n: 0 });
        const sentinel = store.withRead((tx) => tx.prepare("SELECT note FROM phase4_sentinel").all()) as { note: string }[];
        expect(sentinel[0]?.note).toBe("pre-v4-sentinel");
      } finally {
        store.close();
      }

      const backups = publishedBackups(backupsDir);
      expect(backups).toHaveLength(1);
      expect(backups[0]).toMatch(/^phase-plan-pre-schema-3-7-\d{8}T\d{6}(\.\d+)?Z?-[0-9a-f-]{8,}\.sqlite3$/);
      const backupDb = openDatabase(path.join(backupsDir, backups[0]!), { readonly: true });
      try {
        const row = backupDb.prepare("PRAGMA user_version").get() as Record<string, unknown>;
        expect(Object.values(row)[0]).toBe(3);
      } finally {
        backupDb.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("rolls back a failing v4 migration to a fully valid schema-3 store (E34/§52)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      ensureDirs(root);
      const first = await initializePlanStore({ pluginDataRoot: root });
      first.close();
      makeSchema3Store(root);

      const failing: StoreMigration = {
        from: 3,
        to: 4,
        name: "deliberately-failing-v4",
        apply(tx) {
          tx.exec("CREATE TABLE memory_artifacts (run_id TEXT)");
          tx.exec("CREATE TABLE half_v4 (x TEXT)");
          throw new Error("injected v4 failure");
        },
      };

      await expect(
        initializePlanStore({
          pluginDataRoot: root,
          migrations: [
            createInitializeMigration({ generateStoreId: fixedClock().newId, nowIso: fixedClock().nowIso }),
            createWorkspaceBindingMigration(),
            createPlanningRunMigration(),
            failing,
            createProposalApprovalCommitMigration(),
            createObservationEvidenceMigration(),
          ],
        }),
      ).rejects.toMatchObject({ code: "STORE_MIGRATION_FAILED" });

      const raw = rawConnection(storePathsFor(root).databasePath, 500);
      try {
        const versionRow = raw.prepare("PRAGMA user_version").get() as Record<string, unknown>;
        expect(Object.values(versionRow)[0]).toBe(3);
        const tables = (
          raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]
        ).map((t) => t.name);
        expect(tables).toContain("phase4_sentinel");
        expect(tables).not.toContain("memory_artifacts");
        expect(tables).not.toContain("half_v4");
        const history = (
          raw.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as { version: number }[]
        ).map((h) => h.version);
        expect(history).toEqual([1, 2, 3]);
      } finally {
        raw.close();
      }
      const retry = await initializePlanStore({ pluginDataRoot: root });
      expect(retry.getSchemaVersion()).toBe(7);
      retry.close();
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("fences a real schema-3 writer after the Phase 5 migration (E36/§53)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      ensureDirs(root);
      const first = await initializePlanStore({ pluginDataRoot: root });
      first.close();
      makeSchema3Store(root);
      const store = await initializePlanStore({ pluginDataRoot: root });
      store.close();

      const oldWriterDb = openDatabase(storePathsFor(root).databasePath, { busyTimeoutMs: 500 });
      try {
        expect(() =>
          runWrite(
            oldWriterDb,
            (tx) => {
              tx.exec("CREATE TABLE smuggled_by_schema3_process (x TEXT)");
              return undefined;
            },
            { supportedSchemaVersion: 3, databasePath: storePathsFor(root).databasePath },
          ),
        ).toThrowError(expect.objectContaining({ code: "STORE_SCHEMA_TOO_NEW" }));
        const probe = openDatabase(storePathsFor(root).databasePath, { readonly: true });
        try {
          const names = (
            probe.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
          ).map((t) => t.name);
          expect(names).not.toContain("smuggled_by_schema3_process");
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

  it("structural v4 validation flags missing memory tables without an O(history) scan", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const store = await initializePlanStore({ pluginDataRoot: root });
      store.close();
      const raw = rawConnection(storePathsFor(root).databasePath, 500);
      try {
        raw.exec("DROP TABLE snapshot_members");
      } finally {
        raw.close();
      }
      const inspection = inspectPlanStore(root);
      expect(inspection.status).toBe("invalid");
      expect((inspection.problems ?? []).join(" ")).toContain("snapshot_members table missing");
    } finally {
      removeTempPluginDataRoot(root);
    }
  });
});
