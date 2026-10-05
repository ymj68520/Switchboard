/**
 * v0.2.0 Phase 5 — SupervisorAssessment, Verification Acceptance & ExecutionCommit.
 *
 * Covers the Phase 5 directive gates: the accepted-state model with no fake
 * EC-000 (§5/§E2), commit-anchored window bases (§6/E3), explicit immutable
 * Stage completion obligations with legacy fail-closed (§8-§10/E4-E5),
 * verification coverage declarations in the Directive hash (§11-§12/E6-E7),
 * machine-readable finding classification with legacy fail-closed (§13-§14/
 * E8), the durable SupervisorAssessment with exact bindings and idempotent
 * retry (§21-§30/E9-E15), the qualifying-verifier/negative-evidence/coverage
 * commit gates (§15-§20/§39-§42/E16-E21), the linear immutable commit chain
 * with window closure and acceptedHead advancement (§31-§37/E22-E31),
 * running/indeterminate attempt gates (§37-§38/E32-E33), atomicity (§31/E34),
 * window-only vs stage-scope commits with obligation accumulation (§43-§46/
 * E35-E40), no ExecutionRun completion (§48/E41), idempotent retry + accept
 * race (§49/§57/§75-§76/E42-E43), recovery (§56/E44), durable reopen (§78/
 * E45), malformed graph fail-closed (§79/E46), the non-goals (§2/E47-E51),
 * and the scope gates (§60-§61/E52-E53).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DurablePlanStore,
  EXECUTION_STAGE_TRANSITIONS,
  computeSupervisorAssessmentHash,
  type SupervisorAssessment,
  type ExecutionRun,
  type ExecutionStage,
  type FinalPlanID,
  type SupervisorAssessmentID,
  type VerificationWindow,
  type WorkerReportPayload,
} from "../src/index.js";
import {
  FIXED,
  WORKSPACE,
  durableHandoffPendingWorld,
  handoffPendingWorld,
  prepareInput,
  tamper,
  type HandoffPendingWorld,
} from "./execution-world.js";

const OWNER = "ses_accept_supervisor";
const AUTH = { sessionID: OWNER, workspace: WORKSPACE, generation: 1 };
const FULL_CEILING = {
  repositoryRead: true,
  repositoryWrite: true,
  commandExecution: true,
  networkAccess: true,
  dependencyMutation: true,
  gitCommit: true,
  gitPush: true,
  externalServiceMutation: true,
};

import type { InMemoryPlanStore as InMemoryPlanStoreType } from "../src/index.js";

/** Structural world shape (in-memory or durable store — both are InMemoryPlanStores). */
interface AcceptanceWorldStore {
  store: InMemoryPlanStoreType;
  runID: string;
  finalPlan: { id: FinalPlanID; revision: number; hash: string };
}
type AcceptanceWorld = { world: AcceptanceWorldStore; run: ExecutionRun; stage: ExecutionStage; window: VerificationWindow };

/** Supervised-active world with an obligation-bearing Stage + open window. */
async function acceptanceWorld(loaded?: HandoffPendingWorld, obligations = 1): Promise<AcceptanceWorld> {
  const base = (loaded ?? (await handoffPendingWorld())) as unknown as AcceptanceWorldStore;
  const { run } = await base.store.prepareInitialExecutionRun(prepareInput(base as never));
  await base.store.attachExecutionSupervisor({ executionRunID: run.id, sessionID: OWNER, workspace: WORKSPACE });
  const active = await base.store.activateSupervisedExecutionRun({
    executionRunID: run.id,
    sessionID: OWNER,
    workspace: WORKSPACE,
    generation: 1,
    runRevision: run.revision,
    finalPlan: run.finalPlan,
  });
  const stages = await base.store.createExecutionStages({
    executionRunID: active.id,
    ...AUTH,
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
    ...AUTH,
    expectedRunRevision: active.revision,
    expectedStageRevision: stage.revision,
  });
  const { window, run: openRun } = await base.store.openVerificationWindow({
    executionRunID: active.id,
    stageID: stage.id,
    ...AUTH,
    expectedRunRevision: activated.run.revision,
    expectedStageRevision: activated.stage.revision,
  });
  return { world: base, run: openRun, stage: activated.stage, window };
}

/** Issue → start → report helper. draft overrides merge over defaults. Reads LIVE revisions for CAS. */
async function runDirective(
  world: AcceptanceWorld,
  draft: Record<string, unknown>,
  report: Partial<WorkerReportPayload> = {},
) {
  const liveRun = (await world.world.store.getExecutionRun(world.run.id))!;
  const liveStage = (await world.world.store.getExecutionStage(world.stage.id))!;
  const liveWindow = (await world.world.store.findOpenVerificationWindow(world.run.id))!;
  const directive = await world.world.store.issueExecutionDirective({
    executionRunID: world.run.id,
    stageID: world.stage.id,
    windowID: world.window.id,
    ...AUTH,
    ceiling: FULL_CEILING,
    expectedRunRevision: liveRun.revision,
    expectedStageRevision: liveStage.revision,
    expectedWindowRevision: liveWindow.revision,
    draft: {
      kind: "implementation",
      objective: "work",
      planRefs: [{ kind: "implementation_step", order: 1 }],
      expectedExecutionScope: {},
      capabilityEnvelope: { ...FULL_CEILING },
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
    ...AUTH,
    ceiling: FULL_CEILING,
  });
  await world.world.store.submitExecutionReport({
    executionRunID: world.run.id,
    attemptID: attempt.id,
    ...AUTH,
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

/** A clean, current, qualifying verifier evidence bundle (§15). */
async function qualifyingVerification(world: AcceptanceWorld, coverage: string[] = [], draft: Record<string, unknown> = {}, report: Partial<WorkerReportPayload> = {}) {
  return runDirective(
    world,
    {
      kind: "verification",
      objective: "verify",
      candidateEffect: "non_mutating",
      capabilityEnvelope: { ...FULL_CEILING, repositoryWrite: false },
      ...(coverage.length > 0 ? { verificationCoverage: { obligationRefs: coverage } } : {}),
      ...draft,
    },
    { workerRole: "verifier", candidateMutation: "none", ...report },
  );
}

/** Re-read the live run/stage/window snapshots for CAS-exact calls. */
async function live(world: AcceptanceWorld) {
  const run = (await world.world.store.getExecutionRun(world.run.id))!;
  const stage = (await world.world.store.getExecutionStage(world.stage.id))!;
  const window = (await world.world.store.findOpenVerificationWindow(world.run.id))!;
  return { run, stage, window };
}

async function acceptInput(world: AcceptanceWorld, overrides: Record<string, unknown> = {}) {
  const run = (await world.world.store.getExecutionRun(world.run.id))!;
  const stage = (await world.world.store.getExecutionStage(world.stage.id))!;
  const window = (await world.world.store.findOpenVerificationWindow(world.run.id)) ?? (await (async () => {
    throw new Error("no open window for acceptInput");
  })());
  const { disposition, acceptanceScope, rationale, assessmentID, coveredObligations, ...rest } = overrides as {
    disposition?: string;
    acceptanceScope?: string;
    rationale?: string;
    assessmentID?: SupervisorAssessmentID;
    coveredObligations?: string[];
  };
  return {
    executionRunID: run.id,
    stageID: stage.id,
    windowID: window.id,
    candidateRevision: window.candidateRevision,
    ...AUTH,
    draft: {
      reportRefs: [] as never[],
      planRefs: [] as never[],
      coveredObligations: (coveredObligations ?? []) as never[],
      acceptanceScope: (acceptanceScope ?? "window") as never,
      disposition: (disposition ?? "accept") as never,
      rationale: rationale ?? "evidence is clean",
      ...(assessmentID !== undefined ? { assessmentID } : {}),
    },
    ...rest,
  };
};

// -----------------------------------------------------------------------------
// §5/§6/§E1-E3 — Accepted state model & commit-anchored window bases
// -----------------------------------------------------------------------------

describe("accepted state model (§5/§6)", () => {
  it("no fake EC-000: fresh window anchors execution_start; acceptedHead absent (§5/E2)", async () => {
    const world = await acceptanceWorld();
    expect(world.run.acceptedHead).toBeUndefined();
    expect(world.window.baseAcceptedState).toEqual({ kind: "execution_start", executionRunID: world.run.id });
  });

  it("after a commit, the NEXT window anchors execution_commit EC-001 (§6/E3)", async () => {
    const world = await acceptanceWorld();
    await runDirective(world, {});
    await qualifyingVerification(world);
    await world.world.store.submitSupervisorAssessment(await acceptInput(world));
    // Window-only commit: stage stays active → open the next window.
    const { run, stage } = await live(world);
    const next = await world.world.store.openVerificationWindow({
      executionRunID: run.id,
      stageID: stage.id,
      ...AUTH,
      expectedRunRevision: run.revision,
      expectedStageRevision: stage.revision,
    });
    expect(next.window.baseAcceptedState).toEqual({ kind: "execution_commit", executionCommitID: "EC-001" });
  });
});

// -----------------------------------------------------------------------------
// §8-§10/§E4-E5 — Stage completion obligations
// -----------------------------------------------------------------------------

describe("stage completion obligations (§8-§10)", () => {
  it("obligations are store-assigned, immutable, and FinalPlan-reachable", async () => {
    const world = await acceptanceWorld(undefined, 2);
    expect(world.stage.completionObligations!.map((obligation) => obligation.id)).toEqual(["OBS-001", "OBS-002"]);
    // Invalid obligation planRefs are refused at creation.
    const base = await handoffPendingWorld();
    await expect(
      (async () => {
        const w = base as unknown as AcceptanceWorldStore;
        const { run } = await w.store.prepareInitialExecutionRun(prepareInput(base as never));
        await w.store.attachExecutionSupervisor({ executionRunID: run.id, sessionID: OWNER, workspace: WORKSPACE });
        const active = await w.store.activateSupervisedExecutionRun({
          executionRunID: run.id, sessionID: OWNER, workspace: WORKSPACE, generation: 1, runRevision: run.revision, finalPlan: run.finalPlan,
        });
        return w.store.createExecutionStages({
          executionRunID: active.id, ...AUTH,
          drafts: [{ title: "s", objective: "o", planRefs: [], dependsOn: [], completionObligations: [{ description: "x", planRefs: [{ kind: "section_revision", id: "SEC-001" as never, revision: 9 }] }] }],
        });
      })(),
    ).rejects.toMatchObject({ code: "invalid_scope" });
  });

  it("a legacy Stage WITHOUT obligations can never silently complete (§10/E5)", async () => {
    // A pre-Phase-5 Stage: build the world WITHOUT obligations (Phase 3-style draft).
    const legacyBase = await handoffPendingWorld();
    const legacyStore = legacyBase.store;
    const { run: legacyRun } = await legacyStore.prepareInitialExecutionRun(prepareInput(legacyBase));
    await legacyStore.attachExecutionSupervisor({ executionRunID: legacyRun.id, sessionID: OWNER, workspace: WORKSPACE });
    const legacyActive = await legacyStore.activateSupervisedExecutionRun({
      executionRunID: legacyRun.id, sessionID: OWNER, workspace: WORKSPACE, generation: 1, runRevision: legacyRun.revision, finalPlan: legacyRun.finalPlan,
    });
    const legacyStages = await legacyStore.createExecutionStages({
      executionRunID: legacyActive.id, ...AUTH,
      drafts: [{ title: "legacy", objective: "o", planRefs: [{ kind: "implementation_step", order: 1 }], dependsOn: [] }],
    });
    const legacyStage = legacyStages[0]!;
    const legacyActivated = await legacyStore.activateExecutionStage({
      executionRunID: legacyActive.id, stageID: legacyStage.id, ...AUTH,
      expectedRunRevision: legacyActive.revision, expectedStageRevision: legacyStage.revision,
    });
    await legacyStore.openVerificationWindow({
      executionRunID: legacyActive.id, stageID: legacyStage.id, ...AUTH,
      expectedRunRevision: legacyActivated.run.revision, expectedStageRevision: legacyActivated.stage.revision,
    });
    const legacyWorld: AcceptanceWorld = {
      world: { store: legacyStore, runID: legacyBase.runID, finalPlan: legacyBase.finalPlan },
      run: (await legacyStore.getExecutionRun(legacyRun.id))!,
      stage: (await legacyStore.getExecutionStage(legacyStage.id))!,
      window: (await legacyStore.findOpenVerificationWindow(legacyRun.id))!,
    };
    await runDirective(legacyWorld, {});
    await qualifyingVerification(legacyWorld);
    await expect(
      legacyStore.submitSupervisorAssessment(await acceptInput({ ...legacyWorld, run: (await legacyStore.getExecutionRun(legacyRun.id))!, stage: (await legacyStore.getExecutionStage(legacyStage.id))!, window: (await legacyStore.findOpenVerificationWindow(legacyRun.id))! }, { acceptanceScope: "stage" })),
    ).rejects.toMatchObject({ code: "stage_completion_obligations_missing" });
  });
});

// -----------------------------------------------------------------------------
// §11-§14/§E6-E8 — Verification coverage & finding classification
// -----------------------------------------------------------------------------

describe("verification coverage & findings (§11-§14)", () => {
  it("coverage is verification-kind-only and must reference real obligations; it participates in the hash (§11/§12/E6-E7)", async () => {
    const world = await acceptanceWorld(undefined, 1);
    await expect(
      world.world.store.issueExecutionDirective({
        executionRunID: world.run.id, stageID: world.stage.id, windowID: world.window.id, ...AUTH, ceiling: FULL_CEILING,
        expectedRunRevision: world.run.revision, expectedStageRevision: world.stage.revision, expectedWindowRevision: world.window.revision,
        draft: { kind: "implementation", objective: "x", planRefs: [], expectedExecutionScope: {}, capabilityEnvelope: { ...FULL_CEILING }, candidateEffect: "non_mutating", invariants: [], requiredActions: [], forbiddenActions: [], validationRequirements: [], deliverables: [], stopConditions: [], reportContract: "", body: "", verificationCoverage: { obligationRefs: ["OBS-001" as never] } },
      }),
    ).rejects.toMatchObject({ code: "invalid_scope" });
    await expect(
      world.world.store.issueExecutionDirective({
        executionRunID: world.run.id, stageID: world.stage.id, windowID: world.window.id, ...AUTH, ceiling: FULL_CEILING,
        expectedRunRevision: world.run.revision, expectedStageRevision: world.stage.revision, expectedWindowRevision: world.window.revision,
        draft: { kind: "verification", objective: "x", planRefs: [], expectedExecutionScope: {}, capabilityEnvelope: { ...FULL_CEILING, repositoryWrite: false }, candidateEffect: "non_mutating", invariants: [], requiredActions: [], forbiddenActions: [], validationRequirements: [], deliverables: [], stopConditions: [], reportContract: "", body: "", verificationCoverage: { obligationRefs: ["OBS-099" as never] } },
      }),
    ).rejects.toMatchObject({ code: "invalid_scope" });
    // Hash discipline: coverage changes the hash.
    const withCoverage = await world.world.store.issueExecutionDirective({
      executionRunID: world.run.id, stageID: world.stage.id, windowID: world.window.id, ...AUTH, ceiling: FULL_CEILING,
      expectedRunRevision: world.run.revision, expectedStageRevision: world.stage.revision, expectedWindowRevision: world.window.revision,
      draft: { kind: "verification", objective: "v", planRefs: [], expectedExecutionScope: {}, capabilityEnvelope: { ...FULL_CEILING, repositoryWrite: false }, candidateEffect: "non_mutating", invariants: [], requiredActions: [], forbiddenActions: [], validationRequirements: [], deliverables: [], stopConditions: [], reportContract: "", body: "same body", verificationCoverage: { obligationRefs: ["OBS-001" as never] } },
    });
    const withoutCoverage = await world.world.store.issueExecutionDirective({
      executionRunID: world.run.id, stageID: world.stage.id, windowID: world.window.id, ...AUTH, ceiling: FULL_CEILING,
      expectedRunRevision: world.run.revision, expectedStageRevision: world.stage.revision, expectedWindowRevision: world.window.revision,
      draft: { kind: "verification", objective: "v", planRefs: [], expectedExecutionScope: {}, capabilityEnvelope: { ...FULL_CEILING, repositoryWrite: false }, candidateEffect: "non_mutating", invariants: [], requiredActions: [], forbiddenActions: [], validationRequirements: [], deliverables: [], stopConditions: [], reportContract: "", body: "same body" },
    });
    expect(withCoverage.hash).not.toBe(withoutCoverage.hash);
  });

  it("an unclassified verifier finding is never positive evidence (§14/E8; Phase 6A §37 blocks on the effective evidence ref)", async () => {
    const world = await acceptanceWorld();
    await runDirective(world, {});
    await qualifyingVerification(world, [], {}, { findings: ["something odd but unclassified"] });
    await expect(world.world.store.submitSupervisorAssessment(await acceptInput(world))).rejects.toMatchObject({ code: "blocking_verification_result" });
    // Nothing was persisted by the failed accept.
    expect(await world.world.store.findOpenVerificationWindow(world.run.id)).toBeDefined();
    expect(((await world.world.store.getExecutionRun(world.run.id))!).acceptedHead).toBeUndefined();
  });
});

// -----------------------------------------------------------------------------
// §62-§67/§E16-E20 — The verification gates
// -----------------------------------------------------------------------------

describe("acceptance gates (§62-§67)", () => {
  it("§62 happy path: implementation + clean current verification → accept commits", async () => {
    const world = await acceptanceWorld();
    await runDirective(world, {});
    await qualifyingVerification(world);
    const { assessment, commit } = (await world.world.store.submitSupervisorAssessment(await acceptInput(world))) as { assessment: { id: string; disposition: string }; commit: { id: string } };
    expect(assessment.disposition).toBe("accept");
    expect(commit.id).toBe("EC-001");
    const run = (await world.world.store.getExecutionRun(world.run.id))!;
    expect(run.acceptedHead).toBe("EC-001");
    expect(run.openWindow).toBeUndefined();
    expect((await world.world.store.findOpenVerificationWindow(world.run.id))).toBeUndefined();
    const stage = (await world.world.store.getExecutionStage(world.stage.id))!;
    expect(stage.status).toBe("active"); // window-only scope
  });

  it("§63 no verification → VERIFICATION_REQUIRED and NOTHING persists", async () => {
    const world = await acceptanceWorld();
    await runDirective(world, {}); // implementation only
    await expect(world.world.store.submitSupervisorAssessment(await acceptInput(world))).rejects.toMatchObject({ code: "verification_required" });
    expect(((await world.world.store.getExecutionRun(world.run.id))!).acceptedHead).toBeUndefined();
    expect((await world.world.store.findOpenVerificationWindow(world.run.id))!.state).toBe("open");
    // No assessment was persisted as accepted truth.
    expect(await world.world.store.getSupervisorAssessment("SA-001" as never)).toBeUndefined();
  });

  it("§64 stale verification cannot verify a newer candidate", async () => {
    const world = await acceptanceWorld();
    await runDirective(world, {}); // candidate 0 → 1
    await qualifyingVerification(world); // verifies candidate 1 (base 1... wait — base was 0)
    // Advance the candidate after verification (simulating late rework evidence ordering).
    await runDirective(world, { objective: "late rework" }); // 1 → 2
    await expect(world.world.store.submitSupervisorAssessment(await acceptInput(world))).rejects.toMatchObject({ code: "verification_required" });
  });

  it("§65 a mutating verifier report cannot verify its own resulting candidate", async () => {
    const world = await acceptanceWorld();
    await runDirective(world, {});
    // Verifier that MUTATES: advances 0 → 1.
    await qualifyingVerification(world, [], {}, { candidateMutation: "changed" });
    expect((await world.world.store.findOpenVerificationWindow(world.run.id))!.candidateRevision).toBe(2);
    await expect(world.world.store.submitSupervisorAssessment(await acceptInput(world))).rejects.toMatchObject({ code: "verification_required" });
  });

  it("§66 negative current verifier evidence blocks: failed / partial / blocked / blocking finding", async () => {
    for (const [index, variant] of (
      [
        { result: "failed" },
        { result: "partial" },
        { result: "blocked", blockers: [{ kind: "missing_context", summary: "x" }] },
        { result: "completed", candidateMutation: "none", findings: [{ statement: "defect", acceptanceImpact: "blocking" }] },
      ] as (Partial<WorkerReportPayload>)[]
    ).entries()) {
      const world = await acceptanceWorld();
      await runDirective(world, {});
      await qualifyingVerification(world, [], {}, { ...variant });
      await expect(world.world.store.submitSupervisorAssessment(await acceptInput(world))).rejects.toMatchObject({ code: "blocking_verification_result" });
      void index;
    }
  });

  it("§67 older-revision negative evidence does not block a newer verified candidate", async () => {
    const world = await acceptanceWorld();
    await runDirective(world, {}); // 0 → 1
    // Negative verification of candidate 1.
    await qualifyingVerification(world, [], {}, { result: "failed", findings: [] });
    // Wait — failed + non-mutating does NOT advance; the failed report is CURRENT (base 1).
    // Rework: implementation mutates 1 → 2, making the failed report historical.
    await runDirective(world, { objective: "rework" });
    // Fresh clean verification of candidate 2.
    await qualifyingVerification(world, [], { objective: "fresh verify" });
    const { commit } = (await world.world.store.submitSupervisorAssessment(await acceptInput(world))) as { commit: { id: string } };
    expect(commit.id).toBe("EC-001");
  });
});

// -----------------------------------------------------------------------------
// §68/§E21 — Coverage gate
// -----------------------------------------------------------------------------

describe("coverage gate (§68)", () => {
  it("covering O2 without verifier coverage for O2 fails VERIFICATION_REQUIRED; with coverage it passes", async () => {
    const world = await acceptanceWorld(undefined, 2);
    await runDirective(world, {});
    // V1 covers only O1.
    await qualifyingVerification(world, ["OBS-001" as never], { objective: "v1" });
    await expect(
      world.world.store.submitSupervisorAssessment(await acceptInput(world, { coveredObligations: ["OBS-001" as never, "OBS-002" as never] })),
    ).rejects.toMatchObject({ code: "verification_required" });
    // V2 covers O2 (same candidate — non-mutating verifications keep candidateRevision stable).
    await qualifyingVerification(world, ["OBS-002" as never], { objective: "v2" });
    const { commit } = (await world.world.store.submitSupervisorAssessment(await acceptInput(world, { coveredObligations: ["OBS-001" as never, "OBS-002" as never] }))) as { commit: { satisfiedObligations: string[] } };
    expect(commit.satisfiedObligations).toEqual(["OBS-001", "OBS-002"]);
  });
});

// -----------------------------------------------------------------------------
// §44/§45/§69-§71/§E35-E40 — Window-only vs stage-scope commits
// -----------------------------------------------------------------------------

describe("stage scope & obligation accumulation (§43-§46/§69-§71)", () => {
  it("§69 window-only commit: window closed, acceptedHead advanced, Stage stays active, next window anchors EC-1", async () => {
    const world = await acceptanceWorld(undefined, 2);
    await runDirective(world, {});
    await qualifyingVerification(world, ["OBS-001" as never], { objective: "v (OBS-001 only)" });
    await world.world.store.submitSupervisorAssessment(await acceptInput(world, { coveredObligations: ["OBS-001" as never] }));
    const run = (await world.world.store.getExecutionRun(world.run.id))!;
    expect(run.acceptedHead).toBe("EC-001");
    expect(run.openWindow).toBeUndefined();
    expect(run.activeStage).toBe(world.stage.id);
    const stage = (await world.world.store.getExecutionStage(world.stage.id))!;
    expect(stage.status).toBe("active");
    // Next window anchors EC-001; complete the remaining obligation with stage scope.
    const next = await world.world.store.openVerificationWindow({
      executionRunID: run.id, stageID: stage.id, ...AUTH, expectedRunRevision: run.revision, expectedStageRevision: stage.revision,
    });
    const world2: AcceptanceWorld = { ...world, run: next.run, stage: (await world.world.store.getExecutionStage(world.stage.id))!, window: next.window };
    await runDirective(world2, { objective: "second window work" });
    await qualifyingVerification(world2, ["OBS-002"], { objective: "v2" });
    await world2.world.store.submitSupervisorAssessment(
      await acceptInput({ ...world2, run: (await world2.world.store.getExecutionRun(world2.run.id))!, stage: (await world2.world.store.getExecutionStage(world2.stage.id))!, window: (await world2.world.store.findOpenVerificationWindow(world2.run.id))! }, {
        coveredObligations: ["OBS-002" as never],
        acceptanceScope: "stage",
      }),
    );
    const finalRun = (await world2.world.store.getExecutionRun(world2.run.id))!;
    expect(finalRun.activeStage).toBeUndefined(); // §39/E39
    expect((await world2.world.store.getExecutionStage(world2.stage.id))!.status).toBe("completed");
    expect(await world2.world.store.acceptedStageObligations(world2.run.id, world2.stage.id)).toEqual(["OBS-001", "OBS-002"]); // §43/E36
    // §48/E41: the run is NOT completed by the last Stage completion.
    expect(finalRun.lifecycle).toBe("active");
  });

  it("§71 incomplete stage closure fails the whole transaction", async () => {
    const world = await acceptanceWorld(undefined, 3);
    await runDirective(world, {});
    await qualifyingVerification(world, ["OBS-002" as never], { objective: "v2 only" });
    await expect(
      world.world.store.submitSupervisorAssessment(await acceptInput(world, { coveredObligations: ["OBS-002" as never], acceptanceScope: "stage" })),
    ).rejects.toMatchObject({ code: "stage_completion_incomplete" });
    expect(((await world.world.store.getExecutionRun(world.run.id))!).acceptedHead).toBeUndefined();
  });

  it("no direct stage-completion API exists (§46/E40)", () => {
    expect(EXECUTION_STAGE_TRANSITIONS.active).toEqual(["completed"]);
  });
});

// -----------------------------------------------------------------------------
// §37/§38/§72-§73/§E32-E33 — Attempt gates
// -----------------------------------------------------------------------------

describe("attempt gates (§37/§38)", () => {
  it("§73 a running Attempt blocks accept", async () => {
    const world = await acceptanceWorld();
    await runDirective(world, {});
    await qualifyingVerification(world);
    // Start an extra attempt on a second directive (same window) and leave it running.
    const liveRun = (await world.world.store.getExecutionRun(world.run.id))!;
    const liveStage = (await world.world.store.getExecutionStage(world.stage.id))!;
    const liveWindow = (await world.world.store.findOpenVerificationWindow(world.run.id))!;
    const directive = await world.world.store.issueExecutionDirective({
      executionRunID: world.run.id, stageID: world.stage.id, windowID: world.window.id, ...AUTH, ceiling: FULL_CEILING,
      expectedRunRevision: liveRun.revision, expectedStageRevision: liveStage.revision, expectedWindowRevision: liveWindow.revision,
      draft: { kind: "implementation", objective: "second", planRefs: [], expectedExecutionScope: {}, capabilityEnvelope: { ...FULL_CEILING }, candidateEffect: "may_mutate", invariants: [], requiredActions: [], forbiddenActions: [], validationRequirements: [], deliverables: [], stopConditions: [], reportContract: "", body: "" },
    });
    await world.world.store.startExecutionAttempt({
      executionRunID: world.run.id, directive: { id: directive.id, revision: directive.revision }, ...AUTH, ceiling: FULL_CEILING,
    });
    await expect(world.world.store.submitSupervisorAssessment(await acceptInput(world))).rejects.toMatchObject({ code: "active_attempt_conflict" });
  });

  it("§72 an unresolved indeterminate Attempt forces reconciliation mode and blocks accept (Phase 6A §42/§55 upgrade)", async () => {
    const world = await acceptanceWorld();
    // Raw directive+start (no report), then mark indeterminate.
    const directive = await world.world.store.issueExecutionDirective({
      executionRunID: world.run.id, stageID: world.stage.id, windowID: world.window.id, ...AUTH, ceiling: FULL_CEILING,
      expectedRunRevision: world.run.revision, expectedStageRevision: world.stage.revision, expectedWindowRevision: world.window.revision,
      draft: { kind: "implementation", objective: "doomed", planRefs: [], expectedExecutionScope: {}, capabilityEnvelope: { ...FULL_CEILING }, candidateEffect: "may_mutate", invariants: [], requiredActions: [], forbiddenActions: [], validationRequirements: [], deliverables: [], stopConditions: [], reportContract: "", body: "" },
    });
    const { attempt } = await world.world.store.startExecutionAttempt({
      executionRunID: world.run.id, directive: { id: directive.id, revision: directive.revision }, ...AUTH, ceiling: FULL_CEILING,
    });
    await world.world.store.markExecutionAttemptIndeterminate({ executionRunID: world.run.id, attemptID: attempt.id, ...AUTH });
    // Phase 6A: fresh work is no longer issuable at all — reconciliation mode.
    await expect(runDirective(world, { objective: "again" })).rejects.toMatchObject({ code: "reconciliation_required" });
    await expect(qualifyingVerification(world, [], { objective: "clean verify" })).rejects.toMatchObject({ code: "reconciliation_required" });
    await expect(world.world.store.submitSupervisorAssessment(await acceptInput(world))).rejects.toMatchObject({ code: "reconciliation_required" });
  });
});

// -----------------------------------------------------------------------------
// §25/§29/§E13-E14 — Non-accept dispositions
// -----------------------------------------------------------------------------

describe("non-accept dispositions (§25/§29)", () => {
  it("rework / need_more_verification / request_replan persist judgments and change NOTHING else (§29/E13-E14)", async () => {
    const world = await acceptanceWorld();
    for (const disposition of ["rework", "need_more_verification", "request_replan"] as const) {
      const before = (await world.world.store.getExecutionRun(world.run.id))!;
      const { assessment } = (await world.world.store.submitSupervisorAssessment(
        await acceptInput(world, { disposition, rationale: disposition, assessmentID: ("SA-1" + String(world.world.store === world.world.store ? disposition.length : 0)) as never }),
      )) as { assessment: { id: string; disposition: string } };
      expect(assessment.disposition).toBe(disposition);
      const after = (await world.world.store.getExecutionRun(world.run.id))!;
      expect(after.acceptedHead).toBeUndefined();
      expect(after.openWindow).toBeDefined();
      expect(after.lifecycle).toBe("active");
      expect(after.revision).toBe(before.revision); // no run mutation at all
      expect((await world.world.store.findOpenVerificationWindow(world.run.id))!.candidateRevision).toBe(0);
    }
    // request_replan does NOT transition the run lifecycle (§25/E14).
    const run = (await world.world.store.getExecutionRun(world.run.id))!;
    expect(run.lifecycle).toBe("active");
  });
});

// -----------------------------------------------------------------------------
// §49/§57/§74/§76/§E42-E45 — Idempotency, atomicity, durable reopen
// -----------------------------------------------------------------------------

describe("idempotent retry & durable atomicity (§49/§57/§74/§76)", () => {
  it("§76 same assessment id + same content returns the SAME assessment and SAME commit", async () => {
    const world = await acceptanceWorld();
    await runDirective(world, {});
    await qualifyingVerification(world);
    const id = "SA-001" as SupervisorAssessmentID;
    // The retry input is built BEFORE the first submit (the caller's retry
    // carries the same payload it originally sent).
    const retryInput = await acceptInput(world, { assessmentID: id });
    const first = (await world.world.store.submitSupervisorAssessment(await acceptInput(world, { assessmentID: id }))) as { assessment: { id: string }; commit: { id: string } };
    // The response was lost; the window is now closed. The retry reuses the
    // SAME payload — the store must return the existing result.
    const retry = (await world.world.store.submitSupervisorAssessment(retryInput as never)) as { assessment: { id: string }; commit: { id: string } };
    expect(retry.assessment.id).toBe(first.assessment.id);
    expect(retry.commit!.id).toBe(first.commit.id);
    expect(((await world.world.store.getExecutionRun(world.run.id))!).acceptedHead).toBe("EC-001");
    // Events not duplicated.
    const commitEvents = (await world.world.store.listEvents(world.world.runID as never)).filter((event) => event.detail.type === "execution.commit_created");
    expect(commitEvents).toHaveLength(1);
  });

  it("same assessment id + DIFFERENT content fails assessment_conflict (§27)", async () => {
    const world = await acceptanceWorld();
    await runDirective(world, {});
    await qualifyingVerification(world);
    const id = "SA-001" as SupervisorAssessmentID;
    const conflicting = await acceptInput(world, { assessmentID: id, rationale: "changed my mind" });
    await world.world.store.submitSupervisorAssessment(await acceptInput(world, { assessmentID: id }));
    await expect(
      world.world.store.submitSupervisorAssessment(conflicting as never),
    ).rejects.toMatchObject({ code: "assessment_conflict" });
  });

  it("§74 the accept transaction is one durable commit point (reopen shows the full result, no partial state)", async () => {
    let dir: string | undefined;
    try {
      dir = await mkdtemp(path.join(tmpdir(), "ultra-plan-accept-"));
      const file = path.join(dir, "plan.json");
      const loaded = await durableHandoffPendingWorld(file);
      const world = await acceptanceWorld(loaded as unknown as HandoffPendingWorld, 1);
      await runDirective(world, {});
      await qualifyingVerification(world, ["OBS-001" as never], { objective: "v1" });
      await world.world.store.submitSupervisorAssessment(await acceptInput(world, { coveredObligations: ["OBS-001" as never], acceptanceScope: "stage" }));
      (world.world.store as unknown as { close(): void }).close();
      const verify = new DurablePlanStore(file, { now: () => FIXED });
      const run = (await verify.getExecutionRun(world.run.id))!;
      expect(run.acceptedHead).toBe("EC-001");
      expect(run.openWindow).toBeUndefined();
      expect(run.activeStage).toBeUndefined();
      expect((await verify.getExecutionStage(world.stage.id))!.status).toBe("completed");
      expect((await verify.listExecutionCommitsForRun(world.run.id))).toHaveLength(1);
      verify.close();
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  });

  it("§78 the commit chain survives reopen exactly (linear chain, acceptedHead at tip)", async () => {
    let dir: string | undefined;
    try {
      dir = await mkdtemp(path.join(tmpdir(), "ultra-plan-chain-"));
      const file = path.join(dir, "plan.json");
      const loaded = await durableHandoffPendingWorld(file);
      const first = await acceptanceWorld(loaded as unknown as HandoffPendingWorld, 1);
      // Window 1 → EC-1.
      await runDirective(first, {});
      await qualifyingVerification(first, ["OBS-001"], { objective: "v1" });
      await first.world.store.submitSupervisorAssessment(await acceptInput(first, { coveredObligations: ["OBS-001" as never] }));
      // Window 2 → EC-2 (window-only).
      const r1 = (await first.world.store.getExecutionRun(first.run.id))!;
      const s1 = (await first.world.store.getExecutionStage(first.stage.id))!;
      const w2 = await first.world.store.openVerificationWindow({
        executionRunID: r1.id, stageID: s1.id, ...AUTH, expectedRunRevision: r1.revision, expectedStageRevision: s1.revision,
      });
      const second: AcceptanceWorld = { ...first, run: w2.run, stage: (await first.world.store.getExecutionStage(first.stage.id))!, window: w2.window };
      await runDirective(second, { objective: "w2 work" });
      await qualifyingVerification(second, [], { objective: "v2" });
      await second.world.store.submitSupervisorAssessment(await acceptInput(second));
      (second.world.store as unknown as { close(): void }).close();
      const verify = new DurablePlanStore(file, { now: () => FIXED });
      const run = (await verify.getExecutionRun(first.run.id))!;
      expect(run.acceptedHead).toBe("EC-002");
      const commits = await verify.listExecutionCommitsForRun(first.run.id);
      expect(commits).toHaveLength(2);
      expect(commits[0]!.parentAcceptedState).toEqual({ kind: "execution_start", executionRunID: first.run.id });
      expect(commits[1]!.parentAcceptedState).toEqual({ kind: "execution_commit", executionCommitID: "EC-001" });
      verify.close();
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  });
});

// -----------------------------------------------------------------------------
// §50/§75/§77/§E27-E30 — One commit per window, races, stale head
// -----------------------------------------------------------------------------

describe("commit uniqueness & head (§50/§75/§77)", () => {
  it("§77 a window anchored to a stale accepted state fails STALE_EXECUTION_HEAD — no branching", async () => {
    const world = await acceptanceWorld();
    await runDirective(world, {});
    await qualifyingVerification(world);
    const staleInput = await acceptInput(world);
    await world.world.store.submitSupervisorAssessment(staleInput as never);
    // A second accept through the (now closed) window fails closed: the
    // chain stays linear with exactly one commit.
    await expect(world.world.store.submitSupervisorAssessment(staleInput as never)).rejects.toMatchObject({ code: "assessment_stale" });
    // The durable chain stays linear with one commit.
    expect(await world.world.store.listExecutionCommitsForRun(world.run.id)).toHaveLength(1);
  });

  it("§75 two durable instances racing to accept the SAME window produce exactly ONE commit (E43)", async () => {
    let dir: string | undefined;
    try {
      dir = await mkdtemp(path.join(tmpdir(), "ultra-plan-accept-race-"));
      const file = path.join(dir, "plan.json");
      const loaded = await durableHandoffPendingWorld(file);
      const world = await acceptanceWorld(loaded as unknown as HandoffPendingWorld, 1);
      await runDirective(world, {});
      await qualifyingVerification(world);
      (world.world.store as unknown as { close(): void }).close();
      const a = new DurablePlanStore(file, { now: () => FIXED });
      const b = new DurablePlanStore(file, { now: () => FIXED });
      const input = await acceptInput(world);
      const [ra, rb] = await Promise.allSettled([
        a.submitSupervisorAssessment(input as never),
        b.submitSupervisorAssessment(input as never),
      ]);
      a.close();
      b.close();
      expect([ra, rb].filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const verify = new DurablePlanStore(file, { now: () => FIXED });
      expect(await verify.listExecutionCommitsForRun(world.run.id)).toHaveLength(1);
      const run = (await verify.getExecutionRun(world.run.id))!;
      expect(run.acceptedHead).toBe("EC-001");
      expect(run.openWindow).toBeUndefined();
      const commitEvents = (await verify.listEvents(loaded.runID)).filter((event) => event.detail.type === "execution.commit_created");
      expect(commitEvents).toHaveLength(1);
      verify.close();
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  });
});

// -----------------------------------------------------------------------------
// §56/§E44 — Recovery context
// -----------------------------------------------------------------------------

describe("recovery context (§56)", () => {
  it("exposes acceptedHead, current accepted state, latest commit, and Stage obligation progress", async () => {
    const world = await acceptanceWorld(undefined, 2);
    await runDirective(world, {});
    await qualifyingVerification(world, ["OBS-001" as never], { objective: "v1" });
    await world.world.store.submitSupervisorAssessment(await acceptInput(world, { coveredObligations: ["OBS-001" as never] }));
    const context = (await world.world.store.buildExecutionRecoveryContext(world.run.id, { sessionID: OWNER }))!;
    expect(context["acceptedHead"]).toBe("EC-001");
    expect(context["currentAcceptedState"]).toEqual({ kind: "execution_commit", executionCommitID: "EC-001" });
    expect(context["latestCommit"]).toMatchObject({ id: "EC-001", stageCompleted: false });
    expect(context["stageAcceptedObligations"]).toEqual(["OBS-001"]);
    expect(context["stageRemainingObligations"]).toEqual(["OBS-002"]);
  });
});

// -----------------------------------------------------------------------------
// §79/§80/§E46/E54 — Malformed graph & backward compatibility
// -----------------------------------------------------------------------------

describe("malformed graph & compatibility (§79/§80)", () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "ultra-plan-accept-mig-"));
    filePath = path.join(dir, "plan.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("§80 pre-Phase-5 stores open with empty acceptance families and intact history", async () => {
    const world = await durableHandoffPendingWorld(filePath);
    const aw = await acceptanceWorld(world as unknown as HandoffPendingWorld);
    (aw.world.store as unknown as { close(): void }).close();
    await tamper(filePath, (raw) => {
      delete raw["supervisorAssessments"];
      delete raw["executionCommits"];
      delete raw["executionCommitByWindow"];
      delete raw["executionCommitByAssessment"];
    });
    const migrated = new DurablePlanStore(filePath, { now: () => FIXED });
    const run = (await migrated.getExecutionRun(aw.run.id))!;
    expect(run.acceptedHead).toBeUndefined();
    expect(await migrated.listSupervisorAssessmentsForRun(aw.run.id)).toEqual([]);
    expect(await migrated.listExecutionCommitsForRun(aw.run.id)).toEqual([]);
    expect((await migrated.listExecutionStagesForRun(aw.run.id)).length).toBe(1);
    expect(await migrated.findOpenVerificationWindow(aw.run.id)).toBeDefined();
    migrated.close();
  });

  it("§79 malformed acceptance graphs fail closed", async () => {
    const pristineFile = path.join(dir, "pristine.json");
    const loaded = await durableHandoffPendingWorld(pristineFile);
    const world = await acceptanceWorld(loaded as unknown as HandoffPendingWorld, 1);
    await runDirective(world, {});
    await qualifyingVerification(world, ["OBS-001" as never], { objective: "v1" });
    await world.world.store.submitSupervisorAssessment(await acceptInput(world, { coveredObligations: ["OBS-001" as never] }));
    (world.world.store as unknown as { close(): void }).close();
    const reopenable = new DurablePlanStore(pristineFile, { now: () => FIXED });
    reopenable.close();
    const pristine = JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(pristineFile, "utf8"))) as Record<string, unknown>;
    const family = (raw: Record<string, unknown>, key: string): Record<string, Record<string, unknown>> => raw[key] as Record<string, Record<string, unknown>>;
    const cases: readonly (readonly [string, (raw: Record<string, unknown>) => void, RegExp])[] = [
      ["commit-missing-assessment", (raw) => { delete family(raw, "supervisorAssessments")["SA-001"]; }, /references missing SupervisorAssessment/],
      ["commit-non-accept", (raw) => {
        const record = family(raw, "supervisorAssessments")["SA-001"]!;
        record["disposition"] = "rework";
        // Re-seal so the disposition check fires (not the hash check).
        const clone = { ...(record as unknown as SupervisorAssessment) };
        const { createdAt: _c, hash: _h, ...payload } = clone;
        void _c;
        void _h;
        record["hash"] = computeSupervisorAssessmentHash(payload);
      }, /non-accept assessment/],
      ["commit-candidate-mismatch", (raw) => { family(raw, "executionCommits")["EC-001"]!["candidateRevision"] = 9; }, /binding disagrees/],
      ["commit-two-per-window", (raw) => {
        const clone = structuredClone(family(raw, "executionCommits")["EC-001"]!);
        clone["id"] = "EC-002";
        family(raw, "executionCommits")["EC-002"] = clone;
      }, /two execution commits|is not indexed as its window/],
      ["acceptedhead-not-tip", (raw) => {
        const execRunID = Object.keys(family(raw, "executionRuns"))[0]!;
        family(raw, "executionRuns")[execRunID]!["acceptedHead"] = "EC-099";
      }, /acceptedHead .* is not the chain tip/],
      ["closed-window-without-commit", (raw) => { delete family(raw, "executionCommits")["EC-001"]; }, /not closed|is not indexed|references missing commit/],
      ["covered-unknown-obligation", (raw) => {
        const record = family(raw, "supervisorAssessments")["SA-001"]!;
        record["coveredObligations"] = ["OBS-099"];
        const clone = { ...(record as unknown as SupervisorAssessment) };
        const { createdAt: _c, hash: _h, ...payload } = clone;
        void _c;
        void _h;
        record["hash"] = computeSupervisorAssessmentHash(payload);
      }, /covers unknown Stage obligation/],
      ["commit-satisfied-unknown-obligation", (raw) => { family(raw, "executionCommits")["EC-001"]!["satisfiedObligations"] = ["OBS-099"]; }, /satisfies unknown Stage obligation/],
      ["completed-stage-without-closure", (raw) => {
        // A completed Stage whose only commit denies stage closure: no valid closure provenance.
        const stageID = String(family(raw, "executionCommits")["EC-001"]!["stageID"]);
        family(raw, "executionCommits")["EC-001"]!["stageCompleted"] = false;
        family(raw, "executionStages")[stageID]!["status"] = "completed";
        const execRunID = String(family(raw, "executionCommits")["EC-001"]!["executionRunID"]);
        delete family(raw, "executionRuns")[execRunID]!["activeStage"];
      }, /has no closure commit/],
    ];
    for (const [name, mutate, pattern] of cases) {
      const caseFile = path.join(dir, `malformed-${name}.json`);
      const raw = structuredClone(pristine) as Record<string, unknown>;
      mutate(raw);
      const { writeFile } = await import("node:fs/promises");
      await writeFile(caseFile, JSON.stringify(raw));
      let lastError: unknown;
      try {
        new DurablePlanStore(caseFile, { now: () => FIXED }).open();
      } catch (error) {
        lastError = error;
      }
      expect((lastError as Error | undefined)?.message ?? "no error thrown").toMatch(pattern);
    }
  }, 30_000);
});

// -----------------------------------------------------------------------------
// §60-§61/§E52-E53 — Scope gates
// -----------------------------------------------------------------------------

describe("scope gates (§60/§61)", () => {
  it("no model-facing acceptance tool exists (§60/E52)", async () => {
    const { TOOL_CONTRACTS } = await import("../src/index.js");
    expect(Object.keys(TOOL_CONTRACTS).filter((name) => /assess|accept|commit/i.test(name))).toEqual([]);
  });

  it("the v0.1 production handoff creates NONE of the Phase 1-5 artifacts (§61/E53)", async () => {
    const world = await handoffPendingWorld();
    const result = await world.controller.recoverExecutionHandoff(world.sessionID);
    expect(result.status).toBe("completed");
    expect(await world.store.listOpenExecutionRuns()).toHaveLength(0);
    const events = (await world.store.listEvents(world.runID)).map((event) => event.detail.type);
    expect(events.filter((type) => type.startsWith("execution."))).toEqual([]);
  });

  it("no setAcceptedHead / direct closure APIs exist anywhere (§34/§35/§46)", async () => {
    const world = await acceptanceWorld();
    const storeShape = Object.getOwnPropertyNames(Object.getPrototypeOf(world.world.store) as Record<string, unknown>);
    expect(storeShape.some((name) => /set.*acceptedhead|close.*window|complete.*stage/i.test(name) && !name.includes("seed"))).toBe(false);
  });
});
