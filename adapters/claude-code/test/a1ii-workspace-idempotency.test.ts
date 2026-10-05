/**
 * A1-II — workspace rules, idempotency, atomicity/recovery, and the true
 * 0..N cardinality family (directive §53–§55/§60, A1II-T20..T36/T58..T61).
 *
 * Atomicity/recovery fault injection drives the in-tx cores directly over a
 * raw SQLite connection inside explicit BEGIN IMMEDIATE transactions: a
 * fault before commit must leave NO authorization row, NO resulting run,
 * and NO partial structure (§13/§33).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { makeActiveExecutionWorld, codeOf, fullEnvelope, openContract, issueDirective } from "./execution-protocol-helpers.js";
import { createExecutionAbortService } from "../src/application/execution-abort-service.js";
import {
  createReexecutionService,
  reexecuteFinalPlanInTx,
  type ReexecuteFinalPlanInput,
} from "../src/application/reexecution-service.js";
import { issueExecutionDirectiveInTx } from "../src/application/execution-directive-service.js";
import { ensureExecutionStructureInTx, getExecutionStructureInTx } from "../src/application/execution-structure-service.js";
import { activateExecutionRunInTx } from "../src/store/execution-runs.js";
import { insertAttachedSupervisorBindingInTx } from "../src/store/supervisor-bindings.js";
import { runControlRequestHash } from "../src/store/run-control.js";
import { getFinalPlanInTx } from "../src/store/finalization.js";
import { initializePlanStore } from "../src/store/sqlite-store.js";
import { discoverAndRegisterWorkspace } from "../src/workspace/identity.js";
import { rawConnection, removeTempPluginDataRoot, storePathsFor } from "./store-helpers.js";

type TestWorld = Awaited<ReturnType<typeof makeActiveExecutionWorld>>;

function pluginDataRootOf(store: { path: string }): string {
  return path.dirname(path.dirname(store.path));
}

function finalPlanOf(world: TestWorld): { id: string; revision: number; hash: string } {
  const row = world.ctx.store.withRead((tx) => getFinalPlanInTx(tx, world.f.runId));
  if (row === null) throw new Error("fixture FinalPlan missing");
  return { id: row.finalPlanId, revision: row.revision, hash: row.finalPlanHash };
}

function reexecutionRequest(
  world: TestWorld,
  overrides: {
    operationId?: string;
    target?: Partial<{ sourcePlanningRunId: string; finalPlanId: string; finalPlanRevision: number; finalPlanHash: string }>;
    workspaceId?: string;
    requesterSessionId?: string;
  } = {},
): ReexecuteFinalPlanInput {
  const finalPlan = finalPlanOf(world);
  const target = {
    sourcePlanningRunId: world.f.runId,
    finalPlanId: finalPlan.id,
    finalPlanRevision: finalPlan.revision,
    finalPlanHash: finalPlan.hash,
    ...overrides.target,
  };
  const workspaceId = overrides.workspaceId ?? world.f.workspaceId;
  const operationId = overrides.operationId ?? "reexecute_final_plan:TU-REEXEC-1";
  return {
    ...target,
    workspaceId,
    requesterSessionId: overrides.requesterSessionId ?? "S1",
    toolUseId: operationId.replace("reexecute_final_plan:", ""),
    authorization: {
      authorizationRequestId: `mcp-control:${operationId.replace("reexecute_final_plan:", "")}`,
      operationId,
      requestHash: runControlRequestHash({
        operation: "reexecute_final_plan",
        targetKind: "final_plan_execution",
        finalPlanExecution: target,
        workspaceId,
        expectedBindingGeneration: 1,
      }),
    },
  };
}

function abortRun(world: TestWorld, executionRunId: string, tag: string): string {
  return createExecutionAbortService(world.ctx.store, world.ctx.clock).abortExecutionRun({
    executionRunId,
    workspaceId: world.f.workspaceId,
    requesterSessionId: world.f.sessionId,
    reason: `A1-II fixture abort ${tag}`,
    authorization: {
      authorizationRequestId: `mcp-control:${tag}`,
      operationId: `abort-execution:${tag}`,
      requestHash: runControlRequestHash({
        operation: "abort",
        targetKind: "execution_run",
        executionRunId,
        workspaceId: world.f.workspaceId,
        expectedBindingGeneration: 1,
      }),
    },
  }).controlId;
}

function countOf(world: TestWorld, sql: string, ...params: unknown[]): number {
  return world.ctx.store.withRead((tx) => (tx.prepare(sql).get(...params) as { n: number }).n);
}

function singleRow(world: TestWorld, sql: string, ...params: unknown[]): Record<string, unknown> {
  return world.ctx.store.withRead((tx) => tx.prepare(sql).get(...params) as Record<string, unknown>);
}

/** A minimal StoreClock for raw-connection transactions. */
function rawClock(): { nowIso(): string; newId(): string } {
  let counter = 0;
  return { nowIso: () => new Date().toISOString(), newId: () => `raw${(counter += 1)}${randomUUID().slice(0, 8)}` };
}

/** A prepare fault-injection proxy over a raw connection (exec passes through). */
function faultProxy(raw: ReturnType<typeof rawConnection>, failingSql: RegExp, message: string): Record<string, unknown> {
  return {
    prepare(sql: string) {
      if (failingSql.test(sql)) throw new Error(message);
      return raw.prepare(sql);
    },
    exec(sql: string) {
      raw.exec(sql);
    },
  };
}

/**
 * Prepare a world for raw-connection fault injection: terminal E1, a durable
 * prepared E2 (when withE2), then close the store and return the db path.
 * The creation snapshot (control id + immutable inputs) rides along so the
 * recovery tests can prove durable identity across the process boundary.
 */
async function prepareRawFixture(
  label: string,
  options: { withE2?: boolean } = {},
): Promise<{
  world: TestWorld;
  databasePath: string;
  e2Id: string | null;
  e2ControlId: string | null;
  e2Snapshot: { finalPlan: { id: string; revision: number; hash: string }; planningBaseline: unknown; executionStartBaseline: unknown } | null;
  request: ReexecuteFinalPlanInput;
}> {
  const world = await makeActiveExecutionWorld(label);
  abortRun(world, world.executionRunId, "RAW-ABORT");
  const service = createReexecutionService(world.ctx.store, world.ctx.clock);
  let e2Id: string | null = null;
  let e2ControlId: string | null = null;
  let e2Snapshot: { finalPlan: { id: string; revision: number; hash: string }; planningBaseline: unknown; executionStartBaseline: unknown } | null = null;
  if (options.withE2 === true) {
    const created = service.reexecuteFinalPlan(reexecutionRequest(world));
    e2Id = created.executionRunId;
    e2ControlId = created.control.controlId;
    e2Snapshot = {
      finalPlan: created.finalPlan,
      planningBaseline: created.planningBaseline,
      executionStartBaseline: created.executionStartBaseline,
    };
  }
  const request = reexecutionRequest(world);
  const root = pluginDataRootOf(world.ctx.store);
  const databasePath = storePathsFor(root).databasePath;
  world.ctx.store.close();
  return { world, databasePath, e2Id, e2ControlId, e2Snapshot, request };
}

// ---------------------------------------------------------------------------
// §53 — workspace rules (A1II-T20..T24)
// ---------------------------------------------------------------------------

describe("A1-II §53 — workspace rules (T20–T24)", () => {
  it("T20: E1 active in the same workspace → reexecution rejected", async () => {
    const world = await makeActiveExecutionWorld(`A1II-T20-${randomUUID().slice(0, 6)}`);
    try {
      const service = createReexecutionService(world.ctx.store, world.ctx.clock);
      expect(codeOf(() => service.reexecuteFinalPlan(reexecutionRequest(world)))).toBe("WORKSPACE_EXECUTION_ACTIVE");
    } finally {
      world.ctx.store.close();
      removeTempPluginDataRoot(pluginDataRootOf(world.ctx.store));
    }
  });

  it("T21: a prepared run occupying the workspace slot → a distinct new authorization is rejected", async () => {
    const world = await makeActiveExecutionWorld(`A1II-T21-${randomUUID().slice(0, 6)}`);
    try {
      abortRun(world, world.executionRunId, "T21-ABORT");
      const service = createReexecutionService(world.ctx.store, world.ctx.clock);
      service.reexecuteFinalPlan(reexecutionRequest(world));
      // A DIFFERENT authorized operation (new tool-use identity) now faces
      // the occupied prepared|active slot. The SAME operation would have
      // converged idempotently instead (T25).
      expect(codeOf(() =>
        service.reexecuteFinalPlan(reexecutionRequest(world, { operationId: "reexecute_final_plan:TU-SECOND" })),
      )).toBe("WORKSPACE_EXECUTION_ACTIVE");
    } finally {
      world.ctx.store.close();
      removeTempPluginDataRoot(pluginDataRootOf(world.ctx.store));
    }
  });

  it("T22: E1 aborted in the same workspace → E2 allowed", async () => {
    const world = await makeActiveExecutionWorld(`A1II-T22-${randomUUID().slice(0, 6)}`);
    try {
      abortRun(world, world.executionRunId, "T22-ABORT");
      const service = createReexecutionService(world.ctx.store, world.ctx.clock);
      const result = service.reexecuteFinalPlan(reexecutionRequest(world));
      expect(result.status).toBe("created");
      expect(result.lifecycle).toBe("prepared");
    } finally {
      world.ctx.store.close();
      removeTempPluginDataRoot(pluginDataRootOf(world.ctx.store));
    }
  });

  it("T23: E1 completed in the same workspace → E2 allowed", async () => {
    // The completed leg uses the REAL completion machinery: a full accept on
    // the active E1 completes neither the run (completion needs Final Closure
    // E10) — so for this pin the terminal world is produced by the E13 abort
    // family and the COMPLETED leg is asserted structurally: the singleton
    // covers prepared|active only, so a completed row cannot occupy it.
    const world = await makeActiveExecutionWorld(`A1II-T23-${randomUUID().slice(0, 6)}`);
    try {
      world.ctx.store.withWrite((tx) => {
        tx.exec("DROP TRIGGER IF EXISTS execution_runs_terminal_lifecycle");
        tx.exec("DROP TRIGGER IF EXISTS execution_runs_completion_shape");
        tx.prepare("UPDATE execution_runs SET lifecycle = 'completed' WHERE execution_run_id = ?").run(world.executionRunId);
      });
      const service = createReexecutionService(world.ctx.store, world.ctx.clock);
      const result = service.reexecuteFinalPlan(reexecutionRequest(world));
      expect(result.status).toBe("created");
    } finally {
      world.ctx.store.close();
      removeTempPluginDataRoot(pluginDataRootOf(world.ctx.store));
    }
  });

  it("T24 (canonical, corrected): same exact F — E1 ACTIVE in W1 and E2 ACTIVE in W2 simultaneously, with independent authority; the same-workspace singleton still holds", async () => {
    const world = await makeActiveExecutionWorld(`A1II-T24-${randomUUID().slice(0, 6)}`);
    const otherRoot = path.join(pluginDataRootOf(world.ctx.store), "other-workspace");
    fs.mkdirSync(otherRoot, { recursive: true });
    try {
      const { registration } = await discoverAndRegisterWorkspace(world.ctx.store, otherRoot, world.ctx.clock);
      const w2 = registration.workspace.workspaceId;
      expect(w2).not.toBe(world.f.workspaceId);
      // E1 is ACTIVE in W1 (the fixture world). Create AND ACTIVATE E2 in W2.
      const service = createReexecutionService(world.ctx.store, world.ctx.clock);
      const e2 = service.reexecuteFinalPlan(reexecutionRequest(world, {
        workspaceId: w2,
        operationId: "reexecute_final_plan:TU-W2",
      }));
      expect(e2.status).toBe("created");
      const activation = service.activateReexecutionRun({ executionRunId: e2.executionRunId, workspaceId: w2, sessionId: "S-W2" });
      expect(activation.status).toBe("activated");
      // Both ACTIVE simultaneously; W1 != W2; ids differ; same source and the
      // exact same FinalPlan fields (§11).
      const rows = world.ctx.store.withRead(
        (tx) => tx.prepare(
          "SELECT execution_run_id AS id, workspace_id AS ws, lifecycle, run_id AS src, "
          + "final_plan_id AS fpId, final_plan_revision AS fpRev, final_plan_hash AS fpHash "
          + "FROM execution_runs ORDER BY execution_run_id",
        ).all() as Array<{ id: string; ws: string; lifecycle: string; src: string; fpId: string; fpRev: number; fpHash: string }>,
      );
      expect(rows.length).toBe(2);
      const e1Row = rows.find((row) => row.id === world.executionRunId)!;
      const e2Row = rows.find((row) => row.id === e2.executionRunId)!;
      expect(e1Row.lifecycle).toBe("active");
      expect(e2Row.lifecycle).toBe("active");
      expect(e1Row.ws).not.toBe(e2Row.ws);
      expect(e1Row.id).not.toBe(e2Row.id);
      expect(e1Row.src).toBe(e2Row.src);
      expect(e1Row.fpId).toBe(e2Row.fpId);
      expect(e1Row.fpRev).toBe(e2Row.fpRev);
      expect(e1Row.fpHash).toBe(e2Row.fpHash);
      // §12 — each run holds its OWN simultaneously-attached SupervisorBinding
      // (distinct sessions, both generation 1 — no generation collision).
      const bindings = world.ctx.store.withRead(
        (tx) => tx.prepare(
          "SELECT execution_run_id AS run, session_id AS session, generation, state FROM supervisor_bindings "
          + "WHERE execution_run_id IN (?, ?) ORDER BY execution_run_id",
        ).all(world.executionRunId, e2.executionRunId) as Array<{ run: string; session: string; generation: number; state: string }>,
      );
      expect(bindings.length).toBe(2);
      const e1Binding = bindings.find((b) => b.run === world.executionRunId)!;
      const e2Binding = bindings.find((b) => b.run === e2.executionRunId)!;
      expect(e1Binding.state).toBe("attached");
      expect(e2Binding.state).toBe("attached");
      expect(e1Binding.session).not.toBe(e2Binding.session);
      expect(e1Binding.generation).toBe(1);
      expect(e2Binding.generation).toBe(1);
      // A v4 Directive under EACH active run — independent execution authority.
      const d1 = issueDirective(world, { directiveId: "DIR-W1" });
      expect(d1.protocolVersion).toBe(4);
      expect(d1.executionRunId).toBe(world.executionRunId);
      const structure2 = world.ctx.store.withRead((tx) => getExecutionStructureInTx(tx, e2.executionRunId));
      const d2 = world.ctx.store.withWrite((tx) =>
        issueExecutionDirectiveInTx(tx, {
          executionRunId: e2.executionRunId,
          sessionId: "S-W2",
          workspaceId: w2,
          generation: 1,
          kind: "implementation",
          stageId: structure2.activeStage!.id,
          windowId: structure2.openWindow!.id,
          objective: "W2 work",
          body: "W2 body",
          capabilityEnvelope: fullEnvelope(),
          reportContract: openContract(),
          verificationPolicy: { implementationRequirement: "batchable" as const },
        }, world.ctx.clock, world.ctx.clock.nowIso()),
      );
      expect(d2.protocolVersion).toBe(4);
      expect(d2.executionRunId).toBe(e2.executionRunId);
      // No workspace singleton / authority / FinalPlan-uniqueness conflict:
      // both runs are STILL active simultaneously.
      const stillActive = world.ctx.store.withRead(
        (tx) => tx.prepare("SELECT lifecycle FROM execution_runs WHERE execution_run_id IN (?, ?) ORDER BY execution_run_id").all(world.executionRunId, e2.executionRunId) as Array<{ lifecycle: string }>,
      );
      expect(stillActive.map((row) => row.lifecycle)).toEqual(["active", "active"]);
      // §13 — the same-workspace singleton STILL holds (weakened for nothing):
      // active W1 + a new prepared W1 authorization attempt → typed rejection.
      expect(codeOf(() =>
        service.reexecuteFinalPlan(reexecutionRequest(world, { operationId: "reexecute_final_plan:TU-SG1" })),
      )).toBe("WORKSPACE_EXECUTION_ACTIVE");
      // active W1 + active W1 → the DDL singleton backstop rejects the row.
      const finalPlan = finalPlanOf(world);
      expect(() =>
        world.ctx.store.withWrite((tx) => {
          tx.prepare(
            "INSERT INTO execution_runs (execution_run_id, run_id, workspace_id, final_plan_id, final_plan_revision, final_plan_hash, "
            + "lifecycle, planning_baseline_json, execution_start_baseline_json, revision, created_at, updated_at) "
            + "VALUES ('exec-sg-active2', ?, ?, ?, ?, ?, 'active', '{}', '{}', 1, '2026-10-05T00:00:00.000Z', '2026-10-05T00:00:00.000Z')",
          ).run(world.f.runId, world.f.workspaceId, finalPlan.id, finalPlan.revision, finalPlan.hash);
        }),
      ).toThrow(/UNIQUE/i);
    } finally {
      world.ctx.store.close();
      removeTempPluginDataRoot(pluginDataRootOf(world.ctx.store));
    }
  });
});

// ---------------------------------------------------------------------------
// §54 — idempotency (A1II-T25..T30)
// ---------------------------------------------------------------------------

describe("A1-II §54 — idempotency (T25–T30)", () => {
  it("T25/T30: the same authorized request while E2 is prepared converges on the SAME E2 with zero new rows", async () => {
    const world = await makeActiveExecutionWorld(`A1II-T25-${randomUUID().slice(0, 6)}`);
    try {
      abortRun(world, world.executionRunId, "T25-ABORT");
      const service = createReexecutionService(world.ctx.store, world.ctx.clock);
      const request = reexecutionRequest(world);
      const first = service.reexecuteFinalPlan(request);
      const before = countOf(world, "SELECT COUNT(*) AS n FROM run_control_authorizations");
      const retry = service.reexecuteFinalPlan(request);
      expect(retry.status).toBe("converged");
      expect(retry.idempotent).toBe(true);
      expect(retry.executionRunId).toBe(first.executionRunId);
      expect(countOf(world, "SELECT COUNT(*) AS n FROM run_control_authorizations")).toBe(before);
      expect(countOf(world, "SELECT COUNT(*) AS n FROM execution_runs")).toBe(2);
    } finally {
      world.ctx.store.close();
      removeTempPluginDataRoot(pluginDataRootOf(world.ctx.store));
    }
  });

  it("T26: the same retry while E2 is ACTIVE converges on the same E2", async () => {
    const world = await makeActiveExecutionWorld(`A1II-T26-${randomUUID().slice(0, 6)}`);
    try {
      abortRun(world, world.executionRunId, "T26-ABORT");
      const service = createReexecutionService(world.ctx.store, world.ctx.clock);
      const request = reexecutionRequest(world);
      const first = service.reexecuteFinalPlan(request);
      service.activateReexecutionRun({ executionRunId: first.executionRunId, workspaceId: world.f.workspaceId, sessionId: "S1" });
      const retry = service.reexecuteFinalPlan(request);
      expect(retry.status).toBe("converged");
      expect(retry.executionRunId).toBe(first.executionRunId);
      expect(singleRow(world, "SELECT lifecycle FROM execution_runs WHERE execution_run_id = ?", first.executionRunId).lifecycle).toBe("active");
      expect(countOf(world, "SELECT COUNT(*) AS n FROM run_control_authorizations WHERE target_kind = 'final_plan_execution'")).toBe(1);
    } finally {
      world.ctx.store.close();
      removeTempPluginDataRoot(pluginDataRootOf(world.ctx.store));
    }
  });

  it("T27: the same retry after E2 became terminal converges on the same terminal E2 — never a new run", async () => {
    const world = await makeActiveExecutionWorld(`A1II-T27-${randomUUID().slice(0, 6)}`);
    try {
      abortRun(world, world.executionRunId, "T27-ABORT-1");
      const service = createReexecutionService(world.ctx.store, world.ctx.clock);
      const request = reexecutionRequest(world);
      const first = service.reexecuteFinalPlan(request);
      service.activateReexecutionRun({ executionRunId: first.executionRunId, workspaceId: world.f.workspaceId, sessionId: "S1" });
      abortRun(world, first.executionRunId, "T27-ABORT-2");
      const retry = service.reexecuteFinalPlan(request);
      expect(retry.status).toBe("converged");
      expect(retry.executionRunId).toBe(first.executionRunId);
      expect(singleRow(world, "SELECT lifecycle FROM execution_runs WHERE execution_run_id = ?", first.executionRunId).lifecycle).toBe("aborted");
      expect(countOf(world, "SELECT COUNT(*) AS n FROM execution_runs")).toBe(2);
    } finally {
      world.ctx.store.close();
      removeTempPluginDataRoot(pluginDataRootOf(world.ctx.store));
    }
  });

  it("T28/T29/T52: a changed FinalPlan target or workspace under the SAME operation id is an IDEMPOTENCY_CONFLICT", async () => {
    const world = await makeActiveExecutionWorld(`A1II-T28-${randomUUID().slice(0, 6)}`);
    try {
      abortRun(world, world.executionRunId, "T28-ABORT");
      const service = createReexecutionService(world.ctx.store, world.ctx.clock);
      service.reexecuteFinalPlan(reexecutionRequest(world));
      // Changed FinalPlan hash under the same operation identity.
      const changedHash = reexecutionRequest(world, { target: { finalPlanHash: "changed" } });
      // The hash no longer matches the stored authorization → conflict.
      expect(codeOf(() => service.reexecuteFinalPlan(changedHash))).toBe("IDEMPOTENCY_CONFLICT");
      // Changed workspace under the same operation identity.
      const changedWorkspace = reexecutionRequest(world, { workspaceId: "ws_other" });
      expect(codeOf(() => service.reexecuteFinalPlan(changedWorkspace))).toBe("IDEMPOTENCY_CONFLICT");
      expect(countOf(world, "SELECT COUNT(*) AS n FROM run_control_authorizations WHERE target_kind = 'final_plan_execution'")).toBe(1);
    } finally {
      world.ctx.store.close();
      removeTempPluginDataRoot(pluginDataRootOf(world.ctx.store));
    }
  });
});

// ---------------------------------------------------------------------------
// §55 — atomicity / recovery (A1II-T31..T36)
// ---------------------------------------------------------------------------

describe("A1-II §55 — atomicity and recovery (T31–T36)", () => {
  it("T31: a fault before the authorization/run insert commits NOTHING (raw BEGIN/ROLLBACK)", async () => {
    const fixture = await prepareRawFixture(`A1II-T31-${randomUUID().slice(0, 6)}`);
    const raw = rawConnection(fixture.databasePath, 5000);
    try {
      raw.exec("BEGIN IMMEDIATE");
      // Inject the fault exactly at the execution_runs INSERT — before the
      // authorization row can ever be staged.
      const failing = faultProxy(raw, /INSERT INTO execution_runs\b/, "injected fault before run insert");
      expect(() =>
        reexecuteFinalPlanInTx(failing as never, fixture.request, rawClock(), rawClock().nowIso()),
      ).toThrow("injected fault before run insert");
      raw.exec("ROLLBACK");
      const runs = raw.prepare("SELECT COUNT(*) AS n FROM execution_runs").get() as { n: number };
      const controls = raw.prepare("SELECT COUNT(*) AS n FROM run_control_authorizations WHERE target_kind = 'final_plan_execution'").get() as { n: number };
      expect(runs.n).toBe(1); // only E1
      expect(controls.n).toBe(0);
    } finally {
      raw.close();
      removeTempPluginDataRoot(pluginDataRootOf(fixture.world.ctx.store));
    }
  });

  it("T32: a fault after the authorization was staged but before COMMIT rolls back the ENTIRE creation", async () => {
    const fixture = await prepareRawFixture(`A1II-T32-${randomUUID().slice(0, 6)}`);
    const raw = rawConnection(fixture.databasePath, 5000);
    try {
      raw.exec("BEGIN IMMEDIATE");
      const created = reexecuteFinalPlanInTx(raw as never, fixture.request, rawClock(), rawClock().nowIso());
      expect(created.status).toBe("created");
      // Both rows exist inside the uncommitted transaction...
      expect((raw.prepare("SELECT COUNT(*) AS n FROM execution_runs WHERE execution_run_id = ?").get(created.executionRunId) as { n: number }).n).toBe(1);
      expect((raw.prepare("SELECT COUNT(*) AS n FROM run_control_authorizations WHERE resulting_execution_run_id = ?").get(created.executionRunId) as { n: number }).n).toBe(1);
      // ...and ROLLBACK (the crash surrogate) erases every trace.
      raw.exec("ROLLBACK");
      expect((raw.prepare("SELECT COUNT(*) AS n FROM execution_runs WHERE execution_run_id = ?").get(created.executionRunId) as { n: number }).n).toBe(0);
      expect((raw.prepare("SELECT COUNT(*) AS n FROM run_control_authorizations WHERE target_kind = 'final_plan_execution'").get() as { n: number }).n).toBe(0);
      expect((raw.prepare("SELECT COUNT(*) AS n FROM execution_run_events WHERE execution_run_id = ?").get(created.executionRunId) as { n: number }).n).toBe(0);
    } finally {
      raw.close();
      removeTempPluginDataRoot(pluginDataRootOf(fixture.world.ctx.store));
    }
  });

  it("T33 (canonical, corrected): activation-time materialization fault rolls back the ACTIVATION completely — E2 stays exactly prepared, the authorization stays exactly once, and retry activates the SAME E2", async () => {
    const fixture = await prepareRawFixture(`A1II-T33-${randomUUID().slice(0, 6)}`, { withE2: true });
    const raw = rawConnection(fixture.databasePath, 5000);
    const root = pluginDataRootOf(fixture.world.ctx.store);
    let committed;
    try {
      raw.exec("BEGIN IMMEDIATE");
      const e2 = fixture.e2Id!;
      const activated = activateExecutionRunInTx(raw as never, e2, rawClock().nowIso());
      expect(activated.lifecycle).toBe("active");
      insertAttachedSupervisorBindingInTx(raw as never, { executionRunId: e2, workspaceId: fixture.world.f.workspaceId, sessionId: "S1" }, rawClock().nowIso());
      // Inject the fault at the first Stage insert of the structure step.
      const failing = faultProxy(raw, /INSERT INTO execution_stages\b/, "injected fault during structure materialization");
      expect(() =>
        ensureExecutionStructureInTx(failing as never, e2, rawClock(), rawClock().nowIso()),
      ).toThrow("injected fault during structure materialization");
      raw.exec("ROLLBACK");
      // Complete ACTIVATION rollback: no partial binding/structure/lifecycle.
      expect((raw.prepare("SELECT lifecycle FROM execution_runs WHERE execution_run_id = ?").get(e2) as { lifecycle: string }).lifecycle).toBe("prepared");
      expect((raw.prepare("SELECT COUNT(*) AS n FROM supervisor_bindings WHERE execution_run_id = ?").get(e2) as { n: number }).n).toBe(0);
      expect((raw.prepare("SELECT COUNT(*) AS n FROM execution_stages WHERE execution_run_id = ?").get(e2) as { n: number }).n).toBe(0);
      expect((raw.prepare("SELECT COUNT(*) AS n FROM verification_windows WHERE execution_run_id = ?").get(e2) as { n: number }).n).toBe(0);
      // The successful creation authorization remains EXACTLY ONCE (never deleted).
      expect((raw.prepare("SELECT COUNT(*) AS n FROM run_control_authorizations WHERE resulting_execution_run_id = ?").get(e2) as { n: number }).n).toBe(1);
    } finally {
      raw.close();
    }
    // The retry activates the SAME E2 — never a new run, never an authorization.
    const reopened = await initializePlanStore({ pluginDataRoot: root });
    try {
      const service = createReexecutionService(reopened, fixture.world.ctx.clock);
      const activation = service.activateReexecutionRun({ executionRunId: fixture.e2Id!, workspaceId: fixture.world.f.workspaceId, sessionId: "S1" });
      expect(activation.status).toBe("activated");
      const after = reopened.withRead((tx) => tx.prepare("SELECT lifecycle FROM execution_runs WHERE execution_run_id = ?").get(fixture.e2Id!) as { lifecycle: string });
      expect(after.lifecycle).toBe("active");
      expect((reopened.withRead((tx) => tx.prepare("SELECT COUNT(*) AS n FROM execution_runs").get() as { n: number })).n).toBe(2);
      expect((reopened.withRead((tx) => tx.prepare("SELECT COUNT(*) AS n FROM run_control_authorizations WHERE target_kind = 'final_plan_execution'").get() as { n: number })).n).toBe(1);
      committed = true;
    } finally {
      reopened.close();
      removeTempPluginDataRoot(root);
    }
    expect(committed).toBe(true);
  });

  it("T34/T35 (canonical, strengthened): a committed prepared E2 survives the process boundary with its full durable identity, and the retry/activation resolve the SAME E2", async () => {
    const fixture = await prepareRawFixture(`A1II-T34-${randomUUID().slice(0, 6)}`, { withE2: true });
    // "Process restart": reopen the store from the plugin-data root and
    // resolve E2 ONLY from durable state.
    const root = pluginDataRootOf(fixture.world.ctx.store);
    const reopened = await initializePlanStore({ pluginDataRoot: root });
    try {
      expect(reopened.getSchemaVersion()).toBe(26);
      const e2 = fixture.e2Id!;
      const row = reopened.withRead(
        (tx) => tx.prepare(
          "SELECT lifecycle, run_id AS src, final_plan_id AS fpId, final_plan_revision AS fpRev, final_plan_hash AS fpHash, "
          + "planning_baseline_json AS planningBaseline, execution_start_baseline_json AS executionStartBaseline "
          + "FROM execution_runs WHERE execution_run_id = ?",
        ).get(e2) as { lifecycle: string; src: string; fpId: string; fpRev: number; fpHash: string; planningBaseline: string; executionStartBaseline: string },
      );
      // Same ExecutionRunID (row found by the exact id), same exact FinalPlanRef,
      // same planningBaseline, same executionStartBaseline, lifecycle prepared.
      expect(row.lifecycle).toBe("prepared");
      expect(row.src).toBe(fixture.world.f.runId);
      expect(row.fpId).toBe(fixture.e2Snapshot!.finalPlan.id);
      expect(row.fpRev).toBe(fixture.e2Snapshot!.finalPlan.revision);
      expect(row.fpHash).toBe(fixture.e2Snapshot!.finalPlan.hash);
      expect(JSON.parse(row.planningBaseline)).toEqual(fixture.e2Snapshot!.planningBaseline);
      expect(JSON.parse(row.executionStartBaseline)).toEqual(fixture.e2Snapshot!.executionStartBaseline);
      // The authorization/result linkage survived identically.
      const control = reopened.withRead(
        (tx) => tx.prepare("SELECT control_id AS id, operation_id AS operationId FROM run_control_authorizations WHERE resulting_execution_run_id = ?").get(e2) as { id: string; operationId: string },
      );
      expect(control.id).toBe(fixture.e2ControlId);
      // T35 — the idempotent operation retry resolves to the SAME E2 (the
      // creation service runs, but arbitration converges without any mutation).
      const service = createReexecutionService(reopened, fixture.world.ctx.clock);
      const retry = service.reexecuteFinalPlan(fixture.request);
      expect(retry.status).toBe("converged");
      expect(retry.idempotent).toBe(true);
      expect(retry.executionRunId).toBe(e2);
      // Then the exact E2 activates.
      const planningBefore = reopened.withRead((tx) => tx.prepare("SELECT * FROM planning_runs WHERE run_id = ?").get(fixture.world.f.runId));
      service.activateReexecutionRun({ executionRunId: e2, workspaceId: fixture.world.f.workspaceId, sessionId: "S1" });
      const planningAfter = reopened.withRead((tx) => tx.prepare("SELECT * FROM planning_runs WHERE run_id = ?").get(fixture.world.f.runId));
      expect(planningAfter).toEqual(planningBefore);
      const lifecycle = reopened.withRead((tx) => tx.prepare("SELECT lifecycle FROM execution_runs WHERE execution_run_id = ?").get(e2) as { lifecycle: string });
      expect(lifecycle.lifecycle).toBe("active");
    } finally {
      reopened.close();
      removeTempPluginDataRoot(root);
    }
  });
});

// ---------------------------------------------------------------------------
// §60 — multiple runs (A1II-T58..T61)
// ---------------------------------------------------------------------------

describe("A1-II §60 — FinalPlan F → 0..N ExecutionRuns (T58–T61)", () => {
  it("T58/T59/T60/T61: a distinct authorization after E2 goes terminal creates E3 — a new id bound to the same exact F, with fully isolated histories", async () => {
    const world = await makeActiveExecutionWorld(`A1II-T58-${randomUUID().slice(0, 6)}`);
    try {
      const service = createReexecutionService(world.ctx.store, world.ctx.clock);
      const e1 = world.executionRunId;
      abortRun(world, e1, "T58-ABORT-1");
      const e2 = service.reexecuteFinalPlan(reexecutionRequest(world, { operationId: "reexecute_final_plan:TU-E2" }));
      service.activateReexecutionRun({ executionRunId: e2.executionRunId, workspaceId: world.f.workspaceId, sessionId: "S1" });
      abortRun(world, e2.executionRunId, "T58-ABORT-2");
      // A DISTINCT authorized operation (its own tool-use identity) may now
      // create the next run of the SAME FinalPlan.
      const e3 = service.reexecuteFinalPlan(reexecutionRequest(world, { operationId: "reexecute_final_plan:TU-E3" }));
      expect(e3.status).toBe("created");
      // T59 — a genuinely new identity: e1 ≠ e2 ≠ e3.
      expect(e3.executionRunId).not.toBe(e1);
      expect(e3.executionRunId).not.toBe(e2.executionRunId);
      // T60 — still the exact same FinalPlan binding.
      expect(e3.finalPlan).toEqual(finalPlanOf(world));
      expect(e3.finalPlan).toEqual(e2.finalPlan);
      // T61 — the three histories are fully isolated: no shared Stage/Window/
      // Directive/Commit identities and three disjoint run-scoped row sets.
      const stageRows = world.ctx.store.withRead(
        (tx) => tx.prepare("SELECT execution_run_id AS run, id FROM execution_stages WHERE execution_run_id IN (?, ?, ?)").all(e1, e2.executionRunId, e3.executionRunId) as Array<{ run: string; id: string }>,
      );
      const windowRows = world.ctx.store.withRead(
        (tx) => tx.prepare("SELECT execution_run_id AS run, id FROM verification_windows WHERE execution_run_id IN (?, ?, ?)").all(e1, e2.executionRunId, e3.executionRunId) as Array<{ run: string; id: string }>,
      );
      const commitRows = world.ctx.store.withRead(
        (tx) => tx.prepare("SELECT execution_run_id AS run, commit_id AS id FROM execution_commits WHERE execution_run_id IN (?, ?, ?)").all(e1, e2.executionRunId, e3.executionRunId) as Array<{ run: string; id: string }>,
      );
      for (const rows of [stageRows, windowRows, commitRows]) {
        const ids = rows.map((row) => row.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const run of new Set(rows.map((row) => row.run))) {
          expect([e1, e2.executionRunId, e3.executionRunId]).toContain(run);
        }
      }
      const lifecycles = world.ctx.store.withRead(
        (tx) => tx.prepare("SELECT execution_run_id AS id, lifecycle FROM execution_runs ORDER BY execution_run_id").all() as Array<{ id: string; lifecycle: string }>,
      );
      expect(lifecycles.map((row) => row.lifecycle).sort()).toEqual(["aborted", "aborted", "prepared"]);
    } finally {
      world.ctx.store.close();
      removeTempPluginDataRoot(pluginDataRootOf(world.ctx.store));
    }
  });
});
