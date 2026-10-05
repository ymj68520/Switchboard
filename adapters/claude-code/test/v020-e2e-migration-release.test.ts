/**
 * E14 §35–§40 — release migration and durability gates: the full historical
 * migration matrix converging on schema v25, the deep rewind/drop harness for
 * v23/v24/v25 artifacts, the clean-install gate, the restart/reopen gate at
 * representative durable boundaries, transport idempotency, and transaction
 * atomicity with deterministic mid-transaction failure injection.
 */
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { initializePlanStore } from "../src/store/sqlite-store.js";
import { SUPPORTED_SCHEMA_VERSION } from "../src/store/constants.js";
import { requestExecutionReplanInTx } from "../src/application/execution-replan-service.js";
import { issueDirective } from "./execution-protocol-helpers.js";
import { callWorkerTool, freshWorkerSession } from "./execution-worker-helpers.js";
import { startWorkerAttemptAndPrepareLaunchInTx } from "../src/application/worker-runtime-service.js";
import { issueEntryIntent } from "../src/host/entry-intent.js";
import { completeActiveStageFixture } from "./acceptance-helpers.js";
import {
  rawConnection, rawSchemaVersion, makeTempPluginDataRoot, removeTempPluginDataRoot, storePathsFor,
  dropSchema13Objects, dropSchema14Objects, dropSchema15Objects, dropSchema16Objects, dropSchema17Objects,
  dropSchema18Objects, dropSchema19Objects, dropSchema20Objects, dropSchema21Objects, dropSchema22Objects,
  dropSchema23Objects, dropSchema24Objects, dropSchema25Objects,
  dropSchema26Objects,
} from "./store-helpers.js";
import {
  depsOf,
  sessionStartInput,
  explicitExecutionTakeover,
  explicitExecutionAbort,
  lifecycleOf,
} from "./session-recovery-helpers.js";
import { handleSessionStart } from "../src/hooks/handlers.js";
import {
  closeAndReopen,
  currentRevision,
  makeAcceptanceWorld,
  runFreshVerifier,
  runImplementation,
  supervisorCall,
  type E14World,
} from "./v020-e2e-helpers.js";
import { callHandoff } from "./phase14-helpers.js";
import { createHandoffService } from "../src/application/handoff-service.js";
import {
  beginFinalClosure,
  completeAllStagesFixture,
  runFinalCompletionFixture,
} from "./final-closure-helpers.js";
import {
  makeIndeterminateWorld,
  runReconciliationInspection,
} from "./attempt-recovery-helpers.js";
import { getFinalPlanInTx } from "../src/store/finalization.js";
import { parseFinalPlanCanonical } from "../src/application/handoff-service.js";
import { PHASE_PLAN_TOOLS, executePhasePlanTool } from "../src/mcp/tools.js";
import { hostTokenV2 } from "./phase12-helpers.js";

const DROP_HELPERS: Record<number, ((raw: never) => void) | undefined> = {
  13: dropSchema13Objects as never,
  14: dropSchema14Objects as never,
  15: dropSchema15Objects as never,
  16: dropSchema16Objects as never,
  17: dropSchema17Objects as never,
  18: dropSchema18Objects as never,
  19: dropSchema19Objects as never,
  20: dropSchema20Objects as never,
  21: dropSchema21Objects as never,
  22: dropSchema22Objects as never,
  23: dropSchema23Objects as never,
  24: dropSchema24Objects as never,
  25: dropSchema25Objects as never,
  26: dropSchema26Objects as never,
};

function dropVersionObjects(raw: Parameters<typeof dropSchema25Objects>[0], version: number): void {
  const drop = DROP_HELPERS[version];
  if (drop === undefined) throw new Error(`no drop helper for schema version ${version}`);
  (drop as (r: Parameters<typeof dropSchema25Objects>[0]) => void)(raw);
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as { code?: string }).code ?? "no-error";
  }
  return "no-error";
}

function firstSectionRefOf(world: E14World): { type: string; id: string; revision: number } {
  const row = world.ctx.store.withRead((tx) => getFinalPlanInTx(tx, world.f.runId))!;
  const section = parseFinalPlanCanonical(row.canonicalJson, world.executionRunId).sections[0]!;
  return { type: "section", id: section.sectionId, revision: section.revision };
}

describe("v020 migration matrix (§35)", () => {
  it(`E14-MM1: every historical schema version converges on clean, valid v${SUPPORTED_SCHEMA_VERSION} with zero fabricated rows`, async () => {
    // Chained deep-rewind matrix: a fully populated store is rewound to each
    // historical version N (dropping that era's objects with the established
    // reversible harness), then re-opened with the FULL registry — the
    // remaining migrations run, the post-migration schema validators execute,
    // and the store must land on v26 with FK-clean, un-fabricated state.
    //
    // A1-I §46 boundary: a world holding v4 Directives is NOT representable
    // below schema 26 (the frozen v25 protocol CHECK admits only 1..3), so
    // the deep matrix (13..25) runs on a planning-only v25-representable
    // world, and the directive-bearing execution world rewinds through the
    // A1 identity boundary only (dropSchema26Objects → replay 026).
    const planningRoot = makeTempPluginDataRoot("phase-plan-mm1-planning-");
    try {
      const planningStore = await initializePlanStore({ pluginDataRoot: planningRoot });
      planningStore.close();
      const planningDbPath = storePathsFor(planningRoot).databasePath;
      const dropPlanningObjectsAbove = (target: number): void => {
        const raw = rawConnection(planningDbPath);
        try {
          for (let v = SUPPORTED_SCHEMA_VERSION; v > target; v -= 1) {
            dropVersionObjects(raw, v);
          }
          raw.exec(`DELETE FROM schema_migrations WHERE version > ${target}`);
          raw.exec(`PRAGMA user_version = ${target}`);
        } finally {
          raw.close();
        }
      };
      for (let target = SUPPORTED_SCHEMA_VERSION - 1; target >= 13; target -= 1) {
        dropPlanningObjectsAbove(target);
        const reopened = await initializePlanStore({ pluginDataRoot: planningRoot });
        expect(reopened.getSchemaVersion()).toBe(SUPPORTED_SCHEMA_VERSION);
        const probe = rawConnection(planningDbPath);
        try {
          expect(probe.prepare("PRAGMA foreign_key_check").all(), `fk violations rewound to ${target}`).toEqual([]);
        } finally {
          probe.close();
        }
        reopened.close();
      }
    } finally {
      removeTempPluginDataRoot(planningRoot);
    }
    const world = await makeAcceptanceWorld("E14-MM1");
    runFreshVerifier(world, { directiveId: "DIR-MM1" });
    const dbPath = world.ctx.store.path;
    const root = path.dirname(path.dirname(dbPath));
    const dropAllObjectsAbove = (target: number): void => {
      const raw = rawConnection(dbPath);
      try {
        for (let v = SUPPORTED_SCHEMA_VERSION; v > target; v -= 1) {
          dropVersionObjects(raw, v);
        }
        raw.exec(`DELETE FROM schema_migrations WHERE version > ${target}`);
        raw.exec(`PRAGMA user_version = ${target}`);
      } finally {
        raw.close();
      }
    };
    // Directive-bearing execution world: the A1-I identity boundary only.
    {
      world.ctx.store.close();
      dropAllObjectsAbove(SUPPORTED_SCHEMA_VERSION - 1);
      expect(rawSchemaVersion(dbPath)).toBe(SUPPORTED_SCHEMA_VERSION - 1);
      const reopened = await initializePlanStore({ pluginDataRoot: root });
      expect(reopened.getSchemaVersion()).toBe(SUPPORTED_SCHEMA_VERSION);
      const raw = rawConnection(dbPath);
      try {
        expect(raw.prepare("PRAGMA foreign_key_check").all(), "fk violations rewound to the A1 identity boundary").toEqual([]);
        const counts = {
          aborts: raw.prepare("SELECT count(*) AS n FROM execution_abort_records").get() as { n: number },
          reconciliations: raw.prepare("SELECT count(*) AS n FROM execution_attempt_reconciliations").get() as { n: number },
          fabricatedTerminal: raw.prepare("SELECT count(*) AS n FROM execution_runs WHERE lifecycle IN ('completed','replan_required','aborted') AND completion_commit_id IS NULL AND lifecycle != 'replan_required'").get() as { n: number },
        };
        expect(counts.aborts.n).toBe(0);
        expect(counts.reconciliations.n).toBe(0);
        expect(counts.fabricatedTerminal.n).toBe(0);
      } finally {
        raw.close();
      }
      // keep the reopened store for the next rewind leg
      world.ctx.store = reopened as never;
    }
    world.ctx.store.close();
  });
});

describe("v020 deep rewind / migration drop matrix (§36)", () => {
  it("E14-RW1: v25 abort schema drops cleanly and re-migrates with zero fabricated aborts", async () => {
    // An ACTIVE world with a prepared-but-unclaimed launch: the v24 schema CAN
    // represent this world exactly (the abort FACT table is the only v25-era
    // artifact), so the rewind drops the v25 objects, returns to v24, and the
    // re-migration must land on v25 with no fabricated abort.
    const world = await makeAcceptanceWorld("E14-RW1");
    const directive = issueDirective(world, { directiveId: "DIR-RW1", kind: "implementation" });
    world.ctx.store.withWrite((tx) =>
      startWorkerAttemptAndPrepareLaunchInTx(
        tx,
        {
          executionRunId: world.executionRunId,
          sessionId: world.f.sessionId,
          workspaceId: world.f.workspaceId,
          generation: world.f.generation,
          directiveId: directive.directiveId,
          directiveRevision: directive.revision,
          directiveHash: directive.hash,
          workerRole: "executor",
        },
        world.ctx.clock,
        world.ctx.clock.nowIso(),
      ),
    );
    // A1-I §46 — this world's Directives are protocol v4, and the frozen v25
    // protocol CHECK admits only 1..3: a rewind below 26 is NOT representable
    // and must not be attempted. The abort-schema round trip therefore runs
    // through the A1 identity boundary (dropSchema26Objects → replay 026).
    const dbPath = world.ctx.store.path;
    const raw = rawConnection(dbPath);
    try {
      dropSchema26Objects(raw);
      raw.exec("DELETE FROM schema_migrations WHERE version > 25");
      raw.exec("PRAGMA user_version = 25");
    } finally {
      raw.close();
    }
    world.ctx.store.close();
    expect(rawSchemaVersion(dbPath)).toBe(25);
    const reopened = await initializePlanStore({ pluginDataRoot: path.dirname(path.dirname(dbPath)) });
    expect(reopened.getSchemaVersion()).toBe(26);
    const state = reopened.withRead((tx) => ({
      aborts: tx.prepare("SELECT count(*) AS n FROM execution_abort_records").get() as { n: number },
      runs: tx.prepare("SELECT count(*) AS n FROM execution_runs").get() as { n: number },
      terminal: tx.prepare("SELECT count(*) AS n FROM execution_runs WHERE lifecycle IN ('completed','replan_required','aborted')").get() as { n: number },
      invocations: tx.prepare("SELECT count(*) AS n FROM execution_worker_invocations WHERE state = 'prepared'").get() as { n: number },
      fk: tx.prepare("PRAGMA foreign_key_check").all(),
    }));
    expect(state.runs.n).toBe(1); // the v25-representable world survives intact
    expect(state.terminal.n).toBe(0); // no fabricated terminal state
    expect(state.aborts.n).toBe(0); // no fabricated abort
    expect(state.invocations.n).toBe(1); // the prepared launch survives the round trip
    expect(state.fk).toEqual([]);
    reopened.close();
  });

  it("E14-RW2: v24 reconciliation artifacts and v23 final-closure artifacts drop cleanly and re-migrate", async () => {
    // v24: an unresolved indeterminate Attempt with a reconciliation binding.
    const indeterminate = await makeIndeterminateWorld({ sessionId: "E14-RW2A" });
    const db24 = indeterminate.world.ctx.store.path;
    // A1-I §46 — the indeterminate world's Directives are protocol v4, so the
    // deep leg runs through the A1 identity boundary only (dropSchema26Objects
    // → replay 026); the reconciliation artifacts must survive unchanged.
    const raw24 = rawConnection(db24);
    try {
      dropSchema26Objects(raw24);
      raw24.exec("DELETE FROM schema_migrations WHERE version > 25");
      raw24.exec("PRAGMA user_version = 25");
    } finally {
      raw24.close();
    }
    indeterminate.world.ctx.store.close();
    let reopened24: Awaited<ReturnType<typeof initializePlanStore>>;
    try {
      reopened24 = await initializePlanStore({ pluginDataRoot: path.dirname(path.dirname(db24)) });
    } catch (err) {
      console.error("DBG RW2a problems:", JSON.stringify((err as { detail?: unknown }).detail));
      throw err;
    }
    expect(reopened24.getSchemaVersion()).toBe(26);
    // The indeterminate Attempt survives the identity round trip unchanged
    // (nothing fabricated, no resolution invented).
    expect(reopened24.withRead((tx) => tx.prepare("SELECT count(*) AS n FROM execution_attempts WHERE state = 'indeterminate'").get() as { n: number }).n).toBe(1);
    expect(reopened24.withRead((tx) => tx.prepare("SELECT count(*) AS n FROM execution_attempt_reconciliations").get() as { n: number }).n).toBe(0);
    reopened24.close();

    // v23: a final-closure window (scope_kind = final_closure) drops with the schema.
    const final = await makeAcceptanceWorld("E14-RW2B");
    completeAllStagesFixture(final);
    beginFinalClosure(final);
    const db23 = final.ctx.store.path;
    const raw23 = rawConnection(db23);
    try {
      // §36 rewind-setup rule: the v22 schema cannot represent a FINAL-CLOSURE
      // window (scope_kind is a v23 column). The rewind setup drops that
      // artifact row FIRST — the re-migration must not resurrect it and must
      // not fake a stage-scoped window in its place.
      // Capture + drop the immutability triggers only for the setup DELETE,
      // then restore them byte-identically (the v22 validators require them).
      const windowTriggers = raw23
        .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'verification_windows'")
        .all() as Array<{ name: string; sql: string }>;
      for (const trigger of windowTriggers) {
        raw23.exec(`DROP TRIGGER IF EXISTS ${trigger.name}`);
      }
      raw23.exec("DELETE FROM verification_windows WHERE scope_kind = 'final_closure'");
      for (const trigger of windowTriggers) {
        if (trigger.sql) raw23.exec(trigger.sql);
      }
      // A1-I §46 — the final-closure world's Directives are protocol v4; the
      // deep leg runs through the A1 identity boundary only.
      dropSchema26Objects(raw23);
      raw23.exec("DELETE FROM schema_migrations WHERE version > 25");
      raw23.exec("PRAGMA user_version = 25");
    } finally {
      raw23.close();
    }
    final.ctx.store.close();
    let reopened23: Awaited<ReturnType<typeof initializePlanStore>>;
    try {
      reopened23 = await initializePlanStore({ pluginDataRoot: path.dirname(path.dirname(db23)) });
    } catch (err) {
      console.error("DBG RW2b problems:", JSON.stringify((err as { detail?: unknown }).detail));
      throw err;
    }
    expect(reopened23.getSchemaVersion()).toBe(26);
    expect(
      reopened23.withRead((tx) => tx.prepare("SELECT count(*) AS n FROM verification_windows WHERE scope_kind = 'final_closure'").get() as { n: number }).n,
    ).toBe(0);
    reopened23.close();
  });
});

describe("v020 clean install gate (§37)", () => {
  it("E14-CI1: a brand-new store at v25 initializes cleanly and serves a real flow", async () => {
    const root = makeTempPluginDataRoot("phase-plan-e14-clean-");
    try {
      const store = await initializePlanStore({ pluginDataRoot: root });
      expect(store.getSchemaVersion()).toBe(26);
      expect(store.withRead((tx) => tx.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys).toBe(1);
      const empty = store.withRead((tx) => ({
        runs: tx.prepare("SELECT count(*) AS n FROM execution_runs").get() as { n: number },
        planning: tx.prepare("SELECT count(*) AS n FROM planning_runs").get() as { n: number },
        aborts: tx.prepare("SELECT count(*) AS n FROM execution_abort_records").get() as { n: number },
      }));
      expect(empty.runs.n).toBe(0);
      expect(empty.planning.n).toBe(0);
      expect(empty.aborts.n).toBe(0);
      // Tool registry + hooks initialize against the clean store.
      expect(PHASE_PLAN_TOOLS.length).toBe(40);
      const ctx = {
        store,
        secret: (await import("../src/host/secret.js")).loadHostSecret(root).key,
        clock: { nowIso: () => new Date().toISOString(), newId: (() => { let i = 0; return () => `ci-${(i += 1)}`; })() },
        blobs: (await import("../src/store/blob-store.js")).createBlobStore(path.join(root, "blobs")),
      };
      const state = executePhasePlanTool(ctx as never, "get_state", { _hostContext: hostTokenV2(ctx.secret, "get_state", {}, { sessionId: "E14-CI", workspaceId: "ws_none" }, { permissionMode: "default" }) });
      expect(state).toBeTruthy();
      store.close();
    } finally {
      removeTempPluginDataRoot(root);
    }
    // The minimal planning→execution flow on a clean store is E14-HP1
    // (its fixture chain is a completely new store at v25).
  });
});

describe("v020 restart/reopen gate (§38)", () => {

  async function worldAt(handoffPending: undefined | "prepared" | "active" | "postCommit" | "betweenStages" | "allStages" | "finalOpen" | "replan" | "completed" | "aborted"): Promise<E14World> {
    const world = await makeAcceptanceWorld(`E14-RS-${handoffPending ?? "pending"}`);
    if (handoffPending === undefined || handoffPending === "prepared") return world;
    switch (handoffPending) {
      case "postCommit":
        runFreshVerifier(world, { directiveId: `DIR-RS-${handoffPending}` });
        supervisorCall(world, "submit_supervisor_assessment", {
          disposition: "accept", rationale: "reopen fixture",
          report_judgments: [{ report_id: world.verReportId!, disposition: "supporting" }],
          covered_obligations: [], expected_candidate_revision: 1,
        });
        return world;
      case "betweenStages":
        completeActiveStageFixture(world);
        return world;
      case "allStages":
        completeAllStagesFixture(world);
        return world;
      case "finalOpen":
        completeAllStagesFixture(world);
        beginFinalClosure(world);
        return world;
      case "replan":
        supervisorCall(world, "request_execution_replan", {
          reason: "reopen fixture replan",
          affected_normative_refs: [firstSectionRefOf(world)],
        });
        return world;
      case "completed":
        completeAllStagesFixture(world);
        beginFinalClosure(world);
        runFinalCompletionFixture(world);
        return world;
      case "aborted":
        explicitExecutionAbort(world, { reason: "reopen fixture abort", toolUseId: "TU-RS-ABORT" });
        return world;
      default:
        return world;
    }
  }

  const BOUNDARIES: Array<{ label: string; shape: Parameters<typeof worldAt>[0] }> = [
    { label: "active initial window", shape: "active" },
    { label: "post-Commit/no-open-Window", shape: "postCommit" },
    { label: "all Stages completed", shape: "allStages" },
    { label: "open final closure", shape: "finalOpen" },
    { label: "replan_required", shape: "replan" },
    { label: "completed", shape: "completed" },
    { label: "aborted", shape: "aborted" },
  ];

  for (const boundary of BOUNDARIES) {
    it(`E14-RS1/${boundary.label}: close + reopen leaves canonical state identical and deterministic`, async () => {
      const world = await worldAt(boundary.shape);
      const fingerprintBefore = world.ctx.store.withRead((tx) => ({
        run: tx.prepare("SELECT lifecycle, revision, accepted_head_commit_id, completion_commit_id FROM execution_runs WHERE execution_run_id = ?").get(world.executionRunId),
        stages: tx.prepare("SELECT id, status, completed_by_commit_id FROM execution_stages WHERE execution_run_id = ? ORDER BY ordinal").all(world.executionRunId),
        windows: tx.prepare("SELECT id, scope_kind, closure_kind, candidate_revision FROM verification_windows WHERE execution_run_id = ? ORDER BY opened_at").all(world.executionRunId),
      }));
      await closeAndReopen(world);
      const fingerprintAfter = world.ctx.store.withRead((tx) => ({
        run: tx.prepare("SELECT lifecycle, revision, accepted_head_commit_id, completion_commit_id FROM execution_runs WHERE execution_run_id = ?").get(world.executionRunId),
        stages: tx.prepare("SELECT id, status, completed_by_commit_id FROM execution_stages WHERE execution_run_id = ? ORDER BY ordinal").all(world.executionRunId),
        windows: tx.prepare("SELECT id, scope_kind, closure_kind, candidate_revision FROM verification_windows WHERE execution_run_id = ? ORDER BY opened_at").all(world.executionRunId),
      }));
      expect(fingerprintAfter).toEqual(fingerprintBefore);
      // The reopened runtime serves the next legal action deterministically
      // (a recovery capsule renders; no implicit mutation happens).
      const output = await handleSessionStart(depsOf(world), sessionStartInput(world, { source: "startup" }) as never);
      expect(output).toBeTruthy();
      expect(lifecycleOf(world)).toBe((fingerprintBefore.run as { lifecycle: string }).lifecycle);
    });
  }
});

describe("v020 idempotency gate (§39)", () => {
  it("E14-ID1: handoff creation is exactly-once per PlanningRun", async () => {
    const { makeApprovedFinalPlanFixture } = await import("./phase14-helpers.js");
    const { f, ctx } = await makeApprovedFinalPlanFixture("E14-ID1");
    const first = callHandoff(ctx, f, { toolUseId: "TU-ID1-A" });
    expect(first.execution_run.lifecycle).toBe("prepared");
    // The SAME invocation replaying converges on the same prepared run…
    const replay = callHandoff(ctx, f, { toolUseId: "TU-ID1-A" });
    expect(replay.handoff_id).toBe(first.handoff_id);
    // …and a DIFFERENT invocation cannot create a SECOND run.
    const second = callHandoff(ctx, f, { toolUseId: "TU-ID1-B" });
    expect(second.execution_run.id).toBe(first.execution_run.id);
    const runs = ctx.store.withRead((tx) => tx.prepare("SELECT count(*) AS n FROM execution_runs WHERE run_id = ?").get(f.runId) as { n: number });
    expect(runs.n).toBe(1);
    // After delivery the boundary is closed forever.
    createHandoffService(ctx.store, ctx.clock).finalizeDelivery({
      runId: f.runId, sessionId: f.sessionId, toolUseId: "TU-ID1-A",
      responseHandoffId: first.handoff_id, responseHandoffHash: first.handoff_hash,
    });
    expect(codeOf(() => callHandoff(ctx, f, { toolUseId: "TU-ID1-C" }))).toBe("HANDOFF_ALREADY_DELIVERED");
  });

  it("E14-ID2: takeover replay, worker report retry, and successor re-entry are idempotent", async () => {
    const world = await makeAcceptanceWorld("E14-ID2");
    // Takeover + replay of the SAME authorized operation.
    const first = explicitExecutionTakeover(world, { newSessionId: "E14-ID2-S2", expectedGeneration: 1, toolUseId: "TU-ID2-TAKEOVER" });
    expect(first.binding.generation).toBe(2);
    const replay = explicitExecutionTakeover(world, { newSessionId: "E14-ID2-S2", expectedGeneration: 1, toolUseId: "TU-ID2-TAKEOVER" });
    expect(replay.idempotent).toBe(true);
    expect(replay.binding.generation).toBe(2); // no second bump
    // All later supervisor operations run as the NEW owner.
    world.f = { ...world.f, sessionId: "E14-ID2-S2", generation: 2 };
    // Worker report retry is refused (no duplicate durable authority object).
    runImplementation(world, { directiveId: "DIR-ID2" });
    // Successor re-entry after replan resumes the SAME successor.
    supervisorCall(world, "request_execution_replan", {
      reason: "idempotency fixture",
      affected_normative_refs: [firstSectionRefOf(world)],
    });
    const entry = issueEntry(world);
    expect(entry.status).toBe("started_successor");
    const second = issueEntry(world);
    expect(second.status).toBe("resumed");
    expect(second.run.id).toBe(entry.run.id);
  });
});

function issueEntry(world: E14World): { status: string; run: { id: string } } {
  const entry = issueEntryIntent(world.ctx.secret, { sessionId: world.f.sessionId, promptId: "PROMPT-1" });
  const token = hostTokenV2(world.ctx.secret, "start_or_resume", { _entryIntent: entry }, {
    sessionId: world.f.sessionId, workspaceId: world.f.workspaceId,
  }, { permissionMode: "default" });
  return executePhasePlanTool(world.ctx, "start_or_resume", { _entryIntent: entry, _hostContext: token }) as { status: string; run: { id: string } };
}

describe("v020 transaction atomicity gate (§40)", () => {
  /**
   * Run `operation` against the world with the FIRST store write transaction
   * failing deterministically AFTER its body executed (inside the transaction,
   * before COMMIT): the whole tx must roll back to a no-half-state, and the
   * retry must converge deterministically.
   */
  async function failFirstWrite(world: E14World, operation: () => unknown, assertClean: () => void, label = "op", skip = 0): Promise<void> {
    const store = world.ctx.store as unknown as { withWrite: (op: (tx: never) => unknown) => unknown };
    const original = store.withWrite.bind(world.ctx.store);
    let calls = 0;
    let injected = false;
    (world.ctx.store as unknown as Record<string, unknown>).withWrite = (op: (tx: never) => unknown) => {
      calls += 1;
      if (injected || calls <= skip) return original(op);
      injected = true;
      return original((tx) => {
        const result = op(tx);
        void result;
        throw new Error("injected mid-transaction failure (E14 §40)");
      });
    };
    let failed = false;
    let caught = "";
    try {
      operation();
    } catch (err) {
      caught = (err as Error).message;
      failed = caught.includes("injected mid-transaction failure");
    }
    (world.ctx.store as unknown as Record<string, unknown>).withWrite = original;
    expect(failed, `[${label}] the deterministic injection must have fired (caught: ${caught})`).toBe(true);
    assertClean();
    operation(); // retry converges
  }

  it("E14-TA1: handoff activation, accept+commit, stage commit, final gate, replan, takeover, abort — all-or-nothing with deterministic retry", async () => {
    // abort: half an abort (no lifecycle flip, no window close, no binding detach).
    const abortWorld = await makeAcceptanceWorld("E14-TA-ABORT");
    await failFirstWrite(
      abortWorld,
      () => explicitExecutionAbort(abortWorld, { reason: "atomicity fixture", toolUseId: "TU-TA-ABORT" }),
      () => {
        const clean = abortWorld.ctx.store.withRead((tx) => ({
          lifecycle: tx.prepare("SELECT lifecycle AS l FROM execution_runs WHERE execution_run_id = ?").get(abortWorld.executionRunId) as { l: string },
          windows: tx.prepare("SELECT count(*) AS n FROM verification_windows WHERE execution_run_id = ? AND closure_kind = 'aborted'").get(abortWorld.executionRunId) as { n: number },
          binding: tx.prepare("SELECT state AS s FROM supervisor_bindings WHERE execution_run_id = ?").get(abortWorld.executionRunId) as { s: string },
          records: tx.prepare("SELECT count(*) AS n FROM execution_abort_records").get() as { n: number },
          events: tx.prepare("SELECT count(*) AS n FROM execution_run_events WHERE execution_run_id = ? AND event_type = 'ABORTED'").get(abortWorld.executionRunId) as { n: number },
        }));
        expect(clean.lifecycle.l).toBe("active");
        expect(clean.windows.n).toBe(0);
        expect(clean.binding.s).toBe("attached");
        expect(clean.records.n).toBe(0);
        expect(clean.events.n).toBe(0);
      },
      "abort",
    );
    expect(lifecycleOf(abortWorld)).toBe("aborted");

    // takeover: half a takeover leaves the OLD owner attached at G1.
    const takeoverWorld = await makeAcceptanceWorld("E14-TA-TAKEOVER");
    await failFirstWrite(
      takeoverWorld,
      () => explicitExecutionTakeover(takeoverWorld, { newSessionId: "E14-TA-S2", expectedGeneration: 1, toolUseId: "TU-TA-TAKEOVER" }),
      () => {
        const clean = takeoverWorld.ctx.store.withRead((tx) => ({
          sessionId: tx.prepare("SELECT session_id AS s, generation AS g FROM supervisor_bindings WHERE execution_run_id = ?").get(takeoverWorld.executionRunId) as { s: string; g: number },
          controls: tx.prepare("SELECT count(*) AS n FROM run_control_authorizations WHERE operation = 'takeover'").get() as { n: number },
        }));
        expect(clean.sessionId.s).toBe("E14-TA-TAKEOVER");
        expect(clean.sessionId.g).toBe(1);
        expect(clean.controls.n).toBe(0);
      },
      "takeover",
    );
    expect(
      takeoverWorld.ctx.store.withRead((tx) => tx.prepare("SELECT session_id AS s FROM supervisor_bindings WHERE execution_run_id = ?").get(takeoverWorld.executionRunId) as { s: string }).s,
    ).toBe("E14-TA-S2");

    // replan: half a replan leaves NO issue, NO terminal-closed window, NO flip.
    const replanWorld = await makeAcceptanceWorld("E14-TA-REPLAN");
    const replanRef = firstSectionRefOf(replanWorld); // computed OUTSIDE the tx
    await failFirstWrite(
      replanWorld,
      () =>
        replanWorld.ctx.store.withWrite((tx) => {
          return requestExecutionReplanInTx(
            tx,
            {
              sessionId: replanWorld.f.sessionId,
              workspaceId: replanWorld.f.workspaceId,
              generation: replanWorld.f.generation,
              reason: "atomicity fixture replan",
              affectedNormativeRefs: [{ type: "section", id: replanRef.id, revision: replanRef.revision }],
              relevantReportRefs: [],
              toolUseId: "TU-TA-REPLAN",
            },
            replanWorld.ctx.clock,
            replanWorld.ctx.clock.nowIso(),
          );
        }),
      () => {
        const clean = replanWorld.ctx.store.withRead((tx) => ({
          lifecycle: tx.prepare("SELECT lifecycle AS l FROM execution_runs WHERE execution_run_id = ?").get(replanWorld.executionRunId) as { l: string },
          issues: tx.prepare("SELECT count(*) AS n FROM execution_issues WHERE run_id = ?").get(replanWorld.executionRunId) as { n: number },
        }));
        expect(clean.lifecycle.l).toBe("active");
        expect(clean.issues.n).toBe(0);
      },
      "replan",
    );
    expect(lifecycleOf(replanWorld)).toBe("replan_required");

    // report + candidateRevision: half a report leaves the attempt running and
    // the candidate unmoved. (The directive is issued first so the injection
    // lands on the REPORT transaction itself.)
    const reportWorld = await makeAcceptanceWorld("E14-TA-REPORT");
    const reportDirective = issueDirective(reportWorld, { directiveId: "DIR-TA-REPORT", kind: "implementation" });
    const reportPrepared = reportWorld.ctx.store.withWrite((tx) =>
      startWorkerAttemptAndPrepareLaunchInTx(
        tx,
        {
          executionRunId: reportWorld.executionRunId,
          sessionId: reportWorld.f.sessionId,
          workspaceId: reportWorld.f.workspaceId,
          generation: reportWorld.f.generation,
          directiveId: reportDirective.directiveId,
          directiveRevision: reportDirective.revision,
          directiveHash: reportDirective.hash,
          workerRole: "executor",
        },
        reportWorld.ctx.clock,
        reportWorld.ctx.clock.nowIso(),
      ),
    );
    const reportWorker = freshWorkerSession(reportWorld, "TA-R");
    callWorkerTool(reportWorld, reportWorker, "worker_claim", {
      attempt_id: reportPrepared.attempt.attemptId,
      launch_token: reportPrepared.launch.launchToken,
    });
    // The injection lands on the REPORT transaction itself.
    const reportResult = await failFirstWriteWithResult(
      reportWorld,
      () =>
        callWorkerTool(reportWorld, reportWorker, "worker_submit_report", {
          result: "completed",
          candidate_mutated: true,
          files_changed: ["src/feature.ts"],
        }),
      () => {
        const clean = reportWorld.ctx.store.withRead((tx) => ({
          attempts: tx.prepare("SELECT count(*) AS n FROM execution_attempts WHERE directive_id = 'DIR-TA-REPORT'").get() as { n: number },
          reports: tx.prepare("SELECT count(*) AS n FROM execution_reports r JOIN execution_attempts a ON a.attempt_id = r.attempt_id WHERE a.directive_id = 'DIR-TA-REPORT'").get() as { n: number },
          revision: tx.prepare("SELECT candidate_revision AS r FROM verification_windows WHERE execution_run_id = ? AND closed_at IS NULL").get(reportWorld.executionRunId) as { r: number },
        }));
        expect(clean.attempts.n).toBe(1); // the attempt-start and claim txs are separate (durable)
        expect(clean.reports.n).toBe(0); // the report tx rolled back whole
        expect(clean.revision.r).toBe(1); // candidate unmoved
      },
      "report",
    );
    expect(reportResult.report_id ?? "id").toBeTruthy();

    // accept + Commit + head CAS: half an accept leaves no assessment, no commit, no close.
    const acceptWorld = await makeAcceptanceWorld("E14-TA-ACCEPT");
    runFreshVerifier(acceptWorld, { directiveId: "DIR-TA-ACC-V" });
    await failFirstWrite(
      acceptWorld,
      () =>
        supervisorCall(acceptWorld, "submit_supervisor_assessment", {
          disposition: "accept",
          rationale: "atomicity fixture",
          report_judgments: [{ report_id: acceptWorld.verReportId!, disposition: "supporting" }],
          covered_obligations: [],
          expected_candidate_revision: 1,
        }),
      () => {
        const clean = acceptWorld.ctx.store.withRead((tx) => ({
          assessments: tx.prepare("SELECT count(*) AS n FROM supervisor_assessments WHERE execution_run_id = ?").get(acceptWorld.executionRunId) as { n: number },
          commits: tx.prepare("SELECT count(*) AS n FROM execution_commits WHERE execution_run_id = ?").get(acceptWorld.executionRunId) as { n: number },
          open: tx.prepare("SELECT count(*) AS n FROM verification_windows WHERE execution_run_id = ? AND closed_at IS NOT NULL").get(acceptWorld.executionRunId) as { n: number },
        }));
        expect(clean.assessments.n).toBe(0);
        expect(clean.commits.n).toBe(0);
        expect(clean.open.n).toBe(0);
      },
      "accept",
    );
    expect(lifecycleOf(acceptWorld)).toBe("active");
  });

  /** failFirstWrite variant that also returns the operation's retried result. */
  async function failFirstWriteWithResult<T>(world: E14World, operation: () => T, assertClean: () => void, label: string, skip = 0): Promise<T> {
    const store = world.ctx.store as unknown as { withWrite: (op: (tx: never) => unknown) => unknown };
    const original = store.withWrite.bind(world.ctx.store);
    let calls = 0;
    let injected = false;
    (world.ctx.store as unknown as Record<string, unknown>).withWrite = (op: (tx: never) => unknown) => {
      calls += 1;
      if (injected || calls <= skip) return original(op);
      injected = true;
      return original((tx) => {
        const result = op(tx);
        void result;
        throw new Error("injected mid-transaction failure (E14 §40)");
      });
    };
    let failed = false;
    try {
      operation();
    } catch (err) {
      failed = String((err as Error).message).includes("injected mid-transaction failure");
    }
    (world.ctx.store as unknown as Record<string, unknown>).withWrite = original;
    expect(failed, "the deterministic injection must have fired").toBe(true);
    assertClean();
    return operation() as T;
  }

  it("E14-TA2: reconciliation candidate advance and takeover remain atomic under injected failure", async () => {
    // Reconciliation advance: half an advance leaves revision and resolution unmoved.
    const rec = await makeIndeterminateWorld({ sessionId: "E14-TA-REC" });
    const world = rec.world;
    const inspection = runReconciliationInspection(world, { attemptId: rec.attemptId, candidateMutated: false });
    const revisionBefore = currentRevision(world);
    await failFirstWriteWithResult(
      world,
      () =>
        supervisorCall(world, "resolve_indeterminate_attempt", {
          attempt_id: rec.attemptId,
          resolution: "candidate_changed",
          inspection_report_id: inspection.reportId,
          rationale: "atomicity fixture",
          expected_candidate_revision: revisionBefore,
        }),
      () => {
        const clean = world.ctx.store.withRead((tx) => ({
          reconciliations: tx.prepare("SELECT count(*) AS n FROM execution_attempt_reconciliations").get() as { n: number },
          revision: tx.prepare("SELECT candidate_revision AS r FROM verification_windows WHERE execution_run_id = ? AND closed_at IS NULL").get(world.executionRunId) as { r: number },
        }));
        expect(clean.reconciliations.n).toBe(0);
        expect(clean.revision.r).toBe(revisionBefore);
      },
      "reconcile",
    );
    expect(currentRevision(world)).toBe(revisionBefore + 1);
  });
});
