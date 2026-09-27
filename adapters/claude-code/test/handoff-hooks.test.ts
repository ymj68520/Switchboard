/**
 * Phase 14 hooks — PreToolUse setMode flow + §7 PermissionRequest gate +
 * PostToolUse delivery finalizer + handoffPending guards (§10/§37/§44/§45/
 * §77/§79/§85–§89/§93, E17–E20/E25/E39–E41/E62/E64/E70/E80).
 */
import { describe, expect, it } from "vitest";

import { RuntimeError } from "../src/runtime/errors.js";
import { executePhasePlanTool } from "../src/mcp/tools.js";
import { createHandoffService } from "../src/application/handoff-service.js";
import { getExecutionBindingInTx } from "../src/store/execution.js";
import { getPlanningRunRecord } from "../src/store/planning-runs.js";
import { listObservationSummaries } from "../src/application/observation-service.js";
import {
  handlePermissionRequest,
  handlePostToolUse,
  handlePreToolUse,
  handleSessionEnd,
  handleSessionStart,
  handleUserPromptSubmit,
} from "../src/hooks/handlers.js";
import type { HookOutput } from "../src/hooks/output.js";
import { callHandoff, executionToken, hostTokenV2, makeApprovedFinalPlanFixture } from "./phase14-helpers.js";

import type { PlanStore } from "../src/store/sqlite-store.js";
import type { StoreClock } from "../src/store/migration-runner.js";
import type { PhasePlanToolContext } from "../src/mcp/tools.js";

function depsOf(ctx: PhasePlanToolContext): { store: PlanStore; secret: Buffer; clock: StoreClock } {
  return { store: ctx.store, secret: ctx.secret, clock: ctx.clock };
}

function outputOf(output: HookOutput): Record<string, unknown> {
  return output.kind === "json" ? output.payload : {};
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof RuntimeError) return err.code;
    throw err;
  }
  throw new Error("expected a RuntimeError but none was thrown");
}

async function preparedWorld(sessionId = "S1") {
  const { f, ctx } = await makeApprovedFinalPlanFixture(sessionId);
  const prepared = callHandoff(ctx, f, { toolUseId: `${sessionId}-HOOK-1` });
  return { f, ctx, prepared };
}

describe("PreToolUse handoff gating (§7/§45/§87–§89, E17/E39/E40)", () => {
  it("pending + plan mode → ask with the signed context (mode orchestration, not approval)", async () => {
    const { f, ctx } = await makeApprovedFinalPlanFixture();
    const out = await handlePreToolUse(depsOf(ctx), {
      sessionId: f.sessionId,
      cwd: f.workspaceRoot,
      permissionMode: "plan",
      hookEventName: "PreToolUse",
      toolName: "mcp__plugin_phase-plan_phase-plan__handoff",
      toolInput: {},
      toolUseId: "call_PRE-1",
    });
    const payload = outputOf(out) as { hookSpecificOutput: { permissionDecision: string; updatedInput: Record<string, unknown> } };
    expect(payload.hookSpecificOutput.permissionDecision).toBe("ask");
    expect(typeof payload.hookSpecificOutput.updatedInput._hostContext).toBe("string");
  });

  it("pending + default mode → no permission decision (retry without restoring Plan Mode, §89/E40)", async () => {
    const { f, ctx } = await makeApprovedFinalPlanFixture();
    const out = await handlePreToolUse(depsOf(ctx), {
      sessionId: f.sessionId,
      cwd: f.workspaceRoot,
      permissionMode: "default",
      hookEventName: "PreToolUse",
      toolName: "mcp__plugin_phase-plan_phase-plan__handoff",
      toolInput: {},
      toolUseId: "call_PRE-2",
    });
    const payload = outputOf(out) as { hookSpecificOutput: { permissionDecision?: string; updatedInput?: Record<string, unknown> } };
    expect(payload.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(typeof payload.hookSpecificOutput.updatedInput?._hostContext).toBe("string");
  });

  it("not pending → deny before any mode change (E17)", async () => {
    const { makeCleanValidationFixture } = await import("./phase13-helpers.js");
    const early = await makeCleanValidationFixture("S1");
    const { getWorkspaceById } = await import("../src/store/repositories.js");
    const out = await handlePreToolUse(depsOf(early.ctx), {
      sessionId: early.f.sessionId,
      cwd: getWorkspaceById(early.ctx.store, early.f.workspaceId)!.canonicalRoot,
      permissionMode: "plan",
      hookEventName: "PreToolUse",
      toolName: "mcp__plugin_phase-plan_phase-plan__handoff",
      toolInput: {},
      toolUseId: "call_PRE-3",
    });
    const payload = outputOf(out) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
    expect(payload.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(payload.hookSpecificOutput.permissionDecisionReason).toContain("HANDOFF_NOT_AUTHORIZED");
  });

  it("execution tools are denied while handoff is pending; allowlist reads pass (§45/E39)", async () => {
    const { f, ctx } = await makeApprovedFinalPlanFixture();
    for (const tool of ["Write", "Edit", "NotebookEdit", "Bash", "PowerShell", "Agent"]) {
      const out = await handlePreToolUse(depsOf(ctx), {
        sessionId: f.sessionId,
        cwd: f.workspaceRoot,
        permissionMode: "default",
        hookEventName: "PreToolUse",
        toolName: tool,
        toolInput: {},
        toolUseId: `call_GUARD-${tool}`,
      });
      const payload = outputOf(out) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
      expect(payload.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(payload.hookSpecificOutput.permissionDecisionReason).toContain("HANDOFF_DELIVERY_PENDING");
    }
    const read = await handlePreToolUse(depsOf(ctx), {
      sessionId: f.sessionId,
      cwd: f.workspaceRoot,
      permissionMode: "default",
      hookEventName: "PreToolUse",
      toolName: "Read",
      toolInput: { file_path: "x" },
      toolUseId: "call_GUARD-READ",
    });
    expect(read.kind).toBe("empty");
  });
});

describe("UserPromptSubmit handoff-pending (§44, E41)", () => {
  it("pending + non-plan mode injects the pending notice and is NOT the A1 drift block", async () => {
    const { f, ctx } = await makeApprovedFinalPlanFixture();
    const out = handleUserPromptSubmit(depsOf(ctx), {
      sessionId: f.sessionId,
      permissionMode: "default",
      hookEventName: "UserPromptSubmit",
      prompt: "continue working",
    });
    const payload = outputOf(out) as { hookSpecificOutput?: { additionalContext?: string }; decision?: string };
    expect(payload.decision).toBeUndefined();
    expect(payload.hookSpecificOutput?.additionalContext).toContain("execution handoff is pending");
    expect(payload.hookSpecificOutput?.additionalContext).toContain("Complete phase_plan.handoff");
  });
});

describe("PermissionRequest handoff gate (§6–§7/§88, E18)", () => {
  it("verified eligible context → allow with session-scoped setMode(default)", async () => {
    const { f, ctx } = await makeApprovedFinalPlanFixture();
    const token = hostTokenV2(ctx.secret, "handoff", {}, {
      sessionId: f.sessionId, workspaceId: f.workspaceId, runId: f.runId, generation: f.generation,
    }, { permissionMode: "plan", toolUseId: "call_PR-1" });
    const out = handlePermissionRequest(depsOf(ctx), {
      sessionId: f.sessionId,
      permissionMode: "plan",
      hookEventName: "PermissionRequest",
      toolName: "mcp__plugin_phase-plan_phase-plan__handoff",
      toolInput: { _hostContext: token },
    });
    const payload = outputOf(out) as { hookSpecificOutput: { decision: { behavior: string; updatedPermissions: Array<{ type: string; mode: string; destination: string }> } } };
    expect(payload.hookSpecificOutput.decision.behavior).toBe("allow");
    expect(payload.hookSpecificOutput.decision.updatedPermissions).toEqual([
      { type: "setMode", mode: "default", destination: "session" },
    ]);
  });

  it("ineligible or tampered contexts deny the transition (never mode-first)", async () => {
    const { makeCleanValidationFixture } = await import("./phase13-helpers.js");
    const early = await makeCleanValidationFixture("S1");
    const token = hostTokenV2(early.ctx.secret, "handoff", {}, {
      sessionId: early.f.sessionId, workspaceId: early.f.workspaceId, runId: early.f.runId, generation: early.f.generation,
    }, { permissionMode: "plan", toolUseId: "call_PR-2" });
    const denied = handlePermissionRequest(depsOf(early.ctx), {
      sessionId: early.f.sessionId,
      permissionMode: "plan",
      hookEventName: "PermissionRequest",
      toolName: "mcp__plugin_phase-plan_phase-plan__handoff",
      toolInput: { _hostContext: token },
    });
    const payload = outputOf(denied) as { hookSpecificOutput: { decision: { behavior: string; reason: string } } };
    expect(payload.hookSpecificOutput.decision.behavior).toBe("deny");
    expect(payload.hookSpecificOutput.decision.reason).toContain("HANDOFF_NOT_AUTHORIZED");

    const { f, ctx } = await makeApprovedFinalPlanFixture("S2");
    const forged = hostTokenV2(ctx.secret, "handoff", {}, {
      sessionId: "OTHER", workspaceId: f.workspaceId, runId: f.runId, generation: f.generation,
    }, { permissionMode: "plan", toolUseId: "call_PR-3" });
    const mismatch = handlePermissionRequest(depsOf(ctx), {
      sessionId: f.sessionId,
      permissionMode: "plan",
      hookEventName: "PermissionRequest",
      toolName: "mcp__plugin_phase-plan_phase-plan__handoff",
      toolInput: { _hostContext: forged },
    });
    const mismatchPayload = outputOf(mismatch) as { hookSpecificOutput: { decision: { behavior: string } } };
    expect(mismatchPayload.hookSpecificOutput.decision.behavior).toBe("deny");
  });
});

describe("PostToolUse delivery finalizer (§37–§39/§93, E25/E70/E80)", () => {
  function postInput(f: { sessionId: string }, toolUseId: string, response: unknown) {
    return {
      sessionId: f.sessionId,
      permissionMode: "default",
      hookEventName: "PostToolUse" as const,
      toolName: "mcp__plugin_phase-plan_phase-plan__handoff",
      toolInput: {},
      toolUseId,
      toolResponse: {
        content: [{ type: "text", text: JSON.stringify(response) }],
      },
    };
  }

  it("matching response → DELIVERED + completed + injected completion context", async () => {
    const { f, ctx, prepared } = await preparedWorld();
    const out = await handlePostToolUse(depsOf(ctx), postInput(f, "S1-HOOK-1", {
      ok: true, status: "ok", handoff_id: prepared.handoff_id, handoff_hash: prepared.handoff_hash,
    }));
    const payload = outputOf(out) as { hookSpecificOutput: { additionalContext: string } };
    expect(payload.hookSpecificOutput.additionalContext).toContain("Phase Plan execution handoff delivered.");
    expect(payload.hookSpecificOutput.additionalContext).toContain("PlanningRun is completed.");
    expect(getPlanningRunRecord(ctx.store, f.runId)!.lifecycle).toBe("completed");
  });

  it("host shape B — a bare content-array tool_response (2.1.283 live stdin) finalizes too", async () => {
    const { f, ctx, prepared } = await preparedWorld();
    // Claude Code 2.1.283 delivers tool_response as the bare content array,
    // not the {content:[...]} envelope (captured verbatim on a natural
    // delivery during the Phase 14 closure run).
    const out = await handlePostToolUse(depsOf(ctx), {
      sessionId: f.sessionId,
      permissionMode: "default",
      hookEventName: "PostToolUse" as const,
      toolName: "mcp__plugin_phase-plan_phase-plan__handoff",
      toolInput: {},
      toolUseId: "S1-HOOK-1", // the exact prepared attempt identity (§93)
      toolResponse: [{ type: "text", text: JSON.stringify({
        ok: true, status: "ok", handoff_id: prepared.handoff_id, handoff_hash: prepared.handoff_hash,
      }) }],
    } as Parameters<typeof handlePostToolUse>[1]);
    const payload = outputOf(out) as { hookSpecificOutput: { additionalContext: string } };
    expect(payload.hookSpecificOutput.additionalContext).toContain("Phase Plan execution handoff delivered.");
    expect(getPlanningRunRecord(ctx.store, f.runId)!.lifecycle).toBe("completed");
  });

  it("a bare content array without a text first element is silently ignored", async () => {
    const { f, ctx } = await preparedWorld();
    const out = await handlePostToolUse(depsOf(ctx), {
      sessionId: f.sessionId,
      permissionMode: "default",
      hookEventName: "PostToolUse" as const,
      toolName: "mcp__plugin_phase-plan_phase-plan__handoff",
      toolInput: {},
      toolUseId: "S1-HOOK-ARRAY-BAD",
      toolResponse: [{ type: "text" }],
    } as Parameters<typeof handlePostToolUse>[1]);
    expect(outputOf(out)).toEqual({});
    expect(getPlanningRunRecord(ctx.store, f.runId)!.lifecycle).toBe("active");
  });

  it("a forged response (wrong hash) never completes the transition and is fail-visible", async () => {
    const { f, ctx, prepared } = await preparedWorld();
    const out = await handlePostToolUse(depsOf(ctx), postInput(f, "S1-HOOK-1", {
      ok: true, status: "ok", handoff_id: prepared.handoff_id, handoff_hash: "sha256:" + "0".repeat(64),
    }));
    const payload = outputOf(out) as { hookSpecificOutput: { additionalContext: string } };
    expect(payload.hookSpecificOutput.additionalContext).toContain("HANDOFF_DELIVERY_INVALID");
    expect(getPlanningRunRecord(ctx.store, f.runId)!.lifecycle).toBe("active");
    // error envelope shape is never leaked
    expect(payload.hookSpecificOutput.additionalContext).not.toContain("at Proxy");
  });

  it("replaying the same delivered PostToolUse event changes nothing (§116)", async () => {
    const { f, ctx, prepared } = await preparedWorld();
    const input = postInput(f, "S1-HOOK-1", { ok: true, status: "ok", handoff_id: prepared.handoff_id, handoff_hash: prepared.handoff_hash });
    await handlePostToolUse(depsOf(ctx), input);
    const before = getPlanningRunRecord(ctx.store, f.runId);
    await handlePostToolUse(depsOf(ctx), input);
    expect(getPlanningRunRecord(ctx.store, f.runId)).toEqual(before);
  });

  it("observation capture stops after completion (§69/E56)", async () => {
    const { f, ctx, prepared } = await preparedWorld();
    await handlePostToolUse(depsOf(ctx), postInput(f, "S1-HOOK-1", {
      ok: true, status: "ok", handoff_id: prepared.handoff_id, handoff_hash: prepared.handoff_hash,
    }));
    const before = listObservationSummaries(ctx.store, f.runId, { limit: 100 }).length;
    await handlePostToolUse(depsOf(ctx), {
      sessionId: f.sessionId,
      permissionMode: "default",
      hookEventName: "PostToolUse",
      toolName: "Read",
      toolInput: { file_path: "x.ts" },
      toolUseId: "call_AFTER",
      toolResponse: { type: "text", text: "irrelevant" },
    });
    expect(listObservationSummaries(ctx.store, f.runId, { limit: 100 }).length).toBe(before);
  });
});

describe("SessionStart/SessionEnd Build recovery (§77/§79/§85–§86, E62/E64/E86)", () => {
  it("delivered handoff + attached binding → the Execution Contract is injected on startup/resume/compact", async () => {
    const { f, ctx, prepared } = await preparedWorld();
    createHandoffService(ctx.store, ctx.clock).finalizeDelivery({
      runId: f.runId,
      sessionId: f.sessionId,
      toolUseId: "S1-HOOK-1",
      responseHandoffId: prepared.handoff_id,
      responseHandoffHash: prepared.handoff_hash,
    });
    for (const source of ["startup", "resume", "compact"] as const) {
      const out = await handleSessionStart(depsOf(ctx), {
        sessionId: f.sessionId,
        cwd: f.workspaceRoot,
        permissionMode: "default",
        hookEventName: "SessionStart",
        source,
      });
      const payload = outputOf(out) as { hookSpecificOutput: { additionalContext: string } };
      expect(payload.hookSpecificOutput.additionalContext).toContain("[Phase Plan Execution Contract v1]");
      expect(payload.hookSpecificOutput.additionalContext).toContain(prepared.handoff_id);
      expect(payload.hookSpecificOutput.additionalContext).toContain(prepared.handoff_hash);
    }
  });

  it("handoff-pending recovery names the pending state and the prepared handoff, never Plan Mode restoration", async () => {
    const { f, ctx, prepared } = await preparedWorld();
    const out = await handleSessionStart(depsOf(ctx), {
      sessionId: f.sessionId,
      cwd: f.workspaceRoot,
      permissionMode: "default",
      hookEventName: "SessionStart",
      source: "startup",
    });
    const payload = outputOf(out) as { hookSpecificOutput: { additionalContext: string } };
    const text = payload.hookSpecificOutput.additionalContext;
    expect(text).toContain("Execution handoff is pending.");
    expect(text).toContain(prepared.handoff_id);
    expect(text).toContain("Plan Mode restoration is not required.");
    expect(text).not.toContain("must be restored by invoking /phase-plan");
  });

  it("SessionEnd detaches the execution binding (+1); resume reattaches (+1) (§79/E64)", async () => {
    const { f, ctx, prepared } = await preparedWorld();
    createHandoffService(ctx.store, ctx.clock).finalizeDelivery({
      runId: f.runId,
      sessionId: f.sessionId,
      toolUseId: "S1-HOOK-1",
      responseHandoffId: prepared.handoff_id,
      responseHandoffHash: prepared.handoff_hash,
    });
    const gen1 = ctx.store.withRead((tx) => getExecutionBindingInTx(tx, f.runId))!.generation;
    handleSessionEnd(depsOf(ctx), { sessionId: f.sessionId, hookEventName: "SessionEnd", reason: "prompt_input_exit" });
    const afterDetach = ctx.store.withRead((tx) => getExecutionBindingInTx(tx, f.runId))!;
    expect(afterDetach.state).toBe("detached");
    expect(afterDetach.generation).toBe(gen1 + 1);
    await handleSessionStart(depsOf(ctx), {
      sessionId: f.sessionId,
      cwd: f.workspaceRoot,
      permissionMode: "default",
      hookEventName: "SessionStart",
      source: "resume",
    });
    const afterResume = ctx.store.withRead((tx) => getExecutionBindingInTx(tx, f.runId))!;
    expect(afterResume.state).toBe("attached");
    expect(afterResume.generation).toBe(gen1 + 2);
  });

  it("after SessionEnd the Build authority is gone (detached binding fails closed, E43)", async () => {
    const { f, ctx, prepared } = await preparedWorld();
    createHandoffService(ctx.store, ctx.clock).finalizeDelivery({
      runId: f.runId,
      sessionId: f.sessionId,
      toolUseId: "S1-HOOK-1",
      responseHandoffId: prepared.handoff_id,
      responseHandoffHash: prepared.handoff_hash,
    });
    const binding = ctx.store.withRead((tx) => getExecutionBindingInTx(tx, f.runId))!;
    handleSessionEnd(depsOf(ctx), { sessionId: f.sessionId, hookEventName: "SessionEnd", reason: "other" });
    // The binding is detached: no authority at all (reattach + stale generation is STALE_EXECUTION_BINDING,
    // covered by the read-authority suite).
    expect(codeOf(() =>
      executeGetState(ctx, f, binding.generation),
    )).toBe("EXECUTION_CONTEXT_NOT_AVAILABLE");
  });

  function executeGetState(ctx: PhasePlanToolContext, f: { sessionId: string; workspaceId: string; runId: string; finalPlanId: string }, generation: number) {
    return executePhasePlanTool(ctx, "get_state", {
      _hostContext: executionToken(ctx, {
        sessionId: f.sessionId, workspaceId: f.workspaceId, runId: f.runId, finalPlanId: f.finalPlanId,
        generation, tool: "get_state",
      }),
    });
  }
});
