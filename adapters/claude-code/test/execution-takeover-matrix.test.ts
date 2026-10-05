/**
 * E12-T29..T35 + §64 — explicit takeover and the FULL stale-owner matrix
 * (E12 §25–§35/§64): takeover requires the trusted user authorization, moves
 * generation N → N+1 exactly once, fences the old generation permanently,
 * refuses terminal runs and foreign workspaces — and after the fence the old
 * Supervisor fails EVERY supervisor-owned mutation, proven as a shared table
 * over the real enforcement surfaces.
 */
import { describe, expect, it } from "vitest";

import { handlePermissionRequest, handlePreToolUse } from "../src/hooks/handlers.js";
import { makeAcceptanceWorld, codeOf, supervisorCall, runVerificationCycle } from "./acceptance-helpers.js";
import { makeIndeterminateWorld } from "./attempt-recovery-helpers.js";
import { requestExecutionReplanInTx } from "../src/application/execution-replan-service.js";
import {
  bindingOf,
  directiveProbeBusiness,
  explicitExecutionTakeover,
  supervisorCallAs,
} from "./session-recovery-helpers.js";

const ALL_SUPERVISOR_OP_TOOLS = [
  "issue_execution_directive",
  "start_worker_attempt",
  "continue_execution_stage",
  "activate_execution_stage",
  "submit_supervisor_assessment",
  "begin_execution_final_closure",
  "request_execution_replan",
  "declare_verification_conflict",
  "resolve_verification_conflict",
  "issue_attempt_reconciliation",
  "resolve_indeterminate_attempt",
  "retry_unclaimed_worker_launch",
];

describe("E12 explicit takeover (§25–§27)", () => {
  it("E12-T29: a different session cannot mutate before the takeover", async () => {
    const world = await makeAcceptanceWorld("S1");
    expect(codeOf(() => supervisorCall(world, "issue_execution_directive", directiveProbeBusiness(world) as never, "S9"))).toBe(
      "STALE_SUPERVISOR_BINDING",
    );
    expect(bindingOf(world)).toMatchObject({ state: "attached", generation: 1, sessionId: "S1" });
  });

  it("E12-T30: takeover requires the trusted user authorization surface (mandatory dialog, never auto-allow)", async () => {
    const world = await makeAcceptanceWorld("S1");
    // The PreToolUse decision for takeover_run is an ASK (the host dialog IS
    // the authorization); it is never an allow and never decides.
    const out = await handlePreToolUse(
      { store: world.ctx.store, secret: world.ctx.secret, clock: world.ctx.clock },
      {
        sessionId: "S9",
        cwd: world.f.workspaceRoot,
        permissionMode: "default",
        hookEventName: "PreToolUse",
        toolName: "mcp__plugin_phase-plan_phase-plan__takeover_run",
        toolInput: { run_id: world.executionRunId, expected_binding_generation: 1 },
        toolUseId: "TU-T30",
      } as never,
    );
    expect(JSON.stringify(out)).toContain('"permissionDecision":"ask"');
    // The PermissionRequest hook NEVER auto-allows takeover_run.
    const perm = handlePermissionRequest(
      { store: world.ctx.store, secret: world.ctx.secret, clock: world.ctx.clock },
      {
        sessionId: "S9",
        cwd: world.f.workspaceRoot,
        hookEventName: "PermissionRequest",
        toolName: "mcp__plugin_phase-plan_phase-plan__takeover_run",
        toolInput: { run_id: world.executionRunId, expected_binding_generation: 1 },
      } as never,
    );
    expect(perm.kind).toBe("empty");
  });

  it("E12-T31: a valid takeover moves N → N+1 and attaches the new session", async () => {
    const world = await makeAcceptanceWorld("S1");
    const result = explicitExecutionTakeover(world, { newSessionId: "S2", expectedGeneration: 1 });
    expect(result.supervisor).toMatchObject({ executionRunId: world.executionRunId, generation: 2, state: "attached" });
    expect(bindingOf(world)).toMatchObject({ state: "attached", generation: 2, sessionId: "S2" });
  });

  it("E12-T32: the old generation is permanently fenced for every supervisor mutation (§64 matrix)", async () => {
    const world = await makeAcceptanceWorld("S1");
    explicitExecutionTakeover(world, { newSessionId: "S2", expectedGeneration: 1 });
    // Shared authority-fence table over the PreToolUse signing surface: the
    // stale owner's session signs NOTHING (SUPERVISOR_BINDING_REQUIRED), while
    // the new owner's session signs every one of the same tools.
    for (const tool of ALL_SUPERVISOR_OP_TOOLS) {
      const stale = await handlePreToolUse(
        { store: world.ctx.store, secret: world.ctx.secret, clock: world.ctx.clock },
        {
          sessionId: "S1",
          cwd: world.f.workspaceRoot,
          permissionMode: "default",
          hookEventName: "PreToolUse",
          toolName: `mcp__plugin_phase-plan_phase-plan__${tool}`,
          toolInput: {},
          toolUseId: `TU-STALE-${tool}`,
        } as never,
      );
      expect(JSON.stringify(stale), tool).toContain("SUPERVISOR_BINDING_REQUIRED");
      const fresh = await handlePreToolUse(
        { store: world.ctx.store, secret: world.ctx.secret, clock: world.ctx.clock },
        {
          sessionId: "S2",
          cwd: world.f.workspaceRoot,
          permissionMode: "default",
          hookEventName: "PreToolUse",
          toolName: `mcp__plugin_phase-plan_phase-plan__${tool}`,
          toolInput: {},
          toolUseId: `TU-FRESH-${tool}`,
        } as never,
      );
      expect(JSON.stringify(fresh), tool).not.toContain("SUPERVISOR_BINDING_REQUIRED");
    }
    // MCP-level proof for a mutating representative: the stale generation
    // token fails the authority check itself.
    expect(
      codeOf(() =>
        supervisorCallAs(world, {
          sessionId: "S1",
          generation: 1,
          tool: "issue_execution_directive",
          business: directiveProbeBusiness(world),
        }),
      ),
    ).toBe("STALE_SUPERVISOR_BINDING");
  });

  it("E12-T33: a second takeover moves N+1 → N+2 — no generation reuse", async () => {
    const world = await makeAcceptanceWorld("S1");
    explicitExecutionTakeover(world, { newSessionId: "S2", expectedGeneration: 1 });
    const second = explicitExecutionTakeover(world, { newSessionId: "S3", expectedGeneration: 2 });
    expect(second.supervisor).toMatchObject({ generation: 3, state: "attached" });
    // Stale expected generations fail closed.
    expect(codeOf(() => explicitExecutionTakeover(world, { newSessionId: "S4", expectedGeneration: 1 }))).toBe(
      "STALE_SUPERVISOR_BINDING",
    );
  });

  it("E12-T34: terminal runs can never be taken over (completed + replan_required)", async () => {
    const world = await makeAcceptanceWorld("S1");
    runVerificationCycle(world);
    world.ctx.store.withWrite((tx) =>
      requestExecutionReplanInTx(
        tx,
        {
          sessionId: world.f.sessionId,
          workspaceId: world.f.workspaceId,
          generation: world.f.generation,
          reason: "approved interface contradicts reality",
          affectedNormativeRefs: [{ type: "section", id: world.f.sectionIds[0]!, revision: 1 }],
          relevantReportRefs: [],
          toolUseId: "TU-T34",
        },
        world.ctx.clock,
        world.ctx.clock.nowIso(),
      ),
    );
    expect(codeOf(() => explicitExecutionTakeover(world, { newSessionId: "S9", expectedGeneration: 1 }))).toBe(
      "RUN_TERMINAL",
    );
    // A DETACHED binding on an ACTIVE run is lawful takeover territory (§25 —
    // detach is not terminality): the ownership change succeeds.
    const { world: w2 } = await makeIndeterminateWorld();
    w2.ctx.store.withWrite((tx) => {
      tx.prepare("UPDATE supervisor_bindings SET state = 'detached' WHERE execution_run_id = ?").run(w2.executionRunId);
    });
    const detached = explicitExecutionTakeover(w2, { newSessionId: "S9", expectedGeneration: 1 });
    expect(detached.supervisor).toMatchObject({ generation: 2, state: "attached" });
  });

  it("E12-T35: takeover from a mismatched workspace fails closed", async () => {
    const world = await makeAcceptanceWorld("S1");
    expect(
      codeOf(() =>
        explicitExecutionTakeover(world, {
          newSessionId: "S9",
          expectedGeneration: 1,
          workspaceId: "ws_some-other-workspace",
        }),
      ),
    ).toBe("WORKSPACE_MISMATCH");
  });
});
