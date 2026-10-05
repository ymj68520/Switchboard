/**
 * Shared fixtures for the v0.2.0 E6 acceptance/commit focused tests.
 *
 * An "acceptance world" drives the real E1→E5 chain through the MCP/InTx
 * authority surfaces: an implementation Attempt completed by a real claimed
 * ExecutionWorker with a MUTATING report (candidate 0 → 1), then a
 * verification Directive at the new candidate completed by a fresh verifier
 * ExecutionWorker with a completed non-mutating report — the exact shape the
 * E6 §13 fresh-verification gate demands.
 */
import { randomUUID } from "node:crypto";

import {
  directiveInput,
  issueDirective,
  makeActiveExecutionWorld,
  codeOf,
  type E4World,
} from "./execution-protocol-helpers.js";
import {
  callWorkerTool,
  freshWorkerSession,
  type WorkerSession,
} from "./execution-worker-helpers.js";
import { executionToken } from "./phase14-helpers.js";
import { createAcceptanceService, openNextWindowForActiveStageInTx } from "../src/application/acceptance-service.js";
import { startWorkerAttemptAndPrepareLaunchInTx } from "../src/application/worker-runtime-service.js";
import { executePhasePlanTool } from "../src/mcp/tools.js";
import { takeoverSupervisorBindingInTx } from "../src/store/supervisor-bindings.js";
import { getExecutionStageInTx } from "../src/store/execution-structure.js";
import { deriveStageCompletionValidationRequirement, stageObjectiveObligation } from "../src/core/stage-completion.js";
import type { ExecutionDirective } from "../src/core/execution-directive.js";
import type { IssueExecutionDirectiveInput } from "../src/application/execution-directive-service.js";
import type { PreparedWorkerLaunch } from "../src/application/worker-runtime-service.js";

export interface AcceptanceWorld extends E4World {
  implDirective: ExecutionDirective;
  execSession: WorkerSession;
  implReportId: string;
  verDirective: ExecutionDirective | null;
  verSession: WorkerSession | null;
  verReportId: string | null;
}

interface LaunchableWorld {
  ctx: E4World["ctx"];
  f: E4World["f"];
  executionRunId: string;
}

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
  // E4 §27 — result=blocked carries at least one structured blocker.
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

/**
 * Claim + report one prepared launch as its fresh worker session, through the
 * real worker MCP surface. Returns the immutable report id.
 */
export function runWorkerAttempt(
  world: LaunchableWorld & { launch: PreparedWorkerLaunch; attemptId: string },
  session: WorkerSession,
  reportOverrides: Record<string, unknown> = {},
): string {
  callWorkerTool(world, session, "worker_claim", {
    attempt_id: world.launch.attemptId,
    launch_token: world.launch.launchToken,
  });
  const ack = callWorkerTool(world, session, "worker_submit_report", reportPayload(reportOverrides)) as {
    report_id: string;
  };
  return ack.report_id;
}

/** The full accept-ready baseline (implementation mutation + nothing else). */
export async function makeAcceptanceWorld(sessionId = "S1"): Promise<AcceptanceWorld> {
  const base = await makeActiveExecutionWorld(sessionId);
  const implDirective = issueDirective(base, { directiveId: "DIR-I", kind: "implementation" });
  const { attempt, launch } = base.ctx.store.withWrite((tx) =>
    startWorkerAttemptAndPrepareLaunchInTx(
      tx,
      {
        executionRunId: base.executionRunId,
        sessionId: base.f.sessionId,
        workspaceId: base.f.workspaceId,
        generation: base.f.generation,
        directiveId: implDirective.directiveId,
        directiveRevision: implDirective.revision,
        directiveHash: implDirective.hash,
        workerRole: "executor",
      },
      base.ctx.clock,
      base.ctx.clock.nowIso(),
    ),
  );
  const world: AcceptanceWorld = {
    ...base,
    implDirective,
    execSession: freshWorkerSession(base, "EXEC"),
    implReportId: "",
    verDirective: null,
    verSession: null,
    verReportId: null,
  };
  world.implReportId = runWorkerAttempt({ ...world, launch, attemptId: attempt.attemptId }, world.execSession, {
    candidate_mutated: true,
    files_changed: ["src/feature.ts"],
  });
  return world;
}

export interface DirectiveCycleResult {
  directive: ExecutionDirective;
  attemptId: string;
  session: WorkerSession;
  reportId: string;
}

/**
 * Run one full worker cycle at the CURRENT candidate through the real E5
 * surfaces: issue the Directive, start the Attempt, and complete it with a
 * fresh worker session. Verification directives run as the verifier role;
 * everything else as the executor role (E4 role rule).
 */
export function runDirectiveCycle(
  world: AcceptanceWorld,
  options: {
    directiveId?: string;
    kind: "implementation" | "inspection" | "verification";
    reportOverrides?: Record<string, unknown>;
    directiveOverrides?: Partial<IssueExecutionDirectiveInput>;
  },
): DirectiveCycleResult {
  const directive = issueDirective(world, {
    directiveId: options.directiveId ?? `DIR-${options.kind.slice(0, 1).toUpperCase()}-${randomUUID().slice(0, 8)}`,
    kind: options.kind,
    ...(options.directiveOverrides ?? {}),
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
  const session = freshWorkerSession(world, `W-${randomUUID().slice(0, 4).toUpperCase()}`);
  const reportId = runWorkerAttempt({ ...world, launch, attemptId: attempt.attemptId }, session, {
    candidate_mutated: options.kind === "verification" ? false : (options.reportOverrides?.candidate_mutated as boolean | undefined) ?? false,
    ...(options.reportOverrides ?? {}),
  });
  if (options.kind === "verification") {
    world.verDirective = directive;
    world.verSession = session;
    world.verReportId = reportId;
  }
  return { directive, attemptId: attempt.attemptId, session, reportId };
}

/** E6 §13 — one verification cycle at the CURRENT candidate. */
export function runVerificationCycle(
  world: AcceptanceWorld,
  overrides: {
    directiveId?: string;
    directiveOverrides?: Partial<IssueExecutionDirectiveInput>;
    reportOverrides?: Record<string, unknown>;
  } = {},
): DirectiveCycleResult {
  return runDirectiveCycle(world, {
    kind: "verification",
    directiveId: overrides.directiveId,
    directiveOverrides: overrides.directiveOverrides,
    reportOverrides: overrides.reportOverrides,
  });
}

/**
 * E7 — complete the run's CURRENT active Stage through the real gate: one
 * verification cycle whose Directive carries the derived Stage-completion
 * requirement, then an accept assessment with the exact stage_objective
 * obligation. Fixture helper for progression/dependency/recovery tests.
 */
export function completeActiveStageFixture(world: AcceptanceWorld): { commitId: string } {
  // Refresh the world's window AND stage pointers: continuation/activation
  // may have opened a NEW window and activated a NEW stage.
  world.openWindowId = world.ctx.store.withRead(
    (tx) =>
      (tx.prepare("SELECT id FROM verification_windows WHERE execution_run_id = ? AND closed_at IS NULL").get(world.executionRunId) as { id: string })
        .id,
  );
  world.activeStageId = world.ctx.store.withRead(
    (tx) =>
      (tx.prepare("SELECT id FROM execution_stages WHERE execution_run_id = ? AND status = 'active'").get(world.executionRunId) as { id: string }).id,
  );
  const stageId = world.activeStageId;
  const stage = world.ctx.store.withRead((tx) => getExecutionStageInTx(tx, stageId))!;
  const requirement = deriveStageCompletionValidationRequirement(stage);
  runVerificationCycle(world, { directiveOverrides: { validationRequirements: [requirement] } });
  const result = acceptanceServiceOf(world).submitSupervisorAssessment(
    acceptInput(world, { coveredObligations: [stageObjectiveObligation(stage)] }) as never,
  ) as { stageCompleted: boolean; commit: { commitId: string } | null };
  if (!result.stageCompleted || result.commit === null) {
    throw new Error("fixture stage completion failed");
  }
  return { commitId: result.commit.commitId };
}

/** Drive a supervisor execution operation through the real MCP dispatcher. */
export function supervisorCall(
  world: E4World,
  tool: string,
  business: Record<string, unknown> = {},
  sessionId = world.f.sessionId,
): Record<string, unknown> {
  return executePhasePlanTool(world.ctx, tool, {
    ...business,
    _hostContext: executionToken(world.ctx, {
      sessionId,
      workspaceId: world.f.workspaceId,
      runId: world.executionRunId,
      finalPlanId: world.f.finalPlanId,
      generation: world.f.generation,
      tool,
      business,
    }),
  }) as Record<string, unknown>;
}

/** Current candidate revision of the world's open window (-1 when none open). */
export function currentRevision(world: E4World): number {
  return world.ctx.store.withRead((tx) => {
    const row = tx
      .prepare("SELECT candidate_revision AS revision FROM verification_windows WHERE execution_run_id = ? AND closed_at IS NULL")
      .get(world.executionRunId) as { revision: number } | undefined;
    return row?.revision ?? -1;
  });
}

/** The acceptance service bound to the world (service-level gate calls). */
export function acceptanceServiceOf(world: E4World) {
  return createAcceptanceService(world.ctx.store, world.ctx.clock);
}

/** E6 §35 — open the successor window over the current accepted head. */
export function openSuccessorWindow(world: E4World): { window: { id: string; candidateRevision: number; baseKind: string; baseCommitId: string | null; openedAt: string }; baseCommitId: string } {
  const result = world.ctx.store.withWrite((tx) =>
    openNextWindowForActiveStageInTx(tx, { executionRunId: world.executionRunId }, world.ctx.clock, world.ctx.clock.nowIso()),
  );
  // Keep the world's "current open window" pointer fresh for later directives.
  world.openWindowId = result.window.id;
  return result;
}

/** Minimal valid accept input over the world's current authority context. */
export function acceptInput(
  world: AcceptanceWorld,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    executionRunId: world.executionRunId,
    sessionId: world.f.sessionId,
    workspaceId: world.f.workspaceId,
    generation: world.f.generation,
    disposition: "accept",
    rationale: "Verifier evidence covers the exact candidate; no blockers remain.",
    reportJudgments: world.verReportId === null ? [] : [{ report_id: world.verReportId, disposition: "supporting" }],
    coveredObligations: [],
    expectedCandidateRevision: currentRevision(world),
    ...overrides,
  };
}

/** Take supervision ownership to a different session (E2 takeover, G+1). */
export function takeoverTo(world: E4World, newSessionId: string): number {
  return world.ctx.store.withWrite((tx) => {
    const binding = takeoverSupervisorBindingInTx(
      tx,
      {
        executionRunId: world.executionRunId,
        workspaceId: world.f.workspaceId,
        newSessionId,
        expectedGeneration: world.f.generation,
      },
      world.ctx.clock.nowIso(),
    );
    return binding.generation;
  });
}

export { directiveInput, codeOf };

/** The thrown error message (SQLite RAISE messages carry no stable code). */
export function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return "no-error";
}
