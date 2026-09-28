/**
 * Phase 16 — PlanningRun ownership control (takeover_run) and explicit abort
 * (abort_run), over the REAL MCP handlers / hook handlers / application
 * services (directive §55–§59, exit gates E6–E59).
 *
 * The ownership epoch itself is the FROZEN Phase 3 primitive
 * (takeoverBindingInTx / detachBindingInTx generation fencing); these tests
 * pin the Phase 16 control-plane composition around it: durable
 * authorization, exact-generation takeover, immediate old-owner fencing,
 * terminal abort semantics, race outcomes, and the mandatory-authorization
 * hook contract.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { executePhasePlanTool, type PhasePlanToolContext } from "../src/mcp/tools.js";
import { RuntimeError } from "../src/runtime/errors.js";
import { ABORT_MODE_NORMALIZATION_NOTICE, handlePermissionRequest, handlePostToolUse, handlePreToolUse } from "../src/hooks/handlers.js";
import type { PostToolUseInput } from "../src/hooks/parse.js";
import type { HookOutput } from "../src/hooks/output.js";
import { initializePlanStore, type PlanStore } from "../src/store/sqlite-store.js";
import type { StoreClock } from "../src/store/migration-runner.js";
import { createBlobStore } from "../src/store/blob-store.js";
import { loadHostSecret } from "../src/host/secret.js";
import { issueEntryIntent } from "../src/host/entry-intent.js";
import { discoverAndRegisterWorkspace } from "../src/workspace/identity.js";
import { createBindingService } from "../src/session/binding-service.js";
import { createPlanningRunService } from "../src/application/planning-run-service.js";
import { createRunControlService } from "../src/application/run-control-service.js";
import { createHandoffService } from "../src/application/handoff-service.js";
import { getFinalPlanInTx } from "../src/store/finalization.js";
import { getHeadCommitRecord } from "../src/store/plan-commits.js";
import { getAwaitingProposalRecord } from "../src/store/proposals.js";
import { getPlanningRunRecord } from "../src/store/planning-runs.js";
import { getBinding } from "../src/store/session-bindings.js";
import { fixedClock, makeTempPluginDataRoot, removeTempPluginDataRoot } from "./store-helpers.js";
import { hostToken } from "./context-helpers.js";
import { hostTokenV2 } from "./phase12-helpers.js";
import { DECISION_1, makeProposalFixture, prepareCheckpoint } from "./proposal-helpers.js";
import { makeCleanValidationFixture } from "./phase13-helpers.js";
import { callHandoff, makeApprovedFinalPlanFixture } from "./phase14-helpers.js";
import { makeDetailFixture } from "./phase11-helpers.js";

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof RuntimeError) return err.code;
    throw err;
  }
  throw new Error("expected a RuntimeError but none was thrown");
}

/** codeOf variant that tolerates success (returns null instead of throwing). */
function maybeCode(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof RuntimeError ? err.code : String(err);
  }
}

function outputOf(output: HookOutput): Record<string, unknown> {
  return output.kind === "json" ? output.payload : {};
}

let clockSeq = 0;
function toolClock(): StoreClock {
  let i = 0;
  return {
    nowIso: () => new Date(Date.now() + (i += 1)).toISOString(),
    newId: () => `rc-${(clockSeq += 1)}`,
  };
}

/** A minimal world: registered workspace + one ACTIVE run bound to S1. */
async function activeWorld(sessionId = "S1", goal = "phase16 control fixture") {
  const root = makeTempPluginDataRoot("phase-plan-rc-");
  const store = await initializePlanStore({ pluginDataRoot: root });
  const projectDir = path.join(root, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  const { registration } = await discoverAndRegisterWorkspace(store, projectDir, fixedClock({ ids: ["r0", "w0"] }));
  const workspaceId = registration.workspace.workspaceId;
  const runs = createPlanningRunService(store, fixedClock({ ids: ["run-id"] }));
  const { run, binding } = runs.createPlanningRun({ workspaceId, sessionId, goal });
  const clock = toolClock();
  const secret = loadHostSecret(root).key;
  const blobs = createBlobStore(path.join(root, "blobs"));
  const ctx: PhasePlanToolContext = { store, secret, clock, blobs };
  return {
    root,
    store,
    ctx,
    deps: { store, secret, clock, blobs },
    workspaceId,
    workspaceRoot: projectDir,
    runId: run.runId,
    sessionId,
    generation: binding.generation,
    runRevision: run.revision,
    runsService: runs,
    bindings: createBindingService(store, fixedClock({ ids: ["b0"] })),
  };
}

type World = Awaited<ReturnType<typeof activeWorld>>;

function closeWorld(world: World): void {
  world.store.close();
  removeTempPluginDataRoot(world.root);
}

/** takeover_run through the real MCP handler with a signed V2 main-session token. */
function callTakeover(
  ctx: PhasePlanToolContext,
  ids: { sessionId: string; workspaceId: string },
  business: { run_id: string; expected_binding_generation: number },
  options: { toolUseId?: string; agent?: { agentId?: string; agentType?: string } } = {},
) {
  const token = hostTokenV2(ctx.secret, "takeover_run", business, { sessionId: ids.sessionId, workspaceId: ids.workspaceId }, {
    permissionMode: "plan",
    toolUseId: options.toolUseId ?? "TU-TAKE-1",
    ...(options.agent === undefined ? {} : { agent: options.agent }),
  });
  return executePhasePlanTool(ctx, "takeover_run", { ...business, _hostContext: token }) as {
    status: string;
    idempotent: boolean;
    control_id: string;
    run: { id: string; lifecycle: string; stage: string; revision: number; goal: string };
    binding: { state: string; generation: number };
  };
}

/** abort_run through the real MCP handler with a signed V2 main-session token. */
function callAbort(
  ctx: PhasePlanToolContext,
  ids: { sessionId: string; workspaceId: string; runId: string; generation: number },
  business: { reason?: string } = {},
  options: { toolUseId?: string; agent?: { agentId?: string; agentType?: string } } = {},
) {
  const token = hostTokenV2(
    ctx.secret,
    "abort_run",
    business,
    { sessionId: ids.sessionId, workspaceId: ids.workspaceId, runId: ids.runId, generation: ids.generation },
    {
      permissionMode: "plan",
      toolUseId: options.toolUseId ?? "TU-ABORT-1",
      ...(options.agent === undefined ? {} : { agent: options.agent }),
    },
  );
  return executePhasePlanTool(ctx, "abort_run", { ...business, _hostContext: token }) as {
    status: string;
    idempotent: boolean;
    control_id: string;
    run: { id: string; lifecycle: string; stage: string; revision: number };
    binding: { state: string; generation: number };
  };
}

function controlRowCount(store: PlanStore): number {
  return (store.withRead((tx) => tx.prepare("SELECT COUNT(*) AS n FROM run_control_authorizations").get()) as { n: number }).n;
}

function controlRows(store: PlanStore): Array<Record<string, unknown>> {
  return store.withRead((tx) =>
    tx.prepare("SELECT * FROM run_control_authorizations ORDER BY created_at, control_id").all() as Array<Record<string, unknown>>,
  );
}

/** Awaiting-proposal world at architecture stage (real proposal service). */
async function proposalWorld(sessionId = "S1") {
  const root = makeTempPluginDataRoot("phase-plan-rcp-");
  const fixture = await makeProposalFixture(root, { stage: "architecture", sessionId });
  const prepared = prepareCheckpoint(fixture, [
    { op: "ADD_DECISION", content: { ...DECISION_1 }, compactProjection: "d1" },
  ]);
  const secret = loadHostSecret(root).key;
  const ctx: PhasePlanToolContext = {
    store: fixture.store,
    secret,
    clock: toolClock(),
    blobs: createBlobStore(path.join(root, "blobs")),
  };
  return {
    root,
    fixture,
    ctx,
    sessionId,
    workspaceId: fixture.workspaceId,
    runId: fixture.runId,
    generation: fixture.generation,
    runRevision: fixture.runRevision,
    awaiting: {
      id: prepared.proposal.proposalId,
      revision: prepared.proposal.revision,
      hash: prepared.proposal.proposalHash,
    },
  };
}

type ProposalWorld = Awaited<ReturnType<typeof proposalWorld>>;

function closeProposalWorld(world: ProposalWorld): void {
  world.fixture.store.close();
  removeTempPluginDataRoot(world.root);
}

// ---------------------------------------------------------------------------
// takeover_run (§8–§26, §55, E6–E24)
// ---------------------------------------------------------------------------

describe("takeover_run (§8–§26, §55)", () => {
  it("detached active run: ownership moves G → G+1 exactly once, durable authorization recorded, run untouched (§16/§17/§23/E13/E14)", async () => {
    const w = await activeWorld("S1");
    try {
      // /clear + SessionEnd analog: the ORIGINAL owner detaches (SB-04 —
      // every epoch change, including detach, bumps the generation once).
      w.bindings.detach({ runId: w.runId, sessionId: "S1" });
      const result = callTakeover(w.ctx, { sessionId: "S2", workspaceId: w.workspaceId }, {
        run_id: w.runId,
        expected_binding_generation: 2,
      });
      expect(result.status).toBe("taken_over");
      expect(result.idempotent).toBe(false);
      expect(result.binding).toEqual({ state: "attached", generation: 3 });
      expect(result.run).toMatchObject({ id: w.runId, lifecycle: "active", stage: "discovery", revision: w.runRevision });
      // §18 — ownership is not a design fact.
      expect(getPlanningRunRecord(w.store, w.runId)).toMatchObject({ lifecycle: "active", revision: w.runRevision, stage: "discovery" });
      // §4/§5 — one durable immutable authorization with the exact lineage.
      expect(controlRowCount(w.store)).toBe(1);
      const row = controlRows(w.store)[0]!;
      expect(row.operation).toBe("takeover");
      expect(row.operation_id).toBe("takeover:TU-TAKE-1");
      expect(row.authorization_request_id).toBe("mcp-control:TU-TAKE-1");
      expect(row.expected_binding_generation).toBe(2);
      expect(row.resulting_binding_generation).toBe(3);
      expect(JSON.parse(String(row.previous_binding_identity))).toEqual({ sessionId: "S1", generation: 2 });
      expect(JSON.parse(String(row.new_binding_identity))).toEqual({ sessionId: "S2", generation: 3 });
      // §19/§59 — the OLD owner's generation is fenced immediately.
      expect(
        codeOf(() =>
          w.runsService.transitionRun({
            runId: w.runId,
            workspaceId: w.workspaceId,
            sessionId: "S1",
            bindingGeneration: 1,
            expectedRevision: w.runRevision,
            event: "DISCOVERY_COMPLETE",
          }),
        ),
      ).toBe("STALE_SESSION_BINDING");
      // §5 — the authorization row is immutable.
      expect(() =>
        w.store.withWrite((tx) => tx.prepare("UPDATE run_control_authorizations SET request_hash = 'x'").run()),
      ).toThrow(/immutable/);
      expect(() =>
        w.store.withWrite((tx) => tx.prepare("DELETE FROM run_control_authorizations").run()),
      ).toThrow(/immutable/);
    } finally {
      closeWorld(w);
    }
  });

  it("attached LIVE owner: takeover succeeds without any liveness oracle and fences the old owner immediately (§24/E21/E22/E67)", async () => {
    const w = await activeWorld("S1");
    try {
      const result = callTakeover(w.ctx, { sessionId: "S2", workspaceId: w.workspaceId }, {
        run_id: w.runId,
        expected_binding_generation: 1,
      });
      expect(result.status).toBe("taken_over");
      expect(result.binding).toEqual({ state: "attached", generation: 2 });
      expect(getBinding(w.store, w.runId)).toMatchObject({ sessionId: "S2", state: "attached", generation: 2 });
    } finally {
      closeWorld(w);
    }
  });

  it("same-session reattach is NOT takeover: the original detached session is sent to the resume path (§22/E20)", async () => {
    const w = await activeWorld("S1");
    try {
      w.bindings.detach({ runId: w.runId, sessionId: "S1" });
      expect(
        codeOf(() =>
          callTakeover(w.ctx, { sessionId: "S1", workspaceId: w.workspaceId }, {
            run_id: w.runId,
            expected_binding_generation: 1,
          }),
        ),
      ).toBe("TAKEOVER_NOT_REQUIRED");
      expect(controlRowCount(w.store)).toBe(0);
      expect(getBinding(w.store, w.runId)).toMatchObject({ state: "detached", generation: 2 });
    } finally {
      closeWorld(w);
    }
  });

  it("same workspace required: a caller in another workspace/worktree is refused (§14/E9/E10)", async () => {
    const w = await activeWorld("S1");
    try {
      const otherDir = path.join(w.root, "worktree-b");
      fs.mkdirSync(otherDir, { recursive: true });
      const { registration } = await discoverAndRegisterWorkspace(w.store, otherDir, fixedClock({ ids: ["r1", "w1"] }));
      expect(registration.workspace.workspaceId).not.toBe(w.workspaceId);
      expect(
        codeOf(() =>
          callTakeover(w.ctx, { sessionId: "S2", workspaceId: registration.workspace.workspaceId }, {
            run_id: w.runId,
            expected_binding_generation: 1,
          }),
        ),
      ).toBe("WORKSPACE_MISMATCH");
      expect(controlRowCount(w.store)).toBe(0);
    } finally {
      closeWorld(w);
    }
  });

  it("design world survives takeover byte-for-byte: revision, stage, HEAD, awaiting proposal (§18/E16–E19)", async () => {
    const w = await proposalWorld("S1");
    try {
      const headBefore = getHeadCommitRecord(w.fixture.store, w.runId);
      const result = callTakeover(w.ctx, { sessionId: "S2", workspaceId: w.workspaceId }, {
        run_id: w.runId,
        expected_binding_generation: w.generation,
      });
      expect(result.status).toBe("taken_over");
      expect(getPlanningRunRecord(w.fixture.store, w.runId)).toMatchObject({
        lifecycle: "active",
        stage: "architecture",
        revision: w.runRevision,
      });
      expect(getHeadCommitRecord(w.fixture.store, w.runId)).toEqual(headBefore);
      const awaiting = getAwaitingProposalRecord(w.fixture.store, w.runId);
      expect(awaiting).not.toBeNull();
      expect(awaiting).toMatchObject({
        proposalId: w.awaiting.id,
        revision: w.awaiting.revision,
        proposalHash: w.awaiting.hash,
        status: "awaiting_approval",
      });
    } finally {
      closeProposalWorld(w);
    }
  });

  it("same-invocation retry is idempotent; a changed request under the same operation id conflicts (§25/E24/E53)", async () => {
    const w = await activeWorld("S1");
    try {
      const first = callTakeover(w.ctx, { sessionId: "S2", workspaceId: w.workspaceId }, {
        run_id: w.runId,
        expected_binding_generation: 1,
      }, { toolUseId: "TU-RETRY" });
      expect(first.idempotent).toBe(false);
      const retry = callTakeover(w.ctx, { sessionId: "S2", workspaceId: w.workspaceId }, {
        run_id: w.runId,
        expected_binding_generation: 1,
      }, { toolUseId: "TU-RETRY" });
      expect(retry.idempotent).toBe(true);
      expect(retry.control_id).toBe(first.control_id);
      expect(retry.binding).toEqual({ state: "attached", generation: 2 });
      expect(controlRowCount(w.store)).toBe(1);
      expect(
        codeOf(() =>
          callTakeover(w.ctx, { sessionId: "S2", workspaceId: w.workspaceId }, {
            run_id: w.runId,
            expected_binding_generation: 9,
          }, { toolUseId: "TU-RETRY" }),
        ),
      ).toBe("IDEMPOTENCY_CONFLICT");
      expect(getBinding(w.store, w.runId)).toMatchObject({ generation: 2 });
    } finally {
      closeWorld(w);
    }
  });

  it("concurrent takeovers with the same expected generation produce exactly one winner (§26/E23)", async () => {
    // Writers serialize through BEGIN IMMEDIATE (one process or many): the
    // FIRST takeover commits G → G+1 and every other authorized attempt at
    // the same expected generation is fenced STALE — two "successful"
    // takeovers can never produce G+2. Cross-process lock coordination is
    // separately covered by the store-multiprocess suite.
    const w = await activeWorld("S1");
    try {
      const attempt = (store: PlanStore, sessionId: string) =>
        createRunControlService(store, toolClock()).takeoverRun({
          runId: w.runId,
          workspaceId: w.workspaceId,
          callerSessionId: sessionId,
          expectedBindingGeneration: 1,
          authorization: {
            authorizationRequestId: `mcp-control:TU-${sessionId}`,
            operationId: `takeover:TU-${sessionId}`,
            requestHash: "race-hash",
          },
        });
      // Two store handles on the same database, as two host processes would open.
      const storeB = await initializePlanStore({ pluginDataRoot: w.root, busyTimeoutMs: 5000 });
      try {
        expect(attempt(w.store, "S2").binding).toMatchObject({ state: "attached", generation: 2 });
        expect(maybeCode(() => attempt(storeB, "S3"))).toBe("STALE_SESSION_BINDING");
      } finally {
        storeB.close();
      }
      expect(getBinding(w.store, w.runId)).toMatchObject({ state: "attached", generation: 2 });
      expect(controlRowCount(w.store)).toBe(1);
    } finally {
      closeWorld(w);
    }
  });

  it("terminal runs can never be taken over; a caller holding execution authority is refused (§8/§9/E7/E8/E12)", async () => {
    // A DELIVERED world: the predecessor run is completed with an attached
    // ExecutionBinding held by S1 (planning binding detached at delivery).
    const { f, ctx } = await makeApprovedFinalPlanFixture("S1");
    const root = path.dirname(path.dirname(ctx.store.path));
    try {
      const prepared = callHandoff(ctx, f, { toolUseId: "S1-DELIVER-E7" });
      createHandoffService(ctx.store, ctx.clock).finalizeDelivery({
        runId: f.runId,
        sessionId: f.sessionId,
        toolUseId: "S1-DELIVER-E7",
        responseHandoffId: prepared.handoff_id,
        responseHandoffHash: prepared.handoff_hash,
      });
      expect(
        codeOf(() =>
          callTakeover(ctx, { sessionId: "S2", workspaceId: f.workspaceId }, {
            run_id: f.runId,
            expected_binding_generation: f.generation,
          }),
        ),
      ).toBe("RUN_TERMINAL");
      // E12 — the session bound to the delivered execution contract (S1,
      // attached ExecutionBinding, detached planning binding) cannot take over
      // another active run in the same workspace.
      const runs = createPlanningRunService(ctx.store, fixedClock({ ids: ["run-id-2"] }));
      const second = runs.createPlanningRun({ workspaceId: f.workspaceId, sessionId: "S9", goal: "second run" });
      expect(
        codeOf(() =>
          callTakeover(ctx, { sessionId: "S1", workspaceId: f.workspaceId }, {
            run_id: second.run.runId,
            expected_binding_generation: 1,
          }),
        ),
      ).toBe("SESSION_ALREADY_BOUND");
      expect(controlRowCount(ctx.store)).toBe(0);
      expect(getBinding(ctx.store, second.run.runId)).toMatchObject({ sessionId: "S9", generation: 1 });
    } finally {
      ctx.store.close();
      removeTempPluginDataRoot(root);
    }
  });

  it("hook contract: takeover is asked (never allowed), a bound caller is denied, and PermissionRequest never auto-allows (§2/§15/E68 automated half)", async () => {
    const w = await activeWorld("S1");
    try {
      // A bound caller is denied at the hook layer.
      const bound = outputOf(
        await handlePreToolUse(w.deps, {
          sessionId: "S1",
          cwd: w.workspaceRoot,
          permissionMode: "plan",
          hookEventName: "PreToolUse",
          toolName: "mcp__plugin_phase-plan_phase-plan__takeover_run",
          toolInput: { run_id: w.runId, expected_binding_generation: 1 },
          toolUseId: "TU-H1",
        }),
      );
      expect((bound.hookSpecificOutput as Record<string, unknown>).permissionDecision).toBe("deny");
      expect((bound.hookSpecificOutput as Record<string, unknown>).permissionDecisionReason).toContain("SESSION_ALREADY_BOUND");
      // An unbound caller is asked with an injected context — never allowed.
      const asked = outputOf(
        await handlePreToolUse(w.deps, {
          sessionId: "S2",
          cwd: w.workspaceRoot,
          permissionMode: "plan",
          hookEventName: "PreToolUse",
          toolName: "mcp__plugin_phase-plan_phase-plan__takeover_run",
          toolInput: { run_id: w.runId, expected_binding_generation: 1 },
          toolUseId: "TU-H2",
        }),
      );
      const decision = asked.hookSpecificOutput as Record<string, unknown>;
      expect(decision.permissionDecision).toBe("ask");
      expect((decision.updatedInput as Record<string, unknown>)._hostContext).toBeTruthy();
      // PermissionRequest never auto-allows takeover: the mandatory dialog is the authorization.
      expect(
        handlePermissionRequest(w.deps, {
          sessionId: "S2",
          permissionMode: "plan",
          hookEventName: "PermissionRequest",
          toolName: "mcp__plugin_phase-plan_phase-plan__takeover_run",
          toolInput: { run_id: w.runId, expected_binding_generation: 1 },
        }).kind,
      ).toBe("empty");
    } finally {
      closeWorld(w);
    }
  });

  it("subagents (validator attestation) can never take over or abort (§47/E51)", async () => {
    const w = await activeWorld("S1");
    try {
      expect(
        codeOf(() =>
          callTakeover(w.ctx, { sessionId: "S2", workspaceId: w.workspaceId }, {
            run_id: w.runId,
            expected_binding_generation: 1,
          }, { agent: { agentId: "agent-1", agentType: "phase-plan:validator" } }),
        ),
      ).toBe("VALIDATOR_MUTATION_FORBIDDEN");
      expect(
        codeOf(() =>
          callAbort(w.ctx, { sessionId: "S1", workspaceId: w.workspaceId, runId: w.runId, generation: 1 }, {}, { agent: { agentType: "phase-plan:validator" } }),
        ),
      ).toBe("VALIDATOR_MUTATION_FORBIDDEN");
      expect(controlRowCount(w.store)).toBe(0);
      expect(getPlanningRunRecord(w.store, w.runId)).toMatchObject({ lifecycle: "active" });
    } finally {
      closeWorld(w);
    }
  });

  it("an execution-authority token can never authorize takeover or abort (§46/E52)", async () => {
    const w = await activeWorld("S1");
    try {
      const { encodeExecutionHostContextToken, buildExecutionHostContextEnvelope } = await import("../src/host/execution-context.js");
      const { businessInputHashOf } = await import("../src/host/host-context.js");
      const business = { run_id: w.runId, expected_binding_generation: 1 };
      const token = encodeExecutionHostContextToken(w.ctx.secret, buildExecutionHostContextEnvelope({
        sessionId: "S2",
        workspaceId: w.workspaceId,
        runId: w.runId,
        finalPlanId: "fplan_x",
        executionBindingGeneration: 1,
        permissionMode: "plan",
        toolUseId: "TU-EXEC-1",
        toolName: "mcp__plugin_phase-plan_phase-plan__takeover_run",
        businessInputHash: businessInputHashOf(business),
      }));
      expect(
        codeOf(() => executePhasePlanTool(w.ctx, "takeover_run", { ...business, _hostContext: token })),
      ).toBe("HOST_CONTEXT_INVALID");
      expect(controlRowCount(w.store)).toBe(0);
    } finally {
      closeWorld(w);
    }
  });
});

// ---------------------------------------------------------------------------
// abort_run (§27–§42, §56, E25–E49)
// ---------------------------------------------------------------------------

describe("abort_run (§27–§42, §56)", () => {
  it("discovery abort: active → aborted, revision +1 exactly once, binding detached +1, zero commit mutation (§29/§30/E27–E33)", async () => {
    const w = await activeWorld("S1");
    try {
      const result = callAbort(w.ctx, {
        sessionId: "S1",
        workspaceId: w.workspaceId,
        runId: w.runId,
        generation: 1,
      }, { reason: "user stopped planning" });
      expect(result.status).toBe("aborted");
      expect(result.idempotent).toBe(false);
      expect(result.run).toMatchObject({ id: w.runId, lifecycle: "aborted", stage: "discovery", revision: w.runRevision + 1 });
      expect(result.binding).toEqual({ state: "detached", generation: 2 });
      expect(controlRowCount(w.store)).toBe(1);
      const row = controlRows(w.store)[0]!;
      expect(row.operation).toBe("abort");
      expect(row.operation_id).toBe("abort:TU-ABORT-1");
      expect(row.resulting_run_revision).toBe(w.runRevision + 1);
      expect(row.reason).toBe("user stopped planning");
      // §30/§32 — no HEAD movement, no commits, stage untouched.
      expect(getHeadCommitRecord(w.store, w.runId)).toBeNull();
    } finally {
      closeWorld(w);
    }
  });

  it("abort works at every planning stage, including after an approved FinalPlan with no handoff (§33/E41)", async () => {
    // detail stage
    {
      const fixture = await makeDetailFixture("S1");
      const root = path.dirname(path.dirname(fixture.store.path));
      try {
        const result = callAbort(
          { store: fixture.store, secret: loadHostSecret(root).key, clock: toolClock(), blobs: createBlobStore(path.join(root, "blobs")) },
          { sessionId: "S1", workspaceId: fixture.workspaceId, runId: fixture.runId, generation: fixture.generation },
          {},
          { toolUseId: "TU-ABORT-DET" },
        );
        expect(result.run).toMatchObject({ lifecycle: "aborted", stage: "detail" });
      } finally {
        fixture.store.close();
        removeTempPluginDataRoot(root);
      }
    }
    // validation stage
    {
      const { f, ctx } = await makeCleanValidationFixture("S1");
      const root = path.dirname(path.dirname(ctx.store.path));
      try {
        const result = callAbort(ctx, {
          sessionId: "S1",
          workspaceId: f.workspaceId,
          runId: f.runId,
          generation: f.generation,
        }, {}, { toolUseId: "TU-ABORT-VAL" });
        expect(result.run).toMatchObject({ lifecycle: "aborted" });
        expect(result.binding).toEqual({ state: "detached", generation: f.generation + 1 });
      } finally {
        ctx.store.close();
        removeTempPluginDataRoot(root);
      }
    }
    // final stage with an approved FinalPlan and NO handoff (§33)
    const { f, ctx } = await makeApprovedFinalPlanFixture("S1");
    const root = path.dirname(path.dirname(ctx.store.path));
    try {
      const commitsBefore = (ctx.store.withRead((tx) => tx.prepare("SELECT COUNT(*) AS n FROM plan_commits").get()) as { n: number }).n;
      const result = callAbort(ctx, {
        sessionId: "S1",
        workspaceId: f.workspaceId,
        runId: f.runId,
        generation: f.generation,
      }, {}, { toolUseId: "TU-ABORT-FIN" });
      expect(result.run).toMatchObject({ lifecycle: "aborted", stage: "final" });
      // §33 — the approved FinalPlan stays immutable history; handoff dies.
      const finalPlan = ctx.store.withRead((tx) => getFinalPlanInTx(tx, f.runId));
      expect(finalPlan).not.toBeNull();
      expect(finalPlan!.finalPlanId).toBe(f.finalPlanId);
      expect(finalPlan!.finalPlanHash).toBe(f.finalPlanHash);
      expect((ctx.store.withRead((tx) => tx.prepare("SELECT COUNT(*) AS n FROM plan_commits").get()) as { n: number }).n).toBe(commitsBefore);
      // The handoff is no longer available after abort: the exact binding
      // fence refuses the call before eligibility is even evaluated.
      expect(codeOf(() => callHandoff(ctx, f, { toolUseId: "TU-LATE-HANDOFF" }))).toBe("BINDING_DETACHED");
    } finally {
      ctx.store.close();
      removeTempPluginDataRoot(root);
    }
  });

  it("an awaiting proposal is preserved as frozen history but can never be committed after abort (§31/E34)", async () => {
    const w = await proposalWorld("S1");
    try {
      const result = callAbort(w.ctx, {
        sessionId: w.sessionId,
        workspaceId: w.workspaceId,
        runId: w.runId,
        generation: w.generation,
      });
      expect(result.status).toBe("aborted");
      const awaiting = getAwaitingProposalRecord(w.fixture.store, w.runId);
      expect(awaiting).not.toBeNull();
      expect(awaiting).toMatchObject({ proposalId: w.awaiting.id, status: "awaiting_approval" });
      // Approval after abort fails closed — no commit can land on a terminal run.
      const token = hostToken(
        w.ctx.secret,
        "approve_proposal",
        { proposal_id: w.awaiting.id, proposal_revision: w.awaiting.revision, proposal_hash: w.awaiting.hash },
        { sessionId: w.sessionId, workspaceId: w.workspaceId, runId: w.runId, generation: w.generation + 1 },
        { toolUseId: "TU-LATE-APPROVE" },
      );
      expect(
        codeOf(() =>
          executePhasePlanTool(w.ctx, "approve_proposal", {
            proposal_id: w.awaiting.id,
            proposal_revision: w.awaiting.revision,
            proposal_hash: w.awaiting.hash,
            _hostContext: token,
          }),
        ),
      ).toBe("BINDING_DETACHED");
      expect((w.fixture.store.withRead((tx) => tx.prepare("SELECT COUNT(*) AS n FROM plan_commits").get()) as { n: number }).n).toBe(0);
    } finally {
      closeProposalWorld(w);
    }
  });

  it("abort creates no FinalPlan, no ExecutionHandoff, and no ExecutionBinding (§32/E38–E40)", async () => {
    const w = await activeWorld("S1");
    try {
      callAbort(w.ctx, { sessionId: "S1", workspaceId: w.workspaceId, runId: w.runId, generation: 1 });
      const counts = w.store.withRead((tx) =>
        ["final_plans", "execution_handoffs", "execution_bindings"].map(
          (table) => (tx.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
        ),
      );
      expect(counts).toEqual([0, 0, 0]);
      // §32 — abort never marks the run completed.
      expect(getPlanningRunRecord(w.store, w.runId)).toMatchObject({ lifecycle: "aborted" });
    } finally {
      closeWorld(w);
    }
  });

  it("terminal runs cannot be aborted: completed and already-aborted both fail closed without mutating (§29/E48/E49)", async () => {
    const { f, ctx } = await makeApprovedFinalPlanFixture("S1");
    const root = path.dirname(path.dirname(ctx.store.path));
    try {
      // Delivered → planning binding detached → fail closed.
      const prepared = callHandoff(ctx, f, { toolUseId: "S1-DELIVER-AB" });
      createHandoffService(ctx.store, ctx.clock).finalizeDelivery({
        runId: f.runId,
        sessionId: f.sessionId,
        toolUseId: "S1-DELIVER-AB",
        responseHandoffId: prepared.handoff_id,
        responseHandoffHash: prepared.handoff_hash,
      });
      expect(
        codeOf(() =>
          callAbort(ctx, { sessionId: "S1", workspaceId: f.workspaceId, runId: f.runId, generation: f.generation }),
        ),
      ).toBe("STALE_SESSION_BINDING");
      expect(getPlanningRunRecord(ctx.store, f.runId)).toMatchObject({ lifecycle: "completed" });
    } finally {
      ctx.store.close();
      removeTempPluginDataRoot(root);
    }
    const w = await activeWorld("S1");
    try {
      callAbort(w.ctx, { sessionId: "S1", workspaceId: w.workspaceId, runId: w.runId, generation: 1 }, {}, { toolUseId: "TU-FIRST" });
      const revisionAfterFirst = getPlanningRunRecord(w.store, w.runId)!.revision;
      // A DIFFERENT later invocation: the binding is detached — fail closed, no second bump.
      expect(
        codeOf(() =>
          callAbort(w.ctx, { sessionId: "S1", workspaceId: w.workspaceId, runId: w.runId, generation: 2 }, {}, { toolUseId: "TU-SECOND" }),
        ),
      ).toBe("STALE_SESSION_BINDING");
      expect(getPlanningRunRecord(w.store, w.runId)).toMatchObject({ lifecycle: "aborted", revision: revisionAfterFirst });
      expect(controlRowCount(w.store)).toBe(1);
    } finally {
      closeWorld(w);
    }
  });

  it("abort during a PREPARED handoff fails closed (§34/E42); the same invocation replays idempotently after a crash (§25/E53)", async () => {
    const { f, ctx } = await makeApprovedFinalPlanFixture("S1");
    const root = path.dirname(path.dirname(ctx.store.path));
    try {
      callHandoff(ctx, f, { toolUseId: "TU-PREPARE-1" });
      expect(
        codeOf(() =>
          callAbort(ctx, { sessionId: "S1", workspaceId: f.workspaceId, runId: f.runId, generation: f.generation }),
        ),
      ).toBe("ABORT_NOT_AVAILABLE_DURING_HANDOFF");
      expect(getPlanningRunRecord(ctx.store, f.runId)).toMatchObject({ lifecycle: "active" });
      expect(controlRowCount(ctx.store)).toBe(0);
    } finally {
      ctx.store.close();
      removeTempPluginDataRoot(root);
    }
    // Idempotent retry: the SAME authorized invocation finds its durable row.
    const w = await activeWorld("S1");
    try {
      const first = callAbort(w.ctx, { sessionId: "S1", workspaceId: w.workspaceId, runId: w.runId, generation: 1 }, {}, { toolUseId: "TU-SAME" });
      expect(first.idempotent).toBe(false);
      const retry = callAbort(w.ctx, { sessionId: "S1", workspaceId: w.workspaceId, runId: w.runId, generation: 1 }, {}, { toolUseId: "TU-SAME" });
      expect(retry.idempotent).toBe(true);
      expect(retry.control_id).toBe(first.control_id);
      expect(retry.run).toMatchObject({ lifecycle: "aborted", revision: first.run.revision });
      expect(controlRowCount(w.store)).toBe(1);
    } finally {
      closeWorld(w);
    }
  });

  it("hook contract: abort is asked with a signed context; PermissionRequest re-verifies and returns the session-scoped mode exit only when eligible (§37/§38/§42)", async () => {
    const w = await activeWorld("S1");
    try {
      const business = { reason: "stop" };
      const asked = outputOf(
        await handlePreToolUse(w.deps, {
          sessionId: "S1",
          cwd: w.workspaceRoot,
          permissionMode: "plan",
          hookEventName: "PreToolUse",
          toolName: "mcp__plugin_phase-plan_phase-plan__abort_run",
          toolInput: business,
          toolUseId: "TU-HA-1",
        }),
      );
      const decision = asked.hookSpecificOutput as Record<string, unknown>;
      expect(decision.permissionDecision).toBe("ask");
      const hostContext = (decision.updatedInput as Record<string, unknown>)._hostContext as string;
      expect(hostContext).toBeTruthy();
      // Eligible: the probe allow carries setMode(default, session) — nothing else.
      const permission = outputOf(
        handlePermissionRequest(w.deps, {
          sessionId: "S1",
          permissionMode: "plan",
          hookEventName: "PermissionRequest",
          toolName: "mcp__plugin_phase-plan_phase-plan__abort_run",
          toolInput: { ...business, _hostContext: hostContext },
        }),
      );
      const updates = (permission.hookSpecificOutput as { decision?: { behavior?: string; updatedPermissions?: Array<Record<string, unknown>> } }).decision;
      expect(updates?.behavior).toBe("allow");
      expect(updates?.updatedPermissions).toEqual([{ type: "setMode", mode: "default", destination: "session" }]);
      // Zero-mutation so far: the handler owns every mutation, the hook none.
      expect(controlRowCount(w.store)).toBe(0);
      expect(getPlanningRunRecord(w.store, w.runId)).toMatchObject({ lifecycle: "active", revision: w.runRevision });
      // A stale-generation context is denied by the probe (zero-mutation deny path).
      const staleToken = hostTokenV2(w.deps.secret, "abort_run", business, { sessionId: "S1", workspaceId: w.workspaceId, runId: w.runId, generation: 99 }, { toolUseId: "TU-HA-2" });
      const denied = outputOf(
        handlePermissionRequest(w.deps, {
          sessionId: "S1",
          permissionMode: "plan",
          hookEventName: "PermissionRequest",
          toolName: "mcp__plugin_phase-plan_phase-plan__abort_run",
          toolInput: { ...business, _hostContext: staleToken },
        }),
      );
      expect(((denied.hookSpecificOutput as { decision?: { behavior?: string } }).decision)?.behavior).toBe("deny");
    } finally {
      closeWorld(w);
    }
  });

  it("post-abort: no planning context, Build context is unavailable, terminal runs never reattach, and /phase-plan starts a NEW run (§43/§44/§66/§67/E47–E50)", async () => {
    const w = await activeWorld("S1");
    try {
      callAbort(w.ctx, { sessionId: "S1", workspaceId: w.workspaceId, runId: w.runId, generation: 1 });
      // Planning reads degrade: the aborted run is nobody's current run.
      const readToken = hostToken(w.ctx.secret, "get_context", { detail: "current" }, { sessionId: "S1", workspaceId: w.workspaceId }, { toolUseId: "TU-READ-1" });
      expect(executePhasePlanTool(w.ctx, "get_context", { detail: "current", _hostContext: readToken })).toEqual({ status: "no_active_run" });
      // Build context is NEVER reachable under planning authority.
      const buildToken = hostToken(w.ctx.secret, "get_context", { detail: "build" }, { sessionId: "S1", workspaceId: w.workspaceId }, { toolUseId: "TU-READ-2" });
      expect(
        codeOf(() => executePhasePlanTool(w.ctx, "get_context", { detail: "build", _hostContext: buildToken })),
      ).toBe("EXECUTION_CONTEXT_NOT_AVAILABLE");
      // E48 — a terminal run can never reattach.
      expect(
        codeOf(() => w.runsService.reattachActiveRun({ runId: w.runId, workspaceId: w.workspaceId, sessionId: "S1" })),
      ).toBe("RUN_TERMINAL");
      // §67 — a fresh explicit /phase-plan creates a NEW ordinary run.
      const entry = issueEntryIntent(w.ctx.secret, { sessionId: "S1", promptId: "PROMPT-1" });
      const entryToken = hostToken(w.ctx.secret, "start_or_resume", { _entryIntent: entry, goal: "fresh goal" }, { sessionId: "S1", workspaceId: w.workspaceId }, { permissionMode: "default", toolUseId: "TU-REENTRY" });
      const reentry = executePhasePlanTool(w.ctx, "start_or_resume", { _entryIntent: entry, goal: "fresh goal", _hostContext: entryToken }) as {
        status: string;
        started: boolean;
        run: { id: string };
      };
      expect(reentry.status).toBe("started");
      expect(reentry.started).toBe(true);
      expect(reentry.run.id).not.toBe(w.runId);
      // The aborted run is unchanged and is not a successor baseline.
      expect(getPlanningRunRecord(w.store, w.runId)).toMatchObject({ lifecycle: "aborted" });
      expect((w.store.withRead((tx) => tx.prepare("SELECT COUNT(*) AS n FROM planning_run_baselines").get()) as { n: number }).n).toBe(0);
    } finally {
      closeWorld(w);
    }
  });
});

// ---------------------------------------------------------------------------
// Races (§57/§58, E54–E56)
// ---------------------------------------------------------------------------

describe("run-control races (§57/§58)", () => {
  it("takeover vs SessionEnd: the stale expected generation loses; the retry at the new generation wins (§57)", async () => {
    const w = await activeWorld("S1");
    try {
      // SessionEnd detaches with a generation bump.
      w.bindings.detach({ runId: w.runId, sessionId: "S1" });
      expect(
        codeOf(() =>
          callTakeover(w.ctx, { sessionId: "S2", workspaceId: w.workspaceId }, {
            run_id: w.runId,
            expected_binding_generation: 1,
          }),
        ),
      ).toBe("STALE_SESSION_BINDING");
      // One fence-consistent state; the user retries at the current generation.
      const retry = callTakeover(w.ctx, { sessionId: "S2", workspaceId: w.workspaceId }, {
        run_id: w.runId,
        expected_binding_generation: 2,
      }, { toolUseId: "TU-TAKE-RETRY" });
      expect(retry.binding).toEqual({ state: "attached", generation: 3 });
    } finally {
      closeWorld(w);
    }
  });

  it("abort vs current mutation: the mutation is fenced the moment abort lands (§57/E54)", async () => {
    const w = await activeWorld("S1");
    try {
      callAbort(w.ctx, { sessionId: "S1", workspaceId: w.workspaceId, runId: w.runId, generation: 1 });
      expect(
        codeOf(() =>
          w.runsService.transitionRun({
            runId: w.runId,
            workspaceId: w.workspaceId,
            sessionId: "S1",
            bindingGeneration: 1,
            expectedRevision: w.runRevision,
            event: "DISCOVERY_COMPLETE",
          }),
        ),
      ).toBe("BINDING_DETACHED");
    } finally {
      closeWorld(w);
    }
  });

  it("abort vs approval: whichever wins, no PlanCommit can land after the abort (§58/E55)", async () => {
    // (a) abort wins first → approval must fail closed.
    {
      const w = await proposalWorld("S1");
      try {
        callAbort(w.ctx, { sessionId: w.sessionId, workspaceId: w.workspaceId, runId: w.runId, generation: w.generation });
        const token = hostToken(w.ctx.secret, "approve_proposal", { proposal_id: w.awaiting.id, proposal_revision: w.awaiting.revision, proposal_hash: w.awaiting.hash }, { sessionId: w.sessionId, workspaceId: w.workspaceId, runId: w.runId, generation: w.generation + 1 }, { toolUseId: "TU-RACE-APPROVE" });
        expect(
          codeOf(() =>
            executePhasePlanTool(w.ctx, "approve_proposal", {
              proposal_id: w.awaiting.id,
              proposal_revision: w.awaiting.revision,
              proposal_hash: w.awaiting.hash,
              _hostContext: token,
            }),
          ),
        ).toBe("BINDING_DETACHED");
        expect((w.fixture.store.withRead((tx) => tx.prepare("SELECT COUNT(*) AS n FROM plan_commits").get()) as { n: number }).n).toBe(0);
      } finally {
        closeProposalWorld(w);
      }
    }
    // (b) approval wins first → commit lands, abort then runs on the NEW revision.
    {
      const w = await proposalWorld("S1");
      try {
        const token = hostToken(w.ctx.secret, "approve_proposal", { proposal_id: w.awaiting.id, proposal_revision: w.awaiting.revision, proposal_hash: w.awaiting.hash }, { sessionId: w.sessionId, workspaceId: w.workspaceId, runId: w.runId, generation: w.generation }, { toolUseId: "TU-APPROVE-FIRST" });
        const approved = executePhasePlanTool(w.ctx, "approve_proposal", {
          proposal_id: w.awaiting.id,
          proposal_revision: w.awaiting.revision,
          proposal_hash: w.awaiting.hash,
          _hostContext: token,
        }) as { approved: boolean; new_run_revision: number };
        expect(approved.approved).toBe(true);
        const commitsAfterApproval = (w.fixture.store.withRead((tx) => tx.prepare("SELECT COUNT(*) AS n FROM plan_commits").get()) as { n: number }).n;
        const aborted = callAbort(w.ctx, {
          sessionId: w.sessionId,
          workspaceId: w.workspaceId,
          runId: w.runId,
          generation: w.generation,
        }, {}, { toolUseId: "TU-ABORT-AFTER" });
        expect(aborted.status).toBe("aborted");
        expect(aborted.run.revision).toBe(approved.new_run_revision + 1);
        expect((w.fixture.store.withRead((tx) => tx.prepare("SELECT COUNT(*) AS n FROM plan_commits").get()) as { n: number }).n).toBe(commitsAfterApproval);
      } finally {
        closeProposalWorld(w);
      }
    }
  });

  it("abort vs takeover: exactly one consistent outcome — dual ownership is impossible (§57/E56)", async () => {
    // Serialized writers: whichever operation lands first, the other is
    // fenced by the generation/lifecycle it left behind. Both orders are
    // exercised; dual ownership and post-abort takeover are both impossible.
    const w = await activeWorld("S1");
    try {
      const storeB = await initializePlanStore({ pluginDataRoot: w.root, busyTimeoutMs: 5000 });
      const take = (store: PlanStore, sessionId: string) =>
        createRunControlService(store, toolClock()).takeoverRun({
          runId: w.runId,
          workspaceId: w.workspaceId,
          callerSessionId: sessionId,
          expectedBindingGeneration: 1,
          authorization: {
            authorizationRequestId: `mcp-control:TU-${sessionId}`,
            operationId: `takeover:TU-${sessionId}`,
            requestHash: "race-hash-2",
          },
        });
      const abort = (store: PlanStore) =>
        createRunControlService(store, toolClock()).abortRun({
          workspaceId: w.workspaceId,
          callerSessionId: "S1",
          bindingGeneration: 1,
          authorization: {
            authorizationRequestId: "mcp-control:TU-ABORT-RACE",
            operationId: "abort:TU-ABORT-RACE",
            requestHash: "race-hash-3",
          },
        });
      try {
        // Order 1 — the takeover lands first: the old owner's abort is fenced.
        expect(take(storeB, "S2").binding).toMatchObject({ state: "attached", generation: 2 });
        expect(maybeCode(() => abort(w.store))).toBe("STALE_SESSION_BINDING");
        expect(getBinding(w.store, w.runId)).toMatchObject({ state: "attached", sessionId: "S2", generation: 2 });
      } finally {
        storeB.close();
      }
      closeWorld(w);
      // Order 2 — the abort lands first: takeover of the terminal run is refused.
      const w2 = await activeWorld("S1");
      try {
        const storeB2 = await initializePlanStore({ pluginDataRoot: w2.root, busyTimeoutMs: 5000 });
        try {
          expect(createRunControlService(w2.store, toolClock()).abortRun({
            workspaceId: w2.workspaceId,
            callerSessionId: "S1",
            bindingGeneration: 1,
            authorization: {
              authorizationRequestId: "mcp-control:TU-ABORT-FIRST",
              operationId: "abort:TU-ABORT-FIRST",
              requestHash: "race-hash-4",
            },
          }).run.lifecycle).toBe("aborted");
          expect(
            maybeCode(() =>
              createRunControlService(storeB2, toolClock()).takeoverRun({
                runId: w2.runId,
                workspaceId: w2.workspaceId,
                callerSessionId: "S2",
                expectedBindingGeneration: 1,
                authorization: {
                  authorizationRequestId: "mcp-control:TU-LATE-TAKE",
                  operationId: "takeover:TU-LATE-TAKE",
                  requestHash: "race-hash-5",
                },
              }),
            ),
          ).toBe("RUN_TERMINAL");
        } finally {
          storeB2.close();
        }
        expect(getBinding(w2.store, w2.runId)).toMatchObject({ state: "detached", generation: 2 });
      } finally {
        closeWorld(w2);
      }
    } finally {
      // Order-1 world already closed above.
    }
  });
});


// ---------------------------------------------------------------------------
// Abort host-mode normalization (Amendment A2 §9/§26–§28, E43-A2/E71-A2)
// ---------------------------------------------------------------------------

/** The delivered MCP success envelope for a tool result (bootstrap wrapping). */
function deliveredAbortResponse(result: Record<string, unknown>): unknown {
  return { content: [{ type: "text", text: JSON.stringify({ ok: true, ...result }) }] };
}

function abortPostToolUseInput(toolResponse: unknown, permissionMode?: string): PostToolUseInput {
  return {
    sessionId: "S1",
    ...(permissionMode === undefined ? {} : { permissionMode }),
    hookEventName: "PostToolUse",
    toolName: "mcp__plugin_phase-plan_phase-plan__abort_run",
    toolInput: {},
    toolUseId: "TU-A2-1",
    toolResponse,
  };
}

function tableRowCounts(store: PlanStore): Map<string, number> {
  return store.withRead((tx) => {
    const tables = (
      tx
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    const counts = new Map<string, number>();
    for (const table of tables) {
      counts.set(table, (tx.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n);
    }
    return counts;
  });
}

describe("abort host-mode normalization (Amendment A2 §9/§26–§28, E43-A2/E71-A2)", () => {
  it("abort response requests the mode exit and never claims it happened; PostToolUse observes plan → the frozen A2 notice (§27/§28)", async () => {
    const w = await activeWorld("S1");
    try {
      const result = callAbort(w.ctx, { sessionId: "S1", workspaceId: w.workspaceId, runId: w.runId, generation: 1 }) as unknown as Record<string, unknown>;
      expect(result.mode_exit).toBe("requested");
      expect(result.next as string).toContain("requested");
      expect(result.next as string).not.toMatch(/has left Plan Mode|permission mode changed/i);

      const plan = await handlePostToolUse(w.deps, abortPostToolUseInput(deliveredAbortResponse(result), "plan"));
      expect(plan.kind).toBe("json");
      const payload = plan.kind === "json" ? plan.payload : {};
      const specific = payload.hookSpecificOutput as { hookEventName?: string; additionalContext?: string };
      expect(specific.hookEventName).toBe("PostToolUse");
      expect(specific.additionalContext).toBe(ABORT_MODE_NORMALIZATION_NOTICE);
      // A2 §5 — the condition needs a POSITIVE plan observation; default or
      // absent modes inject nothing (the host already left Plan Mode, or the
      // mode is unobservable and no mismatch may be claimed).
      const defaulted = await handlePostToolUse(w.deps, abortPostToolUseInput(deliveredAbortResponse(result), "default"));
      expect(defaulted.kind).toBe("empty");
      const unobserved = await handlePostToolUse(w.deps, abortPostToolUseInput(deliveredAbortResponse(result)));
      expect(unobserved.kind).toBe("empty");
    } finally {
      closeWorld(w);
    }
  });

  it("an idempotent abort replay is still a successful abort for the A2 condition (§5)", async () => {
    const w = await activeWorld("S1");
    try {
      const ids = { sessionId: "S1", workspaceId: w.workspaceId, runId: w.runId, generation: 1 };
      callAbort(w.ctx, ids, {}, { toolUseId: "TU-SAME" });
      const retry = callAbort(w.ctx, ids, {}, { toolUseId: "TU-SAME" });
      expect(retry.idempotent).toBe(true);
      const notice = await handlePostToolUse(
        w.deps,
        abortPostToolUseInput(deliveredAbortResponse(retry as unknown as Record<string, unknown>), "plan"),
      );
      expect(notice.kind).toBe("json");
    } finally {
      closeWorld(w);
    }
  });

  it("the abort stays terminal and the notice cannot mutate the Store; no execution artifacts exist in either mode outcome (§28/RI-23)", async () => {
    const w = await activeWorld("S1");
    try {
      const result = callAbort(w.ctx, { sessionId: "S1", workspaceId: w.workspaceId, runId: w.runId, generation: 1 }) as unknown as Record<string, unknown>;
      const afterAbort = tableRowCounts(w.store);
      for (const mode of ["plan", "default", undefined]) {
        const output = await handlePostToolUse(w.deps, abortPostToolUseInput(deliveredAbortResponse(result), mode));
        expect(output.kind === "json" || output.kind === "empty").toBe(true);
      }
      expect(tableRowCounts(w.store)).toEqual(afterAbort);
      // Terminal semantics are identical in both host-mode outcomes (RI-23).
      expect(getPlanningRunRecord(w.store, w.runId)).toMatchObject({ lifecycle: "aborted", revision: w.runRevision + 1 });
      expect(getBinding(w.store, w.runId)).toMatchObject({ state: "detached", generation: 2 });
      expect(controlRowCount(w.store)).toBe(1);
      expect((w.store.withRead((tx) => tx.prepare("SELECT COUNT(*) AS n FROM execution_handoffs").get()) as { n: number }).n).toBe(0);
      expect((w.store.withRead((tx) => tx.prepare("SELECT COUNT(*) AS n FROM execution_bindings").get()) as { n: number }).n).toBe(0);
    } finally {
      closeWorld(w);
    }
  });

  it("denied/failed/different-tool responses produce no PostToolUse success path and no Abort (§28)", async () => {
    const w = await activeWorld("S1");
    try {
      // The bootstrap failure envelope (ok=false) — a denied or failed call.
      const failed = await handlePostToolUse(
        w.deps,
        abortPostToolUseInput(
          { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, code: "ABORT_NOT_AVAILABLE", message: "denied" }) }] },
          "plan",
        ),
      );
      expect(failed.kind).toBe("empty");
      // A success envelope for a different operation status is not an abort.
      const other = await handlePostToolUse(
        w.deps,
        abortPostToolUseInput({ content: [{ type: "text", text: JSON.stringify({ ok: true, status: "taken_over" }) }] }, "plan"),
      );
      expect(other.kind).toBe("empty");
      // Unparseable responses never throw and never notice.
      const junk = await handlePostToolUse(w.deps, abortPostToolUseInput("not-json", "plan"));
      expect(junk.kind).toBe("empty");
      expect(controlRowCount(w.store)).toBe(0);
      expect(getPlanningRunRecord(w.store, w.runId)).toMatchObject({ lifecycle: "active", revision: w.runRevision });
    } finally {
      closeWorld(w);
    }
  });

  it("no settings write path exists in the abort/normalization modules (CC-12, §28)", () => {
    for (const rel of [
      "src/hooks/handlers.ts",
      "src/mcp/tools.ts",
      "src/application/run-control-service.ts",
      "src/store/run-control.ts",
    ]) {
      const src = fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
      expect(src).not.toMatch(/writeFileSync|appendFileSync|rmSync|mkdirSync/);
      expect(src).not.toMatch(/settings\.json/);
    }
  });
});
