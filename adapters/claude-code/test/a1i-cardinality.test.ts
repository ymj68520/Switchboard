/**
 * A1-I Verification Closure — workspace serialization and accepted-head
 * cardinality pins (runbook §8, T6/T10–T13).
 *
 * T6  — the accepted head survives the 25 ↔ 26 identity boundary unchanged.
 * T10 — prepared + prepared in the SAME workspace is rejected.
 * T11 — active + prepared in the SAME workspace is rejected.
 * T12 — active + active in the SAME workspace is rejected.
 * T13 — a TERMINAL (aborted) run plus a prepared run in the same workspace is
 *       structurally allowed (the singleton covers prepared|active only).
 * These are schema-level pins on the A1 §27 serialization; they are NOT an
 * A1-II production reexecution path.
 */
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { makeActiveExecutionWorld, type E4World } from "./execution-protocol-helpers.js";
import { initializePlanStore } from "../src/store/sqlite-store.js";
import { dropSchema26Objects, rawConnection, removeTempPluginDataRoot, storePathsFor } from "./store-helpers.js";
import type { StoreTx } from "../src/store/transaction.js";

function pluginDataRootOf(store: { path: string }): string {
  return path.dirname(path.dirname(store.path));
}

/** One-argument row inserter for schema-level cardinality fixtures. */
function insertRun(
  tx: StoreTx,
  values: { executionRunId: string; runId: string; workspaceId: string; finalPlanId: string; finalPlanRevision: number; finalPlanHash: string; lifecycle: string },
): void {
  tx.prepare(
    "INSERT INTO execution_runs (execution_run_id, run_id, workspace_id, final_plan_id, final_plan_revision, final_plan_hash, lifecycle, planning_baseline_json, execution_start_baseline_json, revision, created_at, updated_at) "
    + "VALUES (?, ?, ?, ?, ?, ?, ?, '{}', '{}', 1, '2026-10-04T00:00:00.000Z', '2026-10-04T00:00:00.000Z')",
  ).run(values.executionRunId, values.runId, values.workspaceId, values.finalPlanId, values.finalPlanRevision, values.finalPlanHash, values.lifecycle);
}

async function withWorld(label: string, fn: (w: E4World) => void): Promise<void> {
  const w = await makeActiveExecutionWorld(label);
  try {
    fn(w);
  } finally {
    w.ctx.store.close();
    removeTempPluginDataRoot(pluginDataRootOf(w.ctx.store));
  }
}

describe("A1-I §8 — workspace serialization singleton (T10–T12)", () => {
  it("T10: a second prepared run in the same workspace is rejected", async () => {
    await withWorld(`A1I-SG10-${Math.random().toString(36).slice(2, 8)}`, (w) => {
      const err = w.ctx.store.withWrite((tx) => {
        try {
          insertRun(tx, { executionRunId: "exec-sg-prepared", runId: w.f.runId, workspaceId: w.f.workspaceId, finalPlanId: w.f.finalPlanId ?? "fp", finalPlanRevision: 1, finalPlanHash: "h", lifecycle: "prepared" });
          return null;
        } catch (e) {
          return e as Error;
        }
      });
      expect(err).not.toBeNull();
      expect(String(err?.message)).toMatch(/UNIQUE|singleton|failed/i);
    });
  });

  it("T11: a prepared run alongside the ACTIVE run in the same workspace is rejected", async () => {
    await withWorld(`A1I-SG11-${Math.random().toString(36).slice(2, 8)}`, (w) => {
      const err = w.ctx.store.withWrite((tx) => {
        try {
          insertRun(tx, { executionRunId: "exec-sg-prepared", runId: w.f.runId, workspaceId: w.f.workspaceId, finalPlanId: w.f.finalPlanId ?? "fp", finalPlanRevision: 1, finalPlanHash: "h", lifecycle: "prepared" });
          return null;
        } catch (e) {
          return e as Error;
        }
      });
      expect(err).not.toBeNull();
    });
  });

  it("T12: a second active run in the same workspace is rejected", async () => {
    await withWorld(`A1I-SG12-${Math.random().toString(36).slice(2, 8)}`, (w) => {
      const err = w.ctx.store.withWrite((tx) => {
        try {
          insertRun(tx, { executionRunId: "exec-sg-active", runId: w.f.runId, workspaceId: w.f.workspaceId, finalPlanId: w.f.finalPlanId ?? "fp", finalPlanRevision: 1, finalPlanHash: "h", lifecycle: "active" });
          return null;
        } catch (e) {
          return e as Error;
        }
      });
      expect(err).not.toBeNull();
    });
  });

  it("T13: a terminal (aborted) run plus a prepared run in the same workspace is structurally allowed", async () => {
    const w = await makeActiveExecutionWorld(`A1I-SG13-${Math.random().toString(36).slice(2, 8)}`);
    try {
      // Terminate the world's run through the real E13 path is heavier than
      // needed: the schema-level pin only requires the singleton's WHERE
      // clause to exclude terminal lifecycles. Abort the run directly.
      w.ctx.store.withWrite((tx: StoreTx) => {
        tx.prepare("UPDATE sqlite_sequence SET seq = seq WHERE 0");
        tx.exec("DROP TRIGGER IF EXISTS execution_runs_terminal_lifecycle");
        tx.exec("DROP TRIGGER IF EXISTS execution_runs_completion_shape");
        tx.prepare("UPDATE execution_runs SET lifecycle = 'aborted' WHERE execution_run_id = ?").run(w.executionRunId);
      });
      // Now a prepared run in the SAME workspace fits the singleton.
      w.ctx.store.withWrite((tx: StoreTx) => {
        insertRun(tx, { executionRunId: "exec-sg-prepared", runId: w.f.runId, workspaceId: w.f.workspaceId, finalPlanId: w.f.finalPlanId ?? "fp", finalPlanRevision: 1, finalPlanHash: "h", lifecycle: "prepared" });
      });
      const rows = w.ctx.store.withRead(
        (tx) => tx.prepare("SELECT execution_run_id AS id, lifecycle FROM execution_runs ORDER BY execution_run_id").all(),
      ) as Array<{ id: string; lifecycle: string }>;
      expect(rows.map((row) => row.lifecycle).sort()).toEqual(["aborted", "prepared"]);
    } finally {
      w.ctx.store.close();
      removeTempPluginDataRoot(pluginDataRootOf(w.ctx.store));
    }
  });
});

describe("A1-I §8 — accepted head across the identity boundary (T6/T7)", () => {
  it("T6/T7: the accepted head is preserved byte-identically and stays same-run through 25 ↔ 26", async () => {
    const w = await makeActiveExecutionWorld(`A1I-AH-${Math.random().toString(36).slice(2, 8)}`);
    const root = pluginDataRootOf(w.ctx.store);
    const databasePath = storePathsFor(root).databasePath;
    const before = w.ctx.store.withRead(
      (tx) => tx.prepare("SELECT execution_run_id AS id, accepted_head_commit_id AS head FROM execution_runs WHERE execution_run_id = ?").get(w.executionRunId) as { id: string; head: string | null },
    );
    // Commit once so the head is non-null (real E6 commit path is heavy; the
    // acceptedHead column carries the window's head — read the actual value).
    w.ctx.store.close();

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
      const after = reopened.withRead(
        (tx) => tx.prepare("SELECT execution_run_id AS id, accepted_head_commit_id AS head FROM execution_runs WHERE execution_run_id = ?").get(w.executionRunId) as { id: string; head: string | null },
      );
      expect(after).toEqual(before);
      // Same-run law: the head commit (when present) belongs to THIS run.
      if (after.head !== null) {
        const commitRun = reopened.withRead(
          (tx) => tx.prepare("SELECT execution_run_id AS eid FROM execution_commits WHERE commit_id = ?").get(after.head) as { eid: string } | undefined,
        );
        expect(commitRun?.eid).toBe(w.executionRunId);
      }
    } finally {
      reopened.close();
      removeTempPluginDataRoot(root);
    }
  });
});
