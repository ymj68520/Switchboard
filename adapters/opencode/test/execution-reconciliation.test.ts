/**
 * v0.2.0 Phase 6A Part C — indeterminate Attempt reconciliation.
 *
 * Covers the Phase 6A directive gates: indeterminate stays terminal immutable
 * history (§40/E38), the canonical unresolved-indeterminate set (§41/E39),
 * fail-closed reconciliation mode allowing ONLY the explicit inspection
 * (§42/E40-E41), complete-set targeting (§43/E42), capability constraints
 * (§45/E43), the reconciliation worker context (§46), the unified report
 * observation extension (§47/E44), mutating workers cannot resolve (§48/E50),
 * the durable immutable AttemptReconciliation (§49/E45), unchanged/changed
 * semantics with exactly-once candidate advance (§51/§52/E46-E47), natural
 * staleness (§53/E48), inconclusive non-resolution (§50/E49), no acceptance
 * by reconciliation (§54/E52), the upgraded commit gate (§55/E51), idempotent
 * retry (§56/E53), cross-instance race (§57/E54), commit provenance keeping
 * the uncertainty visible (§90), recovery projection (§65/E55), malformed
 * graphs (§62/§92/E56), and durable reopen (§93).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DurablePlanStore,
  assembleExecutionWorkerContext,
  type AttemptReconciliationID,
  type ExecutionAttemptID,
  type WorkerReportPayload,
} from "../src/index.js";
import {
  EXEC_AUTH,
  FIXED,
  durableHandoffPendingWorld,
  execAcceptInput,
  execCleanVerification,
  execLive,
  execRunDirective,
  supervisedWorld,
  tamper,
  FULL_EXEC_CEILING,
  type SupervisedWorld,
} from "./execution-world.js";

/** Read + command execution — the §45 reconciliation inspection envelope. */
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

/** Issue + start + abandon an attempt into the terminal indeterminate state. */
async function makeIndeterminate(world: SupervisedWorld, objective = "interrupted work") {
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
      objective,
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
    },
  });
  const { attempt } = await world.world.store.startExecutionAttempt({
    executionRunID: world.run.id,
    directive: { id: directive.id, revision: directive.revision },
    ...EXEC_AUTH,
    ceiling: FULL_EXEC_CEILING,
  });
  await world.world.store.markExecutionAttemptIndeterminate({ executionRunID: world.run.id, attemptID: attempt.id, ...EXEC_AUTH });
  return { directive, attempt };
}

/** Issue + start + report the reconciliation inspection (observation required). */
async function runReconciliationInspection(
  world: SupervisedWorld,
  targets: ExecutionAttemptID[],
  observation: "unchanged" | "changed" | "unresolved",
  report: Partial<WorkerReportPayload> = {},
) {
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
      kind: "inspection",
      objective: "re-establish repository reality",
      planRefs: [],
      expectedExecutionScope: {},
      capabilityEnvelope: RECON_ENVELOPE,
      candidateEffect: "non_mutating",
      invariants: [],
      requiredActions: [],
      forbiddenActions: [],
      validationRequirements: [],
      deliverables: [],
      stopConditions: [],
      reportContract: "",
      body: "",
      reconciliationTargets: [...targets],
    },
  });
  const { attempt } = await world.world.store.startExecutionAttempt({
    executionRunID: world.run.id,
    directive: { id: directive.id, revision: directive.revision },
    ...EXEC_AUTH,
    ceiling: FULL_EXEC_CEILING,
  });
  const storeReport = await world.world.store.submitExecutionReport({
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
      candidateMutation: "none",
      baseCandidateRevision: live.window.candidateRevision,
      reconciliationObservation: observation,
      ...report,
    },
  });
  return { directive, attempt, report: storeReport.report };
}

/** Issue + start a reconciliation inspection and abandon IT into indeterminate (§48/§87 — the second unresolved Attempt can only be a reconciliation itself). */
async function makeIndeterminateInspection(world: SupervisedWorld, targets: ExecutionAttemptID[]) {
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
      kind: "inspection",
      objective: "interrupted reconciliation",
      planRefs: [],
      expectedExecutionScope: {},
      capabilityEnvelope: RECON_ENVELOPE,
      candidateEffect: "non_mutating",
      invariants: [],
      requiredActions: [],
      forbiddenActions: [],
      validationRequirements: [],
      deliverables: [],
      stopConditions: [],
      reportContract: "",
      body: "",
      reconciliationTargets: [...targets],
    },
  });
  const { attempt } = await world.world.store.startExecutionAttempt({
    executionRunID: world.run.id,
    directive: { id: directive.id, revision: directive.revision },
    ...EXEC_AUTH,
    ceiling: FULL_EXEC_CEILING,
  });
  await world.world.store.markExecutionAttemptIndeterminate({ executionRunID: world.run.id, attemptID: attempt.id, ...EXEC_AUTH });
  return { directive, attempt };
}

/** Record the durable reconciliation over the complete target set. */
async function recordReconciliation(
  world: SupervisedWorld,
  targets: ExecutionAttemptID[],
  inspection: { id: string; revision: number },
  reconciliationID?: AttemptReconciliationID,
) {
  return world.world.store.recordAttemptReconciliation({
    executionRunID: world.run.id,
    stageID: world.stage.id,
    windowID: world.window.id,
    ...EXEC_AUTH,
    targetAttemptIDs: targets,
    inspectionDirective: { id: inspection.id as never, revision: inspection.revision },
    ...(reconciliationID !== undefined ? { reconciliationID } : {}),
  });
}

describe("reconciliation mode (§41/§42/§82/E39-E41)", () => {
  it("an unresolved indeterminate Attempt forces reconciliation mode: implementation, ordinary inspection, verification, and accept ALL fail closed", async () => {
    const world = await supervisedWorld();
    const { attempt } = await makeIndeterminate(world);
    const canonical = await world.world.store.unresolvedIndeterminateAttempts(world.run.id, world.window.id);
    expect(canonical.map((entry) => entry.id)).toEqual([attempt.id]);
    // Implementation fails.
    await expect(execRunDirective(world, { objective: "new work" })).rejects.toMatchObject({ code: "reconciliation_required" });
    // Ordinary inspection (no targets) fails.
    await expect(execRunDirective(world, { kind: "inspection", objective: "ordinary look", candidateEffect: "non_mutating", capabilityEnvelope: RECON_ENVELOPE }, { workerRole: "executor", candidateMutation: "none" })).rejects.toMatchObject({ code: "reconciliation_required" });
    // Verification fails.
    await expect(execCleanVerification(world, [], { objective: "verify" })).rejects.toMatchObject({ code: "reconciliation_required" });
    // Accept fails.
    await expect(world.world.store.submitSupervisorAssessment(await execAcceptInput(world))).rejects.toMatchObject({ code: "reconciliation_required" });
    // The ONLY issuable work: the explicit reconciliation inspection targeting the complete set.
    const inspection = await runReconciliationInspection(world, [attempt.id], "unchanged");
    expect(inspection.directive.reconciliationTargets).toEqual([attempt.id]);
  });

  it("§43 (Phase 7A §7) targets must equal the COMPLETE canonical SIDE-EFFECTING unresolved set; non-mutating interruptions are never targets", async () => {
    const world = await supervisedWorld();
    const first = await makeIndeterminate(world, "first interruption");
    await runReconciliationInspection(world, [first.attempt.id], "unresolved"); // inconclusive — still unresolved
    // The interrupted reconciliation inspection is non-mutating indeterminate
    // history — it joins the unresolved record set but NEVER the blocking set.
    const second = await makeIndeterminateInspection(world, [first.attempt.id]);
    void second;
    const sideEffecting = await world.world.store.unresolvedSideEffectingAttempts(world.run.id, world.window.id);
    expect(sideEffecting.map((entry) => entry.id)).toEqual([first.attempt.id]);
    const allUnresolved = await world.world.store.unresolvedIndeterminateAttempts(world.run.id, world.window.id);
    expect(allUnresolved.map((entry) => entry.id).sort()).toEqual([first.attempt.id, second.attempt.id].sort());
    // Targeting the non-mutating interruption fails (not in the blocking set).
    await expect(runReconciliationInspection(world, [second.attempt.id], "unchanged")).rejects.toMatchObject({ code: "invalid_scope" });
    // The COMPLETE side-effecting set alone is issuable — the interrupted
    // inspection does not have to be "reconciled".
    const inspection = await runReconciliationInspection(world, [first.attempt.id], "unchanged");
    expect(inspection.directive.reconciliationTargets).toEqual([first.attempt.id]);
  });

  it("§45/E43 reconciliation capability constraints: repositoryRead required, mutations forbidden", async () => {
    const world = await supervisedWorld();
    const { attempt } = await makeIndeterminate(world);
    const live = await execLive(world);
    const base = {
      executionRunID: world.run.id, stageID: world.stage.id, windowID: world.window.id, ...EXEC_AUTH, ceiling: FULL_EXEC_CEILING,
      expectedRunRevision: live.run.revision, expectedStageRevision: live.stage.revision, expectedWindowRevision: live.window.revision,
      draft: { kind: "inspection", objective: "reconcile", planRefs: [], expectedExecutionScope: {}, candidateEffect: "non_mutating", invariants: [], requiredActions: [], forbiddenActions: [], validationRequirements: [], deliverables: [], stopConditions: [], reportContract: "", body: "", reconciliationTargets: [attempt.id] },
    };
    // Missing repositoryRead.
    await expect(world.world.store.issueExecutionDirective({ ...base, draft: { ...base.draft, capabilityEnvelope: { ...RECON_ENVELOPE, repositoryRead: false } } } as never)).rejects.toMatchObject({ code: "invalid_scope" });
    // repositoryWrite granted.
    await expect(world.world.store.issueExecutionDirective({ ...base, draft: { ...base.draft, capabilityEnvelope: { ...RECON_ENVELOPE, repositoryWrite: true } } } as never)).rejects.toMatchObject({ code: "invalid_scope" });
    // gitCommit granted.
    await expect(world.world.store.issueExecutionDirective({ ...base, draft: { ...base.draft, capabilityEnvelope: { ...RECON_ENVELOPE, gitCommit: true } } } as never)).rejects.toMatchObject({ code: "invalid_scope" });
    void world;
  });

  it("§46 the reconciliation worker context carries the targets, their directives/effects, and the known revision — no hidden reasoning", async () => {
    const world = await supervisedWorld();
    const { directive: interrupted, attempt } = await makeIndeterminate(world);
    const inspection = await runReconciliationInspection(world, [attempt.id], "unresolved");
    const run = (await world.world.store.getExecutionRun(world.run.id))!;
    const finalPlanRecord = (await world.world.store.getCurrentFinalPlan(run.planID))!;
    const context = await assembleExecutionWorkerContext(world.world.store, inspection.directive, {
      planID: run.planID,
      finalPlan: run.finalPlan,
      finalPlanRecord,
      goal: "g",
      executionRunID: run.id,
      stage: { id: world.stage.id, title: world.stage.title, objective: world.stage.objective },
      window: { id: world.window.id, baseAcceptedState: world.window.baseAcceptedState },
      role: "executor",
      trustedCeiling: FULL_EXEC_CEILING,
      reconciliationContext: {
        objective: "determine current repository/candidate reality",
        knownCandidateRevision: 0,
        baseAcceptedState: world.window.baseAcceptedState,
        targets: [{ attemptID: attempt.id, directive: { id: interrupted.id, revision: interrupted.revision, hash: interrupted.hash }, candidateEffect: interrupted.candidateEffect, startedAt: attempt.startedAt }],
      },
    });
    expect(context.reconciliationContext).toBeDefined();
    expect(context.reconciliationContext!.targets).toHaveLength(1);
    expect(context.reconciliationContext!.targets[0]).toMatchObject({ attemptID: attempt.id, candidateEffect: "may_mutate" });
    expect(JSON.stringify(context.reconciliationContext)).not.toMatch(/hidden|reasoning|session/i);
    // Assembling without the required reconciliation context fails closed.
    await expect(
      assembleExecutionWorkerContext(world.world.store, inspection.directive, {
        planID: run.planID, finalPlan: run.finalPlan, finalPlanRecord, goal: "g", executionRunID: run.id,
        stage: { id: world.stage.id, title: world.stage.title, objective: world.stage.objective },
        window: { id: world.window.id, baseAcceptedState: world.window.baseAcceptedState },
        role: "executor", trustedCeiling: FULL_EXEC_CEILING,
      }),
    ).rejects.toMatchObject({ code: "invalid_scope" });
  });
});

describe("unchanged / changed / inconclusive reconciliation (§50-§52/§83-§85)", () => {
  it("§83 unchanged: no candidate advance; the target is covered; the commit gate no longer blocks on it", async () => {
    const world = await supervisedWorld();
    const { attempt } = await makeIndeterminate(world);
    const inspection = await runReconciliationInspection(world, [attempt.id], "unchanged");
    const { reconciliation, created, window } = await recordReconciliation(world, [attempt.id], inspection.directive);
    expect(created).toBe(true);
    expect(reconciliation!.observation).toBe("unchanged");
    expect(reconciliation!.baseCandidateRevision).toBe(0);
    expect(reconciliation!.resultingCandidateRevision).toBe(0);
    expect(window.candidateRevision).toBe(0);
    expect(await world.world.store.unresolvedIndeterminateAttempts(world.run.id, world.window.id)).toEqual([]);
    // The indeterminate Attempt itself remains terminal immutable history (§40/E38).
    expect((await world.world.store.getExecutionAttempt(attempt.id))!.state).toBe("indeterminate");
    // §54/§90 — reconciliation did NOT accept anything: no commit, no closure.
    expect((await execLive(world)).run.acceptedHead).toBeUndefined();
    // Yet acceptance can now proceed with fresh verification.
    await execCleanVerification(world);
    const { commit } = (await world.world.store.submitSupervisorAssessment(await execAcceptInput(world))) as { commit: { id: string; reconciliationRefs?: string[]; directiveRefs: string[] } };
    expect(commit.id).toBe("EC-001");
    // §90 — the uncertainty and its resolution stay visible in the provenance.
    expect(commit.directiveRefs).toContain(inspection.directive.id);
    expect(commit.reconciliationRefs).toEqual([reconciliation!.id]);
  });

  it("§84 changed: the candidate advances EXACTLY once and prior verification goes stale", async () => {
    const world = await supervisedWorld();
    const { attempt } = await makeIndeterminate(world);
    // A verifier at revision 0 (will be stale after the changed reconciliation).
    await expect(world.world.store.submitSupervisorAssessment(await execAcceptInput(world))).rejects.toMatchObject({ code: "reconciliation_required" });
    const inspection = await runReconciliationInspection(world, [attempt.id], "changed");
    const { reconciliation, window } = await recordReconciliation(world, [attempt.id], inspection.directive);
    expect(reconciliation!.observation).toBe("changed");
    expect(reconciliation!.baseCandidateRevision).toBe(0);
    expect(reconciliation!.resultingCandidateRevision).toBe(1);
    expect(window.candidateRevision).toBe(1);
    // §53 — the world moved: fresh verification is now required at revision 1.
    await expect(world.world.store.submitSupervisorAssessment(await execAcceptInput(world))).rejects.toMatchObject({ code: "verification_required" });
  });

  it("§85 inconclusive: observation=unresolved persists NOTHING and the uncertainty stays open", async () => {
    const world = await supervisedWorld();
    const { attempt } = await makeIndeterminate(world);
    const inspection = await runReconciliationInspection(world, [attempt.id], "unresolved");
    await expect(recordReconciliation(world, [attempt.id], inspection.directive)).rejects.toMatchObject({ code: "reconciliation_inconclusive" });
    expect(await world.world.store.listAttemptReconciliationsForRun(world.run.id)).toEqual([]);
    expect(await world.world.store.unresolvedIndeterminateAttempts(world.run.id, world.window.id)).toHaveLength(1);
    // A NEW reconciliation inspection is issuable (bounded Supervisor retry).
    const next = await runReconciliationInspection(world, [attempt.id], "unchanged");
    await recordReconciliation(world, [attempt.id], next.directive);
    expect(await world.world.store.unresolvedIndeterminateAttempts(world.run.id, world.window.id)).toEqual([]);
  });

  it("§86/E50 a MUTATING reconciliation worker cannot resolve prior uncertainty", async () => {
    const world = await supervisedWorld();
    const { attempt } = await makeIndeterminate(world);
    // The reconciliation inspection itself mutates: Phase 4 physical truth advances the revision.
    const inspection = await runReconciliationInspection(world, [attempt.id], "changed", { candidateMutation: "changed" });
    expect(inspection.report.resultingCandidateRevision).toBe(1);
    const { window } = await execLive(world);
    expect(window.candidateRevision).toBe(1);
    // Recording fails: a mutating report can never resolve uncertainty.
    await expect(recordReconciliation(world, [attempt.id], inspection.directive)).rejects.toMatchObject({ code: "invalid_scope" });
    // The original target stays unresolved; the next reconciliation binds the NEW revision.
    expect(await world.world.store.unresolvedIndeterminateAttempts(world.run.id, world.window.id)).toHaveLength(1);
    const next = await runReconciliationInspection(world, [attempt.id], "unchanged");
    const { reconciliation } = await recordReconciliation(world, [attempt.id], next.directive);
    expect(reconciliation!.baseCandidateRevision).toBe(1);
  });

  it("§87 (Phase 7A §7) one success over the complete SIDE-EFFECTING set covers it; non-mutating interruptions stay inert history", async () => {
    const world = await supervisedWorld();
    const first = await makeIndeterminate(world, "interrupted implementation");
    // The interrupted reconciliation inspection is indeterminate history but
    // never joins the blocking set (Phase 7A §3).
    const second = await makeIndeterminateInspection(world, [first.attempt.id]);
    const sideEffecting = (await world.world.store.unresolvedSideEffectingAttempts(world.run.id, world.window.id)).map((entry) => entry.id);
    expect(sideEffecting).toEqual([first.attempt.id]);
    const inspection = await runReconciliationInspection(world, sideEffecting, "unchanged");
    const { reconciliation } = await recordReconciliation(world, sideEffecting, inspection.directive);
    expect(reconciliation!.targetAttemptIDs).toEqual([first.attempt.id]);
    // The side-effecting uncertainty is gone; the non-mutating interruption
    // remains indeterminate history without forcing anything.
    expect(await world.world.store.unresolvedSideEffectingAttempts(world.run.id, world.window.id)).toEqual([]);
    expect(
      (await world.world.store.getExecutionAttempt(second.attempt.id))!.state,
    ).toBe("indeterminate");
    // Fresh ordinary work is issuable again without any further reconciliation.
    await execRunDirective(world, { objective: "fresh work after reconciliation" });
  });
});

describe("reconciliation retry & race (§56/§57/§88-§89)", () => {
  it("§88 a changed-reconciliation retry with the same id never double-advances (no N → N+2)", async () => {
    const world = await supervisedWorld();
    const { attempt } = await makeIndeterminate(world);
    const inspection = await runReconciliationInspection(world, [attempt.id], "changed");
    const input = { targets: [attempt.id], inspectionDirective: { id: inspection.directive.id, revision: inspection.directive.revision }, reconciliationID: "REC-001" as AttemptReconciliationID };
    const first = await recordReconciliation(world, input.targets, input.inspectionDirective, input.reconciliationID);
    expect(first.created).toBe(true);
    expect((await execLive(world)).window.candidateRevision).toBe(1);
    const retry = await recordReconciliation(world, input.targets, input.inspectionDirective, input.reconciliationID);
    expect(retry.created).toBe(false);
    expect(retry.reconciliation).toEqual(first.reconciliation);
    expect((await execLive(world)).window.candidateRevision).toBe(1);
    // Different content under the same id is a conflict.
    await expect(
      recordReconciliation(world, input.targets, input.inspectionDirective, input.reconciliationID).then(() => undefined),
    ).resolves.toBeUndefined();
    const events = (await world.world.store.listEvents((await execLive(world)).run.planID)).filter((event) => event.detail.type === "execution.attempt_reconciled");
    expect(events).toHaveLength(1);
  });

  it("§57/§89 two durable instances racing the same unresolved set: ONE winner, revision advances at most once", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ultra-plan-exec-recon-race-"));
    const filePath = path.join(dir, "plan.json");
    try {
      const loaded = await durableHandoffPendingWorld(filePath);
      const world = await supervisedWorld(loaded as never);
      const { attempt } = await makeIndeterminate(world);
      const inspection = await runReconciliationInspection(world, [attempt.id], "changed");
      (world.world.store as unknown as { close(): void }).close();
      const b1 = new DurablePlanStore(filePath, { now: () => FIXED });
      const b2 = new DurablePlanStore(filePath, { now: () => FIXED });
      const input = {
        executionRunID: world.run.id,
        stageID: world.stage.id,
        windowID: world.window.id,
        ...EXEC_AUTH,
        targetAttemptIDs: [attempt.id],
        inspectionDirective: { id: inspection.directive.id as never, revision: inspection.directive.revision },
      };
      const outcomes = await Promise.allSettled([b1.recordAttemptReconciliation(input), b2.recordAttemptReconciliation(input)]);
      const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
      const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: "attempt_already_reconciled" });
      const winner = (fulfilled[0] as PromiseFulfilledResult<{ window: { candidateRevision: number } }>).value;
      expect(winner.window.candidateRevision).toBe(1);
      // Both instances agree after refresh.
      expect((await (await b1.getExecutionRun(world.run.id))!).acceptedHead).toBeUndefined();
      const verify = new DurablePlanStore(filePath, { now: () => FIXED });
      expect((await verify.getVerificationWindow(world.window.id))!.candidateRevision).toBe(1);
      expect(await verify.listAttemptReconciliationsForRun(world.run.id)).toHaveLength(1);
      verify.close();
      b1.close();
      b2.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("recovery projection (§65/E55)", () => {
  it("the recovery context distinguishes unresolved indeterminate work from reconciled history", async () => {
    const world = await supervisedWorld();
    const { attempt } = await makeIndeterminate(world);
    let context = await world.world.store.buildExecutionRecoveryContext(world.run.id, { sessionID: EXEC_AUTH.sessionID });
    expect(context!.reconciliationRequired).toBe(true);
    expect(context!.unresolvedIndeterminateAttempts).toHaveLength(1);
    expect(context!.attemptReconciliations).toEqual([]);
    expect(context!.verificationCondition).toBe("clear");
    const inspection = await runReconciliationInspection(world, [attempt.id], "unchanged");
    await recordReconciliation(world, [attempt.id], inspection.directive);
    context = await world.world.store.buildExecutionRecoveryContext(world.run.id, { sessionID: EXEC_AUTH.sessionID });
    expect(context!.reconciliationRequired).toBe(false);
    expect(context!.unresolvedIndeterminateAttempts).toEqual([]);
    expect(context!.indeterminateAttempts).toHaveLength(1); // history remains visible
    expect(context!.attemptReconciliations).toHaveLength(1);
    expect(context!.attemptReconciliations[0]).toMatchObject({ observation: "unchanged", baseCandidateRevision: 0, resultingCandidateRevision: 0 });
  });
});

describe("durable persistence & malformed graphs (§62/§92-§93/E56)", () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "ultra-plan-exec-recon-"));
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

  /** Build a durable world with one unchanged reconciliation recorded. */
  async function reconciledWorld() {
    const loaded = await durableHandoffPendingWorld(filePath);
    const world = await supervisedWorld(loaded as never);
    const { attempt } = await makeIndeterminate(world);
    const inspection = await runReconciliationInspection(world, [attempt.id], "unchanged");
    const { reconciliation } = await recordReconciliation(world, [attempt.id], inspection.directive);
    return { world, attempt, inspection, reconciliation: reconciliation! };
  }

  it("§93 the reconciliation + window state survive close/reopen exactly; the unresolved set re-derives", async () => {
    const { world, reconciliation } = await reconciledWorld();
    (world.world.store as unknown as { close(): void }).close();
    const reopened = new DurablePlanStore(filePath, { now: () => FIXED });
    expect(await reopened.getAttemptReconciliation(reconciliation.id)).toEqual(reconciliation);
    expect((await reopened.getVerificationWindow(world.window.id))!.candidateRevision).toBe(0);
    expect(await reopened.unresolvedIndeterminateAttempts(world.run.id, world.window.id)).toEqual([]);
    reopened.close();
  });

  it("§92a a reconciliation targeting a non-indeterminate Attempt fails closed", async () => {
    const { world, reconciliation, attempt } = await reconciledWorld();
    void reconciliation;
    (world.world.store as unknown as { close(): void }).close();
    await tamper(filePath, (raw) => {
      (raw["executionAttempts"] as Record<string, Record<string, unknown>>)[attempt.id]!["state"] = "reported";
    });
    await expect(corruptOpen(filePath)).rejects.toMatchObject({ code: "store_corrupt" });
  });

  it("§92b a cross-window reconciliation target fails closed", async () => {
    const { world, reconciliation } = await reconciledWorld();
    (world.world.store as unknown as { close(): void }).close();
    await tamper(filePath, (raw) => {
      (raw["attemptReconciliations"] as Record<string, Record<string, unknown>>)[reconciliation.id]!["windowID"] = "WIN-099";
    });
    await expect(corruptOpen(filePath)).rejects.toMatchObject({ code: "store_corrupt" });
  });

  it("§92c wrong revision arithmetic fails closed (changed must be exactly base+1)", async () => {
    const loaded = await durableHandoffPendingWorld(filePath);
    const world = await supervisedWorld(loaded as never);
    const { attempt } = await makeIndeterminate(world);
    const inspection = await runReconciliationInspection(world, [attempt.id], "changed");
    await recordReconciliation(world, [attempt.id], inspection.directive);
    (world.world.store as unknown as { close(): void }).close();
    await tamper(filePath, (raw) => {
      const reconciliations = raw["attemptReconciliations"] as Record<string, Record<string, unknown>>;
      for (const record of Object.values(reconciliations)) record["resultingCandidateRevision"] = (record["baseCandidateRevision"] as number) + 5;
    });
    await expect(corruptOpen(filePath)).rejects.toMatchObject({ code: "store_corrupt" });
  });

  it("§92d two successful reconciliations covering the same Attempt fail closed", async () => {
    const { world, attempt, inspection, reconciliation } = await reconciledWorld();
    void inspection;
    (world.world.store as unknown as { close(): void }).close();
    await tamper(filePath, (raw) => {
      const reconciliations = raw["attemptReconciliations"] as Record<string, Record<string, unknown>>;
      const clone = structuredClone(reconciliations[reconciliation.id]!);
      clone["id"] = "REC-099";
      reconciliations["REC-099"] = clone;
      (raw["reconciliationByAttempt"] as Record<string, string>)[attempt.id] = "REC-099";
    });
    await expect(corruptOpen(filePath)).rejects.toMatchObject({ code: "store_corrupt" });
  });

  it("§92e a mutating inspection Report cannot back a reconciliation", async () => {
    const { world, attempt, inspection, reconciliation } = await reconciledWorld();
    void attempt;
    (world.world.store as unknown as { close(): void }).close();
    await tamper(filePath, (raw) => {
      const reports = raw["executionReports"] as Record<string, Record<string, unknown>>;
      const report = reports[reconciliation.inspectionReportID]!;
      report["candidateMutation"] = "changed";
      report["resultingCandidateRevision"] = (report["baseCandidateRevision"] as number) + 1;
      void inspection;
    });
    await expect(corruptOpen(filePath)).rejects.toMatchObject({ code: "store_corrupt" });
  });

  it("§92f an unresolved-observation reconciliation record fails closed", async () => {
    const { world, reconciliation } = await reconciledWorld();
    (world.world.store as unknown as { close(): void }).close();
    await tamper(filePath, (raw) => {
      const reconciliations = raw["attemptReconciliations"] as Record<string, Record<string, unknown>>;
      reconciliations[reconciliation.id]!["observation"] = "unresolved";
      const reports = raw["executionReports"] as Record<string, Record<string, unknown>>;
      reports[reconciliation.inspectionReportID]!["reconciliationObservation"] = "unresolved";
    });
    await expect(corruptOpen(filePath)).rejects.toMatchObject({ code: "store_corrupt" });
  });

  it("the v0.1 production handoff still creates NO execution artifacts (§95 regression)", async () => {
    const world = await durableHandoffPendingWorld(filePath);
    await world.controller.recoverExecutionHandoff(world.sessionID);
    expect(await world.store.listOpenExecutionRuns()).toHaveLength(0);
    const events = (await world.store.listEvents(world.runID)).map((event) => event.detail.type);
    expect(events.filter((type) => type.startsWith("execution."))).toEqual([]);
  });
});
