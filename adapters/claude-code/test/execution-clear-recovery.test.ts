/**
 * E12-T8..T12 — /clear semantics (E12 §11–§13/§59): the clear-created session
 * receives NO writable authority, nothing mutates merely because it starts,
 * execution state is untouched, and explicit takeover is the only path to
 * ownership — after which the cleared session is fenced.
 */
import { describe, expect, it } from "vitest";

import { handlePreToolUse, handleSessionStart } from "../src/hooks/handlers.js";
import { makeAcceptanceWorld } from "./acceptance-helpers.js";
import { codeOf, supervisorCall } from "./acceptance-helpers.js";
import {
  bindingOf,
  directiveProbeBusiness,
  contextOf,
  depsOf,
  executionFingerprintOf,
  explicitExecutionTakeover,
  sessionStartInput,
  supervisorCallAs,
} from "./session-recovery-helpers.js";

describe("E12 /clear (§11–§13)", () => {
  it("E12-T8: the clear-created session has no writable supervisor authority", async () => {
    const world = await makeAcceptanceWorld("S1");
    const out = await handleSessionStart(depsOf(world), sessionStartInput(world, { sessionId: "S2-CLEAR", source: "clear" }) as never);
    const context = contextOf(out);
    expect(context).toContain("NO writable supervision authority");
    expect(context).toContain("explicit user-authorized takeover");
    expect(context).toContain("Session relation: clear");
  });

  it("E12-T8b: the clear-created session cannot sign supervisor execution operations", async () => {
    const world = await makeAcceptanceWorld("S1");
    const out = await handlePreToolUse(
      depsOf(world),
      {
        sessionId: "S2-CLEAR",
        cwd: world.f.workspaceRoot,
        permissionMode: "default",
        hookEventName: "PreToolUse",
        toolName: "mcp__plugin_phase-plan_phase-plan__issue_execution_directive",
        toolInput: {},
        toolUseId: "TU-CLEAR-1",
      } as never,
    );
    const payload = JSON.stringify(out);
    expect(payload).toContain("SUPERVISOR_BINDING_REQUIRED");
  });

  it("E12-T9: no generation increment merely because the clear session starts", async () => {
    const world = await makeAcceptanceWorld("S1");
    await handleSessionStart(depsOf(world), sessionStartInput(world, { sessionId: "S2-CLEAR", source: "clear" }) as never);
    expect(bindingOf(world)).toMatchObject({ state: "attached", generation: 1, sessionId: "S1" });
  });

  it("E12-T10: the clear session start mutates no execution state", async () => {
    const world = await makeAcceptanceWorld("S1");
    const before = executionFingerprintOf(world);
    await handleSessionStart(depsOf(world), sessionStartInput(world, { sessionId: "S2-CLEAR", source: "clear" }) as never);
    expect(executionFingerprintOf(world)).toBe(before);
  });

  it("E12-T11: explicit takeover from the clear-created session advances the generation by one", async () => {
    const world = await makeAcceptanceWorld("S1");
    const result = explicitExecutionTakeover(world, { newSessionId: "S2-CLEAR", expectedGeneration: 1 });
    expect(result.supervisor).toMatchObject({ generation: 2, state: "attached" });
    expect(bindingOf(world)).toMatchObject({ state: "attached", generation: 2, sessionId: "S2-CLEAR" });
  });

  it("E12-T12: the old cleared session is fenced after the takeover", async () => {
    const world = await makeAcceptanceWorld("S1");
    explicitExecutionTakeover(world, { newSessionId: "S2-CLEAR", expectedGeneration: 1 });
    // S1 signs with its remembered generation 1 — permanently stale at gen 2.
    // (A mutating supervisor op: presence-only field validation defers to the
    // EXECUTION authority check, which fires first.)
    expect(
      codeOf(() =>
        supervisorCall(world, "issue_execution_directive", directiveProbeBusiness(world) as never, "S1"),
      ),
    ).toBe("STALE_SUPERVISOR_BINDING");
    // The new owner proceeds with the CURRENT generation.
    const listing = supervisorCallAs(world, {
      sessionId: "S2-CLEAR",
      generation: 2,
      tool: "get_execution_acceptance_context",
    }) as Record<string, unknown>;
    expect(listing).not.toHaveProperty("error");
  });
});
