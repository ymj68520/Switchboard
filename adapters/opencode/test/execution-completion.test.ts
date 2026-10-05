/**
 * v0.2.0 Phase 6B — final closure & the ExecutionCompletionGate.
 *
 * Covers the Phase 6B directive gates: the execution-only final_closure Stage
 * kind with legacy-default ordinary (§5/§6/E1-E2), readiness (§8-§9/E4-E6),
 * the ordinary-creation freeze after closure begins (§10/E7), closure-Stage
 * non-supersession (§11/E8), Core-derived dependencies and explicit
 * FinalPlan-derived obligations (§13-§16/E9-E12), kind-aware activation (§17/
 * E13), the normal final VerificationWindow protocol anchoring the current
 * accepted head (§18/§77/E14-E15) with normal rework semantics (§19-§20/E16-
 * E17), fresh independent acceptance verification with full coverage (§21-§23/
 * E18-E20), multiple checkpoint windows (§24/E21), the ordinary final
 * ExecutionCommit identified by stageCompleted on the final_closure Stage and
 * becoming acceptedHead (§25-§26/E22-E24) with NO auto-complete (§83/E25),
 * no new work after closure completes (§27/E26), the SEPARATE
 * ExecutionCompletionGate (§28/E27) with the sealed bare primitive (§29/E28),
 * the durable ExecutionCompletionRecord provenance (§30-§31/E29-E30), the
 * full precondition battery (§33-§43/E31-E39), the atomic gate transaction
 * that mutates nothing else (§44-§46/E40-E44), re-execution freedom (§100/
 * E45), idempotent/concurrent/crash recovery (§47-§49/§56-§57/§92-§96/E46-E49),
 * the recovery projection (§54-§55/E50), legacy compatibility (§50-§53/§97-
 * §98/E51-E53), malformed graphs (§59-§63/§102/E54), mutual exclusivity
 * (§103/E55), and the regression battery (§104-§105/E61-E68).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DurablePlanStore,
  type WorkerReportPayload,
} from "../src/index.js";
import {
  EXEC_AUTH,
  EXEC_OWNER,
  FIXED,
  durableHandoffPendingWorld,
  execAcceptInput,
  execCleanVerification,
  execLive,
  execOpenNextWindow,
  execRunDirective,
  supervisedWorld,
  tamper,
  FULL_EXEC_CEILING,
  type SupervisedWorld,
} from "./execution-world.js";

/** Read + command execution envelope for reconciliation inspections. */
const RECON_ENVELOPE = {
  repositoryRead: true,
  repositoryWrite: false,
  commandExecution: true,
  networkAccess: false,
  dependencyMutation: false,
  gitCommit: false,
  gitPush: false,
  externalServiceMutation: false,
};

/** The exact FinalPlan-reachable obligation refs every closure set must carry (§15): F1/F2/F3. */
function closureObligations(world: SupervisedWorld) {
  const finalPlanRef = { kind: "final_plan" as const, id: world.run.finalPlan.id, revision: world.run.finalPlan.revision };
  return [
    { description: "The approved persistence contract remains valid across the integrated implementation", planRefs: [finalPlanRef] },
    { description: "Global invariants hold across the integrated implementation", planRefs: [finalPlanRef] },
    { description: "The final regression pass over the approved Sections succeeds", planRefs: [finalPlanRef] },
  ];
}

/** Complete the CURRENTLY-ACTIVE ordinary Stage through a stage-scope accept. */
async function completeOrdinaryStage(world: SupervisedWorld): Promise<string> {
  const window = (await world.world.store.findOpenVerificationWindow(world.run.id))!;
  world.window = window;
  const liveActive = ((await world.world.store.getExecutionRun(world.run.id))!).activeStage!;
  const stage = (await world.world.store.getExecutionStage(liveActive))!;
  await execRunDirective(world, { objective: `work for ${stage.id}` });
  const coverage = stage.completionObligations!.map((obligation) => obligation.id as string);
  await execCleanVerification(world, coverage, { objective: `verify ${stage.id}` });
  const accept = await execAcceptInput(world, { acceptanceScope: "stage", coveredObligations: coverage });
  const { commit } = (await world.world.store.submitSupervisorAssessment(accept)) as { commit: { id: string } };
  return commit.id;
}

/** Drive the world to "all ordinary Stages completed, idle, accepted progress" (§68). */
async function completedOrdinaryWorld(loaded?: import("./execution-world.js").HandoffPendingWorld, stageCount = 2): Promise<SupervisedWorld> {
  const world = await supervisedWorld(loaded, 1);
  await completeOrdinaryStage(world); // Stage A
  for (let index = 1; index < stageCount; index++) {
    const live = await execLive(world);
    const [next] = await world.world.store.createExecutionStages({
      executionRunID: world.run.id,
      ...EXEC_AUTH,
      drafts: [
        {
          title: `Stage ${index + 1}`,
          objective: "objective",
          planRefs: [{ kind: "implementation_step", order: 1 }],
          dependsOn: [world.stage.id],
          completionObligations: [{ description: `Obligation ${index + 1}`, planRefs: [{ kind: "implementation_step" as const, order: 1 }] }],
        },
      ],
    });
    world.stage = next!;
    const activated = await world.world.store.activateExecutionStage({
      executionRunID: world.run.id,
      stageID: next!.id,
      ...EXEC_AUTH,
      expectedRunRevision: live.run.revision,
      expectedStageRevision: next!.revision,
    });
    await world.world.store.openVerificationWindow({
      executionRunID: world.run.id,
      stageID: next!.id,
      ...EXEC_AUTH,
      expectedRunRevision: activated.run.revision,
      expectedStageRevision: activated.stage.revision,
    });
    await completeOrdinaryStage(world);
  }
  return world;
}

/** Prepare the final_closure Stage (live CAS). */
async function prepareClosure(world: SupervisedWorld, overrides: Record<string, unknown> = {}) {
  const { run } = await execLive(world);
  void run;
  return world.world.store.prepareFinalClosureStage({
    executionRunID: world.run.id,
    ...EXEC_AUTH,
    expectedRunRevision: run.revision,
    title: "Final integration closure",
    objective: "Verify the approved design end-to-end across the integrated implementation",
    completionObligations: closureObligations(world),
    ...overrides,
  });
}

/** Prepare + activate the final closure Stage and open its first Window. */
async function closureActive(world: SupervisedWorld) {
  const { stage } = await prepareClosure(world);
  const live = await execLive(world);
  const activated = await world.world.store.activateExecutionStage({
    executionRunID: world.run.id,
    stageID: stage.id,
    ...EXEC_AUTH,
    expectedRunRevision: live.run.revision,
    expectedStageRevision: stage.revision,
  });
  world.stage = activated.stage;
  const window = await execOpenNextWindow(world);
  return { stage: activated.stage, window };
}

/** Accept the final candidate with stage scope over the given coverage. */
async function finalAccept(world: SupervisedWorld, coverage: string[]) {
  return world.world.store.submitSupervisorAssessment(
    await execAcceptInput(world, { acceptanceScope: "stage", coveredObligations: coverage }),
  );
}

/** Drive the world to the §83 recovery point: final closure committed, run still active. */
async function completionReadyWorld(loaded?: import("./execution-world.js").HandoffPendingWorld) {
  const world = await completedOrdinaryWorld(loaded as never);
  const { stage } = await closureActive(world);
  const coverage = stage.completionObligations!.map((obligation) => obligation.id as string);
  await execRunDirective(world, { objective: "final integration validation" });
  await execCleanVerification(world, coverage, { objective: "final independent verification" });
  const { commit } = (await finalAccept(world, coverage)) as { commit: { id: string } };
  return { world, stage, commit };
}

/** The gate input for a world — the gate derives everything from canonical state. */
function gateInput(world: SupervisedWorld, overrides: Record<string, unknown> = {}) {
  return {
    executionRunID: world.run.id,
    ...EXEC_AUTH,
    ...overrides,
  };
}

describe("closure readiness & preparation (§68-§72/E1-E12)", () => {
  it("§68 readiness is TRUE once every ordinary Stage is completed and the run is idle", async () => {
    const world = await completedOrdinaryWorld();
    expect(await world.world.store.isExecutionReadyForFinalClosure(world.run.id)).toBe(true);
    const recovery = await world.world.store.buildExecutionRecoveryContext(world.run.id, { sessionID: EXEC_OWNER });
    expect(recovery!.finalClosure).toBe("absent");
    expect(recovery!.completionReady).toBe(false);
    expect(recovery!.completionBlockers).toContain("final_closure_absent");
  });

  it("§69/§70/§71 a pending/active ordinary Stage or an open Window blocks preparation (final_closure_not_ready)", async () => {
    // Pending ordinary Stage.
    const pendingWorld = await supervisedWorld(undefined, 1);
    await expect(prepareClosure(pendingWorld)).rejects.toMatchObject({ code: "final_closure_not_ready" });
    // Active ordinary Stage (supervisedWorld activates its Stage).
    const activeWorld = await supervisedWorld(undefined, 1);
    await expect(prepareClosure(activeWorld)).rejects.toMatchObject({ code: "final_closure_not_ready" });
    // Open Window (stage completed but window kept open via a window-scope checkpoint).
    const windowWorld = await supervisedWorld(undefined, 1);
    await execRunDirective(windowWorld, {});
    await execCleanVerification(windowWorld);
    await windowWorld.world.store.submitSupervisorAssessment(await execAcceptInput(windowWorld)); // window-scope
    await expect(prepareClosure(windowWorld)).rejects.toMatchObject({ code: "final_closure_not_ready" });
  });

  it("§72 prepare creates THE pending final_closure Stage with Core-derived dependencies and explicit FinalPlan obligations", async () => {
    const world = await completedOrdinaryWorld();
    const { stage, created } = await prepareClosure(world);
    expect(created).toBe(true);
    expect(stage.kind).toBe("final_closure");
    expect(stage.status).toBe("pending");
    const ordinary = (await world.world.store.listExecutionStagesForRun(world.run.id)).filter((candidate) => candidate.kind !== "final_closure");
    expect([...stage.dependsOn].sort()).toEqual(ordinary.map((candidate) => candidate.id).sort()); // every ordinary completed Stage
    expect(stage.completionObligations!.length).toBeGreaterThanOrEqual(1);
    expect(stage.planRefs).toEqual([{ kind: "final_plan", id: world.run.finalPlan.id, revision: world.run.finalPlan.revision }]);
    // Idempotent same-request retry.
    const retry = await prepareClosure(world);
    expect(retry.created).toBe(false);
    expect(retry.stage).toEqual(stage);
    // A different closure request conflicts (one closure Stage per run, §7).
    await expect(prepareClosure(world, { title: "A DIFFERENT closure" })).rejects.toMatchObject({ code: "final_closure_already_exists" });
  });

  it("§14/§15 empty obligation sets and sets missing the FinalPlan ref/hard-Constraint coverage are rejected", async () => {
    const world = await completedOrdinaryWorld();
    await expect(prepareClosure(world, { completionObligations: [] })).rejects.toMatchObject({ code: "invalid_final_closure_obligations" });
    await expect(
      prepareClosure(world, {
        completionObligations: [{ description: "no plan provenance", planRefs: [] }],
      }),
    ).rejects.toMatchObject({ code: "invalid_final_closure_obligations" });
    void world;
  });
});

describe("closure uniqueness/freeze/supersede/activation (§7/§10/§11/§17/§73-§76)", () => {
  it("§73 the durable prepare race produces exactly ONE final_closure Stage", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ultra-plan-exec-closure-race-"));
    try {
      const filePath = path.join(dir, "plan.json");
      const loaded = await durableHandoffPendingWorld(filePath);
      const world = await completedOrdinaryWorld(loaded as never);
      const { run } = await execLive(world);
      const input = {
        executionRunID: world.run.id, ...EXEC_AUTH, expectedRunRevision: run.revision,
        title: "Final integration closure", objective: "Verify the approved design end-to-end",
        completionObligations: closureObligations(world),
      };
      const outcomes = await Promise.allSettled([
        world.world.store.prepareFinalClosureStage(input),
        world.world.store.prepareFinalClosureStage(input),
      ]);
      const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
      expect(fulfilled).toHaveLength(2);
      expect(fulfilled.filter((outcome) => (outcome as PromiseFulfilledResult<{ created: boolean }>).value.created)).toHaveLength(1);
      const stages = await world.world.store.listExecutionStagesForRun(world.run.id);
      expect(stages.filter((stage) => stage.kind === "final_closure")).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("§74/E7 no ordinary Stage can be created after closure begins — or after it completes", async () => {
    const world = await completedOrdinaryWorld();
    await prepareClosure(world);
    await expect(
      world.world.store.createExecutionStages({
        executionRunID: world.run.id, ...EXEC_AUTH,
        drafts: [{ title: "Late ordinary", objective: "o", planRefs: [], dependsOn: [] }],
      }),
    ).rejects.toMatchObject({ code: "ordinary_stage_exists_after_closure_started" });
    // E26: after the closure Stage COMPLETES, no new execution structure at all.
    const ready = await completionReadyWorld();
    await expect(
      ready.world.world.store.createExecutionStages({
        executionRunID: ready.world.run.id, ...EXEC_AUTH,
        drafts: [{ title: "Post-closure", objective: "o", planRefs: [], dependsOn: [] }],
      }),
    ).rejects.toMatchObject({ code: "invalid_execution_lifecycle" });
  });

  it("§75/E8 the final_closure Stage cannot be superseded (any status)", async () => {
    const world = await completedOrdinaryWorld();
    const { stage } = await prepareClosure(world);
    await expect(
      world.world.store.supersedeExecutionStage({
        executionRunID: world.run.id, stageID: stage.id, ...EXEC_AUTH, expectedStageRevision: stage.revision,
      }),
    ).rejects.toMatchObject({ code: "invalid_stage_transition" });
  });

  it("§76/E13 activation reuses the normal protocol and makes the closure Stage the run's active Stage", async () => {
    // (The "ordinary pending/active blocks closure activation" arm is
    // protocol-unreachable by design: prepare §8 already requires all ordinary
    // Stages completed, and the loader rejects the impossible combination —
    // the activation guard is belt-and-suspenders defense in depth.)
    const world = await completedOrdinaryWorld();
    const { stage } = await closureActive(world);
    expect(stage.status).toBe("active");
    expect((await execLive(world)).run.activeStage).toBe(stage.id);
    // Identical re-prepare replays the existing closure Stage (§7 idempotency);
    // a DIFFERENT closure request conflicts (§11 — no second closure Stage).
    const replay = await prepareClosure(world);
    expect(replay.created).toBe(false);
    await expect(prepareClosure(world, { objective: "a DIFFERENT closure" })).rejects.toMatchObject({ code: "final_closure_already_exists" });
  });
});

describe("final verification window & commit (§18-§26/§77-§83/E14-E25)", () => {
  it("§77/E15 the final Window anchors the CURRENT accepted head (EC-001), never a fake baseline", async () => {
    const world = await completedOrdinaryWorld();
    const before = await execLive(world);
    expect(before.run.acceptedHead).toBe("EC-002"); // the last ordinary Stage-completing commit
    await closureActive(world);
    const window = (await world.world.store.findOpenVerificationWindow(world.run.id))!;
    expect(window.baseAcceptedState).toEqual({ kind: "execution_commit", executionCommitID: "EC-002" });
  });

  it("§78/§E16 integration rework inside the final closure follows the frozen Phase 4/5 semantics", async () => {
    const world = await completedOrdinaryWorld();
    const { stage } = await closureActive(world);
    const coverage = stage.completionObligations!.map((obligation) => obligation.id as string);
    // The final verifier finds a defect at revision 0.
    await execRunDirective(world, { kind: "verification", objective: "final verify", candidateEffect: "non_mutating", capabilityEnvelope: { ...FULL_EXEC_CEILING, repositoryWrite: false } },
      { workerRole: "verifier", candidateMutation: "none", findings: [{ statement: "integration regression", acceptanceImpact: "blocking" }] });
    await expect(finalAccept(world, coverage)).rejects.toMatchObject({ code: "blocking_verification_result" });
    // Rework inside the SAME final_closure Stage: implementation Directive → revision 1.
    await execRunDirective(world, { objective: "integration repair" });
    // Fresh verification at revision 1 → stage-scope accept completes closure.
    await execCleanVerification(world, coverage, { objective: "fresh final verification at revision 1" });
    const { commit } = (await finalAccept(world, coverage)) as { commit: { id: string } };
    expect(commit.id).toBe("EC-003");
  });

  it("§79/§E18 final completion without a fresh verifier fails VERIFICATION_REQUIRED (no closure exception)", async () => {
    const world = await completedOrdinaryWorld();
    const { stage } = await closureActive(world);
    const coverage = stage.completionObligations!.map((obligation) => obligation.id as string);
    // Only implementation work; NO verification at all.
    await execRunDirective(world, { objective: "final validation work" });
    await expect(finalAccept(world, coverage)).rejects.toMatchObject({ code: "verification_required" });
    const stageAfter = await world.world.store.getExecutionStage(stage.id);
    expect(stageAfter!.status).toBe("active");
  });

  it("§80/§E20 stage-scope completion requires COMPLETE final obligation coverage", async () => {
    const world = await completedOrdinaryWorld();
    const { stage } = await closureActive(world);
    const all = stage.completionObligations!.map((obligation) => obligation.id as string);
    expect(all).toHaveLength(3); // F1/F2/F3
    const partial = all.slice(0, 2); // F1 F2 only
    await execRunDirective(world, { objective: "final validation" });
    await execCleanVerification(world, partial, { objective: "partial final verification" });
    await expect(finalAccept(world, partial)).rejects.toMatchObject({ code: "stage_completion_incomplete" });
    // Full coverage passes.
    await execCleanVerification(world, all, { objective: "complete final verification" });
    const { commit } = (await finalAccept(world, all)) as { commit: { id: string } };
    expect(commit.id).toBe("EC-003");
  });

  it("§81/§82 conflicts and unresolved indeterminate Attempts still block the final accept", async () => {
    // Open conflict on the final candidate.
    const conflictWorld = await completedOrdinaryWorld();
    const { stage } = await closureActive(conflictWorld);
    const coverage = stage.completionObligations!.map((obligation) => obligation.id as string);
    await execRunDirective(conflictWorld, { objective: "final work" });
    const failed = await execRunDirective(
      conflictWorld,
      { kind: "verification", objective: "v1", candidateEffect: "non_mutating", capabilityEnvelope: { ...FULL_EXEC_CEILING, repositoryWrite: false } },
      { workerRole: "verifier", candidateMutation: "none", result: "failed" },
    );
    const clean = await execCleanVerification(conflictWorld, coverage, { objective: "v2" });
    const window = await execLive(conflictWorld);
    const { conflict } = await conflictWorld.world.store.createVerificationConflict({
      executionRunID: conflictWorld.run.id, stageID: conflictWorld.stage.id, windowID: conflictWorld.window.id,
      candidateRevision: window.window.candidateRevision, ...EXEC_AUTH,
      evidenceA: { kind: "report_result", reportID: (await conflictWorld.world.store.findExecutionReportForAttempt(failed.attempt.id))!.id },
      evidenceB: { kind: "report_result", reportID: (await conflictWorld.world.store.findExecutionReportForAttempt(clean.attempt.id))!.id },
      claimA: "broken", claimB: "works", resolutionQuestion: "Which is true?",
    });
    await expect(finalAccept(conflictWorld, coverage)).rejects.toMatchObject({ code: "verification_conflict_open" });
    void conflict;
    // Unresolved indeterminate on the final candidate.
    const indeterminateWorld = await completedOrdinaryWorld();
    const stage2 = await closureActive(indeterminateWorld);
    const coverage2 = stage2.stage.completionObligations!.map((obligation) => obligation.id as string);
    const live = await execLive(indeterminateWorld);
    const directive = await indeterminateWorld.world.store.issueExecutionDirective({
      executionRunID: indeterminateWorld.run.id, stageID: indeterminateWorld.stage.id, windowID: indeterminateWorld.window.id, ...EXEC_AUTH, ceiling: FULL_EXEC_CEILING,
      expectedRunRevision: live.run.revision, expectedStageRevision: live.stage.revision, expectedWindowRevision: live.window.revision,
      draft: { kind: "implementation", objective: "interrupted", planRefs: [], expectedExecutionScope: {}, capabilityEnvelope: { ...FULL_EXEC_CEILING }, candidateEffect: "may_mutate", invariants: [], requiredActions: [], forbiddenActions: [], validationRequirements: [], deliverables: [], stopConditions: [], reportContract: "", body: "" },
    });
    const { attempt } = await indeterminateWorld.world.store.startExecutionAttempt({
      executionRunID: indeterminateWorld.run.id, directive: { id: directive.id, revision: directive.revision }, ...EXEC_AUTH, ceiling: FULL_EXEC_CEILING,
    });
    await indeterminateWorld.world.store.markExecutionAttemptIndeterminate({ executionRunID: indeterminateWorld.run.id, attemptID: attempt.id, ...EXEC_AUTH });
    await expect(finalAccept(indeterminateWorld, coverage2)).rejects.toMatchObject({ code: "reconciliation_required" });
    void coverage2;
  });

  it("§83/§E25 the final Commit completes the closure Stage but the run does NOT auto-complete", async () => {
    const { world, stage, commit } = await completionReadyWorld();
    expect(commit.id).toBe("EC-003"); // two ordinary Stage commits + the final one
    const closedStage = await world.world.store.getExecutionStage(stage.id);
    expect(closedStage!.status).toBe("completed");
    const live = await execLive(world);
    expect(live.run.lifecycle).toBe("active");
    expect(live.run.acceptedHead).toBe(commit.id);
    expect(live.run.activeStage).toBeUndefined();
    expect(live.run.openWindow).toBeUndefined();
    // Recovery shows the crash-recovery point (§56/§84).
    const recovery = await world.world.store.buildExecutionRecoveryContext(world.run.id, { sessionID: EXEC_OWNER });
    expect(recovery!.finalClosure).toBe("completed");
    expect(recovery!.completionReady).toBe(true);
    expect(recovery!.completionBlockers).toEqual([]);
    expect(recovery!.finalClosureCommit).toMatchObject({ id: commit.id });
  });
});

describe("the ExecutionCompletionGate (§28-§49/§85-§94)", () => {
  it("§85-§86/§E40-E43 the gate persists the record + terminal transition and changes NOTHING else", async () => {
    const { world } = await completionReadyWorld();
    const before = {
      stages: await world.world.store.listExecutionStagesForRun(world.run.id),
      windows: await world.world.store.listVerificationWindowsForRun(world.run.id),
      directives: await world.world.store.listExecutionDirectivesForRun(world.run.id),
      attempts: await world.world.store.listExecutionAttemptsForRun(world.run.id),
      reports: await world.world.store.listExecutionReportsForRun(world.run.id),
      assessments: await world.world.store.listSupervisorAssessmentsForRun(world.run.id),
      commits: await world.world.store.listExecutionCommitsForRun(world.run.id),
      binding: await world.world.store.findSupervisorBinding(world.run.id),
    };
    const { record, run, created } = await world.world.store.completeExecutionRunThroughGate(await gateInput(world));
    expect(created).toBe(true);
    expect(run.lifecycle).toBe("completed");
    expect(run.completionRecord).toBe(record.id);
    expect(run.acceptedHead).toBe(record.acceptedHead);
    expect(record.finalPlanRef).toEqual({ id: world.run.finalPlan.id, revision: world.run.finalPlan.revision });
    expect(record.finalCommitID).toBe(run.acceptedHead);
    expect(record.finalVerificationReportRefs!.length).toBeGreaterThan(0);
    // §44/§86 — history untouched; binding preserved (§45/E43).
    expect(await world.world.store.listExecutionStagesForRun(world.run.id)).toEqual(before.stages);
    expect(await world.world.store.listVerificationWindowsForRun(world.run.id)).toEqual(before.windows);
    expect(await world.world.store.listExecutionDirectivesForRun(world.run.id)).toEqual(before.directives);
    expect(await world.world.store.listExecutionAttemptsForRun(world.run.id)).toEqual(before.attempts);
    expect(await world.world.store.listExecutionReportsForRun(world.run.id)).toEqual(before.reports);
    expect(await world.world.store.listSupervisorAssessmentsForRun(world.run.id)).toEqual(before.assessments);
    expect(await world.world.store.listExecutionCommitsForRun(world.run.id)).toEqual(before.commits);
    expect(await world.world.store.findSupervisorBinding(world.run.id)).toEqual(before.binding);
    // Recovery: v0.2 protocol provenance (§52/E51).
    const recovery = await world.world.store.buildExecutionRecoveryContext(world.run.id, { sessionID: EXEC_OWNER });
    expect(recovery!.executionCompletion).toMatchObject({ protocol: "v0.2" });
    expect(recovery!.completionReady).toBe(false);
  });

  it("§87/§E28 no force/complete bypass exists on the store surface", async () => {
    const world = await completedOrdinaryWorld();
    const storeShape = Object.getOwnPropertyNames(Object.getPrototypeOf(world.world.store) as Record<string, unknown>);
    expect(storeShape).not.toContain("completeExecutionRun");
    expect(storeShape).not.toContain("forceCompleteExecutionRun");
    expect(storeShape).not.toContain("setExecutionLifecycle");
    expect(storeShape).toContain("completeExecutionRunThroughGate");
  });

  it("§88/§26 an accepted head that is not the final closure Commit fails closed (loader-enforced; the gate's stale_execution_head arm is defense in depth)", async () => {
    // §26: "final closure commit, then another accepted commit" must fail
    // closed STRUCTURALLY. The linear-chain loader invariant (acceptedHead ==
    // chain tip == the stage-completing closure commit) rejects any such state
    // at load — no accepted state with a non-head final closure commit ever
    // reaches the gate (whose own stale_execution_head arm guards a hostile
    // store that somehow clears validation).
    const dir = await mkdtemp(path.join(tmpdir(), "ultra-plan-exec-completion-stale-"));
    try {
      const filePath = path.join(dir, "plan.json");
      const loaded = await durableHandoffPendingWorld(filePath);
      const { world } = await completionReadyWorld(loaded as never);
      (world.world.store as unknown as { close(): void }).close();
      await tamper(filePath, (raw) => {
        (raw["executionRuns"] as Record<string, Record<string, unknown>>)[world.run.id]!["acceptedHead"] = "EC-001";
      });
      try {
        new DurablePlanStore(filePath, { now: () => FIXED }).open();
        throw new Error("expected store_corrupt at open");
      } catch (error) {
        expect((error as { code?: string }).code ?? "store_corrupt").toBe("store_corrupt");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("§89/§90 completion without a completed final closure Stage fails (final_closure_commit_required)", async () => {
    // No closure Stage at all.
    const bare = await completedOrdinaryWorld();
    await expect(bare.world.store.completeExecutionRunThroughGate(await gateInput(bare))).rejects.toMatchObject({ code: "final_closure_commit_required" });
    // Closure Stage ACTIVE with a checkpoint (window-scope) Commit but no stage-completing Commit.
    const world = await completedOrdinaryWorld();
    const { stage } = await closureActive(world);
    await execRunDirective(world, { objective: "checkpoint work" });
    await execCleanVerification(world, []);
    await world.world.store.submitSupervisorAssessment(await execAcceptInput(world)); // window-scope checkpoint
    const live = await execLive(world);
    expect(live.run.acceptedHead).toBe("EC-003");
    await expect(
      world.world.store.completeExecutionRunThroughGate({ executionRunID: world.run.id, ...EXEC_AUTH }),
    ).rejects.toMatchObject({ code: "execution_completion_not_ready" });
    void stage;
  });

  it("§91/§E34 unresolved indeterminate blocks completion; reconciled indeterminate history does not", async () => {
    // Full completion WITH a reconciled indeterminate episode inside an ordinary Stage.
    const world = await supervisedWorld(undefined, 1); // Stage A active, Window open
    // An indeterminate implementation attempt...
    const live = await execLive(world);
    const directive = await world.world.store.issueExecutionDirective({
      executionRunID: world.run.id, stageID: world.stage.id, windowID: world.window.id, ...EXEC_AUTH, ceiling: FULL_EXEC_CEILING,
      expectedRunRevision: live.run.revision, expectedStageRevision: live.stage.revision, expectedWindowRevision: live.window.revision,
      draft: { kind: "implementation", objective: "interrupted", planRefs: [], expectedExecutionScope: {}, capabilityEnvelope: { ...FULL_EXEC_CEILING }, candidateEffect: "may_mutate", invariants: [], requiredActions: [], forbiddenActions: [], validationRequirements: [], deliverables: [], stopConditions: [], reportContract: "", body: "" },
    });
    const { attempt } = await world.world.store.startExecutionAttempt({
      executionRunID: world.run.id, directive: { id: directive.id, revision: directive.revision }, ...EXEC_AUTH, ceiling: FULL_EXEC_CEILING,
    });
    await world.world.store.markExecutionAttemptIndeterminate({ executionRunID: world.run.id, attemptID: attempt.id, ...EXEC_AUTH });
    // ...reconciled by an unchanged inspection.
    const live2 = await execLive(world);
    const inspection = await world.world.store.issueExecutionDirective({
      executionRunID: world.run.id, stageID: world.stage.id, windowID: world.window.id, ...EXEC_AUTH, ceiling: FULL_EXEC_CEILING,
      expectedRunRevision: live2.run.revision, expectedStageRevision: live2.stage.revision, expectedWindowRevision: live2.window.revision,
      draft: { kind: "inspection", objective: "reconcile", planRefs: [], expectedExecutionScope: {}, capabilityEnvelope: RECON_ENVELOPE, candidateEffect: "non_mutating", invariants: [], requiredActions: [], forbiddenActions: [], validationRequirements: [], deliverables: [], stopConditions: [], reportContract: "", body: "", reconciliationTargets: [attempt.id] },
    });
    const inspectionAttempt = await world.world.store.startExecutionAttempt({
      executionRunID: world.run.id, directive: { id: inspection.id, revision: inspection.revision }, ...EXEC_AUTH, ceiling: FULL_EXEC_CEILING,
    });
    await world.world.store.submitExecutionReport({
      executionRunID: world.run.id, attemptID: inspectionAttempt.attempt.id, ...EXEC_AUTH,
      report: {
        directive: { id: inspection.id, revision: inspection.revision, hash: inspection.hash },
        workerRole: "executor", result: "completed", actionsPerformed: [], filesExamined: [], filesChanged: [], commandsRun: [], testsRun: [],
        findings: [], deviations: [], blockers: [], deliverables: [], candidateMutation: "none",
        baseCandidateRevision: live2.window.candidateRevision, reconciliationObservation: "unchanged",
      } as WorkerReportPayload,
    });
    await world.world.store.recordAttemptReconciliation({
      executionRunID: world.run.id, stageID: world.stage.id, windowID: world.window.id, ...EXEC_AUTH,
      targetAttemptIDs: [attempt.id], inspectionDirective: { id: inspection.id, revision: inspection.revision },
    });
    // The reconciled history no longer blocks: finish the whole path to completed.
    const coverage = world.stage.completionObligations!.map((obligation) => obligation.id as string);
    await execCleanVerification(world, coverage, { objective: "verify after reconciliation" });
    await world.world.store.submitSupervisorAssessment(await execAcceptInput(world, { acceptanceScope: "stage", coveredObligations: coverage }));
    const { stage: closure } = await prepareClosure(world);
    const live4 = await execLive(world);
    await world.world.store.activateExecutionStage({
      executionRunID: world.run.id, stageID: closure.id, ...EXEC_AUTH,
      expectedRunRevision: live4.run.revision, expectedStageRevision: closure.revision,
    });
    await execOpenNextWindow(world);
    const closureCoverage = closure.completionObligations!.map((obligation) => obligation.id as string);
    await execRunDirective(world, { objective: "final validation" });
    await execCleanVerification(world, closureCoverage, { objective: "final verification" });
    await finalAccept(world, closureCoverage);
    const { run } = await world.world.store.completeExecutionRunThroughGate({ executionRunID: world.run.id, ...EXEC_AUTH });
    expect(run.lifecycle).toBe("completed");
    void coverage;
  });

  it("§92/§48/§96 completion retry is idempotent — same record, no duplicate events, even after reopen", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ultra-plan-exec-completion-retry-"));
    try {
      const filePath = path.join(dir, "plan.json");
      const loaded = await durableHandoffPendingWorld(filePath);
      const { world } = await completionReadyWorld(loaded as never);
      const first = await world.world.store.completeExecutionRunThroughGate({ executionRunID: world.run.id, ...EXEC_AUTH, completionID: "CMPL-001" as never });
      expect(first.created).toBe(true);
      const retry = await world.world.store.completeExecutionRunThroughGate({ executionRunID: world.run.id, ...EXEC_AUTH, completionID: "CMPL-001" as never });
      expect(retry.created).toBe(false);
      expect(retry.record).toEqual(first.record);
      expect(retry.run).toEqual(first.run);
      // §93 — same id + conflicting final-commit belief is a conflict.
      await expect(
        world.world.store.completeExecutionRunThroughGate({ executionRunID: world.run.id, ...EXEC_AUTH, completionID: "CMPL-001" as never, expectedFinalCommitID: "EC-001" as never }),
      ).rejects.toMatchObject({ code: "execution_completion_conflict" });
      // Crash after the completion commit point: reopen → exact record + terminal run; retry replays.
      (world.world.store as unknown as { close(): void }).close();
      const reopened = new DurablePlanStore(filePath, { now: () => FIXED });
      expect(await reopened.getExecutionCompletion("CMPL-001" as never)).toEqual(first.record);
      expect(((await reopened.getExecutionRun(world.run.id))!).lifecycle).toBe("completed");
      const replay = await reopened.completeExecutionRunThroughGate({ executionRunID: world.run.id, ...EXEC_AUTH, completionID: "CMPL-001" as never });
      expect(replay.created).toBe(false);
      expect(replay.record).toEqual(first.record);
      reopened.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("§94/§E47 concurrent completion across durable instances yields ONE record and ONE transition", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ultra-plan-exec-completion-race-"));
    try {
      const filePath = path.join(dir, "plan.json");
      const loaded = await durableHandoffPendingWorld(filePath);
      const { world } = await completionReadyWorld(loaded as never);
      (world.world.store as unknown as { close(): void }).close();
      const a = new DurablePlanStore(filePath, { now: () => FIXED });
      const b = new DurablePlanStore(filePath, { now: () => FIXED });
      const input = { executionRunID: world.run.id, ...EXEC_AUTH, completionID: "CMPL-001" as never };
      const outcomes = await Promise.allSettled([a.completeExecutionRunThroughGate(input), b.completeExecutionRunThroughGate(input)]);
      const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
      expect(fulfilled).toHaveLength(2);
      expect(fulfilled.filter((outcome) => (outcome as PromiseFulfilledResult<{ created: boolean }>).value.created)).toHaveLength(1);
      const verify = new DurablePlanStore(filePath, { now: () => FIXED });
      expect(((await verify.getExecutionRun(world.run.id))!).lifecycle).toBe("completed");
      expect(await verify.findExecutionCompletionForRun(world.run.id)).toBeDefined();
      const events = (await verify.listEvents((await verify.getExecutionRun(world.run.id))!.planID)).filter((event) => event.detail.type === "execution.run_completed");
      expect(events).toHaveLength(1);
      verify.close();
      a.close();
      b.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("§95/§56/§84 crash after the final Commit recovers to completionReady WITHOUT repeating verification", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ultra-plan-exec-completion-crash-"));
    try {
      const filePath = path.join(dir, "plan.json");
      const loaded = await durableHandoffPendingWorld(filePath);
      const { world } = await completionReadyWorld(loaded as never);
      (world.world.store as unknown as { close(): void }).close();
      const reopened = new DurablePlanStore(filePath, { now: () => FIXED });
      const recovery = await reopened.buildExecutionRecoveryContext(world.run.id, { sessionID: EXEC_OWNER });
      expect(recovery!.completionReady).toBe(true);
      // Straight to the gate: no verifier, no assessment, no commit re-run.
      const { run, record } = await reopened.completeExecutionRunThroughGate({ executionRunID: world.run.id, ...EXEC_AUTH });
      expect(run.lifecycle).toBe("completed");
      expect(record.finalCommitID).toBe("EC-003");
      reopened.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("legacy compatibility & post-completion world (§50-§53/§97-§103)", () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "ultra-plan-exec-completion-"));
    filePath = path.join(dir, "plan.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function corruptOpen(file: string): Promise<unknown> {
    try {
      new DurablePlanStore(file, { now: () => FIXED }).open();
      return Promise.reject(new Error("expected store_corrupt at open"));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  it("§97/§E52 a pre-6B completed run (no record) still loads and is explicitly LEGACY in recovery", async () => {
    const loaded = await durableHandoffPendingWorld(filePath);
    const world = await supervisedWorld(loaded as never);
    const { run } = await execLive(world);
    (world.world.store as unknown as { close(): void }).close();
    await tamper(filePath, (raw) => {
      (raw["executionRuns"] as Record<string, Record<string, unknown>>)[run.id]!["lifecycle"] = "completed";
    });
    const reopened = new DurablePlanStore(filePath, { now: () => FIXED });
    expect(((await reopened.getExecutionRun(run.id))!).lifecycle).toBe("completed");
    const recovery = await reopened.buildExecutionRecoveryContext(run.id, { sessionID: EXEC_OWNER });
    expect(recovery!.executionCompletion).toEqual({ protocol: "legacy" });
    reopened.close();
  });

  it("§98/§E53 a dangling completionRecord ref on a completed run fails closed; records on non-completed runs fail closed", async () => {
    const loaded = await durableHandoffPendingWorld(filePath);
    const world = await supervisedWorld(loaded as never);
    const { run } = await execLive(world);
    (world.world.store as unknown as { close(): void }).close();
    await tamper(filePath, (raw) => {
      (raw["executionRuns"] as Record<string, Record<string, unknown>>)[run.id]!["lifecycle"] = "completed";
      (raw["executionRuns"] as Record<string, Record<string, unknown>>)[run.id]!["completionRecord"] = "CMPL-001";
    });
    // completed + dangling record ref (no CMPL-001 record) → the run/record bidirectionality fails.
    await expect(corruptOpen(filePath)).rejects.toMatchObject({ code: "store_corrupt" });
    // Record against an ACTIVE run → fail closed.
    await tamper(filePath, (raw) => {
      (raw["executionRuns"] as Record<string, Record<string, unknown>>)[run.id]!["lifecycle"] = "active";
      (raw["executionRuns"] as Record<string, Record<string, unknown>>)[run.id]!["completionRecord"] = undefined;
      (raw["executionCompletions"] as Record<string, unknown>)["CMPL-001"] = {
        id: "CMPL-001",
        executionRunID: run.id,
        finalPlanRef: { id: "FINAL-001", revision: 1 },
        finalClosureStageID: "STAGE-001",
        finalWindowID: "WIN-001",
        finalCommitID: "EC-001",
        finalAssessmentID: "SA-001",
        acceptedHead: "EC-001",
        completedAt: FIXED,
        hash: "bogus",
      };
    });
    await expect(corruptOpen(filePath)).rejects.toMatchObject({ code: "store_corrupt" });
  });

  it("§99/§E44-E46 a completed run refuses every execution mutation; completed is terminal", async () => {
    const loaded = await durableHandoffPendingWorld(filePath);
    const { world } = await completionReadyWorld(loaded as never);
    const { run } = await world.world.store.completeExecutionRunThroughGate({ executionRunID: world.run.id, ...EXEC_AUTH });
    expect(run.lifecycle).toBe("completed");
    // Create/activate Stage.
    await expect(
      world.world.store.createExecutionStages({ executionRunID: world.run.id, ...EXEC_AUTH, drafts: [{ title: "x", objective: "o", planRefs: [], dependsOn: [] }] }),
    ).rejects.toMatchObject({ code: "invalid_execution_lifecycle" });
    // Issue Directive.
    await expect(
      world.world.store.issueExecutionDirective({
        executionRunID: world.run.id, stageID: world.stage.id, windowID: world.window.id, ...EXEC_AUTH, ceiling: FULL_EXEC_CEILING,
        expectedRunRevision: run.revision, expectedStageRevision: 1, expectedWindowRevision: 1,
        draft: { kind: "implementation", objective: "x", planRefs: [], expectedExecutionScope: {}, capabilityEnvelope: { ...FULL_EXEC_CEILING }, candidateEffect: "non_mutating", invariants: [], requiredActions: [], forbiddenActions: [], validationRequirements: [], deliverables: [], stopConditions: [], reportContract: "", body: "" },
      }),
    ).rejects.toMatchObject({ code: "invalid_execution_lifecycle" });
    // Supervisor assessment.
    await expect(
      world.world.store.submitSupervisorAssessment({
        executionRunID: world.run.id, stageID: world.stage.id, windowID: world.window.id, candidateRevision: 0, ...EXEC_AUTH,
        draft: { reportRefs: [], planRefs: [], coveredObligations: [], acceptanceScope: "window", disposition: "accept", rationale: "r" },
      }),
    ).rejects.toMatchObject({ code: "invalid_execution_lifecycle" });
    // Conflict creation + reconciliation recording.
    await expect(
      world.world.store.createVerificationConflict({
        executionRunID: world.run.id, stageID: world.stage.id, windowID: world.window.id, candidateRevision: 0, ...EXEC_AUTH,
        evidenceA: { kind: "report_result", reportID: "RPT-001" as never }, evidenceB: { kind: "report_result", reportID: "RPT-002" as never },
        claimA: "a", claimB: "b", resolutionQuestion: "q",
      }),
    ).rejects.toMatchObject({ code: "invalid_execution_lifecycle" });
    // Replan transition (§103): completed → replan FAILS.
    await expect(
      world.world.store.transitionExecutionRunToReplanRequired({
        executionRunID: world.run.id, ...EXEC_AUTH, sourceAssessmentID: "SA-001" as never,
        reason: "r", affectedPlanRefs: [], expectedRunRevision: run.revision,
      }),
    ).rejects.toMatchObject({ code: "invalid_execution_lifecycle" });
    // A NEW completion attempt is execution_already_completed.
    await expect(
      world.world.store.completeExecutionRunThroughGate({ executionRunID: world.run.id, ...EXEC_AUTH }),
    ).rejects.toMatchObject({ code: "execution_already_completed" });
  });

  it("§103/§E55 replan_required runs refuse completion — the terminal states are mutually exclusive", async () => {
    const loaded = await durableHandoffPendingWorld(filePath);
    const world = await supervisedWorld(loaded as never);
    // An ACTIVE run with live structure refuses the gate on readiness first…
    await expect(
      world.world.store.completeExecutionRunThroughGate({ executionRunID: world.run.id, ...EXEC_AUTH }),
    ).rejects.toMatchObject({ code: "execution_completion_not_ready" });
    // …and a replan_required terminal run refuses it on lifecycle grounds.
    await execRunDirective(world, {});
    await world.world.store.submitSupervisorAssessment(
      (await execAcceptInput(world, { disposition: "request_replan", rationale: "escalate" })) as never,
    );
    const { run } = await execLive(world);
    await world.world.store.transitionExecutionRunToReplanRequired({
      executionRunID: world.run.id, ...EXEC_AUTH,
      sourceAssessmentID: ((await world.world.store.listSupervisorAssessmentsForRun(world.run.id)).find((a) => a.disposition === "request_replan"))!.id as never,
      reason: "normative authority exhausted",
      affectedPlanRefs: [{ kind: "implementation_step" as const, order: 1 }],
      expectedRunRevision: run.revision,
    });
    await expect(
      world.world.store.completeExecutionRunThroughGate({ executionRunID: world.run.id, ...EXEC_AUTH }),
    ).rejects.toMatchObject({ code: "invalid_execution_lifecycle" });
  });

  it("§100/§E45 the same FinalPlan can still be executed in a NEW ExecutionRun after completion", async () => {
    const loaded = await durableHandoffPendingWorld(filePath);
    const { world } = await completionReadyWorld(loaded as never);
    await world.world.store.completeExecutionRunThroughGate({ executionRunID: world.run.id, ...EXEC_AUTH });
    const second = await world.world.store.prepareInitialExecutionRun({
      planID: loaded.runID as never,
      finalPlan: world.run.finalPlan,
      finalPlanHash: world.run.finalPlanHash,
      workspace: { key: "opencode-project:worktree-B" },
      executionStartBaseline: { workspaceFingerprint: "fp-2" },
      initialHandoffKey: "second-execution",
    });
    expect(second.run.id).not.toBe(world.run.id);
    expect(second.created).toBe(true);
  });

  it("§102a/§E54 two final_closure Stages in one run fail closed", async () => {
    const loaded = await durableHandoffPendingWorld(filePath);
    const world = await completedOrdinaryWorld(loaded as never);
    await prepareClosure(world);
    (world.world.store as unknown as { close(): void }).close();
    await tamper(filePath, (raw) => {
      const stages = raw["executionStages"] as Record<string, Record<string, unknown>>;
      const closure = Object.values(stages).find((stage) => stage["kind"] === "final_closure")!;
      const clone = structuredClone(closure);
      clone["id"] = "STAGE-099";
      stages["STAGE-099"] = clone;
    });
    await expect(corruptOpen(filePath)).rejects.toMatchObject({ code: "store_corrupt" });
  });

  it("§102b/§E54 a superseded final_closure Stage fails closed", async () => {
    const loaded = await durableHandoffPendingWorld(filePath);
    const world = await completedOrdinaryWorld(loaded as never);
    await prepareClosure(world);
    (world.world.store as unknown as { close(): void }).close();
    await tamper(filePath, (raw) => {
      const stages = raw["executionStages"] as Record<string, Record<string, unknown>>;
      for (const stage of Object.values(stages)) {
        if (stage["kind"] === "final_closure") stage["status"] = "superseded";
      }
    });
    await expect(corruptOpen(filePath)).rejects.toMatchObject({ code: "store_corrupt" });
  });

  it("§101/§E60 a pre-Phase-6B store opens unchanged with an empty completion family", async () => {
    const loaded = await durableHandoffPendingWorld(filePath);
    const world = await supervisedWorld(loaded as never);
    await execRunDirective(world, {});
    (world.world.store as unknown as { close(): void }).close();
    const { readFile } = await import("node:fs/promises");
    const raw = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
    expect(raw["executionCompletions"]).toEqual({});
    const reopened = new DurablePlanStore(filePath, { now: () => FIXED });
    expect(((await reopened.getExecutionRun(world.run.id))!).lifecycle).toBe("active");
    reopened.close();
  });

  it("the v0.1 production handoff still creates NO execution artifacts (§105 regression)", async () => {
    const world = await durableHandoffPendingWorld(filePath);
    await world.controller.recoverExecutionHandoff(world.sessionID);
    expect(await world.store.listOpenExecutionRuns()).toHaveLength(0);
    const events = (await world.store.listEvents(world.runID)).map((event) => event.detail.type);
    expect(events.filter((type) => type.startsWith("execution."))).toEqual([]);
  });
});
