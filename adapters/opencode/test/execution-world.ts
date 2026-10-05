/**
 * Shared world builders for the v0.2.0 execution-foundation suites
 * (execution-run.test.ts, execution-supervisor.test.ts).
 *
 * Drives the REAL v0.1 planning flow (admission → DAG → checkpoints →
 * synthesis → validation → finalization → Final PlanCommit) to the exact
 * handoff_pending entry state both phases build from — the same proven
 * drive pattern the Phase 2H/2I/2J suites use. Test infrastructure only:
 * nothing here is production code.
 */
import { readFile, writeFile } from "node:fs/promises";

import { expect } from "vitest";

import {
  DurablePlanStore,
  InMemoryPlanStore,
  UltraPlanController,
  executionInitialHandoffKey,
  type FinalPlanID,
  type PlanID,
  type SemanticValidator,
  type WorkspaceIdentity,
} from "../src/index.js";
import { admittedStart } from "./helpers.js";
import type { PlanningRun } from "../src/core/types.js";
import type { PrepareInitialExecutionRunInput } from "../src/memory/store.js";

export const FIXED = "2026-09-29T12:00:00.000Z";
export const GOAL = "Build the supervised execution foundation";
export const WORKSPACE: WorkspaceIdentity = { key: "opencode-project:worktree-A" };
export const BASELINE = {
  workspaceFingerprint: "fp-exec-start-001",
  vcs: { type: "git" as const, commit: "abc1234", branch: "main" },
};

export const ARCH_CHANGE = {
  kind: "add_architecture" as const,
  content: {
    architecture: {
      summary: "Completion target",
      components: [{ name: "Core", summary: "kernel" }],
      boundaries: [],
      dataFlows: [],
      principles: [],
    },
  },
};

export const CHAIN_DECOMPOSITION = {
  sections: [
    { key: "runtime", title: "Runtime Integration", objective: "bind to the host" },
    { key: "plan-memory", title: "Plan Memory", objective: "durable authoritative state", dependsOn: ["runtime"] },
    { key: "context", title: "Context Assembly", objective: "deterministic model context", dependsOn: ["plan-memory"] },
  ],
  initialSection: "runtime",
};

export type World = { store: InMemoryPlanStore; controller: UltraPlanController };

/** Minimal v0.1 execution runtime: dispatch accepts and yields a host receipt. */
export const ACCEPTING_HOST = {
  async dispatchHandoff(input: { sessionID: string; deliveryKey: string }) {
    return { accepted: true as const, deliveryKey: input.deliveryKey };
  },
  async findHandoffDelivery(input: { sessionID: string; deliveryKey: string }) {
    return { sessionID: input.sessionID, messageID: "msg_001" };
  },
};

export function makeWorld(options: { validator?: SemanticValidator } = {}) {
  const store = new InMemoryPlanStore(() => FIXED);
  const validator = options.validator ?? { async validate() { return { text: JSON.stringify({ result: "clean", findings: [] }) }; } };
  const controller = new UltraPlanController({
    store,
    now: () => FIXED,
    semanticValidator: validator,
    executionRuntime: { adapter: ACCEPTING_HOST },
  });
  return { store, controller };
}

function checkpointInput(sectionID: "SEC-001" | "SEC-002" | "SEC-003"): Parameters<UltraPlanController["prepareSectionCheckpoint"]>[1] {
  const depID = sectionID === "SEC-001" ? undefined : sectionID === "SEC-002" ? "SEC-001" : "SEC-002";
  return {
    problem: `Problem ${sectionID}`,
    design: `Design ${sectionID}`,
    interfaces: [{ name: `I${sectionID}`, description: "boundary" }],
    invariants: ["invariant one"],
    failureModes: [],
    dependencies: depID ? [{ sectionID: depID as never, consumes: [] }] : [],
    decisions: [],
    openQuestions: [],
    impacts: [],
    projection: {
      compact: `compact ${sectionID}`,
      contract: {
        provides: [`${sectionID.toLowerCase()}-capability`],
        requires: [],
        invariants: ["invariant one"],
        interfaces: [{ name: `I${sectionID}` }],
        decisions: [],
      },
    },
  };
}

export async function dagWorld(world: World, sessionID: string) {
  let run = (await admittedStart(world.controller, sessionID, GOAL)).run;
  await world.controller.requestArchitecture(sessionID);
  const completion = await world.controller.prepareProposal(sessionID, {
    type: "architecture_completion",
    scope: { type: "architecture" },
    title: "Complete architecture",
    summary: "s",
    changes: [ARCH_CHANGE, { kind: "complete_architecture" }] as never,
  });
  const begun = await world.controller.beginProposalApproval(sessionID, completion.proposal.id);
  await world.controller.recordApprovalAndCommit(sessionID, completion.proposal.id, begun.request);
  const decomposition = await world.controller.prepareSectionDecomposition(sessionID, CHAIN_DECOMPOSITION);
  const dagBegun = await world.controller.beginProposalApproval(sessionID, decomposition.proposal.id);
  await world.controller.recordApprovalAndCommit(sessionID, decomposition.proposal.id, dagBegun.request);
  run = (await world.store.getRun(run.id)) as PlanningRun;
  expect(run.stage).toBe("detail");
}

export async function checkpointAndComplete(world: World, sessionID: string): Promise<void> {
  const run = (await world.store.findActiveRunBySession(sessionID)) as PlanningRun;
  const active = run.activeWork?.type === "section" ? run.activeWork.id : undefined;
  if (!active) throw new Error("no active section");
  const prepared = await world.controller.prepareSectionCheckpoint(sessionID, checkpointInput(active as "SEC-001"));
  const begun = await world.controller.beginProposalApproval(sessionID, prepared.proposal.id);
  await world.controller.recordApprovalAndCommit(sessionID, prepared.proposal.id, begun.request);
  const completion = await world.controller.requestCompletion(sessionID, { kind: "section" });
  const completionBegun = await world.controller.beginProposalApproval(sessionID, completion.proposal.id);
  await world.controller.recordApprovalAndCommit(sessionID, completion.proposal.id, completionBegun.request);
}

export function manifestDraft(): Parameters<UltraPlanController["submitSynthesisManifest"]>[1] {
  return {
    crossSectionLinks: [
      {
        statement: "SEC-001 provides isec-001-capability consumed by SEC-002",
        sources: [
          { kind: "section", id: "SEC-001", revision: 1 },
          { kind: "section", id: "SEC-002", revision: 1 },
        ],
      },
    ],
    implementationOrder: [
      {
        title: "Deliver the runtime",
        description: "Implement the three approved sections in dependency order as one delivery wave.",
        sections: [
          { id: "SEC-001", revision: 1 },
          { id: "SEC-002", revision: 1 },
          { id: "SEC-003", revision: 1 },
        ],
        sources: [{ kind: "architecture" }, { kind: "section", id: "SEC-001", revision: 1 }],
      },
    ],
    limitations: [
      {
        statement: "The approved design leaves repository freshness to the Evidence Audit.",
        sources: [{ kind: "architecture" }],
      },
    ],
    unresolvedFindings: [],
  };
}

/**
 * The Phase 1 ENTRY state: handoff_pending with the exact approved FinalPlan
 * committed (the same entry condition the v0.1 handoff freeze requires).
 */
export interface HandoffPendingWorld extends World {
  sessionID: string;
  runID: PlanID;
  finalPlan: { id: FinalPlanID; revision: number; hash: string; baseSnapshot: { id: string }; baseCommit: string | null };
}

export async function handoffPendingWorld(options: { validator?: SemanticValidator } = {}): Promise<HandoffPendingWorld> {
  const world = makeWorld(options);
  const sessionID = "ses_exec";
  await dagWorld(world, sessionID);
  await checkpointAndComplete(world, sessionID);
  await checkpointAndComplete(world, sessionID);
  await checkpointAndComplete(world, sessionID);
  await world.controller.beginSynthesis(sessionID);
  await world.controller.submitSynthesisManifest(sessionID, manifestDraft());
  await world.controller.runSemanticValidation(sessionID);
  const finalization = await world.controller.requestFinalization(sessionID);
  expect(finalization.gate.result).toBe("pass");
  const prepared = await world.controller.prepareFinalPlan(sessionID);
  const begun = await world.controller.beginProposalApproval(sessionID, prepared.proposal.id);
  await world.controller.recordApproval(sessionID, prepared.proposal.id, begun.request);
  await world.controller.commitApprovedProposal(sessionID, prepared.proposal.id);
  const run = (await world.store.findLatestRunBySession(sessionID)) as PlanningRun;
  expect(run.stage).toBe("final");
  expect(run.lifecycle).toBe("handoff_pending");
  // Phase 7B §103 — this world is the PRE-CUTOVER legacy handoff entry state:
  // a real Final Approval now durably records supervised_v0_2, so the legacy
  // compatibility suites strip the marker to simulate the pre-cutover
  // document. (The durable twin below keeps the marker — supervised flows.)
  await world.store.saveRun({ ...run, handoffProtocol: undefined });
  const finalPlan = (await world.store.getCurrentFinalPlan(run.id))!;
  return { ...world, sessionID, runID: run.id, finalPlan };
}

/** Authority input for the DEFAULT initial handoff of the world's FinalPlan. */
export function prepareInput(
  world: { runID: string; finalPlan: { id: string; revision: number; hash: string } },
  overrides: Partial<PrepareInitialExecutionRunInput> = {},
): PrepareInitialExecutionRunInput {
  const planID = world.runID as PlanID;
  const ref = { id: world.finalPlan.id as FinalPlanID, revision: world.finalPlan.revision };
  return {
    planID,
    finalPlan: ref,
    finalPlanHash: world.finalPlan.hash,
    workspace: WORKSPACE,
    executionStartBaseline: BASELINE,
    initialHandoffKey: executionInitialHandoffKey(planID, ref),
    ...overrides,
  };
}

/** Prepare + activate the initial run, returning the activated record. */
export async function prepareAndActivate(world: Awaited<ReturnType<typeof handoffPendingWorld>>): Promise<import("../src/index.js").ExecutionRun> {
  const { run } = await world.store.prepareInitialExecutionRun(prepareInput(world));
  return world.store.activateExecutionRun(run.id, {
    workspace: WORKSPACE,
    runRevision: run.revision,
    finalPlan: run.finalPlan,
  });
}

export interface DurableHandoffPendingWorld {
  store: DurablePlanStore;
  controller: UltraPlanController;
  sessionID: string;
  runID: PlanID;
  finalPlan: { id: FinalPlanID; revision: number; hash: string };
}

/** Drive a REAL planning flow to handoff_pending on a durable store file. */
export async function durableHandoffPendingWorld(filePath: string): Promise<DurableHandoffPendingWorld> {
  const store = new DurablePlanStore(filePath, { now: () => FIXED });
  const controller = new UltraPlanController({
    store,
    now: () => FIXED,
    semanticValidator: { async validate() { return { text: JSON.stringify({ result: "clean", findings: [] }) }; } },
  });
  const sessionID = "ses_exec_durable";
  const world: World = { store, controller };
  await dagWorld(world, sessionID);
  await checkpointAndComplete(world, sessionID);
  await checkpointAndComplete(world, sessionID);
  await checkpointAndComplete(world, sessionID);
  await controller.beginSynthesis(sessionID);
  await controller.submitSynthesisManifest(sessionID, manifestDraft());
  await controller.runSemanticValidation(sessionID);
  const finalization = await controller.requestFinalization(sessionID);
  expect(finalization.gate.result).toBe("pass");
  const prepared = await controller.prepareFinalPlan(sessionID);
  const begun = await controller.beginProposalApproval(sessionID, prepared.proposal.id);
  await controller.recordApproval(sessionID, prepared.proposal.id, begun.request);
  await controller.commitApprovedProposal(sessionID, prepared.proposal.id);
  const run = (await store.findLatestRunBySession(sessionID)) as PlanningRun;
  expect(run.lifecycle).toBe("handoff_pending");
  const finalPlan = (await store.getCurrentFinalPlan(run.id))!;
  return { store, controller, sessionID, runID: run.id, finalPlan };
}

export function makeWorldWithStore(store: InMemoryPlanStore): World {
  return { store, controller: new UltraPlanController({ store, now: () => FIXED }) };
}

/** Rewrite one durable document in place (test-only corruption/migration seam). */
export async function tamper(filePath: string, mutate: (raw: Record<string, unknown>) => void): Promise<void> {
  const raw = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
  mutate(raw);
  await writeFile(filePath, JSON.stringify(raw));
}

/** The document's execution-run family, narrowed for tampering. */
export function executionFamily(raw: Record<string, unknown>): Record<string, Record<string, unknown>> {
  return raw["executionRuns"] as Record<string, Record<string, unknown>>;
}

/** The document's supervisor-binding family, narrowed for tampering. */
export function bindingFamily(raw: Record<string, unknown>): Record<string, Record<string, unknown>> {
  return raw["supervisorBindings"] as Record<string, Record<string, unknown>>;
}

// -- v0.2.0 Phase 6A — supervised-execution escalation helpers ----------------

export const EXEC_OWNER = "ses_phase6_supervisor";
export const EXEC_AUTH = { sessionID: EXEC_OWNER, workspace: WORKSPACE, generation: 1 };
export const FULL_EXEC_CEILING = {
  repositoryRead: true,
  repositoryWrite: true,
  commandExecution: true,
  networkAccess: true,
  dependencyMutation: true,
  gitCommit: true,
  gitPush: true,
  externalServiceMutation: true,
};

/** Structural world shape for the escalation suites. */
export interface SupervisedWorld {
  world: World;
  run: import("../src/index.js").ExecutionRun;
  stage: import("../src/index.js").ExecutionStage;
  window: import("../src/index.js").VerificationWindow;
}

/** Supervised-active world with an obligation-bearing Stage + open window. */
export async function supervisedWorld(loaded?: HandoffPendingWorld, obligations = 1): Promise<SupervisedWorld> {
  const base = (loaded ?? (await handoffPendingWorld())) as unknown as {
    store: World["store"];
    runID: PlanID;
    finalPlan: { id: FinalPlanID; revision: number; hash: string };
  };
  const { run } = await base.store.prepareInitialExecutionRun(prepareInput(base as never));
  await base.store.attachExecutionSupervisor({ executionRunID: run.id, sessionID: EXEC_OWNER, workspace: WORKSPACE });
  const active = await base.store.activateSupervisedExecutionRun({
    executionRunID: run.id,
    sessionID: EXEC_OWNER,
    workspace: WORKSPACE,
    generation: 1,
    runRevision: run.revision,
    finalPlan: run.finalPlan,
  });
  const stages = await base.store.createExecutionStages({
    executionRunID: active.id,
    ...EXEC_AUTH,
    drafts: [
      {
        title: "Stage A",
        objective: "objective",
        planRefs: [{ kind: "implementation_step", order: 1 }],
        dependsOn: [],
        completionObligations: Array.from({ length: obligations }, (_, index) => ({
          description: `Obligation ${index + 1}`,
          planRefs: [{ kind: "implementation_step" as const, order: 1 }],
        })),
      },
    ],
  });
  const stage = stages[0]!;
  const activated = await base.store.activateExecutionStage({
    executionRunID: active.id,
    stageID: stage.id,
    ...EXEC_AUTH,
    expectedRunRevision: active.revision,
    expectedStageRevision: stage.revision,
  });
  const { window, run: openRun } = await base.store.openVerificationWindow({
    executionRunID: active.id,
    stageID: stage.id,
    ...EXEC_AUTH,
    expectedRunRevision: activated.run.revision,
    expectedStageRevision: activated.stage.revision,
  });
  return { world: base as unknown as World, run: openRun, stage: activated.stage, window };
}

/** Issue → start → report helper with LIVE CAS reads (escalation suites). */
export async function execRunDirective(
  world: SupervisedWorld,
  draft: Record<string, unknown>,
  report: Partial<import("../src/worker/report-payload.js").WorkerReportPayload> = {},
) {
  const liveRun = (await world.world.store.getExecutionRun(world.run.id))!;
  const liveStage = (await world.world.store.getExecutionStage(world.stage.id))!;
  const liveWindow = (await world.world.store.findOpenVerificationWindow(world.run.id))!;
  const directive = await world.world.store.issueExecutionDirective({
    executionRunID: world.run.id,
    stageID: world.stage.id,
    windowID: world.window.id,
    ...EXEC_AUTH,
    ceiling: FULL_EXEC_CEILING,
    expectedRunRevision: liveRun.revision,
    expectedStageRevision: liveStage.revision,
    expectedWindowRevision: liveWindow.revision,
    draft: {
      kind: "implementation",
      objective: "work",
      planRefs: [{ kind: "implementation_step", order: 1 }],
      expectedExecutionScope: {},
      capabilityEnvelope: { ...FULL_EXEC_CEILING },
      candidateEffect: "may_mutate",
      invariants: [],
      requiredActions: [],
      forbiddenActions: [],
      validationRequirements: [],
      deliverables: [],
      stopConditions: [],
      reportContract: "",
      body: "b",
      ...draft,
    },
  });
  const { attempt } = await world.world.store.startExecutionAttempt({
    executionRunID: world.run.id,
    directive: { id: directive.id, revision: directive.revision },
    ...EXEC_AUTH,
    ceiling: FULL_EXEC_CEILING,
  });
  await world.world.store.submitExecutionReport({
    executionRunID: world.run.id,
    attemptID: attempt.id,
    ...EXEC_AUTH,
    report: {
      directive: { id: directive.id, revision: directive.revision, hash: directive.hash },
      workerRole: attempt.workerRole as never,
      result: "completed",
      actionsPerformed: [],
      filesExamined: [],
      filesChanged: [],
      commandsRun: [],
      testsRun: [],
      findings: [],
      deviations: [],
      blockers: [],
      deliverables: [],
      candidateMutation: "changed",
      baseCandidateRevision: liveWindow.candidateRevision,
      ...report,
    },
  });
  return { directive, attempt };
}

/** Re-read the live run/stage/window snapshots for CAS-exact calls. */
export async function execLive(world: SupervisedWorld) {
  const run = (await world.world.store.getExecutionRun(world.run.id))!;
  const stage = (await world.world.store.getExecutionStage(world.stage.id))!;
  const window = (await world.world.store.findOpenVerificationWindow(world.run.id))!;
  return { run, stage, window };
}

/**
 * After a window-only commit the run has NO open window; open the next one on
 * the still-active Stage and rebind world.window (the escalation suites'
 * "continue working after a commit" move).
 */
export async function execOpenNextWindow(world: SupervisedWorld) {
  const run = (await world.world.store.getExecutionRun(world.run.id))!;
  const stage = (await world.world.store.getExecutionStage(run.activeStage!))!;
  const { window } = await world.world.store.openVerificationWindow({
    executionRunID: run.id,
    stageID: stage.id,
    ...EXEC_AUTH,
    expectedRunRevision: run.revision,
    expectedStageRevision: stage.revision,
  });
  world.stage = stage;
  world.window = window;
  return window;
}

/** A clean, current, acceptance-purpose qualifying verifier bundle. */
export async function execCleanVerification(
  world: SupervisedWorld,
  coverage: string[] = [],
  draft: Record<string, unknown> = {},
  report: Record<string, unknown> = {},
) {
  return execRunDirective(
    world,
    {
      kind: "verification",
      objective: "verify",
      candidateEffect: "non_mutating",
      capabilityEnvelope: { ...FULL_EXEC_CEILING, repositoryWrite: false },
      ...(coverage.length > 0 ? { verificationCoverage: { obligationRefs: coverage } } : {}),
      ...draft,
    },
    { workerRole: "verifier", candidateMutation: "none", ...report } as never,
  );
}

/** accept-assessment input bound to the LIVE window/candidate. */
export async function execAcceptInput(
  world: SupervisedWorld,
  overrides: Record<string, unknown> = {},
): Promise<import("../src/memory/store.js").SubmitSupervisorAssessmentInput> {
  const { run, stage, window } = await execLive(world);
  const { disposition, acceptanceScope, rationale, assessmentID, coveredObligations, ...rest } = overrides as {
    disposition?: string;
    acceptanceScope?: string;
    rationale?: string;
    assessmentID?: import("../src/core/ids.js").SupervisorAssessmentID;
    coveredObligations?: string[];
  };
  return {
    executionRunID: run.id,
    stageID: stage.id,
    windowID: window.id,
    candidateRevision: window.candidateRevision,
    ...EXEC_AUTH,
    draft: {
      reportRefs: [],
      planRefs: [],
      coveredObligations: (coveredObligations ?? []) as never[],
      acceptanceScope: (acceptanceScope ?? "window") as never,
      disposition: (disposition ?? "accept") as never,
      rationale: rationale ?? "evidence is clean",
      ...(assessmentID !== undefined ? { assessmentID } : {}),
    },
    ...rest,
  } as never;
}
