/**
 * E12-T55..T57 / T61..T63 + §73 — unknown worker liveness across takeover,
 * terminal recovery, and the cross-feature recovery projection matrix: for
 * each canonical Store world the projection is deterministic, purely
 * Store-derived, and never rewritten by a conversation operation.
 */
import { describe, expect, it } from "vitest";

import { handleSessionStart } from "../src/hooks/handlers.js";
import { codeOf, makeAcceptanceWorld, runVerificationCycle, acceptanceServiceOf, acceptInput, completeActiveStageFixture } from "./acceptance-helpers.js";
import { makeIndeterminateWorld, makeUnknownLivenessWorld } from "./attempt-recovery-helpers.js";
import { createSupervisorBindingService } from "../src/application/supervisor-binding-service.js";
import { renderExecutionRecoveryContext } from "../src/context/execution-recovery.js";
import { requestExecutionReplanInTx } from "../src/application/execution-replan-service.js";
import { beginFinalClosure, completeAllStagesFixture, runFinalCompletionFixture } from "./final-closure-helpers.js";
import { explicitExecutionTakeover, depsOf, executionFingerprintOf, sessionStartInput } from "./session-recovery-helpers.js";
import type { AcceptanceWorld } from "./acceptance-helpers.js";

function factsOf(world: AcceptanceWorld) {
  return world.ctx.store.withRead((tx) =>
    createSupervisorBindingService(world.ctx.store, world.ctx.clock).loadExecutionRecoveryFactsInTx(tx, {
      executionRunId: world.executionRunId,
      sessionId: world.f.sessionId,
    }),
  );
}

/** The capsule exactly as the SessionStart surface renders it. */
function capsuleOf(world: AcceptanceWorld): string {
  return renderExecutionRecoveryContext({
    ...factsOf(world),
    sessionStart: { outcome: "same_owner_attached", relation: "startup" },
  });
}

async function replanWorld(): Promise<AcceptanceWorld> {
  const world = await makeAcceptanceWorld(`RC-${Math.random().toString(36).slice(2, 8)}`);
  world.ctx.store.withWrite((tx) =>
    requestExecutionReplanInTx(
      tx,
      {
        sessionId: world.f.sessionId,
        workspaceId: world.f.workspaceId,
        generation: world.f.generation,
        reason: "the approved interface contradicts the platform reality",
        affectedNormativeRefs: [{ type: "section", id: world.f.sectionIds[0]!, revision: 1 }],
        relevantReportRefs: [],
        toolUseId: `TU-RC-${Math.random().toString(36).slice(2, 8)}`,
      },
      world.ctx.clock,
      world.ctx.clock.nowIso(),
    ),
  );
  return world;
}

describe("E12 unknown worker liveness across takeover (§45/§70)", () => {
  it("E12-T55/T56: takeover never classifies unknown-running as indeterminate and never replays", async () => {
    const { world, attemptId } = await makeUnknownLivenessWorld();
    const attemptsBefore = world.ctx.store.withRead(
      (tx) => tx.prepare("SELECT COUNT(*) AS n FROM execution_attempts WHERE execution_run_id = ?").get(world.executionRunId) as { n: number },
    ).n;
    explicitExecutionTakeover(world, { newSessionId: "S2", expectedGeneration: 1 });
    const attempt = world.ctx.store.withRead(
      (tx) => tx.prepare("SELECT state FROM execution_attempts WHERE attempt_id = ?").get(attemptId) as { state: string },
    );
    expect(attempt.state).toBe("running");
    const invocation = world.ctx.store.withRead(
      (tx) => tx.prepare("SELECT state FROM execution_worker_invocations WHERE attempt_id = ?").get(attemptId) as { state: string },
    );
    expect(invocation.state).toBe("claimed");
    const attemptsAfter = world.ctx.store.withRead(
      (tx) => tx.prepare("SELECT COUNT(*) AS n FROM execution_attempts WHERE execution_run_id = ?").get(world.executionRunId) as { n: number },
    ).n;
    expect(attemptsAfter).toBe(attemptsBefore);
  });

  it("E12-T57: the recovery projection under the new supervisor still says runtime resolution required", async () => {
    const { world } = await makeUnknownLivenessWorld();
    explicitExecutionTakeover(world, { newSessionId: "S2", expectedGeneration: 1 });
    const capsule = capsuleOf(world);
    expect(capsule).toContain("runtime=claimed");
    expect(capsule).toContain("Next legal action: wait for runtime resolution");
  });
});

describe("E12 terminal recovery (§27/§72)", () => {
  it("E12-T61: a completed run is readable, not attachable, and not take-overable", async () => {
    const world = await makeAcceptanceWorld("S1");
    completeAllStagesFixture(world);
    beginFinalClosure(world);
    runFinalCompletionFixture(world);
    expect(factsOf(world).executionRun.lifecycle).toBe("completed");
    const capsule = capsuleOf(world);
    expect(capsule).toContain("ExecutionRun is COMPLETE");
    expect(capsule).toContain("Next legal action: none");
    // Takeover refuses the terminal run outright.
    const code = codeOf(() => explicitExecutionTakeover(world, { newSessionId: "S9", expectedGeneration: 1 }));
    expect(code).not.toBe("no-error");
  });

  it("E12-T62: a replan_required run is readable; the next action is /phase-plan, never execution takeover", async () => {
    const world = await replanWorld();
    const capsule = capsuleOf(world);
    expect(capsule).toContain("TERMINAL (replan_required)");
    expect(capsule).toContain("Next legal action: invoke /phase-plan");
    expect(codeOf(() => explicitExecutionTakeover(world, { newSessionId: "S9", expectedGeneration: 1 }))).not.toBe("no-error");
  });

  it("E12-T63: clear/fork/rewind conversation operations cannot reopen a terminal run", async () => {
    const world = await replanWorld();
    const before = executionFingerprintOf(world);
    for (const source of ["clear", "startup", "resume", "compact"] as const) {
      await handleSessionStart(depsOf(world), sessionStartInput(world, { sessionId: world.f.sessionId, source }) as never);
      expect(executionFingerprintOf(world), source).toBe(before);
      expect(world.ctx.store.withRead((tx) => tx.prepare("SELECT lifecycle FROM execution_runs WHERE execution_run_id = ?").get(world.executionRunId) as { lifecycle: string }).lifecycle).toBe(
        "replan_required",
      );
    }
  });
});

describe("E12 §73 — cross-feature recovery projection determinism", () => {
  async function worldsWithProjections(): Promise<Array<{ name: string; world: AcceptanceWorld; capsule: string }>> {
    const out: Array<{ name: string; world: AcceptanceWorld; capsule: string }> = [];
    // active candidate
    {
      const world = await makeAcceptanceWorld(`P1-${Math.random().toString(36).slice(2, 6)}`);
      out.push({ name: "active stage", world, capsule: capsuleOf(world) });
    }
    // post-commit same stage
    {
      const world = await makeAcceptanceWorld(`P2-${Math.random().toString(36).slice(2, 6)}`);
      runVerificationCycle(world);
      acceptanceServiceOf(world).submitSupervisorAssessment(acceptInput(world) as never);
      out.push({ name: "post-commit same stage", world, capsule: capsuleOf(world) });
    }
    // between stages (stage completed, successor active)
    {
      const world = await makeAcceptanceWorld(`P3-${Math.random().toString(36).slice(2, 6)}`);
      completeActiveStageFixture(world);
      out.push({ name: "between/after stage commit", world, capsule: capsuleOf(world) });
    }
    // open final closure
    {
      const world = await makeAcceptanceWorld(`P4-${Math.random().toString(36).slice(2, 6)}`);
      completeAllStagesFixture(world);
      beginFinalClosure(world);
      out.push({ name: "open final closure", world, capsule: capsuleOf(world) });
    }
    // unresolved indeterminate
    {
      const { world } = await makeIndeterminateWorld();
      out.push({ name: "unresolved indeterminate", world, capsule: capsuleOf(world) });
    }
    // unknown-running worker
    {
      const { world } = await makeUnknownLivenessWorld();
      out.push({ name: "unknown-running worker", world, capsule: capsuleOf(world) });
    }
    // replan_required
    {
      const world = await replanWorld();
      out.push({ name: "replan_required", world, capsule: capsuleOf(world) });
    }
    // completed
    {
      const world = await makeAcceptanceWorld(`P7-${Math.random().toString(36).slice(2, 6)}`);
      completeAllStagesFixture(world);
      beginFinalClosure(world);
      runFinalCompletionFixture(world);
      out.push({ name: "completed", world, capsule: capsuleOf(world) });
    }
    return out;
  }

  it("every canonical world renders a deterministic, Store-derived projection; SessionStart never rewrites it", async () => {
    const projections = await worldsWithProjections();
    expect(projections.length).toBeGreaterThanOrEqual(7);
    for (const { name, world, capsule } of projections) {
      // Deterministic: the same canonical state renders identically twice.
      expect(capsuleOf(world), name).toBe(capsule);
      // Conversation operations never rewrite the underlying truth.
      const before = executionFingerprintOf(world);
      await handleSessionStart(depsOf(world), sessionStartInput(world, { source: "compact" }) as never);
      expect(executionFingerprintOf(world), name).toBe(before);
      expect(capsuleOf(world), name).toBe(capsule);
    }
    // Each named world shows its marker facts.
    const byName = new Map(projections.map((p) => [p.name, p.capsule]));
    expect(byName.get("unresolved indeterminate")).toContain("state=indeterminate");
    expect(byName.get("unknown-running worker")).toContain("runtime=claimed");
    expect(byName.get("open final closure")).toContain("FINAL EXECUTION CLOSURE IN PROGRESS");
    expect(byName.get("replan_required")).toContain("TERMINAL (replan_required)");
    expect(byName.get("completed")).toContain("ExecutionRun is COMPLETE");
    expect(byName.get("post-commit same stage")).toContain("accepted head: ec_");
  });
});
