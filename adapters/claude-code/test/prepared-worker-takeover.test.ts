/**
 * E12-T44..T48 — prepared-unclaimed workers across takeover (E12 §37/§38):
 * the takeover transaction itself invalidates the fenced supervisor's launch
 * credential; the old token can never claim; the SAME Attempt is
 * re-credentialed by the new supervisor through retry_unclaimed_worker_launch;
 * no second Attempt is ever created.
 */
import { describe, expect, it } from "vitest";

import { codeOf, makeAcceptanceWorld } from "./acceptance-helpers.js";
import { issueDirective } from "./execution-protocol-helpers.js";
import { freshWorkerSession } from "./execution-worker-helpers.js";
import { startWorkerAttemptAndPrepareLaunchInTx } from "../src/application/worker-runtime-service.js";
import { claimWorkerInvocationInTx, getWorkerInvocationInTx, listRunWorkerInvocationsInTx } from "../src/store/worker-invocations.js";
import { listRunAttemptsInTx } from "../src/store/execution-attempts.js";
import { hashLaunchToken } from "../src/store/worker-invocations.js";
import { explicitExecutionTakeover, supervisorCallAs } from "./session-recovery-helpers.js";

async function preparedWorld(sessionId = "S1") {
  const world = await makeAcceptanceWorld(sessionId);
  const directive = issueDirective(world, { directiveId: "DIR-PREP", kind: "implementation" });
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
  return { world, attemptId: attempt.attemptId, staleLaunchToken: launch.launchToken, directiveId: directive.directiveId, directiveRevision: directive.revision };
}

describe("E12 prepared-unclaimed worker across takeover (§37/§38)", () => {
  it("E12-T44: the takeover invalidates the old launch credential in the same transaction", async () => {
    const { world, attemptId, staleLaunchToken } = await preparedWorld();
    const hashBefore = world.ctx.store.withRead((tx) => getWorkerInvocationInTx(tx, attemptId))!.launchTokenHash;
    expect(hashBefore).toBe(hashLaunchToken(staleLaunchToken));
    const result = explicitExecutionTakeover(world, { newSessionId: "S2", expectedGeneration: 1 });
    expect(result.supervisor!.revokedLaunchCredentials).toEqual([attemptId]);
    const hashAfter = world.ctx.store.withRead((tx) => getWorkerInvocationInTx(tx, attemptId))!.launchTokenHash;
    expect(hashAfter).not.toBe(hashBefore);
    // The Attempt and its invocation binding are otherwise untouched.
    expect(world.ctx.store.withRead((tx) => getWorkerInvocationInTx(tx, attemptId))).toMatchObject({
      state: "prepared",
      workerSessionId: null,
    });
  });

  it("E12-T45: the old token can never claim after the fence", async () => {
    const { world, attemptId, staleLaunchToken } = await preparedWorld();
    explicitExecutionTakeover(world, { newSessionId: "S2", expectedGeneration: 1 });
    const session = freshWorkerSession(world, "STALE");
    expect(
      codeOf(() =>
        world.ctx.store.withWrite((tx) =>
          claimWorkerInvocationInTx(
            tx,
            {
              attemptId,
              launchToken: staleLaunchToken,
              workerSessionId: session.sessionId,
              workerAgentId: session.agentId,
              workspaceId: world.f.workspaceId,
              executionRunId: world.executionRunId,
            },
            world.ctx.clock.nowIso(),
          ),
        ),
      ),
    ).toBe("WORKER_CLAIM_TOKEN_INVALID");
  });

  it("E12-T46: no new Attempt is created by the takeover recovery", async () => {
    const { world, attemptId, directiveId } = await preparedWorld();
    explicitExecutionTakeover(world, { newSessionId: "S2", expectedGeneration: 1 });
    const attempts = world.ctx.store.withRead((tx) => listRunAttemptsInTx(tx, world.executionRunId));
    expect(attempts.filter((a) => a.directiveId === directiveId).map((a) => a.attemptId)).toEqual([attemptId]);
    const invocations = world.ctx.store.withRead((tx) => listRunWorkerInvocationsInTx(tx, world.executionRunId));
    expect(invocations.filter((i) => i.attemptId === attemptId)).toHaveLength(1);
  });

  it("E12-T47/T48: the new supervisor retries the SAME Attempt and the new credential claims", async () => {
    const { world, attemptId } = await preparedWorld();
    explicitExecutionTakeover(world, { newSessionId: "S2", expectedGeneration: 1 });
    const retried = supervisorCallAs(world, {
      sessionId: "S2",
      generation: 2,
      tool: "retry_unclaimed_worker_launch",
      business: { attempt_id: attemptId },
    }) as { status: string; attempt_id: string; launch_token: string };
    expect(retried.status).toBe("relaunched");
    expect(retried.attempt_id).toBe(attemptId);
    const session = freshWorkerSession(world, "RETRY2");
    world.ctx.store.withWrite((tx) =>
      claimWorkerInvocationInTx(
        tx,
        {
          attemptId,
          launchToken: retried.launch_token,
          workerSessionId: session.sessionId,
          workerAgentId: session.agentId,
          workspaceId: world.f.workspaceId,
          executionRunId: world.executionRunId,
        },
        world.ctx.clock.nowIso(),
      ),
    );
    expect(world.ctx.store.withRead((tx) => getWorkerInvocationInTx(tx, attemptId))).toMatchObject({
      state: "claimed",
      workerSessionId: session.sessionId,
    });
  });
});
