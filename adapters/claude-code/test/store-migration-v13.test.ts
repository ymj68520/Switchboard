/**
 * Migration 12 → 13 — run-control-authorizations (Phase 16 directive §52–§54,
 * E1/E64/E65): a real schema-12 store carrying the full Phase 15 world
 * (active successor run + binding, detached completed predecessor, FinalPlan,
 * delivered handoff, ExecutionBinding, ExecutionIssue, successor baseline)
 * migrates with every old row unchanged and the control table empty; a
 * failing 013 rolls back to a valid schema-12 store; a too-new writer is
 * fenced with zero writes.
 */
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { createProductionMigrations, type StoreMigration } from "../src/store/migrations/index.js";
import { SUPPORTED_SCHEMA_VERSION } from "../src/store/constants.js";
import { initializePlanStore, type PlanStore } from "../src/store/sqlite-store.js";
import { getPlanningRunBaselineForSuccessorInTx, listBaselineScopesInTx } from "../src/store/successor-baselines.js";
import { createExecutionIssueService } from "../src/application/execution-issue-service.js";
import { createSuccessorRunService } from "../src/application/successor-run-service.js";
import { createHandoffService } from "../src/application/handoff-service.js";
import { callHandoff, makeApprovedFinalPlanFixture, type ApprovedFinalPlanFixture } from "./phase14-helpers.js";
import type { PhasePlanToolContext } from "../src/mcp/tools.js";
import { fixedClock, makeTempPluginDataRoot, publishedBackups, rawConnection, removeTempPluginDataRoot, storePathsFor, dropSchema13Objects } from "./store-helpers.js";

function pluginDataRootOf(store: PlanStore): string {
  return path.dirname(path.dirname(store.path));
}

/** Force a v13+ store back to a genuine schema-12 state (drop the v13 domain). */
function rewindToSchema12(databasePath: string): void {
  const raw = rawConnection(databasePath, 5000);
  try {
    dropSchema13Objects(raw);
    raw.exec("DELETE FROM schema_migrations WHERE version >= 13");
    raw.exec("PRAGMA user_version = 12");
  } finally {
    raw.close();
  }
}

function rawSchemaVersion(databasePath: string): number {
  const raw = rawConnection(databasePath, 5000);
  try {
    const row = raw.prepare("PRAGMA user_version").get() as Record<string, unknown>;
    return Object.values(row)[0] as number;
  } finally {
    raw.close();
  }
}

interface Phase15World {
  f: ApprovedFinalPlanFixture;
  ctx: PhasePlanToolContext;
  successorRunId: string;
  issueId: string;
}

/** The full §52 fixture world: delivered predecessor + issue + successor baseline. */
async function makePhase15World(sessionId = "S1"): Promise<Phase15World> {
  const { f, ctx } = await makeApprovedFinalPlanFixture(sessionId);
  const prepared = callHandoff(ctx, f, { toolUseId: `${sessionId}-DELIVER-1` });
  createHandoffService(ctx.store, ctx.clock).finalizeDelivery({
    runId: f.runId,
    sessionId: f.sessionId,
    toolUseId: `${sessionId}-DELIVER-1`,
    responseHandoffId: prepared.handoff_id,
    responseHandoffHash: prepared.handoff_hash,
  });
  const issue = createExecutionIssueService(ctx.store, ctx.clock).reportIssue({
    runId: f.runId,
    workspaceId: f.workspaceId,
    workspaceRoot: f.workspaceRoot,
    sessionId: f.sessionId,
    toolUseId: `${sessionId}-ISSUE-1`,
    finalPlanId: f.finalPlanId,
    executionBindingGeneration: 1,
    kind: "section_contract",
    summary: "live fixture conflict",
    detail: "the delivered contract cannot be implemented as approved",
    affectedRefs: [{ type: "section", id: "SEC-1", revision: 1 }],
  });
  const successor = createSuccessorRunService(ctx.store, ctx.clock).createSuccessor({
    workspaceId: f.workspaceId,
    sessionId: f.sessionId,
  });
  return { f, ctx, successorRunId: successor.successorRun.runId, issueId: issue.issueId };
}

describe("migration 12 → 13 run-control-authorizations (§52–§54, E1/E64/E65)", () => {
  it("migrates the full Phase 15 world: every old row unchanged, run_control_authorizations empty, history [1..13] (§52/E1)", async () => {
    const world = await makePhase15World();
    const root = pluginDataRootOf(world.ctx.store);
    try {
      const databasePath = storePathsFor(root).databasePath;
      // Snapshot the pre-migration v12 world.
      const before = {
        runs: world.ctx.store.withRead((tx) => tx.prepare("SELECT run_id AS id, lifecycle, stage, revision FROM planning_runs ORDER BY run_id").all()),
        issues: world.ctx.store.withRead((tx) => tx.prepare("SELECT * FROM execution_issues ORDER BY issue_id").all()),
        baselines: world.ctx.store.withRead((tx) => tx.prepare("SELECT * FROM planning_run_baselines ORDER BY baseline_id").all()),
        scopes: world.ctx.store.withRead((tx) => tx.prepare("SELECT * FROM planning_run_baseline_scopes ORDER BY baseline_id, section_id").all()),
        finalPlans: world.ctx.store.withRead((tx) => tx.prepare("SELECT final_plan_id, final_plan_hash, canonical_json FROM final_plans ORDER BY final_plan_id").all()),
        handoffs: world.ctx.store.withRead((tx) => tx.prepare("SELECT handoff_id, handoff_hash, canonical_json FROM execution_handoffs ORDER BY handoff_id").all()),
        bindings: world.ctx.store.withRead((tx) => tx.prepare("SELECT * FROM execution_bindings ORDER BY run_id").all()),
        commits: world.ctx.store.withRead((tx) => tx.prepare("SELECT * FROM plan_commits ORDER BY commit_id").all()),
        sessions: world.ctx.store.withRead((tx) => tx.prepare("SELECT * FROM session_bindings ORDER BY run_id").all()),
      };
      world.ctx.store.close();
      rewindToSchema12(databasePath);

      const store = await initializePlanStore({ pluginDataRoot: root });
      try {
        expect(store.getSchemaVersion()).toBe(SUPPORTED_SCHEMA_VERSION);
        const same = <T>(a: T, b: T) => expect(b).toEqual(a);
        same(before.runs, store.withRead((tx) => tx.prepare("SELECT run_id AS id, lifecycle, stage, revision FROM planning_runs ORDER BY run_id").all()));
        same(before.issues, store.withRead((tx) => tx.prepare("SELECT * FROM execution_issues ORDER BY issue_id").all()));
        same(before.baselines, store.withRead((tx) => tx.prepare("SELECT * FROM planning_run_baselines ORDER BY baseline_id").all()));
        same(before.scopes, store.withRead((tx) => tx.prepare("SELECT * FROM planning_run_baseline_scopes ORDER BY baseline_id, section_id").all()));
        same(before.finalPlans, store.withRead((tx) => tx.prepare("SELECT final_plan_id, final_plan_hash, canonical_json FROM final_plans ORDER BY final_plan_id").all()));
        same(before.handoffs, store.withRead((tx) => tx.prepare("SELECT handoff_id, handoff_hash, canonical_json FROM execution_handoffs ORDER BY handoff_id").all()));
        same(before.bindings, store.withRead((tx) => tx.prepare("SELECT * FROM execution_bindings ORDER BY run_id").all()));
        same(before.commits, store.withRead((tx) => tx.prepare("SELECT * FROM plan_commits ORDER BY commit_id").all()));
        same(before.sessions, store.withRead((tx) => tx.prepare("SELECT * FROM session_bindings ORDER BY run_id").all()));
        // §52 — the control table exists and starts EMPTY; no backfill.
        expect(store.withRead((tx) => tx.prepare("SELECT COUNT(*) AS n FROM run_control_authorizations").get())).toEqual({ n: 0 });
        // The migrated seam stays live: successor baseline + scopes readable.
        const baseline = store.withRead((tx) => getPlanningRunBaselineForSuccessorInTx(tx, world.successorRunId));
        expect(baseline).not.toBeNull();
        expect(store.withRead((tx) => listBaselineScopesInTx(tx, baseline!.baselineId)).length).toBeGreaterThan(0);
        // The issue was ADOPTED by the successor (open == no adoption row), so
        // the durable fact is the issue row itself.
        expect((store.withRead((tx) => tx.prepare("SELECT COUNT(*) AS n FROM execution_issues").get()) as { n: number }).n).toBe(1);
      } finally {
        store.close();
      }
      const raw = rawConnection(databasePath, 5000);
      try {
        const rows = raw.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>;
        expect(rows.map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
      } finally {
        raw.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("failing-013 rolls back to a fully valid schema-12 store — no partial control tables/triggers (§53/E65)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { databasePath, backupsDir } = storePathsFor(root);
      const probe = await initializePlanStore({ pluginDataRoot: root });
      probe.close();
      rewindToSchema12(databasePath);

      const clock = fixedClock();
      const failing: StoreMigration = {
        from: 12,
        to: 13,
        name: "run-control-authorizations",
        apply(tx) {
          tx.exec("CREATE TABLE half_created_control (x TEXT)");
          throw new Error("injected 013 failure");
        },
      };
      const production = createProductionMigrations({ generateStoreId: clock.newId, nowIso: clock.nowIso });
      await expect(
        initializePlanStore({
          pluginDataRoot: root,
          migrations: [...production.filter((m) => m.to <= 12), failing],
        }),
      ).rejects.toMatchObject({ code: "STORE_MIGRATION_FAILED", causeText: expect.stringContaining("injected 013 failure") });

      expect(rawSchemaVersion(databasePath)).toBe(12);
      const raw = rawConnection(databasePath, 5000);
      try {
        const names = (raw.prepare("SELECT name FROM sqlite_master").all() as Array<{ name: string }>).map((r) => r.name);
        expect(names).not.toContain("run_control_authorizations");
        expect(names).not.toContain("run_control_authorizations_no_update");
        expect(names).not.toContain("run_control_authorizations_no_delete");
        expect(names).not.toContain("half_created_control");
      } finally {
        raw.close();
      }
      // A normal open migrates it forward again.
      const store = await initializePlanStore({ pluginDataRoot: root });
      try {
        expect(store.getSchemaVersion()).toBe(13);
      } finally {
        store.close();
      }
      expect(publishedBackups(backupsDir).length).toBeGreaterThan(0);
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("a newer-than-supported store is fenced with zero writes (§54/E64)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { databasePath } = storePathsFor(root);
      const probe = await initializePlanStore({ pluginDataRoot: root });
      probe.close();
      // A future binary's marker one step past this binary's supported version.
      const raw = rawConnection(databasePath, 5000);
      try {
        raw.exec(`PRAGMA user_version = ${SUPPORTED_SCHEMA_VERSION + 1}`);
      } finally {
        raw.close();
      }
      await expect(initializePlanStore({ pluginDataRoot: root })).rejects.toMatchObject({
        code: "STORE_SCHEMA_TOO_NEW",
      });
      expect(rawSchemaVersion(databasePath)).toBe(SUPPORTED_SCHEMA_VERSION + 1);
    } finally {
      removeTempPluginDataRoot(root);
    }
  });
});
