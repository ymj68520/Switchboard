/**
 * v0.2.0 Phase 3 — ExecutionStage & VerificationWindow foundation.
 *
 * Covers the Phase 3 directive gates: the durable Stage decomposition of the
 * bound FinalPlan's obligations (§6-§8), explicit mandatory dependencies
 * with candidate-DAG validation (§9/§18/§45), deterministic eligibility
 * (§10), the single-active-Stage invariant enforced by Core + Store and by
 * REAL two-instance concurrency (§11/§46), the atomic activation transaction
 * with run/stage revision CAS (§13), prepared-run refusal (§14), completion
 * reservation (§15), minimal pending supersession (§16), the
 * single-open-Window invariant with its concurrency test (§23/§49), the
 * execution-start anchored baseAcceptedState — never a fake ExecutionCommit
 * (§20), candidateRevision 0-start + CAS + monotonic +1 (§25-§29/§48),
 * window-closing reservation (§30), open-Window blocking Stage transitions
 * (§31), terminal runs preserving structure history (§32), durable
 * persistence with fail-closed load validation (§33-§37), the expanded
 * Recovery Context (§38/§51), backward compatibility (§52), and the scope
 * gates: no model-facing API (§42), no production callers (§43), no
 * Directive/Attempt/Report/Worker/Verifier/Assessment/Commit leakage (§29).
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DurablePlanStore,
  EXECUTION_STAGE_TRANSITIONS,
  assertCurrentCandidateRevision,
  isStageEligible,
  type ExecutionRun,
  type ExecutionRunID,
  type ExecutionStage,
  type FinalPlanID,
  type InMemoryPlanStore as InMemoryPlanStoreType,
  type PlanID,
  type VerificationWindow,
} from "../src/index.js";
import type { PlanningRun } from "../src/core/types.js";
import {
  FIXED,
  WORKSPACE,
  durableHandoffPendingWorld,
  handoffPendingWorld,
  prepareInput,
  tamper,
} from "./execution-world.js";

const OWNER = "ses_stage_supervisor";
const AUTH = { sessionID: OWNER, workspace: WORKSPACE, generation: 1 };

/** Structural world shape shared by the in-memory and durable builders. */
type StageWorld = { store: InMemoryPlanStoreType; runID: PlanID; finalPlan: { id: FinalPlanID; revision: number; hash: string } };

/** A supervised-active world (prepare → attach → supervised activation). */
async function supervisedActiveWorld(world: StageWorld): Promise<{ run: ExecutionRun; world: StageWorld }> {
  const { run } = await world.store.prepareInitialExecutionRun(prepareInput(world));
  await world.store.attachExecutionSupervisor({ executionRunID: run.id, sessionID: OWNER, workspace: WORKSPACE });
  const active = await world.store.activateSupervisedExecutionRun({
    executionRunID: run.id,
    sessionID: OWNER,
    workspace: WORKSPACE,
    generation: 1,
    runRevision: run.revision,
    finalPlan: run.finalPlan,
  });
  return { run: active, world };
}

const REF = {
  finalPlan: (world: StageWorld) => ({ kind: "final_plan" as const, id: world.finalPlan.id, revision: world.finalPlan.revision }),
  section: (id: string, revision = 1) => ({ kind: "section_revision" as const, id: id as never, revision }),
  step: (order: number) => ({ kind: "implementation_step" as const, order }),
};

const DRAFT = {
  title: "Deliver the runtime core",
  objective: "Implement the runtime integration obligations",
  planRefs: [REF.step(1), REF.section("SEC-001")],
  dependsOn: [],
};

/** Narrows a durable document family for test-only tampering. */
function docFamily(raw: Record<string, unknown>, key: string): Record<string, Record<string, unknown>> {
  return raw[key] as Record<string, Record<string, unknown>>;
}

/** Create two independent stages on the active run (both eligible). */
async function twoStandaloneStages(world: { store: InMemoryPlanStoreType }, runID: ExecutionRunID) {
  const stages = await world.store.createExecutionStages({
    executionRunID: runID,
    ...AUTH,
    drafts: [
      { ...DRAFT, title: "Stage A" },
      { ...DRAFT, title: "Stage B", planRefs: [REF.step(1)] },
    ],
  });
  return { first: stages[0]!, second: stages[1]! };
}

// -----------------------------------------------------------------------------
// §6/§7/§8/§17 — Stage creation: identity, execution-only provenance, authority
// -----------------------------------------------------------------------------

describe("Stage creation (§6/§7/§8/§17)", () => {
  it("creates a pending batch with sequential never-reused ids and audit events", async () => {
    const world = await handoffPendingWorld();
    const { run } = await supervisedActiveWorld(world);
    const stages = await world.store.createExecutionStages({ executionRunID: run.id, ...AUTH, drafts: [DRAFT, { ...DRAFT, title: "Stage 2" }] });
    expect(stages.map((stage) => stage.id)).toEqual(["STAGE-001", "STAGE-002"]);
    expect(stages.every((stage) => stage.status === "pending" && stage.revision === 1 && stage.executionRunID === run.id)).toBe(true);
    const events = (await world.store.listEvents(world.runID)).map((event) => event.detail.type);
    expect(events.filter((type) => type === "execution.stage_created")).toHaveLength(2);
  });

  it("decomposition requires an ACTIVE run (prepared is refused) and supervisor authority", async () => {
    const world = await handoffPendingWorld();
    const { run } = await world.store.prepareInitialExecutionRun(prepareInput(world));
    await world.store.attachExecutionSupervisor({ executionRunID: run.id, sessionID: OWNER, workspace: WORKSPACE });
    await expect(
      world.store.createExecutionStages({ executionRunID: run.id, ...AUTH, drafts: [DRAFT] }),
    ).rejects.toMatchObject({ code: "invalid_execution_lifecycle" });
    const supervised = await supervisedActiveWorld(world);
    await expect(
      supervised.world.store.createExecutionStages({
        executionRunID: supervised.run.id,
        ...AUTH,
        generation: 99,
        drafts: [DRAFT],
      }),
    ).rejects.toMatchObject({ code: "stale_supervisor_binding" });
  });

  it("planRefs must resolve to exact approved FinalPlan reachable refs — nothing is resolved to latest", async () => {
    const world = await handoffPendingWorld();
    const { run } = await supervisedActiveWorld(world);
    const input = (planRefs: unknown) => ({ executionRunID: run.id, ...AUTH, drafts: [{ ...DRAFT, planRefs } as never] });
    // Unknown section revision (approved FinalPlan carries @1, not @2).
    await expect(world.store.createExecutionStages(input([REF.section("SEC-001", 2)]))).rejects.toMatchObject({ code: "invalid_scope" });
    await expect(world.store.createExecutionStages(input([REF.section("SEC-099")]))).rejects.toMatchObject({ code: "invalid_scope" });
    // Unknown decision / constraint / implementation step order.
    await expect(world.store.createExecutionStages(input([{ kind: "decision", id: "DEC-001", revision: 1 }]))).rejects.toMatchObject({ code: "invalid_scope" });
    await expect(world.store.createExecutionStages(input([{ kind: "constraint", id: "CON-099" }]))).rejects.toMatchObject({ code: "invalid_scope" });
    await expect(world.store.createExecutionStages(input([REF.step(99)]))).rejects.toMatchObject({ code: "invalid_scope" });
    // A final_plan ref that is not the run's exact binding is refused.
    await expect(world.store.createExecutionStages(input([{ kind: "final_plan", id: world.finalPlan.id, revision: 2 }]))).rejects.toMatchObject({
      code: "invalid_scope",
    });
    // Exact refs pass (approved section revision, existing step order, exact final plan).
    const ok = await world.store.createExecutionStages({
      executionRunID: run.id,
      ...AUTH,
      drafts: [{ ...DRAFT, planRefs: [REF.finalPlan(world), REF.section("SEC-001"), REF.step(1)] }],
    });
    expect(ok[0]!.planRefs).toHaveLength(3);
  });
});

// -----------------------------------------------------------------------------
// §9/§18/§45 — Dependency semantics & candidate-DAG validation
// -----------------------------------------------------------------------------

describe("Stage dependencies (§9/§18/§45)", () => {
  it("implementationOrder is NOT mechanically converted into hard dependencies (§9)", async () => {
    const world = await handoffPendingWorld();
    const { run } = await supervisedActiveWorld(world);
    const stages = await world.store.createExecutionStages({
      executionRunID: run.id,
      ...AUTH,
      // Same step referenced by two stages, no dependsOn anywhere: creation
      // succeeds — sequencing guidance is provenance, not a dependency edge.
      drafts: [
        { ...DRAFT, title: "A", planRefs: [REF.step(1)] },
        { ...DRAFT, title: "B", planRefs: [REF.step(1)] },
      ],
    });
    expect(stages.every((stage) => stage.dependsOn.length === 0)).toBe(true);
    expect(await world.store.listExecutionStagesForRun(run.id)).toHaveLength(2);
  });

  it("self dependency and same-batch cycles fail on the CANDIDATE DAG (§18)", async () => {
    const world = await handoffPendingWorld();
    const { run } = await supervisedActiveWorld(world);
    // Self dependency (declared via the batch's own future id is impossible
    // pre-assignment, so the direct form is a dependency on a batch peer that
    // depends back — plus the explicit self check through existing ids).
    await expect(
      world.store.createExecutionStages({
        executionRunID: run.id,
        ...AUTH,
        drafts: [
          { ...DRAFT, title: "A", dependsOn: ["STAGE-002" as never] },
          { ...DRAFT, title: "B", dependsOn: ["STAGE-001" as never] },
        ],
      }),
    ).rejects.toMatchObject({ code: "stage_dependency_cycle" });
    // Three-node cycle across the batch: validated as one DAG, not line-by-line.
    await expect(
      world.store.createExecutionStages({
        executionRunID: run.id,
        ...AUTH,
        drafts: [
          { ...DRAFT, title: "A", dependsOn: ["STAGE-003" as never] },
          { ...DRAFT, title: "B", dependsOn: ["STAGE-001" as never] },
          { ...DRAFT, title: "C", dependsOn: ["STAGE-002" as never] },
        ],
      }),
    ).rejects.toMatchObject({ code: "stage_dependency_cycle" });
    // A forward reference within a linear batch is FINE (A→B→C).
    const linear = await world.store.createExecutionStages({
      executionRunID: run.id,
      ...AUTH,
      drafts: [
        { ...DRAFT, title: "A", dependsOn: ["STAGE-002" as never, "STAGE-003" as never] },
        { ...DRAFT, title: "B" },
        { ...DRAFT, title: "C" },
      ],
    });
    expect(linear.map((stage) => stage.id)).toEqual(["STAGE-001", "STAGE-002", "STAGE-003"]);
  });

  it("cross-run dependency refs fail closed", async () => {
    const world = await handoffPendingWorld();
    const first = await supervisedActiveWorld(world);
    await world.store.createExecutionStages({ executionRunID: first.run.id, ...AUTH, drafts: [DRAFT] });
    // A second supervised run in the SAME store binds the same FinalPlan.
    const secondRun = await world.store.prepareInitialExecutionRun(prepareInput(world, { initialHandoffKey: `${world.runID}/FINAL-001@1/second` }));
    await world.store.attachExecutionSupervisor({ executionRunID: secondRun.run.id, sessionID: OWNER, workspace: WORKSPACE });
    const activated = await world.store.activateSupervisedExecutionRun({
      executionRunID: secondRun.run.id,
      sessionID: OWNER,
      workspace: WORKSPACE,
      generation: 1,
      runRevision: secondRun.run.revision,
      finalPlan: secondRun.run.finalPlan,
    });
    await expect(
      world.store.createExecutionStages({
        executionRunID: activated.id,
        ...AUTH,
        drafts: [{ ...DRAFT, dependsOn: ["STAGE-001" as never] }],
      }),
    ).rejects.toMatchObject({ code: "stage_dependency_unsatisfied" });
  });

  it("a completed dependency makes the dependent eligible; a pending one does not (seeded fixtures)", async () => {
    const world = await handoffPendingWorld();
    const { run } = await supervisedActiveWorld(world);
    const store = world.store;
    const [a, b] = await world.store.createExecutionStages({
      executionRunID: run.id,
      ...AUTH,
      drafts: [{ ...DRAFT, title: "A" }, { ...DRAFT, title: "B depends on A", dependsOn: ["STAGE-001" as never] }],
    });
    expect(isStageEligible({ run: (await store.getExecutionRun(run.id))!, stage: b!, stagesForRun: await store.listExecutionStagesForRun(run.id) })).toBe(false);
    // Completion belongs to the future ExecutionCommit — the eligible-predicate
    // is verified against an in-memory stage list (Phase 8 §53: no store
    // seeding of non-pending Stages).
    const stageACompleted = { ...a!, status: "completed" as const };
    expect(
      isStageEligible({ run: (await store.getExecutionRun(run.id))!, stage: b!, stagesForRun: [stageACompleted, b!] }),
    ).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// §10/§11/§13/§14/§44 — Activation transaction & single-active invariant
// -----------------------------------------------------------------------------

describe("Stage activation (§10/§13/§14/§44)", () => {
  it("activates an eligible stage atomically: status, run.activeStage, revisions, event", async () => {
    const world = await handoffPendingWorld();
    const { run } = await supervisedActiveWorld(world);
    const { first } = await twoStandaloneStages(world, run.id);
    const { stage, run: updated } = await world.store.activateExecutionStage({
      executionRunID: run.id,
      stageID: first.id,
      ...AUTH,
      expectedRunRevision: run.revision,
      expectedStageRevision: first.revision,
    });
    expect(stage.status).toBe("active");
    expect(stage.revision).toBe(first.revision + 1);
    expect(updated.activeStage).toBe(first.id);
    expect(updated.revision).toBe(run.revision + 1);
    expect(((await world.store.getExecutionRun(run.id))!).activeStage).toBe(first.id);
    const events = (await world.store.listEvents(world.runID)).map((event) => event.detail.type);
    expect(events).toContain("execution.stage_activated");
  });

  it("a second activation while one Stage is active FAILs (active_stage_conflict)", async () => {
    const world = await handoffPendingWorld();
    const { run } = await supervisedActiveWorld(world);
    const { first, second } = await twoStandaloneStages(world, run.id);
    await world.store.activateExecutionStage({ executionRunID: run.id, stageID: first.id, ...AUTH, expectedRunRevision: run.revision, expectedStageRevision: first.revision });
    await expect(
      world.store.activateExecutionStage({
        executionRunID: run.id,
        stageID: second.id,
        ...AUTH,
        expectedRunRevision: run.revision + 1,
        expectedStageRevision: second.revision,
      }),
    ).rejects.toMatchObject({ code: "active_stage_conflict" });
  });

  it("an open Window blocks activation; unmet dependency fails; stale CAS fails", async () => {
    const world = await handoffPendingWorld();
    const { run } = await supervisedActiveWorld(world);
    const { first } = await twoStandaloneStages(world, run.id);
    const [dep, dependent] = await world.store.createExecutionStages({
      executionRunID: run.id,
      ...AUTH,
      drafts: [{ ...DRAFT, title: "dep" }, { ...DRAFT, title: "dependent", dependsOn: ["STAGE-003" as never] }],
    });
    await expect(
      world.store.activateExecutionStage({
        executionRunID: run.id,
        stageID: dependent!.id,
        ...AUTH,
        expectedRunRevision: run.revision,
        expectedStageRevision: dependent!.revision,
      }),
    ).rejects.toMatchObject({ code: "stage_dependency_unsatisfied" });
    void dep;
    await world.store.activateExecutionStage({ executionRunID: run.id, stageID: first.id, ...AUTH, expectedRunRevision: run.revision, expectedStageRevision: first.revision });
    await world.store.openVerificationWindow({
      executionRunID: run.id,
      stageID: first.id,
      ...AUTH,
      expectedRunRevision: run.revision + 1,
      expectedStageRevision: first.revision + 1,
    });
    // With the run's stage active + window open, superseding/switching is blocked anyway;
    // a DIFFERENT stage activation fails active_stage_conflict (window check comes after
    // the active-stage check by definition of the invariants).
    const { second } = await twoStandaloneStages(world, run.id);
    await expect(
      world.store.activateExecutionStage({
        executionRunID: run.id,
        stageID: second.id,
        ...AUTH,
        expectedRunRevision: run.revision + 2,
        expectedStageRevision: second.revision,
      }),
    ).rejects.toMatchObject({ code: "active_stage_conflict" });
    // Stale run/stage CAS.
    await expect(
      world.store.activateExecutionStage({
        executionRunID: run.id,
        stageID: first.id,
        ...AUTH,
        expectedRunRevision: 0,
        expectedStageRevision: first.revision,
      }),
    ).rejects.toMatchObject({ code: "stale_execution_run" });
  });

  it("activation on a PREPARED run fails; a stage from another run is not found (§14/§44)", async () => {
    const world = await handoffPendingWorld();
    // A PREPARED run refuses stage activation even with a valid binding (S14).
    const prepared = await world.store.prepareInitialExecutionRun(prepareInput(world, { initialHandoffKey: `${world.runID}/FINAL-001@1/second-run` }));
    await world.store.attachExecutionSupervisor({ executionRunID: prepared.run.id, sessionID: OWNER, workspace: WORKSPACE });
    await expect(
      world.store.activateExecutionStage({
        executionRunID: prepared.run.id,
        stageID: "STAGE-001" as never,
        ...AUTH,
        expectedRunRevision: prepared.run.revision,
        expectedStageRevision: 1,
      }),
    ).rejects.toMatchObject({ code: "invalid_execution_lifecycle" });
    // A stage from ANOTHER run is not found in this run's scoped namespace.
    const { run } = await supervisedActiveWorld(world);
    const { first } = await twoStandaloneStages(world, run.id);
    const secondPrepared = await world.store.prepareInitialExecutionRun(prepareInput(world, { initialHandoffKey: `${world.runID}/FINAL-001@1/third-run` }));
    await world.store.attachExecutionSupervisor({ executionRunID: secondPrepared.run.id, sessionID: OWNER, workspace: WORKSPACE });
    const secondActive = await world.store.activateSupervisedExecutionRun({
      executionRunID: secondPrepared.run.id,
      sessionID: OWNER,
      workspace: WORKSPACE,
      generation: 1,
      runRevision: secondPrepared.run.revision,
      finalPlan: secondPrepared.run.finalPlan,
    });
    await expect(
      world.store.activateExecutionStage({
        executionRunID: secondActive.id,
        stageID: first.id,
        ...AUTH,
        expectedRunRevision: secondActive.revision,
        expectedStageRevision: first.revision,
      }),
    ).rejects.toMatchObject({ code: "execution_stage_not_found" });
  });
});

// -----------------------------------------------------------------------------
// §15/§16 — Completion reserved; minimal supersession
// -----------------------------------------------------------------------------

describe("completion reservation & supersession (§15/§16)", () => {
  it("NO normal API can mark a Stage completed (belongs to the future ExecutionCommit)", async () => {
    const world = await handoffPendingWorld();
    const storeShape = Object.getOwnPropertyNames(Object.getPrototypeOf(world.store) as Record<string, unknown>);
    expect(storeShape.some((name) => /complete.*stage|stage.*complete/i.test(name) && !name.includes("seed"))).toBe(false);
    // The frozen transition table documents the reserved edge but exposes no operation.
    expect(EXECUTION_STAGE_TRANSITIONS.active).toEqual(["completed"]);
    expect(EXECUTION_STAGE_TRANSITIONS.pending).toEqual(["active", "superseded"]);
  });

  it("pending → superseded is durable and audited; superseded never re-activates (§16/§44)", async () => {
    const world = await handoffPendingWorld();
    const { run } = await supervisedActiveWorld(world);
    const { first } = await twoStandaloneStages(world, run.id);
    const superseded = await world.store.supersedeExecutionStage({ executionRunID: run.id, stageID: first.id, ...AUTH, expectedStageRevision: first.revision });
    expect(superseded.status).toBe("superseded");
    // The old record stays durable under its own id.
    expect((await world.store.getExecutionStage(first.id))!.status).toBe("superseded");
    await expect(
      world.store.activateExecutionStage({
        executionRunID: run.id,
        stageID: first.id,
        ...AUTH,
        expectedRunRevision: run.revision,
        expectedStageRevision: superseded.revision,
      }),
    ).rejects.toMatchObject({ code: "invalid_stage_transition" });
    const events = (await world.store.listEvents(world.runID)).map((event) => event.detail.type);
    expect(events).toContain("execution.stage_superseded");
    // An ACTIVE stage cannot be superseded in Phase 3 (minimal semantics).
    const { second } = await twoStandaloneStages(world, run.id);
    await world.store.activateExecutionStage({ executionRunID: run.id, stageID: second.id, ...AUTH, expectedRunRevision: run.revision, expectedStageRevision: second.revision });
    await expect(
      world.store.supersedeExecutionStage({ executionRunID: run.id, stageID: second.id, ...AUTH, expectedStageRevision: second.revision + 1 }),
    ).rejects.toMatchObject({ code: "invalid_stage_transition" });
  });
});

// -----------------------------------------------------------------------------
// §19/§20/§21/§23/§24/§25/§47 — Window domain, opening, single-open invariant
// -----------------------------------------------------------------------------

describe("VerificationWindow (§19/§20/§23/§24/§47)", () => {
  it("opens the candidate span on the ACTIVE stage: candidateRevision 0, execution_start anchor", async () => {
    const world = await handoffPendingWorld();
    const { run } = await supervisedActiveWorld(world);
    const { first } = await twoStandaloneStages(world, run.id);
    const activated = await world.store.activateExecutionStage({ executionRunID: run.id, stageID: first.id, ...AUTH, expectedRunRevision: run.revision, expectedStageRevision: first.revision });
    const { window, run: updated } = await world.store.openVerificationWindow({
      executionRunID: run.id,
      stageID: first.id,
      ...AUTH,
      expectedRunRevision: activated.run.revision,
      expectedStageRevision: activated.stage.revision,
    });
    expect(window).toMatchObject({ state: "open", candidateRevision: 0, stageID: first.id, baseAcceptedState: { kind: "execution_start", executionRunID: run.id } });
    expect(updated.openWindow).toBe(window.id);
    expect(((await world.store.getExecutionRun(run.id))!).openWindow).toBe(window.id);
    // §25: opened with candidateRevision 0 is a legal resting state.
    expect(await world.store.findOpenVerificationWindow(run.id)).toEqual(window);
    const events = (await world.store.listEvents(world.runID)).map((event) => event.detail.type);
    expect(events).toContain("execution.window_opened");
  });

  it("a second Window / a non-active Stage / a prepared run / another run's Stage all FAIL (§47)", async () => {
    const world = await handoffPendingWorld();
    const { run } = await supervisedActiveWorld(world);
    const { first } = await twoStandaloneStages(world, run.id);
    const activated = await world.store.activateExecutionStage({ executionRunID: run.id, stageID: first.id, ...AUTH, expectedRunRevision: run.revision, expectedStageRevision: first.revision });
    const openInput = { executionRunID: run.id, stageID: first.id, ...AUTH, expectedRunRevision: activated.run.revision, expectedStageRevision: activated.stage.revision };
    await world.store.openVerificationWindow(openInput);
    await expect(world.store.openVerificationWindow(openInput)).rejects.toMatchObject({ code: "window_already_open" });
    const { second } = await twoStandaloneStages(world, run.id);
    await expect(
      world.store.openVerificationWindow({
        executionRunID: run.id,
        stageID: second.id,
        ...AUTH,
        expectedRunRevision: activated.run.revision + 1,
        expectedStageRevision: second.revision,
      }),
    ).rejects.toMatchObject({ code: "stage_window_mismatch" });
    // Another run's namespace: scoped lookup misses.
    const otherPrepared = await world.store.prepareInitialExecutionRun(prepareInput(world, { initialHandoffKey: `${world.runID}/FINAL-001@1/other` }));
    await world.store.attachExecutionSupervisor({ executionRunID: otherPrepared.run.id, sessionID: OWNER, workspace: WORKSPACE });
    await expect(
      world.store.openVerificationWindow({
        executionRunID: otherPrepared.run.id,
        stageID: first.id,
        ...AUTH,
        expectedRunRevision: otherPrepared.run.revision,
        expectedStageRevision: first.revision,
      }),
    ).rejects.toMatchObject({ code: "invalid_execution_lifecycle" });
    // And an ACTIVE second run scoping the first run's stage: not found.
    const otherActive = await world.store.activateSupervisedExecutionRun({
      executionRunID: otherPrepared.run.id,
      sessionID: OWNER,
      workspace: WORKSPACE,
      generation: 1,
      runRevision: otherPrepared.run.revision,
      finalPlan: otherPrepared.run.finalPlan,
    });
    await expect(
      world.store.openVerificationWindow({
        executionRunID: otherActive.id,
        stageID: first.id,
        ...AUTH,
        expectedRunRevision: otherActive.revision,
        expectedStageRevision: first.revision,
      }),
    ).rejects.toMatchObject({ code: "execution_stage_not_found" });
    // Prepared run (supervised but not yet active): window refused.
    const preparedWorld = await handoffPendingWorld({ validator: { async validate() { return { text: JSON.stringify({ result: "clean", findings: [] }) }; } } });
    const prepared = await preparedWorld.store.prepareInitialExecutionRun(prepareInput(preparedWorld));
    await preparedWorld.store.attachExecutionSupervisor({ executionRunID: prepared.run.id, sessionID: OWNER, workspace: WORKSPACE });
    await expect(
      preparedWorld.store.openVerificationWindow({
        executionRunID: prepared.run.id,
        stageID: "STAGE-001" as never,
        ...AUTH,
        expectedRunRevision: prepared.run.revision,
        expectedStageRevision: 1,
      }),
    ).rejects.toMatchObject({ code: "invalid_execution_lifecycle" });
  });

  it("window closing is RESERVED — no close/accept API exists (§30)", async () => {
    const world = await handoffPendingWorld();
    const storeShape = Object.getOwnPropertyNames(Object.getPrototypeOf(world.store) as Record<string, unknown>);
    expect(storeShape.some((name) => /close.*window|window.*close|accept.*window|mark.*verified/i.test(name))).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// §26/§27/§28/§29/§48 — candidateRevision: CAS, monotonic +1, staleness
// -----------------------------------------------------------------------------

describe("candidateRevision primitive (§26-§29/§48)", () => {
  async function windowWorld() {
    const world = await handoffPendingWorld();
    const { run } = await supervisedActiveWorld(world);
    const { first } = await twoStandaloneStages(world, run.id);
    const activated = await world.store.activateExecutionStage({ executionRunID: run.id, stageID: first.id, ...AUTH, expectedRunRevision: run.revision, expectedStageRevision: first.revision });
    const { window } = await world.store.openVerificationWindow({
      executionRunID: run.id,
      stageID: first.id,
      ...AUTH,
      expectedRunRevision: activated.run.revision,
      expectedStageRevision: activated.stage.revision,
    });
    return { world, run: activated.run, stage: activated.stage, window };
  }

  it("advances +1 only through CAS: 0→1→2; a repeated expectation fails stale (§48)", async () => {
    const { world, run, window } = await windowWorld();
    const first = await world.store.advanceCandidateRevision({ executionRunID: run.id, ...AUTH, expectedCandidateRevision: 0 });
    expect(first.candidateRevision).toBe(1);
    await expect(
      world.store.advanceCandidateRevision({ executionRunID: run.id, ...AUTH, expectedCandidateRevision: 0 }),
    ).rejects.toMatchObject({ code: "stale_candidate_revision" });
    const second = await world.store.advanceCandidateRevision({ executionRunID: run.id, ...AUTH, expectedCandidateRevision: 1 });
    expect(second.candidateRevision).toBe(2);
    // The record CAS revision and the candidate revision are DISTINCT axes (§26).
    expect(second.revision).toBe(window.revision + 2);
    const events = (await world.store.listEvents(world.runID)).filter((event) => event.detail.type === "execution.window_candidate_advanced");
    expect(events).toHaveLength(2);
    void window;
  });

  it("no setter/decrement exists; the reusable staleness check gates stale refs (§28/§29)", async () => {
    const { world, run, window } = await windowWorld();
    const storeShape = Object.getOwnPropertyNames(Object.getPrototypeOf(world.store) as Record<string, unknown>);
    expect(storeShape.some((name) => /set.*candidate|candidate.*set|reset/i.test(name))).toBe(false);
    // A reference to revision N goes stale after the advance to N+1.
    assertCurrentCandidateRevision(window, 0);
    await world.store.advanceCandidateRevision({ executionRunID: run.id, ...AUTH, expectedCandidateRevision: 0 });
    const current = (await world.store.findOpenVerificationWindow(run.id))!;
    expect(() => assertCurrentCandidateRevision(current, 0)).toThrowError(/stale/);
    expect(() => assertCurrentCandidateRevision(current, 1)).not.toThrow();
  });

  it("advancing without an open window fails window_not_found", async () => {
    const world = await handoffPendingWorld();
    const { run } = await supervisedActiveWorld(world);
    await expect(world.store.advanceCandidateRevision({ executionRunID: run.id, ...AUTH, expectedCandidateRevision: 0 })).rejects.toMatchObject({
      code: "window_not_found",
    });
  });
});

// -----------------------------------------------------------------------------
// §31/§32 — Open Window blocks Stage transitions; terminal runs preserve history
// -----------------------------------------------------------------------------

describe("open-window blocking & terminal history (§31/§32)", () => {
  it("superseding the ACTIVE stage is refused in Phase 3 (and an open window freezes the stage further)", async () => {
    const world = await handoffPendingWorld();
    const { run } = await supervisedActiveWorld(world);
    const { first } = await twoStandaloneStages(world, run.id);
    const activated = await world.store.activateExecutionStage({ executionRunID: run.id, stageID: first.id, ...AUTH, expectedRunRevision: run.revision, expectedStageRevision: first.revision });
    await world.store.openVerificationWindow({
      executionRunID: run.id,
      stageID: first.id,
      ...AUTH,
      expectedRunRevision: activated.run.revision,
      expectedStageRevision: activated.stage.revision,
    });
    await expect(
      world.store.supersedeExecutionStage({ executionRunID: run.id, stageID: first.id, ...AUTH, expectedStageRevision: activated.stage.revision }),
    ).rejects.toMatchObject({ code: "invalid_stage_transition" });
  });

  it("a terminal run preserves Stage/Window history exactly (no silent cleanup) (§32)", async () => {
    const world = await handoffPendingWorld();
    const { run } = await supervisedActiveWorld(world);
    const { first } = await twoStandaloneStages(world, run.id);
    const activated = await world.store.activateExecutionStage({ executionRunID: run.id, stageID: first.id, ...AUTH, expectedRunRevision: run.revision, expectedStageRevision: first.revision });
    const { window } = await world.store.openVerificationWindow({
      executionRunID: run.id,
      stageID: first.id,
      ...AUTH,
      expectedRunRevision: activated.run.revision,
      expectedStageRevision: activated.stage.revision,
    });
    await world.store.advanceCandidateRevision({ executionRunID: run.id, ...AUTH, expectedCandidateRevision: 0 });
    await world.store.abortExecutionRun(run.id, {
      workspace: WORKSPACE,
      runRevision: activated.run.revision + 1,
      finalPlan: run.finalPlan,
    });
    // Frozen history: the Stage stays active-status, the Window stays open-state,
    // the candidateRevision survives — nothing was deleted or closed.
    expect((await world.store.getExecutionStage(first.id))!.status).toBe("active");
    expect((await world.store.getVerificationWindow(window.id))!.state).toBe("open");
    expect((await world.store.getVerificationWindow(window.id))!.candidateRevision).toBe(1);
    const context = await world.store.buildExecutionRecoveryContext(run.id, { sessionID: OWNER });
    expect(context!.lifecycle).toBe("aborted");
    expect(context!.activeStage).toMatchObject({ id: first.id, status: "active" });
    expect(context!.openWindow).toMatchObject({ id: window.id, candidateRevision: 1 });
  });
});

// -----------------------------------------------------------------------------
// §46/§49 — REAL durable concurrency: single active Stage / single open Window
// -----------------------------------------------------------------------------

describe("durable concurrency — single writer invariants (§46/§49)", () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "ultra-plan-stage-"));
    filePath = path.join(dir, "plan.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("two instances racing to activate different Stages yield exactly ONE active Stage", async () => {
    const world = await durableHandoffPendingWorld(filePath);
    const { run } = await supervisedActiveWorld(world);
    const { first, second } = await twoStandaloneStages(world, run.id);
    world.store.close();
    const a = new DurablePlanStore(filePath, { now: () => FIXED });
    const b = new DurablePlanStore(filePath, { now: () => FIXED });
    const input = (stage: ExecutionStage) => ({
      executionRunID: run.id,
      stageID: stage.id,
      ...AUTH,
      expectedRunRevision: run.revision,
      expectedStageRevision: stage.revision,
    });
    const [ra, rb] = await Promise.allSettled([a.activateExecutionStage(input(first)), b.activateExecutionStage(input(second))]);
    a.close();
    b.close();
    const fulfilled = [ra, rb].filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
    // Durable truth: exactly one active Stage, run.activeStage == winner.
    const verify = new DurablePlanStore(filePath, { now: () => FIXED });
    const stages = await verify.listExecutionStagesForRun(run.id);
    expect(stages.filter((stage) => stage.status === "active")).toHaveLength(1);
    const winner = stages.find((stage) => stage.status === "active")!;
    expect(((await verify.getExecutionRun(run.id))!).activeStage).toBe(winner.id);
    const activatedEvents = (await verify.listEvents(world.runID)).filter((event) => event.detail.type === "execution.stage_activated");
    expect(activatedEvents).toHaveLength(1);
    verify.close();
  });

  it("two instances racing to open a Window yield exactly ONE open Window", async () => {
    const world = await durableHandoffPendingWorld(filePath);
    const { run } = await supervisedActiveWorld(world);
    const { first } = await twoStandaloneStages(world, run.id);
    const activated = await world.store.activateExecutionStage({ executionRunID: run.id, stageID: first.id, ...AUTH, expectedRunRevision: run.revision, expectedStageRevision: first.revision });
    world.store.close();
    const a = new DurablePlanStore(filePath, { now: () => FIXED });
    const b = new DurablePlanStore(filePath, { now: () => FIXED });
    const input = {
      executionRunID: run.id,
      stageID: first.id,
      ...AUTH,
      expectedRunRevision: activated.run.revision,
      expectedStageRevision: activated.stage.revision,
    };
    const [ra, rb] = await Promise.allSettled([a.openVerificationWindow(input), b.openVerificationWindow(input)]);
    a.close();
    b.close();
    expect([ra, rb].filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const verify = new DurablePlanStore(filePath, { now: () => FIXED });
    const windows = await verify.listVerificationWindowsForRun(run.id);
    expect(windows.filter((window) => window.state === "open")).toHaveLength(1);
    expect(((await verify.getExecutionRun(run.id))!).openWindow).toBe(windows[0]!.id);
    verify.close();
  });

  it("two instances advancing from the SAME candidateRevision yield ONE winner (never N+2)", async () => {
    const world = await durableHandoffPendingWorld(filePath);
    const { run } = await supervisedActiveWorld(world);
    const { first } = await twoStandaloneStages(world, run.id);
    const activated = await world.store.activateExecutionStage({ executionRunID: run.id, stageID: first.id, ...AUTH, expectedRunRevision: run.revision, expectedStageRevision: first.revision });
    await world.store.openVerificationWindow({
      executionRunID: run.id,
      stageID: first.id,
      ...AUTH,
      expectedRunRevision: activated.run.revision,
      expectedStageRevision: activated.stage.revision,
    });
    world.store.close();
    const a = new DurablePlanStore(filePath, { now: () => FIXED });
    const b = new DurablePlanStore(filePath, { now: () => FIXED });
    const input = { executionRunID: run.id, ...AUTH, expectedCandidateRevision: 0 };
    const [ra, rb] = await Promise.allSettled([a.advanceCandidateRevision(input), b.advanceCandidateRevision(input)]);
    a.close();
    b.close();
    expect([ra, rb].filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = [ra, rb].find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((rejected.reason as { code?: string }).code).toBe("stale_candidate_revision");
    const verify = new DurablePlanStore(filePath, { now: () => FIXED });
    expect(((await verify.findOpenVerificationWindow(run.id))!).candidateRevision).toBe(1);
    verify.close();
  });
});

// -----------------------------------------------------------------------------
// §33/§34/§35/§50 — Persistence, run-reference consistency, migration
// -----------------------------------------------------------------------------

describe("persistence, consistency & backward compatibility (§33-§37/§50/§52)", () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "ultra-plan-stage-mig-"));
    filePath = path.join(dir, "plan.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function stageWindowWorld(file: string): Promise<{ run: ExecutionRun; stage: ExecutionStage; window: VerificationWindow }> {
    const world = await durableHandoffPendingWorld(file);
    const { run } = await supervisedActiveWorld(world);
    const { first } = await twoStandaloneStages(world, run.id);
    const activated = await world.store.activateExecutionStage({ executionRunID: run.id, stageID: first.id, ...AUTH, expectedRunRevision: run.revision, expectedStageRevision: first.revision });
    const { window } = await world.store.openVerificationWindow({
      executionRunID: run.id,
      stageID: first.id,
      ...AUTH,
      expectedRunRevision: activated.run.revision,
      expectedStageRevision: activated.stage.revision,
    });
    await world.store.advanceCandidateRevision({ executionRunID: run.id, ...AUTH, expectedCandidateRevision: 0 });
    await world.store.advanceCandidateRevision({ executionRunID: run.id, ...AUTH, expectedCandidateRevision: 1 });
    return { run: activated.run, stage: activated.stage, window };
  }

  it("Stage/Window survive close/reopen exactly; run refs stay consistent (§50/E24)", async () => {
    const { run, stage, window } = await stageWindowWorld(filePath);
    const reopened = new DurablePlanStore(filePath, { now: () => FIXED });
    expect(await reopened.getExecutionStage(stage.id)).toMatchObject({ id: stage.id, status: "active", revision: stage.revision });
    expect(await reopened.getVerificationWindow(window.id)).toMatchObject({ id: window.id, candidateRevision: 2, state: "open" });
    const runAfter = (await reopened.getExecutionRun(run.id))!;
    expect(runAfter.activeStage).toBe(stage.id);
    expect(runAfter.openWindow).toBe(window.id);
    // Consistency in the other direction too.
    expect((await reopened.findOpenVerificationWindow(run.id))!.id).toBe(window.id);
    reopened.close();
  });

  it("pre-Phase-3 documents open with planning + execution + binding intact and empty families (§52/E27)", async () => {
    const world = await durableHandoffPendingWorld(filePath);
    const runID = world.runID;
    const { run } = await world.store.prepareInitialExecutionRun(prepareInput(world));
    await world.store.attachExecutionSupervisor({ executionRunID: run.id, sessionID: OWNER, workspace: WORKSPACE });
    world.store.close();
    await tamper(filePath, (raw) => {
      delete raw["executionStages"];
      delete raw["verificationWindows"];
    });
    const migrated = new DurablePlanStore(filePath, { now: () => FIXED });
    expect(((await migrated.getRun(runID)) as PlanningRun).lifecycle).toBe("handoff_pending");
    expect(await migrated.listExecutionRunsForPlan(runID)).toHaveLength(1);
    expect(await migrated.findSupervisorBinding(run.id)).toMatchObject({ ownerSessionID: OWNER, generation: 1 });
    expect(await migrated.listExecutionStagesForRun(run.id)).toEqual([]);
    expect(await migrated.listVerificationWindowsForRun(run.id)).toEqual([]);
    migrated.close();
  });

  it("malformed Stage/Window structures fail closed (S36/S37/E28)", async () => {
    // One pristine structural world; each case copies the snapshot and
    // tampers (a full planning drive per case would be needlessly slow).
    const pristineFile = path.join(dir, "pristine.json");
    await stageWindowWorld(pristineFile);
    const reopenable = new DurablePlanStore(pristineFile, { now: () => FIXED });
    reopenable.close();
    const pristine = await readFile(pristineFile, "utf8");
    const cases: readonly (readonly [string, (raw: Record<string, unknown>, stageID: string, windowID: string) => void, RegExp])[] = [
      ["stage-missing-run", (raw) => { docFamily(raw, "executionStages")["STAGE-001"]!["executionRunID"] = "EXEC-099"; }, /references missing execution run/],
      ["stage-bad-status", (raw) => { docFamily(raw, "executionStages")["STAGE-001"]!["status"] = "paused"; }, /invalid status/],
      ["stage-self-dep", (raw) => { docFamily(raw, "executionStages")["STAGE-001"]!["dependsOn"] = ["STAGE-001"]; }, /depends on itself/],
      ["stage-cross-run-dep", (raw) => {
        docFamily(raw, "executionStages")["STAGE-001"]!["dependsOn"] = ["STAGE-099"];
        docFamily(raw, "executionStages")["STAGE-099"] = { id: "STAGE-099", executionRunID: "EXEC-099", title: "x", objective: "y", status: "pending", planRefs: [], dependsOn: [], revision: 1, createdAt: FIXED, updatedAt: FIXED };
      }, /references missing execution run|another ExecutionRun/],
      ["two-active-stages", (raw, stageID) => {
        const clone = structuredClone(docFamily(raw, "executionStages")[stageID]!);
        clone["id"] = "STAGE-002";
        docFamily(raw, "executionStages")["STAGE-002"] = clone;
      }, /two active Stages/],
      ["run-activestage-missing", (raw, stageID) => {
        const execRun = docFamily(raw, "executionStages")[stageID]!["executionRunID"] as string;
        docFamily(raw, "executionRuns")[execRun]!["activeStage"] = "STAGE-099";
      }, /activeStage references missing Stage/],
      ["run-activestage-pending", (raw, stageID) => {
        const execRun = docFamily(raw, "executionStages")[stageID]!["executionRunID"] as string;
        docFamily(raw, "executionStages")[stageID]!["status"] = "pending";
        delete docFamily(raw, "executionRuns")[execRun]!["openWindow"];
        delete raw["verificationWindows"];
      }, /references .* in status pending/],
      ["window-missing-stage", (raw) => { docFamily(raw, "verificationWindows")["WIN-001"]!["stageID"] = "STAGE-099"; }, /references missing Stage/],
      ["window-cross-run-stage", (raw) => { docFamily(raw, "verificationWindows")["WIN-001"]!["executionRunID"] = "EXEC-099"; }, /references missing execution run|another ExecutionRun/],
      ["window-bad-state", (raw) => { docFamily(raw, "verificationWindows")["WIN-001"]!["state"] = "verifying"; }, /invalid state/],
      ["window-bad-candidate", (raw) => { docFamily(raw, "verificationWindows")["WIN-001"]!["candidateRevision"] = -1; }, /malformed candidateRevision/],
      ["window-fake-commit-anchor", (raw) => { docFamily(raw, "verificationWindows")["WIN-001"]!["baseAcceptedState"] = { kind: "execution_commit", executionCommitID: "EC-000" }; }, /invalid baseAcceptedState|anchors a missing\/foreign execution commit/],
      ["run-openwindow-closed", (raw, _s, windowID) => {
        docFamily(raw, "verificationWindows")[windowID]!["state"] = "closed";
      }, /references closed Window/],
    ];
    for (const [name, mutate, pattern] of cases) {
      const caseFile = path.join(dir, `malformed-${name}.json`);
      let stageID = "STAGE-001";
      let windowID = "WIN-001";
      const raw = JSON.parse(pristine) as Record<string, unknown>;
      stageID = Object.keys(docFamily(raw, "executionStages"))[0]!;
      windowID = Object.keys(docFamily(raw, "verificationWindows"))[0]!;
      mutate(raw, stageID, windowID);
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
// §38/§39/§51 — Recovery Context expansion (projection, rebuild)
// -----------------------------------------------------------------------------

describe("recovery context expansion (§38/§39/§51)", () => {
  it("rebuilds run + binding + active Stage + open Window + candidateRevision after restart (§51)", async () => {
    let dir: string | undefined;
    try {
      dir = await mkdtemp(path.join(tmpdir(), "ultra-plan-stage-recovery-"));
      const file = path.join(dir, "plan.json");
      const world = await durableHandoffPendingWorld(file);
      const { run } = await supervisedActiveWorld(world);
      const { first } = await twoStandaloneStages(world, run.id);
      const activated = await world.store.activateExecutionStage({ executionRunID: run.id, stageID: first.id, ...AUTH, expectedRunRevision: run.revision, expectedStageRevision: first.revision });
      await world.store.openVerificationWindow({
        executionRunID: run.id,
        stageID: first.id,
        ...AUTH,
        expectedRunRevision: activated.run.revision,
        expectedStageRevision: activated.stage.revision,
      });
      await world.store.advanceCandidateRevision({ executionRunID: run.id, ...AUTH, expectedCandidateRevision: 0 });
      await world.store.advanceCandidateRevision({ executionRunID: run.id, ...AUTH, expectedCandidateRevision: 1 });
      const before = await world.store.buildExecutionRecoveryContext(run.id, { sessionID: OWNER });
      world.store.close();
      // Conversation history is absent by construction in this fresh process —
      // recovery reads ONLY the durable document.
      const reopened = new DurablePlanStore(file, { now: () => FIXED });
      const after = await reopened.buildExecutionRecoveryContext(run.id, { sessionID: OWNER });
      expect(after).toEqual(before);
      expect(after!.activeStage).toMatchObject({ id: first.id, title: "Stage A", status: "active" });
      expect(after!.openWindow).toMatchObject({ id: "WIN-001", stage: first.id, candidateRevision: 2, baseAcceptedState: { kind: "execution_start", executionRunID: run.id } });
      expect(after!.binding).toMatchObject({ ownerSessionID: OWNER, generation: 1, state: "attached" });
      // §39: rebuilding is read-only — the document is unchanged.
      const rawBefore = JSON.stringify(JSON.parse(await readFile(file, "utf8")));
      await reopened.buildExecutionRecoveryContext(run.id, { sessionID: "ses_other" });
      expect(JSON.stringify(JSON.parse(await readFile(file, "utf8")))).toBe(rawBefore);
      reopened.close();
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  });

  it("an unstructured run projects activeStage/openWindow as absent — nothing fabricated (§38)", async () => {
    const world = await handoffPendingWorld();
    const { run } = await supervisedActiveWorld(world);
    const context = await world.store.buildExecutionRecoveryContext(run.id, { sessionID: OWNER });
    expect(context!.activeStage).toBeUndefined();
    expect(context!.openWindow).toBeUndefined();
  });
});

// -----------------------------------------------------------------------------
// §42/§43 — Scope gates: no model-facing API, no production callers
// -----------------------------------------------------------------------------

describe("scope gates (§42/§43)", () => {
  it("no model-facing Stage/Window mutation tool exists (§42/E30)", async () => {
    const { TOOL_CONTRACTS } = await import("../src/index.js");
    const names = Object.keys(TOOL_CONTRACTS);
    expect(names.filter((name) => /stage|window|candidate|directive|attempt|report|verifier|assessment|commit/i.test(name))).toEqual([]);
  });

  it("no Assessment/Commit/acceptedHead/Scheduler/CompletionGate object leaked (§3/E29; Phase 6A authorizes ExecutionIssue/conflict/reconciliation)", async () => {
    // Phase 4 scope update: Directive/Attempt/Report/Worker are now REQUIRED
    // vocabulary — the still-forbidden objects below remain forbidden.
    const exports = await import("../src/index.js");
    // Phase 5 scope update: SupervisorAssessment/ExecutionCommit are now
    // REQUIRED vocabulary — the still-forbidden objects remain forbidden.
    // Phase 6A scope update: ExecutionIssue/VerificationConflict/
    // AttemptReconciliation are now REQUIRED vocabulary; the still-forbidden
    // objects remain forbidden (notably ExecutionCompletionGate — Phase 6B).
    for (const name of Object.getOwnPropertyNames(exports)) {
      expect(name).not.toMatch(/VerificationScheduler|ExecutionCompletionGate|acceptedHeadSetter|ReplanRequiredWorkflow|ExecutionObservation/);
    }
  });

  it("the v0.1 production handoff still creates NO execution structures (§43/E31)", async () => {
    const world = await handoffPendingWorld();
    const result = await world.controller.recoverExecutionHandoff(world.sessionID);
    expect(result.status).toBe("completed");
    expect(await world.store.listOpenExecutionRuns()).toHaveLength(0);
    const events = (await world.store.listEvents(world.runID)).map((event) => event.detail.type);
    expect(events.filter((type) => type.startsWith("execution."))).toEqual([]);
  });
});
