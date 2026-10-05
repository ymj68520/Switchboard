/**
 * E12-T49/T50 — the claim/takeover race in BOTH serialization orders
 * (E12 §39): claim-first leaves a fully authorized claimed Worker that
 * survives; takeover-first rejects the old credential with no duplicate
 * Worker authority and leaves the SAME Attempt prepared for the new
 * supervisor's retry.
 */
import { describe, expect, it } from "vitest";

import { codeOf, makeAcceptanceWorld } from "./acceptance-helpers.js";
import { issueDirective } from "./execution-protocol-helpers.js";
import { freshWorkerSession } from "./execution-worker-helpers.js";
import { startWorkerAttemptAndPrepareLaunchInTx } from "../src/application/worker-runtime-service.js";
import { claimWorkerInvocationInTx, getWorkerInvocationInTx } from "../src/store/worker-invocations.js";
import { listRunAttemptsInTx } from "../src/store/execution-attempts.js";
import { explicitExecutionTakeover, supervisorCallAs } from "./session-recovery-helpers.js";

async function preparedWorld(sessionId = "S1") {
  const world = await makeAcceptanceWorld(sessionId);
  const directive = issueDirective(world, { directiveId: "DIR-RACE", kind: "implementation" });
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
  return { world, attemptId: attempt.attemptId, launchToken: launch.launchToken };
}

describe("E12 claim/takeover race (§39)", () => {
  it("E12-T49: claim commits FIRST — the claimed Worker survives the takeover", async () => {
    const { world, attemptId, launchToken } = await preparedWorld();
    const session = freshWorkerSession(world, "WIN");
    world.ctx.store.withWrite((tx) =>
      claimWorkerInvocationInTx(
        tx,
        {
          attemptId,
          launchToken,
          workerSessionId: session.sessionId,
          workerAgentId: session.agentId,
          workspaceId: world.f.workspaceId,
          executionRunId: world.executionRunId,
        },
        world.ctx.clock.nowIso(),
      ),
    );
    const result = explicitExecutionTakeover(world, { newSessionId: "S2", expectedGeneration: 1 });
    // Nothing prepared+unclaimed existed — the revocation sweep is empty — and
    // the claimed invocation is untouched.
    expect(result.supervisor!.revokedLaunchCredentials).toEqual([]);
    expect(world.ctx.store.withRead((tx) => getWorkerInvocationInTx(tx, attemptId))).toMatchObject({
      state: "claimed",
      workerSessionId: session.sessionId,
    });
  });

  it("E12-T50: takeover commits FIRST — the old credential is rejected, no duplicate authority", async () => {
    const { world, attemptId, launchToken } = await preparedWorld();
    explicitExecutionTakeover(world, { newSessionId: "S2", expectedGeneration: 1 });
    const session = freshWorkerSession(world, "LOSE");
    expect(
      codeOf(() =>
        world.ctx.store.withWrite((tx) =>
          claimWorkerInvocationInTx(
            tx,
            {
              attemptId,
              launchToken,
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
    // The Attempt stays prepared/unclaimed under the SAME identity; no
    // attempt was created by the recovery; the new supervisor can re-credential.
    const attempts = world.ctx.store.withRead((tx) => listRunAttemptsInTx(tx, world.executionRunId));
    expect(attempts.filter((a) => a.attemptId === attemptId)).toHaveLength(1);
    expect(world.ctx.store.withRead((tx) => getWorkerInvocationInTx(tx, attemptId))).toMatchObject({
      state: "prepared",
      workerSessionId: null,
    });
    const retried = supervisorCallAs(world, {
      sessionId: "S2",
      generation: 2,
      tool: "retry_unclaimed_worker_launch",
      business: { attempt_id: attemptId },
    }) as { launch_token: string };
    expect(typeof retried.launch_token).toBe("string");
    expect(retried.launch_token).not.toBe(launchToken);
  });
});
