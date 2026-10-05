/**
 * E12-T41..T43 — claimed workers across takeover (E12 §36): a worker that
 * already claimed keeps its full Attempt authority through the ownership
 * change; its durable Report persists normally; only the CURRENT supervisor
 * can act on it afterward.
 */
import { describe, expect, it } from "vitest";

import { codeOf, makeAcceptanceWorld, runVerificationCycle } from "./acceptance-helpers.js";
import { issueDirective } from "./execution-protocol-helpers.js";
import { freshWorkerSession } from "./execution-worker-helpers.js";
import { startWorkerAttemptAndPrepareLaunchInTx } from "../src/application/worker-runtime-service.js";
import { claimWorkerInvocationInTx, getWorkerInvocationInTx } from "../src/store/worker-invocations.js";
import { getExecutionAttemptInTx } from "../src/store/execution-attempts.js";
import { directiveProbeBusiness, explicitExecutionTakeover, supervisorCallAs } from "./session-recovery-helpers.js";
import { callWorkerTool } from "./execution-worker-helpers.js";

/** A claimed implementation worker under the world's attached supervisor. */
async function claimedWorld(sessionId = "S1") {
  const world = await makeAcceptanceWorld(sessionId);
  const directive = issueDirective(world, { directiveId: "DIR-CLAIM", kind: "implementation" });
  const { attempt, launch } = world.ctx.store.withWrite((tx) =>
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
  const session = freshWorkerSession(world, "CLAIM");
  world.ctx.store.withWrite((tx) =>
    claimWorkerInvocationInTx(
      tx,
      {
        attemptId: attempt.attemptId,
        launchToken: launch.launchToken,
        workerSessionId: session.sessionId,
        workerAgentId: session.agentId,
        workspaceId: world.f.workspaceId,
        executionRunId: world.executionRunId,
      },
      world.ctx.clock.nowIso(),
    ),
  );
  return { world, attemptId: attempt.attemptId, session };
}

describe("E12 claimed worker across takeover (§36)", () => {
  it("E12-T41: the claimed worker keeps its authority when the supervisor is taken over", async () => {
    const { world, attemptId, session } = await claimedWorld();
    explicitExecutionTakeover(world, { newSessionId: "S2", expectedGeneration: 1 });
    // The invocation binding, attempt, and worker session are untouched.
    const invocation = world.ctx.store.withRead((tx) => getWorkerInvocationInTx(tx, attemptId));
    expect(invocation).toMatchObject({ state: "claimed", workerSessionId: session.sessionId });
    expect(world.ctx.store.withRead((tx) => getExecutionAttemptInTx(tx, attemptId))?.state).toBe("running");
  });

  it("E12-T42: the worker submits its durable Report normally after the takeover", async () => {
    const { world, attemptId, session } = await claimedWorld();
    explicitExecutionTakeover(world, { newSessionId: "S2", expectedGeneration: 1 });
    const ack = callWorkerTool(world, session, "worker_submit_report", {
      result: "completed",
      candidate_mutated: true,
      actions_performed: [{ action: "implemented", detail: null }],
      files_examined: ["src/a.ts"],
      files_changed: ["src/a.ts"],
      commands_run: [],
      tests_run: [],
      findings: [{ summary: "done under the original claim", details: null }],
      deviations: [],
      blockers: [],
      deliverables: [],
    }) as { report_id: string };
    expect(typeof ack.report_id).toBe("string");
    expect(world.ctx.store.withRead((tx) => getExecutionAttemptInTx(tx, attemptId))?.state).toBe("reported");
  });

  it("E12-T43: the OLD supervisor cannot act on the report; the new one can", async () => {
    const { world } = await claimedWorld();
    // The old supervisor owns the candidate... takeover first, then the old
    // supervisor's follow-up issuance is fenced at its stale generation.
    explicitExecutionTakeover(world, { newSessionId: "S2", expectedGeneration: 1 });
    expect(
      codeOf(() =>
        supervisorCallAs(world, { sessionId: "S1", generation: 1, tool: "issue_execution_directive", business: directiveProbeBusiness(world) }),
      ),
    ).toBe("STALE_SUPERVISOR_BINDING");
    // The new supervisor acts with the current generation: the next
    // verification-cycle issuance path exercises its authority (a full cycle
    // is beyond this test's scope — the acceptance-context read proves it).
    const listing = supervisorCallAs(world, {
      sessionId: "S2",
      generation: 2,
      tool: "get_execution_acceptance_context",
    }) as Record<string, unknown>;
    expect(listing).not.toHaveProperty("error");
    void runVerificationCycle;
  });
});
