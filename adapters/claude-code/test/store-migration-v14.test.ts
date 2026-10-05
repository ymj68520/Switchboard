/**
 * Migration 13 → 14 — execution-run-foundation (v0.2.0 E1 §8/§13/§17-T15,
 * E1-I14): a real schema-13 store carrying the full v0.1 world (approved
 * FinalPlan, delivered handoff, ExecutionBinding, completed predecessor run,
 * ExecutionIssue, successor baseline) migrates with every old row unchanged
 * and the execution-run tables empty; a legacy PREPARED handoff (pre-E1
 * upgrade) recovers onto the SAME new ExecutionRun and completes; a failing
 * 014 rolls back to a valid schema-13 store; a too-new writer is fenced.
 */
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { createProductionMigrations, type StoreMigration } from "../src/store/migrations/index.js";
import { SUPPORTED_SCHEMA_VERSION } from "../src/store/constants.js";
import { initializePlanStore, type PlanStore } from "../src/store/sqlite-store.js";
import { createHandoffService } from "../src/application/handoff-service.js";
import { getExecutionRunInTx, listExecutionRunEventsInTx } from "../src/store/execution-runs.js";
import { getPlanningRunRecord } from "../src/store/planning-runs.js";
import { callHandoff, makeApprovedFinalPlanFixture, type ApprovedFinalPlanFixture } from "./phase14-helpers.js";
import type { PhasePlanToolContext } from "../src/mcp/tools.js";
import { fixedClock, makeTempPluginDataRoot, publishedBackups, rawConnection, removeTempPluginDataRoot, storePathsFor, dropSchema14Objects } from "./store-helpers.js";

function pluginDataRootOf(store: PlanStore): string {
  return path.dirname(path.dirname(store.path));
}

/** Force a v14+ store back to a genuine schema-13 state (drop the v14 domain). */
function rewindToSchema13(databasePath: string): void {
  const raw = rawConnection(databasePath, 5000);
  try {
    dropSchema14Objects(raw);
    raw.exec("DELETE FROM schema_migrations WHERE version >= 14");
    raw.exec("PRAGMA user_version = 13");
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

interface E1World {
  f: ApprovedFinalPlanFixture;
  ctx: PhasePlanToolContext;
}

/**
 * The §T15 fixture world: an approved FinalPlan whose handoff was PREPARED
 * under the pre-E1 semantics (the ExecutionRun domain did not exist yet).
 * The v14 ExecutionRun row the current binary would have written is removed
 * by the rewind, reconstructing the genuine schema-13 state.
 */
async function makePreparedPreE1World(sessionId = "S1"): Promise<E1World> {
  const { f, ctx } = await makeApprovedFinalPlanFixture(sessionId);
  callHandoff(ctx, f, { toolUseId: `${sessionId}-PRE-E1-1` });
  return { f, ctx };
}

describe("migration 13 → 14 execution-run-foundation (E1 §17-T15)", () => {
  it("migrates the delivered v0.1 world: every old row unchanged, execution_runs empty, history [1..14]; legacy delivery replay converges without fabricating history", async () => {
    const { f, ctx } = await makePreparedPreE1World();
    const root = pluginDataRootOf(ctx.store);
    try {
      const databasePath = storePathsFor(root).databasePath;
      // Deliver under the E1 binary so the v13 world below is the real
      // legacy end state (delivered + completed, no ExecutionRun).
      const prepared = callHandoff(ctx, f, { toolUseId: "S1-DELIVER" });
      createHandoffService(ctx.store, ctx.clock).finalizeDelivery({
        runId: f.runId,
        sessionId: f.sessionId,
        toolUseId: "S1-DELIVER",
        responseHandoffId: prepared.handoff_id,
        responseHandoffHash: prepared.handoff_hash,
      });
      expect(getPlanningRunRecord(ctx.store, f.runId)!.lifecycle).toBe("completed");
      // Snapshot the pre-migration legacy world (v13-domain tables only).
      const before = {
        runs: ctx.store.withRead((tx) => tx.prepare("SELECT run_id AS id, lifecycle, stage, revision FROM planning_runs ORDER BY run_id").all()),
        finalPlans: ctx.store.withRead((tx) => tx.prepare("SELECT final_plan_id, final_plan_hash, canonical_json FROM final_plans ORDER BY final_plan_id").all()),
        handoffs: ctx.store.withRead((tx) => tx.prepare("SELECT handoff_id, handoff_hash, canonical_json FROM execution_handoffs ORDER BY handoff_id").all()),
        handoffStates: ctx.store.withRead((tx) => tx.prepare("SELECT * FROM execution_handoff_states ORDER BY run_id").all()),
        bindings: ctx.store.withRead((tx) => tx.prepare("SELECT * FROM execution_bindings ORDER BY run_id").all()),
        commits: ctx.store.withRead((tx) => tx.prepare("SELECT * FROM plan_commits ORDER BY commit_id").all()),
        sessions: ctx.store.withRead((tx) => tx.prepare("SELECT * FROM session_bindings ORDER BY run_id").all()),
      };
      ctx.store.close();
      rewindToSchema13(databasePath);

      const store = await initializePlanStore({ pluginDataRoot: root });
      try {
        expect(store.getSchemaVersion()).toBe(SUPPORTED_SCHEMA_VERSION);
        const same = <T>(a: T, b: T) => expect(b).toEqual(a);
        same(before.runs, store.withRead((tx) => tx.prepare("SELECT run_id AS id, lifecycle, stage, revision FROM planning_runs ORDER BY run_id").all()));
        same(before.finalPlans, store.withRead((tx) => tx.prepare("SELECT final_plan_id, final_plan_hash, canonical_json FROM final_plans ORDER BY final_plan_id").all()));
        same(before.handoffs, store.withRead((tx) => tx.prepare("SELECT handoff_id, handoff_hash, canonical_json FROM execution_handoffs ORDER BY handoff_id").all()));
        same(before.handoffStates, store.withRead((tx) => tx.prepare("SELECT * FROM execution_handoff_states ORDER BY run_id").all()));
        same(before.bindings, store.withRead((tx) => tx.prepare("SELECT * FROM execution_bindings ORDER BY run_id").all()));
        same(before.commits, store.withRead((tx) => tx.prepare("SELECT * FROM plan_commits ORDER BY commit_id").all()));
        same(before.sessions, store.withRead((tx) => tx.prepare("SELECT * FROM session_bindings ORDER BY run_id").all()));
        // No fabricated execution history: the legacy completion stays as-is.
        expect((store.withRead((tx) => tx.prepare("SELECT COUNT(*) AS n FROM execution_runs").get()) as { n: number }).n).toBe(0);
        // E1 §13 — the legacy delivered replay converges (no new run, no
        // invented ExecutionRun), and Build read authority still resolves.
        const replay = createHandoffService(store, fixedClock()).finalizeDelivery({
          runId: f.runId,
          sessionId: f.sessionId,
          toolUseId: "S1-DELIVER",
          responseHandoffId: prepared.handoff_id,
          responseHandoffHash: prepared.handoff_hash,
        });
        expect(replay.alreadyDelivered).toBe(true);
        expect(replay.executionRun).toBeNull();
        expect((store.withRead((tx) => tx.prepare("SELECT COUNT(*) AS n FROM execution_runs").get()) as { n: number }).n).toBe(0);
        const authority = store.withRead((tx) =>
          createHandoffService(store, fixedClock()).requireBuildReadAuthorityInTx(tx, {
            sessionId: f.sessionId,
            workspaceId: f.workspaceId,
            runId: f.runId,
            finalPlanId: f.finalPlanId,
            generation: 1,
          }),
        );
        expect(authority.run.lifecycle).toBe("completed");
      } finally {
        store.close();
      }
      const raw = rawConnection(databasePath, 5000);
      try {
        const rows = raw.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>;
        expect(rows.map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26]);
      } finally {
        raw.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("a legacy PREPARED handoff recovers onto the SAME new ExecutionRun and completes the PlanningRun (E1 §13)", async () => {
    const world = await makePreparedPreE1World();
    const root = pluginDataRootOf(world.ctx.store);
    const { f } = world;
    try {
      const databasePath = storePathsFor(root).databasePath;
      const handoffBefore = world.ctx.store.withRead((tx) =>
        tx.prepare("SELECT handoff_id AS id, handoff_hash AS hash, canonical_json AS canonical FROM execution_handoffs WHERE run_id = ?").get(f.runId),
      );
      const runBefore = getPlanningRunRecord(world.ctx.store, f.runId)!;
      world.ctx.store.close();
      rewindToSchema13(databasePath);

      const store = await initializePlanStore({ pluginDataRoot: root });
      try {
        expect(store.getSchemaVersion()).toBe(26);
        expect((store.withRead((tx) => tx.prepare("SELECT COUNT(*) AS n FROM execution_runs").get()) as { n: number }).n).toBe(0);
        // The prepared handoff survives the migration untouched.
        expect(store.withRead((tx) =>
          tx.prepare("SELECT handoff_id AS id, handoff_hash AS hash, canonical_json AS canonical FROM execution_handoffs WHERE run_id = ?").get(f.runId),
        )).toEqual(handoffBefore);
        expect(getPlanningRunRecord(store, f.runId)!.lifecycle).toBe("active");
        // Recovery: retrying the handoff prepares the run idempotently from
        // the stored handoff baseline, then delivery activates THE SAME run.
        const recoveredCtx = {
          store,
          secret: world.ctx.secret,
          clock: world.ctx.clock,
          blobs: world.ctx.blobs,
        } as unknown as PhasePlanToolContext;
        const retryToken = callHandoff(recoveredCtx, f, { toolUseId: "S1-RECOVER" });
        expect(retryToken.execution_run.lifecycle).toBe("prepared");
        // A1 — the recovered world is keyed by the canonical ExecutionRunID
        // minted by the recovery handoff.
        const row = store.withRead((tx) => getExecutionRunInTx(tx, retryToken.execution_run.id));
        expect(row).not.toBeNull();
        expect(row!.lifecycle).toBe("prepared");
        // The execution-start baseline came from the frozen v0.1 handoff.
        const storedHandoff = JSON.parse((handoffBefore as { canonical: string }).canonical) as { repositoryBaseline: unknown };
        expect(row!.executionStartBaseline).toEqual(storedHandoff.repositoryBaseline);
        const result = createHandoffService(store, fixedClock()).finalizeDelivery({
          runId: f.runId,
          sessionId: f.sessionId,
          toolUseId: "S1-RECOVER",
          responseHandoffId: retryToken.handoff_id,
          responseHandoffHash: retryToken.handoff_hash,
        });
        expect(result.alreadyDelivered).toBe(false);
        expect(result.executionRun!.lifecycle).toBe("active");
        expect(getPlanningRunRecord(store, f.runId)!.lifecycle).toBe("completed");
        expect(getPlanningRunRecord(store, f.runId)!.revision).toBe(runBefore.revision + 1);
        // A1 §16 — the event ledger is keyed by the canonical ExecutionRunID.
        expect(
          store.withRead((tx) => listExecutionRunEventsInTx(tx, result.executionRun!.executionRunId)).map((e) => e.eventType),
        ).toEqual(["PREPARED", "ACTIVATED"]);
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("failing-014 rolls back to a fully valid schema-13 store — no partial execution-run objects", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { databasePath, backupsDir } = storePathsFor(root);
      const probe = await initializePlanStore({ pluginDataRoot: root });
      probe.close();
      rewindToSchema13(databasePath);

      const clock = fixedClock();
      const failing: StoreMigration = {
        from: 13,
        to: 14,
        name: "execution-run-foundation",
        apply(tx) {
          tx.exec("CREATE TABLE half_created_runs (x TEXT)");
          throw new Error("injected 014 failure");
        },
      };
      const production = createProductionMigrations({ generateStoreId: clock.newId, nowIso: clock.nowIso });
      await expect(
        initializePlanStore({
          pluginDataRoot: root,
          migrations: [...production.filter((m) => m.to <= 13), failing, ...production.filter((m) => m.to >= 15)],
        }),
      ).rejects.toMatchObject({ code: "STORE_MIGRATION_FAILED", causeText: expect.stringContaining("injected 014 failure") });

      expect(rawSchemaVersion(databasePath)).toBe(13);
      const raw = rawConnection(databasePath, 5000);
      try {
        const names = (raw.prepare("SELECT name FROM sqlite_master").all() as Array<{ name: string }>).map((r) => r.name);
        expect(names).not.toContain("execution_runs");
        expect(names).not.toContain("execution_run_events");
        expect(names).not.toContain("execution_runs_binding_immutable");
        expect(names).not.toContain("execution_runs_no_delete");
        expect(names).not.toContain("half_created_runs");
      } finally {
        raw.close();
      }
      // A normal open migrates it forward again.
      const store = await initializePlanStore({ pluginDataRoot: root });
      try {
        expect(store.getSchemaVersion()).toBe(26);
      } finally {
        store.close();
      }
      expect(publishedBackups(backupsDir).length).toBeGreaterThan(0);
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("a newer-than-supported store is fenced with zero writes", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { databasePath } = storePathsFor(root);
      const probe = await initializePlanStore({ pluginDataRoot: root });
      probe.close();
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
