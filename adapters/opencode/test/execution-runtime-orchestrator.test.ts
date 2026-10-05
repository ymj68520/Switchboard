/**
 * v0.2.0 Phase 7A — runtime contract tests with FAKE model runtimes
 * (directive §73/§78-§81/§86/§88-§94).
 *
 * The provider-neutral ports are scripted; the REAL orchestrator, tool
 * surface, context assembler, and Core transactions do all the work. No
 * OpenCode client and no live model is involved here (that boundary lives in
 * execution-runtime-adapters.test.ts).
 */
import { describe, expect, it } from "vitest";

import {
  InMemoryExecutionRuntimeTracer,
  ExecutionOrchestrator,
  ExecutionSupervisorToolSurface,
  runDormantSupervisedExecution,
  resolveExecutionModelPolicy,
  createUltraPlanTools,
  OpenCodeRuntimeAdapter,
  DEFAULT_PLANNING_RUNTIME_SPEC,
} from "../src/index.js";
import {
  EXEC_AUTH,
  EXEC_OWNER,
  FULL_EXEC_CEILING,
  WORKSPACE,
  execLive,
  handoffPendingWorld,
  prepareInput,
  supervisedWorld,
  type SupervisedWorld,
} from "./execution-world.js";
import type { ExecutionDirectiveID } from "../src/index.js";

// The scripted Supervisor/Worker ports are shared with the Phase 7B
// production suites (fake-execution-runtime.ts — test infrastructure only).
import { FakeSupervisor, FakeWorker, reportedPayload } from "./fake-execution-runtime.js";

interface RuntimeWorld {
  world: SupervisedWorld;
  supervisor: FakeSupervisor;
  worker: FakeWorker;
  orchestrator: ExecutionOrchestrator;
  tracer: InMemoryExecutionRuntimeTracer;
}

function runtimeWorld(world: SupervisedWorld): RuntimeWorld {
  const supervisor = new FakeSupervisor([]);
  const worker = new FakeWorker([]);
  const tracer = new InMemoryExecutionRuntimeTracer();
  const orchestrator = new ExecutionOrchestrator({
    store: world.world.store,
    supervisor,
    worker,
    policy: resolveExecutionModelPolicy({ ...DEFAULT_PLANNING_RUNTIME_SPEC, planningModel: "frontier/model-x", executionModel: "build/model-y" }),
    trustedCeiling: FULL_EXEC_CEILING,
    workspace: WORKSPACE,
    tracer,
  });
  return { world, supervisor, worker, orchestrator, tracer };
}

/** Issue a directive exactly as the tool surface would (live CAS values). */
async function issueDirective(
  world: SupervisedWorld,
  draft: Record<string, unknown>,
): Promise<{ id: ExecutionDirectiveID; revision: number; hash: string; kind: string }> {
  const live = await execLive(world);
  const directive = await world.world.store.issueExecutionDirective({
    executionRunID: world.run.id,
    stageID: world.stage.id,
    windowID: world.window.id,
    ...EXEC_AUTH,
    ceiling: FULL_EXEC_CEILING,
    expectedRunRevision: live.run.revision,
    expectedStageRevision: live.stage.revision,
    expectedWindowRevision: live.window.revision,
    draft: {
      kind: "implementation",
      objective: "work",
      planRefs: [],
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
      body: "",
      ...draft,
    },
  } as never);
  return { id: directive.id, revision: directive.revision, hash: directive.hash, kind: directive.kind };
}

describe("§73/E65 — the complete dormant Supervisor→Directive→Worker→Report→Supervisor loop", () => {
  it("runs mechanically: directives dispatch, reports persist, the candidate advances, acceptance commits, and the next Supervisor turn sees it all", async () => {
    const world = await supervisedWorld();
    const rw = runtimeWorld(world);
    const executorReportIDs: string[] = [];

    rw.supervisor.calls.length = 0;
    rw.supervisor.script = [
      // Turn 1: issue the implementation Directive (mutation ends the turn).
      async () => {
        const directive = await issueDirective(world, { objective: "implement it", candidateEffect: "may_mutate" });
        return { outcome: "directive_issued", directive } as const;
      },
      // Turn 2 (fresh durable state: candidate is now 1): issue verification.
      async () => {
        const live = await execLive(world);
        expect(live.window.candidateRevision).toBe(1);
        const obligation = (await world.world.store.getExecutionStage(world.stage.id))!.completionObligations![0]!.id;
        const directive = await issueDirective(world, {
          kind: "verification",
          objective: "verify the candidate",
          candidateEffect: "non_mutating",
          capabilityEnvelope: { ...FULL_EXEC_CEILING, repositoryWrite: false },
          verificationCoverage: { obligationRefs: [obligation] },
        });
        return { outcome: "directive_issued", directive } as const;
      },
      // Turn 3: judge — accept the current candidate (Core runs the gate).
      async () => {
        const live = await execLive(world);
        const obligation = (await world.world.store.getExecutionStage(world.stage.id))!.completionObligations![0]!.id;
        await world.world.store.submitSupervisorAssessment({
          executionRunID: world.run.id,
          stageID: live.stage.id,
          windowID: live.window.id,
          candidateRevision: live.window.candidateRevision,
          ...EXEC_AUTH,
          draft: {
            reportRefs: [],
            planRefs: [],
            coveredObligations: [obligation],
            acceptanceScope: "window",
            disposition: "accept",
            rationale: "clean verifier",
          },
        } as never);
        return { outcome: "state_mutated", mutation: "execution_submit_assessment" } as const;
      },
      // Turn 4: read-only turn — the Supervisor's rebuilt context MUST see the durable report (§73).
      async () => {
        const reports = await world.world.store.listExecutionReportsForRun(world.run.id);
        expect(reports.length).toBe(2);
        executorReportIDs.push(...reports.map((report) => report.id));
        const recovery = (await world.world.store.buildExecutionRecoveryContext(world.run.id, { sessionID: EXEC_OWNER }))!;
        expect(recovery.latestReport).toBeDefined();
        expect(recovery.acceptedHead).toBe("EC-001");
        return { outcome: "awaiting_supervisor", note: "stage window accepted; awaiting next candidate" } as const;
      },
    ];
    rw.worker.script = [
      (input) => {
        expect(input.attempt.workerRole).toBe("executor");
        return { kind: "reported", payload: reportedPayload(input, { candidateMutation: "changed" }) };
    },
      (input) => {
        expect(input.attempt.workerRole).toBe("verifier");
        return { kind: "reported", payload: reportedPayload(input) };
      },
    ];

    const result = await rw.orchestrator.runSupervisedLoop({
      executionRunID: world.run.id,
      sessionID: EXEC_OWNER,
      generation: 1,
      maxSteps: 8,
    });
    expect(result.stopped).toBe("budget");
    expect(result.steps).toBe(8);
    expect(rw.supervisor.calls).toHaveLength(8);
    expect(rw.worker.invocations).toHaveLength(2);

    // §73 — durable state, not conversation, carried every fact. (The window
    // closed at acceptance; read the record family, not the open pointer.)
    const windows = await world.world.store.listVerificationWindowsForRun(world.run.id);
    expect(windows[windows.length - 1]!.candidateRevision).toBe(1);
    expect((await world.world.store.getExecutionRun(world.run.id))!.acceptedHead).toBe("EC-001");
    expect(executorReportIDs.length).toBe(2);
    // Both roles ran through the ONE common worker protocol (§E41).
    expect(rw.worker.invocations.map((invocation) => invocation.attempt.workerRole)).toEqual(["executor", "verifier"]);
    // §69 — the runtime tracer (fed by the real adapters) never records output content.
    expect(JSON.stringify(rw.tracer.events)).not.toContain("did the work");
  });

  it("§30/E27 — the Worker context carries the exact Directive and never Supervisor identity or hidden reasoning", async () => {
    const world = await supervisedWorld();
    const rw = runtimeWorld(world);
    rw.supervisor.script = [
      async () => ({ outcome: "directive_issued", directive: await issueDirective(world, { objective: "build it" }) } as const),
    ];
    rw.worker.script = [(input) => ({ kind: "reported", payload: reportedPayload(input) })];
    await rw.orchestrator.runSupervisedLoop({ executionRunID: world.run.id, sessionID: EXEC_OWNER, maxSteps: 2 });
    const invocation = rw.worker.invocations[0]!;
    const contextJson = JSON.stringify(invocation.context);
    expect(contextJson).not.toContain(EXEC_OWNER);
    expect(contextJson).not.toMatch(/hidden|scratchpad|chain-of-thought/i);
    expect(invocation.context.directive.objective).toBe("build it");
    expect(invocation.context.role).toBe("executor");
  });
});

describe("§86/§88 — host-owned mechanical dispatch of an issued Directive", () => {
  it("starts the EXACT attempt for the issued ref and refuses a hash mismatch", async () => {
    const world = await supervisedWorld();
    const rw = runtimeWorld(world);
    rw.worker.script = [(input) => ({ kind: "reported", payload: reportedPayload(input) })];
    const directive = await issueDirective(world, { objective: "exact ref" });
    const dispatched = await rw.orchestrator.dispatchIssuedDirective({
      executionRunID: world.run.id,
      directive,
      sessionID: EXEC_OWNER,
    });
    expect(dispatched.kind).toBe("reported");
    const attempt = await world.world.store.findExecutionAttemptForDirective(world.run.id, { id: directive.id, revision: directive.revision });
    expect(attempt).toBeDefined();
    expect(attempt!.state).toBe("reported");
    // Exact-ref validation: a tampered hash never dispatches (§28).
    await expect(
      rw.orchestrator.dispatchIssuedDirective({
        executionRunID: world.run.id,
        directive: { ...directive, hash: "tampered" },
        sessionID: EXEC_OWNER,
      }),
    ).rejects.toMatchObject({ code: "directive_hash_mismatch" });
  });

  it("§88/E73 a crash between issuance and dispatch recovers: the SAME unconsumed Directive dispatches once, never duplicated", async () => {
    const world = await supervisedWorld();
    const rw = runtimeWorld(world);
    rw.worker.script = [(input) => ({ kind: "reported", payload: reportedPayload(input) })];
    const directive = await issueDirective(world, { objective: "survive the crash" });
    // Supervisor runtime crashes before dispatch → nothing consumed yet.
    expect(await world.world.store.findRunningExecutionAttempt(world.run.id)).toBeUndefined();
    const first = await rw.orchestrator.dispatchIssuedDirective({ executionRunID: world.run.id, directive, sessionID: EXEC_OWNER });
    expect(first.kind).toBe("reported");
    // Crash AFTER the report was durable (§90/E75): recovery does not redispatch.
    const second = await rw.orchestrator.dispatchIssuedDirective({ executionRunID: world.run.id, directive, sessionID: EXEC_OWNER });
    expect(second.kind).toBe("already_consumed");
    expect(rw.worker.invocations).toHaveLength(1);
  });

  it("§54/§89/E74 — a Worker runtime crash fails the Attempt closed to indeterminate (never a fabricated failed Report)", async () => {
    const world = await supervisedWorld();
    const rw = runtimeWorld(world);
    rw.worker.script = [
      () => {
        throw new Error("worker process disappeared");
      },
    ];
    const directive = await issueDirective(world, { objective: "interrupted by crash" });
    const outcome = await rw.orchestrator.dispatchIssuedDirective({ executionRunID: world.run.id, directive, sessionID: EXEC_OWNER });
    expect(outcome.kind).toBe("indeterminate");
    expect(outcome).toMatchObject({ reason: "host_lost_result" });
    const attempt = await world.world.store.getExecutionAttempt((outcome as { attempt: { id: string } }).attempt.id as never);
    expect(attempt!.state).toBe("indeterminate");
    expect(await world.world.store.findExecutionReportForAttempt(attempt!.id)).toBeUndefined();
    // P0 semantics: the crashed attempt was may_mutate → reconciliation mode.
    const recovery = (await world.world.store.buildExecutionRecoveryContext(world.run.id, { sessionID: EXEC_OWNER }))!;
    expect(recovery.reconciliationRequired).toBe(true);
  });
});

describe("§57-§59/E55-E57 — deterministic recovery (never latest-by-time, never auto-takeover)", () => {
  it("none / unbound / resumed / requires_takeover / ambiguous, with same-session resume preserving the generation", async () => {
    const base = await handoffPendingWorld();
    const store = base.store;
    const orchestrator = new ExecutionOrchestrator({
      store,
      supervisor: new FakeSupervisor([]),
      worker: new FakeWorker([]),
      policy: resolveExecutionModelPolicy(DEFAULT_PLANNING_RUNTIME_SPEC),
      trustedCeiling: FULL_EXEC_CEILING,
      workspace: WORKSPACE,
    });
    expect(await orchestrator.recoverSupervisedExecution({ sessionID: EXEC_OWNER })).toEqual({ status: "none" });

    const { run } = await store.prepareInitialExecutionRun(prepareInput(base));
    expect(await orchestrator.recoverSupervisedExecution({ sessionID: EXEC_OWNER })).toMatchObject({ status: "unbound", executionRunID: run.id });

    await store.attachExecutionSupervisor({ executionRunID: run.id, sessionID: EXEC_OWNER, workspace: WORKSPACE });
    // A DIFFERENT session sees requires_takeover — never an auto-takeover (§58).
    expect(await orchestrator.recoverSupervisedExecution({ sessionID: "ses_other" })).toMatchObject({
      status: "requires_takeover",
      executionRunID: run.id,
      ownerSessionID: EXEC_OWNER,
    });
    // Same authoritative session resumes WITHOUT a generation bump (§59/E56).
    expect(await orchestrator.recoverSupervisedExecution({ sessionID: EXEC_OWNER })).toEqual({ status: "resumed", executionRunID: run.id });
    expect((await store.findSupervisorBinding(run.id))!.generation).toBe(1);

    // Two prepared runs for the workspace → ambiguous, never a silent latest-pick (§57).
    await store.prepareInitialExecutionRun(
      prepareInput(base, { initialHandoffKey: "explicit-second-recovery-key" as never }),
    );
    const ambiguous = await orchestrator.recoverSupervisedExecution({ sessionID: EXEC_OWNER });
    expect(ambiguous.status).toBe("ambiguous");
    expect(ambiguous.status === "ambiguous" && ambiguous.candidateRunIDs).toHaveLength(2);
  });

  it("§60/E58 — an orphaned running Attempt with an unprovable worker fails closed to indeterminate", async () => {
    const world = await supervisedWorld();
    const store = world.world.store;
    const rw = runtimeWorld(world);
    rw.worker.script = [];
    const directive = await issueDirective(world, { objective: "orphaned" });
    await store.startExecutionAttempt({
      executionRunID: world.run.id,
      directive: { id: directive.id, revision: directive.revision },
      ...EXEC_AUTH,
      ceiling: FULL_EXEC_CEILING,
    });
    // Probe CANNOT prove liveness → indeterminate (§61: registry ≠ authority).
    const liveProbe = async () => true;
    const deadProbe = async () => false;
    const recovered = new ExecutionOrchestrator({
      store,
      supervisor: new FakeSupervisor([]),
      worker: new FakeWorker([]),
      policy: resolveExecutionModelPolicy(DEFAULT_PLANNING_RUNTIME_SPEC),
      trustedCeiling: FULL_EXEC_CEILING,
      workspace: WORKSPACE,
      livenessProbe: deadProbe,
    });
    expect(await recovered.recoverSupervisedExecution({ sessionID: EXEC_OWNER })).toMatchObject({
      status: "resumed",
      executionRunID: world.run.id,
      orphanedAttemptMarkedIndeterminate: expect.any(String),
    });
    void liveProbe;
    const recovery = (await store.buildExecutionRecoveryContext(world.run.id, { sessionID: EXEC_OWNER }))!;
    expect(recovery.reconciliationRequired).toBe(true);
  });
});

describe("§49/§50/§93/§94 — loop routing makes no normative decisions and stops cleanly on terminals", () => {
  it("a scripted supervisor outcome routes without orchestrator reinterpretation; replan/completed stop terminal", async () => {
    const world = await supervisedWorld();
    const rw = runtimeWorld(world);
    rw.supervisor.script = [
      () => ({ outcome: "replan_required" }),
    ];
    const result = await rw.orchestrator.runSupervisedLoop({ executionRunID: world.run.id, sessionID: EXEC_OWNER, maxSteps: 4 });
    expect(result).toMatchObject({ stopped: "terminal", outcome: "replan_required", steps: 1 });

    const rw2 = runtimeWorld(world);
    rw2.supervisor.script = [
      () => ({ outcome: "completed", completionID: "CMPL-001" }),
    ];
    const completed = await rw2.orchestrator.runSupervisedLoop({ executionRunID: world.run.id, sessionID: EXEC_OWNER, maxSteps: 4 });
    expect(completed).toMatchObject({ stopped: "terminal", outcome: "completed", completionID: "CMPL-001" });

    const rw3 = runtimeWorld(world);
    rw3.supervisor.script = [
      () => ({ outcome: "fencing_failure", code: "stale_supervisor_binding", message: "fenced" }),
    ];
    const fenced = await rw3.orchestrator.runSupervisedLoop({ executionRunID: world.run.id, sessionID: EXEC_OWNER, maxSteps: 4 });
    expect(fenced).toMatchObject({ stopped: "fencing" });
  });

  it("§93/E78 a replan_required run reaches the Supervisor runtime and stops terminal with ZERO Worker invocations", async () => {
    const world = await supervisedWorld();
    const store = world.world.store;
    // A durable request_replan judgment + the atomic replan transition.
    const live = await execLive(world);
    const { assessment } = await store.submitSupervisorAssessment({
      executionRunID: world.run.id,
      stageID: live.stage.id,
      windowID: live.window.id,
      candidateRevision: live.window.candidateRevision,
      ...EXEC_AUTH,
      draft: {
        reportRefs: [],
        planRefs: [],
        coveredObligations: [],
        acceptanceScope: "window",
        disposition: "request_replan",
        rationale: "the FinalPlan cannot express the discovered constraint",
      },
    } as never);
    await store.transitionExecutionRunToReplanRequired({
      executionRunID: world.run.id,
      ...EXEC_AUTH,
      sourceAssessmentID: assessment.id,
      reason: "normative authority insufficient",
      affectedPlanRefs: [],
      expectedRunRevision: (await execLive(world)).run.revision,
    });
    const rw = runtimeWorld(world);
    // The scripted port mirrors the real adapter's pre-model short-circuit
    // (proven directly against the real adapter in the adapters file).
    rw.supervisor.script = [() => ({ outcome: "replan_required" })];
    const result = await rw.orchestrator.runSupervisedLoop({ executionRunID: world.run.id, sessionID: EXEC_OWNER, maxSteps: 4 });
    expect(result).toMatchObject({ stopped: "terminal", outcome: "replan_required" });
    expect(rw.worker.invocations).toHaveLength(0);
    // The run itself is durably terminal — nothing can un-stick it.
    expect((await world.world.store.getExecutionRun(world.run.id))!.lifecycle).toBe("replan_required");
  });
});

describe("§91/§92 — durable idempotency across response loss", () => {
  it("§91/E76 an acceptance whose response was lost is never accepted twice", async () => {
    const world = await supervisedWorld();
    const rw = runtimeWorld(world);
    rw.supervisor.script = [
      async () => {
        const directive = await issueDirective(world, { kind: "verification", objective: "verify", candidateEffect: "non_mutating", capabilityEnvelope: { ...FULL_EXEC_CEILING, repositoryWrite: false } });
        return { outcome: "directive_issued", directive } as const;
      },
      async () => {
        // The accept transaction (persist-before-acknowledge, §56).
        const live = await execLive(world);
        await world.world.store.submitSupervisorAssessment({
          executionRunID: world.run.id,
          stageID: live.stage.id,
          windowID: live.window.id,
          candidateRevision: live.window.candidateRevision,
          ...EXEC_AUTH,
          draft: {
            reportRefs: [],
            planRefs: [],
            coveredObligations: [],
            acceptanceScope: "window",
            disposition: "accept",
            rationale: "clean",
          },
        } as never);
        return { outcome: "state_mutated", mutation: "execution_submit_assessment" } as const;
      },
      async () => {
        // The runtime "response" was lost. The recovered Supervisor rebuilds
        // context from the Store, SEES the durable Commit, and never
        // re-accepts (§91).
        const commits = await world.world.store.listExecutionCommitsForRun(world.run.id);
        expect(commits).toHaveLength(1);
        expect(commits[0]!.id).toBe("EC-001");
        const recovery = (await world.world.store.buildExecutionRecoveryContext(world.run.id, { sessionID: EXEC_OWNER }))!;
        expect(recovery.acceptedHead).toBe("EC-001");
        return { outcome: "state_mutated", mutation: "recovery observed the durable commit" } as const;
      },
    ];
    rw.worker.script = [(input) => ({ kind: "reported", payload: reportedPayload(input) })];
    await rw.orchestrator.runSupervisedLoop({ executionRunID: world.run.id, sessionID: EXEC_OWNER, maxSteps: 4 });
    expect(await world.world.store.listExecutionCommitsForRun(world.run.id)).toHaveLength(1);
  });
});

describe("§22-§26 — the provider-neutral tool surface", () => {
  it("exposes NO raw state setters; every entry maps to a frozen domain operation (§23/E19)", async () => {
    const world = await supervisedWorld();
    const surface = new ExecutionSupervisorToolSurface({ store: world.world.store, trustedCeiling: FULL_EXEC_CEILING });
    const names = surface.tools.map((tool) => tool.name);
    expect(names).not.toContain("setLifecycle");
    expect(names).not.toContain("setAcceptedHead");
    expect(names).not.toContain("setCandidateRevision");
    expect(names).not.toContain("setActiveStage");
    expect(names).not.toContain("setOpenWindow");
    expect(names).not.toContain("closeWindow");
    expect(names).not.toContain("completeStage");
    expect(names).not.toContain("forceCommit");
    expect(names).not.toContain("forceReplan");
    expect(names).not.toContain("forceComplete");
    for (const name of names) expect(name.startsWith("execution_")).toBe(true);
  });

  it("§25/E21 — a second authoritative mutation in the SAME turn is refused", async () => {
    const world = await supervisedWorld();
    const live = await execLive(world);
    const surface = new ExecutionSupervisorToolSurface({ store: world.world.store, trustedCeiling: FULL_EXEC_CEILING });
    surface.bindRun(world.run.id);
    const authority = { sessionID: EXEC_OWNER, workspace: WORKSPACE, generation: 1 };
    const first = await surface.execute(
      "execution_create_stages",
      {
        executionRunID: world.run.id,
        drafts: [
          {
            title: "Stage B",
            objective: "next",
            planRefs: [{ kind: "implementation_step", order: 1 }],
            dependsOn: [world.stage.id],
            completionObligations: [{ description: "done", planRefs: [{ kind: "implementation_step", order: 1 }] }],
          },
        ],
      },
      authority,
    );
    expect(first.ok).toBe(true);
    const second = await surface.execute(
      "execution_activate_stage",
      { executionRunID: world.run.id, stageID: world.stage.id, expectedRunRevision: live.run.revision, expectedStageRevision: live.stage.revision },
      authority,
    );
    expect(second.ok).toBe(false);
    expect(second.error!.code).toBe("supervisor_turn_already_mutated");
  });

  it("§62 — domain errors cross the boundary as structured {code, message, retryable}", async () => {
    const world = await supervisedWorld();
    const surface = new ExecutionSupervisorToolSurface({ store: world.world.store, trustedCeiling: FULL_EXEC_CEILING });
    surface.bindRun(world.run.id);
    const stale = await surface.execute(
      "execution_activate_stage",
      { executionRunID: world.run.id, stageID: world.stage.id, expectedRunRevision: 999, expectedStageRevision: 999 },
      { sessionID: EXEC_OWNER, workspace: WORKSPACE, generation: 1 },
    );
    expect(stale.ok).toBe(false);
    expect(stale.error!.code).toBe("stale_execution_run");
    expect(stale.error!.retryable).toBe(true);
    const unknown = await surface.execute("execution_launch_missiles", {}, { sessionID: EXEC_OWNER, workspace: WORKSPACE, generation: 1 });
    expect(unknown.error!.code).toBe("unknown_execution_tool");
  });
});

describe("§72 — the dormant internal harness entry (bind → activate → loop)", () => {
  it("takes a PREPARED run to a full supervised cycle without any production-path involvement", async () => {
    const base = await handoffPendingWorld();
    const { run } = await base.store.prepareInitialExecutionRun(prepareInput(base));
    const world = { world: { store: base.store }, run, stage: undefined as never, window: undefined as never } as unknown as SupervisedWorld;
    const supervisor = new FakeSupervisor([
      async () => {
        // The harness activated the run; the first turn decomposes Stages.
        const live = await base.store.getExecutionRun(run.id);
        expect(live!.lifecycle).toBe("active");
        await base.store.createExecutionStages({
          executionRunID: run.id, ...EXEC_AUTH,
          drafts: [{
            title: "Stage A", objective: "objective",
            planRefs: [{ kind: "implementation_step", order: 1 }], dependsOn: [],
            completionObligations: [{ description: "Obligation 1", planRefs: [{ kind: "implementation_step" as const, order: 1 }] }],
          }],
        } as never);
        return { outcome: "state_mutated", mutation: "execution_create_stages" } as const;
      },
      async () => {
        const live = await base.store.getExecutionRun(run.id);
        const stage = (await base.store.listExecutionStagesForRun(run.id))[0]!;
        await base.store.activateExecutionStage({
          executionRunID: run.id, stageID: stage.id, ...EXEC_AUTH,
          expectedRunRevision: live!.revision, expectedStageRevision: stage.revision,
        });
        await base.store.openVerificationWindow({
          executionRunID: run.id, stageID: stage.id, ...EXEC_AUTH,
          expectedRunRevision: (await base.store.getExecutionRun(run.id))!.revision,
          expectedStageRevision: (await base.store.getExecutionStage(stage.id))!.revision,
        });
        return { outcome: "state_mutated", mutation: "execution_open_window" } as const;
      },
      async () => {
        const liveRun = (await base.store.getExecutionRun(run.id))!;
        world.stage = (await base.store.getExecutionStage(liveRun.activeStage!))!;
        world.window = (await base.store.findOpenVerificationWindow(run.id))!;
        const directive = await issueDirective(world, { objective: "harness work" });
        return { outcome: "directive_issued", directive } as const;
      },
    ]);
    const worker = new FakeWorker([(input) => ({ kind: "reported", payload: reportedPayload(input, { candidateMutation: "none" }) })]);
    const tracer = new InMemoryExecutionRuntimeTracer();
    const result = await runDormantSupervisedExecution(
      {
        store: base.store,
        supervisor,
        worker,
        policy: resolveExecutionModelPolicy({ ...DEFAULT_PLANNING_RUNTIME_SPEC, planningModel: "frontier/model-x", executionModel: "build/model-y" }),
        trustedCeiling: FULL_EXEC_CEILING,
        workspace: WORKSPACE,
        tracer,
      },
      { executionRunID: run.id, sessionID: EXEC_OWNER, maxSteps: 6 },
    );
    expect(result.phase).toBe("loop");
    expect(result.phase === "loop" && result.dispatches).toHaveLength(1);
    expect(rwUnwrap(result)).toMatchObject({ stopped: "budget" });
    // §58 — a foreign session is never auto-bound by the harness either.
    const base2 = await handoffPendingWorld();
    const { run: run2 } = await base2.store.prepareInitialExecutionRun(prepareInput(base2));
    await base2.store.attachExecutionSupervisor({ executionRunID: run2.id, sessionID: EXEC_OWNER, workspace: WORKSPACE });
    const foreign = await runDormantSupervisedExecution(
      {
        store: base2.store,
        supervisor: new FakeSupervisor([]),
        worker: new FakeWorker([]),
        policy: resolveExecutionModelPolicy(DEFAULT_PLANNING_RUNTIME_SPEC),
        trustedCeiling: FULL_EXEC_CEILING,
        workspace: WORKSPACE,
      },
      { executionRunID: run2.id, sessionID: "ses_other" },
    );
    expect(foreign).toEqual({ phase: "takeover_required", ownerSessionID: EXEC_OWNER });
  });
});

function rwUnwrap(result: { phase: string; result?: unknown }): unknown {
  return (result as { result: unknown }).result;
}

describe("§14/§95 — model policy defaults and production dormancy", () => {
  it("supervisor defaults to the planning tier; verifier defaults to the worker tier; nothing is hardcoded", () => {
    const policy = resolveExecutionModelPolicy({
      ...DEFAULT_PLANNING_RUNTIME_SPEC,
      planningModel: "frontier/model-x",
      executionModel: "build/model-y",
    });
    expect(policy.supervisorModel).toBe("frontier/model-x");
    expect(policy.workerModel).toBe("build/model-y");
    expect(policy.verifierModel).toBe("build/model-y");
    const explicit = resolveExecutionModelPolicy({
      ...DEFAULT_PLANNING_RUNTIME_SPEC,
      planningModel: "frontier/model-x",
      supervisorModel: "frontier/supervisor-y",
      workerModel: "build/model-y",
      verifierModel: "build/verifier-z",
    });
    expect(explicit.supervisorModel).toBe("frontier/supervisor-y");
    expect(explicit.verifierModel).toBe("build/verifier-z");
    // No Build model defaults into the Supervisor seat when no planning model exists.
    expect(resolveExecutionModelPolicy(DEFAULT_PLANNING_RUNTIME_SPEC).supervisorModel).toBeUndefined();
  });

  it("§95/E80/§71/E81 — the v0.1 production surface exposes ZERO execution-runtime entries", async () => {
    const base = await handoffPendingWorld();
    // The FinalPlan approval → v0.1 handoff produced ZERO execution artifacts.
    expect(await base.store.listExecutionRunsForPlan(base.runID)).toEqual([]);
    expect(await base.store.listRecoverableExecutionRuns(WORKSPACE)).toEqual([]);
    // The production planning tool registry has no execution_* tool.
    const tools = createUltraPlanTools(base.controller);
    for (const name of Object.keys(tools)) expect(name.startsWith("execution_")).toBe(false);
    // The production config registers no supervisor/worker runtime agents.
    const adapter = new OpenCodeRuntimeAdapter();
    const config: { command?: Record<string, unknown>; agent?: Record<string, unknown> } = {};
    adapter.applyToConfig(config as never);
    expect(Object.keys(config.agent ?? {})).toEqual(["ultraplan"]);
    for (const name of Object.values(DEFAULT_PLANNING_RUNTIME_SPEC)) void name;
  });
});
