/**
 * Phase 11 §70/§71/§72 — migration 7 → 8 (section-workflow). A real
 * schema-7 world with a Section artifact migrates with every old row
 * preserved, the Section backfilled OPEN with a REGISTERED event (fail-closed
 * §9 — never guessed completed), no active work, history [1..8], and a valid
 * consistent backup. An injected failing 008 rolls back to a fully valid
 * schema-7 store; a schema-7 "old process" writer stays fenced (E57/E58).
 */

import { describe, expect, it } from "vitest";

import { canonicalJson } from "../src/core/canonical-json.js";
import { initializePlanStore, inspectPlanStore } from "../src/store/sqlite-store.js";
import { commitCheckpoint, makeContextFixture, type ContextFixture } from "./context-helpers.js";
import { commitSectionDag, makeDetailFixture } from "./phase11-helpers.js";
import { CONSTRAINT_1 } from "./proposal-helpers.js";
import {
  ensureStoreDir,
  publishedBackups,
  rawConnection,
  removeTempPluginDataRoot,
  storePathsFor,
  tableNames,
  dropSchema12Objects,
} from "./store-helpers.js";

/** Build a real schema-7-shaped world with a committed Section artifact. */
async function makeSchema7World(): Promise<ContextFixture> {
  const fixture = await makeContextFixture("S1");
  commitCheckpoint(fixture, [{ op: "ADD_CONSTRAINT", content: CONSTRAINT_1, compactProjection: "CONST-1@1" }]);
  // Raw-insert a Section identity + revision exactly as a schema-7 store
  // could have produced (no workflow tables exist at v7).
  const db = rawConnection(storePathsFor(fixture.root).databasePath, 5000);
  try {
    db.prepare("INSERT INTO memory_artifacts (run_id, kind, artifact_id, created_at) VALUES (?, 'section', ?, ?)").run(
      fixture.runId,
      "SEC-legacy",
      "2026-09-26T00:00:00.000Z",
    );
    db.prepare(
      `INSERT INTO memory_revisions (
         run_id, kind, artifact_id, revision, content_json, compact_projection, contract_json, created_at
       ) VALUES (?, 'section', 'SEC-legacy', 1, ?, ?, ?, ?)`,
    ).run(
      fixture.runId,
      canonicalJson({
        title: "Legacy section",
        objective: "o",
        design: "d",
        interfaces: [],
        invariants: [],
        failureModes: [],
        dependencies: [],
        decisionRefs: [],
        openQuestionRefs: [],
        impactRefs: [],
        contract: { sectionId: "SEC-legacy", revision: 1, provides: [], requires: [], invariants: [], interfaces: [], decisions: [] },
      }),
      "SEC-legacy@1",
      canonicalJson({ sectionId: "SEC-legacy", revision: 1, provides: [], requires: [], invariants: [], interfaces: [], decisions: [] }),
      "2026-09-26T00:00:00.000Z",
    );
  } finally {
    db.close();
  }
  return fixture;
}

/** Rewind an initialized v8 store to an exact schema-7 shape (test-only). */
function rewindToSchema7(root: string): void {
  const db = rawConnection(storePathsFor(root).databasePath, 5000);
  try {
    // Phase 12: rewind must also remove the v9 synthesis/validation objects
    // (children first; each table owns its no_update/no_delete triggers).
    for (const table of ["execution_handoffs", "execution_handoff_events", "execution_handoff_states", "execution_bindings"]) {
      db.exec(`DROP TABLE IF EXISTS ${table}`);
    }
    db.exec("DROP INDEX IF EXISTS idx_execution_handoff_events_handoff");
    db.exec("DROP INDEX IF EXISTS idx_execution_bindings_active_session");
    db.exec("DROP INDEX IF EXISTS idx_execution_bindings_session");
    for (const kind of ["update", "delete"]) {
      for (const table of ["execution_handoffs", "execution_handoff_events"]) {
        db.exec(`DROP TRIGGER IF EXISTS ${table}_no_${kind}`);
      }
    }
    for (const table of ["final_plans", "proposal_final_plan_refs", "final_plan_candidate_refs", "final_plan_candidates", "evidence_audit_entries", "evidence_audit_snapshots"]) {
      db.exec(`DROP TABLE IF EXISTS ${table}`);
    }
    db.exec("DROP INDEX IF EXISTS idx_evidence_audit_entries_audit");
    db.exec("DROP INDEX IF EXISTS idx_final_plan_candidates_run");
    db.exec("DROP INDEX IF EXISTS idx_proposal_final_plan_refs_candidate");
    for (const kind of ["update", "delete"]) {
      for (const table of ["evidence_audit_snapshots", "evidence_audit_entries", "final_plan_candidates", "final_plan_candidate_refs", "proposal_final_plan_refs", "final_plans"]) {
        db.exec(`DROP TRIGGER IF EXISTS ${table}_no_${kind}`);
      }
    }
    for (const table of ["synthesis_manifest_refs", "synthesis_manifests", "semantic_validation_findings", "semantic_validation_reports", "synthesis_input_refs", "synthesis_input_evidence", "synthesis_inputs"]) {
      db.exec(`DROP TABLE IF EXISTS ${table}`);
    }
    db.exec("DROP INDEX IF EXISTS idx_synthesis_inputs_run");
    db.exec("DROP INDEX IF EXISTS idx_synthesis_manifests_input");
    db.exec("DROP INDEX IF EXISTS idx_validation_reports_manifest");

    db.exec("DROP TRIGGER IF EXISTS section_workflow_events_no_update");
    db.exec("DROP TRIGGER IF EXISTS section_workflow_events_no_delete");
    db.exec("DROP TRIGGER IF EXISTS section_workflow_states_no_delete");
    db.exec("DROP TABLE IF EXISTS section_workflow_events");
    db.exec("DROP TABLE IF EXISTS section_workflow_states");
    db.exec("DROP TABLE IF EXISTS planning_active_work");
    db.exec("DROP INDEX IF EXISTS idx_section_workflow_events_section");
    dropSchema12Objects(db);
    db.exec("DELETE FROM schema_migrations WHERE version >= 8");
    db.exec("PRAGMA user_version = 7");
  } finally {
    db.close();
  }
}

describe("migration 7 → 8 section-workflow (§70/§71/§72, E1/E3/E57/E58)", () => {
  it("migrates a real schema-7 store: rows preserved, existing Section open, active work absent, history [1..8]", async () => {
    const fixture = await makeSchema7World();
    const root = fixture.root;
    try {
      rewindToSchema7(root);
      expect(inspectPlanStore(root)).toMatchObject({ status: "too_old", schemaVersion: 7 });
      const { backupsDir } = ensureStoreDir(root);
      const store = await initializePlanStore({ pluginDataRoot: root });
      try {
        expect(store.getSchemaVersion()).toBe(12);
        const read = (sql: string, ...params: unknown[]): unknown =>
          store.withRead((tx) => tx.prepare(sql).get(...params)) as Record<string, unknown>;
        // Old rows survive EXACTLY.
        const constraint = JSON.parse(
          (read("SELECT content_json AS c FROM memory_revisions WHERE kind = 'constraint' AND artifact_id = 'CONST-1'") as { c: string }).c,
        ) as { statement: string };
        expect(constraint.statement).toBe(CONSTRAINT_1.statement);
        // §9/§70 — the existing Section is OPEN with a REGISTERED event,
        // never guessed completed.
        expect((read("SELECT status AS s FROM section_workflow_states WHERE run_id = ? AND section_id = 'SEC-legacy'", fixture.runId) as { s: string }).s).toBe("open");
        const event = read(
          "SELECT event_type AS e, reason_code AS reason FROM section_workflow_events WHERE run_id = ? AND section_id = 'SEC-legacy' ORDER BY event_seq DESC LIMIT 1",
          fixture.runId,
        ) as { e: string; reason: string };
        expect(event.e).toBe("REGISTERED");
        expect(event.reason).toBe("schema8_failclosed_initialization");
        // §70 — no active work is ever invented by the migration.
        expect((read("SELECT COUNT(*) AS n FROM planning_active_work") as { n: number }).n).toBe(0);
        // History [1..8]; one consistent backup.
        const history = store
          .withRead((tx) => tx.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>)
          .map((row) => row.version);
        expect(history).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
        expect(publishedBackups(backupsDir)).toHaveLength(1);
        expect(publishedBackups(backupsDir)[0]).toMatch(/^phase-plan-pre-schema-7-12-/);
      } finally {
        store.close();
      }
    } finally {
      fixture.close();
    }
  });

  it("rolls back a failing 008 to a fully valid schema-7 store — no partial workflow state (§71/E58)", async () => {
    const fixture = await makeSchema7World();
    const root = fixture.root;
    try {
      rewindToSchema7(root);
      const { createProductionMigrations } = await import("../src/store/migrations/index.js");
      const production = createProductionMigrations({ generateStoreId: () => "seed", nowIso: () => "seed" });
      const failing = production.find((m) => m.to === 8)!;
      (failing as unknown as { apply: () => never }).apply = (() => {
        throw new Error("injected 008 failure");
      }) as never;
      const registry = [...production.filter((m) => m.to < 8), failing, ...production.filter((m) => m.to > 8)];
      await expect(initializePlanStore({ pluginDataRoot: root, migrations: registry })).rejects.toMatchObject({
        code: "STORE_MIGRATION_FAILED",
        causeText: expect.stringContaining("injected 008 failure"),
      });
      const names = tableNames(storePathsFor(root).databasePath);
      expect(names).not.toContain("section_workflow_events");
      expect(names).not.toContain("section_workflow_states");
      expect(names).not.toContain("planning_active_work");
      // The untouched schema-7 world is fully intact.
      expect(names).toContain("evidence_validation_events");
      expect(names).toContain("memory_artifacts");
    } finally {
      fixture.close();
    }
  });

  it("fences a real schema-7 writer after the Phase 11 migration (§72/E57)", async () => {
    const fixture = await makeSchema7World();
    const root = fixture.root;
    try {
      rewindToSchema7(root);
      const store = await initializePlanStore({ pluginDataRoot: root });
      try {
        expect(store.getSchemaVersion()).toBe(12);
        const { assertWriteCompat } = await import("../src/store/transaction.js");
        let writeRan = false;
        expect(() =>
          store.withWrite((tx) => {
            assertWriteCompat(tx, { supportedSchemaVersion: 7, databasePath: "test" });
            writeRan = true;
            tx.exec("CREATE TABLE smuggled_v7 (x TEXT)");
            return null;
          }),
        ).toThrowError(expect.objectContaining({ code: "STORE_SCHEMA_TOO_NEW" }));
        expect(writeRan).toBe(false);
        expect(tableNames(storePathsFor(root).databasePath)).not.toContain("smuggled_v7");
      } finally {
        store.close();
      }
    } finally {
      fixture.close();
    }
  });

  it("structural v8 validation flags a divergent workflow projection without an O(history) scan (§69)", async () => {
    const f = await makeDetailFixture();
    try {
      commitSectionDag(f, [{ title: "A" }]);
      // Simulate a divergent projection: force the materialized row to
      // completed (with internally-consistent provenance) while its last
      // workflow event still says REGISTERED → open.
      const db = rawConnection(storePathsFor(f.root).databasePath, 5000);
      try {
        db.prepare(
          "UPDATE section_workflow_states SET status = 'completed', completed_revision = 1, completed_proposal_id = 'PROP-divergent', completed_proposal_revision = 1, completion_commit_id = 'CMT-divergent' WHERE run_id = ? AND section_id = 'SEC-1'",
        ).run(f.runId);
      } finally {
        db.close();
      }
      f.store.close();
      const inspection = inspectPlanStore(f.root);
      expect(inspection.status).toBe("invalid");
      expect((inspection.problems ?? []).join(" ")).toContain("does not match its last workflow event");
    } finally {
      removeTempPluginDataRoot(f.root);
    }
  });
});
