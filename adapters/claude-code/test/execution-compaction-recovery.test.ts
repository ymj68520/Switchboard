/**
 * E12-T24..T28 — compaction (E12 §20–§22/§46/§62): compaction is NOT an
 * ownership change; a same-session compaction is zero-mutation; the recovery
 * capsule is rebuilt from the Store (never from the compact summary); a
 * claimed Worker is unaffected; the unresolved-indeterminate fence survives;
 * and compaction never revokes a prepared worker credential (§40 — the
 * credential fence belongs to a takeover generation change, never to
 * detachment-adjacent conversation mechanics).
 */
import { describe, expect, it } from "vitest";

import { handleSessionStart } from "../src/hooks/handlers.js";
import {
  acceptanceServiceOf,
  acceptInput,
  codeOf,
  makeAcceptanceWorld,
  runVerificationCycle,
  type AcceptanceWorld,
} from "./acceptance-helpers.js";
import { freshWorkerSession, callWorkerTool } from "./execution-worker-helpers.js";
import { makeIndeterminateWorld, makeUnknownLivenessWorld } from "./attempt-recovery-helpers.js";
import { issueDirective } from "./execution-protocol-helpers.js";
import { startWorkerAttemptAndPrepareLaunchInTx } from "../src/application/worker-runtime-service.js";
import { claimWorkerInvocationInTx } from "../src/store/worker-invocations.js";
import {
  depsOf,
  executionFingerprintOf,
  sessionStartInput,
  supervisorEventCountOf,
} from "./session-recovery-helpers.js";

async function compact(world: AcceptanceWorld, sessionId?: string) {
  return handleSessionStart(
    depsOf(world),
    sessionStartInput(world, { sessionId: sessionId ?? world.f.sessionId, source: "compact" }) as never,
  );
}

describe("E12 compaction (§20–§22/§46)", () => {
  it("E12-T24/T25: same-session compaction is zero-mutation — same binding, same generation, no events", async () => {
    const world = await makeAcceptanceWorld("S1");
    const before = executionFingerprintOf(world);
    const eventsBefore = supervisorEventCountOf(world);
    const out = await compact(world);
    expect(executionFingerprintOf(world)).toBe(before);
    expect(supervisorEventCountOf(world)).toBe(eventsBefore);
    // The compact-sourced SessionStart still restores the owner's capsule.
    const context = JSON.stringify(out);
    expect(context).toContain("Execution Recovery Context");
    expect(context).toContain("ownership: current-session");
    expect(context).toContain("session relation: compact");
  });

  it("E12-T26: the recovery capsule reflects the latest acceptedHead/candidate from the Store", async () => {
    const world = await makeAcceptanceWorld("S1");
    runVerificationCycle(world);
    const accept = acceptanceServiceOf(world).submitSupervisorAssessment(acceptInput(world) as never) as {
      commit: { commitId: string } | null;
    };
    expect(accept.commit).not.toBeNull();
    const out = await compact(world);
    const context = JSON.stringify(out);
    expect(context).toContain(`accepted head: ${accept.commit!.commitId}`);
  });

  it("E12-T27: compaction during a running Worker neither affects nor cancels it", async () => {
    const { world, attemptId } = await makeUnknownLivenessWorld();
    const before = executionFingerprintOf(world);
    await compact(world);
    expect(executionFingerprintOf(world)).toBe(before);
    // The claimed worker finishes and submits its durable Report normally —
    // no re-claim needed (the invocation is still bound to its worker session).
    const { sid } = world.ctx.store.withRead(
      (tx) => tx.prepare("SELECT worker_session_id AS sid FROM execution_worker_invocations WHERE attempt_id = ?").get(attemptId) as { sid: string },
    );
    const ack = callWorkerTool(
      world,
      { sessionId: sid, agentId: "agent-live", workspaceId: world.f.workspaceId },
      "worker_submit_report",
      {
      result: "completed",
      candidate_mutated: false,
      actions_performed: [],
      files_examined: ["src/feature.ts"],
      files_changed: [],
      commands_run: [],
      tests_run: [],
      findings: [{ summary: "the work is intact", details: null }],
      deviations: [],
      blockers: [],
      deliverables: [],
      },
    ) as { report_id: string };
    expect(typeof ack.report_id).toBe("string");
    expect(ack.report_id.length).toBeGreaterThan(0);
  });

  it("E12-T28: compaction during reconciliation preserves the unresolved fence", async () => {
    const { world } = await makeIndeterminateWorld();
    await compact(world);
    expect(codeOf(() => issueDirective(world, { directiveId: "DIR-POSTCOMPACT", kind: "implementation" }))).toBe(
      "ATTEMPT_RECONCILIATION_REQUIRED",
    );
  });

  it("E12-T28b: compaction never revokes a prepared-unclaimed worker credential (§40)", async () => {
    const world = await makeAcceptanceWorld("S1");
    const directive = issueDirective(world, { directiveId: "DIR-COMPACT", kind: "inspection" });
    const { launch } = world.ctx.store.withWrite((tx) =>
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
    await compact(world);
    // The prepared credential survives compaction and still claims.
    const session = freshWorkerSession(world, "POSTCOMPACT");
    world.ctx.store.withWrite((tx) =>
      claimWorkerInvocationInTx(
        tx,
        {
          attemptId: launch.attemptId,
          launchToken: launch.launchToken,
          workerSessionId: session.sessionId,
          workerAgentId: "agent-postcompact",
          workspaceId: world.f.workspaceId,
          executionRunId: world.executionRunId,
        },
        world.ctx.clock.nowIso(),
      ),
    );
    const { state } = world.ctx.store.withRead(
      (tx) => tx.prepare("SELECT state FROM execution_worker_invocations WHERE attempt_id = ?").get(launch.attemptId) as { state: string },
    );
    expect(state).toBe("claimed");
  });
});
