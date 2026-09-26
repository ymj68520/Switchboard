/**
 * Migration 5 → 6 (observation-evidence-foundation) — Phase 9 §3/§61/§62/§63.
 *
 * Real schema-5 world with committed Plan Memory, proposal/commit/HEAD data:
 * migration preserves every old row, adds the EMPTY v6 tables, records
 * history 1..6 with a consistent pre-migration backup; an injected failing
 * 006 rolls back to a fully valid schema-5 store; and a schema-5 "old
 * process" writer stays fenced (STORE_SCHEMA_TOO_NEW) after the migration.
 */

import { describe, expect, it } from "vitest";

import { openDatabase } from "../src/store/connection.js";
import { runWrite } from "../src/store/transaction.js";
import { createObservationEvidenceMigration } from "../src/store/migrations/006-observation-evidence-foundation.js";
import { initializePlanStore, inspectPlanStore } from "../src/store/sqlite-store.js";
import { commitCheckpoint, makeContextFixture, type ContextFixture } from "./context-helpers.js";
import { CONSTRAINT_1 } from "./proposal-helpers.js";
import {
  ensureStoreDir,
  fixedClock,
  makeTempPluginDataRoot,
  publishedBackups,
  rawConnection,
  removeTempPluginDataRoot,
  storePathsFor,
  tableNames,
} from "./store-helpers.js";

/** Build a real schema-5 world (data present), then rewind to v5 cleanly. */
async function makeSchema5World(): Promise<ContextFixture> {
  const fixture = await makeContextFixture("S1");
  // One committed checkpoint (constraint + HEAD commit/snapshot pair).
  commitCheckpoint(fixture, [{ op: "ADD_CONSTRAINT", content: CONSTRAINT_1, compactProjection: "CONST-1@1" }]);
  return fixture;
}

/** Rewind an initialized v6 store to an exact schema-5 shape (test-only). */
function rewindToSchema5(root: string): void {
  const db = rawConnection(storePathsFor(root).databasePath, 5000);
  try {
    for (const kind of ["update", "delete"]) {
      for (const table of ["observations", "evidence_artifacts", "evidence_revisions", "evidence_observation_refs", "evidence_derived_refs"]) {
        db.exec(`DROP TRIGGER IF EXISTS ${table}_no_${kind}`);
      }
    }
    for (const table of ["evidence_validation_events", "evidence_current_states", "proposal_evidence_refs", "evidence_derived_refs", "evidence_observation_refs", "evidence_revisions", "evidence_artifacts", "observations"]) {
      db.exec(`DROP TABLE IF EXISTS ${table}`);
    }
    db.exec("DELETE FROM schema_migrations WHERE version >= 6");
    db.exec("PRAGMA user_version = 5");
    db.exec("CREATE TABLE phase6_sentinel (note TEXT NOT NULL)");
    db.prepare("INSERT INTO phase6_sentinel (note) VALUES (?)").run("pre-v6-sentinel");
  } finally {
    db.close();
  }
}

describe("migration 5 → 6 observation-evidence-foundation (§3/§62, E1/E2)", () => {
  it("migrates a real schema-5 store: all Phase 1–8 data preserved, v6 tables empty, history [1..6], one backup", async () => {
    const fixture = await makeSchema5World();
    const root = fixture.root;
    try {
      rewindToSchema5(root);
      expect(inspectPlanStore(root)).toMatchObject({ status: "too_old", schemaVersion: 5 });

      const before = {
        runs: count(root, "planning_runs"),
        bindings: count(root, "session_bindings"),
        memoryArtifacts: count(root, "memory_artifacts"),
        memoryRevisions: count(root, "memory_revisions"),
        snapshots: count(root, "plan_snapshots"),
        heads: count(root, "plan_heads"),
        commits: count(root, "plan_commits"),
        audit: count(root, "audit_events"),
      };
      expect(before.runs).toBeGreaterThan(0);
      expect(before.commits).toBeGreaterThan(0);

      const { backupsDir } = ensureStoreDir(root);
      const store = await initializePlanStore({ pluginDataRoot: root });
      try {
        expect(store.getSchemaVersion()).toBe(7);
        // Old data survives EXACTLY (E2).
        expect(count(root, "planning_runs")).toBe(before.runs);
        expect(count(root, "session_bindings")).toBe(before.bindings);
        expect(count(root, "memory_artifacts")).toBe(before.memoryArtifacts);
        expect(count(root, "memory_revisions")).toBe(before.memoryRevisions);
        expect(count(root, "plan_snapshots")).toBe(before.snapshots);
        expect(count(root, "plan_heads")).toBe(before.heads);
        expect(count(root, "plan_commits")).toBe(before.commits);
        // audit_events rebuilt verbatim (§72): same rows, EVIDENCE_PROMOTED allowed.
        expect(count(root, "audit_events")).toBe(before.audit);
        // New tables exist and are EMPTY (§62).
        for (const table of ["observations", "evidence_artifacts", "evidence_revisions", "evidence_observation_refs", "evidence_derived_refs"]) {
          expect(count(root, table)).toBe(0);
        }
        expect(tableNames(storePathsFor(root).databasePath).sort()).toEqual(expect.arrayContaining([
          "observations",
          "evidence_artifacts",
          "evidence_revisions",
          "evidence_observation_refs",
          "evidence_validation_events", "evidence_current_states", "proposal_evidence_refs", "evidence_derived_refs",
        ]));
        const history = store.withRead((tx) =>
          tx.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>,
        ).map((row) => row.version);
        expect(history).toEqual([1, 2, 3, 4, 5, 6, 7]);
        // The audit CHECK actually accepts the new event type (§72): a probe
        // insert succeeds inside a transaction that is then rolled back, and
        // an unknown type is rejected by the CHECK.
        expect(() =>
          store.withWrite((tx) => {
            tx.prepare(
              "INSERT INTO audit_events (event_id, run_id, event_type, subject_json, payload_json, created_at) VALUES (?, ?, 'EVIDENCE_PROMOTED', '{}', '{}', ?)",
            ).run("EVT-mig-probe", fixture.runId, "2026-01-01T00:00:00.000Z");
            throw new Error("rollback-probe");
          }),
        ).toThrowError("rollback-probe");
        expect(() =>
          store.withWrite((tx) => {
            tx.prepare(
              "INSERT INTO audit_events (event_id, run_id, event_type, subject_json, payload_json, created_at) VALUES (?, ?, 'BOGUS_TYPE', '{}', '{}', ?)",
            ).run("EVT-mig-probe-2", fixture.runId, "2026-01-01T00:00:00.000Z");
            return undefined;
          }),
        ).toThrowError(/CHECK constraint failed/);
      } finally {
        store.close();
      }
      expect(publishedBackups(backupsDir).length).toBeGreaterThanOrEqual(1);
    } finally {
      fixture.close();
    }
  });

  it("rolls back a failing 006 to a fully valid schema-5 store — no partial v6 tables (§63, E44)", async () => {
    const fixture = await makeSchema5World();
    const root = fixture.root;
    try {
      rewindToSchema5(root);
      const { backupsDir } = ensureStoreDir(root);

      const failing = createObservationEvidenceMigration();
      (failing as unknown as { apply: () => never }).apply = (() => {
        throw new Error("injected 006 failure");
      }) as never;

      // Re-run the production chain but substitute the failing 006 by wiring
      // the registry through initializePlanStore's test seam. The registry
      // must still reach the supported schema (7), so 007 follows the
      // injected failure — it never runs because 006 aborts first.
      const { createProductionMigrations } = await import("../src/store/migrations/index.js");
      const clock = fixedClock();
      const production = createProductionMigrations({ generateStoreId: clock.newId, nowIso: clock.nowIso });
      const registry = [...production.filter((m) => m.to < 6), failing, ...production.filter((m) => m.to > 6)];

      await expect(initializePlanStore({ pluginDataRoot: root, migrations: registry })).rejects.toMatchObject({
        code: "STORE_MIGRATION_FAILED",
        causeText: expect.stringContaining("injected 006 failure"),
      });

      const raw = rawConnection(storePathsFor(root).databasePath, 500);
      try {
        const versionRow = raw.prepare("PRAGMA user_version").get() as Record<string, unknown>;
        expect(Object.values(versionRow)[0]).toBe(5);
        const tables = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
        for (const banned of ["observations", "evidence_artifacts", "evidence_revisions", "evidence_observation_refs", "evidence_derived_refs"]) {
          expect(tables).not.toContain(banned);
        }
        expect(tables).toContain("phase6_sentinel");
        const history = (raw.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as { version: number }[]).map((h) => h.version);
        // The failing 006 aborted before its history row: back to [1..5].
        expect(history).toEqual([1, 2, 3, 4, 5]);
      } finally {
        raw.close();
      }
      // The pre-migration backup is retained as the recovery artifact.
      expect(publishedBackups(backupsDir)).toHaveLength(1);

      // A clean retry reaches v6 and preserves the schema-5 world.
      const retry = await initializePlanStore({ pluginDataRoot: root });
      expect(retry.getSchemaVersion()).toBe(7);
      expect(count(root, "plan_commits")).toBeGreaterThan(0);
      retry.close();
    } finally {
      fixture.close();
    }
  });

  it("fences a real schema-5 writer after the v6 migration (§61, E43)", async () => {
    const fixture = await makeSchema5World();
    const root = fixture.root;
    try {
      const store = await initializePlanStore({ pluginDataRoot: root });
      store.close();

      const oldWriterDb = openDatabase(storePathsFor(root).databasePath, { busyTimeoutMs: 500 });
      try {
        expect(() =>
          runWrite(
            oldWriterDb,
            (tx) => {
              tx.exec("CREATE TABLE smuggled_by_schema5_process (x TEXT)");
              return undefined;
            },
            { supportedSchemaVersion: 5, databasePath: storePathsFor(root).databasePath },
          ),
        ).toThrowError(expect.objectContaining({ code: "STORE_SCHEMA_TOO_NEW" }));
        const probe = openDatabase(storePathsFor(root).databasePath, { readonly: true });
        try {
          const names = (probe.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
          expect(names).not.toContain("smuggled_by_schema5_process");
        } finally {
          probe.close();
        }
      } finally {
        oldWriterDb.close();
      }
    } finally {
      fixture.close();
    }
  });

  it("structural v6 validation flags missing v6 tables/triggers/indexes (§61)", async () => {
    const root = makeTempPluginDataRoot("phase-plan-v6-struct-");
    try {
      const store = await initializePlanStore({ pluginDataRoot: root });
      store.close();
      const raw = rawConnection(storePathsFor(root).databasePath, 500);
      try {
        raw.exec("DROP TRIGGER evidence_revisions_no_delete");
      } finally {
        raw.close();
      }
      const inspection = inspectPlanStore(root);
      expect(inspection.status).toBe("invalid");
      expect(inspection.problems?.join("; ")).toContain("evidence_revisions_no_delete");
    } finally {
      removeTempPluginDataRoot(root);
    }
  });
});

function count(root: string, table: string): number {
  const db = rawConnection(storePathsFor(root).databasePath, 500);
  try {
    const row = db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}
