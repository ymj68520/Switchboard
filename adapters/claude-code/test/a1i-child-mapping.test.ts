/**
 * A1-I Verification Closure — canonical T2/T8 data-preservation proof
 * (evidence-only closure round; minimal missing assertions).
 *
 * T2 — EVERY rebuilt execution-child family maps to the exact historical
 *      ExecutionRunID after the real 25 → 26 migration (data-level, not
 *      schema inventory): each row dump is byte-identical across the
 *      boundary, and every carried execution_run_id resolves to the exact
 *      historical run.
 * T8 — the accepted commit chain (commit_id, sequence, parent_commit_id,
 *      whole row) is unchanged through the migration, and the accepted head
 *      is a REAL non-null commit of the SAME run (also strengthens the
 *      T6/T7 citations in a1i-cardinality, which prove the column law on a
 *      possibly-null head).
 */
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
  acceptInput,
  acceptanceServiceOf,
  makeAcceptanceWorld,
  openSuccessorWindow,
  runVerificationCycle,
  runDirectiveCycle,
  type AcceptanceWorld,
} from "./acceptance-helpers.js";
import { initializePlanStore } from "../src/store/sqlite-store.js";
import { v26RebuiltTableNames } from "../src/store/migrations/026-execution-run-identity-foundation.js";
import { dropSchema26Objects, rawConnection, removeTempPluginDataRoot, storePathsFor } from "./store-helpers.js";
import type { StoreTx } from "../src/store/transaction.js";

function pluginDataRootOf(store: { path: string }): string {
  return path.dirname(path.dirname(store.path));
}

type Rows = Record<string, unknown>[];

/** Full row dump of one table, deterministically ordered by rowid. */
function dumpTable(tx: StoreTx, table: string): Rows {
  return tx.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all() as Rows;
}

describe("A1-I canonical T2/T8 — child→run mapping and commit chain across the real 25 → 26 migration", () => {
  it("T2/T8: every rebuilt family maps to the exact historical ExecutionRunID and the accepted commit chain is byte-identical", async () => {
    // A world with REAL execution memory: directives, attempts, reports, and
    // an accepted two-commit chain (EC seq 1 → seq 2, real parent link) via
    // the real E6 accept path.
    const w: AcceptanceWorld = await makeAcceptanceWorld(`A1I-MAP-${Math.random().toString(36).slice(2, 8)}`);
    const root = pluginDataRootOf(w.ctx.store);
    try {
      runVerificationCycle(w);
      const first = acceptanceServiceOf(w).submitSupervisorAssessment(acceptInput(w) as never);
      expect(first.commit?.sequence).toBe(1);
      openSuccessorWindow(w);
      runDirectiveCycle(w, { directiveId: "DIR-MAP-2", kind: "implementation", reportOverrides: { candidate_mutated: true } });
      runVerificationCycle(w);
      const second = acceptanceServiceOf(w).submitSupervisorAssessment(acceptInput(w) as never);
      expect(second.commit?.sequence).toBe(2);
      expect(second.commit?.parentCommitId).toBe(first.commit!.commitId);

      const runId = w.executionRunId;
      const rebuilt = v26RebuiltTableNames();
      expect(rebuilt.length).toBe(24);
      const beforeCommits = w.ctx.store.withRead((tx) => dumpTable(tx, "execution_commits"));
      const beforeHead = w.ctx.store.withRead(
        (tx) => tx.prepare("SELECT execution_run_id AS id, accepted_head_commit_id AS head FROM execution_runs WHERE execution_run_id = ?").get(runId) as { id: string; head: string | null },
      );
      // The head is a REAL commit of THIS run (non-null precondition).
      expect(beforeHead.head).toBe(second.commit!.commitId);
      const beforeDumps = Object.fromEntries(
        rebuilt.map((table) => [table, w.ctx.store.withRead((tx) => dumpTable(tx, table))]),
      ) as Record<string, Rows>;
      // Precondition: the migrated families actually carry data in this world
      // (the proof is vacuous on an empty estate).
      const nonEmpty = rebuilt.filter((table) => (beforeDumps[table] as Rows).length > 0);
      expect(nonEmpty.length).toBeGreaterThanOrEqual(10);
      w.ctx.store.close();

      // Real 25 → 26: rewind presents a v25 store, the reopen replays 026.
      const raw = rawConnection(storePathsFor(root).databasePath, 5000);
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

        // T8 — the commit chain is unchanged: whole-row equality.
        const afterCommits = reopened.withRead((tx) => dumpTable(tx, "execution_commits"));
        expect(afterCommits).toEqual(beforeCommits);
        const chain = afterCommits as Array<Record<string, unknown>>;
        expect(chain.map((row) => [row.commit_id, row.sequence, row.parent_commit_id])).toEqual([
          [first.commit!.commitId, 1, null],
          [second.commit!.commitId, 2, first.commit!.commitId],
        ]);

        // T6/T7 (real, non-null) — the accepted head survived and belongs to
        // THIS exact run.
        const afterHead = reopened.withRead(
          (tx) => tx.prepare("SELECT execution_run_id AS id, accepted_head_commit_id AS head FROM execution_runs WHERE execution_run_id = ?").get(runId) as { id: string; head: string | null },
        );
        expect(afterHead).toEqual(beforeHead);
        expect(afterHead.head).toBe(second.commit!.commitId);

        // T2 — every rebuilt family: rows byte-identical across the
        // boundary, and every carried execution_run_id is the EXACT
        // historical run (mapping to the unique exact Run, data-level).
        // Tables keyed through their parent (the 2 indirect FK children)
        // carry no execution_run_id column of their own: their byte-identity
        // plus the v26 parent FK prove the same mapping transitively.
        for (const table of rebuilt) {
          const afterRows = reopened.withRead((tx) => dumpTable(tx, table));
          expect(afterRows, `rows of ${table} across 25→26`).toEqual(beforeDumps[table]);
          const scoped = afterRows as Array<Record<string, unknown>>;
          const carriesColumn = scoped.some((row) => "execution_run_id" in row)
            || (reopened.withRead(
              (tx) => tx.prepare(`SELECT count(*) AS n FROM pragma_table_info('${table}') WHERE name = 'execution_run_id'`).get() as { n: number },
            ).n > 0);
          if (!carriesColumn) continue;
          // An empty family maps vacuously (byte-identity above still proves
          // preservation); a non-empty family maps EXACTLY to this run.
          const distinctRuns = [...new Set(scoped.map((row) => row.execution_run_id))];
          expect(distinctRuns, `${table} execution_run_id domain`).toEqual(scoped.length === 0 ? [] : [runId]);
        }
      } finally {
        reopened.close();
      }
    } finally {
      w.ctx.store.close();
      removeTempPluginDataRoot(root);
    }
  });
});
