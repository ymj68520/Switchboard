/**
 * v0.2.0 E14 release-closure shared fixtures.
 *
 * Integrated E2E driving: the real planning chain through the real MCP
 * handlers, worker claim/report paths through the real MCP dispatcher with
 * signed worker tokens, supervisor control operations (takeover, abort,
 * replan, conflicts, stage progression) through the real MCP dispatcher with
 * signed execution tokens, and directive/attempt/assessment assembly through
 * the real domain services (the exact transaction bodies the MCP handlers
 * run). No direct SQL status mutation anywhere: raw SQL in these helpers is
 * READ-ONLY projection of durable state for assertions.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { initializePlanStore } from "../src/store/sqlite-store.js";
import { createBlobStore } from "../src/store/blob-store.js";
import { loadHostSecret } from "../src/host/secret.js";
import { getExecutionRunInTx } from "../src/store/execution-runs.js";
import { getAcceptedHeadCommitIdInTx } from "../src/store/execution-commits.js";
import { getSupervisorBindingInTx } from "../src/store/supervisor-bindings.js";
import { getExecutionStructureInTx } from "../src/application/execution-structure-service.js";
import { listRunAttemptsInTx } from "../src/store/execution-attempts.js";
import { listRunDirectivesInTx } from "../src/store/execution-directives.js";
import type { ExecutionDirective } from "../src/core/execution-directive.js";
import type { AcceptanceWorld } from "./acceptance-helpers.js";
import {
  currentRevision,
  makeAcceptanceWorld,
  supervisorCall,
} from "./acceptance-helpers.js";
import { issueDirective } from "./execution-protocol-helpers.js";
import { callWorkerTool, freshWorkerSession } from "./execution-worker-helpers.js";
import { startWorkerAttemptAndPrepareLaunchInTx } from "../src/application/worker-runtime-service.js";
import {
  deriveStageCompletionValidationRequirement,
  stageObjectiveObligation,
} from "../src/core/stage-completion.js";
import { getExecutionStageInTx } from "../src/store/execution-structure.js";
import {
  loadExecutionCompletionSemanticsInTx,
} from "../src/application/final-closure-service.js";
import { executionRunCompletionObligation } from "../src/core/execution-completion.js";
import { getExecutionAttemptInTx } from "../src/store/execution-attempts.js";

export type E14World = AcceptanceWorld;

export {
  currentRevision,
  makeAcceptanceWorld,
  supervisorCall,
  issueDirective,
  callWorkerTool,
  freshWorkerSession,
  startWorkerAttemptAndPrepareLaunchInTx,
  deriveStageCompletionValidationRequirement,
  stageObjectiveObligation,
  executionRunCompletionObligation,
  loadExecutionCompletionSemanticsInTx,
  getExecutionStageInTx,
  getExecutionAttemptInTx,
  getExecutionRunInTx,
  getAcceptedHeadCommitIdInTx,
  getSupervisorBindingInTx,
  getExecutionStructureInTx,
};

/** Read-only projection of the durable canonical state of a run. */
export function boundariesOf(world: E14World, runId = world.executionRunId) {
  return world.ctx.store.withRead((tx) => {
    const run = getExecutionRunInTx(tx, runId);
    const binding = getSupervisorBindingInTx(tx, runId);
    const structure = getExecutionStructureInTx(tx, runId);
    const stages = tx
      .prepare("SELECT id, ordinal, status, completed_by_commit_id AS completedBy FROM execution_stages WHERE execution_run_id = ? ORDER BY ordinal")
      .all(runId) as Array<{ id: string; ordinal: number; status: string; completedBy: string | null }>;
    const windows = tx
      .prepare("SELECT id, scope_kind AS scopeKind, closure_kind AS closureKind, candidate_revision AS rev, base_commit_id AS baseCommitId FROM verification_windows WHERE execution_run_id = ? ORDER BY opened_at, id")
      .all(runId) as Array<{ id: string; scopeKind: string | null; closureKind: string | null; rev: number; baseCommitId: string | null }>;
    const commits = tx
      .prepare("SELECT c.commit_id AS commitId, c.stage_id AS stageId, w.scope_kind AS windowScope FROM execution_commits c JOIN verification_windows w ON w.id = c.window_id WHERE c.execution_run_id = ? ORDER BY c.created_at, c.commit_id")
      .all(runId) as Array<{ commitId: string; stageId: string | null; windowScope: string | null }>;
    const planning = tx
      .prepare("SELECT lifecycle AS lifecycle, revision AS revision FROM planning_runs WHERE run_id = ?")
      .get(run?.runId ?? runId) as { lifecycle: string; revision: number } | undefined;
    const reports = tx
      .prepare("SELECT count(*) AS n FROM execution_reports WHERE execution_run_id = ?")
      .get(runId) as { n: number };
    const completion = tx
      .prepare("SELECT completion_commit_id AS completionCommitId FROM execution_runs WHERE execution_run_id = ?")
      .get(runId) as { completionCommitId: string | null };
    return {
      planningLifecycle: planning?.lifecycle ?? null,
      lifecycle: run?.lifecycle ?? null,
      runRevision: run?.revision ?? null,
      acceptedHead: getAcceptedHeadCommitIdInTx(tx, runId),
      completionCommitId: completion.completionCommitId,
      binding: binding === null ? null : { state: binding.state, generation: binding.generation, sessionId: binding.sessionId },
      stages,
      windows,
      commits,
      activeStage: structure.activeStage?.id ?? null,
      openWindow: structure.openWindow === null
        ? null
        : { id: structure.openWindow.id, candidateRevision: structure.openWindow.candidateRevision, scopeKind: structure.openWindow.scopeKind },
      directives: listRunDirectivesInTx(tx, runId).map((d) => ({ id: d.directiveId, revision: d.revision, hash: d.hash, windowId: d.windowId })),
      attempts: listRunAttemptsInTx(tx, runId).map((a) => ({ id: a.attemptId, state: a.state, directiveRevision: a.directiveRevision })),
      reportCount: reports.n,
    };
  });
}

/** One implementation cycle: directive + executor attempt + MCP claim/report. */
export function runImplementation(
  world: E14World,
  options: {
    directiveId: string;
    candidateMutated?: boolean;
    reportOverrides?: Record<string, unknown>;
    /** Run THIS existing directive (by id/revision/hash) instead of issuing a new revision. */
    existingDirective?: { directiveId: string; revision: number; hash: string };
  },
): { directiveId: string; revision: number; hash: string; attemptId: string; reportId: string } {
  const directive = (options.existingDirective
    ? (options.existingDirective as never as ExecutionDirective)
    : issueDirective(world, {
        directiveId: options.directiveId,
        kind: "implementation",
      }));
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
  const session = freshWorkerSession(world, `X-${options.directiveId}`);
  callWorkerTool(world, session, "worker_claim", {
    attempt_id: attempt.attemptId,
    launch_token: launch.launchToken,
  });
  const ack = callWorkerTool(world, session, "worker_submit_report", {
    result: "completed",
    candidate_mutated: options.candidateMutated ?? true,
    actions_performed: [{ action: "edit", detail: null }],
    files_changed: ["src/feature.ts"],
    ...(options.reportOverrides ?? {}),
  }) as { report_id: string };
  return {
    directiveId: directive.directiveId,
    revision: directive.revision,
    hash: directive.hash,
    attemptId: attempt.attemptId,
    reportId: ack.report_id,
  };
}

/** One fresh-verifier verification cycle at the CURRENT candidate. */
export function runFreshVerifier(
  world: E14World,
  options: {
    directiveId: string;
    validationRequirements?: Array<{ requirement: string; detail: string }>;
    reportOverrides?: Record<string, unknown>;
    finalClosure?: boolean;
    /** Run THIS existing directive (by id/revision/hash) instead of issuing a new revision. */
    existingDirective?: { directiveId: string; revision: number; hash: string };
  },
): { directiveId: string; revision: number; hash: string; attemptId: string; reportId: string; sessionId: string } {
  const directive = (options.existingDirective
    ? (options.existingDirective as never as ExecutionDirective)
    : issueDirective(world, {
        directiveId: options.directiveId,
        kind: "verification",
        ...(options.finalClosure === true
          ? { scopeKind: "final_closure" as never, stageId: undefined, windowId: world.openWindowId }
          : {}),
        ...(options.validationRequirements === undefined ? {} : { validationRequirements: options.validationRequirements as never }),
      }));
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
  const session = freshWorkerSession(world, `V-${options.directiveId}`);
  callWorkerTool(world, session, "worker_claim", {
    attempt_id: attempt.attemptId,
    launch_token: launch.launchToken,
  });
  const ack = callWorkerTool(world, session, "worker_submit_report", {
    result: "completed",
    candidate_mutated: false,
    tests_run: [{ name: "verification-suite", outcome: "pass", detail: null }],
    ...(options.reportOverrides ?? {}),
  }) as { report_id: string };
  world.verDirective = directive;
  world.verSession = session;
  world.verReportId = ack.report_id;
  return {
    directiveId: directive.directiveId,
    revision: directive.revision,
    hash: directive.hash,
    attemptId: attempt.attemptId,
    reportId: ack.report_id,
    sessionId: session.sessionId,
  };
}

/**
 * Accept the current candidate through the REAL MCP supervisor surface (the
 * same strict business schema + host-context + Core gate the live host hits).
 */
export function acceptViaMcp(
  world: E14World,
  options: {
    disposition?: string;
    rationale?: string;
    reportJudgments?: Array<{ report_id: string; disposition: string }>;
    coveredObligations?: Array<Record<string, unknown>>;
    expectedCandidateRevision?: number;
  } = {},
): Record<string, unknown> {
  return supervisorCall(world, "submit_supervisor_assessment", {
    disposition: options.disposition ?? "accept",
    rationale: options.rationale ?? "Verifier evidence covers the exact candidate; no blockers remain.",
    report_judgments: options.reportJudgments
      ?? (world.verReportId === null ? [] : [{ report_id: world.verReportId, disposition: "supporting" }]),
    covered_obligations: options.coveredObligations ?? [],
    expected_candidate_revision: options.expectedCandidateRevision ?? currentRevision(world),
  });
}

/** Record a non-accept supervisor judgment through the real MCP surface. */
export function assessViaMcp(
  world: E14World,
  disposition: "rework" | "need_more_verification" | "blocked" | "request_replan",
  rationale: string,
): Record<string, unknown> {
  return acceptViaMcp(world, { disposition, rationale });
}

/**
 * Complete the CURRENT active Stage through the real acceptance gate: one
 * stage-completion verification cycle at the current candidate, then the
 * accept assessment carrying the EXACT stage_objective obligation.
 */
export function completeStageViaGate(world: E14World): { stageId: string; commitId: string } {
  world.openWindowId = world.ctx.store.withRead(
    (tx) =>
      (tx.prepare("SELECT id FROM verification_windows WHERE execution_run_id = ? AND closed_at IS NULL").get(world.executionRunId) as { id: string })
        .id,
  );
  world.activeStageId = world.ctx.store.withRead(
    (tx) =>
      (tx.prepare("SELECT id FROM execution_stages WHERE execution_run_id = ? AND status = 'active'").get(world.executionRunId) as { id: string }).id,
  );
  const stage = world.ctx.store.withRead((tx) => getExecutionStageInTx(tx, world.activeStageId))!;
  const requirement = deriveStageCompletionValidationRequirement(stage);
  runFreshVerifier(world, { directiveId: `DIR-VSC-${stage.id}`, validationRequirements: [requirement] });
  const obligation = stageObjectiveObligation(stage);
  const result = acceptViaMcp(world, {
    coveredObligations: [
      {
        source: "stage_objective",
        stage_id: obligation.stageId,
        objective_hash: obligation.objectiveHash,
        contentHash: obligation.contentHash,
      },
    ],
  }) as { status: string; commit: { id: string } | null; stage_completed?: boolean };
  const commitId = result.commit?.id ?? null;
  if (!result.stage_completed || !commitId) throw new Error(`fixture stage completion failed: ${JSON.stringify(result)}`);
  return { stageId: stage.id, commitId };
}

/**
 * Drive the E10 final-completion accept through the REAL MCP surface: the
 * verify_execution_completion verification cycle plus the execution_run_completion
 * obligation.
 */
export function completeRunViaGate(world: E14World): { commitId: string } {
  const head = world.ctx.store.withRead((tx) => getAcceptedHeadCommitIdInTx(tx, world.executionRunId));
  if (head === null) throw new Error("fixture head missing");
  const semantics = world.ctx.store.withRead((tx) =>
    loadExecutionCompletionSemanticsInTx(tx, world.executionRunId, head),
  );
  const obligation = executionRunCompletionObligation(semantics);
  runFreshVerifier(world, {
    directiveId: "DIR-VFINAL",
    finalClosure: true,
    validationRequirements: [{ requirement: "verify_execution_completion", detail: obligation.contentHash }],
  });
  const result = acceptViaMcp(world, {
    reportJudgments: world.verReportId === null ? [] : [{ report_id: world.verReportId, disposition: "supporting" }],
    coveredObligations: [
      {
        source: "execution_run_completion",
        execution_run_id: obligation.executionRunId,
        final_plan_hash: obligation.finalPlanHash,
        base_accepted_head_commit_id: obligation.baseAcceptedHeadCommitId,
        completed_stage_set_hash: obligation.completedStageSetHash,
        contentHash: obligation.contentHash,
      },
    ],
  }) as { status: string; commit: { id: string } | null; run_completed?: boolean };
  const commitId = result.commit?.id ?? null;
  if (!result.run_completed || !commitId) throw new Error(`fixture final completion failed: ${JSON.stringify(result)}`);
  return { commitId };
}

/**
 * Physically close and reopen the Store/runtime at the same plugin data root
 * (§38 restart gate). The canonical layout is `<root>/store/phase-plan.sqlite3`.
 */
export async function closeAndReopen(world: E14World): Promise<void> {
  const dbPath = world.ctx.store.path;
  const pluginDataRoot = path.dirname(path.dirname(dbPath));
  world.ctx.store.close();
  const store = await initializePlanStore({ pluginDataRoot });
  world.ctx = {
    store,
    secret: loadHostSecret(pluginDataRoot).key,
    clock: world.ctx.clock,
    blobs: createBlobStore(path.join(pluginDataRoot, "blobs")),
  };
}

/** A real uncommitted workspace mutation inside the run's workspace root. */
export function mutateWorkspace(world: E14World, relPath: string, content: string): string {
  const full = path.join(world.f.workspaceRoot, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

/** The code of a thrown domain error (stable RuntimeError code). */
export function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as { code?: string }).code ?? "no-error";
  }
  return "no-error";
}
