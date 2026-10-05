/**
 * v0.2.0 Phase 7B — production supervised handoff cutover tests
 * (directive §4-§7, §9-§19, §28-§37, §54-§55, §58-§67, §81-§82, §90, §96-§104).
 *
 * The REAL production controller path (controller.enter, the durable
 * protocol discriminator, the recoverable handoff state machine) with
 * scripted runtime PORTS — no live model. Legacy free-Build coverage runs on
 * PRE-CUTOVER documents (marker stripped), per §103.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  DurablePlanStore,
  UltraPlanController,
  parseUserExecutionCommand,
  validateModelRef,
  validateProductionExecutionBudgets,
  DEFAULT_PRODUCTION_EXECUTION_BUDGETS,
  planningRunHandoffProtocol,
  EXECUTION_SUPERVISOR_OPERATIONS,
  ULTRA_PLAN_TOOL_NAMES,
  OpenCodeRuntimeAdapter,
  executionInitialHandoffKey,
  type ExecutionIssueID,
  type PlanningRun,
  type SupervisorAssessmentID,
  type WorkspaceIdentity,
} from "../src/index.js";
import {
  FULL_EXEC_CEILING,
  FIXED,
  WORKSPACE,
  checkpointAndComplete,
  dagWorld,
  manifestDraft,
} from "./execution-world.js";
import { FakeSupervisor, FakeWorker } from "./fake-execution-runtime.js";
import {
  PROD_AUTH,
  PROD_OTHER,
  PROD_OWNER,
  productionEnter,
} from "./production-world.js";

/** Tamper helper for durable documents (same pattern as execution-world). */
async function tamperFile(filePath: string, mutate: (raw: Record<string, unknown>) => void): Promise<void> {
  const raw = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
  mutate(raw);
  await writeFile(filePath, JSON.stringify(raw));
}

/** Drive the REAL planning flow on a DURABLE store to handoff_pending (supervised marker durable), then close. */
async function driveDurableFinalApproval(filePath: string, sessionID: string): Promise<void> {
  const store = new DurablePlanStore(filePath, { now: () => FIXED });
  const controller = new UltraPlanController({
    store,
    now: () => FIXED,
    semanticValidator: { async validate() { return { text: JSON.stringify({ result: "clean", findings: [] }) }; } },
  });
  const world = { store, controller };
  await dagWorld(world as never, sessionID);
  await checkpointAndComplete(world as never, sessionID);
  await checkpointAndComplete(world as never, sessionID);
  await checkpointAndComplete(world as never, sessionID);
  await controller.beginSynthesis(sessionID);
  await controller.submitSynthesisManifest(sessionID, manifestDraft());
  await controller.runSemanticValidation(sessionID);
  const finalization = await controller.requestFinalization(sessionID);
  expect(finalization.gate.result).toBe("pass");
  const prepared = await controller.prepareFinalPlan(sessionID);
  const begun = await controller.beginProposalApproval(sessionID, prepared.proposal.id);
  await controller.recordApproval(sessionID, prepared.proposal.id, begun.request);
  await controller.commitApprovedProposal(sessionID, prepared.proposal.id);
  store.close();
}

/** A production controller over a durable store with scripted runtime ports. */
function durableProductionController(store: DurablePlanStore, supervisor: FakeSupervisor, worker: FakeWorker): UltraPlanController {
  const controller = new UltraPlanController({ store, now: () => FIXED });
  controller.attachSupervisedExecution({
    supervisor,
    worker,
    workspace: WORKSPACE,
    policy: { planningModel: undefined, supervisorModel: undefined, workerModel: undefined, verifierModel: undefined },
    trustedCeiling: { ...FULL_EXEC_CEILING },
    budgets: { ...DEFAULT_PRODUCTION_EXECUTION_BUDGETS },
    executionStartBaseline: async () => ({ workspaceFingerprint: "fp-exec-durable" }),
  });
  return controller;
}

// -----------------------------------------------------------------------------
// §4-§7 — the durable handoff protocol discriminator
// -----------------------------------------------------------------------------

describe("§4-§7 — the durable handoff protocol discriminator", () => {
  it("E1/§5/§6: a new Final Approval durably selects supervised_v0_2 in the commit publication", async () => {
    const { approvedFinalPlanWorld } = await import("./production-world.js");
    const world = await approvedFinalPlanWorld();
    const run = (await world.store.getRun(world.runID)) as PlanningRun;
    expect(run.handoffProtocol).toBe("supervised_v0_2");
    expect(planningRunHandoffProtocol(run)).toBe("supervised_v0_2");
  });

  it("§7: a pre-marker run resolves to legacy_v0_1 and is never guessed from artifacts", async () => {
    const { approvedFinalPlanWorld } = await import("./production-world.js");
    const world = await approvedFinalPlanWorld();
    await world.store.saveRun({ ...(await world.store.getRun(world.runID)) as PlanningRun, handoffProtocol: undefined });
    const run = (await world.store.getRun(world.runID)) as PlanningRun;
    expect(run.handoffProtocol).toBeUndefined();
    // No ExecutionRun exists, and none is needed to know the protocol.
    expect(await world.store.findExecutionRunsForPlan(world.runID)).toEqual([]);
    expect(planningRunHandoffProtocol(run)).toBe("legacy_v0_1");
  });

  it("parseUserExecutionCommand — the host-side deterministic argument grammar", () => {
    expect(parseUserExecutionCommand("")).toEqual({ kind: "plan" });
    expect(parseUserExecutionCommand("build a parser")).toEqual({ kind: "plan", goal: "build a parser" });
    expect(parseUserExecutionCommand("new build a parser")).toEqual({ kind: "new", goal: "build a parser" });
    expect(parseUserExecutionCommand("resume")).toEqual({ kind: "resume" });
    expect(parseUserExecutionCommand("resume exec-002")).toEqual({ kind: "resume", executionRunID: "EXEC-002" });
    expect(parseUserExecutionCommand("resume EXEC-002 --takeover")).toEqual({ kind: "takeover", executionRunID: "EXEC-002" });
    expect(parseUserExecutionCommand("takeover EXEC-002")).toEqual({ kind: "takeover", executionRunID: "EXEC-002" });
    expect(parseUserExecutionCommand("abort EXEC-003")).toEqual({ kind: "abort", executionRunID: "EXEC-003" });
    // A bare "abort" is NOT a valid abort — it degrades to a goal, never a guess.
    expect(parseUserExecutionCommand("abort")).toEqual({ kind: "plan", goal: "abort" });
    expect(parseUserExecutionCommand("replan")).toEqual({ kind: "replan" });
    expect(parseUserExecutionCommand("replan EXEC-001")).toEqual({ kind: "replan", executionRunID: "EXEC-001" });
  });
});

// -----------------------------------------------------------------------------
// §96/E85 — production controller routing matrix
// -----------------------------------------------------------------------------

describe("§96/E85 — production controller routing matrix", () => {
  it("supervised handoff_pending + plain /ultra-plan → recovery drives A→E and the pump runs (E13)", async () => {
    const { approvedFinalPlanWorld } = await import("./production-world.js");
    const world = await approvedFinalPlanWorld();
    world.supervisor.script = [() => ({ outcome: "awaiting_supervisor", note: "first look" } as const)];
    const result = await productionEnter(world.controller, PROD_OWNER, "");
    expect(result.kind).toBe("supervised");
    const entry = (result as { kind: "supervised"; entry: { status: string } }).entry;
    expect(entry.status).toBe("handoff_recovered");
    // §15/§16/E9/E11 — activation happened BEFORE the PlanningRun completion,
    // and completion no longer means Build delivery.
    expect(((await world.store.getRun(world.runID)) as PlanningRun).lifecycle).toBe("completed");
    const executionRun = (await world.store.findExecutionRunsForPlan(world.runID))[0]!;
    expect(executionRun.lifecycle).toBe("active");
    expect(executionRun.id).toBe("EXEC-001");
    // The legacy Build adapter was never called (E72).
    expect(world.legacyHost.dispatches).toHaveLength(0);
    // The initial owner is the TRUSTED user session (§13/E7).
    const binding = await world.store.findSupervisorBinding(executionRun.id as never);
    expect(binding!.ownerSessionID).toBe(PROD_OWNER);
    expect(binding!.generation).toBe(1);
  });

  it("§30/E55: same-session /ultra-plan after completion resumes the SAME supervised run — no new PlanningRun", async () => {
    const { approvedFinalPlanWorld } = await import("./production-world.js");
    const world = await approvedFinalPlanWorld();
    world.supervisor.script = [() => ({ outcome: "awaiting_supervisor", note: "yield one" } as const)];
    await productionEnter(world.controller, PROD_OWNER, "");
    const before = (await world.store.findLatestRunBySession(PROD_OWNER)) as PlanningRun;
    world.supervisor.script = [() => ({ outcome: "awaiting_supervisor", note: "yield two" } as const)];
    const second = await productionEnter(world.controller, PROD_OWNER, "");
    expect((second as { kind: "supervised"; entry: { status: string } }).entry.status).toBe("resumed");
    const after = (await world.store.findLatestRunBySession(PROD_OWNER)) as PlanningRun;
    expect(after.id).toBe(before.id);
    expect(await world.store.findExecutionRunsForPlan(world.runID)).toHaveLength(1);
  });

  it("§32/E27: a different session surfaces requires_takeover with owner identity — NO mutation", async () => {
    const { approvedFinalPlanWorld } = await import("./production-world.js");
    const world = await approvedFinalPlanWorld();
    world.supervisor.script = [() => ({ outcome: "awaiting_supervisor", note: "boot" } as const)];
    await productionEnter(world.controller, PROD_OWNER, "");
    const runRevisionBefore = ((await world.store.getExecutionRun("EXEC-001" as never))!).revision;
    const other = await productionEnter(world.controller, PROD_OTHER, "");
    const entry = (other as { kind: "supervised"; entry: { status: string; ownerSessionID?: string; statusText: string } }).entry;
    expect(entry.status).toBe("requires_takeover");
    expect(entry.ownerSessionID).toBe(PROD_OWNER);
    expect(entry.statusText).toContain("--takeover");
    // The store never moved.
    const executionRun = (await world.store.getExecutionRun("EXEC-001" as never))!;
    expect(executionRun.revision).toBe(runRevisionBefore);
  });

  it("§31/E26: multiple recoverable runs are ambiguous — never a latest-pick", async () => {
    const { approvedFinalPlanWorld, prodInitialHandoffKey } = await import("./production-world.js");
    const world = await approvedFinalPlanWorld();
    // Two crash-window runs; the FIRST one is adopted by the recovery machine
    // (attach + activate) before the planning completion lands.
    for (const key of [prodInitialHandoffKey(world), `${world.runID}/two`]) {
      await world.store.prepareInitialExecutionRun({
        planID: world.runID,
        finalPlan: { id: world.finalPlan.id, revision: world.finalPlan.revision },
        finalPlanHash: world.finalPlan.hash,
        workspace: WORKSPACE,
        executionStartBaseline: { workspaceFingerprint: `fp-${key}` },
        initialHandoffKey: key,
      } as never);
    }
    const runs = await world.store.findExecutionRunsForPlan(world.runID);
    expect(runs).toHaveLength(2);
    await world.store.attachExecutionSupervisor({ executionRunID: runs[0]!.id, sessionID: PROD_OWNER, workspace: WORKSPACE });
    await world.store.activateSupervisedExecutionRun({
      executionRunID: runs[0]!.id,
      sessionID: PROD_OWNER,
      workspace: WORKSPACE,
      generation: 1,
      runRevision: runs[0]!.revision,
      finalPlan: runs[0]!.finalPlan,
    });
    await world.store.completePlanningRunForSupervisedHandoff(world.runID);
    // The planning run is no longer the router's entry — the workspace scan
    // sees TWO recoverable runs and refuses to pick.
    const result = await productionEnter(world.controller, PROD_OWNER, "");
    const entry = (result as { kind: "supervised"; entry: { status: string; candidateRunIDs?: string[]; statusText: string } }).entry;
    expect(entry.status).toBe("ambiguous");
    expect(entry.candidateRunIDs!.length).toBe(2);
    expect(entry.statusText).toContain("ambiguous_execution_run");
  });

  it("§66-4/§41: plain /ultra-plan continuation after replan_required starts replanning FROM the issue (E33/E34/E36)", async () => {
    const { approvedFinalPlanWorld, prodInitialHandoffKey } = await import("./production-world.js");
    const world = await approvedFinalPlanWorld();
    // Drive a terminal replan_required run (state machine + frozen §7 judgment).
    const { run } = await world.store.prepareInitialExecutionRun({
      planID: world.runID,
      finalPlan: { id: world.finalPlan.id, revision: world.finalPlan.revision },
      finalPlanHash: world.finalPlan.hash,
      workspace: WORKSPACE,
      executionStartBaseline: { workspaceFingerprint: "fp-replan" },
      initialHandoffKey: prodInitialHandoffKey(world),
    } as never);
    await world.store.attachExecutionSupervisor({ executionRunID: run.id, sessionID: PROD_OWNER, workspace: WORKSPACE });
    const active = await world.store.activateSupervisedExecutionRun({
      executionRunID: run.id,
      sessionID: PROD_OWNER,
      workspace: WORKSPACE,
      generation: 1,
      runRevision: run.revision,
      finalPlan: run.finalPlan,
    });
    await world.store.completePlanningRunForSupervisedHandoff(world.runID);
    const [stage] = await world.store.createExecutionStages({
      executionRunID: active.id,
      ...PROD_AUTH,
      drafts: [
        {
          title: "Stage 1",
          objective: "objective",
          planRefs: [{ kind: "implementation_step", order: 1 }],
          completionObligations: [{ description: "O1", planRefs: [{ kind: "implementation_step" as const, order: 1 }] }],
        },
      ],
    } as never);
    const activated = await world.store.activateExecutionStage({
      executionRunID: active.id,
      stageID: stage!.id,
      ...PROD_AUTH,
      expectedRunRevision: (await world.store.getExecutionRun(active.id))!.revision,
      expectedStageRevision: stage!.revision,
    } as never);
    const opened = await world.store.openVerificationWindow({
      executionRunID: active.id,
      stageID: stage!.id,
      ...PROD_AUTH,
      expectedRunRevision: activated.run.revision,
      expectedStageRevision: activated.stage.revision,
    } as never);
    const liveStage = (await world.store.getExecutionStage(stage!.id))!;
    const directive = await world.store.issueExecutionDirective({
      executionRunID: active.id,
      stageID: stage!.id,
      windowID: opened.window.id,
      ...PROD_AUTH,
      ceiling: FULL_EXEC_CEILING,
      expectedRunRevision: opened.run.revision,
      expectedStageRevision: liveStage.revision,
      expectedWindowRevision: opened.window.revision,
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
      },
    } as never);
    const { attempt } = await world.store.startExecutionAttempt({
      executionRunID: active.id,
      directive: { id: directive.id, revision: directive.revision },
      ...PROD_AUTH,
      ceiling: FULL_EXEC_CEILING,
    } as never);
    await world.store.submitExecutionReport({
      executionRunID: active.id,
      attemptID: attempt.id,
      ...PROD_AUTH,
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
        baseCandidateRevision: opened.window.candidateRevision,
        resultingCandidateRevision: opened.window.candidateRevision + 1,
      },
    } as never);
    // The executor report advanced the candidate — bind the CURRENT one.
    const liveWindow = (await world.store.findOpenVerificationWindow(active.id))!;
    await world.store.submitSupervisorAssessment({
      executionRunID: active.id,
      stageID: stage!.id,
      windowID: liveWindow.id,
      candidateRevision: liveWindow.candidateRevision,
      ...PROD_AUTH,
      draft: {
        reportRefs: [],
        planRefs: [],
        coveredObligations: [],
        acceptanceScope: "window",
        disposition: "request_replan",
        rationale: "the approved design cannot deliver obligation 1",
      },
    } as never);
    const liveRun = (await world.store.getExecutionRun(active.id))!;
    const assessments = await world.store.listSupervisorAssessmentsForRun(active.id);
    const source = assessments.find((assessment) => assessment.disposition === "request_replan")!;
    await world.store.transitionExecutionRunToReplanRequired({
      executionRunID: active.id,
      ...PROD_AUTH,
      sourceAssessmentID: source.id as SupervisorAssessmentID,
      reason: "the approved design omits the recovery boundary",
      affectedPlanRefs: [{ kind: "final_plan", id: world.finalPlan.id, revision: world.finalPlan.revision }],
      expectedRunRevision: liveRun.revision,
    } as never);

    const before = (await world.store.findLatestRunBySession(PROD_OWNER)) as PlanningRun;
    const result = await productionEnter(world.controller, PROD_OWNER, "");
    const entry = (result as { kind: "supervised"; entry: { status: string; planningRunID?: string; statusText: string } }).entry;
    expect(entry.status).toBe("replan_started");
    const newRun = (await world.store.getRun(entry.planningRunID as never)) as PlanningRun;
    expect(newRun.id).not.toBe(before.id);
    expect(newRun.lifecycle).toBe("active");
    // §42/E36 — exact ExecutionIssue provenance.
    expect(newRun.replanProvenance!.priorExecutionRun).toBe(active.id);
    expect(newRun.replanProvenance!.priorFinalPlan.hash).toBe(world.finalPlan.hash);
    expect(newRun.replanProvenance!.sourceExecutionIssue.executionRunID).toBe(active.id);
    // §39 — the issue is surfaced, never silent.
    expect(entry.statusText).toContain("REPLAN");
    expect(entry.statusText).toContain("recovery boundary");
    // §46/§47 — the old planning run stays completed; the old run stays terminal.
    expect(before.lifecycle).toBe("completed");
    expect(((await world.store.getExecutionRun(active.id))!).lifecycle).toBe("replan_required");
  });
});

// -----------------------------------------------------------------------------
// §68/E57 — the supervised handoff crash matrix (durable H1-H5)
// -----------------------------------------------------------------------------

describe("§68/E57 — the supervised handoff crash matrix", () => {
  it("H1: marker durable + ExecutionRun absent → recovery prepares the SAME run; recovery never duplicates it (§98/E87/E6)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ultra-plan-7b-h1-"));
    try {
      const filePath = path.join(dir, "plan-store.json");
      await driveDurableFinalApproval(filePath, PROD_OWNER);
      const supervisor = new FakeSupervisor([]);
      const worker = new FakeWorker([]);
      const store = new DurablePlanStore(filePath, { now: () => FIXED });
      const controller = durableProductionController(store, supervisor, worker);
      supervisor.script = [() => ({ outcome: "awaiting_supervisor", note: "h1" } as const)];
      const result = await productionEnter(controller, PROD_OWNER, "");
      expect((result as { kind: "supervised"; entry: { status: string } }).entry.status).toBe("handoff_recovered");
      const run = (await store.findExecutionRunsForPlan("PLAN-001" as never))[0]!;
      expect(run.id).toBe("EXEC-001");
      expect(run.executionStartBaseline.workspaceFingerprint).toBe("fp-exec-durable");
      expect(((await store.getRun("PLAN-001" as never)) as PlanningRun).lifecycle).toBe("completed");
      // Repeat recovery: SAME run, ONE binding, generation unchanged (§99/E88).
      supervisor.script = [() => ({ outcome: "awaiting_supervisor", note: "h1 again" } as const)];
      await productionEnter(controller, PROD_OWNER, "");
      expect(await store.findExecutionRunsForPlan("PLAN-001" as never)).toHaveLength(1);
      expect((await store.findSupervisorBinding(run.id))!.generation).toBe(1);
      store.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("H2: prepared-without-binding → recovery attaches the SAME trusted owner (§13/E7)", async () => {
    const { approvedFinalPlanWorld, prodInitialHandoffKey } = await import("./production-world.js");
    const world = await approvedFinalPlanWorld();
    const { run } = await world.store.prepareInitialExecutionRun({
      planID: world.runID,
      finalPlan: { id: world.finalPlan.id, revision: world.finalPlan.revision },
      finalPlanHash: world.finalPlan.hash,
      workspace: WORKSPACE,
      executionStartBaseline: { workspaceFingerprint: "fp-h2" },
      initialHandoffKey: prodInitialHandoffKey(world),
    } as never);
    expect(await world.store.findSupervisorBinding(run.id)).toBeUndefined();
    world.supervisor.script = [() => ({ outcome: "awaiting_supervisor", note: "h2" } as const)];
    const entered = await productionEnter(world.controller, PROD_OWNER, "");
    expect((entered as { kind: "supervised"; entry: { status: string } }).entry.status).toBe("handoff_recovered");
    const binding = await world.store.findSupervisorBinding(run.id);
    expect(binding!.ownerSessionID).toBe(PROD_OWNER);
    expect(((await world.store.getRun(world.runID)) as PlanningRun).lifecycle).toBe("completed");
    // H3 replay on the activated state: idempotent — same run, same generation.
    world.supervisor.script = [() => ({ outcome: "awaiting_supervisor", note: "h3" } as const)];
    const again = await productionEnter(world.controller, PROD_OWNER, "");
    expect((again as { kind: "supervised"; entry: { status: string } }).entry.status).toBe("resumed");
    expect((await world.store.findSupervisorBinding(run.id))!.generation).toBe(1);
    expect(await world.store.findExecutionRunsForPlan(world.runID)).toHaveLength(1);
  });

  it("H4: active + PlanningRun handoff_pending → recovery completes ONLY the PlanningRun handoff (§15)", async () => {
    const { approvedFinalPlanWorld, prodInitialHandoffKey } = await import("./production-world.js");
    const world = await approvedFinalPlanWorld();
    const { run } = await world.store.prepareInitialExecutionRun({
      planID: world.runID,
      finalPlan: { id: world.finalPlan.id, revision: world.finalPlan.revision },
      finalPlanHash: world.finalPlan.hash,
      workspace: WORKSPACE,
      executionStartBaseline: { workspaceFingerprint: "fp-h4" },
      initialHandoffKey: prodInitialHandoffKey(world),
    } as never);
    await world.store.attachExecutionSupervisor({ executionRunID: run.id, sessionID: PROD_OWNER, workspace: WORKSPACE });
    // Crash window: activation happened, the PlanningRun completion did not.
    await world.store.activateSupervisedExecutionRun({
      executionRunID: run.id,
      sessionID: PROD_OWNER,
      workspace: WORKSPACE,
      generation: 1,
      runRevision: run.revision,
      finalPlan: run.finalPlan,
    });
    expect(((await world.store.getRun(world.runID)) as PlanningRun).lifecycle).toBe("handoff_pending");
    world.supervisor.script = [() => ({ outcome: "awaiting_supervisor", note: "h4" } as const)];
    const entered = await productionEnter(world.controller, PROD_OWNER, "");
    expect((entered as { kind: "supervised"; entry: { status: string } }).entry.status).toBe("handoff_recovered");
    // The planning run completed; NOTHING was recreated or re-attached.
    expect(((await world.store.getRun(world.runID)) as PlanningRun).lifecycle).toBe("completed");
    expect(await world.store.findExecutionRunsForPlan(world.runID)).toHaveLength(1);
    expect((await world.store.findSupervisorBinding(run.id))!.generation).toBe(1);
  });

  it("H5: active + PlanningRun completed + first Supervisor turn pending → the pump resumes from canonical state (§20)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ultra-plan-7b-h5-"));
    try {
      const filePath = path.join(dir, "plan-store.json");
      await driveDurableFinalApproval(filePath, PROD_OWNER);
      const supervisor = new FakeSupervisor([]);
      const worker = new FakeWorker([]);
      {
        const store = new DurablePlanStore(filePath, { now: () => FIXED });
        const controller = durableProductionController(store, supervisor, worker);
        supervisor.script = [() => ({ outcome: "awaiting_supervisor", note: "activate only" } as const)];
        await productionEnter(controller, PROD_OWNER, "");
        store.close();
      }
      // Fresh process: the FIRST real Supervisor turn happens now, from the store.
      {
        const store = new DurablePlanStore(filePath, { now: () => FIXED });
        const controller = durableProductionController(store, supervisor, worker);
        let derived = false;
        supervisor.script = [
          async () => {
            derived = true;
            const stages = await store.listExecutionStagesForRun("EXEC-001" as never);
            expect(stages).toHaveLength(0); // §23/§24 — the HOST did not auto-create Stages.
            return { outcome: "awaiting_supervisor", note: "h5 derivation turn" } as const;
          },
        ];
        const result = await productionEnter(controller, PROD_OWNER, "");
        expect((result as { kind: "supervised"; entry: { status: string } }).entry.status).toBe("resumed");
        expect(derived).toBe(true);
        store.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// -----------------------------------------------------------------------------
// §17/§18/§82/E3/E4/E72/E94 — legacy path isolation
// -----------------------------------------------------------------------------

describe("§17/§18/§82/E3/E4/E72/E94 — legacy path isolation", () => {
  it("§94/E4: the store REFUSES legacy handoff artifacts under a supervised run (source-level unreachability)", async () => {
    const { approvedFinalPlanWorld } = await import("./production-world.js");
    const world = await approvedFinalPlanWorld();
    const { assembleExecutionHandoff } = await import("../src/index.js");
    const run = (await world.store.getRun(world.runID)) as PlanningRun;
    const finalPlan = (await world.store.getCurrentFinalPlan(world.runID))!;
    const { handoff } = assembleExecutionHandoff({
      run,
      finalPlan,
      requiredContracts: [],
      assign: { id: "HANDOFF-001", now: FIXED },
    });
    await expect(world.store.saveExecutionHandoff(world.runID, handoff)).rejects.toMatchObject({ code: "handoff_not_allowed" });
    const result = await world.controller.recoverExecutionHandoff(PROD_OWNER);
    expect(result.status).toBe("blocked");
    expect((result as { code?: string }).code).toBe("handoff_not_allowed");
  });

  it("§18/§81/E3/E71: a PRE-CUTOVER legacy handoff still recovers through the old path — and never creates a supervised run", async () => {
    const { approvedFinalPlanWorld } = await import("./production-world.js");
    const world = await approvedFinalPlanWorld();
    await world.store.saveRun({ ...(await world.store.getRun(world.runID)) as PlanningRun, handoffProtocol: undefined });
    const result = await world.controller.maybeRecoverHandoff(PROD_OWNER);
    expect(result?.status).toBe("completed");
    expect(await world.store.findExecutionRunsForPlan(world.runID)).toHaveLength(0);
    expect(((await world.store.getRun(world.runID)) as PlanningRun).lifecycle).toBe("completed");
  });

  it("§97/E86: supervised marker + legacy delivery artifacts fails store open", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ultra-plan-7b-lv1-"));
    try {
      const filePath = path.join(dir, "plan-store.json");
      await driveDurableFinalApproval(filePath, "ses_lv1");
      await tamperFile(filePath, (raw) => {
        (raw["executionHandoffs"] as Record<string, Record<string, unknown>>)["PLAN-001"] = {
          "HANDOFF-001": { id: "HANDOFF-001" },
        };
      });
      expect(() => new DurablePlanStore(filePath, { now: () => FIXED }).open()).toThrowError(
        /supervised_v0_2 handoff protocol but carries legacy/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("§97/E86: legacy marker + supervised execution state fails store open; unknown protocol fails open", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ultra-plan-7b-lv2-"));
    try {
      const filePath = path.join(dir, "plan-store.json");
      await driveDurableFinalApproval(filePath, "ses_lv2");
      await tamperFile(filePath, (raw) => {
        // Strip the marker (pre-cutover document) and add execution state.
        for (const runRecord of Object.values(raw["runs"] as Record<string, Record<string, unknown>>)) {
          delete runRecord["handoffProtocol"];
        }
        (raw["executionRuns"] as Record<string, Record<string, unknown>>)["EXEC-001"] = {
          id: "EXEC-001",
          planID: "PLAN-001",
        };
      });
      expect(() => new DurablePlanStore(filePath, { now: () => FIXED }).open()).toThrowError(
        /legacy \(pre-marker\) handoff but carries supervised execution state/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    const dir2 = await mkdtemp(path.join(tmpdir(), "ultra-plan-7b-lv3-"));
    try {
      const filePath = path.join(dir2, "plan-store.json");
      await driveDurableFinalApproval(filePath, "ses_lv3");
      await tamperFile(filePath, (raw) => {
        (raw["runs"] as Record<string, Record<string, unknown>>)["PLAN-001"]!["handoffProtocol"] = "supervised_v9";
      });
      expect(() => new DurablePlanStore(filePath, { now: () => FIXED }).open()).toThrowError(/unknown handoffProtocol/);
    } finally {
      await rm(dir2, { recursive: true, force: true });
    }
  });
});

// -----------------------------------------------------------------------------
// §27/§59/E23/E48 — budgets are configuration, validated fail-closed
// -----------------------------------------------------------------------------

describe("§27/§59/E23/E48 — runtime budgets are configuration, validated fail-closed", () => {
  it("default budgets are valid and complete", () => {
    expect(() => validateProductionExecutionBudgets(DEFAULT_PRODUCTION_EXECUTION_BUDGETS)).not.toThrow();
  });

  it("negative budgets / zero timeouts / fractional timeouts / bad model refs fail closed", () => {
    expect(() => validateProductionExecutionBudgets({ ...DEFAULT_PRODUCTION_EXECUTION_BUDGETS, maxSupervisorTurnsPerPump: 0 })).toThrow(/maxSupervisorTurnsPerPump/);
    expect(() => validateProductionExecutionBudgets({ ...DEFAULT_PRODUCTION_EXECUTION_BUDGETS, workerTimeoutMs: -5 })).toThrow(/workerTimeoutMs/);
    expect(() => validateProductionExecutionBudgets({ ...DEFAULT_PRODUCTION_EXECUTION_BUDGETS, supervisorTimeoutMs: 1.5 })).toThrow(/supervisorTimeoutMs/);
    expect(() => validateModelRef("anthropic/claude-x", "supervisor")).not.toThrow();
    expect(() => validateModelRef("claude-x", "supervisor")).toThrow(/provider\/model/);
    expect(() => validateModelRef("/claude-x", "supervisor")).toThrow(/provider\/model/);
    expect(() => validateModelRef(undefined, "supervisor")).not.toThrow();
  });
});

// -----------------------------------------------------------------------------
// §62/§63/E50-E52 + §34/E29 — role-scoped registration, no model control
// -----------------------------------------------------------------------------

describe("§62/§63/E50-E52 + §34/E29 — role-scoped registration and model control limits", () => {
  it("the plugin config registers planning tools to the planning agent only — no execution mutation tools anywhere", () => {
    const config: Record<string, unknown> = {};
    new OpenCodeRuntimeAdapter().applyToConfig(config as never);
    const agent = (config["agent"] as Record<string, { tools?: Record<string, boolean> }>)["ultraplan"]!;
    expect(Object.keys(agent.tools ?? {}).sort()).toEqual([...ULTRA_PLAN_TOOL_NAMES].sort());
    const serialized = JSON.stringify(config);
    for (const op of EXECUTION_SUPERVISOR_OPERATIONS) {
      expect(serialized).not.toContain(op);
    }
  });

  it("§34/E29: the Supervisor tool surface has NO takeover or abort operation", () => {
    expect([...EXECUTION_SUPERVISOR_OPERATIONS].some((name) => /takeover|abort/i.test(name))).toBe(false);
  });

  it("§33-§36: control actions without a HOST-minted authorization fail closed", async () => {
    const { approvedFinalPlanWorld } = await import("./production-world.js");
    const world = await approvedFinalPlanWorld();
    world.supervisor.script = [() => ({ outcome: "awaiting_supervisor", note: "boot" } as const)];
    await productionEnter(world.controller, PROD_OWNER, "");
    // A model-initiated takeover (no user-typed --takeover) is refused...
    world.controller.issueStartAdmission(PROD_OTHER);
    await expect(world.controller.enter(PROD_OTHER, "resume EXEC-001 --takeover")).rejects.toMatchObject({ code: "start_not_authorized" });
    // ...and a model-initiated abort likewise.
    world.controller.issueStartAdmission(PROD_OWNER);
    await expect(world.controller.enter(PROD_OWNER, "abort EXEC-001")).rejects.toMatchObject({ code: "start_not_authorized" });
  });
});

// -----------------------------------------------------------------------------
// §48/§91/E42/E81 — durable projections only
// -----------------------------------------------------------------------------

describe("§48/§91/E42/E81 — the user-facing projection is durable state only", () => {
  it("status of a supervised handoff_pending run renders the supervised projection (never Build lines)", async () => {
    const { approvedFinalPlanWorld } = await import("./production-world.js");
    const world = await approvedFinalPlanWorld();
    const status = (await world.controller.statusReport(PROD_OWNER)).statusText;
    expect(status).toContain("Supervised execution: handoff pending (ExecutionRun not yet prepared)");
    expect(status).toContain("supervised_v0_2");
    expect(status).not.toContain("Build");
  });

  it("the pump summary carries IDs and durable lifecycle, never model output fields", async () => {
    const { approvedFinalPlanWorld } = await import("./production-world.js");
    const world = await approvedFinalPlanWorld();
    world.supervisor.script = [() => ({ outcome: "awaiting_supervisor", note: "look" } as const)];
    const result = await productionEnter(world.controller, PROD_OWNER, "");
    const entry = (result as { kind: "supervised"; entry: { pump: { summary: { executionRunID: string; planID: string; lifecycle: string } } } }).entry;
    expect(entry.pump.summary.executionRunID).toBe("EXEC-001");
    expect(entry.pump.summary.planID).toBe(world.runID);
    expect(entry.pump.summary.lifecycle).toBe("active");
    expect(Object.keys(entry.pump.summary).some((key) => /reasoning|chain|thought|output/i.test(key))).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// §54-§55/E46 + §28/E24 — yield semantics
// -----------------------------------------------------------------------------

describe("§54-§55/E46 + §28/E24 — yields never mutate the lifecycle", () => {
  it("three consecutive blocked_runtime turns → yielded; resume continues with a fresh budget", async () => {
    const { approvedFinalPlanWorld } = await import("./production-world.js");
    const world = await approvedFinalPlanWorld({ budgets: { maxConsecutiveSupervisorProtocolFailures: 3 } });
    world.supervisor.script = [
      () => ({ outcome: "blocked_runtime", reason: "invalid control output" } as const),
      () => ({ outcome: "blocked_runtime", reason: "invalid control output" } as const),
      () => ({ outcome: "blocked_runtime", reason: "invalid control output" } as const),
    ];
    const result = await productionEnter(world.controller, PROD_OWNER, "");
    const entry = (result as { kind: "supervised"; entry: { status: string; pump: { outcome: string; reason: string } } }).entry;
    expect(entry.status).toBe("handoff_recovered");
    expect(entry.pump.outcome).toBe("yielded");
    expect(entry.pump.reason).toContain("blocked_runtime");
    expect((await world.store.getExecutionRun("EXEC-001" as never))!.lifecycle).toBe("active");
    world.supervisor.script = [() => ({ outcome: "awaiting_supervisor", note: "recovered" } as const)];
    const resumed = await productionEnter(world.controller, PROD_OWNER, "");
    expect((resumed as { kind: "supervised"; entry: { status: string } }).entry.status).toBe("resumed");
  });

  it("§28/E24: a one-turn budget yields immediately with the run active; §29 resume continues", async () => {
    const { approvedFinalPlanWorld } = await import("./production-world.js");
    const world = await approvedFinalPlanWorld({ budgets: { maxSupervisorTurnsPerPump: 1 } });
    world.supervisor.script = [() => ({ outcome: "awaiting_supervisor", note: "one look" } as const)];
    const result = await productionEnter(world.controller, PROD_OWNER, "");
    const entry = (result as { kind: "supervised"; entry: { pump: { outcome: string; reason: string } } }).entry;
    expect(entry.pump.outcome).toBe("yielded");
    expect(entry.pump.reason).toBe("budget_exhausted");
    expect((await world.store.getExecutionRun("EXEC-001" as never))!.lifecycle).toBe("active");
    world.supervisor.script = [() => ({ outcome: "awaiting_supervisor", note: "next pump" } as const)];
    const resumed = await productionEnter(world.controller, PROD_OWNER, "");
    expect((resumed as { kind: "supervised"; entry: { status: string } }).entry.status).toBe("resumed");
  });
});

// -----------------------------------------------------------------------------
// §35-§37/E69 — explicit human abort
// -----------------------------------------------------------------------------

describe("§35-§37/E69 — explicit human abort", () => {
  it("abort marks an unprovable running Attempt indeterminate, terminates the run, and never rolls back", async () => {
    const { approvedFinalPlanWorld, prodInitialHandoffKey } = await import("./production-world.js");
    const world = await approvedFinalPlanWorld();
    // Recover (activate) + set up an open window, then simulate the crash
    // fact: a RUNNING attempt whose worker can no longer answer.
    const { run } = await world.store.prepareInitialExecutionRun({
      planID: world.runID,
      finalPlan: { id: world.finalPlan.id, revision: world.finalPlan.revision },
      finalPlanHash: world.finalPlan.hash,
      workspace: WORKSPACE,
      executionStartBaseline: { workspaceFingerprint: "fp-abort" },
      initialHandoffKey: prodInitialHandoffKey(world),
    } as never);
    await world.store.attachExecutionSupervisor({ executionRunID: run.id, sessionID: PROD_OWNER, workspace: WORKSPACE });
    await world.store.activateSupervisedExecutionRun({
      executionRunID: run.id,
      sessionID: PROD_OWNER,
      workspace: WORKSPACE,
      generation: 1,
      runRevision: run.revision,
      finalPlan: run.finalPlan,
    });
    await world.store.completePlanningRunForSupervisedHandoff(world.runID);
    const [stage] = await world.store.createExecutionStages({
      executionRunID: run.id,
      ...PROD_AUTH,
      drafts: [
        {
          title: "Stage 1",
          objective: "objective",
          planRefs: [{ kind: "implementation_step", order: 1 }],
          completionObligations: [{ description: "O1", planRefs: [{ kind: "implementation_step" as const, order: 1 }] }],
        },
      ],
    } as never);
    const activated = await world.store.activateExecutionStage({
      executionRunID: run.id,
      stageID: stage!.id,
      ...PROD_AUTH,
      expectedRunRevision: (await world.store.getExecutionRun(run.id))!.revision,
      expectedStageRevision: stage!.revision,
    } as never);
    const opened = await world.store.openVerificationWindow({
      executionRunID: run.id,
      stageID: stage!.id,
      ...PROD_AUTH,
      expectedRunRevision: activated.run.revision,
      expectedStageRevision: activated.stage.revision,
    } as never);
    const abortLiveStage = (await world.store.getExecutionStage(stage!.id))!;
    const directive = await world.store.issueExecutionDirective({
      executionRunID: run.id,
      stageID: stage!.id,
      windowID: opened.window.id,
      ...PROD_AUTH,
      ceiling: FULL_EXEC_CEILING,
      expectedRunRevision: opened.run.revision,
      expectedStageRevision: abortLiveStage.revision,
      expectedWindowRevision: opened.window.revision,
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
      },
    } as never);
    await world.store.startExecutionAttempt({
      executionRunID: run.id,
      directive: { id: directive.id, revision: directive.revision },
      ...PROD_AUTH,
      ceiling: FULL_EXEC_CEILING,
    } as never);
    const running = await world.store.findRunningExecutionAttempt(run.id);
    expect(running).toBeDefined();

    // Explicit human abort (host-minted exact-run authorization).
    const aborted = await productionEnter(world.controller, PROD_OWNER, "abort EXEC-001");
    const entry = (aborted as { kind: "supervised"; entry: { status: string; statusText: string } }).entry;
    expect(entry.status).toBe("aborted");
    expect(entry.statusText).toContain("indeterminate");
    expect(entry.statusText).toContain("NOT rolled back");
    const executionRun = (await world.store.getExecutionRun(run.id))!;
    expect(executionRun.lifecycle).toBe("aborted");
    // History retained — the attempt is inspectable and indeterminate.
    const attempts = await world.store.listExecutionAttemptsForRun(run.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.state).toBe("indeterminate");
  });

  it("abort authorization is exact — an authorization for another run does not match", async () => {
    const { approvedFinalPlanWorld } = await import("./production-world.js");
    const world = await approvedFinalPlanWorld();
    world.supervisor.script = [() => ({ outcome: "awaiting_supervisor", note: "boot" } as const)];
    await productionEnter(world.controller, PROD_OWNER, "");
    world.controller.issueStartAdmission(PROD_OWNER);
    world.controller.issueUserExecutionCommand(PROD_OWNER, "abort EXEC-999");
    await expect(world.controller.enter(PROD_OWNER, "abort EXEC-001")).rejects.toMatchObject({ code: "start_not_authorized" });
  });
});

// The branded-id friction seam: the recovery state machine runs against
// WorkspaceIdentity values typed as never at store boundaries.
void (0 as unknown as (workspace: WorkspaceIdentity) => void);
void (0 as unknown as (issue: ExecutionIssueID) => void);
void executionInitialHandoffKey;
