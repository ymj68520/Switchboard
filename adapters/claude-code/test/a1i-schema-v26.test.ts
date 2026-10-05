/**
 * A1-I Verification Closure — schema v26 formal gates (runbook §3/§4/§5).
 *
 * A — the 60-object SCHEMA_V26_OBJECTS presence probe runs as a formal test
 *     (not only inside validateSchemaV26), with a fail-closed negative for a
 *     missing critical trigger and a missing invariant index.
 * B — the machine-derived v25→v26 object matrix: every v25 table that carried
 *     an execution-scoped run_id (FK → execution_runs) is classified as
 *     rebuilt re-key/dual (22), Class-D initial-delivery metadata (4), or
 *     unchanged; the 2 indirect FK children complete the 24 rebuilt objects.
 *     Nothing may remain unclassified (runbook §3 — otherwise NOT CLOSED).
 * C — the v26 validator carries every v14–v25 invariant family (static pin on
 *     the validateSchemaV26 body — the runbook §5 forward matrix evidence).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { makeActiveExecutionWorld } from "./execution-protocol-helpers.js";
import { initializePlanStore } from "../src/store/sqlite-store.js";
import type { StoreTx } from "../src/store/transaction.js";
import { SCHEMA_V26_OBJECTS, assertSchemaState, setSchemaVersion } from "../src/store/schema.js";
import { createProductionMigrations } from "../src/store/migrations/index.js";
import { v26RebuiltTableNames } from "../src/store/migrations/026-execution-run-identity-foundation.js";
import {
  dropSchema26Objects,
  makeTempPluginDataRoot,
  rawConnection,
  removeTempPluginDataRoot,
  storePathsFor,
} from "./store-helpers.js";

interface TableInfoRow {
  name: string;
  type: string;
  sql: string | null;
}

function tableNames(raw: ReturnType<typeof rawConnection>): string[] {
  return (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as unknown as TableInfoRow[])
    .map((row) => row.name)
    .sort();
}

function tableDdl(raw: ReturnType<typeof rawConnection>): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of raw.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as unknown as TableInfoRow[]) {
    map.set(row.name, row.sql ?? "");
  }
  return map;
}

function columns(raw: ReturnType<typeof rawConnection>, table: string): Set<string> {
  return new Set(
    (raw.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>).map((column) => column.name),
  );
}

/** Tables whose v25 shape held FOREIGN KEY (run_id) → execution_runs(run_id). */
function runIdFkTargetsOfExecutionRuns(raw: ReturnType<typeof rawConnection>): string[] {
  const found: string[] = [];
  for (const table of tableNames(raw)) {
    const fks = raw.prepare(`PRAGMA foreign_key_list('${table}')`).all() as Array<{ table: string; from: string; to: string | null }>;
    if (fks.some((fk) => fk.table === "execution_runs" && fk.from === "run_id" && (fk.to === null || fk.to === "run_id"))) {
      found.push(table);
    }
  }
  return found.sort();
}

/** Post-v26: no child may keep an FK on execution_runs(run_id) (A1-I47/T5). */
function fkDomainViolations(raw: ReturnType<typeof rawConnection>): string[] {
  const violations: string[] = [];
  for (const table of tableNames(raw)) {
    const fks = raw.prepare(`PRAGMA foreign_key_list('${table}')`).all() as Array<{ table: string; from: string; to: string | null }>;
    for (const fk of fks) {
      if (fk.table !== "execution_runs") continue;
      if ((fk.to ?? "") === "run_id") violations.push(`${table}.(${fk.from})→execution_runs(run_id)`);
      if ((fk.to ?? "") !== "execution_run_id" && (fk.to ?? "") !== "run_id") violations.push(`${table}.(${fk.from})→execution_runs(${String(fk.to)})`);
    }
  }
  return violations;
}

describe("A1-I §4 — SCHEMA_V26_OBJECTS formal presence probe", () => {
  it("A1I-T64a: a fresh v26 store carries the full required constraint-object inventory with the right kinds", async () => {
    // The runbook's "60-object" inventory ships with 63 entries (the three
    // A1-I abort/immutability triggers landed in the same block); live schema
    // is the final fact — the count is pinned here so any drift is a test
    // failure, never a silent shrink.
    expect(SCHEMA_V26_OBJECTS.length).toBe(63);
    const w = await makeActiveExecutionWorld(`A1I-OBJ-${Math.random().toString(36).slice(2, 8)}`);
    try {
      const present = new Set(
        (
          w.ctx.store.withRead(
            (tx) => tx.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('trigger','index')").all() as Array<{ name: string; type: string }>,
          )
        ).map((row) => `${row.name}:${row.type}`),
      );
      const missing: string[] = [];
      for (const name of SCHEMA_V26_OBJECTS) {
        const kind = name.startsWith("idx_") ? "index" : "trigger";
        if (!present.has(`${name}:${kind}`)) missing.push(`${name} (${kind})`);
      }
      expect(missing).toEqual([]);
    } finally {
      w.ctx.store.close();
      removeTempPluginDataRoot(path.dirname(path.dirname(w.ctx.store.path)));
    }
  });

  it("A1I-T64b: a missing critical immutability trigger fails schema validation closed on reopen", async () => {
    const root = makeTempPluginDataRoot("a1i-neg-trigger-");
    try {
      const store = await initializePlanStore({ pluginDataRoot: root });
      store.close();
      const databasePath = storePathsFor(root).databasePath;
      const raw = rawConnection(databasePath, 5000);
      try {
        raw.exec("DROP TRIGGER execution_directives_no_update");
      } finally {
        raw.close();
      }
      const err = (await initializePlanStore({ pluginDataRoot: root }).catch((e) => e)) as {
        code?: string;
        message?: string;
        detail?: { problems?: string[] };
      };
      expect(err.code).toBe("STORE_SCHEMA_INVALID");
      expect(`${(err.detail?.problems ?? []).join("; ")}${err.message ?? ""}`).toContain("execution_directives_no_update");
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("A1I-T64c: a missing invariant index (workspace singleton) fails schema validation closed on reopen", async () => {
    const root = makeTempPluginDataRoot("a1i-neg-index-");
    try {
      const store = await initializePlanStore({ pluginDataRoot: root });
      store.close();
      const databasePath = storePathsFor(root).databasePath;
      const raw = rawConnection(databasePath, 5000);
      try {
        raw.exec("DROP INDEX idx_execution_runs_workspace_singleton");
      } finally {
        raw.close();
      }
      const err = (await initializePlanStore({ pluginDataRoot: root }).catch((e) => e)) as {
        code?: string;
        message?: string;
        detail?: { problems?: string[] };
      };
      expect(err.code).toBe("STORE_SCHEMA_INVALID");
      expect(`${(err.detail?.problems ?? []).join("; ")}${err.message ?? ""}`).toContain("idx_execution_runs_workspace_singleton");
    } finally {
      removeTempPluginDataRoot(root);
    }
  });
});

describe("A1-I §3 — machine-derived v26 object matrix (26+2 → 24 reconciliation)", () => {
  /** A GENUINE v25 store: the production chain driven manually up to 25 (the
   * runner itself has no partial-target notion — it always applies the full
   * chain and stamps the target), with the versioned validators run at rest.
   * The v25 FK graph is therefore real historical DDL, not the rewind-hybrid
   * shape, and the V14–V25 validators are proven against a genuine v25 store. */
  async function buildGenuineStore(root: string, targetVersion: number) {
    const paths = storePathsFor(root);
    fs.mkdirSync(paths.storeDir, { recursive: true });
    const db = rawConnection(paths.databasePath, 5000);
    const current = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    const chain = createProductionMigrations({
      generateStoreId: () => "store-a1i-matrix",
      nowIso: () => "2026-10-04T00:00:00.000Z",
    }).filter((migration) => migration.from >= current && migration.to <= targetVersion);
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const migration of chain) {
        migration.apply(db as unknown as StoreTx);
        db.prepare("INSERT INTO schema_migrations (version, name, applied_at, runtime_version) VALUES (?, ?, ?, ?)").run(
          migration.to,
          migration.name,
          "2026-10-04T00:00:00.000Z",
          "a1i-matrix-test",
        );
      }
      setSchemaVersion(db, targetVersion);
      assertSchemaState(db, paths.databasePath);
      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // the failure may have resolved the transaction already
      }
      db.close();
      throw err;
    }
    return db;
  }

  it("A1I-T3/T5: a genuine v25 store classifies exhaustively; rebuilt=24 (22 re-key + 2 indirect); FK domain re-keyed", async () => {
    const root = makeTempPluginDataRoot("a1i-mtx-");
    try {
      // ---- genuine v25 shape: the FK graph is real historical DDL ----
      const v25 = await buildGenuineStore(root, 25);
      let v26: ReturnType<typeof rawConnection> | null = null;
      try {
        const v25Tables = tableNames(v25);
        const v25Ddl = tableDdl(v25);
        const v25Cols = new Map(v25Tables.map((t) => [t, columns(v25, t)] as const));
        const v25RunIdFk = runIdFkTargetsOfExecutionRuns(v25);

        const rebuilt = [...v26RebuiltTableNames()].sort();
        expect(rebuilt.length).toBe(24);

        const rebuiltWithRunId = rebuilt.filter((t) => v25Cols.get(t)?.has("run_id")).sort();
        const rebuiltIndirect = rebuilt.filter((t) => !v25Cols.get(t)?.has("run_id")).sort();
        expect(rebuiltWithRunId.length).toBe(22);
        expect(rebuiltIndirect).toEqual(["execution_worker_invocation_events", "supervisor_assessment_report_judgments"]);

        // Class-D initial-delivery metadata (A1 §42): run_id-bearing, never
        // identity-rebuilt, immutable provenance of the initial handoff only.
        const classD = [
          "execution_bindings",
          "execution_handoff_events",
          "execution_handoff_states",
          "execution_handoffs",
        ];
        for (const table of classD) {
          expect(rebuilt.includes(table), `${table} must not be rebuilt`).toBe(false);
          expect(v25Cols.get(table)?.has("run_id") ?? false, `${table} carries run_id`).toBe(true);
        }

        // The v25 audit population: 22 rebuilt run_id-bearing + 4 Class-D = 26.
        const auditPopulation = [...rebuiltWithRunId, ...classD].sort();
        expect(auditPopulation.length).toBe(26);
        // Every declared run_id FK → execution_runs(run_id) lands inside the
        // population (16 of the 26 declare the constraint; the rest bind by
        // construction in the same rebuild transaction).
        for (const table of v25RunIdFk) {
          expect(auditPopulation.includes(table), `${table} FK→execution_runs outside the audit population`).toBe(true);
        }

        // Exhaustiveness over the whole execution estate: every execution-,
        // supervisor-, verification-, and control-domain table at v25 is
        // either rebuilt or Class-D. Nothing may remain unclassified.
        const estate = v25Tables.filter((t) => /^(execution_|supervisor_|verification_|run_control_)/.test(t));
        for (const table of estate) {
          expect(rebuilt.includes(table) || classD.includes(table), `unclassified estate table ${table}`).toBe(true);
        }

        // Dual-column Class-1 tables already carried execution_run_id at v25
        // (E9-era provenance) versus the pure re-key population.
        const dualAtV25 = rebuiltWithRunId.filter((t) => v25Cols.get(t)?.has("execution_run_id")).sort();
        const pureRekey = rebuiltWithRunId.filter((t) => !v25Cols.get(t)?.has("execution_run_id")).sort();
        expect(dualAtV25).toContain("execution_issues");
        expect(dualAtV25.length).toBeGreaterThanOrEqual(1);
        expect(pureRekey.length).toBeGreaterThanOrEqual(1);

        // The remaining tables (Class-D + planning estate) are untouched by 026.
        const unchanged = v25Tables.filter((t) => !rebuilt.includes(t));
        expect(unchanged.length).toBe(v25Tables.length - 24);

        // ---- the genuine 25 → 26 step ----
        v26 = await buildGenuineStore(root, 26);
        const v26Ddl = tableDdl(v26);
        // T5/A1-I47 — post-v26 FK domain: zero FKs target
        // execution_runs(run_id); execution ownership resolves via
        // execution_run_id only (dual tables' provenance run_id has no FK).
        expect(fkDomainViolations(v26)).toEqual([]);
        // Unchanged tables kept byte-identical DDL across the boundary.
        for (const table of unchanged) {
          expect(v26Ddl.get(table) ?? "", `table ${table} DDL`).toBe(v25Ddl.get(table) ?? "");
        }
        // The rebuilt run_id-bearing tables all carry the canonical scope now.
        for (const table of rebuiltWithRunId) {
          expect(columns(v26, table).has("execution_run_id"), table).toBe(true);
        }
      } finally {
        v25.close();
        v26?.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("A1I-T1/T2/T4: a real data world survives the 25↔26 identity boundary with identity, mapping, and counts intact", async () => {
    const w = await makeActiveExecutionWorld(`A1I-PRES-${Math.random().toString(36).slice(2, 8)}`);
    const root = path.dirname(path.dirname(w.ctx.store.path));
    const databasePath = storePathsFor(root).databasePath;

    const v26Runs = w.ctx.store.withRead(
      (tx) => tx.prepare("SELECT execution_run_id AS id, run_id AS provenance, workspace_id AS ws FROM execution_runs ORDER BY execution_run_id").all(),
    ) as Array<{ id: string; provenance: string; ws: string }>;
    const countTables = (tx: StoreTx) =>
      Object.fromEntries(
        (
          tx.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>
        ).map((row) => [row.name, (tx.prepare(`SELECT count(*) AS n FROM "${row.name}"`).get() as { n: number }).n]),
      ) as Record<string, number>;
    const v26Counts = w.ctx.store.withRead(countTables);
    w.ctx.store.close();

    // Down through the A1 identity boundary, then back up through 026.
    const raw = rawConnection(databasePath, 5000);
    try {
      dropSchema26Objects(raw);
      raw.exec("DELETE FROM schema_migrations WHERE version > 25");
      raw.exec("PRAGMA user_version = 25");
    } finally {
      raw.close();
    }

    const reopened = await initializePlanStore({ pluginDataRoot: root });
    try {
      expect(reopened.getSchemaVersion()).toBe(26);
      const afterRuns = reopened.withRead(
        (tx) => tx.prepare("SELECT execution_run_id AS id, run_id AS provenance, workspace_id AS ws FROM execution_runs ORDER BY execution_run_id").all(),
      ) as Array<{ id: string; provenance: string; ws: string }>;
      expect(afterRuns).toEqual(v26Runs);
      const afterCounts = reopened.withRead(countTables);
      for (const [table, n] of Object.entries(v26Counts)) {
        expect(afterCounts[table], `row count of ${table} across the 25↔26 boundary`).toBe(n);
      }
    } finally {
      reopened.close();
      removeTempPluginDataRoot(root);
    }
  });
});

describe("A1-I §5 — validator forward matrix (v14–v25 → v26 static pin)", () => {
  it("A1I-T5m: validateSchemaV26 carries every frozen invariant family by name", async () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "store", "schema.ts"), "utf8");
    const start = source.indexOf("function validateSchemaV26(");
    expect(start).toBeGreaterThan(0);
    const body = source.slice(start, source.indexOf("\nfunction ", start + 10) === -1 ? source.length : source.indexOf("\nfunction ", start + 10));

    const markers: Array<[string, string]> = [
      // v14 run-root integrity
      ["FinalPlan binding", "is not bound to an exact FinalPlan revision"],
      ["workspace/planning binding", "references a missing workspace or a foreign run workspace"],
      ["lifecycle revision law", "left 'prepared' without a revision advance"],
      ["PREPARED history", "lifecycle history does not start at PREPARED"],
      // v15 SupervisorBinding integrity
      ["binding exact-run scope", "names a missing execution run or a foreign w"],
      ["supervision singleton", "holds multiple attached supervision bind"],
      ["ATTACHED history", "ownership history does not start at ATT"],
      // v16 stage/window structure
      ["stage exact-run scope", "names a missing execution run"],
      ["window scope shape", "has a cross-run stage, a broken scope, or a missin"],
      ["single active stage", "holds multiple active stages"],
      ["single open window", "holds multiple open verification windows"],
      // v17 directive/attempt/report protocol integrity
      ["directive exact-run scope", "names a missing execution run or lacks its e"],
      ["attempt/directive binding", "binds a missing or mismatched Directive revision"],
      ["report/attempt binding", "binds a missing or mismatched Attempt"],
      ["single running attempt", "holds multiple running attempts"],
      ["one attempt per revision", "holds multiple"],
      // v18 worker invocation integrity
      ["invocation authority chain", "binds a missing or mismatched attempt"],
      ["worker claim singleton", "holds multiple claimed invocations"],
      // v19 acceptance integrity
      ["assessment binding", "binds a missing or mismatched run/stage/wind"],
      ["judgment provenance", "carries a judgment for a foreign or missing report"],
      ["commit shape", "binds a mismatched stage/window/revision"],
      ["commit parent chain", "has a broken or cross-run parent link"],
      ["acceptedHead same-run", "holds a foreign or missing accepted head"],
      ["window accepted base", "binds a foreign or missing accepted-base commit"],
      ["open window carries no commit", "already carries an execution commit"],
      // v20 stage completion provenance
      ["stage completion exact-run", "completed without exact same-run/same"],
      ["completed stage owns no open window", "still owns an open verification window"],
      // v21 verification policy / conflict integrity
      ["v1 policy fabrication", "carries a fabricated verification policy"],
      ["v2+ policy legality", "violates the verification-policy legality"],
      ["conflict claim", "claims a foreign or non-current report"],
      ["conflict resolver", "carries a mismatched resolver directive bindin"],
      ["conflict settlement", "settled on a missing or non-completing resol"],
      // v23 execution scope / final closure
      ["final-closure window shape", "has a broken base, scope, or closure/lifecyc"],
      ["completion provenance", "has broken completion provenance or post-completion s"],
      // v24 reconciliation
      ["reconciliation binding", "targets a missing/foreig"],
      ["reconciliation resolution", "has a broken resolution/repor"],
      // v25 abort provenance
      ["abort fact", "disagrees with its abort provenance (E13"],
      ["abort authorization", "references a missing/foreign/non-abort run-control aut"],
      ["aborted carries no completion", "carries completion provenance (E13"],
      ["terminal owns no open window", "still owns an open verification window"],
      ["aborted window shape", "disagrees with its run lifecycle or carries a commit"],
      // A1-I additions
      ["FK domain (A1-I47)", "keeps a foreign key on execution_runs(run_id)"],
      ["exact-run scope column (A1-I4)", "lost the execution_run_id scope column"],
      ["typed control shapes", "violates its typed target shape (A1"],
      ["directives v4 columns", "lost the"],
      ["workspace nonterminal singleton", "holds multiple nonterminal execution runs (A1"],
    ];
    const missing: string[] = [];
    for (const [label, marker] of markers) {
      if (!body.includes(marker)) missing.push(`${label}: "${marker}"`);
    }
    expect(missing).toEqual([]);
    // The 60-object presence-probe block runs inside the same validator open
    // path (its absence message is part of the v26 contract).
    expect(body).toContain("missing for schema version >= 26 (A1-I)");
  });
});
