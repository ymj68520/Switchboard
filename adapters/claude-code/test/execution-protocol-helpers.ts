/**
 * Shared fixtures for the v0.2.0 E4 execution-protocol focused tests.
 *
 * A "world" is the full E1→E3 frozen baseline driven through the real MCP
 * handlers: approved FinalPlan → handoff delivery → active ExecutionRun with
 * an attached SupervisorBinding (generation 1) and a bootstrapped structure
 * (one active Stage, one open Window at candidateRevision 0).
 */
import { createHandoffService } from "../src/application/handoff-service.js";
import {
  createExecutionDirectiveService,
  issueExecutionDirectiveInTx,
  type IssueExecutionDirectiveInput,
} from "../src/application/execution-directive-service.js";
import {
  createExecutionAttemptService,
  startExecutionAttemptInTx,
  type StartExecutionAttemptInput,
} from "../src/application/execution-attempt-service.js";
import {
  createExecutionReportService,
  submitExecutionReportInTx,
  type SubmitExecutionReportInput,
} from "../src/application/execution-report-service.js";
import { getExecutionStructureInTx } from "../src/application/execution-structure-service.js";
import { advanceCandidateRevisionInTx } from "../src/store/execution-structure.js";
import type { DirectiveReportContract, ExecutionCapabilityEnvelope } from "../src/core/execution-directive.js";
import type { SubmitExecutionReportInput as ReportInput } from "../src/application/execution-report-service.js";
import { callHandoff, makeApprovedFinalPlanFixture, type ApprovedFinalPlanFixture } from "./phase14-helpers.js";
import type { PhasePlanToolContext } from "../src/mcp/tools.js";
import type { StoreClock } from "../src/store/migration-runner.js";

export function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as { code?: string }).code ?? "no-error";
  }
  return "no-error";
}

export interface E4World {
  f: ApprovedFinalPlanFixture;
  ctx: PhasePlanToolContext;
  executionRunId: string;
  activeStageId: string;
  openWindowId: string;
}

/** Drive the full frozen baseline to an active run with bootstrapped structure. */
export async function makeActiveExecutionWorld(sessionId = "S1"): Promise<E4World> {
  const { f, ctx } = await makeApprovedFinalPlanFixture(sessionId);
  const prepared = callHandoff(ctx, f, { toolUseId: `${sessionId}-DELIVER` });
  const result = createHandoffService(ctx.store, ctx.clock).finalizeDelivery({
    runId: f.runId,
    sessionId: f.sessionId,
    toolUseId: `${sessionId}-DELIVER`,
    responseHandoffId: prepared.handoff_id,
    responseHandoffHash: prepared.handoff_hash,
  });
  if (result.executionRun === null) throw new Error("fixture activation failed");
  // A1 §16 — the fixture's execution identity is the canonical ExecutionRunID.
  const executionRunId = result.executionRun.executionRunId;
  const structure = ctx.store.withRead((tx) => getExecutionStructureInTx(tx, executionRunId));
  if (structure.activeStage === null || structure.openWindow === null) {
    throw new Error("fixture structure missing");
  }
  return {
    f,
    ctx,
    executionRunId,
    activeStageId: structure.activeStage.id,
    openWindowId: structure.openWindow.id,
  };
}

/** The explicit complete envelope (E4 §15) — every field spelled out. */
export function fullEnvelope(overrides: Partial<ExecutionCapabilityEnvelope> = {}): ExecutionCapabilityEnvelope {
  return {
    repositoryRead: true,
    repositoryWrite: false,
    commandExecution: false,
    networkAccess: false,
    dependencyMutation: false,
    gitCommit: false,
    gitPush: false,
    externalServiceMutation: false,
    ...overrides,
  };
}

/** A contract with no mandatory sections (the smallest legal report contract). */
export function openContract(): DirectiveReportContract {
  return {
    requireActionsPerformed: false,
    requireFilesExamined: false,
    requireFilesChanged: false,
    requireCommandsRun: false,
    requireTestsRun: false,
    requireFindings: false,
    requireDeviations: false,
    requireBlockers: false,
    requireDeliverables: false,
  };
}

/** Minimal valid issuance input against the world's current authority context. */
export function directiveInput(
  w: E4World,
  overrides: Partial<IssueExecutionDirectiveInput> = {},
): IssueExecutionDirectiveInput {
  return {
    executionRunId: w.executionRunId,
    sessionId: w.f.sessionId,
    workspaceId: w.f.workspaceId,
    generation: w.f.generation,
    kind: "implementation",
    stageId: w.activeStageId,
    windowId: w.openWindowId,
    objective: "Implement the first stage",
    body: "Edit the repository according to the active stage objective.",
    capabilityEnvelope: fullEnvelope(),
    reportContract: openContract(),
    // E8 — every directive is protocol v2 and the Core legality matrix demands
    // an explicit policy: fixtures default to the permissive batchable /
    // normal shapes; overrides (including verificationPolicy) win.
    ...(overrides.kind === "inspection"
      ? {}
      : overrides.kind === "verification"
        ? { verificationPolicy: { verificationPurpose: "normal" as const } }
        : { verificationPolicy: { implementationRequirement: "batchable" as const } }),
    ...overrides,
  };
}

/** Issue one directive through the authoritative InTx core. */
export function issueDirective(w: E4World, overrides: Partial<IssueExecutionDirectiveInput> = {}) {
  return w.ctx.store.withWrite((tx) =>
    issueExecutionDirectiveInTx(tx, directiveInput(w, overrides), w.ctx.clock, w.ctx.clock.nowIso()),
  );
}

export function directiveService(w: E4World) {
  return createExecutionDirectiveService(w.ctx.store, w.ctx.clock);
}

/** Minimal attempt-start input bound to a directive with the exact hash. */
export function attemptInput(
  w: E4World,
  directive: { directiveId: string; revision: number; hash: string },
  overrides: Partial<StartExecutionAttemptInput> = {},
): StartExecutionAttemptInput {
  return {
    executionRunId: w.executionRunId,
    sessionId: w.f.sessionId,
    workspaceId: w.f.workspaceId,
    generation: w.f.generation,
    directiveId: directive.directiveId,
    directiveRevision: directive.revision,
    directiveHash: directive.hash,
    workerRole: "executor",
    ...overrides,
  };
}

export function startAttempt(
  w: E4World,
  directive: { directiveId: string; revision: number; hash: string },
  overrides: Partial<StartExecutionAttemptInput> = {},
) {
  return w.ctx.store.withWrite((tx) =>
    startExecutionAttemptInTx(tx, attemptInput(w, directive, overrides), w.ctx.clock, w.ctx.clock.nowIso()),
  );
}

export function attemptService(w: E4World) {
  return createExecutionAttemptService(w.ctx.store, w.ctx.clock);
}

/** Minimal factual report input (completed / not mutated by default). */
export function reportInput(
  input: { attemptId: string } & Partial<Omit<SubmitExecutionReportInput, "attemptId">>,
): SubmitExecutionReportInput {
  return {
    result: "completed",
    candidateMutated: false,
    ...input,
  };
}

export function submitReport(w: E4World, attemptId: string, overrides: Partial<ReportInput> = {}) {
  // Partial-spread widening: the test helper contractually applies overrides
  // over a complete base, so the assertion-style cast is exact here.
  const input = { ...reportInput({ attemptId }), ...overrides } as ReportInput;
  return w.ctx.store.withWrite((tx) =>
    submitExecutionReportInTx(tx, input, w.ctx.clock, w.ctx.clock.nowIso()),
  );
}

export function reportService(w: E4World) {
  return createExecutionReportService(w.ctx.store, w.ctx.clock);
}

/** The E3 Core CAS primitive, for tests that must move the candidate directly. */
export function advanceCandidate(w: E4World, expectedRevision: number) {
  return w.ctx.store.withWrite((tx) =>
    advanceCandidateRevisionInTx(tx, { executionRunId: w.executionRunId, expectedRevision }),
  );
}

export type { StoreClock };
