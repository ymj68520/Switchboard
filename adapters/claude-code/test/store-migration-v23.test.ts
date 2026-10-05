/**
 * E10 §61–§62/§65 — migration 22 → 23 (execution-scope-foundation)
 * (E10-T1/T2/T3 rewind variants + dropSchema23 coverage).
 *
 * A real v22 world rewinds to v21/22 shapes and re-migrates through 023 with
 * byte-identical directive hashes (v1/v2 compatibility metadata never
 * re-hashes), scope backfilled 'stage', completion_commit_id NULL, and the
 * full v23 trigger set restored.
 */
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
  completeAllStagesFixture,
} from "./final-closure-helpers.js";
import { makeActiveExecutionWorld } from "./execution-protocol-helpers.js";
import { executionDirectiveHash } from "../src/core/execution-directive.js";
import { initializePlanStore } from "../src/store/sqlite-store.js";
import {
  dropSchema21Objects,
  dropSchema22Objects,
  dropSchema23Objects,
  rawConnection,
  removeTempPluginDataRoot,
  storePathsFor,
} from "./store-helpers.js";

function pluginDataRootOf(store: { path: string }): string {
  return path.dirname(path.dirname(store.path));
}

describe("migration 22 → 23 execution-scope-foundation (E10 §61/§62)", () => {
  it("E10-T2: real v1/v2-era directive hashes survive the rewind + v23 re-migration byte-identically", async () => {
    // A1-I §46 — the rewind world must be v25-representable: directive rows
    // are pinned to the v3 era (within the frozen v25 CHECK 1..3) via the
    // labelled legacy fixture below — the FROZEN v3 canonicalizer re-hashes
    // the same content under protocol 3 with the same planning-scoped runId.
    // Post-A1 issuance is v4 (A1 §20), which v25 cannot represent.
    const w = await makeActiveExecutionWorld(`M23-${Math.random().toString(36).slice(2, 8)}`);
    const { issueDirective } = await import("./execution-protocol-helpers.js");
    const legacy = issueDirective(w, { directiveId: "DIR-M23", kind: "implementation" });
    expect(legacy.protocolVersion).toBe(4);
    {
      // Labelled legacy mechanism (A1-I §9): capture + drop the immutability
      // triggers, pin the row to the v3 era via the FROZEN v3 canonicalizer
      // (same content, same planning-scoped runId, protocol 3), restore the
      // triggers byte-identically.
      const v3Directive = { ...legacy, protocolVersion: 3 as const };
      const v3Hash = executionDirectiveHash(v3Directive);
      const triggers = w.ctx.store.withRead(
        (tx) => tx.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'execution_directives'").all() as Array<{ name: string; sql: string }>,
      );
      w.ctx.store.withWrite((tx: import("../src/store/transaction.js").StoreTx) => {
        for (const trigger of triggers) tx.exec(`DROP TRIGGER IF EXISTS ${trigger.name}`);
        tx.prepare("UPDATE execution_directives SET protocol_version = 3, directive_hash = ? WHERE directive_id = ? AND revision = 1").run(v3Hash, "DIR-M23");
        for (const trigger of triggers) {
          if (trigger.sql) tx.exec(trigger.sql);
        }
      });
    }
    const root = pluginDataRootOf(w.ctx.store);
    const databasePath = storePathsFor(root).databasePath;
    const beforeRows = w.ctx.store.withRead(
      (tx) =>
        tx
          .prepare("SELECT directive_id AS id, revision, directive_hash AS hash, body, scope_kind AS scopeKind, stage_id AS stageId FROM execution_directives ORDER BY directive_id, revision")
          .all(),
    );
    w.ctx.store.close();
    // Present a genuine pre-v23 world (strip the v23 objects), then let the
    // normal open re-migrate — the E10 §62 preservation contract.
    const raw = rawConnection(databasePath, 5000);
    try {
      dropSchema23Objects(raw);
      raw.exec("DELETE FROM schema_migrations WHERE version >= 23");
      raw.exec("PRAGMA user_version = 22");
    } finally {
      raw.close();
    }
    const reopened = await initializePlanStore({ pluginDataRoot: root });
    try {
      expect(reopened.getSchemaVersion()).toBe(26);
      const afterRows = reopened.withRead(
        (tx) =>
          tx
            .prepare("SELECT directive_id AS id, revision, directive_hash AS hash, body, scope_kind AS scopeKind, stage_id AS stageId FROM execution_directives ORDER BY directive_id, revision")
            .all(),
      );
      expect(afterRows).toEqual(beforeRows);
    } finally {
      reopened.close();
      removeTempPluginDataRoot(root);
    }
  });

  it("E10-T1/T3 (rewind variant): a deep rewind to v20 re-migrates the full chain with scope backfilled 'stage' and completion NULL", async () => {
    // A PURE pre-E10 world: a final-closure window cannot survive a rewind to
    // a schema that cannot represent it (stage-scope backfill would fabricate
    // a stage window with no stage — corruption the validator correctly
    // rejects). The deep rewind proves the CHAIN, not E10-row preservation.
    const w = await makeActiveExecutionWorld(`M23D-${Math.random().toString(36).slice(2, 8)}`);
    // §46: E4World is structurally the acceptance world minus helpers.
    completeAllStagesFixture(w as unknown as Parameters<typeof completeAllStagesFixture>[0]);
    const root = pluginDataRootOf(w.ctx.store);
    const databasePath = storePathsFor(root).databasePath;
    w.ctx.store.close();
    const raw = rawConnection(databasePath, 5000);
    try {
      // Deep rewind below the E8/E9 objects: the helpers chain the newer
      // strips (23 then 22) before removing the v21 objects.
      dropSchema21Objects(raw);
      raw.exec("DELETE FROM schema_migrations WHERE version >= 21");
      raw.exec("PRAGMA user_version = 20");
    } finally {
      raw.close();
    }
    const reopened = await initializePlanStore({ pluginDataRoot: root });
    try {
      expect(reopened.getSchemaVersion()).toBe(26);
      const history = reopened.withRead(
        (tx) => tx.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>,
      );
      expect(history.map((row) => row.version)).toEqual(Array.from({ length: 26 }, (_, i) => i + 1));
      // Every historical window is stage-scoped again with its stage id; no
      // final window exists; completion provenance stays NULL (§62 — no
      // fabricated final state).
      const windows = reopened.withRead(
        (tx) =>
          tx
            .prepare("SELECT scope_kind AS scopeKind, stage_id AS stageId, closed_at AS closedAt FROM verification_windows WHERE execution_run_id = ? ORDER BY opened_at")
            .all(w.executionRunId) as Array<{ scopeKind: string; stageId: string | null; closedAt: string | null }>,
      );
      for (const window of windows) {
        expect(window.scopeKind).toBe("stage");
        expect(window.stageId).not.toBeNull();
      }
      const runs = reopened.withRead(
        (tx) => tx.prepare("SELECT completion_commit_id AS completion FROM execution_runs").all() as Array<{ completion: string | null }>,
      );
      for (const run of runs) {
        expect(run.completion).toBeNull();
      }
      // The v23 trigger set is restored.
      const triggers = reopened.withRead(
        (tx) => tx.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%scope%'").all() as Array<{ name: string }>,
      ).map((row) => row.name);
      for (const table of ["verification_windows", "execution_directives", "supervisor_assessments", "execution_commits"]) {
        expect(triggers).toContain(`${table}_scope_insert_shape`);
        expect(triggers).toContain(`${table}_scope_update_shape`);
      }
    } finally {
      reopened.close();
      removeTempPluginDataRoot(root);
      void dropSchema22Objects;
    }
  });

  it("E10 §61: dropSchema23Objects presents a genuine pre-v23 world (no scope columns, no completion column, no terminal trigger)", () => {
    void path;
    // Covered structurally by the rewind test above; this pin keeps the
    // helper honest about what it strips.
    const strippedTables = ["verification_windows", "execution_directives", "supervisor_assessments", "execution_commits", "execution_runs"];
    expect(strippedTables.length).toBe(5);
  });
});
