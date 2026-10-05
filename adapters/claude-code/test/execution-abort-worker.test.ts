/**
 * E13-T19..T33 — Worker authority vs the abort boundary (§26–§33).
 *
 * Prepared-unclaimed: the launch credential dies atomically with the abort —
 * the Attempt row and invocation HISTORY stay exactly as they were, the old
 * token can never claim, and no replacement token exists. Claimed: abort
 * does not block and rewrites nothing; the terminal Run lifecycle fences all
 * FUTURE worker authority (claim gate + authority chain + host-tool guard),
 * and a late Report is rejected. Unknown liveness, unresolved indeterminate
 * Attempts, and in-progress reconciliations never block the human abort, and
 * abort fabricates no Report or reconciliation.
 */
import { describe, expect, it } from "vitest";

import { executePhasePlanTool } from "../src/mcp/tools.js";
import { startWorkerAttemptAndPrepareLaunchInTx } from "../src/application/worker-runtime-service.js";
import { makeAcceptanceWorld, runWorkerAttempt } from "./acceptance-helpers.js";
import { callWorkerTool } from "./execution-worker-helpers.js";
import { issueDirective } from "./execution-protocol-helpers.js";
import { freshWorkerSession } from "./execution-worker-helpers.js";
import { makeIndeterminateWorld, makeUnknownLivenessWorld } from "./attempt-recovery-helpers.js";
import { explicitExecutionAbort, lifecycleOf } from "./session-recovery-helpers.js";
import type { AcceptanceWorld } from "./acceptance-helpers.js";
import type { PreparedWorkerLaunch } from "../src/application/worker-runtime-service.js";

function codeOfSync(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as { code?: string }).code ?? "no-error";
  }
  return "no-error";
}

/** Prepare one fresh implementation launch; return attempt + token facts. */
function prepareLaunch(world: AcceptanceWorld, directiveId: string): { attemptId: string; launch: PreparedWorkerLaunch; hashBefore: string } {
  const directive = issueDirective(world, { directiveId, kind: "implementation" });
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
  const hashBefore = world.ctx.store.withRead(
    (tx) =>
      tx.prepare("SELECT launch_token_hash AS h FROM execution_worker_invocations WHERE attempt_id = ?").get(attempt.attemptId) as { h: string },
  ).h;
  return { attemptId: attempt.attemptId, launch, hashBefore };
}

function invocationRowOf(world: AcceptanceWorld, attemptId: string) {
  return world.ctx.store.withRead(
    (tx) =>
      tx
        .prepare("SELECT state, worker_session_id AS workerSessionId, launch_token_hash AS hash FROM execution_worker_invocations WHERE attempt_id = ?")
        .get(attemptId) as { state: string; workerSessionId: string | null; hash: string },
  );
}

function attemptRowOf(world: AcceptanceWorld, attemptId: string) {
  return world.ctx.store.withRead(
    (tx) => tx.prepare("SELECT state FROM execution_attempts WHERE attempt_id = ?").get(attemptId) as { state: string },
  );
}

describe("E13 prepared worker on abort (§26)", () => {
  it("E13-T19/T21/T22: the credential dies atomically; the Attempt row and invocation history stay; no replacement token", async () => {
    const world = await makeAcceptanceWorld("S1");
    const { attemptId, hashBefore } = prepareLaunch(world, "DIR-E13-PREP");
    const attemptBefore = attemptRowOf(world, attemptId);
    const result = explicitExecutionAbort(world, { reason: "stop" });
    expect(result.revokedLaunchCredentials).toEqual([attemptId]);
    // The invocation row: still 'prepared', never claimed, hash rotated to a
    // dead value (§26 — invalidation, not deletion).
    const invocation = invocationRowOf(world, attemptId);
    expect(invocation.state).toBe("prepared");
    expect(invocation.workerSessionId).toBeNull();
    expect(invocation.hash).not.toBe(hashBefore);
    // The Attempt row is UNCHANGED (§24 — no invented abort state).
    expect(attemptRowOf(world, attemptId)).toEqual(attemptBefore);
    // No replacement token can ever be minted for this attempt (§26 — never
    // return a new token): the store launch gate requires an ACTIVE run.
    const { prepareWorkerLaunchInTx } = await import("../src/application/worker-runtime-service.js");
    expect(
      codeOfSync(() =>
        world.ctx.store.withWrite((tx) => prepareWorkerLaunchInTx(tx, { attemptId }, world.ctx.clock.nowIso())),
      ),
    ).toBe("WORKER_LAUNCH_INVALID");
    // The supervisor retry surface is closed too (the detached binding gate).
    const { executionToken } = await import("./phase14-helpers.js");
    const token = executionToken(world.ctx, {
      sessionId: world.f.sessionId,
      workspaceId: world.f.workspaceId,
      runId: world.executionRunId,
      finalPlanId: world.f.finalPlanId,
      generation: world.f.generation,
      tool: "retry_unclaimed_worker_launch",
      business: { attempt_id: attemptId },
    });
    expect(codeOfSync(() =>
      executePhasePlanTool(world.ctx, "retry_unclaimed_worker_launch", { attempt_id: attemptId, _hostContext: token }),
    )).toBe("SUPERVISOR_BINDING_REQUIRED");
  });

  it("E13-T20: the old token can never claim after abort", async () => {
    const world = await makeAcceptanceWorld("S1");
    const { attemptId, launch } = prepareLaunch(world, "DIR-E13-CLAIM");
    explicitExecutionAbort(world, { reason: "stop" });
    // The §26 rotation denies the old token FIRST (its hash no longer matches
    // the prepared invocation — "old launch token unusable"); the claim-gate
    // run-lifecycle check is the second fence for any non-rotated path.
    expect(
      codeOfSync(() =>
        callWorkerTool(world, freshWorkerSession(world, "LATE"), "worker_claim", {
          attempt_id: attemptId,
          launch_token: launch.launchToken,
        }),
      ),
    ).toBe("WORKER_CLAIM_TOKEN_INVALID");
  });
});

describe("E13 claimed worker on abort (§27/§28)", () => {
  it("E13-T23/T24/T25: a claimed Worker never blocks abort; Attempt + invocation remain historical", async () => {
    const world = await makeAcceptanceWorld("S1");
    const { attemptId, launch } = prepareLaunch(world, "DIR-E13-CLAIMED");
    const session = freshWorkerSession(world, "C1");
    callWorkerTool(world, session, "worker_claim", { attempt_id: attemptId, launch_token: launch.launchToken });
    expect(invocationRowOf(world, attemptId).state).toBe("claimed");
    const result = explicitExecutionAbort(world, { reason: "stop with a live worker" });
    expect(result.executionRun.lifecycle).toBe("aborted");
    expect(result.revokedLaunchCredentials).toEqual([]);
    // Historical state exactly as it was (§27 — no fabricated completion).
    expect(invocationRowOf(world, attemptId)).toMatchObject({ state: "claimed", workerSessionId: session.sessionId });
    expect(attemptRowOf(world, attemptId).state).toBe("running");
  });

  it("E13-T26: the post-abort worker loses its Phase Plan-authorized host tools (capability guard)", async () => {
    const { handlePreToolUse } = await import("../src/hooks/handlers.js");
    const world = await makeAcceptanceWorld("S1");
    const { attemptId, launch } = prepareLaunch(world, "DIR-E13-GUARD");
    const session = freshWorkerSession(world, "G1");
    callWorkerTool(world, session, "worker_claim", { attempt_id: attemptId, launch_token: launch.launchToken });
    explicitExecutionAbort(world, { reason: "stop" });
    // The worker's host-tool guard routes through requireWorkerAuthorityInTx
    // → the terminal lifecycle denies everything (E13 §28).
    const { depsOf } = await import("./session-recovery-helpers.js");
    const out = await handlePreToolUse(
      depsOf(world),
      {
        sessionId: session.sessionId,
        agentId: session.agentId,
        agentType: "phase-plan:execution-worker",
        cwd: world.f.workspaceRoot,
        permissionMode: "default",
        hookEventName: "PreToolUse",
        toolName: "Write",
        toolInput: { file_path: "src/x.ts" },
        toolUseId: "TU-E13-T26",
      } as never,
    );
    expect(JSON.stringify(out)).toContain("deny");
  });

  it("E13-T27/T28: post-abort worker assignment and report submission are denied; no candidateRevision movement", async () => {
    const world = await makeAcceptanceWorld("S1");
    const { attemptId, launch } = prepareLaunch(world, "DIR-E13-LATE");
    const session = freshWorkerSession(world, "L1");
    callWorkerTool(world, session, "worker_claim", { attempt_id: attemptId, launch_token: launch.launchToken });
    const revisionBefore = world.ctx.store.withRead(
      (tx) => tx.prepare("SELECT COALESCE(MAX(candidate_revision), 0) AS r FROM verification_windows WHERE execution_run_id = ?").get(world.executionRunId) as { r: number },
    ).r;
    explicitExecutionAbort(world, { reason: "stop" });
    expect(
      codeOfSync(() => callWorkerTool(world, session, "worker_get_assignment", {})),
    ).toBe("INVALID_EXECUTION_LIFECYCLE");
    expect(
      codeOfSync(() =>
        callWorkerTool(world, session, "worker_submit_report", {
          result: "completed",
          candidate_mutated: true,
          files_changed: ["src/late.ts"],
          actions_performed: [],
          files_examined: [],
          commands_run: [],
          findings: [],
          deviations: [],
          blockers: [],
          deliverables: [],
        }),
      ),
    ).toBe("INVALID_EXECUTION_LIFECYCLE");
    // No candidateRevision movement after the terminal boundary (§48) — the
    // value the run already carried (the impl report's advance) is final.
    const revisionAfter = world.ctx.store.withRead(
      (tx) => tx.prepare("SELECT COALESCE(MAX(candidate_revision), 0) AS r FROM verification_windows WHERE execution_run_id = ?").get(world.executionRunId) as { r: number },
    );
    expect(revisionAfter.r).toBe(revisionBefore);
  });
});

describe("E13 unknown/indeterminate work (§31/§32/§33)", () => {
  it("E13-T29: unknown Worker liveness does not block the human abort", async () => {
    const { world, attemptId } = await makeUnknownLivenessWorld();
    const result = explicitExecutionAbort(world as never, { reason: "user stopped despite live worker" });
    expect(result.executionRun.lifecycle).toBe("aborted");
    expect(attemptRowOf(world as never, attemptId).state).toBe("running");
  });

  it("E13-T30/T32: an unresolved indeterminate Attempt does not block abort and is NOT fabricated into a resolution", async () => {
    const { world, attemptId } = await makeIndeterminateWorld();
    explicitExecutionAbort(world as never, { reason: "user stopped an uncertain run" });
    expect(lifecycleOf(world as never)).toBe("aborted");
    expect(attemptRowOf(world as never, attemptId).state).toBe("indeterminate");
    const reconciliations = world.ctx.store.withRead(
      (tx) => tx.prepare("SELECT count(*) AS n FROM execution_attempt_reconciliations WHERE attempt_id = ?").get(attemptId) as { n: number },
    );
    expect(reconciliations.n).toBe(0);
  });

  it("E13-T31: a reconciliation Directive prepared for launch does not block abort; no result is invented (§33)", async () => {
    const { world, attemptId } = await makeIndeterminateWorld();
    // A reconciliation in progress = the bound inspection Directive issued;
    // the abort proceeds and fabricates no reconciliation result.
    const directives = world.ctx.store.withRead(
      (tx) => tx.prepare("SELECT count(*) AS n FROM execution_directives WHERE run_id = ?").get(world.executionRunId) as { n: number },
    );
    explicitExecutionAbort(world as never, { reason: "stop during reconciliation" });
    expect(lifecycleOf(world as never)).toBe("aborted");
    const after = world.ctx.store.withRead(
      (tx) => tx.prepare("SELECT count(*) AS n FROM execution_directives WHERE run_id = ?").get(world.executionRunId) as { n: number },
    );
    expect(after.n).toBe(directives.n);
    expect(attemptRowOf(world as never, attemptId).state).toBe("indeterminate");
  });

  it("E13-T33: abort fabricates no Report", async () => {
    const world = await makeAcceptanceWorld("S1");
    const reportsBefore = world.ctx.store.withRead(
      (tx) => tx.prepare("SELECT count(*) AS n FROM execution_reports WHERE execution_run_id = ?").get(world.executionRunId) as { n: number },
    );
    explicitExecutionAbort(world, { reason: "stop" });
    const reportsAfter = world.ctx.store.withRead(
      (tx) => tx.prepare("SELECT count(*) AS n FROM execution_reports WHERE execution_run_id = ?").get(world.executionRunId) as { n: number },
    );
    expect(reportsAfter.n).toBe(reportsBefore.n);
  });
});

describe("E13 report race (§30/§48)", () => {
  it("E13-T34: the Report that commits first stays durable — abort preserves it", async () => {
    const world = await makeAcceptanceWorld("S1");
    const { attemptId, launch } = prepareLaunch(world, "DIR-E13-RACE-R");
    const reportId = runWorkerAttempt({ ...world, launch, attemptId }, freshWorkerSession(world, "RR"));
    expect(reportId).toBeTruthy();
    explicitExecutionAbort(world, { reason: "stop after report" });
    const report = world.ctx.store.withRead(
      (tx) => tx.prepare("SELECT report_id AS id FROM execution_reports WHERE report_id = ?").get(reportId) as { id: string },
    );
    expect(report.id).toBe(reportId);
  });

  it("E13-T35: the abort that commits first rejects the late Report", async () => {
    const world = await makeAcceptanceWorld("S1");
    const { attemptId, launch } = prepareLaunch(world, "DIR-E13-RACE-A");
    const session = freshWorkerSession(world, "RA");
    callWorkerTool(world, session, "worker_claim", { attempt_id: attemptId, launch_token: launch.launchToken });
    explicitExecutionAbort(world, { reason: "stop before report" });
    expect(
      codeOfSync(() =>
        callWorkerTool(world, session, "worker_submit_report", {
          result: "completed",
          candidate_mutated: true,
          files_changed: ["src/late.ts"],
          actions_performed: [],
          files_examined: [],
          commands_run: [],
          findings: [],
          deviations: [],
          blockers: [],
          deliverables: [],
        }),
      ),
    ).toBe("INVALID_EXECUTION_LIFECYCLE");
  });
});
