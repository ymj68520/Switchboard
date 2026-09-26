/**
 * Migration 6→7 — evidence-freshness-foundation (Phase 10 §9/§54/§55/§56).
 *
 * Real schema-6 world (data present, Evidence + EVIDENCE_PROMOTED audit):
 * the migration preserves every old row and initializes every existing
 * evidence revision to needs_validation with an INITIALIZED event — never
 * fresh (fail-closed, §9). An injected failing 007 rolls back to a fully
 * valid schema-6 store (E48); a schema-6 "old process" writer stays fenced
 * after the migration (E47).
 */

import { describe, expect, it } from "vitest";

import { canonicalJson } from "../src/core/canonical-json.js";
import { initializePlanStore, inspectPlanStore } from "../src/store/sqlite-store.js";
import { commitCheckpoint, makeContextFixture, type ContextFixture } from "./context-helpers.js";
import { CONSTRAINT_1 } from "./proposal-helpers.js";
import {
  ensureStoreDir,
  makeTempPluginDataRoot,
  publishedBackups,
  rawConnection,
  removeTempPluginDataRoot,
  storePathsFor,
  tableNames,
} from "./store-helpers.js";

/** Build a real schema-6-shaped world with evidence + audit data present. */
async function makeSchema6World(): Promise<ContextFixture> {
  const fixture = await makeContextFixture("S1");
  commitCheckpoint(fixture, [{ op: "ADD_CONSTRAINT", content: CONSTRAINT_1, compactProjection: "CONST-1@1" }]);
  const db = rawConnection(storePathsFor(fixture.root).databasePath, 5000);
  try {
    db.prepare("INSERT INTO evidence_artifacts (run_id, evidence_id, created_at) VALUES (?, ?, ?)").run(
      fixture.runId,
      "ev_pre_freshness",
      "2026-09-25T00:00:00.000Z",
    );
    db.prepare(
      `INSERT INTO evidence_revisions (
         run_id, evidence_id, revision, claim, kind, scope_json, confidence, criticality,
         validation_strategy, repository_context_json, workspace_context_json,
         source_fingerprints_json, request_id, request_hash, created_at
       ) VALUES (?, ?, 1, ?, 'source_fact', ?, 'direct', 'critical', 'fingerprint', ?, ?, ?, 'promote:legacy', 'sha256:legacy', ?)`,
    ).run(
      fixture.runId,
      "ev_pre_freshness",
      "legacy claim",
      canonicalJson({ type: "global" }),
      canonicalJson({ repositoryRevision: null }),
      canonicalJson({ workspaceId: fixture.workspaceId }),
      canonicalJson([]),
      "2026-09-25T00:00:00.000Z",
    );
    db.prepare(
      "INSERT INTO audit_events (event_id, run_id, event_type, subject_json, payload_json, created_at) VALUES (?, ?, 'EVIDENCE_PROMOTED', ?, ?, ?)",
    ).run(
      "EVT-legacy",
      fixture.runId,
      canonicalJson({ evidenceId: "ev_pre_freshness", revision: 1 }),
      canonicalJson({}),
      "2026-09-25T00:00:00.000Z",
    );
  } finally {
    db.close();
  }
  return fixture;
}

/** Rewind an initialized v7 store to an exact schema-6 shape (test-only). */
function rewindToSchema6(root: string): void {
  const db = rawConnection(storePathsFor(root).databasePath, 5000);
  try {
    db.exec("DROP TRIGGER IF EXISTS evidence_validation_events_no_revival");
    for (const kind of ["update", "delete"]) {
      for (const table of ["evidence_validation_events", "proposal_evidence_refs"]) {
        db.exec(`DROP TRIGGER IF EXISTS ${table}_no_${kind}`);
      }
    }
    db.exec("DROP TRIGGER IF EXISTS evidence_current_states_no_delete");
    db.exec("DROP TABLE IF EXISTS proposal_evidence_refs");
    db.exec("DROP TABLE IF EXISTS evidence_current_states");
    db.exec("DROP TABLE IF EXISTS evidence_validation_events");
    db.exec("DROP INDEX IF EXISTS idx_evidence_validation_events_revision");
    db.exec("DROP INDEX IF EXISTS idx_evidence_derived_refs_upstream");
    db.exec("DELETE FROM schema_migrations WHERE version >= 7");
    db.exec("PRAGMA user_version = 6");
  } finally {
    db.close();
  }
}

describe("migration 6 → 7 evidence-freshness-foundation (§9/§54, E1–E6)", () => {
  it("migrates a real schema-6 store: rows preserved, existing evidence needs_validation, history [1..7]", async () => {
    const fixture = await makeSchema6World();
    const root = fixture.root;
    try {
      rewindToSchema6(root);
      expect(inspectPlanStore(root)).toMatchObject({ status: "too_old", schemaVersion: 6 });

      const { backupsDir } = ensureStoreDir(root);
      const store = await initializePlanStore({ pluginDataRoot: root });
      try {
        expect(store.getSchemaVersion()).toBe(7);
        const read = (sql: string, ...params: unknown[]): unknown =>
          (store.withRead((tx) => tx.prepare(sql).get(...params)) as Record<string, unknown>);
        // Old rows survive EXACTLY (E2).
        const revision = read(
          "SELECT claim, criticality FROM evidence_revisions WHERE run_id = ? AND evidence_id = ?",
          fixture.runId,
          "ev_pre_freshness",
        ) as { claim: string; criticality: string };
        expect(revision.claim).toBe("legacy claim");
        expect((read("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'EVIDENCE_PROMOTED'") as { n: number }).n).toBe(1);
        expect((read("SELECT COUNT(*) AS n FROM plan_commits") as { n: number }).n).toBeGreaterThan(0);

        // §9 fail-closed initialization: needs_validation with INITIALIZED.
        const state = read(
          "SELECT state, last_event_seq AS lastEventSeq FROM evidence_current_states WHERE run_id = ? AND evidence_id = ?",
          fixture.runId,
          "ev_pre_freshness",
        ) as { state: string; lastEventSeq: number };
        expect(state.state).toBe("needs_validation");
        const event = read(
          "SELECT event_type AS eventType, from_state AS fromState, to_state AS toState, reason_code AS reason FROM evidence_validation_events WHERE run_id = ? AND event_seq = ?",
          fixture.runId,
          state.lastEventSeq,
        ) as { eventType: string; fromState: null; toState: string; reason: string };
        expect(event.eventType).toBe("INITIALIZED");
        expect(event.fromState).toBeNull();
        expect(event.toState).toBe("needs_validation");
        expect(event.reason).toBe("schema7_failclosed_initialization");

        // History [1..7]; one consistent backup taken before the migration.
        const history = store
          .withRead((tx) => tx.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>)
          .map((row) => row.version);
        expect(history).toEqual([1, 2, 3, 4, 5, 6, 7]);
        expect(publishedBackups(backupsDir)).toHaveLength(1);
      } finally {
        store.close();
      }
    } finally {
      closeQuietly(fixture, root);
    }
  });

  it("V1-era proposals keep zero inferred evidence refs (§32/E26)", async () => {
    const fixture = await makeSchema6World();
    const root = fixture.root;
    try {
      rewindToSchema6(root);
      const store = await initializePlanStore({ pluginDataRoot: root });
      try {
        const refs = store.withRead(
          (tx) => tx.prepare("SELECT COUNT(*) AS n FROM proposal_evidence_refs WHERE run_id = ?").get(fixture.runId),
        ) as { n: number };
        expect(refs.n).toBe(0); // no retroactive inference, ever
      } finally {
        store.close();
      }
    } finally {
      closeQuietly(fixture, root);
    }
  });

  it("rolls back a failing 007 to a fully valid schema-6 store — no half state tables (§55/E48)", async () => {
    const fixture = await makeSchema6World();
    const root = fixture.root;
    try {
      rewindToSchema6(root);
      const { createProductionMigrations } = await import("../src/store/migrations/index.js");
      const production = createProductionMigrations({ generateStoreId: () => "seed", nowIso: () => "seed" });
      const failing = production.find((m) => m.to === 7)!;
      (failing as unknown as { apply: () => never }).apply = (() => {
        throw new Error("injected 007 failure");
      }) as never;
      const registry = [...production.filter((m) => m.to < 7), failing];
      await expect(initializePlanStore({ pluginDataRoot: root, migrations: registry })).rejects.toMatchObject({
        code: "STORE_MIGRATION_FAILED",
        causeText: expect.stringContaining("injected 007 failure"),
      });
      const databasePath = storePathsFor(root).databasePath;
      const names = tableNames(databasePath);
      expect(names).not.toContain("evidence_validation_events");
      expect(names).not.toContain("evidence_current_states");
      expect(names).not.toContain("proposal_evidence_refs");
      // The untouched schema-6 world is fully intact.
      expect(names).toContain("evidence_revisions");
      expect(names).toContain("audit_events");
      expect((rawConnectionQueried(databasePath) as { n: number }).n ?? 6).toBeTruthy();
    } finally {
      closeQuietly(fixture, root);
    }
  });

  it("fences a real schema-6 writer after the Phase 10 migration (§56/E47)", async () => {
    const fixture = await makeSchema6World();
    const root = fixture.root;
    try {
      rewindToSchema6(root);
      const store = await initializePlanStore({ pluginDataRoot: root });
      try {
        expect(store.getSchemaVersion()).toBe(7);
        const { assertWriteCompat } = await import("../src/store/transaction.js");
        let writeRan = false;
        expect(() =>
          store.withWrite((tx) => {
            assertWriteCompat(tx, { supportedSchemaVersion: 6, databasePath: "test" });
            writeRan = true;
            tx.exec("CREATE TABLE smuggled_v6 (x TEXT)");
            return null;
          }),
        ).toThrowError(expect.objectContaining({ code: "STORE_SCHEMA_TOO_NEW" }));
        expect(writeRan).toBe(false);
        expect(tableNames(storePathsFor(root).databasePath)).not.toContain("smuggled_v6");
      } finally {
        store.close();
      }
    } finally {
      closeQuietly(fixture, root);
    }
  });
});

function rawConnectionQueried(databasePath: string): unknown {
  const db = rawConnection(databasePath, 500);
  try {
    return db.prepare("PRAGMA user_version").get();
  } finally {
    db.close();
  }
}

function closeQuietly(fixture: ContextFixture, root: string): void {
  fixture.close();
  removeTempPluginDataRoot(root);
}

// makeTempPluginDataRoot is re-exported here for symmetry with sibling files.
void makeTempPluginDataRoot;
