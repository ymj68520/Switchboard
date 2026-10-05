/**
 * v0.2.0 Phase 7B — production end-to-end supervised execution
 * (directive §70-§80: simple/multi-window/rework/conflict/reconciliation/
 * verifier-crash/replan/takeover/yield E2E).
 *
 * Every test drives the REAL production controller path
 * (/ultra-plan → Final Approval → supervised handoff → ExecutionOrchestrator
 * pump) with a deterministic fake model runtime (scripted PORTS). The legacy
 * Build host is instrumented in every world and must receive ZERO calls.
 */
import { describe, expect, it } from "vitest";

import type {
  ExecutionRun,
  ExecutionStage,
  InMemoryPlanStore,
  PlanningRun,
  VerificationWindow,
} from "../src/index.js";
import {
  FULL_EXEC_CEILING,
  WORKSPACE,
  checkpointAndComplete,
  dagWorld,
  manifestDraft,
} from "./execution-world.js";
import { reportedPayload } from "./fake-execution-runtime.js";
import type { SupervisorScriptStep } from "./fake-execution-runtime.js";
import {
  PROD_AUTH,
  PROD_OTHER,
  PROD_OWNER,
  approvedFinalPlanWorld,
  productionEnter,
  simpleCompletedScript,
  type ProductionWorld,
} from "./production-world.js";

// -- script helpers ------------------------------------------------------------

type Live = { run: ExecutionRun; stage: ExecutionStage; window: VerificationWindow };

async function live(store: InMemoryPlanStore, runID: string, stageID: string): Promise<Live> {
  const run = (await store.getExecutionRun(runID as never))!;
  const stage = (await store.getExecutionStage(stageID as never))!;
  const window = (await store.findOpenVerificationWindow(runID as never))!;
  return { run, stage, window };
}

async function issue(
  store: InMemoryPlanStore,
  runID: string,
  l: Live,
  draft: Record<string, unknown>,
): Promise<{ id: string; revision: number; hash: string; kind: string }> {
  const directive = await store.issueExecutionDirective({
    executionRunID: runID as never,
    stageID: l.stage.id,
    windowID: l.window.id,
    ...PROD_AUTH,
    ceiling: FULL_EXEC_CEILING,
    expectedRunRevision: l.run.revision,
    expectedStageRevision: l.stage.revision,
    expectedWindowRevision: l.window.revision,
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

/** Mutable state the script closures share (the stage currently in focus). */
interface ScriptState {
  stageID: string;
}

/** Turns 1-3: derive one ordinary Stage, activate it, open its window. */
function setupTurns(world: ProductionWorld, state: ScriptState): SupervisorScriptStep[] {
  const store = world.store;
  const runID = "EXEC-001";
  return [
    async () => {
      const [stage] = await store.createExecutionStages({
        executionRunID: runID as never,
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
      state.stageID = stage!.id;
      return { outcome: "state_mutated", mutation: "execution_create_stages" } as const;
    },
    async () => {
      const run = (await store.getExecutionRun(runID as never))!;
      const stage = (await store.getExecutionStage(state.stageID as never))!;
      await store.activateExecutionStage({
        executionRunID: runID as never, stageID: stage.id, ...PROD_AUTH,
        expectedRunRevision: run.revision, expectedStageRevision: stage.revision,
      } as never);
      return { outcome: "state_mutated", mutation: "execution_activate_stage" } as const;
    },
    async () => {
      const run = (await store.getExecutionRun(runID as never))!;
      const stage = (await store.getExecutionStage(state.stageID as never))!;
      await store.openVerificationWindow({
        executionRunID: runID as never, stageID: stage.id, ...PROD_AUTH,
        expectedRunRevision: run.revision, expectedStageRevision: stage.revision,
      } as never);
      return { outcome: "state_mutated", mutation: "execution_open_window" } as const;
    },
  ];
}

/** One candidate cycle on the current window: impl → verify → accept. */
function cycleTurns(
  world: ProductionWorld,
  state: ScriptState,
  options: { acceptanceScope: "window" | "stage"; verify?: "clean" | "defect"; label?: string } = { acceptanceScope: "window" },
): SupervisorScriptStep[] {
  const store = world.store;
  const runID = "EXEC-001";
  return [
    async () => {
      const directive = await issue(store, runID, await live(store, runID, state.stageID), {
        objective: `${options.label ?? "cycle"} implementation`,
      });
      return { outcome: "directive_issued", directive } as const;
    },
    async () => {
      const obligation = (await store.getExecutionStage(state.stageID as never))!.completionObligations![0]!.id;
      const directive = await issue(store, runID, await live(store, runID, state.stageID), {
        kind: "verification",
        objective: `${options.label ?? "cycle"} verification`,
        candidateEffect: "non_mutating",
        capabilityEnvelope: { ...FULL_EXEC_CEILING, repositoryWrite: false },
        verificationCoverage: { obligationRefs: [obligation] },
      });
      return { outcome: "directive_issued", directive } as const;
    },
    async () => {
      const l = await live(store, runID, state.stageID);
      const obligation = (await store.getExecutionStage(state.stageID as never))!.completionObligations![0]!.id;
      await store.submitSupervisorAssessment({
        executionRunID: runID as never, stageID: l.stage.id, windowID: l.window.id,
        candidateRevision: l.window.candidateRevision, ...PROD_AUTH,
        draft: {
          reportRefs: [], planRefs: [],
          coveredObligations: options.acceptanceScope === "stage" ? [obligation] : [],
          acceptanceScope: options.acceptanceScope,
          disposition: "accept",
          rationale: `${options.label ?? "cycle"} accepted`,
        },
      } as never);
      return { outcome: "state_mutated", mutation: "execution_submit_assessment" } as const;
    },
  ];
}

/** The bare stage-scope accept turn over the CURRENT window candidate. */
function acceptStageTurn(world: ProductionWorld, state: ScriptState, label: string): SupervisorScriptStep {
  const store = world.store;
  const runID = "EXEC-001";
  return async () => {
    const l = await live(store, runID, state.stageID);
    const obligation = (await store.getExecutionStage(state.stageID as never))!.completionObligations![0]!.id;
    await store.submitSupervisorAssessment({
      executionRunID: runID as never, stageID: l.stage.id, windowID: l.window.id,
      candidateRevision: l.window.candidateRevision, ...PROD_AUTH,
      draft: {
        reportRefs: [], planRefs: [],
        coveredObligations: [obligation],
        acceptanceScope: "stage",
        disposition: "accept",
        rationale: label,
      },
    } as never);
    return { outcome: "state_mutated", mutation: "execution_submit_assessment" } as const;
  };
}

/** The final-closure tail: prepare → activate → window → verify → accept → gate. */
function closureTurns(world: ProductionWorld, state: ScriptState): SupervisorScriptStep[] {
  const store = world.store;
  const runID = "EXEC-001";
  return [
    async () => {
      const run = (await store.getExecutionRun(runID as never))!;
      await store.prepareFinalClosureStage({
        executionRunID: runID as never, ...PROD_AUTH, expectedRunRevision: run.revision,
        title: "Final integration closure", objective: "verify end-to-end",
        completionObligations: [
          { description: "design holds", planRefs: [{ kind: "final_plan" as const, id: world.finalPlan.id, revision: world.finalPlan.revision }] },
        ],
      } as never);
      return { outcome: "state_mutated", mutation: "execution_prepare_final_closure" } as const;
    },
    async () => {
      const run = (await store.getExecutionRun(runID as never))!;
      const closureStage = (await store.listExecutionStagesForRun(runID as never)).find((stage) => stage.kind === "final_closure")!;
      state.stageID = closureStage.id;
      await store.activateExecutionStage({
        executionRunID: runID as never, stageID: closureStage.id, ...PROD_AUTH,
        expectedRunRevision: run.revision, expectedStageRevision: closureStage.revision,
      } as never);
      return { outcome: "state_mutated", mutation: "execution_activate_stage" } as const;
    },
    async () => {
      const run = (await store.getExecutionRun(runID as never))!;
      const stage = (await store.getExecutionStage(state.stageID as never))!;
      await store.openVerificationWindow({
        executionRunID: runID as never, stageID: stage.id, ...PROD_AUTH,
        expectedRunRevision: run.revision, expectedStageRevision: stage.revision,
      } as never);
      return { outcome: "state_mutated", mutation: "execution_open_window" } as const;
    },
    async () => {
      const obligation = (await store.getExecutionStage(state.stageID as never))!.completionObligations![0]!.id;
      const directive = await issue(store, runID, await live(store, runID, state.stageID), {
        kind: "verification",
        objective: "final verification",
        candidateEffect: "non_mutating",
        capabilityEnvelope: { ...FULL_EXEC_CEILING, repositoryWrite: false },
        verificationCoverage: { obligationRefs: [obligation] },
      });
      return { outcome: "directive_issued", directive } as const;
    },
    async () => {
      const l = await live(store, runID, state.stageID);
      const closureStage = (await store.getExecutionStage(state.stageID as never))!;
      await store.submitSupervisorAssessment({
        executionRunID: runID as never, stageID: l.stage.id, windowID: l.window.id,
        candidateRevision: l.window.candidateRevision, ...PROD_AUTH,
        draft: {
          reportRefs: [], planRefs: [],
          coveredObligations: closureStage.completionObligations!.map((obligation) => obligation.id),
          acceptanceScope: "stage", disposition: "accept", rationale: "closure verified",
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

const EXECUTOR_CHANGED = (input: Parameters<typeof reportedPayload>[0]) =>
  ({ kind: "reported", payload: reportedPayload(input, { candidateMutation: "changed" }) }) as const;
const CLEAN = (input: Parameters<typeof reportedPayload>[0]) =>
  ({ kind: "reported", payload: reportedPayload(input) }) as const;

async function expectCompleted(world: ProductionWorld): Promise<void> {
  const result = await productionEnter(world.controller, PROD_OWNER, "");
  const entry = (result as { kind: "supervised"; entry: { status: string; pump: { outcome: string; terminal?: string } } }).entry;
  expect(entry.pump.outcome).toBe("terminal");
  expect(entry.pump.terminal).toBe("completed");
  expect(((await world.store.getExecutionRun("EXEC-001" as never))!).lifecycle).toBe("completed");
  expect(await world.store.findExecutionCompletionForRun("EXEC-001" as never)).toBeDefined();
  expect(world.legacyHost.dispatches).toHaveLength(0);
}

// -----------------------------------------------------------------------------
// E2E flows
// -----------------------------------------------------------------------------

describe("§70/E59/E60 — simple full production-path E2E reaches ExecutionRun.completed", () => {
  it("runs the whole protocol through controller.enter with NO free-Build invocation", async () => {
    const world = await approvedFinalPlanWorld();
    simpleCompletedScript(world);
    world.worker.script = [
      (input) => EXECUTOR_CHANGED(input),
      (input) => CLEAN(input),
      (input) => CLEAN(input), // final closure verification (fresh verifier)
    ];
    await expectCompleted(world);
    // The first Supervisor turn derived the decomposition; the Host did not (E14).
    const stages = await world.store.listExecutionStagesForRun("EXEC-001" as never);
    expect(stages.length).toBeGreaterThanOrEqual(2); // ordinary + final_closure
    // Roles through the ONE common worker protocol (§E41): fresh verifier at the end.
    expect(world.worker.invocations.map((invocation) => invocation.attempt.workerRole)).toEqual([
      "executor",
      "verifier",
      "verifier",
    ]);
    expect(executionAcceptedHead((await world.store.getExecutionRun("EXEC-001" as never))!)).toBe("EC-002");
  });
});

function executionAcceptedHead(run: ExecutionRun): string | undefined {
  return run.acceptedHead;
}
void 0 as unknown as (run: ExecutionRun | undefined) => void;

describe("§71/E61 — multi-window: acceptedHead advances linearly across two windows of ONE stage", () => {
  it("two candidate windows on one ordinary stage, commits in strict order, then completion", async () => {
    const world = await approvedFinalPlanWorld();
    const state: ScriptState = { stageID: "STAGE-001" };
    world.supervisor.script = [
      ...setupTurns(world, state),
      ...cycleTurns(world, state, { acceptanceScope: "window", label: "window-1" }),
      // Window 2 on the SAME active stage.
      async () => {
        const run = (await world.store.getExecutionRun("EXEC-001" as never))!;
        const stage = (await world.store.getExecutionStage(state.stageID as never))!;
        await world.store.openVerificationWindow({
          executionRunID: "EXEC-001" as never, stageID: stage.id, ...PROD_AUTH,
          expectedRunRevision: run.revision, expectedStageRevision: stage.revision,
        } as never);
        return { outcome: "state_mutated", mutation: "execution_open_window" } as const;
      },
      ...cycleTurns(world, state, { acceptanceScope: "stage", label: "window-2" }),
      ...closureTurns(world, state),
    ];
    world.worker.script = [
      (input) => EXECUTOR_CHANGED(input),
      (input) => CLEAN(input),
      (input) => EXECUTOR_CHANGED(input),
      (input) => CLEAN(input),
      (input) => CLEAN(input), // final closure
    ];
    await expectCompleted(world);
    expect((await world.store.getExecutionRun("EXEC-001" as never))!.acceptedHead).toBe("EC-003");
    const commits = await world.store.listExecutionCommitsForRun("EXEC-001" as never);
    expect(commits.map((commit) => commit.id)).toEqual(["EC-001", "EC-002", "EC-003"]);
    // Both ordinary windows ran on EXEC-S1, sequentially, candidate advancing.
    const windows = await world.store.listVerificationWindowsForRun("EXEC-001" as never);
    expect(windows[0]!.stageID).toBe(windows[1]!.stageID); // both windows on the ONE ordinary stage
    // The linear candidate progression is proven by the commit chain above;
    // the two windows ran on the SAME ordinary stage sequentially.
  });
});

describe("§72/E62 — rework: a blocking verifier defect performs rework + fresh verification, never an automatic conflict", () => {
  it("rework raises the candidate and a FRESH verifier accepts", async () => {
    const world = await approvedFinalPlanWorld();
    const state: ScriptState = { stageID: "STAGE-001" };
    world.supervisor.script = [
      ...setupTurns(world, state),
      // Cycle 1: impl → verify → (defect observed; NO accept, NO conflict).
      async () => {
        const directive = await issue(world.store, "EXEC-001", await live(world.store, "EXEC-001", state.stageID), { objective: "initial work" });
        return { outcome: "directive_issued", directive } as const;
      },
      async () => {
        const obligation = (await world.store.getExecutionStage(state.stageID as never))!.completionObligations![0]!.id;
        const directive = await issue(world.store, "EXEC-001", await live(world.store, "EXEC-001", state.stageID), {
          kind: "verification", objective: "verify candidate 1",
          candidateEffect: "non_mutating",
          capabilityEnvelope: { ...FULL_EXEC_CEILING, repositoryWrite: false },
          verificationCoverage: { obligationRefs: [obligation] },
        });
        return { outcome: "directive_issued", directive } as const;
      },
      // The Supervisor REWORKS (implementation directive again) — §72.
      async () => {
        const directive = await issue(world.store, "EXEC-001", await live(world.store, "EXEC-001", state.stageID), { objective: "rework after defect" });
        return { outcome: "directive_issued", directive } as const;
      },
      async () => {
        const obligation = (await world.store.getExecutionStage(state.stageID as never))!.completionObligations![0]!.id;
        const directive = await issue(world.store, "EXEC-001", await live(world.store, "EXEC-001", state.stageID), {
          kind: "verification", objective: "fresh verification after rework",
          candidateEffect: "non_mutating",
          capabilityEnvelope: { ...FULL_EXEC_CEILING, repositoryWrite: false },
          verificationCoverage: { obligationRefs: [obligation] },
        });
        return { outcome: "directive_issued", directive } as const;
      },
      acceptStageTurn(world, state, "post-rework fresh verifier clean"),
      ...closureTurns(world, state),
    ];
    world.worker.script = [
      (input) => EXECUTOR_CHANGED(input), // initial implementation
      (input) =>
        ({
          kind: "reported",
          payload: reportedPayload(input, {
            findings: [{ statement: "the invariant is violated", acceptanceImpact: "blocking" }],
          }),
        }) as const, // verifier DEFECT
      (input) => EXECUTOR_CHANGED(input), // rework
      (input) => CLEAN(input), // fresh verifier — clean
      (input) => CLEAN(input), // final closure
    ];
    await expectCompleted(world);
    // NO conflict was created by anyone (E62).
    expect(await world.store.listVerificationConflictsForRun("EXEC-001" as never)).toEqual([]);
    expect(world.worker.invocations.map((invocation) => invocation.attempt.workerRole)).toEqual([
      "executor", "verifier", "executor", "verifier", "verifier",
    ]);
  });
});

describe("§74/E64 — side-effecting indeterminate attempt performs reconciliation and continues", () => {
  it("indeterminate may_mutate executor → inspection → reconciliation → fresh verification → accept → completion", async () => {
    const world = await approvedFinalPlanWorld();
    const state: ScriptState = { stageID: "STAGE-001" };
    const store = world.store;
    const runID = "EXEC-001";
    let inspectionTargets: string[] = [];
    let inspectionDirective: { id: string; revision: number };
    world.supervisor.script = [
      ...setupTurns(world, state),
      async () => {
        const directive = await issue(store, runID, await live(store, runID, state.stageID), { objective: "mutating work" });
        return { outcome: "directive_issued", directive } as const;
      },
      // The Supervisor reads recovery: reconciliation is REQUIRED and targets exactly the lost attempt.
      async () => {
        const recovery = (await store.buildExecutionRecoveryContext(runID as never, { sessionID: PROD_OWNER }))!;
        expect(recovery.reconciliationRequired).toBe(true);
        inspectionTargets = recovery.unresolvedSideEffectingAttempts.map((attempt) => attempt.id);
        expect(inspectionTargets).toHaveLength(1);
        const directive = await issue(store, runID, await live(store, runID, state.stageID), {
          kind: "inspection",
          objective: "reconcile the interrupted candidate",
          candidateEffect: "non_mutating",
          capabilityEnvelope: {
            repositoryRead: true, repositoryWrite: false, commandExecution: false, networkAccess: false,
            dependencyMutation: false, gitCommit: false, gitPush: false, externalServiceMutation: false,
          },
          reconciliationTargets: inspectionTargets,
        });
        inspectionDirective = { id: directive.id, revision: directive.revision };
        return { outcome: "directive_issued", directive } as const;
      },
      // The inspection came back "unchanged" → record the durable reconciliation.
      async () => {
        const l = await live(store, runID, state.stageID);
        await store.recordAttemptReconciliation({
          executionRunID: runID as never,
          stageID: l.stage.id,
          windowID: l.window.id,
          ...PROD_AUTH,
          targetAttemptIDs: inspectionTargets as never,
          inspectionDirective: { id: inspectionDirective.id as never, revision: inspectionDirective.revision },
        } as never);
        const recovery = (await store.buildExecutionRecoveryContext(runID as never, { sessionID: PROD_OWNER }))!;
        expect(recovery.reconciliationRequired).toBe(false);
        return { outcome: "state_mutated", mutation: "execution_record_reconciliation" } as const;
      },
      ...cycleTurns(world, state, { acceptanceScope: "stage", label: "post-reconciliation" }),
      ...closureTurns(world, state),
    ];
    world.worker.script = [
      () => ({ kind: "indeterminate", reason: "timeout" } as const), // the lost executor (may_mutate)
      (input) =>
        ({
          kind: "reported",
          payload: reportedPayload(input, { reconciliationObservation: "unchanged" }),
        }) as const, // reconciliation inspection (executor role, non-mutating)
      (input) => EXECUTOR_CHANGED(input), // real implementation
      (input) => CLEAN(input), // fresh verifier
      (input) => CLEAN(input), // final closure
    ];
    await expectCompleted(world);
    // The reconciliation is durable and the run finished clean.
    const attempts = await store.listExecutionAttemptsForRun(runID as never);
    expect(attempts[0]!.state).toBe("indeterminate");
    expect(attempts[0]!.candidateEffect).toBe("may_mutate");
  });
});

describe("§75/E65 — non-mutating verifier interruption does NOT perform reconciliation", () => {
  it("indeterminate verifier → NO reconciliation mode → fresh VerificationDirective → clean accept", async () => {
    const world = await approvedFinalPlanWorld();
    const state: ScriptState = { stageID: "STAGE-001" };
    const store = world.store;
    const runID = "EXEC-001";
    world.supervisor.script = [
      ...setupTurns(world, state),
      async () => {
        const directive = await issue(store, runID, await live(store, runID, state.stageID), { objective: "mutating work" });
        return { outcome: "directive_issued", directive } as const;
      },
      // Verify #1 — its worker is lost (non_mutating).
      async () => {
        const directive = await issue(store, runID, await live(store, runID, state.stageID), {
          kind: "verification", objective: "verify candidate 1",
          candidateEffect: "non_mutating",
          capabilityEnvelope: { ...FULL_EXEC_CEILING, repositoryWrite: false },
        });
        return { outcome: "directive_issued", directive } as const;
      },
      // The verifier was interrupted — recovery shows NO reconciliation requirement (P0 §4).
      async () => {
        const recovery = (await store.buildExecutionRecoveryContext(runID as never, { sessionID: PROD_OWNER }))!;
        expect(recovery.reconciliationRequired).toBe(false);
        expect(recovery.nonMutatingInterruptedAttempts).toHaveLength(1);
        // A FRESH verification directive on the same candidate (never a replay of the consumed revision).
        const obligation = (await store.getExecutionStage(state.stageID as never))!.completionObligations![0]!.id;
        const directive = await issue(store, runID, await live(store, runID, state.stageID), {
          kind: "verification",
          objective: "fresh verification after interruption",
          candidateEffect: "non_mutating",
          capabilityEnvelope: { ...FULL_EXEC_CEILING, repositoryWrite: false },
          verificationCoverage: { obligationRefs: [obligation] },
        });
        return { outcome: "directive_issued", directive } as const;
      },
      acceptStageTurn(world, state, "fresh verifier clean after interruption"),
      ...closureTurns(world, state),
    ];
    world.worker.script = [
      (input) => EXECUTOR_CHANGED(input), // implementation
      () => ({ kind: "indeterminate", reason: "host_lost_result" } as const), // interrupted verifier (non_mutating)
      (input) => CLEAN(input), // fresh verifier — clean
      (input) => CLEAN(input), // final closure
    ];
    await expectCompleted(world);
    expect(await store.listVerificationConflictsForRun(runID as never)).toEqual([]);
    const recovery = (await store.buildExecutionRecoveryContext(runID as never, { sessionID: PROD_OWNER }))!;
    expect(recovery.reconciliationRequired).toBe(false);
  });
});

describe("§73/E63 — true conflict uses exactly ONE conflict-resolution verifier", () => {
  it("conflict → one resolver → resolved → fresh ordinary acceptance verifier → commit", async () => {
    const world = await approvedFinalPlanWorld();
    const state: ScriptState = { stageID: "STAGE-001" };
    const store = world.store;
    const runID = "EXEC-001";
    let conflictID: string | undefined;
    world.supervisor.script = [
      ...setupTurns(world, state),
      async () => {
        const directive = await issue(store, runID, await live(store, runID, state.stageID), { objective: "disputed work" });
        return { outcome: "directive_issued", directive } as const;
      },
      // TWO verifiers disagree on the same candidate.
      async () => {
        const directive = await issue(store, runID, await live(store, runID, state.stageID), {
          kind: "verification", objective: "verifier A",
          candidateEffect: "non_mutating",
          capabilityEnvelope: { ...FULL_EXEC_CEILING, repositoryWrite: false },
        });
        return { outcome: "directive_issued", directive } as const;
      },
      async () => {
        const directive = await issue(store, runID, await live(store, runID, state.stageID), {
          kind: "verification", objective: "verifier B",
          candidateEffect: "non_mutating",
          capabilityEnvelope: { ...FULL_EXEC_CEILING, repositoryWrite: false },
        });
        return { outcome: "directive_issued", directive } as const;
      },
      // The Supervisor adjudicates: ONE disputed-fact record between the two reports.
      async () => {
        const l = await live(store, runID, state.stageID);
        const reports = (await store.listExecutionReportsForRun(runID as never)).filter((report) => report.workerRole === "verifier");
        expect(reports).toHaveLength(2);
        const failed = reports.find((report) => report.result === "failed")!;
        const clean = reports.find((report) => report.result === "completed")!;
        const { conflict } = await store.createVerificationConflict({
          executionRunID: runID as never,
          stageID: l.stage.id,
          windowID: l.window.id,
          candidateRevision: l.window.candidateRevision,
          ...PROD_AUTH,
          evidenceA: { kind: "report_result", reportID: failed.id },
          evidenceB: { kind: "report_result", reportID: clean.id },
          claimA: "the feature is broken",
          claimB: "the feature works",
          resolutionQuestion: "Does the feature work on the current candidate?",
        } as never);
        void failed;
        void clean;
        conflictID = conflict.id;
        // THE one conflict-resolution directive (blinded one-resolver protocol).
        const directive = await issue(store, runID, l, {
          kind: "verification",
          objective: "resolve the disputed fact",
          candidateEffect: "non_mutating",
          capabilityEnvelope: { ...FULL_EXEC_CEILING, repositoryWrite: false, commandExecution: false },
          verificationPurpose: "conflict_resolution",
          conflictID: conflict.id,
        });
        return { outcome: "directive_issued", directive } as const;
      },
      // Resolved (supports_a neutralizes B) → a FRESH ordinary acceptance verifier is still required.
      async () => {
        const directive = await issue(store, runID, await live(store, runID, state.stageID), {
          kind: "verification", objective: "fresh acceptance verification",
          candidateEffect: "non_mutating",
          capabilityEnvelope: { ...FULL_EXEC_CEILING, repositoryWrite: false },
        });
        return { outcome: "directive_issued", directive } as const;
      },
      ...cycleTurns(world, state, { acceptanceScope: "stage", label: "post-conflict" }),
      ...closureTurns(world, state),
    ];
    world.worker.script = [
      (input) => EXECUTOR_CHANGED(input), // implementation
      (input) =>
        ({
          kind: "reported",
          payload: reportedPayload(input, { result: "failed" }),
        }) as const, // verifier A: failed
      (input) => CLEAN(input), // verifier B: completed (contradicts A)
      (input) =>
        ({
          kind: "reported",
          payload: reportedPayload(input, { conflictResolutionOutcome: "supports_b" }),
        }) as const, // THE one resolver — B (clean) is right; the failed report is neutralized
      (input) => CLEAN(input), // fresh ordinary acceptance verifier
      (input) => EXECUTOR_CHANGED(input), // post-conflict cycle implementation
      (input) => CLEAN(input), // post-conflict cycle verification
      (input) => CLEAN(input), // final closure
    ];
    await expectCompleted(world);
    const conflict = (await store.getVerificationConflict(conflictID! as never))!;
    expect(conflict.status).toBe("resolved");
    expect(conflict.resolutionOutcome).toBe("supports_b");
    // No majority vote machinery: exactly ONE resolver attempt exists.
    const resolverReports = (await store.listExecutionReportsForRun(runID as never)).filter(
      (report) => report.conflictResolutionOutcome !== undefined,
    );
    expect(resolverReports).toHaveLength(1);
  });
});

describe("§76/§77/E66/E67 — REPLAN production E2E: terminal old run → NEW PlanningRun → NEW ExecutionRun", () => {
  it("worker blocked → request_replan → pump stops → replan entry → new approval → EXEC-002", async () => {
    const { approvedFinalPlanWorld } = await import("./production-world.js");
    const world = await approvedFinalPlanWorld();
    const state: ScriptState = { stageID: "STAGE-001" };
    const store = world.store;
    const runID = "EXEC-001";
    world.supervisor.script = [
      ...setupTurns(world, state),
      async () => {
        const directive = await issue(store, runID, await live(store, runID, state.stageID), { objective: "blocked work" });
        return { outcome: "directive_issued", directive } as const;
      },
      // The Supervisor judges the FinalPlan under-specified: request_replan → terminal issue.
      async () => {
        const l = await live(store, runID, state.stageID);
        await store.submitSupervisorAssessment({
          executionRunID: runID as never, stageID: l.stage.id, windowID: l.window.id,
          candidateRevision: l.window.candidateRevision, ...PROD_AUTH,
          draft: {
            reportRefs: [], planRefs: [], coveredObligations: [],
            acceptanceScope: "window", disposition: "request_replan",
            rationale: "the approved design cannot deliver obligation 1",
          },
        } as never);
        const run = (await store.getExecutionRun(runID as never))!;
        const assessments = await store.listSupervisorAssessmentsForRun(runID as never);
        const source = assessments.find((assessment) => assessment.disposition === "request_replan")!;
        await store.transitionExecutionRunToReplanRequired({
          executionRunID: runID as never, ...PROD_AUTH,
          sourceAssessmentID: source.id as never,
          reason: "the approved design omits the recovery boundary",
          affectedPlanRefs: [{ kind: "final_plan", id: world.finalPlan.id, revision: world.finalPlan.revision }],
          expectedRunRevision: run.revision,
        } as never);
        return { outcome: "state_mutated", mutation: "execution_transition_replan" } as const;
      },
    ];
    world.worker.script = [
      (input) =>
        ({
          kind: "reported",
          payload: reportedPayload(input, {
            result: "blocked",
            blockers: [{ kind: "ambiguous_directive", summary: "the directive contradicts the repository reality" }],
          }),
        }) as const,
    ];
    // The pump MUST stop at replan_required with no further dispatches (E32).
    const result = await productionEnter(world.controller, PROD_OWNER, "");
    const entry = (result as { kind: "supervised"; entry: { status: string; pump: { outcome: string; terminal?: string } } }).entry;
    expect(entry.pump.outcome).toBe("terminal");
    expect(entry.pump.terminal).toBe("replan_required");
    expect(((await store.getExecutionRun(runID as never))!).lifecycle).toBe("replan_required");
    expect(((await store.getRun(world.runID)) as PlanningRun).lifecycle).toBe("completed");
    expect(world.worker.invocations).toHaveLength(1);

    // §41 — the explicit typed replan action.
    const replanEntry = await productionEnter(world.controller, PROD_OWNER, "replan");
    const replan = (replanEntry as { kind: "supervised"; entry: { status: string; planningRunID: string; statusText: string } }).entry;
    expect(replan.status).toBe("replan_started");
    const newPlanningID = replan.planningRunID;
    expect(newPlanningID).not.toBe(world.runID);
    const newRun = (await store.getRun(newPlanningID as never)) as PlanningRun;
    expect(newRun.lifecycle).toBe("active");
    expect(newRun.replanProvenance!.priorExecutionRun).toBe(runID);
    // The old planning run is NEVER reactivated (E35).
    expect(((await store.getRun(world.runID)) as PlanningRun).lifecycle).toBe("completed");

    // §44 — drive the NEW planning run through the REAL flow (affected scope is the Planner's judgment; the protocol is unchanged).
    const planningWorld = { store, controller: world.controller };
    await dagWorld(planningWorld as never, PROD_OWNER);
    await checkpointAndComplete(planningWorld as never, PROD_OWNER);
    await checkpointAndComplete(planningWorld as never, PROD_OWNER);
    await checkpointAndComplete(planningWorld as never, PROD_OWNER);
    await world.controller.beginSynthesis(PROD_OWNER);
    await world.controller.submitSynthesisManifest(PROD_OWNER, manifestDraft());
    await world.controller.runSemanticValidation(PROD_OWNER);
    const finalization = await world.controller.requestFinalization(PROD_OWNER);
    expect(finalization.gate.result).toBe("pass");
    const prepared = await world.controller.prepareFinalPlan(PROD_OWNER);
    const begun = await world.controller.beginProposalApproval(PROD_OWNER, prepared.proposal.id);
    await world.controller.recordApproval(PROD_OWNER, prepared.proposal.id, begun.request);
    await world.controller.commitApprovedProposal(PROD_OWNER, prepared.proposal.id);

    // §46/§47/E39/E40 — the Final Approval creates a NEW supervised ExecutionRun.
    world.supervisor.script = [() => ({ outcome: "awaiting_supervisor", note: "new run" } as const)];
    world.worker.script = [];
    const enterNew = await productionEnter(world.controller, PROD_OWNER, "");
    expect((enterNew as { kind: "supervised"; entry: { status: string } }).entry.status).toBe("handoff_recovered");
    const executionRuns = await store.listRecoverableExecutionRuns(WORKSPACE);
    const newExecution = executionRuns.find((run) => run.id !== runID)!;
    expect(newExecution.id).toBe("EXEC-002");
    expect(newExecution.planID).toBe(newPlanningID); // binds the NEW FinalPlan family
    // The OLD terminal run is untouched and unbound (E40).
    expect(((await store.getExecutionRun(runID as never))!).lifecycle).toBe("replan_required");
  });
});

describe("§78/E68 — explicit human takeover E2E", () => {
  it("S2 resume → requiresTakeover; explicit takeover → generation +1 once, S1 fenced", async () => {
    const world = await approvedFinalPlanWorld();
    world.supervisor.script = [() => ({ outcome: "awaiting_supervisor", note: "s1 boot" } as const)];
    await productionEnter(world.controller, PROD_OWNER, "");
    // S2 (a different session) resumes: requiresTakeover, NO mutation.
    const surfaced = await productionEnter(world.controller, PROD_OTHER, "");
    const takeoverEntry = (surfaced as { kind: "supervised"; entry: { status: string; ownerSessionID: string } }).entry;
    expect(takeoverEntry.status).toBe("requires_takeover");
    expect(takeoverEntry.ownerSessionID).toBe(PROD_OWNER);
    expect((await world.store.findSupervisorBinding("EXEC-001" as never))!.generation).toBe(1);

    // The EXPLICIT user takeover (host-minted authorization).
    const taken = await productionEnter(world.controller, PROD_OTHER, "resume EXEC-001 --takeover");
    const resumed = (taken as { kind: "supervised"; entry: { status: string; statusText: string } }).entry;
    expect(resumed.status).toBe("resumed");
    expect(resumed.statusText).toContain("generation 2");
    const binding = (await world.store.findSupervisorBinding("EXEC-001" as never))!;
    expect(binding.generation).toBe(2);
    expect(binding.ownerSessionID).toBe(PROD_OTHER);

    // §78 — S1's next writable control is FENCED: a stale-generation takeover
    // attempt from the OLD owner fails closed.
    await expect(
      world.store.takeoverExecutionSupervisor({
        executionRunID: "EXEC-001" as never,
        sessionID: PROD_OWNER,
        workspace: WORKSPACE,
        expectedGeneration: 1,
        authorization: { kind: "user_authorized", reason: "stale old-owner retry" },
      }),
    ).rejects.toMatchObject({ code: "stale_supervisor_binding" });
    // Exactly +1: a same-owner S2 resume does NOT bump again (§99).
    world.supervisor.script = [() => ({ outcome: "awaiting_supervisor", note: "s2 steady" } as const)];
    const steady = await productionEnter(world.controller, PROD_OTHER, "");
    expect((steady as { kind: "supervised"; entry: { status: string } }).entry.status).toBe("resumed");
    expect((await world.store.findSupervisorBinding("EXEC-001" as never))!.generation).toBe(2);
  });
});

describe("§80/E70 — yield/resume E2E", () => {
  it("a tiny pump budget yields mid-execution; the same session resumes from the Store and completes", async () => {
    const { approvedFinalPlanWorld } = await import("./production-world.js");
    const world = await approvedFinalPlanWorld({ budgets: { maxSupervisorTurnsPerPump: 5 } });
    simpleCompletedScript(world);
    world.worker.script = [
      (input) => EXECUTOR_CHANGED(input),
      (input) => CLEAN(input),
      (input) => CLEAN(input),
    ];
    const first = await productionEnter(world.controller, PROD_OWNER, "");
    const firstEntry = (first as { kind: "supervised"; entry: { status: string; pump: { outcome: string; reason: string } } }).entry;
    expect(firstEntry.pump.outcome).toBe("yielded");
    expect(firstEntry.pump.reason).toBe("budget_exhausted");
    expect(((await world.store.getExecutionRun("EXEC-001" as never))!).lifecycle).toBe("active");
    // No fake failure lifecycle was recorded (E70): the run is simply active.
    const midExecutionRun = (await world.store.getExecutionRun("EXEC-001" as never))!;
    expect(midExecutionRun.activeStage).toBeDefined();

    // Same-session resume: fresh pump budget, canonical Store truth.
    const second = await productionEnter(world.controller, PROD_OWNER, "");
    const secondEntry = (second as { kind: "supervised"; entry: { status: string; pump: { outcome: string; reason: string } } }).entry;
    expect(secondEntry.pump.outcome).toBe("yielded"); // still more turns to run
    const third = await productionEnter(world.controller, PROD_OWNER, "");
    const thirdEntry = (third as { kind: "supervised"; entry: { pump: { outcome: string; terminal?: string } } }).entry;
    expect(thirdEntry.pump.outcome).toBe("terminal");
    expect(thirdEntry.pump.terminal).toBe("completed");
    expect(world.legacyHost.dispatches).toHaveLength(0);
  });
});
