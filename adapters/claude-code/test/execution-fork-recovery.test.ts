/**
 * E12-T13..T17 — fork semantics (E12 §14–§16/§60): a forked conversation
 * inherits NOTHING, the original owner keeps ownership untouched, the fork is
 * fenced from every mutation, and only the explicit authorized takeover moves
 * ownership — after which the old owner is permanently stale.
 */
import { describe, expect, it } from "vitest";

import { handlePreToolUse, handleSessionStart } from "../src/hooks/handlers.js";
import { makeAcceptanceWorld } from "./acceptance-helpers.js";
import { codeOf, supervisorCall } from "./acceptance-helpers.js";
import {
  bindingOf,
  contextOf,
  depsOf,
  directiveProbeBusiness,
  explicitExecutionTakeover,
  sessionStartInput,
  supervisorCallAs,
} from "./session-recovery-helpers.js";

describe("E12 fork (§14–§16)", () => {
  it("E12-T13/T14: the fork inherits no binding and never detaches the original owner", async () => {
    const world = await makeAcceptanceWorld("S1");
    const out = await handleSessionStart(depsOf(world), sessionStartInput(world, { sessionId: "S2-FORK", source: "startup" }) as never);
    expect(contextOf(out)).toContain("owned by another session");
    expect(bindingOf(world)).toMatchObject({ state: "attached", generation: 1, sessionId: "S1" });
  });

  it("E12-T15: the fork cannot issue execution mutations", async () => {
    const world = await makeAcceptanceWorld("S1");
    expect(
      codeOf(() => supervisorCall(world, "issue_execution_directive", directiveProbeBusiness(world) as never, "S2-FORK")),
    ).toBe("STALE_SUPERVISOR_BINDING");
    expect(bindingOf(world)).toMatchObject({ state: "attached", generation: 1 });
  });

  it("E12-T16: the fork cannot perform direct repository mutation (host guard)", async () => {
    const world = await makeAcceptanceWorld("S1");
    for (const [tool, toolInput] of [
      ["Edit", { file_path: "src/x.ts" }],
      ["Write", { file_path: "src/x.ts" }],
      ["Bash", { command: "rm -rf build" }],
      ["Agent", { subagent_type: "general-purpose" }],
    ] as const) {
      const out = await handlePreToolUse(
        depsOf(world),
        {
          sessionId: "S2-FORK",
          cwd: world.f.workspaceRoot,
          permissionMode: "default",
          hookEventName: "PreToolUse",
          toolName: tool,
          toolInput: toolInput as Record<string, unknown>,
          toolUseId: `TU-FORK-${tool}`,
        } as never,
      );
      const payload = JSON.stringify(out);
      expect(payload, tool).toContain("EXECUTION_SESSION_NOT_OWNER");
    }
  });

  it("E12-T17: the explicit authorized fork takeover advances the generation and fences the fork source", async () => {
    const world = await makeAcceptanceWorld("S1");
    const result = explicitExecutionTakeover(world, { newSessionId: "S2-FORK", expectedGeneration: 1 });
    expect(result.supervisor).toMatchObject({ generation: 2, state: "attached" });
    // S1 (the fork source, still alive) is permanently stale at generation 2.
    expect(codeOf(() => supervisorCall(world, "issue_execution_directive", directiveProbeBusiness(world) as never, "S1"))).toBe(
      "STALE_SUPERVISOR_BINDING",
    );
    // The fork itself now works under the CURRENT generation.
    const listing = supervisorCallAs(world, {
      sessionId: "S2-FORK",
      generation: 2,
      tool: "get_execution_acceptance_context",
    }) as Record<string, unknown>;
    expect(listing).not.toHaveProperty("error");
    expect(bindingOf(world)).toMatchObject({ state: "attached", generation: 2, sessionId: "S2-FORK" });
  });
});
