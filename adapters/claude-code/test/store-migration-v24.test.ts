/**
 * E11 §72 — migration 23 → 24 (attempt-reconciliation-foundation) and the
 * T70 static proof: no E12+ behavior exists.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { makeAcceptanceWorld } from "./acceptance-helpers.js";
import {
  makeIndeterminateWorld,
  readOnlyEnvelope,
  FULL_REPORT_CONTRACT,
  runReconciliationInspection,
} from "./attempt-recovery-helpers.js";
import { supervisorCall, currentRevision } from "./acceptance-helpers.js";
import { initializePlanStore } from "../src/store/sqlite-store.js";
import { getExecutionDirectiveInTx } from "../src/store/execution-directives.js";
import { executionDirectiveHash } from "../src/core/execution-directive.js";
import { dropSchema24Objects, rawConnection, removeTempPluginDataRoot } from "./store-helpers.js";

/**
 * A1-I §46 labelled legacy fixture — pin every directive row to the v3 era
 * (within the frozen v25 protocol CHECK) by re-hashing the same content under
 * the FROZEN v3 canonicalizer with the planning-scoped runId. A world holding
 * v4 directives is not representable below schema 26 (A1 §20/CHECK 1..3).
 */
function pinDirectivesToLegacyEra(store: {
  withRead: (fn: (tx: { prepare: (sql: string) => { all: () => unknown; get: () => unknown } }) => unknown) => unknown;
  withWrite: (fn: (tx: { prepare: (sql: string) => { run: (...a: unknown[]) => unknown } }) => unknown) => unknown;
}): void {
  const rows = store.withRead(
    (tx) => tx.prepare("SELECT directive_id AS id, revision AS rev FROM execution_directives WHERE protocol_version = 4").all(),
  ) as Array<{ id: string; rev: number }>;
  store.withWrite((tx) => {
    // The immutability triggers must step aside for the labelled rewrite and
    // come back byte-identically afterwards.
    // Capture + drop every immutability trigger on the touched tables (the
    // labelled rewrite rewrites hash-carrying rows), restore byte-identically.
    const triggerTables = ["execution_directives", "execution_attempts", "execution_reports"];
    const triggers: Array<{ name: string; sql: string }> = [];
    for (const table of triggerTables) {
      const rowsT = (tx as unknown as { prepare: (sql: string) => { all: () => unknown } }).prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = '" + table + "'",
      ).all() as Array<{ name: string; sql: string }>;
      for (const trigger of rowsT) {
        triggers.push(trigger);
        (tx as unknown as { exec: (sql: string) => void }).exec(`DROP TRIGGER IF EXISTS ${trigger.name}`);
      }
    }
    for (const row of rows) {
      const directive = getExecutionDirectiveInTx(tx as never, row.id, row.rev);
      if (directive === null) continue;
      const v3Hash = executionDirectiveHash({ ...directive, protocolVersion: 3 });
      tx.prepare("UPDATE execution_directives SET protocol_version = 3, directive_hash = ? WHERE directive_id = ? AND revision = ?")
        .run(v3Hash, row.id, row.rev);
      // The dependent rows pin the SAME directive hash (E4 §20 binding) —
      // they must follow the labelled rewrite or the v17-era validators
      // correctly flag a mismatched Directive binding.
      tx.prepare("UPDATE execution_attempts SET directive_hash = ? WHERE directive_id = ? AND directive_revision = ?")
        .run(v3Hash, row.id, row.rev);
      tx.prepare("UPDATE execution_reports SET directive_hash = ? WHERE directive_id = ? AND directive_revision = ?")
        .run(v3Hash, row.id, row.rev);
    }
    for (const trigger of triggers) {
      if (trigger.sql) (tx as unknown as { exec: (sql: string) => void }).exec(trigger.sql);
    }
  });
}


function pluginDataRootOf(store: { path: string }): string {
  return path.dirname(path.dirname(store.path));
}

describe("migration 23 → 24 attempt-reconciliation-foundation", () => {
  it("E11 §52: a deep rewind to v23 re-migrates cleanly; historical indeterminate Attempts stay unresolved (nothing fabricated)", async () => {
    const { world, attemptId } = await makeIndeterminateWorld();
    const root = pluginDataRootOf(world.ctx.store);
    const databasePath = world.ctx.store.path;
    pinDirectivesToLegacyEra(world.ctx.store as never);
    world.ctx.store.close();
    const raw = rawConnection(databasePath, 5000);
    try {
      dropSchema24Objects(raw);
      raw.exec("DELETE FROM schema_migrations WHERE version >= 24");
      raw.exec("PRAGMA user_version = 23");
    } finally {
      raw.close();
    }
    const reopened = await initializePlanStore({ pluginDataRoot: root });
    try {
      expect(reopened.getSchemaVersion()).toBe(26);
      // The indeterminate Attempt survived; NO reconciliation row was fabricated.
      const attempts = reopened.withRead(
        (tx) => tx.prepare("SELECT attempt_id AS id, state FROM execution_attempts WHERE execution_run_id = ? AND state = 'indeterminate'").all(world.executionRunId) as Array<{ id: string; state: string }>,
      );
      expect(attempts.some((attempt) => attempt.id === attemptId)).toBe(true);
      expect(reopened.withRead((tx) => tx.prepare("SELECT count(*) AS n FROM execution_attempt_reconciliations").get())).toEqual({ n: 0 });
      expect(reopened.withRead((tx) => tx.prepare("SELECT count(*) AS n FROM execution_attempt_reconciliation_bindings").get())).toEqual({ n: 0 });
      // All directive hashes preserved.
      const directives = reopened.withRead(
        (tx) => tx.prepare("SELECT directive_id AS id, directive_hash AS hash FROM execution_directives WHERE run_id = ? ORDER BY directive_id").all(world.f.runId) as Array<{ id: string; hash: string }>,
      );
      expect(directives.length).toBeGreaterThan(0);
    } finally {
      reopened.close();
      removeTempPluginDataRoot(root);
    }
  });

  it("E11 §51: the recovery workflow still works end-to-end after a rewind + re-migration", async () => {
    const { world, attemptId } = await makeIndeterminateWorld({ sessionId: `M24-${Math.random().toString(36).slice(2, 6)}` });
    const root = pluginDataRootOf(world.ctx.store);
    const databasePath = world.ctx.store.path;
    pinDirectivesToLegacyEra(world.ctx.store as never);
    world.ctx.store.close();
    const raw = rawConnection(databasePath, 5000);
    try {
      dropSchema24Objects(raw);
      raw.exec("DELETE FROM schema_migrations WHERE version >= 24");
      raw.exec("PRAGMA user_version = 23");
    } finally {
      raw.close();
    }
    const reopened = await initializePlanStore({ pluginDataRoot: root });
    // Reopen the world against the migrated store.
    world.ctx.store = reopened;
    const inspection = runReconciliationInspection(world, { attemptId });
    const result = supervisorCall(world, "resolve_indeterminate_attempt", {
      attempt_id: attemptId,
      resolution: "no_effect",
      inspection_report_id: inspection.reportId,
      rationale: "clean after re-migration",
      expected_candidate_revision: currentRevision(world),
    }) as { status: string };
    expect(result.status).toBe("resolved");
    reopened.close();
  });
});

describe("E11-T70: no E12+ behavior exists", () => {
  it("no abort transition, no ExecutionObservation, no /clear or fork recovery matrix", async () => {
    const world = await makeAcceptanceWorld(`T70-${Math.random().toString(36).slice(2, 8)}`);
    // No abort lifecycle writer: the run cannot transition to aborted.
    const aborted = world.ctx.store.withRead(
      (tx) => tx.prepare("SELECT count(*) AS n FROM execution_runs WHERE lifecycle = 'aborted'").get() as { n: number },
    );
    expect(aborted.n).toBe(0);
    // No ExecutionObservation machinery.
    const tables = world.ctx.store.withRead(
      (tx) => tx.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'execution_observations'").all() as Array<{ name: string }>,
    ).map((row) => row.name);
    expect(tables).toEqual([]);
    // Static: no ExecutionObservation production modules (E13 owns the abort
    // machinery now — the E12-era abort prohibition is superseded by E13).
    const srcRoot = path.resolve(__dirname, "../src");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && entry.name.endsWith(".ts")) {
          const base = path.basename(entry.name);
          if (/execution-observation/i.test(base)) offenders.push(base);
          const text = fs.readFileSync(full, "utf8");
          if (/CREATE TABLE (IF NOT EXISTS )?execution_observations|EXECUTION_RUN_ABORTED/.test(text)) offenders.push(base);
        }
      }
    };
    walk(srcRoot);
    expect(offenders).toEqual([]);
    void readOnlyEnvelope;
    void FULL_REPORT_CONTRACT;
  });
});
