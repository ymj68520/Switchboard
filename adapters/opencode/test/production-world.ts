/**
 * Production supervised-execution world builders — v0.2.0 Phase 7B.
 *
 * Drives the REAL planning flow through the REAL Final Approval (which now
 * durably records the supervised_v0_2 handoff protocol) and attaches the
 * production controller routing to scripted runtime PORTS (the deterministic
 * fake model runtime of directive §70). Test infrastructure only: this helper
 * imports NO test file.
 */
import { expect } from "vitest";

import {
  InMemoryPlanStore,
  UltraPlanController,
  DEFAULT_PLANNING_RUNTIME_SPEC,
  DEFAULT_PRODUCTION_EXECUTION_BUDGETS,
  resolveExecutionModelPolicy,
  executionInitialHandoffKey,
  type ExecutionRun,
  type ExecutionStage,
  type FinalPlanID,
  type PlanID,
  type PlanningRun,
  type SemanticValidator,
  type SupervisedExecutionBundle,
  type UltraPlanEntryResult,
  type VerificationWindow,
} from "../src/index.js";
import {
  BASELINE,
  FIXED,
  FULL_EXEC_CEILING,
  WORKSPACE,
  checkpointAndComplete,
  dagWorld,
  manifestDraft,
  makeWorld,
  type World,
} from "./execution-world.js";
import { FakeSupervisor, FakeWorker } from "./fake-execution-runtime.js";

/** The trusted OpenCode user session that owns the final-approval handoff (§13). */
export const PROD_OWNER = "ses_prod_owner";
export const PROD_OTHER = "ses_other_session";

export const PROD_AUTH = { sessionID: PROD_OWNER, workspace: WORKSPACE, generation: 1 };

/** LIVE CAS read for production script closures. */
export async function prodLive(
  store: InMemoryPlanStore,
  executionRunID: string,
  stageID: string,
): Promise<{ run: ExecutionRun; stage: ExecutionStage; window: VerificationWindow }> {
  const run = (await store.getExecutionRun(executionRunID as never))!;
  const stage = (await store.getExecutionStage(stageID as never))!;
  const window = (await store.findOpenVerificationWindow(executionRunID as never))!;
  return { run, stage, window };
}

export interface ProductionWorld {
  store: InMemoryPlanStore;
  controller: UltraPlanController;
  sessionID: string;
  runID: PlanID;
  finalPlan: { id: FinalPlanID; revision: number; hash: string };
  supervisor: FakeSupervisor;
  worker: FakeWorker;
  bundle: SupervisedExecutionBundle;
  /** Legacy free-Build host spy — MUST receive zero dispatches for new approvals (§82). */
  legacyHost: { dispatches: unknown[] };
}

export interface ProductionWorldOptions {
  budgets?: Partial<import("../src/index.js").ProductionExecutionBudgets>;
  validator?: SemanticValidator;
}

/**
 * The REAL planning flow driven through the REAL Final Approval. The commit
 * durably records supervised_v0_2 — asserted here (E1).
 */
export async function approvedFinalPlanWorld(options: ProductionWorldOptions = {}): Promise<ProductionWorld> {
  const base = makeWorld({ ...(options.validator ? { validator: options.validator } : {}) });
  const legacyHost = { dispatches: [] as unknown[] };
  // Instrument the LEGACY host so "new approvals never call it" is provable.
  const instrumentedLegacy = {
    async dispatchHandoff(input: { sessionID: string; deliveryKey: string }) {
      legacyHost.dispatches.push(input);
      return { accepted: true as const, deliveryKey: input.deliveryKey };
    },
    async findHandoffDelivery(input: { sessionID: string; deliveryKey: string }) {
      // Accepting host: the delivered marker is observable immediately.
      return { sessionID: input.sessionID, messageID: "msg_legacy_001" };
    },
  };
  const controller = new UltraPlanController({
    store: base.store,
    now: () => FIXED,
    ...(options.validator ? {} : { semanticValidator: { async validate() { return { text: JSON.stringify({ result: "clean", findings: [] }) }; } } }),
    executionRuntime: { adapter: instrumentedLegacy },
  });
  const world: World = { store: base.store, controller };
  const sessionID = PROD_OWNER;
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
  const run = (await base.store.findLatestRunBySession(sessionID)) as PlanningRun;
  expect(run.stage).toBe("final");
  expect(run.lifecycle).toBe("handoff_pending");
  // E1/§5/§8 — the Final Approval transaction ATOMICALLY recorded the marker.
  expect(run.handoffProtocol).toBe("supervised_v0_2");
  const finalPlanRecord = (await base.store.getCurrentFinalPlan(run.id))!;

  const supervisor = new FakeSupervisor([]);
  const worker = new FakeWorker([]);
  const bundle: SupervisedExecutionBundle = {
    supervisor,
    worker,
    workspace: WORKSPACE,
    policy: resolveExecutionModelPolicy({
      ...DEFAULT_PLANNING_RUNTIME_SPEC,
      planningModel: "frontier/prod-plan",
      executionModel: "build/prod-exec",
    }),
    trustedCeiling: FULL_EXEC_CEILING,
    budgets: { ...DEFAULT_PRODUCTION_EXECUTION_BUDGETS, ...(options.budgets ?? {}) },
    executionStartBaseline: async () => BASELINE,
  };
  controller.attachSupervisedExecution(bundle);
  return {
    store: base.store,
    controller,
    sessionID,
    runID: run.id,
    finalPlan: { id: finalPlanRecord.id, revision: finalPlanRecord.revision, hash: finalPlanRecord.hash },
    supervisor,
    worker,
    bundle,
    legacyHost,
  };
}

/**
 * The HOST-side entry used by production tests: mint the start admission and
 * the typed command authorization from RAW user text (exactly what the
 * command hook does), then run the production controller entry.
 */
export async function productionEnter(
  controller: UltraPlanController,
  sessionID: string,
  rawArguments: string,
): Promise<UltraPlanEntryResult> {
  controller.issueStartAdmission(sessionID);
  controller.issueUserExecutionCommand(sessionID, rawArguments);
  return controller.enter(sessionID, rawArguments);
}

/** The scripted happy-path supervisor: the §23 derivation + §70 full execution. */
export function simpleCompletedScript(world: ProductionWorld, options: { windows?: number } = {}): void {
  const store = world.store;
  const runID = "EXEC-001";
  let stageID = "EXEC-S1";
  const windows = options.windows ?? 1;
  const stagesNeeded = Math.max(1, windows);
  world.supervisor.script = [
    // Turn 1 (§23/§24 — the Supervisor derives the decomposition; the Host never does).
    async () => {
      const run = (await store.getExecutionRun(runID as never))!;
      expect(run.lifecycle).toBe("active");
      expect(run.activeStage).toBeUndefined();
      const [stage] = await store.createExecutionStages({
        executionRunID: runID as never,
        ...PROD_AUTH,
        drafts: Array.from({ length: stagesNeeded }, (_, index) => ({
          title: `Stage ${index + 1}`,
          objective: `objective ${index + 1}`,
          planRefs: [{ kind: "implementation_step", order: 1 }],
          ...(index > 0 ? { dependsOn: [`EXEC-S${index}`] } : {}),
          completionObligations: [
            { description: `Obligation ${index + 1}`, planRefs: [{ kind: "implementation_step" as const, order: 1 }] },
          ],
        })),
      } as never);
      stageID = stage!.id;
      return { outcome: "state_mutated", mutation: "execution_create_stages" } as const;
    },
    // Turn 2: activate the first Stage.
    async () => {
      const live = await prodLive(store, runID, stageID);
      await store.activateExecutionStage({
        executionRunID: runID as never,
        stageID: stageID as never,
        ...PROD_AUTH,
        expectedRunRevision: live.run.revision,
        expectedStageRevision: live.stage.revision,
      } as never);
      return { outcome: "state_mutated", mutation: "execution_activate_stage" } as const;
    },
    // Turn 3: open the candidate window.
    async () => {
      const live = await prodLive(store, runID, stageID);
      await store.openVerificationWindow({
        executionRunID: runID as never,
        stageID: stageID as never,
        ...PROD_AUTH,
        expectedRunRevision: live.run.revision,
        expectedStageRevision: live.stage.revision,
      } as never);
      return { outcome: "state_mutated", mutation: "execution_open_window" } as const;
    },
    ...implementationVerificationAcceptSequence(world, () => stageID),
    // Final closure (§68): all ordinary stages complete → prepare → activate → window → verify → accept → gate.
    async () => {
      const run = (await store.getExecutionRun(runID as never))!;
      await store.prepareFinalClosureStage({
        executionRunID: runID as never,
        ...PROD_AUTH,
        expectedRunRevision: run.revision,
        title: "Final integration closure",
        objective: "Verify the approved design end-to-end",
        completionObligations: [
          {
            description: "The approved design holds across the integrated implementation",
            planRefs: [{ kind: "final_plan" as const, id: world.finalPlan.id, revision: world.finalPlan.revision }],
          },
        ],
      } as never);
      return { outcome: "state_mutated", mutation: "execution_prepare_final_closure" } as const;
    },
    async () => {
      const run = (await store.getExecutionRun(runID as never))!;
      const closureStage = (await store.listExecutionStagesForRun(runID as never)).find((stage) => stage.kind === "final_closure")!;
      stageID = closureStage.id;
      await store.activateExecutionStage({
        executionRunID: runID as never,
        stageID: closureStage.id,
        ...PROD_AUTH,
        expectedRunRevision: run.revision,
        expectedStageRevision: closureStage.revision,
      } as never);
      return { outcome: "state_mutated", mutation: "execution_activate_stage" } as const;
    },
    async () => {
      const live = await prodLive(store, runID, stageID);
      await store.openVerificationWindow({
        executionRunID: runID as never,
        stageID: stageID as never,
        ...PROD_AUTH,
        expectedRunRevision: live.run.revision,
        expectedStageRevision: live.stage.revision,
      } as never);
      return { outcome: "state_mutated", mutation: "execution_open_window" } as const;
    },
    async () => {
      const live = await prodLive(store, runID, stageID);
      const directive = await issueProductionDirective(store, runID, live, {
        kind: "verification",
        objective: "final integration verification",
        candidateEffect: "non_mutating",
        capabilityEnvelope: { ...FULL_EXEC_CEILING, repositoryWrite: false },
        verificationCoverage: {
          obligationRefs: [(await store.getExecutionStage(stageID as never))!.completionObligations![0]!.id],
        },
      });
      return { outcome: "directive_issued", directive } as const;
    },
    async () => {
      const live = await prodLive(store, runID, stageID);
      const closureStage = (await store.getExecutionStage(stageID as never))!;
      await store.submitSupervisorAssessment({
        executionRunID: runID as never,
        stageID: stageID as never,
        windowID: live.window.id,
        candidateRevision: live.window.candidateRevision,
        ...PROD_AUTH,
        draft: {
          reportRefs: [],
          planRefs: [],
          coveredObligations: closureStage.completionObligations!.map((obligation) => obligation.id),
          acceptanceScope: "stage",
          disposition: "accept",
          rationale: "final closure verified",
        },
      } as never);
      return { outcome: "state_mutated", mutation: "execution_submit_assessment" } as const;
    },
    async () => {
      await store.completeExecutionRunThroughGate({ executionRunID: runID as never, ...PROD_AUTH } as never);
      return { outcome: "state_mutated", mutation: "execution_complete_run" } as const;
    },
  ];
}

/** Issue impl → verify → accept turns for the CURRENT window (one candidate cycle). */
function implementationVerificationAcceptSequence(
  world: ProductionWorld,
  stageID: () => string,
): import("./fake-execution-runtime.js").SupervisorScriptStep[] {
  const store = world.store;
  const runID = "EXEC-001";
  return [
    async () => {
      const live = await prodLive(store, runID, stageID());
      const directive = await issueProductionDirective(store, runID, live, {
        kind: "implementation",
        objective: "implement the stage",
        candidateEffect: "may_mutate",
      });
      return { outcome: "directive_issued", directive } as const;
    },
    async () => {
      const live = await prodLive(store, runID, stageID());
      const obligation = (await store.getExecutionStage(stageID() as never))!.completionObligations![0]!.id;
      const directive = await issueProductionDirective(store, runID, live, {
        kind: "verification",
        objective: "verify the candidate",
        candidateEffect: "non_mutating",
        capabilityEnvelope: { ...FULL_EXEC_CEILING, repositoryWrite: false },
        verificationCoverage: { obligationRefs: [obligation] },
      });
      return { outcome: "directive_issued", directive } as const;
    },
    async () => {
      const live = await prodLive(store, runID, stageID());
      const obligation = (await store.getExecutionStage(stageID() as never))!.completionObligations![0]!.id;
      await store.submitSupervisorAssessment({
        executionRunID: runID as never,
        stageID: stageID() as never,
        windowID: live.window.id,
        candidateRevision: live.window.candidateRevision,
        ...PROD_AUTH,
        draft: {
          reportRefs: [],
          planRefs: [],
          coveredObligations: [obligation],
          acceptanceScope: "stage",
          disposition: "accept",
          rationale: "clean verifier",
        },
      } as never);
      return { outcome: "state_mutated", mutation: "execution_submit_assessment" } as const;
    },
  ];
}

/** Issue an immutable Directive with LIVE CAS reads (script helper). */
export async function issueProductionDirective(
  store: InMemoryPlanStore,
  runID: string,
  live: { run: ExecutionRun; stage: ExecutionStage; window: VerificationWindow },
  draft: Record<string, unknown>,
): Promise<{ id: string; revision: number; hash: string; kind: string }> {
  const directive = await store.issueExecutionDirective({
    executionRunID: runID as never,
    stageID: live.stage.id,
    windowID: live.window.id,
    ...PROD_AUTH,
    ceiling: FULL_EXEC_CEILING,
    expectedRunRevision: live.run.revision,
    expectedStageRevision: live.stage.revision,
    expectedWindowRevision: live.window.revision,
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
  } as never);
  return { id: directive.id, revision: directive.revision, hash: directive.hash, kind: directive.kind };
}

/** The initial-handoff identity used by the production recovery (§11). */
export function prodInitialHandoffKey(world: { runID: PlanID; finalPlan: { id: FinalPlanID; revision: number } }): string {
  return executionInitialHandoffKey(world.runID, { id: world.finalPlan.id, revision: world.finalPlan.revision });
}
