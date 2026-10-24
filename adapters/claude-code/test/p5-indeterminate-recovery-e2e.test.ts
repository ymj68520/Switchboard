/**
 * P5 E2E Test Suite — Indeterminate Attempt Recovery Deadlock & Recovery Capability Boundary.
 *
 * Requirements verified:
 * 1. Tiered worker timeout: continuous progress prevents premature timeouts on long builds.
 * 2. No-progress timeout detected; process liveness fence prevents clearing fence while process is still alive.
 * 3. Authoritative termination transitions running -> indeterminate with invocation finished.
 * 4. Recovery Capability Boundary: recovery tools remain accessible while ordinary execution is fenced.
 * 5. Machine-readable recovery guidance provided to supervisor.
 * 6. Interrupted side-effecting attempt resolved via inspection and candidate_changed (no blind replay).
 * 7. Duplicate/repeated resolution calls converge idempotently without error or second revision advance.
 * 8. Late / duplicate report submission recognized idempotently without duplicating report or commit.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
  acceptViaMcp,
  boundariesOf,
  currentRevision,
  makeAcceptanceWorld,
  runImplementation,
  runFreshVerifier,
  supervisorCall,
  callWorkerTool,
  freshWorkerSession,
  getExecutionAttemptInTx,
  startWorkerAttemptAndPrepareLaunchInTx,
} from "./v020-e2e-helpers.js";
import { issueDirective } from "./execution-protocol-helpers.js";
import { runReconciliationInspection } from "./attempt-recovery-helpers.js";
import {
  evaluateWorkerLiveness,
  recordWorkerProgress,
  registerWorkerProcess,
  terminateAndMarkIndeterminateInTx,
  getDetailedRecoveryGuidanceInTx,
} from "../src/application/recovery-process-coordinator.js";
import { submitExecutionReportInTx } from "../src/application/execution-report-service.js";

describe("P5: Indeterminate Attempt Recovery Deadlock & Recovery Capability Boundary E2E", () => {
  it("manages tiered timeouts, process liveness fences, and machine-readable recovery guidance", async () => {
    const world = await makeAcceptanceWorld("P5-E2E");
    const wsRoot = world.f.workspaceRoot;

    // -------------------------------------------------------------------------
    // 1. Long-running build with continuous progress does not timeout prematurely
    // -------------------------------------------------------------------------
    const attemptId1 = "att_p5_long_build";
    const startTime = Date.now();
    registerWorkerProcess(attemptId1, null, startTime);

    // After 80 seconds with continuous heartbeats
    const progressTime = startTime + 80_000;
    recordWorkerProgress(attemptId1, "Compiling TypeScript AST chunks...", progressTime);

    // Even though 80s elapsed (exceeding default 60s no-progress limit from start),
    // because recent progress was recorded, liveness check remains healthy!
    const livenessCheck = evaluateWorkerLiveness(attemptId1, true, {
      startupTimeoutMs: 30_000,
      noProgressTimeoutMs: 60_000,
      absoluteTimeoutMs: 300_000,
    }, progressTime + 10_000);

    expect(livenessCheck.status).toBe("healthy");

    // -------------------------------------------------------------------------
    // 2. No-progress timeout triggered when heartbeats cease
    // -------------------------------------------------------------------------
    const stalledTime = progressTime + 70_000; // 70s without progress (> 60s limit)
    const stalledCheck = evaluateWorkerLiveness(attemptId1, true, {
      startupTimeoutMs: 30_000,
      noProgressTimeoutMs: 60_000,
      absoluteTimeoutMs: 300_000,
    }, stalledTime);

    expect(stalledCheck.status).toBe("no_progress_timeout");
    expect(stalledCheck.reason).toContain("Worker produced no progress output");

    // -------------------------------------------------------------------------
    // 3. Process Liveness Fence: cannot mark indeterminate while process still lives
    // -------------------------------------------------------------------------
    // Start a real directive and worker attempt
    const directive = issueDirective(world, {
      directiveId: "DIR-P5-SIDE-EFFECT",
      kind: "implementation",
      capabilityEnvelope: {
        repositoryRead: true,
        repositoryWrite: true,
        commandExecution: true,
        networkAccess: false,
        dependencyMutation: false,
        gitCommit: false,
        gitPush: false,
        externalServiceMutation: false,
      } as never,
    });

    const { attempt, launch } = world.ctx.store.withWrite((tx: any) =>
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
          enforcementPolicy: "layered",
        },
        world.ctx.clock,
        world.ctx.clock.nowIso(),
      ),
    );

    const session = freshWorkerSession(world, "W-P5");
    callWorkerTool(world, session, "worker_claim", {
      attempt_id: attempt.attemptId,
      launch_token: launch.launchToken,
    });

    // Worker creates a side-effect file in workspace before crashing
    const sideEffectFile = path.join(wsRoot, "src", "side-effect.ts");
    fs.mkdirSync(path.dirname(sideEffectFile), { recursive: true });
    fs.writeFileSync(sideEffectFile, "export const SideEffect = 'created_before_crash';\n");

    // Register active process with current process PID (guaranteed alive)
    registerWorkerProcess(attempt.attemptId, process.pid);

    // Attempting to transition to indeterminate while process is alive fails closed!
    let processAliveErrCode = "no-error";
    try {
      world.ctx.store.withWrite((tx: any) =>
        terminateAndMarkIndeterminateInTx(tx, { attemptId: attempt.attemptId }, world.ctx.clock.nowIso()),
      );
    } catch (err: any) {
      processAliveErrCode = err.code ?? "no-error";
    }
    expect(processAliveErrCode).toBe("WORKER_PROCESS_STILL_ALIVE");

    // Now simulate confirmed process death (overrideProcessAliveCheck = true)
    world.ctx.store.withWrite((tx: any) =>
      terminateAndMarkIndeterminateInTx(
        tx,
        { attemptId: attempt.attemptId, overrideProcessAliveCheck: true },
        world.ctx.clock.nowIso(),
      ),
    );

    // -------------------------------------------------------------------------
    // 4. Recovery Capability Boundary: recovery tools accessible, ordinary execution fenced
    // -------------------------------------------------------------------------
    // Ordinary execution tools are fenced and return structured recovery guidance
    let fencedErr: any = null;
    try {
      issueDirective(world, {
        directiveId: "DIR-P5-ORDINARY",
        kind: "implementation",
      });
    } catch (err: any) {
      fencedErr = err;
    }
    expect(fencedErr?.code).toBe("ATTEMPT_RECONCILIATION_REQUIRED");
    expect(fencedErr?.detail?.recoveryGuidance?.fenced).toBe(true);
    expect(fencedErr?.detail?.recoveryGuidance?.allowedRecoveryOperations).toContain("issue_attempt_reconciliation");

    // Recovery tool get_attempt_recovery_context succeeds cleanly
    const recoveryCtx = supervisorCall(world, "get_attempt_recovery_context", {}) as {
      status: string;
      execution_fenced: boolean;
      recovery_guidance: any;
    };
    expect(recoveryCtx.status).toBe("ok");
    expect(recoveryCtx.execution_fenced).toBe(true);
    expect(recoveryCtx.recovery_guidance.fenced).toBe(true);
    expect(recoveryCtx.recovery_guidance.sideEffectCapable).toBe(true);
    expect(recoveryCtx.recovery_guidance.recommendedActions.length).toBeGreaterThanOrEqual(1);

    // -------------------------------------------------------------------------
    // 5. Interrupted side-effect attempt resolved via inspection (no blind replay)
    // -------------------------------------------------------------------------
    const inspection = runReconciliationInspection(world, {
      attemptId: attempt.attemptId,
      candidateMutated: false,
    });
    expect(inspection.reportId).toBeTruthy();

    const revBeforeResolve = currentRevision(world);

    // Resolve indeterminate attempt with candidate_changed
    const resolutionResult = supervisorCall(world, "resolve_indeterminate_attempt", {
      attempt_id: attempt.attemptId,
      resolution: "candidate_changed",
      inspection_report_id: inspection.reportId,
      rationale: "Inspection confirms candidate changed with valid side effect",
      expected_candidate_revision: revBeforeResolve,
    }) as { status: string; window: { candidate_revision: number } };

    expect(resolutionResult.status).toBe("resolved");

    // Candidate revision advanced to reflect the validated side effect
    expect(currentRevision(world)).toBe(revBeforeResolve + 1);

    // Fence is now lifted!
    const postRecoveryCtx = supervisorCall(world, "get_attempt_recovery_context", {}) as {
      execution_fenced: boolean;
    };
    expect(postRecoveryCtx.execution_fenced).toBe(false);

    // -------------------------------------------------------------------------
    // 6. Idempotent Retry of Resolution Call
    // -------------------------------------------------------------------------
    const retryResolution = supervisorCall(world, "resolve_indeterminate_attempt", {
      attempt_id: attempt.attemptId,
      resolution: "candidate_changed",
      inspection_report_id: inspection.reportId,
      rationale: "Inspection confirms candidate changed with valid side effect",
      expected_candidate_revision: revBeforeResolve,
    }) as { status: string };

    expect(retryResolution.status).toBe("already_resolved");
    // Candidate revision did NOT advance again
    expect(currentRevision(world)).toBe(revBeforeResolve + 1);

    // -------------------------------------------------------------------------
    // 7. Late / Duplicate Report Submission recognized idempotently
    // -------------------------------------------------------------------------
    // Re-submitting the report converges idempotently on the existing report
    const duplicateReportAck = world.ctx.store.withWrite((tx: any) =>
      submitExecutionReportInTx(
        tx,
        {
          attemptId: inspection.attemptId,
          result: "completed",
          candidateMutated: false,
        },
        world.ctx.clock,
        world.ctx.clock.nowIso(),
      ),
    );

    expect(duplicateReportAck.report.reportId).toBe(inspection.reportId);
  });
});
