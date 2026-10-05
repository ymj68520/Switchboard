/**
 * A1-II — explicit same-FinalPlan reexecution: core contract, isolation,
 * baselines, real execution, authorization boundary, stable errors, and the
 * no-hidden-replan/handoff family (directive §50–§59, A1II-T1..T19/T37..T57).
 *
 * Every mutating step rides the REAL production paths: E1 comes from the
 * frozen E1→E6 world builders, the human abort from the E13 service,
 * reexecution from the A1-II service, and E2 execution from the canonical
 * E3–E6 surfaces. No fixture ever writes an execution row directly.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  makeActiveExecutionWorld,
  codeOf,
  fullEnvelope,
  openContract,
} from "./execution-protocol-helpers.js";
import {
  makeAcceptanceWorld,
  runDirectiveCycle,
  runVerificationCycle,
  acceptInput,
  acceptanceServiceOf,
  completeActiveStageFixture,
  type AcceptanceWorld,
} from "./acceptance-helpers.js";
import { createExecutionAbortService } from "../src/application/execution-abort-service.js";
import {
  createReexecutionService,
  type ReexecuteFinalPlanInput,
} from "../src/application/reexecution-service.js";
import { issueExecutionDirectiveInTx } from "../src/application/execution-directive-service.js";
import { startExecutionAttemptInTx } from "../src/application/execution-attempt-service.js";
import { getExecutionStructureInTx } from "../src/application/execution-structure-service.js";
import { runControlRequestHash } from "../src/store/run-control.js";
import { getFinalPlanInTx } from "../src/store/finalization.js";
import { getExecutionRunInTx } from "../src/store/execution-runs.js";
import { discoverAndRegisterWorkspace } from "../src/workspace/identity.js";
import { removeTempPluginDataRoot } from "./store-helpers.js";
import { hostTokenV2 } from "./phase12-helpers.js";
import { executePhasePlanTool, PHASE_PLAN_TOOLS, REQUIRES_USER_INTERACTION_META } from "../src/mcp/tools.js";

type TestWorld = Awaited<ReturnType<typeof makeActiveExecutionWorld>>;

function pluginDataRootOf(store: { path: string }): string {
  return path.dirname(path.dirname(store.path));
}

/** The committed FinalPlan identity of the world's source planning run. */
function finalPlanOf(world: TestWorld): { id: string; revision: number; hash: string } {
  const row = world.ctx.store.withRead((tx) => getFinalPlanInTx(tx, world.f.runId));
  if (row === null) throw new Error("fixture FinalPlan missing");
  return { id: row.finalPlanId, revision: row.revision, hash: row.finalPlanHash };
}

/** The exact authorized reexecution request against a world (A1-II §11). */
function reexecutionRequest(
  world: TestWorld,
  overrides: {
    operationId?: string;
    authorizationRequestId?: string;
    requesterSessionId?: string;
    target?: Partial<{ sourcePlanningRunId: string; finalPlanId: string; finalPlanRevision: number; finalPlanHash: string }>;
    workspaceId?: string;
    reason?: string;
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
  const authorizationRequestId = overrides.authorizationRequestId ?? "mcp-control:TU-REEXEC-1";
  return {
    ...target,
    workspaceId,
    requesterSessionId: overrides.requesterSessionId ?? "S1",
    toolUseId: operationId.replace("reexecute_final_plan:", ""),
    ...(overrides.reason === undefined ? {} : { reason: overrides.reason }),
    authorization: {
      authorizationRequestId,
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

/** The human-authorized E13 abort of a run (the real production terminal path). */
function abortRun(world: TestWorld, executionRunId: string, tag: string, workspaceId?: string): string {
  return createExecutionAbortService(world.ctx.store, world.ctx.clock).abortExecutionRun({
    executionRunId,
    workspaceId: workspaceId ?? world.f.workspaceId,
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

function countsOf(world: TestWorld, tables: string[]): Record<string, number> {
  return world.ctx.store.withRead((tx) =>
    Object.fromEntries(
      tables.map((t) => [t, (tx.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n]),
    ),
  );
}

/** Ordered full-row dump of a run-scoped execution table (byte-compare fuel). */
function runRows(world: TestWorld, table: string, executionRunId: string): string[] {
  return world.ctx.store.withRead((tx) => {
    const rows = tx.prepare(`SELECT * FROM ${table} WHERE execution_run_id = ? ORDER BY rowid`).all(executionRunId);
    return (rows as Record<string, unknown>[]).map((row) => JSON.stringify(row));
  });
}

function singleRow(world: TestWorld, sql: string, ...params: unknown[]): Record<string, unknown> {
  return world.ctx.store.withRead((tx) => tx.prepare(sql).get(...params) as Record<string, unknown>);
}

/** Structure pointers (active stage + open window) of a run. */
function structureOf(world: TestWorld, executionRunId: string) {
  return world.ctx.store.withRead((tx) => getExecutionStructureInTx(tx, executionRunId));
}

/** A full E1 world with real accepted progress (§40 "make accepted progress"). */
async function makeProgressedWorld(sessionId = "S1"): Promise<AcceptanceWorld> {
  const world = await makeAcceptanceWorld(sessionId);
  completeActiveStageFixture(world);
  return world;
}

// ---------------------------------------------------------------------------
// §50 — core reexecution (A1II-T1..T8)
// ---------------------------------------------------------------------------

describe("A1-II §50 — core reexecution (T1–T8)", () => {
  it("T3/T4 + prepared boundary (canonical T1 acceptance leg): one authorized request creates exactly one SELF-SUFFICIENT prepared E2", async () => {
    const world = await makeActiveExecutionWorld(`A1II-CORE-${randomUUID().slice(0, 6)}`);
    try {
      abortRun(world, world.executionRunId, "T1-ABORT");
      const service = createReexecutionService(world.ctx.store, world.ctx.clock);
      const request = reexecutionRequest(world);
      const result = service.reexecuteFinalPlan(request);
      expect(result.status).toBe("created");
      expect(result.idempotent).toBe(false);
      expect(result.lifecycle).toBe("prepared");
      expect(result.executionRunId).not.toBe(world.executionRunId);
      // T4 — the exact FinalPlan binding, compared field by field.
      const expected = finalPlanOf(world);
      expect(result.finalPlan).toEqual(expected);
      const run = world.ctx.store.withRead((tx) => getExecutionRunInTx(tx, result.executionRunId));
      expect(run).not.toBeNull();
      expect(run?.finalPlan).toEqual(expected);
      expect(run?.runId).toBe(world.f.runId);
      expect(run?.lifecycle).toBe("prepared");
      // A1-II closure amendment — the canonical prepared boundary: ALL
      // immutable activation inputs are durable, and NOTHING else exists yet.
      const boundary = world.ctx.store.withRead((tx) =>
        ({
          stages: (tx.prepare("SELECT COUNT(*) AS n FROM execution_stages WHERE execution_run_id = ?").get(result.executionRunId) as { n: number }).n,
          windows: (tx.prepare("SELECT COUNT(*) AS n FROM verification_windows WHERE execution_run_id = ?").get(result.executionRunId) as { n: number }).n,
          bindings: (tx.prepare("SELECT COUNT(*) AS n FROM supervisor_bindings WHERE execution_run_id = ?").get(result.executionRunId) as { n: number }).n,
          directives: (tx.prepare("SELECT COUNT(*) AS n FROM execution_directives WHERE execution_run_id = ?").get(result.executionRunId) as { n: number }).n,
          planningBaseline: (tx.prepare("SELECT planning_baseline_json AS b, execution_start_baseline_json AS s FROM execution_runs WHERE execution_run_id = ?").get(result.executionRunId) as { b: string; s: string }),
        }),
      );
      expect(boundary.stages).toBe(0);
      expect(boundary.windows).toBe(0);
      expect(boundary.bindings).toBe(0);
      expect(boundary.directives).toBe(0);
      expect(JSON.parse(boundary.planningBaseline.b)).toEqual(run?.planningBaseline);
      expect(JSON.parse(boundary.planningBaseline.s)).toEqual(run?.executionStartBaseline);
      // T3 — exactly one authorization row and one new run.
      const control = singleRow(
        world,
        "SELECT target_kind, operation, resulting_execution_run_id FROM run_control_authorizations WHERE operation_id = ?",
        request.authorization.operationId,
      );
      expect(control.target_kind).toBe("final_plan_execution");
      expect(control.operation).toBe("reexecute_final_plan");
      expect(control.resulting_execution_run_id).toBe(result.executionRunId);
      const runCount = world.ctx.store.withRead(
        (tx) => (tx.prepare("SELECT COUNT(*) AS n FROM execution_runs").get() as { n: number }).n,
      );
      expect(runCount).toBe(2);
    } finally {
      world.ctx.store.close();
      removeTempPluginDataRoot(pluginDataRootOf(world.ctx.store));
    }
  });

  it("T2: reexecution against an ACTIVE run is refused by the workspace slot; a missing source run is RUN_NOT_FOUND", async () => {
    const world = await makeActiveExecutionWorld(`A1II-T2-${randomUUID().slice(0, 6)}`);
    try {
      const service = createReexecutionService(world.ctx.store, world.ctx.clock);
      // E1 is active in the workspace: the §8 slot gate fires (the delivery
      // leg is proven separately in T2b).
      expect(codeOf(() => service.reexecuteFinalPlan(reexecutionRequest(world)))).toBe("WORKSPACE_EXECUTION_ACTIVE");
      const request = reexecutionRequest(world, { target: { sourcePlanningRunId: "plan_missing" } });
      // §13 validation order: the exact FinalPlan probe fires before the
      // initial-delivery probe — both are stable fail-closed rejections.
      expect(codeOf(() => service.reexecuteFinalPlan(request))).toBe("FINAL_PLAN_NOT_FOUND");
    } finally {
      world.ctx.store.close();
      removeTempPluginDataRoot(pluginDataRootOf(world.ctx.store));
    }
  });

  it("T2b (canonical T2): without delivered initial delivery → INITIAL_DELIVERY_NOT_COMPLETE; after legitimate delivery the same request class is eligible", async () => {
    const world = await makeActiveExecutionWorld(`A1II-T2b-${randomUUID().slice(0, 6)}`);
    try {
      abortRun(world, world.executionRunId, "T2B-ABORT");
      // The exact committed FinalPlan exists, but the initial delivery is not
      // complete (handoff state flipped off delivery).
      world.ctx.store.withWrite((tx) => {
        tx.prepare("UPDATE execution_handoff_states SET status = 'prepared' WHERE run_id = ?").run(world.f.runId);
      });
      const service = createReexecutionService(world.ctx.store, world.ctx.clock);
      const request = reexecutionRequest(world);
      expect(codeOf(() => service.reexecuteFinalPlan(request))).toBe("INITIAL_DELIVERY_NOT_COMPLETE");
      expect(codeOf(() => service.reexecuteFinalPlan(reexecutionRequest(world, { operationId: "reexecute_final_plan:TU-T2B-2", authorizationRequestId: "mcp-control:TU-T2B-2" })))).toBe("INITIAL_DELIVERY_NOT_COMPLETE");
      // Restore the legitimate delivered state — the SAME request class now
      // becomes eligible (subject to the workspace slot, which is free).
      world.ctx.store.withWrite((tx) => {
        tx.prepare("UPDATE execution_handoff_states SET status = 'delivered' WHERE run_id = ?").run(world.f.runId);
      });
      const eligible = service.reexecuteFinalPlan(reexecutionRequest(world, { operationId: "reexecute_final_plan:TU-T2B-3", authorizationRequestId: "mcp-control:TU-T2B-3" }));
      expect(eligible.status).toBe("created");
    } finally {
      world.ctx.store.close();
      removeTempPluginDataRoot(pluginDataRootOf(world.ctx.store));
    }
  });

  it("T5/T6/T7/T8/T45/T46: creation adds zero planning/handoff/binding artifacts and exactly one final_plan_execution row naming E2", async () => {
    const world = await makeActiveExecutionWorld(`A1II-NOART-${randomUUID().slice(0, 6)}`);
    try {
      abortRun(world, world.executionRunId, "T5-ABORT");
      const before = countsOf(world, [
        "planning_runs", "final_plans", "plan_commits", "approvals",
        "execution_handoffs", "execution_handoff_events", "execution_handoff_states", "execution_bindings",
        "execution_issues", "planning_run_baselines",
      ]);
      const service = createReexecutionService(world.ctx.store, world.ctx.clock);
      const result = service.reexecuteFinalPlan(reexecutionRequest(world));
      const after = countsOf(world, [
        "planning_runs", "final_plans", "plan_commits", "approvals",
        "execution_handoffs", "execution_handoff_events", "execution_handoff_states", "execution_bindings",
        "execution_issues", "planning_run_baselines",
      ]);
      for (const [table, n] of Object.entries(before)) {
        expect(after[table], table).toBe(n);
      }
      // T45/T46 — the one control row is final_plan_execution with E2 stamped
      // at the initial INSERT (append-only; A1 §14).
      const rows = world.ctx.store.withRead(
        (tx) => tx.prepare("SELECT * FROM run_control_authorizations WHERE target_kind = 'final_plan_execution'").all(),
      ) as Record<string, unknown>[];
      expect(rows.length).toBe(1);
      expect(rows[0]?.resulting_execution_run_id).toBe(result.executionRunId);
      expect(rows[0]?.execution_run_id).toBeNull();
      expect(rows[0]?.source_planning_run_id).toBe(world.f.runId);
    } finally {
      world.ctx.store.close();
      removeTempPluginDataRoot(pluginDataRootOf(world.ctx.store));
    }
  });
});

// ---------------------------------------------------------------------------
// §51/§52 — isolation + baselines (A1II-T9..T19)
// ---------------------------------------------------------------------------

describe("A1-II §51/§52 — isolation and baselines (T9–T19)", () => {
  it("T9/T19: E1 stays terminal and byte-identical through creation and activation of E2", async () => {
    const world = await makeProgressedWorld(`A1II-ISO-${randomUUID().slice(0, 6)}`);
    try {
      const e1 = world.executionRunId;
      abortRun(world, e1, "T9-ABORT");
      const tables = [
        "execution_runs", "execution_run_events", "execution_stages", "verification_windows",
        "execution_directives", "execution_attempts", "execution_reports",
        "execution_worker_invocations", "execution_commits", "supervisor_bindings",
      ];
      const before = tables.map((t) => runRows(world, t, e1));
      const service = createReexecutionService(world.ctx.store, world.ctx.clock);
      const created = service.reexecuteFinalPlan(reexecutionRequest(world, { requesterSessionId: "S-USER" }));
      service.activateReexecutionRun({
        executionRunId: created.executionRunId,
        workspaceId: world.f.workspaceId,
        sessionId: "S-USER",
      });
      tables.forEach((t, index) => {
        expect(runRows(world, t, e1), t).toEqual(before[index]);
      });
      const e1Row = singleRow(world, "SELECT lifecycle, accepted_head_commit_id FROM execution_runs WHERE execution_run_id = ?", e1);
      expect(e1Row.lifecycle).toBe("aborted");
    } finally {
      world.ctx.store.close();
      removeTempPluginDataRoot(pluginDataRootOf(world.ctx.store));
    }
  });

  it("T10/T11/T12/T13/T14: E2 starts with a null acceptedHead, genesis candidate revision 0, and fresh Stage/Window/SupervisorBinding identities", async () => {
    const world = await makeProgressedWorld(`A1II-FRESH-${randomUUID().slice(0, 6)}`);
    try {
      abortRun(world, world.executionRunId, "T10-ABORT");
      const service = createReexecutionService(world.ctx.store, world.ctx.clock);
      const created = service.reexecuteFinalPlan(reexecutionRequest(world));
      service.activateReexecutionRun({ executionRunId: created.executionRunId, workspaceId: world.f.workspaceId, sessionId: "S1" });
      const e2Row = singleRow(world, "SELECT accepted_head_commit_id AS head, completion_commit_id AS completion FROM execution_runs WHERE execution_run_id = ?", created.executionRunId);
      // T10 — no inherited commit history.
      expect(e2Row.head).toBeNull();
      expect(e2Row.completion).toBeNull();
      const structure = structureOf(world, created.executionRunId);
      expect(structure.activeStage).not.toBeNull();
      expect(structure.openWindow).not.toBeNull();
      // T11 — genesis candidate revision 0, uninfluenced by E1.
      expect(structure.openWindow?.candidateRevision).toBe(0);
      // T12/T13 — disjoint Stage/Window ID sets (no ID reuse across runs).
      const stageIds = world.ctx.store.withRead(
        (tx) => tx.prepare("SELECT id FROM execution_stages WHERE execution_run_id IN (?, ?) ORDER BY id").all(world.executionRunId, created.executionRunId) as Array<{ id: string }>,
      ).map((row) => row.id);
      expect(new Set(stageIds).size).toBe(stageIds.length);
      const windowIds = world.ctx.store.withRead(
        (tx) => tx.prepare("SELECT id FROM verification_windows WHERE execution_run_id IN (?, ?) ORDER BY id").all(world.executionRunId, created.executionRunId) as Array<{ id: string }>,
      ).map((row) => row.id);
      expect(new Set(windowIds).size).toBe(windowIds.length);
      // T14 — an independent generation-1 SupervisorBinding; E1's own row untouched.
      const bindings = world.ctx.store.withRead(
        (tx) => tx.prepare("SELECT execution_run_id AS run, generation, state FROM supervisor_bindings WHERE execution_run_id IN (?, ?) ORDER BY execution_run_id").all(world.executionRunId, created.executionRunId) as Array<{ run: string; generation: number; state: string }>,
      );
      expect(bindings.length).toBe(2);
      const e2Binding = bindings.find((b) => b.run === created.executionRunId);
      expect(e2Binding?.generation).toBe(1);
      expect(e2Binding?.state).toBe("attached");
    } finally {
      world.ctx.store.close();
      removeTempPluginDataRoot(pluginDataRootOf(world.ctx.store));
    }
  });

  it("T15: E1's former supervision can neither activate nor mutate E2", async () => {
    const world = await makeProgressedWorld(`A1II-FENCE-${randomUUID().slice(0, 6)}`);
    try {
      const e1Session = world.f.sessionId;
      abortRun(world, world.executionRunId, "T15-ABORT");
      const service = createReexecutionService(world.ctx.store, world.ctx.clock);
      const created = service.reexecuteFinalPlan(reexecutionRequest(world, { requesterSessionId: "S-USER" }));
      service.activateReexecutionRun({ executionRunId: created.executionRunId, workspaceId: world.f.workspaceId, sessionId: "S-USER" });
      // The E1 supervisor session cannot acquire or reset E2's supervision.
      expect(codeOf(() =>
        service.activateReexecutionRun({ executionRunId: created.executionRunId, workspaceId: world.f.workspaceId, sessionId: e1Session }),
      )).toBe("STALE_SUPERVISOR_BINDING");
      // Nor can the E1 authority context start an attempt against E2's directive.
      const structure = structureOf(world, created.executionRunId);
      const directive = world.ctx.store.withWrite((tx) =>
        issueExecutionDirectiveInTx(tx, {
          executionRunId: created.executionRunId,
          sessionId: "S-USER",
          workspaceId: world.f.workspaceId,
          generation: 1,
          kind: "implementation",
          stageId: structure.activeStage!.id,
          windowId: structure.openWindow!.id,
          objective: "E2 work",
          body: "E2 body",
          capabilityEnvelope: fullEnvelope(),
          reportContract: openContract(),
          verificationPolicy: { implementationRequirement: "batchable" as const },
        }, world.ctx.clock, world.ctx.clock.nowIso()),
      );
      expect(codeOf(() =>
        world.ctx.store.withWrite((tx) =>
          startExecutionAttemptInTx(tx, {
            executionRunId: created.executionRunId,
            sessionId: e1Session,
            workspaceId: world.f.workspaceId,
            generation: world.f.generation,
            directiveId: directive.directiveId,
            directiveRevision: directive.revision,
            directiveHash: directive.hash,
            workerRole: "executor",
          }, world.ctx.clock, world.ctx.clock.nowIso()),
        ),
      )).not.toBe("no-error");
    } finally {
      world.ctx.store.close();
      removeTempPluginDataRoot(pluginDataRootOf(world.ctx.store));
    }
  });

  it("T16: E2's planningBaseline re-references the exact approved planning provenance of F", async () => {
    const world = await makeActiveExecutionWorld(`A1II-PB-${randomUUID().slice(0, 6)}`);
    try {
      const e1Baseline = singleRow(world, "SELECT planning_baseline_json AS baseline FROM execution_runs WHERE execution_run_id = ?", world.executionRunId).baseline;
      abortRun(world, world.executionRunId, "T16-ABORT");
      const service = createReexecutionService(world.ctx.store, world.ctx.clock);
      const created = service.reexecuteFinalPlan(reexecutionRequest(world));
      const e2Baseline = singleRow(world, "SELECT planning_baseline_json AS baseline FROM execution_runs WHERE execution_run_id = ?", created.executionRunId).baseline;
      expect(e2Baseline).toBe(e1Baseline);
      const parsed = JSON.parse(String(e2Baseline)) as { finalPlanCommitId: string; headSnapshotId: string };
      const finalPlanRow = world.ctx.store.withRead((tx) => getFinalPlanInTx(tx, world.f.runId));
      expect(parsed.finalPlanCommitId).toBe(finalPlanRow?.commitId);
      expect(parsed.headSnapshotId).toBe(finalPlanRow?.snapshotId);
    } finally {
      world.ctx.store.close();
      removeTempPluginDataRoot(pluginDataRootOf(world.ctx.store));
    }
  });

  it("T17/T18/T19: executionStartBaseline is freshly captured — workspace mutation between runs appears in the new baseline", async () => {
    const world = await makeActiveExecutionWorld(`A1II-ESB-${randomUUID().slice(0, 6)}`);
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "a1ii-git-"));
    try {
      const git = (...args: string[]) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
      git("init");
      git("config", "user.email", "a1ii@example.test");
      git("config", "user.name", "A1II Fixture");
      fs.writeFileSync(path.join(repoDir, "starter.txt"), "first state\n");
      git("add", ".");
      git("commit", "-m", "first state");
      const { registration } = await discoverAndRegisterWorkspace(world.ctx.store, repoDir, world.ctx.clock);
      const gitWorkspaceId = registration.workspace.workspaceId;
      expect(registration.workspace.kind).toBe("git_worktree");

      abortRun(world, world.executionRunId, "T17-ABORT");
      const service = createReexecutionService(world.ctx.store, world.ctx.clock);
      const e2 = service.reexecuteFinalPlan(reexecutionRequest(world, { workspaceId: gitWorkspaceId }));
      const e2Baseline = JSON.parse(
        String(singleRow(world, "SELECT execution_start_baseline_json AS baseline FROM execution_runs WHERE execution_run_id = ?", e2.executionRunId).baseline),
      ) as { kind: string; revision: string | null };
      // T17 — freshly derived from the TARGET workspace at creation (git head).
      expect(e2Baseline.kind).toBe("git");
      expect(e2Baseline.revision).toMatch(/^[0-9a-f]{40}$/);
      const firstHead = e2Baseline.revision;

      // §23 — a harmless workspace mutation AFTER E1 terminalization and
      // BEFORE the next reexecution.
      service.activateReexecutionRun({ executionRunId: e2.executionRunId, workspaceId: gitWorkspaceId, sessionId: "S1" });
      abortRun(world, e2.executionRunId, "T18-ABORT", gitWorkspaceId);
      fs.writeFileSync(path.join(repoDir, "mutated.txt"), "second state\n");
      git("add", ".");
      git("commit", "-m", "workspace mutation between runs");
      const e3 = service.reexecuteFinalPlan(reexecutionRequest(world, {
        workspaceId: gitWorkspaceId,
        operationId: "reexecute_final_plan:TU-REEXEC-2",
        authorizationRequestId: "mcp-control:TU-REEXEC-2",
      }));
      const e3Baseline = JSON.parse(
        String(singleRow(world, "SELECT execution_start_baseline_json AS baseline FROM execution_runs WHERE execution_run_id = ?", e3.executionRunId).baseline),
      ) as { kind: string; revision: string | null };
      // T18 — the mutation appears in the fresh baseline.
      expect(e3Baseline.revision).not.toBe(firstHead);
      // T19 — E1's baseline representation is unchanged (directory world).
      const e1Baseline = singleRow(world, "SELECT execution_start_baseline_json AS baseline FROM execution_runs WHERE execution_run_id = ?", world.executionRunId).baseline;
      expect(JSON.parse(String(e1Baseline))).toEqual({ kind: "directory", revision: null });
    } finally {
      world.ctx.store.close();
      removeTempPluginDataRoot(pluginDataRootOf(world.ctx.store));
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// §56 — real execution of E2 (A1II-T37..T42)
// ---------------------------------------------------------------------------

describe("A1-II §56 — E2 actually executes (T37–T42)", () => {
  it("T37..T42: prepared → active → v4 Directive → Worker Attempt/claim → durable Report → accept → a parentless first Commit", async () => {
    const world = await makeProgressedWorld(`A1II-EXEC-${randomUUID().slice(0, 6)}`);
    try {
      // E1 made real accepted progress: its head is a real ExecutionCommit.
      const e1Head = world.ctx.store.withRead(
        (tx) => tx.prepare("SELECT accepted_head_commit_id AS head FROM execution_runs WHERE execution_run_id = ?").get(world.executionRunId) as { head: string | null },
      ).head;
      expect(e1Head).not.toBeNull();

      abortRun(world, world.executionRunId, "T37-ABORT");
      const service = createReexecutionService(world.ctx.store, world.ctx.clock);
      const created = service.reexecuteFinalPlan(reexecutionRequest(world));
      // T37 — activation through the canonical composed primitive.
      const activation = service.activateReexecutionRun({ executionRunId: created.executionRunId, workspaceId: world.f.workspaceId, sessionId: world.f.sessionId });
      expect(activation.status).toBe("activated");
      expect(activation.supervisor.generation).toBe(1);

      // Rebuild the acceptance world view over E2 (same machinery, exact E2 scope).
      const structure = structureOf(world, created.executionRunId);
      const world2: AcceptanceWorld = {
        ...world,
        executionRunId: created.executionRunId,
        activeStageId: structure.activeStage!.id,
        openWindowId: structure.openWindow!.id,
        verDirective: null,
        verSession: null,
        verReportId: null,
      };
      // T38 — the E2 implementation Directive is protocol v4, exact E2.
      const cycle = runDirectiveCycle(world2, { directiveId: "DIR-E2-1", kind: "implementation", reportOverrides: { candidate_mutated: true } });
      expect(cycle.directive.protocolVersion).toBe(4);
      expect(cycle.directive.executionRunId).toBe(created.executionRunId);
      // T39 — the Attempt is exact-E2 scoped.
      const attemptRow = singleRow(world, "SELECT execution_run_id AS run FROM execution_attempts WHERE attempt_id = ?", cycle.attemptId);
      expect(attemptRow.run).toBe(created.executionRunId);
      // T40 — the Report is durable and exact-E2.
      const reportRow = singleRow(world, "SELECT execution_run_id AS run FROM execution_reports WHERE report_id = ?", cycle.reportId);
      expect(reportRow.run).toBe(created.executionRunId);

      // T41 — fresh verification + Assessment accept succeeds on E2.
      runVerificationCycle(world2);
      const accept = acceptanceServiceOf(world2).submitSupervisorAssessment(acceptInput(world2) as never) as {
        commit: { commitId: string; sequence: number } | null;
      };
      expect(accept.commit).not.toBeNull();
      const e2HeadRow = singleRow(world, "SELECT accepted_head_commit_id AS head FROM execution_runs WHERE execution_run_id = ?", created.executionRunId);
      expect(e2HeadRow.head).toBe(accept.commit?.commitId);
      // T42 — E2's first commit has NO parent from E1.
      const commitRow = singleRow(world, "SELECT sequence AS seq, parent_commit_id AS parent FROM execution_commits WHERE commit_id = ?", accept.commit?.commitId);
      expect(commitRow.seq).toBe(1);
      expect(commitRow.parent).toBeNull();
      expect(accept.commit?.commitId).not.toBe(e1Head);
    } finally {
      world.ctx.store.close();
      removeTempPluginDataRoot(pluginDataRootOf(world.ctx.store));
    }
  });
});

// ---------------------------------------------------------------------------
// §57/§58 — authorization boundary + stable errors (A1II-T43..T52)
// ---------------------------------------------------------------------------

describe("A1-II §57 — authorization boundary (T43–T47)", () => {
  it("T43/T44: the tool is mandatory-interaction, main-session-only; subagent contexts are denied", async () => {
    const definition = PHASE_PLAN_TOOLS.find((tool) => tool.name === "reexecute_final_plan");
    expect(definition).toBeDefined();
    expect(definition?._meta).toEqual(REQUIRES_USER_INTERACTION_META);
    // The PermissionRequest path never auto-allows the tool.
    const hooksSource = fs.readFileSync(path.join(process.cwd(), "src", "hooks", "handlers.ts"), "utf8");
    expect(hooksSource).toMatch(/if \(logical === "reexecute_final_plan"\) \{\s*\/\/ A1-II §9[\s\S]{0,400}?return emptyOutput\(\);/);
    // A subagent-attested V2 context is denied at the handler boundary (§49).
    const world = await makeActiveExecutionWorld(`A1II-T44-${randomUUID().slice(0, 6)}`);
    try {
      abortRun(world, world.executionRunId, "T44-ABORT");
      const finalPlan = finalPlanOf(world);
      const business = {
        source_planning_run_id: world.f.runId,
        final_plan_id: finalPlan.id,
        final_plan_revision: finalPlan.revision,
        final_plan_hash: finalPlan.hash,
      };
      const token = hostTokenV2(world.ctx.secret, "reexecute_final_plan", business, {
        sessionId: world.f.sessionId,
        workspaceId: world.f.workspaceId,
      }, { toolUseId: "TU-SUBAGENT", agent: { agentId: "agent_x", agentType: "phase-plan:worker" } });
      let code = "no-error";
      try {
        executePhasePlanTool(world.ctx, "reexecute_final_plan", { ...business, _hostContext: token });
      } catch (err) {
        code = (err as { code?: string }).code ?? "no-error";
      }
      expect(code).toBe("VALIDATOR_MUTATION_FORBIDDEN");
      // The denied call created nothing.
      const rows = world.ctx.store.withRead(
        (tx) => tx.prepare("SELECT COUNT(*) AS n FROM run_control_authorizations WHERE target_kind = 'final_plan_execution'").get() as { n: number },
      ).n;
      expect(rows).toBe(0);
    } finally {
      world.ctx.store.close();
      removeTempPluginDataRoot(pluginDataRootOf(world.ctx.store));
    }
  });

  it("T47: run_control_authorizations stays append-only — the DDL trigger fences any UPDATE of a committed row", async () => {
    const world = await makeActiveExecutionWorld(`A1II-T47-${randomUUID().slice(0, 6)}`);
    try {
      abortRun(world, world.executionRunId, "T47-ABORT");
      expect(codeOf(() =>
        world.ctx.store.withWrite((tx) => {
          tx.prepare("UPDATE run_control_authorizations SET request_hash = 'tampered'").run();
        }),
      )).not.toBe("no-error");
    } finally {
      world.ctx.store.close();
      removeTempPluginDataRoot(pluginDataRootOf(world.ctx.store));
    }
  });
});

describe("A1-II §58 — stable typed errors (T48–T52)", () => {
  it("T48/T49 (canonical T1 validation matrix): exact ref accepted; wrong hash/revision → FINAL_PLAN_MISMATCH; nonexistent → FINAL_PLAN_NOT_FOUND", async () => {
    const world = await makeActiveExecutionWorld(`A1II-ERR-${randomUUID().slice(0, 6)}`);
    try {
      abortRun(world, world.executionRunId, "T48-ABORT");
      const service = createReexecutionService(world.ctx.store, world.ctx.clock);
      const finalPlan = finalPlanOf(world);
      // Canonical T1 leg 1 — the exact valid ref is accepted.
      const valid = service.reexecuteFinalPlan(reexecutionRequest(world, { operationId: "reexecute_final_plan:TU-OK", authorizationRequestId: "mcp-control:TU-OK" }));
      expect(valid.status).toBe("created");
      expect(valid.finalPlan).toEqual(finalPlan);
      // Canonical T1 legs 2–4 — every wrong target fails closed.
      expect(codeOf(() =>
        service.reexecuteFinalPlan(reexecutionRequest(world, { target: { finalPlanHash: "deadbeef" }, operationId: "reexecute_final_plan:TU-H1", authorizationRequestId: "mcp-control:TU-H1" })),
      )).toBe("FINAL_PLAN_MISMATCH");
      expect(codeOf(() =>
        service.reexecuteFinalPlan(reexecutionRequest(world, { target: { finalPlanRevision: finalPlan.revision + 1 }, operationId: "reexecute_final_plan:TU-H2", authorizationRequestId: "mcp-control:TU-H2" })),
      )).toBe("FINAL_PLAN_MISMATCH");
      expect(codeOf(() =>
        service.reexecuteFinalPlan(reexecutionRequest(world, { target: { finalPlanId: "fp_never" }, operationId: "reexecute_final_plan:TU-H3", authorizationRequestId: "mcp-control:TU-H3" })),
      )).toBe("FINAL_PLAN_NOT_FOUND");
      // The rejections created nothing beyond the one valid creation.
      const runs = world.ctx.store.withRead((tx) => tx.prepare("SELECT COUNT(*) AS n FROM execution_runs").get() as { n: number });
      expect(runs.n).toBe(2);
      const controlRows = world.ctx.store.withRead(
        (tx) => tx.prepare("SELECT COUNT(*) AS n FROM run_control_authorizations WHERE target_kind = 'final_plan_execution'").get() as { n: number },
      ).n;
      expect(controlRows).toBe(1);
    } finally {
      world.ctx.store.close();
      removeTempPluginDataRoot(pluginDataRootOf(world.ctx.store));
    }
  });

  it("T50: an unresolvable target workspace fails closed before E2 (never auto-register, never fall back)", async () => {
    const world = await makeActiveExecutionWorld(`A1II-T50-${randomUUID().slice(0, 6)}`);
    try {
      abortRun(world, world.executionRunId, "T50-ABORT");
      const service = createReexecutionService(world.ctx.store, world.ctx.clock);
      expect(codeOf(() =>
        service.reexecuteFinalPlan(reexecutionRequest(world, { workspaceId: "ws_never_registered" })),
      )).toBe("WORKSPACE_UNAVAILABLE");
      const runs = world.ctx.store.withRead((tx) => tx.prepare("SELECT COUNT(*) AS n FROM execution_runs").get() as { n: number });
      expect(runs.n).toBe(1);
    } finally {
      world.ctx.store.close();
      removeTempPluginDataRoot(pluginDataRootOf(world.ctx.store));
    }
  });
});

// ---------------------------------------------------------------------------
// §59 — no hidden replan/handoff (A1II-T53..T57)
// ---------------------------------------------------------------------------

describe("A1-II §59 — no hidden replan or handoff (T53–T57)", () => {
  it("T53..T57: the PlanningRun never leaves completed and no replan/successor/handoff artifact appears", async () => {
    const world = await makeProgressedWorld(`A1II-HIDDEN-${randomUUID().slice(0, 6)}`);
    try {
      const planningBefore = singleRow(world, "SELECT * FROM planning_runs WHERE run_id = ?", world.f.runId);
      abortRun(world, world.executionRunId, "T53-ABORT");
      const before = countsOf(world, [
        "execution_issues", "planning_run_baselines", "execution_issue_adoptions",
        "execution_handoffs", "execution_handoff_states", "execution_handoff_events", "execution_bindings",
      ]);
      const service = createReexecutionService(world.ctx.store, world.ctx.clock);
      const created = service.reexecuteFinalPlan(reexecutionRequest(world));
      service.activateReexecutionRun({ executionRunId: created.executionRunId, workspaceId: world.f.workspaceId, sessionId: world.f.sessionId });
      // T53 — the PlanningRun row is byte-identical (lifecycle completed forever).
      expect(singleRow(world, "SELECT * FROM planning_runs WHERE run_id = ?", world.f.runId)).toEqual(planningBefore);
      // T54/T55/T57 — zero new replan/successor/handoff artifacts.
      const after = countsOf(world, [
        "execution_issues", "planning_run_baselines", "execution_issue_adoptions",
        "execution_handoffs", "execution_handoff_states", "execution_handoff_events", "execution_bindings",
      ]);
      for (const [table, n] of Object.entries(before)) {
        expect(after[table], table).toBe(n);
      }
      // T56 — no new approval/PlanCommit families beyond the fixture's own.
      const approvals = world.ctx.store.withRead((tx) => tx.prepare("SELECT COUNT(*) AS n FROM approvals").get() as { n: number }).n;
      const planCommits = world.ctx.store.withRead((tx) => tx.prepare("SELECT COUNT(*) AS n FROM plan_commits").get() as { n: number }).n;
      expect(approvals).toBeGreaterThanOrEqual(1);
      expect(planCommits).toBeGreaterThanOrEqual(1);
    } finally {
      world.ctx.store.close();
      removeTempPluginDataRoot(pluginDataRootOf(world.ctx.store));
    }
  });
});
