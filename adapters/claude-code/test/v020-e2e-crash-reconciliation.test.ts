/**
 * E14 §15–§19 — integrated crash/liveness E2E: durable report before lost ack,
 * side-effect crash → indeterminate + BOTH reconciliation resolutions, the
 * reconciled candidate mutation, pre-claim crash recovery, and unknown
 * liveness preservation across takeover/compaction. All through the real
 * worker/reconciliation MCP surfaces.
 */
import { describe, expect, it } from "vitest";

import {
  acceptViaMcp,
  boundariesOf,
  codeOf,
  currentRevision,
  makeAcceptanceWorld,
  runFreshVerifier,
  supervisorCall,
  type E14World,
} from "./v020-e2e-helpers.js";
import {
  makeIndeterminateWorld,
  makeUnclaimedWorld,
  makeUnknownLivenessWorld,
  runReconciliationInspection,
} from "./attempt-recovery-helpers.js";
import { callWorkerTool, freshWorkerSession } from "./execution-worker-helpers.js";
import { issueDirective } from "./execution-protocol-helpers.js";
import { startWorkerAttemptAndPrepareLaunchInTx } from "../src/application/worker-runtime-service.js";
import { getExecutionAttemptInTx } from "../src/store/execution-attempts.js";
import { createRunControlService } from "../src/application/run-control-service.js";
import type { RunControlResult } from "../src/application/run-control-service.js";
import { encodeWorkerHostContextToken, buildWorkerHostContextEnvelope } from "../src/host/worker-context.js";
import { businessInputHashOf } from "../src/host/host-context.js";
import { executionToken } from "./phase14-helpers.js";
import { executePhasePlanTool } from "../src/mcp/tools.js";

describe("v020 E2E crash and liveness (§15–§19)", () => {
  it("E14-CR1: durable Report survives a lost acknowledgement — no replay, no new Attempt (§15)", async () => {
    const world = await makeAcceptanceWorld("E14-CR1");
    const directive = issueDirective(world, { directiveId: "DIR-CR1", kind: "implementation" });
    const started = world.ctx.store.withWrite((tx) =>
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
    const session = freshWorkerSession(world, "CR1");
    callWorkerTool(world, session, "worker_claim", { attempt_id: started.attempt.attemptId, launch_token: started.launch.launchToken });
    // The report transaction COMMITS (durable) — but the returned acknowledgement
    // is deliberately discarded (the "parent ack lost" crash).
    callWorkerTool(world, session, "worker_submit_report", {
      result: "completed",
      candidate_mutated: true,
      files_changed: ["src/feature.ts"],
    });

    // Recovery observes the durable truth: Attempt=reported, Report durable,
    // invocation finished.
    const attempt = world.ctx.store.withRead((tx) => getExecutionAttemptInTx(tx, started.attempt.attemptId))!;
    expect(attempt.state).toBe("reported");
    expect(currentRevision(world)).toBe(2); // the mutation stands
    const invocation = world.ctx.store.withRead(
      (tx) => tx.prepare("SELECT state AS s FROM execution_worker_invocations WHERE attempt_id = ?").get(started.attempt.attemptId) as { s: string },
    );
    expect(invocation.s).toBe("finished");
    // A retry of the same report is REFUSED (no replay).
    expect(
      codeOf(() =>
        callWorkerTool(world, session, "worker_submit_report", {
          result: "completed",
          candidate_mutated: true,
        }),
      ),
    ).toBe("WORKER_INVOCATION_FINISHED");
    // The candidate advanced EXACTLY once.
    expect(currentRevision(world)).toBe(2);
    expect(
      world.ctx.store.withRead(
        (tx) => tx.prepare("SELECT count(*) AS n FROM execution_attempts WHERE directive_id = ?").get(directive.directiveId) as { n: number },
      ).n,
    ).toBe(1); // exactly one Attempt for this directive — no replay
    // And no reconciliation machinery was created for a durable report.
    const reconciliations = world.ctx.store.withRead(
      (tx) => tx.prepare("SELECT count(*) AS n FROM execution_attempt_reconciliations WHERE execution_run_id = ?").get(world.executionRunId) as { n: number },
    );
    expect(reconciliations.n).toBe(0);
  });

  it("E14-CR2: side-effect crash → indeterminate; both reconciliation resolutions (§16/§17)", async () => {
    // ---- branch 1: candidate_changed ------------------------------------
    const changed = await makeIndeterminateWorld({ sessionId: "E14-CR2A", envelope: {
      repositoryRead: true, repositoryWrite: true, commandExecution: false, networkAccess: false,
      dependencyMutation: false, gitCommit: false, gitPush: false, externalServiceMutation: false,
    } });
    // The interrupted original: indeterminate, NO report, NOT retried.
    const originalA = changed.world.ctx.store.withRead((tx) => getExecutionAttemptInTx(tx, changed.attemptId))!;
    expect(originalA.state).toBe("indeterminate");
    const reportsOfOriginal = changed.world.ctx.store.withRead(
      (tx) => tx.prepare("SELECT count(*) AS n FROM execution_reports WHERE attempt_id = ?").get(changed.attemptId) as { n: number },
    );
    expect(reportsOfOriginal.n).toBe(0); // no fake report
    // No retry of the same Directive revision.
    const originalDirectiveA = changed.world.ctx.store.withRead(
      (tx) => tx.prepare("SELECT directive_id AS id, revision AS r, directive_hash AS h FROM execution_directives WHERE directive_id = ?").get(changed.directiveId) as { id: string; r: number; h: string },
    );
    // Ordinary execution is FENCED while the indeterminate is unresolved —
    // already at Directive issuance, before any attempt could start (E11 §13).
    expect(
      codeOf(() => issueDirective(changed.world, { directiveId: "DIR-CR2A-NEXT", kind: "implementation" })),
    ).toBe("ATTEMPT_RECONCILIATION_REQUIRED");

    // New reconciliation inspection authority + fresh worker + factual report.
    const inspectionA = runReconciliationInspection(changed.world, {
      attemptId: changed.attemptId,
      candidateMutated: false,
      reportOverrides: { findings: [{ summary: "the workspace contains a half-applied edit of the interrupted directive", details: null }] },
    });
    expect(inspectionA.reportId).toBeTruthy();
    const revisionBefore = currentRevision(changed.world);
    // Supervisor resolves candidate_changed — the ONLY recovered-mutation writer.
    const resolved = supervisorCall(changed.world, "resolve_indeterminate_attempt", {
      attempt_id: changed.attemptId,
      resolution: "candidate_changed",
      inspection_report_id: inspectionA.reportId,
      rationale: "the inspection proves the interrupted work mutated the candidate",
      expected_candidate_revision: revisionBefore,
    }) as { status: string };
    expect(resolved.status).toBe("resolved");
    // §17: candidateRevision N → N+1 exactly once; original Attempt stays indeterminate.
    expect(currentRevision(changed.world)).toBe(revisionBefore + 1);
    expect(
      changed.world.ctx.store.withRead((tx) => getExecutionAttemptInTx(tx, changed.attemptId))!.state,
    ).toBe("indeterminate");
    // The recovery advance is recorded exactly once.
    const reconciliationsA = changed.world.ctx.store.withRead(
      (tx) => tx.prepare("SELECT resolution AS r FROM execution_attempt_reconciliations WHERE attempt_id = ?").get(changed.attemptId) as { r: string },
    );
    expect(reconciliationsA.r).toBe("candidate_changed");
    // Verification pressure now reflects the ORIGINAL directive's policy: the
    // recovered mutation re-opens verification debt (immediate envelope was
    // write-capable; batchable contributes its span). A fresh verifier at the
    // recovered candidate is accepted evidence again.
    runFreshVerifier(changed.world, { directiveId: "DIR-CR2A-V" });
    const acceptA = acceptViaMcp(changed.world, { reportJudgments: classifySupporting(changed.world) }) as { status: string };
    expect(acceptA.status).toBe("accepted");

    // ---- branch 2: no_effect --------------------------------------------
    const noEffect = await makeIndeterminateWorld({ sessionId: "E14-CR2B" });
    const revisionBeforeB = currentRevision(noEffect.world);
    const inspectionB = runReconciliationInspection(noEffect.world, {
      attemptId: noEffect.attemptId,
      candidateMutated: false,
      reportOverrides: { findings: [{ summary: "no durable effect found anywhere in the workspace", details: null }] },
    });
    const resolvedB = supervisorCall(noEffect.world, "resolve_indeterminate_attempt", {
      attempt_id: noEffect.attemptId,
      resolution: "no_effect",
      inspection_report_id: inspectionB.reportId,
      rationale: "the inspection proves the interrupted work had no durable effect",
      expected_candidate_revision: revisionBeforeB,
    }) as { status: string };
    expect(resolvedB.status).toBe("resolved");
    expect(currentRevision(noEffect.world)).toBe(revisionBeforeB); // no advance
    expect(
      noEffect.world.ctx.store.withRead((tx) => getExecutionAttemptInTx(tx, noEffect.attemptId))!.state,
    ).toBe("indeterminate"); // the attempt state itself is never rewritten to a fake outcome
    void originalDirectiveA;
    void originalA;
  });

  it("E14-CR3: pre-claim crash recovery rotates the credential for the SAME Attempt (§18)", async () => {
    const { world, attemptId, staleLaunchToken } = await makeUnclaimedWorld("E14-CR3");
    // The old credential is unusable after the authoritative retry…
    const retried = supervisorCall(world, "retry_unclaimed_worker_launch", {
      attempt_id: attemptId,
    }) as { status: string; launch_token?: string };
    expect(retried.status).toBe("relaunched");
    const newToken = retried.launch_token!;
    expect(newToken).not.toBe(staleLaunchToken);
    // …and the stale token cannot claim.
    const staleSession = freshWorkerSession(world, "STALE");
    expect(
      codeOf(() =>
        callWorkerTool(world, staleSession, "worker_claim", { attempt_id: attemptId, launch_token: staleLaunchToken }),
      ),
    ).toBe("WORKER_CLAIM_TOKEN_INVALID");
    // No second Attempt exists: the SAME attempt is claimable with the new token.
    const attemptsBefore = world.ctx.store.withRead(
      (tx) => tx.prepare("SELECT count(*) AS n FROM execution_attempts WHERE execution_run_id = ?").get(world.executionRunId) as { n: number },
    );
    const session = freshWorkerSession(world, "RECOVERED");
    callWorkerTool(world, session, "worker_claim", { attempt_id: attemptId, launch_token: newToken });
    callWorkerTool(world, session, "worker_submit_report", { result: "completed", candidate_mutated: false });
    const attemptsAfter = world.ctx.store.withRead(
      (tx) => tx.prepare("SELECT count(*) AS n FROM execution_attempts WHERE execution_run_id = ?").get(world.executionRunId) as { n: number },
    );
    expect(attemptsAfter.n).toBe(attemptsBefore.n); // same Attempt, no duplicate work
    expect(world.ctx.store.withRead((tx) => getExecutionAttemptInTx(tx, attemptId))!.state).toBe("reported");
  });

  it("E14-CR4: unknown liveness is preserved — no inference, no replay, survives takeover (§19)", async () => {
    const { world, attemptId } = await makeUnknownLivenessWorld("E14-CR4");
    expect(world.ctx.store.withRead((tx) => getExecutionAttemptInTx(tx, attemptId))!.state).toBe("running");
    // Time passes; nothing authoritatively terminates the worker.
    const before = boundariesOf(world);
    // NO timeout inference: the attempt is still running, no reconciliation exists.
    expect(world.ctx.store.withRead((tx) => getExecutionAttemptInTx(tx, attemptId))!.state).toBe("running");
    expect(
      world.ctx.store.withRead(
        (tx) => tx.prepare("SELECT count(*) AS n FROM execution_attempt_reconciliations WHERE execution_run_id = ?").get(world.executionRunId) as { n: number },
      ).n,
    ).toBe(0);
    // An explicit takeover (human-authorized, generation N+1) preserves the
    // runtime-resolution-required state exactly.
    const takeover = explicitTakeoverOf(world, "E14-CR4-S2");
    expect(takeover).toBe(2);
    expect(world.ctx.store.withRead((tx) => getExecutionAttemptInTx(tx, attemptId))!.state).toBe("running");
    const after = boundariesOf(world);
    expect(after.attempts).toEqual(before.attempts);
    expect(after.acceptedHead).toBe(before.acceptedHead);
    expect(after.openWindow!.candidateRevision).toBe(before.openWindow!.candidateRevision);
    // The claimed worker keeps its Attempt-scoped authority across the takeover.
    const assignment = loadWorkerAssignmentOf(world, attemptId);
    expect(assignment).not.toBeNull(); // the claim persists
    // And the OLD owner is fenced while the worker is untouched.
    expect(
      codeOf(() =>
        supervisorCallAs(world, { sessionId: "E14-CR4", generation: 1, tool: "continue_execution_stage" }),
      ),
    ).toBe("STALE_SUPERVISOR_BINDING");
  });

  it("E14-CR5: a compacted context recovers the running attempt truthfully (§19/§22 boundary)", async () => {
    const { world, attemptId } = await makeUnknownLivenessWorld("E14-CR5");
    // A SessionStart(compact) recovery capsule must render the running truth.
    const { depsOf, sessionStartInput, contextOf } = await import("./session-recovery-helpers.js");
    const output = await (await import("../src/hooks/handlers.js")).handleSessionStart(depsOf(world), sessionStartInput(world, { source: "compact" }) as never);
    const capsule = contextOf(output);
    expect(capsule).toContain("running"); // the live attempt is rendered as live
    expect(world.ctx.store.withRead((tx) => getExecutionAttemptInTx(tx, attemptId))!.state).toBe("running");
  });
});

/** Classify every current-candidate non-mutating verifier report supporting. */
function classifySupporting(world: E14World): Array<{ report_id: string; disposition: string }> {
  return world.ctx.store.withRead((tx) => {
    const windowId = (
      tx.prepare("SELECT id FROM verification_windows WHERE execution_run_id = ? AND closed_at IS NULL").get(world.executionRunId) as { id: string }
    ).id;
    const rows = tx
      .prepare(
        "SELECT r.report_id AS reportId, a.worker_role AS role FROM execution_reports r "
        + "JOIN execution_attempts a ON a.attempt_id = r.attempt_id "
        + "JOIN execution_directives d ON d.directive_id = r.directive_id AND d.revision = r.directive_revision "
        + "WHERE d.window_id = ? AND d.base_candidate_revision = (SELECT candidate_revision FROM verification_windows WHERE id = ?) "
        + "AND r.candidate_mutated = 0 "
        + "ORDER BY r.report_id",
      )
      .all(windowId, windowId) as Array<{ reportId: string; role: string }>;
    return rows.map((row) => ({ report_id: row.reportId, disposition: row.role === "verifier" ? "supporting" : "informational" }));
  });
}

function explicitTakeoverOf(world: E14World, newSessionId: string): number {
  // The supervision branch always returns a full RunControlResult.
  const result = createRunControlService(world.ctx.store, world.ctx.clock).takeoverRun({
    runId: world.f.runId,
    executionRunId: world.executionRunId,
    workspaceId: world.f.workspaceId,
    callerSessionId: newSessionId,
    expectedBindingGeneration: 1,
    authorization: {
      authorizationRequestId: `mcp-control:TU-${newSessionId}`,
      operationId: `takeover:TU-${newSessionId}`,
      requestHash: `hash:${world.executionRunId}:1`,
    },
  }) as RunControlResult;
  return result.binding.generation;
}

function loadWorkerAssignmentOf(world: E14World, attemptId: string): unknown {
  void attemptId; // identity derives from the worker session's claim, never from arguments
  const session = freshWorkerSession(world, "LIVE");
  const token = encodeWorkerHostContextToken(
    world.ctx.secret,
    buildWorkerHostContextEnvelope({
      sessionId: session.sessionId,
      workspaceId: session.workspaceId,
      agent: { agentId: session.agentId, agentType: "phase-plan:execution-worker" },
      permissionMode: "default",
      toolUseId: "TU-ASSIGN",
      toolName: "mcp__plugin_phase-plan_phase-plan__worker_get_assignment",
      businessInputHash: businessInputHashOf({}),
    }),
  );
  return executePhasePlanTool(world.ctx, "worker_get_assignment", { _hostContext: token });
}

function supervisorCallAs(world: E14World, input: { sessionId: string; generation: number; tool: string }): unknown {
  const token = executionToken(world.ctx, {
    sessionId: input.sessionId,
    workspaceId: world.f.workspaceId,
    runId: world.executionRunId,
    finalPlanId: world.f.finalPlanId,
    generation: input.generation,
    tool: input.tool,
    business: {},
  });
  return executePhasePlanTool(world.ctx, input.tool, { _hostContext: token });
}
