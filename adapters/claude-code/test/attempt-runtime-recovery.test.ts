/**
 * E11 §56–§58 — crash-boundary classification (T1..T10): unclaimed retry,
 * token rotation, no-second-Attempt, durable-report-wins, authoritative stop,
 * unknown liveness, no timeout fiction, no replay under uncertainty.
 */
import { describe, expect, it } from "vitest";

import {
  makeIndeterminateWorld,
  makeUnclaimedWorld,
  makeUnknownLivenessWorld,
  supervisorCall,
} from "./attempt-recovery-helpers.js";
import { codeOf, currentRevision } from "./acceptance-helpers.js";
import { freshWorkerSession, callWorkerTool } from "./execution-worker-helpers.js";
import { classifyAttemptRecoveryInTx } from "../src/application/attempt-recovery-service.js";
import { claimWorkerInvocationInTx, hashLaunchToken, getWorkerInvocationInTx } from "../src/store/worker-invocations.js";
import { getExecutionAttemptInTx } from "../src/store/execution-attempts.js";

describe("E11 crash boundaries A/B — unclaimed + reported (§40/§39)", () => {
  it("E11-T1: a prepared-unclaimed attempt classifies safe_unclaimed_retry", async () => {
    const { world, attemptId } = await makeUnclaimedWorld();
    const fact = world.ctx.store.withRead((tx) => classifyAttemptRecoveryInTx(tx, getExecutionAttemptInTx(tx, attemptId)!));
    expect(fact.logicalState).toBe("running");
    expect(fact.runtimeState).toBe("prepared-unclaimed");
    expect(fact.unclaimedRetryAvailable).toBe(true);
    expect(fact.reconciliation).toBe("not-required");
  });

  it("E11-T2: the relaunch keeps the SAME attempt id, directive revision, and invocation binding", async () => {
    const { world, attemptId } = await makeUnclaimedWorld();
    const attemptBefore = world.ctx.store.withRead((tx) => getExecutionAttemptInTx(tx, attemptId)!);
    const bindingBefore = world.ctx.store.withRead((tx) => getWorkerInvocationInTx(tx, attemptId)!);
    const retried = supervisorCall(world, "retry_unclaimed_worker_launch", { attempt_id: attemptId }) as {
      status: string;
      attempt_id: string;
      launch_token: string;
    };
    expect(retried.status).toBe("relaunched");
    expect(retried.attempt_id).toBe(attemptId);
    const attemptAfter = world.ctx.store.withRead((tx) => getExecutionAttemptInTx(tx, attemptId)!);
    const bindingAfter = world.ctx.store.withRead((tx) => getWorkerInvocationInTx(tx, attemptId)!);
    expect(attemptAfter.attemptId).toBe(attemptBefore.attemptId);
    expect(attemptAfter.directiveRevision).toBe(attemptBefore.directiveRevision);
    expect(bindingAfter.attemptId).toBe(bindingBefore.attemptId);
    expect(retried.launch_token).not.toBe("");
    // The new token claims the SAME binding.
    const session = freshWorkerSession(world, "RETRY");
    world.ctx.store.withWrite((tx) => {
      claimWorkerInvocationInTx(
        tx,
        {
          attemptId,
          launchToken: retried.launch_token as string,
          workerSessionId: session.sessionId,
          workerAgentId: "agent-retry",
          workspaceId: world.f.workspaceId,
          executionRunId: world.executionRunId,
        },
        world.ctx.clock.nowIso(),
      );
    });
    expect(world.ctx.store.withRead((tx) => getWorkerInvocationInTx(tx, attemptId))!.state).toBe("claimed");
  });

  it("E11-T3: the OLD launch token is invalid after rotation", async () => {
    const { world, attemptId, staleLaunchToken } = await makeUnclaimedWorld();
    const retried = supervisorCall(world, "retry_unclaimed_worker_launch", { attempt_id: attemptId }) as { launch_token: string };
    expect(retried.launch_token).not.toBe(staleLaunchToken);
    const session = freshWorkerSession(world, "STALE");
    expect(
      codeOf(() =>
        world.ctx.store.withWrite((tx) => {
          claimWorkerInvocationInTx(
            tx,
            {
              attemptId,
              launchToken: staleLaunchToken,
              workerSessionId: session.sessionId,
              workerAgentId: "agent-stale",
              workspaceId: world.f.workspaceId,
              executionRunId: world.executionRunId,
            },
            world.ctx.clock.nowIso(),
          );
        }),
      ),
    ).toBe("WORKER_CLAIM_TOKEN_INVALID");
    // The rotated hash is the persisted one.
    const binding = world.ctx.store.withRead((tx) => getWorkerInvocationInTx(tx, attemptId)!);
    expect(binding.launchTokenHash).toBe(hashLaunchToken(retried.launch_token as string));
  });

  it("E11-T4: retry NEVER creates a second Attempt (one binding per attempt, DDL-enforced)", async () => {
    const { world, attemptId } = await makeUnclaimedWorld();
    supervisorCall(world, "retry_unclaimed_worker_launch", { attempt_id: attemptId });
    const attempts = world.ctx.store.withRead(
      (tx) => tx.prepare("SELECT count(*) AS n FROM execution_attempts WHERE directive_id = 'DIR-UA'").get() as { n: number },
    );
    expect(attempts.n).toBe(1);
    const bindings = world.ctx.store.withRead(
      (tx) => tx.prepare("SELECT count(*) AS n FROM execution_worker_invocations WHERE attempt_id = ?").get(attemptId) as { n: number },
    );
    expect(bindings.n).toBe(1);
    // A CLAIMED invocation refuses retry outright.
    const session = freshWorkerSession(world, "CLAIMED");
    const rotated = supervisorCall(world, "retry_unclaimed_worker_launch", { attempt_id: attemptId }) as {
      launch_token: string;
    };
    world.ctx.store.withWrite((tx) => {
      claimWorkerInvocationInTx(
        tx,
        {
          attemptId,
          launchToken: rotated.launch_token as string,
          workerSessionId: session.sessionId,
          workerAgentId: "agent-t4",
          workspaceId: world.f.workspaceId,
          executionRunId: world.executionRunId,
        },
        world.ctx.clock.nowIso(),
      );
    });
    expect(codeOf(() => supervisorCall(world, "retry_unclaimed_worker_launch", { attempt_id: attemptId }))).toBe(
      "WORKER_LAUNCH_RETRY_NOT_ALLOWED",
    );
  });

  it("E11-T5/T6: a durable Report wins — reported+finished is stable; the lost-ack state is durably impossible", async () => {
    const { world, attemptId, staleLaunchToken } = await makeUnclaimedWorld();
    // Complete the attempt NORMALLY with the original token (claim + report).
    const session = freshWorkerSession(world, "NORMAL");
    callWorkerTool(world, session, "worker_claim", {
      attempt_id: attemptId,
      launch_token: staleLaunchToken,
    });
    callWorkerTool(world, session, "worker_submit_report", {
      result: "completed",
      candidate_mutated: true,
      actions_performed: [],
      files_examined: [],
      files_changed: [],
      commands_run: [],
      tests_run: [],
      findings: [],
      deviations: [],
      blockers: [],
      deliverables: [],
    });
    const revisionAfterReport = currentRevision(world);
    // The lost-acknowledgement world (Report durable, runtime still claimed)
    // is DURABLY IMPOSSIBLE: the report+finish step is one transaction, and
    // the finished-terminal trigger refuses any revival of the runtime state.
    expect(
      (() => {
        try {
          world.ctx.store.withWrite((tx) => {
            tx.prepare("UPDATE execution_worker_invocations SET state = 'claimed', finished_at = NULL WHERE attempt_id = ?").run(attemptId);
          });
          return "no-error";
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }
      })(),
    ).toContain("a finished invocation is terminal");
    // The truth: the attempt is REPORTED, exactly one attempt, one report, no
    // reconciliation, no replay, one candidate advance.
    const attempt = world.ctx.store.withRead((tx) => getExecutionAttemptInTx(tx, attemptId)!);
    expect(attempt.state).toBe("reported");
    expect(world.ctx.store.withRead((tx) => tx.prepare("SELECT count(*) AS n FROM execution_attempts WHERE directive_id = 'DIR-UA'").get())).toEqual({ n: 1 });
    expect(world.ctx.store.withRead((tx) => tx.prepare("SELECT count(*) AS n FROM execution_attempt_reconciliations").get())).toEqual({ n: 0 });
    expect(world.ctx.store.withRead((tx) => tx.prepare("SELECT count(*) AS n FROM execution_reports WHERE attempt_id = ?").get(attemptId))).toEqual({ n: 1 });
    expect(currentRevision(world)).toBe(revisionAfterReport);
    void classifyAttemptRecoveryInTx;
  });
});

describe("E11 crash boundaries C/D — worker loss (§42/§43/§44)", () => {
  it("E11-T7: claimed + no report + authoritative stop → indeterminate", async () => {
    const { world, attemptId } = await makeIndeterminateWorld();
    const attempt = world.ctx.store.withRead((tx) => getExecutionAttemptInTx(tx, attemptId)!);
    expect(attempt.state).toBe("indeterminate");
    const fact = world.ctx.store.withRead((tx) => classifyAttemptRecoveryInTx(tx, attempt));
    expect(fact.runtimeState).toBe("authoritative-stop");
    expect(fact.reconciliation).toBe("required");
    // No Report was fabricated (E11 §5).
    expect(world.ctx.store.withRead((tx) => tx.prepare("SELECT count(*) AS n FROM execution_reports WHERE attempt_id = ?").get(attemptId))).toEqual({ n: 0 });
  });

  it("E11-T8: claimed + no report + NO stop proof stays running (liveness-unknown)", async () => {
    const { world, attemptId } = await makeUnknownLivenessWorld();
    const attempt = world.ctx.store.withRead((tx) => getExecutionAttemptInTx(tx, attemptId)!);
    expect(attempt.state).toBe("running");
    const fact = world.ctx.store.withRead((tx) => classifyAttemptRecoveryInTx(tx, attempt));
    expect(fact.runtimeState).toBe("claimed");
    expect(fact.reconciliation).toBe("not-required");
  });

  it("E11-T9: elapsed time alone never alters state (no timeout fiction)", async () => {
    const { world, attemptId } = await makeUnknownLivenessWorld();
    // No Store path ages a running Attempt into indeterminate, and backdating
    // is refused outright (the attempts identity trigger). The recovery
    // runtime contains NO time-based liveness heuristic (static proof below).
    expect(
      (() => {
        try {
          world.ctx.store.withWrite((tx) => {
            tx.prepare("UPDATE execution_attempts SET started_at = '2020-01-01T00:00:00.000Z' WHERE attempt_id = ?").run(attemptId);
          });
          return "no-error";
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }
      })(),
    ).toContain("execution attempt identity is immutable");
    expect(world.ctx.store.withRead((tx) => getExecutionAttemptInTx(tx, attemptId))!.state).toBe("running");
    const fs = await import("node:fs");
    const path = await import("node:path");
    for (const module of ["attempt-recovery-service.ts", "worker-runtime-service.ts"]) {
      const moduleText = fs.readFileSync(path.resolve(__dirname, "../src/application", module), "utf8");
      expect(moduleText).not.toMatch(/setTimeout|elapsedMs|timeoutMs|heartbeat/);
    }
  });

  it("E11-T10: the SAME directive revision can never relaunch while its attempt is uncertain (fence fires first)", async () => {
    const { world, attemptId, directiveId } = await makeIndeterminateWorld();
    // Start of a NEW attempt on the SAME revision is fenced (§13/§14).
    expect(
      codeOf(() =>
        supervisorCall(world, "start_worker_attempt", {
          directive_id: directiveId,
          directive_revision: 1,
          directive_hash: world.ctx.store.withRead(
            (tx) => (tx.prepare("SELECT directive_hash AS h FROM execution_attempts WHERE attempt_id = ?").get(attemptId) as { h: string }).h,
          ),
          worker_role: "executor",
        }),
      ),
    ).toBe("ATTEMPT_RECONCILIATION_REQUIRED");
    // And the E4 one-attempt-per-revision uniqueness still stands underneath.
    expect(
      world.ctx.store.withRead(
        (tx) => tx.prepare("SELECT count(*) AS n FROM execution_attempts WHERE directive_id = ? AND directive_revision = 1").get(directiveId),
      ),
    ).toEqual({ n: 1 });
  });
});
