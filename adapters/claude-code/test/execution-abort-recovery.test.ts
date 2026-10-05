/**
 * E13-T52..T57 — recovery for an aborted run (§53/§54): the SessionStart
 * capsule renders the terminal history with the durable abort provenance,
 * the historical running Attempt is marked authority-less, NO mutation
 * happens on any conversation operation, and no takeover/reattach path can
 * reopen the run.
 */
import { describe, expect, it } from "vitest";

import { handleSessionStart } from "../src/hooks/handlers.js";
import { makeAcceptanceWorld } from "./acceptance-helpers.js";
import {
  bindingOf,
  contextOf,
  depsOf,
  executionFingerprintOf,
  explicitExecutionAbort,
  sessionStartInput,
  lifecycleOf,
} from "./session-recovery-helpers.js";
import type { AcceptanceWorld } from "./acceptance-helpers.js";

function capsuleOf(world: AcceptanceWorld, overrides: Record<string, unknown> = {}): Promise<string> {
  return (async () => {
    const out = await handleSessionStart(depsOf(world), sessionStartInput(world, overrides) as never);
    return contextOf(out);
  })();
}

describe("E13 recovery (§53/§54)", () => {
  it("E13-T52/T53: the aborted capsule renders terminal state + reason + human-authorization provenance", async () => {
    const world = await makeAcceptanceWorld("S1");
    explicitExecutionAbort(world, { requesterSessionId: "S7", reason: "user cancelled the work" });
    const capsule = await capsuleOf(world);
    expect(capsule).toContain("ExecutionRun is TERMINAL (aborted)");
    expect(capsule).toContain("user cancelled the work");
    expect(capsule).toContain("human-authorized control record");
    expect(capsule).toContain("NO rollback");
    expect(capsule).toContain("none for this Run");
  });

  it("E13-T54: the aborted run renders no open window and the preserved stage history", async () => {
    const world = await makeAcceptanceWorld("S1");
    explicitExecutionAbort(world, { reason: "stop" });
    const capsule = await capsuleOf(world);
    expect(capsule).toContain("open window: none");
    expect(capsule).toContain("active stage:");
  });

  it("E13-T55: a historical running Attempt is rendered authority-less, not live", async () => {
    const world = await makeAcceptanceWorld("S1");
    const { issueDirective } = await import("./execution-protocol-helpers.js");
    const { startWorkerAttemptAndPrepareLaunchInTx } = await import("../src/application/worker-runtime-service.js");
    const directive = issueDirective(world, { directiveId: "DIR-E13-REC", kind: "implementation" });
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
    explicitExecutionAbort(world, { reason: "stop with prepared work" });
    const capsule = await capsuleOf(world);
    expect(capsule).toContain("historical — the terminal Run lifecycle overrides protocol liveness; NO authority remains");
  });

  it("E13-T56: SessionStart against the aborted run performs zero mutation", async () => {
    const world = await makeAcceptanceWorld("S1");
    explicitExecutionAbort(world, { reason: "stop" });
    const before = executionFingerprintOf(world);
    await capsuleOf(world);
    await capsuleOf(world, { sessionId: "S2-OTHER", source: "startup" });
    expect(executionFingerprintOf(world)).toBe(before);
    expect(bindingOf(world)).toMatchObject({ state: "detached", generation: 1 });
  });

  it("E13-T57: clear/fork/rewind/compaction cannot reopen the aborted run", async () => {
    const world = await makeAcceptanceWorld("S1");
    explicitExecutionAbort(world, { reason: "stop" });
    for (const source of ["clear", "fork", "compact", "resume", "startup"] as const) {
      await capsuleOf(world, { sessionId: source === "resume" ? "S1" : `S-${source}`, source });
      expect(lifecycleOf(world), source).toBe("aborted");
    }
    expect(bindingOf(world)).toMatchObject({ state: "detached", generation: 1 });
  });
});
