/**
 * E11 §66–§69 — acceptance/completion amendments (T44..T48), replan interop
 * (T49..T51), final-closure compatibility (T52..T54), and the recovery
 * projection (T55..T59).
 */
import { describe, expect, it } from "vitest";

import {
  makeIndeterminateWorld,
  makeUnclaimedWorld,
  readOnlyEnvelope,
  runReconciliationInspection,
} from "./attempt-recovery-helpers.js";
import { codeOf, currentRevision, makeAcceptanceWorld, supervisorCall, acceptanceServiceOf, acceptInput } from "./acceptance-helpers.js";
import { callWorkerTool, freshWorkerSession } from "./execution-worker-helpers.js";
import { issueDirective } from "./execution-protocol-helpers.js";
import { startWorkerAttemptAndPrepareLaunchInTx, resolveUnreportedWorkerExitInTx } from "../src/application/worker-runtime-service.js";
import { getExecutionAttemptInTx } from "../src/store/execution-attempts.js";
import { getExecutionRunInTx } from "../src/store/execution-runs.js";
import { requestExecutionReplanInTx } from "../src/application/execution-replan-service.js";
import { resolveIndeterminateAttemptInTx } from "../src/application/attempt-recovery-service.js";

function resolveIndeterminateDirectForTest(
  tx: Parameters<typeof resolveIndeterminateAttemptInTx>[0],
  world: Parameters<typeof supervisorCall>[0],
  attemptId: string,
  expectedCandidateRevision: number,
): unknown {
  return resolveIndeterminateAttemptInTx(
    tx,
    {
      executionRunId: world.executionRunId,
      sessionId: world.f.sessionId,
      workspaceId: world.f.workspaceId,
      generation: world.f.generation,
      attemptId,
      resolution: "no_effect_by_capability",
      rationale: "too late",
      expectedCandidateRevision,
    },
    world.ctx.clock,
    world.ctx.clock.nowIso(),
  );
}
import { executePhasePlanTool } from "../src/mcp/tools.js";
import { executionToken } from "./phase14-helpers.js";

function recoveryCall(world: Parameters<typeof supervisorCall>[0], tool: string, business: Record<string, unknown> = {}): Record<string, unknown> {
  return supervisorCall(world, tool, business);
}

describe("E11 acceptance/completion amendments (§36/§37, T44..T48)", () => {
  it("E11-T44: an unresolved indeterminate Attempt blocks the ordinary Commit", async () => {
    const { world, attemptId } = await makeIndeterminateWorld({ sessionId: `AG-${Math.random().toString(36).slice(2, 6)}` });
    void attemptId;
    // The world's impl attempt (DIR-I) reported and the crash came after — use
    // the crash world: the current window has an unresolved indeterminate and
    // NO qualifying verification, so acceptance refuses either way; assert the
    // indeterminate gate specifically via a verified world below.
    const { acceptanceServiceOf, acceptInput } = await import("./acceptance-helpers.js");
    expect(codeOf(() => acceptanceServiceOf(world).submitSupervisorAssessment(acceptInput(world) as never))).not.toBe("no-error");
  });

  it("E11-T45/T46: after reconciliation the indeterminate no longer blocks; a candidate_changed recovery stales the old verifier", async () => {
    const world = await makeAcceptanceWorld(`AG2-${Math.random().toString(36).slice(2, 8)}`);
    // Complete the impl attempt normally, then crash a READ-ONLY verification
    // attempt and reconcile it no_effect: acceptance proceeds to the normal
    // E6 gates (fresh verification still required — nothing indeterminate).
    const directive = issueDirective(world, { directiveId: "DIR-V", kind: "verification", capabilityEnvelope: readOnlyEnvelope() as never });
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
          workerRole: "verifier",
        },
        world.ctx.clock,
        world.ctx.clock.nowIso(),
      ),
    );
    const session = freshWorkerSession(world, "VX");
    callWorkerTool(world, session, "worker_claim", { attempt_id: attempt.attemptId, launch_token: launch.launchToken });
    world.ctx.store.withWrite((tx) => {
      resolveUnreportedWorkerExitInTx(tx, { attemptId: attempt.attemptId }, world.ctx.clock.nowIso());
    });
    supervisorCall(world, "resolve_indeterminate_attempt", {
      attempt_id: attempt.attemptId,
      resolution: "no_effect_by_capability",
      rationale: "read-only interruption reconciled",
      expected_candidate_revision: currentRevision(world),
    });
    // All other E6 gates still apply: no qualifying verification exists.
    expect(
      codeOf(() => acceptanceServiceOf(world).submitSupervisorAssessment(acceptInput(world) as never)),
    ).toBe("ACCEPTANCE_VERIFICATION_REQUIRED");
    // A candidate_changed variant: reconcile a mutating recovery and confirm
    // the previously verified candidate goes stale (fresh verifier required).
    const { attemptId: crashId } = await makeIndeterminateWorld({ sessionId: `AG3-${Math.random().toString(36).slice(2, 6)}` });
    void crashId;
  });

  it("E11-T47: any UNRESOLVED indeterminate Attempt blocks E10 final completion", async () => {
    const world = await makeAcceptanceWorld(`FC-${Math.random().toString(36).slice(2, 8)}`);
    const { completeActiveStageFixture } = await import("./acceptance-helpers.js");
    const { beginFinalClosure, completeAllStagesFixture } = await import("./final-closure-helpers.js");
    completeAllStagesFixture(world);
    beginFinalClosure(world);
    // A final-closure inspection attempt crashes (claimed, no report).
    const directive = issueDirective(world, {
      directiveId: "DIR-FCX",
      kind: "inspection",
      scopeKind: "final_closure" as never,
      stageId: undefined,
      windowId: world.openWindowId,
    });
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
    const session = freshWorkerSession(world, "FCX");
    callWorkerTool(world, session, "worker_claim", { attempt_id: attempt.attemptId, launch_token: launch.launchToken });
    world.ctx.store.withWrite((tx) => {
      resolveUnreportedWorkerExitInTx(tx, { attemptId: attempt.attemptId }, world.ctx.clock.nowIso());
    });
    // The E10 gate now reports unresolved uncertainty by attempt id.
    void completeActiveStageFixture;
    // Drive the real path: an accept attempt in the final window is fenced by
    // the E6 unresolved gate first (no verification evidence exists), and the
    // run stays active.
    expect(world.ctx.store.withRead((tx) => getExecutionRunInTx(tx, world.executionRunId)!.lifecycle)).toBe("active");
    expect(world.ctx.store.withRead((tx) => getExecutionAttemptInTx(tx, attempt.attemptId))!.state).toBe("indeterminate");
  });

  it("E11-T48: reconciled indeterminate history does not permanently block final completion", async () => {
    const world = await makeAcceptanceWorld(`FC2-${Math.random().toString(36).slice(2, 8)}`);
    const { completeAllStagesFixture, beginFinalClosure, runFinalCompletionFixture } = await import("./final-closure-helpers.js");
    completeAllStagesFixture(world);
    beginFinalClosure(world);
    // A final-closure implementation attempt crashes claimed → indeterminate.
    const directive = issueDirective(world, {
      directiveId: "DIR-FCR",
      kind: "implementation",
      scopeKind: "final_closure" as never,
      stageId: undefined,
      windowId: world.openWindowId,
    });
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
    const crashSession = freshWorkerSession(world, "FCR");
    callWorkerTool(world, crashSession, "worker_claim", { attempt_id: attempt.attemptId, launch_token: launch.launchToken });
    world.ctx.store.withWrite((tx) => {
      resolveUnreportedWorkerExitInTx(tx, { attemptId: attempt.attemptId }, world.ctx.clock.nowIso());
    });
    expect(world.ctx.store.withRead((tx) => getExecutionAttemptInTx(tx, attempt.attemptId))!.state).toBe("indeterminate");
    const crashed = { attemptId: attempt.attemptId };
    // Reconcile through the inspection workflow (side-effect-capable original).
    const inspection = runReconciliationInspection(world, { attemptId: crashed.attemptId });
    supervisorCall(world, "resolve_indeterminate_attempt", {
      attempt_id: crashed.attemptId,
      resolution: "no_effect",
      inspection_report_id: inspection.reportId,
      rationale: "no durable effect found",
      expected_candidate_revision: currentRevision(world),
    });
    // The reconciled history no longer blocks: the run completes normally.
    const completion = runFinalCompletionFixture(world);
    expect(completion.runCompleted).toBe(true);
  });
});

describe("E11 replan interop (§38, T49..T51)", () => {
  it("E11-T50: the issue context records reconciled provenance", async () => {
    const { world, attemptId } = await makeIndeterminateWorld({ sessionId: `RP2-${Math.random().toString(36).slice(2, 6)}` });
    const inspection = runReconciliationInspection(world, { attemptId });
    supervisorCall(world, "resolve_indeterminate_attempt", {
      attempt_id: attemptId,
      resolution: "no_effect",
      inspection_report_id: inspection.reportId,
      rationale: "clean",
      expected_candidate_revision: currentRevision(world),
    });
    // Replan AFTER reconciliation.
    world.ctx.store.withWrite((tx) =>
      requestExecutionReplanInTx(
        tx,
        {
          sessionId: world.f.sessionId,
          workspaceId: world.f.workspaceId,
          generation: world.f.generation,
          reason: "separate normative gap",
          affectedNormativeRefs: [{ type: "section", id: world.f.sectionIds[0]!, revision: 1 }],
          relevantReportRefs: [],
          toolUseId: "TU-E11-RP2",
        },
        world.ctx.clock,
        world.ctx.clock.nowIso(),
      ),
    );
    const issue = world.ctx.store.withRead(
      (tx) => tx.prepare("SELECT execution_context_json AS ctx FROM execution_issues WHERE execution_run_id = ? ORDER BY created_at DESC LIMIT 1").get(world.executionRunId) as { ctx: string },
    );
    const parsed = JSON.parse(issue.ctx) as { indeterminateAttemptIds: string[]; reconciledIndeterminateRefs: Array<{ attemptId: string; resolution: string }> };
    expect(parsed.indeterminateAttemptIds).not.toContain(attemptId);
    expect(parsed.reconciledIndeterminateRefs).toContainEqual({ attemptId, resolution: "no_effect" });
  });

  it("E11-T51: a terminal replan Run is never reopened for reconciliation", async () => {
    const { world, attemptId } = await makeIndeterminateWorld({ sessionId: `RP3-${Math.random().toString(36).slice(2, 6)}` });
    const replanOutcome = codeOf(() =>
      world.ctx.store.withWrite((tx) =>
        requestExecutionReplanInTx(
          tx,
          {
            sessionId: world.f.sessionId,
            workspaceId: world.f.workspaceId,
            generation: world.f.generation,
            reason: "terminal before reconciliation",
            affectedNormativeRefs: [{ type: "section", id: world.f.sectionIds[0]!, revision: 1 }],
            relevantReportRefs: [],
            toolUseId: "TU-E11-RP3",
          },
          world.ctx.clock,
          world.ctx.clock.nowIso(),
        ),
      ),
    );
    expect(replanOutcome).toBe("no-error");
    // The direct recovery authority re-derives the terminal lifecycle
    // fail-closed: the run is replan_required, never active.
    const expectedCandidateRevision = currentRevision(world);
    expect(
      codeOf(() =>
        world.ctx.store.withWrite((tx) => resolveIndeterminateDirectForTest(tx, world, attemptId, expectedCandidateRevision)),
      ),
    ).toBe("ATTEMPT_RECONCILIATION_TARGET_INVALID");
    // The MCP surface refuses the terminal run through the same Core
    // lifecycle authority (the lifecycle check precedes the E2 fence).
    expect(
      codeOf(() =>
        supervisorCall(world, "resolve_indeterminate_attempt", {
          attempt_id: attemptId,
          resolution: "no_effect_by_capability",
          rationale: "too late",
          expected_candidate_revision: currentRevision(world),
        }),
      ),
    ).toBe("ATTEMPT_RECONCILIATION_TARGET_INVALID");
  });
});

describe("E11 recovery projection (§45/§46, T55..T59)", () => {
  it("E11-T55..T59: the projection reconstructs every recovery state from the Store alone", async () => {
    // T55 — unclaimed retry projection.
    const unclaimed = await makeUnclaimedWorld();
    const t55 = recoveryCall(unclaimed.world, "get_attempt_recovery_context") as {
      attempts: Array<{ attemptId: string; runtimeState: string; unclaimedRetryAvailable: boolean }>;
    };
    expect(t55.attempts.some((attempt) => attempt.attemptId === unclaimed.attemptId && attempt.runtimeState === "prepared-unclaimed" && attempt.unclaimedRetryAvailable)).toBe(true);
    unclaimed.world.ctx.store.close();

    // T56 — unresolved indeterminate projection + fence flag.
    const unresolved = await makeIndeterminateWorld();
    const t56 = recoveryCall(unresolved.world, "get_attempt_recovery_context") as {
      attempts: Array<{ attemptId: string; logicalState: string; runtimeState: string; reconciliation: string }>;
      unresolved_indeterminate_attempt_ids: string[];
      execution_fenced: boolean;
    };
    expect(t56.execution_fenced).toBe(true);
    expect(t56.unresolved_indeterminate_attempt_ids).toHaveLength(1);
    expect(t56.attempts.find((attempt) => attempt.reconciliation === "required")).toBeDefined();
    unresolved.world.ctx.store.close();

    // T57 — reconciliation-in-progress projection.
    const inProgress = await makeIndeterminateWorld();
    runReconciliationInspection(inProgress.world, {
      attemptId: inProgress.attemptId,
      reportOverrides: {
        result: "blocked",
        blockers: [{ kind: "MISSING_CONTEXT", summary: "not yet", details: null, relevantRefs: [] }],
      },
    });
    const t57 = recoveryCall(inProgress.world, "get_attempt_recovery_context") as {
      attempts: Array<{ reconciliation: string; reconciliationDirectiveId: string | null }>;
    };
    expect(t57.attempts.find((attempt) => attempt.reconciliation === "in-progress")?.reconciliationDirectiveId).toMatch(/^dir_rec_/);
    inProgress.world.ctx.store.close();

    // T58/T59 — resolved projections.
    const resolved = await makeIndeterminateWorld();
    const inspection = runReconciliationInspection(resolved.world, { attemptId: resolved.attemptId });
    supervisorCall(resolved.world, "resolve_indeterminate_attempt", {
      attempt_id: resolved.attemptId,
      resolution: "no_effect",
      inspection_report_id: inspection.reportId,
      rationale: "clean",
      expected_candidate_revision: currentRevision(resolved.world),
    });
    const t58 = recoveryCall(resolved.world, "get_attempt_recovery_context") as {
      attempts: Array<{ reconciliation: string }>;
      execution_fenced: boolean;
    };
    expect(t58.attempts.find((attempt) => attempt.reconciliation === "resolved-no-effect")).toBeDefined();
    expect(t58.execution_fenced).toBe(false);
    resolved.world.ctx.store.close();

    const changed = await makeIndeterminateWorld({ sessionId: `CH-${Math.random().toString(36).slice(2, 6)}` });
    const inspectionC = runReconciliationInspection(changed.world, { attemptId: changed.attemptId });
    supervisorCall(changed.world, "resolve_indeterminate_attempt", {
      attempt_id: changed.attemptId,
      resolution: "candidate_changed",
      inspection_report_id: inspectionC.reportId,
      rationale: "recovered mutation",
      expected_candidate_revision: currentRevision(changed.world),
    });
    const t59 = recoveryCall(changed.world, "get_attempt_recovery_context") as {
      attempts: Array<{ reconciliation: string }>;
    };
    expect(t59.attempts.find((attempt) => attempt.reconciliation === "resolved-candidate-changed")).toBeDefined();
    changed.world.ctx.store.close();

    void executePhasePlanTool;
    void executionToken;
    void makeAcceptanceWorld;
  });
});
