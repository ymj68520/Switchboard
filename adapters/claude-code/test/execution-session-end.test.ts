/**
 * E12-T5..T7 — SessionEnd semantics (E12 §9/§10): best-effort detach of the
 * CURRENT owner only, the run stays active, correctness never depends on the
 * hook firing, and a LATE stale SessionEnd after a takeover can never detach
 * the new owner.
 */
import { describe, expect, it } from "vitest";

import { handleSessionEnd } from "../src/hooks/handlers.js";
import { takeoverSupervisorBindingInTx } from "../src/store/supervisor-bindings.js";
import { getExecutionRunInTx } from "../src/store/execution-runs.js";
import { makeAcceptanceWorld } from "./acceptance-helpers.js";
import { bindingOf, depsOf, lifecycleOf } from "./session-recovery-helpers.js";

function sessionEndInput(sessionId: string): Record<string, unknown> {
  return { sessionId, hookEventName: "SessionEnd", reason: "prompt_input_exit" };
}

describe("E12 SessionEnd (§9/§10)", () => {
  it("E12-T5: the current SessionEnd detaches the current owner; the run stays active", () => {
    const world = makeAcceptanceWorld("S1");
    return world.then((w) => {
      handleSessionEnd(depsOf(w), sessionEndInput("S1") as never);
      expect(bindingOf(w)).toMatchObject({ state: "detached", generation: 1, sessionId: "S1" });
      expect(lifecycleOf(w)).toBe("active");
    });
  });

  it("E12-T6: a missing SessionEnd never breaks a later explicit takeover", async () => {
    const world = await makeAcceptanceWorld("S1");
    // NO SessionEnd fired (crash): the binding is still attached to S1.
    expect(bindingOf(world)).toMatchObject({ state: "attached", generation: 1 });
    const result = world.ctx.store.withWrite((tx) =>
      takeoverSupervisorBindingInTx(
        tx,
        { executionRunId: world.executionRunId, workspaceId: world.f.workspaceId, newSessionId: "S2", expectedGeneration: 1 },
        world.ctx.clock.nowIso(),
      ),
    );
    expect(result).toMatchObject({ state: "attached", generation: 2, sessionId: "S2" });
    expect(world.ctx.store.withRead((tx) => getExecutionRunInTx(tx, world.executionRunId))?.lifecycle).toBe("active");
  });

  it("E12-T7: a LATE stale SessionEnd after takeover cannot detach the new owner", async () => {
    const world = await makeAcceptanceWorld("S1");
    world.ctx.store.withWrite((tx) =>
      takeoverSupervisorBindingInTx(
        tx,
        { executionRunId: world.executionRunId, workspaceId: world.f.workspaceId, newSessionId: "S2", expectedGeneration: 1 },
        world.ctx.clock.nowIso(),
      ),
    );
    // S1's SessionEnd arrives AFTER the ownership moved to S2.
    handleSessionEnd(depsOf(world), sessionEndInput("S1") as never);
    expect(bindingOf(world)).toMatchObject({ state: "attached", generation: 2, sessionId: "S2" });
    // S2's own SessionEnd (when IT ends) detaches normally.
    handleSessionEnd(depsOf(world), sessionEndInput("S2") as never);
    expect(bindingOf(world)).toMatchObject({ state: "detached", generation: 2, sessionId: "S2" });
    expect(lifecycleOf(world)).toBe("active");
  });
});
