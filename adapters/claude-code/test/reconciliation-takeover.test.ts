/**
 * E12-T51..T54 — reconciliation across supervisor takeover (E12 §43/§44/§69):
 * a claimed reconciliation worker survives the ownership change; the new
 * supervisor consumes its completed Report and resolves the indeterminate
 * Attempt under the CURRENT generation; the old supervisor can never resolve;
 * a prepared reconciliation worker follows the SAME token-revocation/retry
 * path — no second recovery protocol.
 */
import { describe, expect, it } from "vitest";

import { codeOf, currentRevision } from "./acceptance-helpers.js";
import {
  effectfulEnvelope,
  FULL_REPORT_CONTRACT,
  makeIndeterminateWorld,
  runReconciliationInspection,
} from "./attempt-recovery-helpers.js";
import { freshWorkerSession } from "./execution-worker-helpers.js";
import { claimWorkerInvocationInTx, getWorkerInvocationInTx } from "../src/store/worker-invocations.js";
import { getReconciliationForAttemptInTx } from "../src/store/attempt-reconciliations.js";
import { explicitExecutionTakeover, supervisorCallAs } from "./session-recovery-helpers.js";

/** Issue the reconciliation Directive + launch (not claim) for the attempt. */
async function issueAndLaunch(world: import("./acceptance-helpers.js").AcceptanceWorld, attemptId: string) {
  const response = supervisorCallAs(world, {
    sessionId: world.f.sessionId,
    generation: world.f.generation,
    tool: "issue_attempt_reconciliation",
    business: {
      attempt_id: attemptId,
      objective: "Establish current repository reality for the interrupted work.",
      body: "Inspect the workspace for partial or complete effects of the interrupted Directive; report factually.",
      capability_envelope: effectfulEnvelope(),
      report_contract: FULL_REPORT_CONTRACT,
    },
  }) as { directive: { id: string; revision: number; hash: string } };
  const { startWorkerAttemptAndPrepareLaunchInTx } = await import("../src/application/worker-runtime-service.js");
  const { launch } = world.ctx.store.withWrite((tx) =>
    startWorkerAttemptAndPrepareLaunchInTx(
      tx,
      {
        executionRunId: world.executionRunId,
        sessionId: world.f.sessionId,
        workspaceId: world.f.workspaceId,
        generation: world.f.generation,
        directiveId: response.directive.id,
        directiveRevision: response.directive.revision,
        directiveHash: response.directive.hash,
        workerRole: "executor",
      },
      world.ctx.clock,
      world.ctx.clock.nowIso(),
    ),
  );
  return { directive: response.directive, launch };
}

describe("E12 reconciliation across takeover (§43/§44)", () => {
  it("E12-T51: a claimed reconciliation worker survives the supervisor takeover", async () => {
    const { world, attemptId } = await makeIndeterminateWorld();
    const { launch } = await issueAndLaunch(world, attemptId);
    const session = freshWorkerSession(world, "RECON");
    world.ctx.store.withWrite((tx) =>
      claimWorkerInvocationInTx(
        tx,
        {
          attemptId: launch.attemptId,
          launchToken: launch.launchToken,
          workerSessionId: session.sessionId,
          workerAgentId: session.agentId,
          workspaceId: world.f.workspaceId,
          executionRunId: world.executionRunId,
        },
        world.ctx.clock.nowIso(),
      ),
    );
    explicitExecutionTakeover(world, { newSessionId: "S2", expectedGeneration: 1 });
    expect(world.ctx.store.withRead((tx) => getWorkerInvocationInTx(tx, launch.attemptId))).toMatchObject({
      state: "claimed",
      workerSessionId: session.sessionId,
    });
  });

  it("E12-T52: the new supervisor consumes the completed reconciliation Report and resolves", async () => {
    const { world, attemptId } = await makeIndeterminateWorld();
    const inspection = runReconciliationInspection(world, { attemptId });
    explicitExecutionTakeover(world, { newSessionId: "S2", expectedGeneration: 1 });
    const resolution = supervisorCallAs(world, {
      sessionId: "S2",
      generation: 2,
      tool: "resolve_indeterminate_attempt",
      business: {
        attempt_id: attemptId,
        resolution: "no_effect",
        inspection_report_id: inspection.reportId,
        rationale: "the interrupted inspection performed no repository effects",
        expected_candidate_revision: currentRevision(world),
      },
    }) as Record<string, unknown>;
    expect(resolution).not.toHaveProperty("error");
    const reconciliation = world.ctx.store.withRead((tx) => getReconciliationForAttemptInTx(tx, attemptId));
    expect(reconciliation?.resolution).toBe("no_effect");
  });

  it("E12-T53: the old supervisor can never resolve after the fence", async () => {
    const { world, attemptId } = await makeIndeterminateWorld();
    const inspection = runReconciliationInspection(world, { attemptId });
    explicitExecutionTakeover(world, { newSessionId: "S2", expectedGeneration: 1 });
    expect(
      codeOf(() =>
        supervisorCallAs(world, {
          sessionId: world.f.sessionId,
          generation: world.f.generation,
          tool: "resolve_indeterminate_attempt",
          business: {
            attempt_id: attemptId,
            resolution: "no_effect",
            inspection_report_id: inspection.reportId,
            rationale: "stale owner attempt",
            expected_candidate_revision: currentRevision(world),
          },
        }),
      ),
    ).toBe("STALE_SUPERVISOR_BINDING");
  });

  it("E12-T54: a prepared reconciliation worker follows the SAME token-revocation/retry path", async () => {
    const { world, attemptId } = await makeIndeterminateWorld();
    const { launch } = await issueAndLaunch(world, attemptId);
    const result = explicitExecutionTakeover(world, { newSessionId: "S2", expectedGeneration: 1 });
    expect(result.supervisor!.revokedLaunchCredentials).toContain(launch.attemptId);
    const stale = freshWorkerSession(world, "STALE-RECON");
    const staleClaim = codeOf(() =>
      world.ctx.store.withWrite((tx) =>
        claimWorkerInvocationInTx(
          tx,
          {
            attemptId: launch.attemptId,
            launchToken: launch.launchToken,
            workerSessionId: stale.sessionId,
            workerAgentId: stale.agentId,
            workspaceId: world.f.workspaceId,
            executionRunId: world.executionRunId,
          },
          world.ctx.clock.nowIso(),
        ),
      ),
    );
    expect(staleClaim).toBe("WORKER_CLAIM_TOKEN_INVALID");
    const retried = supervisorCallAs(world, {
      sessionId: "S2",
      generation: 2,
      tool: "retry_unclaimed_worker_launch",
      business: { attempt_id: launch.attemptId },
    }) as { launch_token: string };
    expect(typeof retried.launch_token).toBe("string");
    expect(retried.launch_token).not.toBe(launch.launchToken);
  });
});
