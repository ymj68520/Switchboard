/**
 * Shared fixtures for the v0.2.0 E10 final-closure focused tests.
 *
 * A "final-closure world" drives the real E1→E9 chain to the E7
 * all_stages_completed boundary (every ordinary Stage completed with exact
 * completed_by_commit provenance), then through the explicit E10 begin
 * operation and the final-closure worker protocol.
 */
import { randomUUID } from "node:crypto";

import {
  activateExecutionStageInTx,
} from "../src/store/execution-structure.js";
import { getExecutionRunInTx } from "../src/store/execution-runs.js";
import { getAcceptedHeadCommitIdInTx } from "../src/store/execution-commits.js";
import {
  beginExecutionFinalClosureInTx,
  loadExecutionCompletionSemanticsInTx,
  type BeginFinalClosureResult,
} from "../src/application/final-closure-service.js";
import { createAcceptanceService } from "../src/application/acceptance-service.js";
import {
  completeActiveStageFixture,
  makeAcceptanceWorld,
  openSuccessorWindow,
  runVerificationCycle,
  runWorkerAttempt,
  currentRevision,
  acceptInput,
  type AcceptanceWorld,
} from "./acceptance-helpers.js";
import { issueDirective } from "./execution-protocol-helpers.js";
import { startWorkerAttemptAndPrepareLaunchInTx } from "../src/application/worker-runtime-service.js";
import { executionDirectiveContent } from "../src/core/execution-directive.js";
import { executionRunCompletionObligation } from "../src/core/execution-completion.js";
import { freshWorkerSession } from "./execution-worker-helpers.js";
import type { ExecutionDirective } from "../src/core/execution-directive.js";

export type FinalClosureWorld = AcceptanceWorld;

/** Drive the E7 progression to the all_stages_completed boundary. */
export function completeAllStagesFixture(world: FinalClosureWorld): void {
  completeActiveStageFixture(world);
  for (;;) {
    const pending = world.ctx.store.withRead(
      (tx) =>
        tx
          .prepare("SELECT id FROM execution_stages WHERE execution_run_id = ? AND status = 'pending' ORDER BY ordinal")
          .all(world.executionRunId) as Array<{ id: string }>,
    );
    if (pending.length === 0) break;
    const target = pending[0]!.id;
    world.ctx.store.withWrite((tx) => activateExecutionStageInTx(tx, target, world.ctx.clock.nowIso()));
    openSuccessorWindow(world);
    completeActiveStageFixture(world);
  }
}

/** The exact all_stages_completed boundary facts (E7 §27 + E10 §0). */
export function boundaryFacts(world: FinalClosureWorld): {
  lifecycle: string;
  activeStageCount: number;
  pendingStageCount: number;
  completedStageCount: number;
  openWindowCount: number;
  acceptedHead: string | null;
} {
  return world.ctx.store.withRead((tx) => {
    const run = getExecutionRunInTx(tx, world.executionRunId)!;
    const stages = tx
      .prepare("SELECT status FROM execution_stages WHERE execution_run_id = ?")
      .all(world.executionRunId) as Array<{ status: string }>;
    const windows = tx
      .prepare("SELECT count(*) AS n FROM verification_windows WHERE execution_run_id = ? AND closed_at IS NULL")
      .get(world.executionRunId) as { n: number };
    return {
      lifecycle: run.lifecycle,
      activeStageCount: stages.filter((stage) => stage.status === "active").length,
      pendingStageCount: stages.filter((stage) => stage.status === "pending").length,
      completedStageCount: stages.filter((stage) => stage.status === "completed").length,
      openWindowCount: windows.n,
      acceptedHead: getAcceptedHeadCommitIdInTx(tx, world.executionRunId),
    };
  });
}

/** E10 §9 — the explicit begin (fresh window pointer is kept on the world). */
export function beginFinalClosure(world: FinalClosureWorld): BeginFinalClosureResult {
  const result = world.ctx.store.withWrite((tx) =>
    beginExecutionFinalClosureInTx(
      tx,
      {
        executionRunId: world.executionRunId,
        sessionId: world.f.sessionId,
        workspaceId: world.f.workspaceId,
        generation: world.f.generation,
      },
      world.ctx.clock,
      world.ctx.clock.nowIso(),
    ),
  );
  world.openWindowId = result.window.id;
  return result;
}

/** Run one final-closure worker cycle through the real E5 surfaces. */
export function runFinalClosureCycle(
  world: FinalClosureWorld,
  options: {
    directiveId?: string;
    kind: "implementation" | "inspection" | "verification";
    reportOverrides?: Record<string, unknown>;
    validationRequirements?: ExecutionDirective["validationRequirements"];
    verificationPolicy?: ExecutionDirective["verificationPolicy"];
    candidateMutated?: boolean;
  },
): { directive: ExecutionDirective; attemptId: string; reportId: string } {
  const directive = issueDirective(world, {
    directiveId: options.directiveId ?? `DIR-FC-${randomUUID().slice(0, 8)}`,
    kind: options.kind,
    scopeKind: "final_closure" as never,
    stageId: undefined,
    windowId: world.openWindowId,
    ...(options.validationRequirements === undefined ? {} : { validationRequirements: options.validationRequirements }),
    ...(options.verificationPolicy === undefined ? {} : { verificationPolicy: options.verificationPolicy as never }),
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
        workerRole: options.kind === "verification" ? "verifier" : "executor",
      },
      world.ctx.clock,
      world.ctx.clock.nowIso(),
    ),
  );
  const session = freshWorkerSession(world, `F-${randomUUID().slice(0, 4).toUpperCase()}`);
  const reportId = runWorkerAttempt(
    { ...world, launch, attemptId: attempt.attemptId } as never,
    session,
    reportPayload({
      candidate_mutated: options.candidateMutated ?? false,
      ...(options.reportOverrides ?? {}),
    }),
  );
  // Keep the world's verifier pointers fresh for acceptInput (same contract
  // as the acceptance-helpers runDirectiveCycle).
  if (options.kind === "verification") {
    world.verReportId = reportId;
    world.verSession = session;
    world.verDirective = directive;
  }
  return { directive, attemptId: attempt.attemptId, reportId };
}

/** Mirror of the acceptance-helpers report payload normalizer (E4 §27). */
function reportPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    result: "completed",
    candidate_mutated: false,
    actions_performed: [],
    files_examined: [],
    files_changed: [],
    commands_run: [],
    tests_run: [],
    findings: [],
    deviations: [],
    blockers: [],
    deliverables: [],
    ...overrides,
  };
  if (payload.result === "blocked" && (!Array.isArray(payload.blockers) || payload.blockers.length === 0)) {
    payload.blockers = [
      {
        kind: "MISSING_CONTEXT",
        summary: "the inspection could not proceed without additional context.",
        details: null,
        relevantRefs: [],
      },
    ];
  }
  return payload;
}

/** All current-candidate report ids of the open window, with their roles. */
export function currentCandidateReports(world: FinalClosureWorld): Array<{ reportId: string; workerRole: string }> {
  return world.ctx.store.withRead((tx) => {
    const windowId = (
      tx.prepare("SELECT id FROM verification_windows WHERE execution_run_id = ? AND closed_at IS NULL").get(world.executionRunId) as { id: string }
    ).id;
    const rows = tx
      .prepare(
        "SELECT r.report_id AS reportId, a.worker_role AS workerRole FROM execution_reports r "
        + "JOIN execution_attempts a ON a.attempt_id = r.attempt_id "
        + "JOIN execution_directives d ON d.directive_id = r.directive_id AND d.revision = r.directive_revision "
        + "WHERE d.window_id = ? AND d.base_candidate_revision = (SELECT candidate_revision FROM verification_windows WHERE id = ?) "
        + "AND r.candidate_mutated = 0 "
        + "ORDER BY r.report_id",
      )
      .all(windowId, windowId) as Array<{ reportId: string; workerRole: string }>;
    return rows;
  });
}

/**
 * The full final-completion cycle at the current candidate: one verification
 * Directive carrying the EXACT verify_execution_completion requirement, run by
 * a fresh verifier, then the accept assessment carrying the EXACT
 * execution_run_completion obligation. Returns the service-level result.
 */
export function runFinalCompletionFixture(world: FinalClosureWorld): {
  commitId: string;
  runCompleted: boolean;
  windowId: string;
  obligation: ReturnType<typeof executionRunCompletionObligation>;
} {
  const head = world.ctx.store.withRead((tx) => getAcceptedHeadCommitIdInTx(tx, world.executionRunId));
  if (head === null) throw new Error("fixture head missing");
  const semantics = world.ctx.store.withRead((tx) =>
    loadExecutionCompletionSemanticsInTx(tx, world.executionRunId, head),
  );
  const obligation = executionRunCompletionObligation(semantics);
  const { directive } = runFinalClosureCycle(world, {
    kind: "verification",
    validationRequirements: [{ requirement: "verify_execution_completion", detail: obligation.contentHash }],
  });
  void directive;
  // Every current-candidate report must be classified (E6 §41): verifier
  // evidence supporting, other evidence informational.
  const judgments = currentCandidateReports(world).map((report) => ({
    report_id: report.reportId,
    disposition: report.workerRole === "verifier" ? "supporting" : "informational",
  }));
  const result = createAcceptanceService(world.ctx.store, world.ctx.clock).submitSupervisorAssessment(
    acceptInput(world, {
      reportJudgments: judgments,
      coveredObligations: [
        {
          source: "execution_run_completion",
          executionRunId: obligation.executionRunId,
          final_plan_hash: obligation.finalPlanHash,
          base_accepted_head_commit_id: obligation.baseAcceptedHeadCommitId,
          completed_stage_set_hash: obligation.completedStageSetHash,
          contentHash: obligation.contentHash,
        },
      ],
    }) as never,
  ) as { runCompleted: boolean; commit: { commitId: string } | null; window: { id: string } };
  if (!result.runCompleted || result.commit === null) {
    throw new Error("fixture final completion failed");
  }
  return { commitId: result.commit.commitId, runCompleted: result.runCompleted, windowId: result.window.id, obligation };
}

/** The v3 canonical content of a directive (hash-input visibility for tests). */
export function canonicalContentOf(directive: ExecutionDirective): string {
  return executionDirectiveContent(directive);
}

export { completeActiveStageFixture, makeAcceptanceWorld, openSuccessorWindow, runVerificationCycle, currentRevision, acceptInput };
