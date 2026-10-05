/**
 * v0.2.0 Phase 7A — REAL OpenCode adapter contract tests over a FAKE model
 * client (directive §74-§77/§80-§85/§87/§93). No live network LLM (§74):
 * the client is a narrow structural fake of `session.create`/`session.prompt`.
 */
import { describe, expect, it } from "vitest";

import {
  ExecutionOrchestrator,
  OpenCodeSupervisorAdapter,
  OpenCodeWorkerAdapter,
  ExecutionSupervisorToolSurface,
  InMemoryExecutionRuntimeTracer,
  parseWorkerReportOutput,
  projectWorkerToolMap,
  projectSupervisorToolMap,
  capabilityEnforceability,
  deriveHostPermissionCeiling,
  assertEnvelopeWithinHostCeiling,
  resolveExecutionModelPolicy,
  renderWorkerTaskMessage,
  EXECUTION_SUPERVISOR_SYSTEM_PROMPT,
  EXECUTION_SUPERVISOR_OPERATIONS,
} from "../src/index.js";
import type { OpenCodeModelClient } from "../src/index.js";
import {
  EXEC_AUTH,
  EXEC_OWNER,
  FULL_EXEC_CEILING,
  WORKSPACE,
  execLive,
  supervisedWorld,
  type SupervisedWorld,
} from "./execution-world.js";

const POLICY = resolveExecutionModelPolicy({
  commandName: "ultra-plan",
  agentName: "ultraplan",
  planningModel: "frontier/planner",
  supervisorModel: "frontier/supervisor",
  executionModel: "build/worker",
  workerModel: "build/worker",
  verifierModel: "build/verifier",
});

/** A scripted fake of the narrow OpenCode client surface. */
class FakeModelClient implements OpenCodeModelClient {
  readonly createdSessions: { parentID?: string; title?: string }[] = [];
  readonly prompts: { sessionID: string; body: { parts: { text: string }[]; model?: { providerID: string; modelID: string }; system?: string; tools?: Record<string, boolean> } }[] = [];
  /** Evaluated lazily so scripts can read live durable state. */
  script: Array<() => string>;
  private readonly options: { hang?: boolean; messageError?: { name: string } };
  constructor(
    script: Array<() => string> = [],
    options: { hang?: boolean; messageError?: { name: string } } = {},
  ) {
    this.script = script;
    this.options = options;
  }
  session = {
    create: async (input: { body?: { parentID?: string; title?: string } }) => {
      this.createdSessions.push(input.body ?? {});
      return { data: { id: `ses_child_${this.createdSessions.length}` } };
    },
    prompt: async (input: { path: { id: string }; body: { parts: { type: "text"; text: string }[]; model?: { providerID: string; modelID: string }; system?: string; tools?: Record<string, boolean> } }) => {
      this.prompts.push({ sessionID: input.path.id, body: input.body });
      if (this.options.hang) return new Promise<never>(() => undefined);
      const next = this.script.shift();
      const text = next ? next() : "";
      return {
        data: {
          info: { id: `msg_${this.prompts.length}`, sessionID: input.path.id, ...(this.options.messageError ? { error: this.options.messageError } : {}) },
          parts: [{ type: "text", text }],
        },
      };
    },
  };
}

/** Issue one directive exactly as the tool surface would (live CAS values). */
async function issueDirective(
  world: SupervisedWorld,
  draft: Record<string, unknown>,
) {
  const live = await execLive(world);
  return world.world.store.issueExecutionDirective({
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
}

/** Sync-throw assertion with the repo's error-code convention. */
function expectThrows(fn: () => unknown, code: string): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect((thrown as { code?: string } | undefined)?.code ?? "no-throw").toBe(code);
}

function supervisorAdapter(
  world: SupervisedWorld,
  client: FakeModelClient,
  extra: Partial<Pick<import("../src/index.js").OpenCodeSupervisorAdapterOptions, "maxReadRounds" | "registeredUltraPlanToolNames">> = {},
) {
  return new OpenCodeSupervisorAdapter({
    client,
    store: world.world.store,
    policy: POLICY,
    trustedCeiling: FULL_EXEC_CEILING,
    parentSessionID: EXEC_OWNER,
    ...extra,
  });
}

/** A valid completed Worker report JSON object (identity fields deliberately WRONG — the host must overwrite them). */
function fakeReportJSON(): string {
  return JSON.stringify({
    directive: { id: "DIR-FAKE", revision: 99, hash: "forged" },
    workerRole: "verifier",
    result: "completed",
    actionsPerformed: ["did things"],
    filesExamined: ["src/a.ts"],
    filesChanged: [],
    commandsRun: [],
    testsRun: [],
    findings: [{ statement: "all good", acceptanceImpact: "informational" }],
    deviations: [],
    blockers: [],
    deliverables: [],
    candidateMutation: "none",
    baseCandidateRevision: 42,
  });
}

describe("§21/§74/§75/E66 — Supervisor repository-tool isolation is mechanical", () => {
  it("every OpenCode runtime tool is DENIED for the whole turn; the planning-tier supervisor model is bound; the compact protocol prompt travels", async () => {
    const world = await supervisedWorld();
    const client = new FakeModelClient([() => "I will wait for worker results."]);
    const adapter = supervisorAdapter(world, client, { registeredUltraPlanToolNames: ["ultraplan_start", "plan_memory"] });
    const outcome = await adapter.runExecutionSupervisorTurn({ executionRunID: world.run.id, trustedAuthority: EXEC_AUTH });
    expect(outcome.outcome).toBe("awaiting_supervisor");
    expect(client.prompts).toHaveLength(1);
    const tools = client.prompts[0]!.body.tools!;
    for (const name of ["read", "grep", "glob", "list", "edit", "write", "patch", "bash", "webfetch", "task", "todowrite", "todoread"]) {
      expect(tools[name]).toBe(false);
    }
    for (const name of ["ultraplan_start", "plan_memory"]) expect(tools[name]).toBe(false);
    expect(Object.values(tools).every((enabled) => enabled === false)).toBe(true);
    // §15 — the frontier supervisor model binding (never the Build model).
    expect(client.prompts[0]!.body.model).toEqual({ providerID: "frontier", modelID: "supervisor" });
    // §65/E60 — compact protocol prompt: boundaries present, full SPEC absent.
    const system = client.prompts[0]!.body.system ?? "";
    expect(system).toContain("Execution Supervisor");
    expect(system).toContain("do NOT edit repository files");
    expect(system).toContain("request_replan");
    expect(system.length).toBeLessThan(3000);
    // §18/§19 — the deterministic context projection travels as data.
    const message = client.prompts[0]!.body.parts[0]!.text;
    expect(message).toContain("SUPERVISOR CONTEXT");
    expect(JSON.parse(message.slice(message.indexOf("{")).split("\n")[0]!.trim())).toBeTruthy();
  });

  it("§68/E59 — each turn runs in a FRESH child session; correctness never depends on prior conversation", async () => {
    const world = await supervisedWorld();
    const client = new FakeModelClient([() => "note one", () => "note two"]);
    const adapter = supervisorAdapter(world, client);
    await adapter.runExecutionSupervisorTurn({ executionRunID: world.run.id, trustedAuthority: EXEC_AUTH });
    await adapter.runExecutionSupervisorTurn({ executionRunID: world.run.id, trustedAuthority: EXEC_AUTH });
    expect(client.createdSessions).toHaveLength(2);
    expect(client.createdSessions[0]!.parentID).toBe(EXEC_OWNER);
    expect(client.createdSessions[1]!.parentID).toBe(EXEC_OWNER);
  });
});

describe("§25/§26/§85/E21-E23 — one mutation ends the turn; the next turn rebuilds fresh context", () => {
  it("a mutation ends the turn IMMEDIATELY (no further model rounds); a second mutation in the same turn is refused by the surface", async () => {
    const world = await supervisedWorld();
    const client = new FakeModelClient();
    const live0 = await execLive(world);
    // The model performs ONE authoritative structural mutation.
    client["script"] = [
      () => JSON.stringify({
        tool: "execution_create_stages",
        args: {
          executionRunID: world.run.id,
          drafts: [{ title: "Stage B", objective: "next", planRefs: [], dependsOn: [world.stage.id], completionObligations: [{ description: "d", planRefs: [] }] }],
        },
      }),
    ];
    void live0;
    const adapter = supervisorAdapter(world, client);
    const outcome = await adapter.runExecutionSupervisorTurn({ executionRunID: world.run.id, trustedAuthority: EXEC_AUTH });
    expect(outcome).toMatchObject({ outcome: "state_mutated", mutation: "execution_create_stages" });
    // EXACTLY one model round — the turn ended at the mutation (§85).
    expect(client.prompts).toHaveLength(1);
    expect((await world.world.store.listExecutionStagesForRun(world.run.id))).toHaveLength(2);

    // §25/E21 — within ONE turn the surface refuses a second mutation.
    const surface = new ExecutionSupervisorToolSurface({ store: world.world.store, trustedCeiling: FULL_EXEC_CEILING });
    surface.bindRun(world.run.id);
    const authority = { sessionID: EXEC_OWNER, workspace: WORKSPACE, generation: 1 };
    const live1 = await execLive(world);
    expect(world.run.openWindow).toBeDefined();
    // The window is open now, so opening another fails at Core — use create_stages (structural, no window interplay).
    await surface.execute(
      "execution_create_stages",
      { executionRunID: world.run.id, drafts: [{ title: "S2", objective: "o", planRefs: [], dependsOn: [world.stage.id], completionObligations: [{ description: "d", planRefs: [] }] }] },
      authority,
    );
    const refused = await surface.execute(
      "execution_activate_stage",
      { executionRunID: world.run.id, stageID: world.stage.id, expectedRunRevision: live1.run.revision, expectedStageRevision: live1.stage.revision },
      authority,
    );
    expect(refused.error!.code).toBe("supervisor_turn_already_mutated");
  });

  it("reads do NOT end the turn: the result feeds the same turn's next round (§25 zero-or-more reads)", async () => {
    const world = await supervisedWorld();
    const client = new FakeModelClient([
      () => JSON.stringify({ tool: "execution_get_state", args: {} }),
      () => "I have the state; waiting for now.",
    ]);
    const adapter = supervisorAdapter(world, client, { maxReadRounds: 3 });
    const outcome = await adapter.runExecutionSupervisorTurn({ executionRunID: world.run.id, trustedAuthority: EXEC_AUTH });
    expect(outcome).toMatchObject({ outcome: "awaiting_supervisor", note: "I have the state; waiting for now." });
    expect(client.prompts).toHaveLength(2);
    expect(client.prompts[1]!.body.parts[0]!.text).toContain("RESULT of execution_get_state");
  });

  it("§63/E53 — a stale CAS mutation maps to stale_context and mutates nothing", async () => {
    const world = await supervisedWorld();
    const live = await execLive(world);
    const client = new FakeModelClient([
      () => JSON.stringify({
        tool: "execution_issue_directive",
        args: {
          executionRunID: world.run.id,
          stageID: world.stage.id,
          windowID: world.window.id,
          expectedRunRevision: live.run.revision + 99,
          expectedStageRevision: live.stage.revision,
          expectedWindowRevision: live.window.revision,
          draft: { kind: "implementation", objective: "stale work", planRefs: [], expectedExecutionScope: {}, capabilityEnvelope: { ...FULL_EXEC_CEILING }, candidateEffect: "may_mutate", invariants: [], requiredActions: [], forbiddenActions: [], validationRequirements: [], deliverables: [], stopConditions: [], reportContract: "", body: "" },
        },
      }),
    ]);
    const adapter = supervisorAdapter(world, client);
    const outcome = await adapter.runExecutionSupervisorTurn({ executionRunID: world.run.id, trustedAuthority: EXEC_AUTH });
    expect(outcome).toMatchObject({ outcome: "stale_context", code: "stale_execution_run" });
    expect(await world.world.store.listExecutionDirectivesForRun(world.run.id)).toHaveLength(0);
  });

  it("§64/E54 — a fencing failure ends writable control with ZERO model calls and never auto-takes over", async () => {
    const world = await supervisedWorld();
    const client = new FakeModelClient([() => { throw new Error("the model must not be called"); }]);
    const adapter = supervisorAdapter(world, client);
    const outcome = await adapter.runExecutionSupervisorTurn({
      executionRunID: world.run.id,
      trustedAuthority: { sessionID: EXEC_OWNER, workspace: WORKSPACE, generation: 99 },
    });
    expect(outcome).toMatchObject({ outcome: "fencing_failure", code: "stale_supervisor_binding" });
    expect(client.prompts).toHaveLength(0);
    expect(client.createdSessions).toHaveLength(0);
    const other = await adapter.runExecutionSupervisorTurn({
      executionRunID: world.run.id,
      trustedAuthority: { sessionID: "ses_intruder", workspace: WORKSPACE, generation: 1 },
    });
    expect(other).toMatchObject({ outcome: "fencing_failure", code: "supervisor_session_mismatch" });
  });

  it("§55/E51 — an invalid tool payload mutates NO business state (blocked_runtime)", async () => {
    const world = await supervisedWorld();
    const client = new FakeModelClient([
      () => JSON.stringify({ tool: "execution_open_window" }), // missing args
      () => JSON.stringify({ tool: "execution_force_commit", args: {} }), // not a domain operation
      () => "{not valid json",
    ]);
    const adapter = supervisorAdapter(world, client);
    expect(await adapter.runExecutionSupervisorTurn({ executionRunID: world.run.id, trustedAuthority: EXEC_AUTH })).toMatchObject({ outcome: "blocked_runtime" });
    expect(await adapter.runExecutionSupervisorTurn({ executionRunID: world.run.id, trustedAuthority: EXEC_AUTH })).toMatchObject({ outcome: "blocked_runtime", code: "unknown_execution_tool" });
    expect(await adapter.runExecutionSupervisorTurn({ executionRunID: world.run.id, trustedAuthority: EXEC_AUTH })).toMatchObject({ outcome: "blocked_runtime" });
    // NOTHING mutated: same stage count, candidate untouched, no directives.
    expect(await world.world.store.listExecutionStagesForRun(world.run.id)).toHaveLength(1);
    expect((await execLive(world)).window.candidateRevision).toBe(0);
    expect(await world.world.store.listExecutionDirectivesForRun(world.run.id)).toHaveLength(0);
  });
});

describe("§93/E78 — terminal runs short-circuit BEFORE any model invocation", () => {
  it("a replan_required run returns the terminal outcome with ZERO client interactions", async () => {
    const world = await supervisedWorld();
    const store = world.world.store;
    const live = await execLive(world);
    const { assessment } = await store.submitSupervisorAssessment({
      executionRunID: world.run.id,
      stageID: live.stage.id,
      windowID: live.window.id,
      candidateRevision: live.window.candidateRevision,
      ...EXEC_AUTH,
      draft: { reportRefs: [], planRefs: [], coveredObligations: [], acceptanceScope: "window", disposition: "request_replan", rationale: "insufficient" },
    } as never);
    await store.transitionExecutionRunToReplanRequired({
      executionRunID: world.run.id,
      ...EXEC_AUTH,
      sourceAssessmentID: assessment.id,
      reason: "insufficient normative authority",
      affectedPlanRefs: [],
      expectedRunRevision: (await execLive(world)).run.revision,
    });
    const client = new FakeModelClient([() => { throw new Error("the supervisor model must never be invoked"); }]);
    const adapter = supervisorAdapter(world, client);
    const outcome = await adapter.runExecutionSupervisorTurn({ executionRunID: world.run.id, trustedAuthority: EXEC_AUTH });
    expect(outcome).toEqual({ outcome: "replan_required" });
    expect(client.prompts).toHaveLength(0);
    expect(client.createdSessions).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------------
// The Worker adapter — §35-§43/§78-§84/§87
// -----------------------------------------------------------------------------

function workerAdapter(
  world: SupervisedWorld,
  client: FakeModelClient,
  extra: Partial<Pick<import("../src/index.js").OpenCodeWorkerAdapterOptions, "timeoutMs" | "tracer" | "registeredUltraPlanToolNames">> = {},
) {
  return new OpenCodeWorkerAdapter({
    client,
    policy: POLICY,
    hostCeiling: FULL_EXEC_CEILING,
    parentSessionID: EXEC_OWNER,
    tracer: new InMemoryExecutionRuntimeTracer(),
    registeredUltraPlanToolNames: ["ultraplan_start", "plan_memory"],
    ...extra,
  });
}

/** A never-called supervisor stand-in (dispatch never consults it). */
const idleSupervisor = {
  async runExecutionSupervisorTurn() {
    return { outcome: "awaiting_supervisor", note: "dispatch-only harness" } as const;
  },
};

async function dispatchOnce(
  world: SupervisedWorld,
  client: FakeModelClient,
  directiveDraft: Record<string, unknown>,
  adapterOverride?: OpenCodeWorkerAdapter,
) {
  const directive = await issueDirective(world, directiveDraft);
  const adapter = adapterOverride ?? workerAdapter(world, client);
  const orchestrator = new ExecutionOrchestrator({
    store: world.world.store,
    supervisor: idleSupervisor,
    worker: adapter,
    policy: POLICY,
    trustedCeiling: FULL_EXEC_CEILING,
    workspace: WORKSPACE,
  });
  // §27/§28 — the host mechanically dispatches the exact issued ref.
  const outcome = await orchestrator.dispatchIssuedDirective({
    executionRunID: world.run.id,
    directive: { id: directive.id, revision: directive.revision, hash: directive.hash },
    sessionID: EXEC_OWNER,
  });
  return { directive, outcome };
}

describe("§17/§78/§79/§E13/E69 — fresh isolated invocations with per-role model policy", () => {
  it("every invocation creates a NEW child session; executor binds workerModel, verifier binds verifierModel", async () => {
    const world = await supervisedWorld();
    const client = new FakeModelClient([() => fakeReportJSON(), () => fakeReportJSON()]);
    const adapter = workerAdapter(world, client);
    const executor = await dispatchOnce(world, client, { objective: "executor work" }, adapter);
    expect(executor.outcome.kind).toBe("reported");
    // A fresh non-mutating verification attempt (post-report the previous one is consumed).
    await execLive(world);
    const verifier = await dispatchOnce(world, client, { kind: "verification", objective: "verify", candidateEffect: "non_mutating", capabilityEnvelope: { ...FULL_EXEC_CEILING, repositoryWrite: false } }, adapter);
    expect(verifier.outcome.kind).toBe("reported");
    if (executor.outcome.kind !== "reported" || verifier.outcome.kind !== "reported") return;
    expect(executor.outcome.attempt.workerRole).toBe("executor");
    expect(verifier.outcome.attempt.workerRole).toBe("verifier");
    // Fresh, distinct, parented sessions.
    expect(client.createdSessions).toHaveLength(2);
    expect(client.createdSessions[0]!.parentID).toBe(EXEC_OWNER);
    expect(client.createdSessions[1]!.parentID).toBe(EXEC_OWNER);
    expect(client.createdSessions[0]).not.toEqual(client.createdSessions[1]);
    // §16/E11/E12 — model bindings follow the role policy.
    expect(client.prompts[0]!.body.model).toEqual({ providerID: "build", modelID: "worker" });
    expect(client.prompts[1]!.body.model).toEqual({ providerID: "build", modelID: "verifier" });
    // §67/E62 — the verifier system prompt forbids silent repair.
    expect(client.prompts[1]!.body.system).toContain("Do NOT silently fix defects");
  });

  it("§80/§87/E36/E70 — a valid payload is strict-parsed and its forged identity is replaced by the host's", async () => {
    const world = await supervisedWorld();
    const client = new FakeModelClient([() => fakeReportJSON()]);
    const { directive, outcome } = await dispatchOnce(world, client, { objective: "identity check" });
    expect(outcome.kind).toBe("reported");
    if (outcome.kind !== "reported") return;
    const report = outcome.report;
    expect(report.workerRole).toBe("executor"); // durable role, not the forged "verifier"
    expect(report.directive).toEqual({ id: directive.id, revision: directive.revision, hash: directive.hash });
    expect(report.baseCandidateRevision).toBe(0);
  });
});

describe("§37-§39/§81-§83/§E38-E40/E71-E72 — invalid/lost worker output is INDETERMINATE, never a fabricated report", () => {
  it("§81/E71 may_mutate + invalid output → indeterminate → reconciliation mode", async () => {
    const world = await supervisedWorld();
    const client = new FakeModelClient([() => "Looks good, tests pass."]);
    const { outcome } = await dispatchOnce(world, client, { objective: "mutating work" });
    expect(outcome).toMatchObject({ kind: "indeterminate", reason: "invalid_output" });
    expect(
      (await world.world.store.getExecutionAttempt((outcome as { attempt: { id: string } }).attempt.id as never))!.state,
    ).toBe("indeterminate");
    const recovery = (await world.world.store.buildExecutionRecoveryContext(world.run.id, { sessionID: EXEC_OWNER }))!;
    expect(recovery.reconciliationRequired).toBe(true);
    expect(recovery.unresolvedSideEffectingAttempts).toHaveLength(1);
  });

  it("§82/E72 non_mutating + invalid output → indeterminate, candidateRevision unchanged, reconciliationRequired FALSE, fresh verification issuable", async () => {
    const world = await supervisedWorld();
    const client = new FakeModelClient([() => "no structured output, sorry"]);
    const { outcome } = await dispatchOnce(world, client, {
      kind: "verification",
      objective: "interrupted verifier",
      candidateEffect: "non_mutating",
      capabilityEnvelope: { ...FULL_EXEC_CEILING, repositoryWrite: false },
    });
    expect(outcome).toMatchObject({ kind: "indeterminate", reason: "invalid_output" });
    const live = await execLive(world);
    expect(live.window.candidateRevision).toBe(0);
    const recovery = (await world.world.store.buildExecutionRecoveryContext(world.run.id, { sessionID: EXEC_OWNER }))!;
    expect(recovery.reconciliationRequired).toBe(false);
    expect(recovery.nonMutatingInterruptedAttempts).toHaveLength(1);
    expect(recovery.unresolvedSideEffectingAttempts).toHaveLength(0);
    // E3 — a fresh verification Directive may replace the lost work.
    const fresh = await issueDirective(world, { kind: "verification", objective: "fresh verify", candidateEffect: "non_mutating", capabilityEnvelope: { ...FULL_EXEC_CEILING, repositoryWrite: false } });
    expect(fresh.kind).toBe("verification");
  });

  it("§83/E38 a hanging worker invocation times out to indeterminate", async () => {
    const world = await supervisedWorld();
    const client = new FakeModelClient([], { hang: true });
    const adapter = workerAdapter(world, client, { timeoutMs: 40 });
    const { outcome } = await dispatchOnce(world, client, { objective: "slow work" }, adapter);
    expect(outcome).toMatchObject({ kind: "indeterminate", reason: "timeout" });
  });

  it("an aborted model message maps to cancelled; a silent host loss maps to host_lost_result", async () => {
    const world = await supervisedWorld();
    const cancelled = new FakeModelClient([], { messageError: { name: "MessageAbortedError" } });
    const cancelledAdapter = workerAdapter(world, cancelled);
    const a = await dispatchOnce(world, cancelled, { objective: "cancelled work" }, cancelledAdapter);
    expect(a.outcome).toMatchObject({ kind: "indeterminate", reason: "cancelled" });

    const world2 = await supervisedWorld();
    const silent = new FakeModelClient([() => ""]);
    const silentAdapter = workerAdapter(world2, silent);
    const b = await dispatchOnce(world2, silent, { objective: "silent work" }, silentAdapter);
    expect(b.outcome).toMatchObject({ kind: "indeterminate", reason: "missing_response" });
  });

  it("§84/§40/E37 — a VALID blocked report is a reported Attempt (never indeterminate)", async () => {
    const world = await supervisedWorld();
    const client = new FakeModelClient([
      () => JSON.stringify({
        directive: { id: "DIR-FAKE", revision: 1, hash: "x" },
        workerRole: "verifier",
        result: "blocked",
        actionsPerformed: [],
        filesExamined: [],
        filesChanged: [],
        commandsRun: [],
        testsRun: [],
        findings: [],
        deviations: [],
        blockers: [{ kind: "missing_context", summary: "the directive's plan ref does not resolve" }],
        deliverables: [],
        candidateMutation: "none",
        baseCandidateRevision: 7,
      }),
    ]);
    const adapter = workerAdapter(world, client);
    const { outcome } = await dispatchOnce(world, client, { objective: "will block" }, adapter);
    expect(outcome.kind).toBe("reported");
    if (outcome.kind === "reported") {
      expect(outcome.report.result).toBe("blocked");
      expect(outcome.report.blockers).toHaveLength(1);
      expect(outcome.report.workerRole).toBe("executor");
      // §40/E37 — the Attempt is REPORTED, never indeterminate.
      expect(outcome.attempt.state).toBe("reported");
    }
  });
});

describe("§31/§33/§76/§77/§E28-E30/E67/E68 — worker tool projection and the honest host ceiling", () => {
  it("the per-call tool map projects the EFFECTIVE envelope; control-plane and delegation tools are never exposed", async () => {
    const world = await supervisedWorld();
    const client = new FakeModelClient([() => fakeReportJSON()]);
    const adapter = workerAdapter(world, client);
    const { outcome } = await dispatchOnce(world, client, {
      objective: "read-only work",
      capabilityEnvelope: { ...FULL_EXEC_CEILING, repositoryWrite: false, networkAccess: false, gitCommit: false },
    }, adapter);
    expect(outcome.kind).toBe("reported");
    const tools = client.prompts[0]!.body.tools!;
    expect(tools["read"]).toBe(true);
    expect(tools["edit"]).toBe(false);
    expect(tools["write"]).toBe(false);
    expect(tools["patch"]).toBe(false);
    expect(tools["webfetch"]).toBe(false);
    expect(tools["bash"]).toBe(true);
    expect(tools["task"]).toBe(false);
    for (const name of ["ultraplan_start", "plan_memory"]) expect(tools[name]).toBe(false);
    // §76/E67 — no control-plane operation appears as a positive entry.
    for (const name of EXECUTION_SUPERVISOR_OPERATIONS) expect(tools[name]).not.toBe(true);
    // §30/E27 — the task message carries the directive + contract only.
    const message = client.prompts[0]!.body.parts[0]!.text;
    expect(message).toContain("DIRECTIVE");
    expect(message).toContain("REPORT CONTRACT");
    expect(message).not.toContain(EXEC_OWNER);
  });

  it("§77/E68 — Directive-false capabilities map to disabled tools; the host ceiling cannot be elevated", () => {
    const envelope = { repositoryRead: true, repositoryWrite: false, commandExecution: false, networkAccess: false, dependencyMutation: false, gitCommit: false, gitPush: false, externalServiceMutation: false };
    const { tools, projection } = projectWorkerToolMap(envelope, ["custom_host_tool"], []);
    expect(tools["read"]).toBe(true);
    expect(tools["grep"]).toBe(true);
    expect(tools["edit"]).toBe(false);
    expect(tools["bash"]).toBe(false);
    expect(tools["webfetch"]).toBe(false);
    expect(tools["custom_host_tool"]).toBe(false);
    // §32/§34/E31 — honest enforceability: no bash ⇒ the git family is transitively mechanical.
    const byCapability = new Map(projection.map((entry) => [entry.capability, entry]));
    expect(byCapability.get("commandExecution")!.enforceability).toBe("mechanical");
    expect(byCapability.get("gitCommit")!.enforceability).toBe("mechanical");
    expect(byCapability.get("dependencyMutation")!.enforceability).toBe("semantic_only");
    // With bash allowed, network/git become semantic subsets — never presented as a sandbox.
    const allowed = capabilityEnforceability({ ...envelope, commandExecution: true });
    const byCapabilityAllowed = new Map(allowed.map((entry) => [entry.capability, entry]));
    expect(byCapabilityAllowed.get("networkAccess")!.enforceability).toBe("semantic_only");
    expect(byCapabilityAllowed.get("gitPush")!.enforceability).toBe("semantic_only");
    // §33/E30 — a Directive cannot elevate the host ceiling.
    expectThrows(() => assertEnvelopeWithinHostCeiling({ ...envelope, repositoryWrite: true }, envelope), "invalid_scope");
  });

  it("§33 — the host permission ceiling derives from REAL config state", () => {
    const ceiling = deriveHostPermissionCeiling({
      permission: { bash: { "git push*": "deny" } },
      agent: { build: { tools: { write: false } } },
    });
    expect(ceiling.repositoryWrite).toBe(false);
    // A pattern-scoped bash deny is friction, not a full denial — the family stays available.
    expect(ceiling.commandExecution).toBe(true);
    const hardDenied = deriveHostPermissionCeiling({ permission: { bash: "deny" } });
    expect(hardDenied.commandExecution).toBe(false);
    expect(hardDenied.gitPush).toBe(false);
  });
});

describe("§69 — runtime tracing carries metadata only", () => {
  it("records started/completed with role, refs, projection, duration — never output content", async () => {
    const world = await supervisedWorld();
    const tracer = new InMemoryExecutionRuntimeTracer();
    const client = new FakeModelClient([() => fakeReportJSON()]);
    const adapter = new OpenCodeWorkerAdapter({
      client,
      policy: POLICY,
      hostCeiling: FULL_EXEC_CEILING,
      parentSessionID: EXEC_OWNER,
      tracer,
      registeredUltraPlanToolNames: [],
    });
    await dispatchOnce(world, client, { objective: "traced" }, adapter);
    const kinds = tracer.events.map((event) => event.kind);
    expect(kinds).toEqual(["worker_invocation_started", "worker_invocation_completed"]);
    expect(tracer.events[0]).toMatchObject({ modelRole: "executor", directiveRef: expect.any(String) });
    expect(tracer.events[1]).toMatchObject({ modelRole: "executor", result: "completed", durationMs: expect.any(Number) });
    const serialized = JSON.stringify(tracer.events);
    expect(serialized).not.toContain("did things");
    expect(serialized).not.toContain("all good");
  });
});

describe("§36/§35 — the strict worker output parser", () => {
  const valid = fakeReportJSON();
  it("accepts one complete JSON object (optionally fence-wrapped) and rejects everything else", () => {
    expect(parseWorkerReportOutput(valid).result).toBe("completed");
    expect(parseWorkerReportOutput("```json\n" + valid + "\n```").result).toBe("completed");
    expectThrows(() => parseWorkerReportOutput("Sure! " + valid), "worker_output_invalid");
    expectThrows(() => parseWorkerReportOutput(valid + " trailing"), "worker_output_invalid");
    expectThrows(() => parseWorkerReportOutput('{"result": "completed", "unknownField": 1}'), "worker_output_invalid");
    expectThrows(() => parseWorkerReportOutput(""), "worker_output_invalid");
    expectThrows(() => parseWorkerReportOutput('{"result": "nope"}'), "worker_output_invalid");
    expectThrows(() => parseWorkerReportOutput(JSON.stringify({ ...JSON.parse(valid), result: "blocked", blockers: [] })), "worker_output_invalid");
  });

  it("the supervisor tool map denies EVERYTHING (§21) and the worker task renderer is deterministic", () => {
    const map = projectSupervisorToolMap(["read", "grep", "custom"]);
    expect(map["read"]).toBe(false);
    expect(map["custom"]).toBe(false);
    expect(Object.values(map).every((value) => value === false)).toBe(true);
    const render = (directive: { id: string }) =>
      renderWorkerTaskMessage(
        {
          directive: { id: directive.id as never, revision: 1, kind: "implementation", objective: "o", planRefs: [], expectedExecutionScope: {}, capabilityEnvelope: FULL_EXEC_CEILING, candidateEffect: "may_mutate", invariants: [], requiredActions: [], forbiddenActions: [], validationRequirements: [], deliverables: [], stopConditions: [], reportContract: "", body: "", baseCandidateRevision: 0, createdAt: "", executionRunID: "EXEC-001" as never, stageID: "STAGE-001" as never, windowID: "WIN-001" as never, hash: "h", finalPlan: { id: "FP-001" as never, revision: 1 }, finalPlanHash: "h", baseAcceptedState: { kind: "execution_start", executionRunID: "EXEC-001" as never } },
          resolvedPlanRefs: [],
          finalPlanIdentity: { id: "FP-001", revision: 1, hash: "h", goal: "g" },
          runIdentity: { executionRunID: "EXEC-001" },
          stage: { id: "STAGE-001", title: "t", objective: "o" },
          window: { id: "WIN-001", baseAcceptedState: { kind: "execution_start", executionRunID: "EXEC-001" as never } },
          baseCandidateRevision: 0,
          effectiveCapabilities: FULL_EXEC_CEILING,
          role: "executor",
        },
        "executor",
      );
    expect(render({ id: "DIR-001" })).toBe(render({ id: "DIR-001" }));
    expect(EXECUTION_SUPERVISOR_SYSTEM_PROMPT.length).toBeGreaterThan(0);
  });
});
