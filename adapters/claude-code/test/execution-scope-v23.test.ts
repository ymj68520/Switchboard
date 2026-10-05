/**
 * E10 §61–§65 — execution-scope persistence + migration compatibility
 * (E10-T1..T5).
 *
 * Historical windows/directives/assessments/commits migrate scope_kind='stage'
 * with stage ids unchanged; final-closure artifacts carry scope_kind=
 * 'final_closure' with stage_id NULL; the shape biconditional is enforced at
 * the parse layer and the schema validator fails on raw corruption.
 */
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
  beginFinalClosure,
  boundaryFacts,
  completeAllStagesFixture,
  makeAcceptanceWorld,
  type FinalClosureWorld,
} from "./final-closure-helpers.js";
import { initializePlanStore } from "../src/store/sqlite-store.js";
import { inspectSchemaState } from "../src/store/schema.js";
import { parseVerificationWindowRow } from "../src/core/verification-window.js";
import { rawConnection, removeTempPluginDataRoot, storePathsFor } from "./store-helpers.js";

function pluginDataRootOf(store: { path: string }): string {
  return path.dirname(path.dirname(store.path));
}

let world: FinalClosureWorld | null = null;

async function freshBoundaryWorld(): Promise<FinalClosureWorld> {
  world = await makeAcceptanceWorld(`SC-${Math.random().toString(36).slice(2, 8)}`);
  completeAllStagesFixture(world);
  return world;
}

describe("E10 execution scope + migration (§61–§65)", () => {
  it("E10-T1: all pre-v23 windows migrate scope=stage with stageId unchanged", async () => {
    const w = await freshBoundaryWorld();
    const windows = w.ctx.store.withRead(
      (tx) =>
        tx
          .prepare("SELECT id, scope_kind AS scopeKind, stage_id AS stageId FROM verification_windows WHERE execution_run_id = ? ORDER BY opened_at")
          .all(w.executionRunId) as Array<{ id: string; scopeKind: string; stageId: string }>,
    );
    expect(windows.length).toBeGreaterThanOrEqual(2);
    for (const window of windows) {
      expect(window.scopeKind).toBe("stage");
      expect(window.stageId).not.toBeNull();
    }
  });

  it("E10-T3: historical assessments/commits keep their stage binding", async () => {
    const w = await freshBoundaryWorld();
    const assessments = w.ctx.store.withRead(
      (tx) =>
        tx
          .prepare("SELECT scope_kind AS scopeKind, stage_id AS stageId FROM supervisor_assessments WHERE execution_run_id = ?")
          .all(w.executionRunId) as Array<{ scopeKind: string; stageId: string }>,
    );
    const commits = w.ctx.store.withRead(
      (tx) =>
        tx
          .prepare("SELECT scope_kind AS scopeKind, stage_id AS stageId FROM execution_commits WHERE execution_run_id = ?")
          .all(w.executionRunId) as Array<{ scopeKind: string; stageId: string }>,
    );
    expect(assessments.length).toBeGreaterThanOrEqual(2);
    expect(commits.length).toBeGreaterThanOrEqual(2);
    for (const row of [...assessments, ...commits]) {
      expect(row.scopeKind).toBe("stage");
      expect(row.stageId).not.toBeNull();
    }
  });

  it("E10-T4: the final closure window and its artifacts carry scope=final_closure with stageId=null", async () => {
    const w = await freshBoundaryWorld();
    beginFinalClosure(w);
    const window = w.ctx.store.withRead(
      (tx) =>
        tx
          .prepare("SELECT scope_kind AS scopeKind, stage_id AS stageId, base_kind AS baseKind, base_commit_id AS baseCommitId, candidate_revision AS revision FROM verification_windows WHERE execution_run_id = ? AND closed_at IS NULL")
          .get(w.executionRunId) as { scopeKind: string; stageId: string | null; baseKind: string; baseCommitId: string; revision: number },
    );
    expect(window.scopeKind).toBe("final_closure");
    expect(window.stageId).toBeNull();
    expect(window.baseKind).toBe("execution_commit");
    expect(window.revision).toBe(0);
    // The boundary facts are untouched: the run is NOT completed by opening.
    const facts = boundaryFacts(w);
    expect(facts.lifecycle).toBe("active");
  });

  it("E10-T5: raw scope corruption fails the parse layer and the schema validator", async () => {
    // Parse layer: stage scope with null id / final_closure with an id are
    // STORE_SCHEMA_INVALID, never smuggled into the core (the detail names the
    // broken fields).
    const stageNull = (() => {
      try {
        parseVerificationWindowRow({ id: "w", runId: "r", scopeKind: "stage", stageId: null, candidateRevision: 0, openedAt: "t", closedAt: null, baseKind: "execution_start", baseCommitId: null, closureKind: null });
        return "no-error";
      } catch (err) {
        return err as Error;
      }
    })();
    expect(stageNull).toBeInstanceOf(Error);
    expect((stageNull as Error as unknown as { detail?: { fields?: string[] } }).detail?.fields).toContain("scope_shape");
    const finalWithStage = (() => {
      try {
        parseVerificationWindowRow({ id: "w", runId: "r", scopeKind: "final_closure", stageId: "stage_x", candidateRevision: 0, openedAt: "t", closedAt: null, baseKind: "execution_commit", baseCommitId: "ec", closureKind: null });
        return "no-error";
      } catch (err) {
        return err as Error;
      }
    })();
    expect(finalWithStage).toBeInstanceOf(Error);
    expect((finalWithStage as Error as unknown as { detail?: { fields?: string[] } }).detail?.fields).toContain("scope_shape");
    // Validator: hand-mangled persisted scope is inconsistent schema state.
    // The DDL scope trigger IS the first fence (a normal write refuses), so
    // the corruption is injected on a raw connection with the trigger dropped,
    // then the validator must still fail closed.
    const w = await freshBoundaryWorld();
    beginFinalClosure(w);
    const root = pluginDataRootOf(w.ctx.store);
    const databasePath = storePathsFor(root).databasePath;
    w.ctx.store.close();
    const raw = rawConnection(databasePath, 5000);
    try {
      raw.exec("PRAGMA foreign_keys = OFF");
      raw.exec("DROP TRIGGER IF EXISTS verification_windows_scope_update_shape");
      raw.exec("DROP TRIGGER IF EXISTS verification_windows_identity_immutable");
      raw.exec("UPDATE verification_windows SET stage_id = 'stage_ghost' WHERE scope_kind = 'final_closure'");
      const state = inspectSchemaState(raw);
      expect(state.consistent).toBe(false);
      expect(state.problems.some((problem) => /final-closure window/.test(problem))).toBe(true);
    } finally {
      raw.close();
    }
  });

  it("E10 §62: existing replan_required/active runs keep completion_commit_id NULL; no final window is fabricated", async () => {
    const w = await freshBoundaryWorld();
    const root = pluginDataRootOf(w.ctx.store);
    w.ctx.store.close();
    const store = await initializePlanStore({ pluginDataRoot: root });
    try {
      const runs = store.withRead(
        (tx) => tx.prepare("SELECT lifecycle, completion_commit_id AS completion FROM execution_runs").all() as Array<{ lifecycle: string; completion: string | null }>,
      );
      for (const run of runs) {
        expect(run.completion).toBeNull();
      }
      const finalWindows = store.withRead(
        (tx) => tx.prepare("SELECT count(*) AS n FROM verification_windows WHERE scope_kind = 'final_closure'").get() as { n: number },
      );
      expect(finalWindows.n).toBe(0);
    } finally {
      store.close();
      removeTempPluginDataRoot(storePathsFor(root).databasePath.includes("store") ? root : root);
    }
  });
});
