/**
 * v0.2.0 Phase 7A P0 — indeterminate scope correction (directive §2-§8).
 *
 * The frozen architecture distinguishes a SIDE-EFFECTING indeterminate Attempt
 * (repository reality uncertain → reconciliation required) from a NON-MUTATING
 * interrupted Attempt (no usable Report, repository untouched → a fresh
 * Directive may replace the lost work). Phase 6A over-conservatively forced
 * reconciliation mode for EVERY indeterminate Attempt; these tests pin the
 * corrected projections (§3), the reconciliation-mode trigger (§4), the
 * non-mutating recovery path (§5), the commit-gate correction (§6), and the
 * side-effecting-only reconciliation target set (§7).
 */
import { describe, expect, it } from "vitest";

import type { ExecutionAttemptID } from "../src/index.js";
import {
  EXEC_AUTH,
  execAcceptInput,
  execCleanVerification,
  execLive,
  execRunDirective,
  FULL_EXEC_CEILING,
  supervisedWorld,
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

/** Issue + start + abandon a NON-MUTATING verification Attempt (interrupted verifier). */
async function makeNonMutatingVerificationIndeterminate(world: SupervisedWorld, objective = "interrupted verification") {
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
      kind: "verification",
      objective,
      planRefs: [],
      expectedExecutionScope: {},
      capabilityEnvelope: { ...FULL_EXEC_CEILING, repositoryWrite: false },
      candidateEffect: "non_mutating",
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

/** Issue + start + abandon a MAY_MUTATE implementation Attempt (interrupted side-effecting work). */
async function makeSideEffectingIndeterminate(world: SupervisedWorld, objective = "interrupted implementation") {
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

describe("non-mutating interruption never forces reconciliation (§5/§39/E3-E5)", () => {
  it("§8a an interrupted non-mutating verifier leaves reconciliationRequired false, the candidateRevision unchanged, and fresh verification issuable; a fresh clean verifier satisfies acceptance", async () => {
    const world = await supervisedWorld();
    const before = await execLive(world);
    expect(before.window.candidateRevision).toBe(0);

    const { attempt } = await makeNonMutatingVerificationIndeterminate(world);

    // §3 — the interrupted verifier is inert history in BOTH projections.
    expect(await world.world.store.unresolvedSideEffectingAttempts(world.run.id, world.window.id)).toEqual([]);
    const recovery = (await world.world.store.buildExecutionRecoveryContext(world.run.id, { sessionID: EXEC_AUTH.sessionID }))!;
    expect(recovery.reconciliationRequired).toBe(false);
    expect(recovery.unresolvedSideEffectingAttempts).toHaveLength(0);
    expect(recovery.nonMutatingInterruptedAttempts.map((entry) => entry.id)).toEqual([attempt.id]);
    expect(recovery.unresolvedIndeterminateAttempts.map((entry) => entry.id)).toEqual([attempt.id]);

    // §5 — a fresh verification Directive is issuable (no reconciliation mode).
    const fresh = await execCleanVerification(world);

    // §5 — the old Attempt remains terminal immutable indeterminate history;
    // the consumed revision can never be replayed.
    expect((await world.world.store.getExecutionAttempt(attempt.id))!.state).toBe("indeterminate");

    // §6/§39 — the candidate never moved: the interruption advanced nothing.
    const after = await execLive(world);
    expect(after.window.candidateRevision).toBe(0);

    // §6/§40/§41 — the fresh qualifying verifier satisfies acceptance; the
    // historical non-mutating interruption does not block the commit.
    const { commit } = (await world.world.store.submitSupervisorAssessment(await execAcceptInput(world))) as {
      commit: { id: string };
    };
    expect(commit.id).toBe("EC-001");
    void fresh;
  });

  it("§8a' the interrupted verifier's Directive revision stays consumed — replaying it fails closed", async () => {
    const world = await supervisedWorld();
    const { directive } = await makeNonMutatingVerificationIndeterminate(world);
    // 1 Directive revision → at most 1 logical Attempt (Phase 4 invariant),
    // even when the Attempt ended without a Report.
    await expect(
      world.world.store.startExecutionAttempt({
        executionRunID: world.run.id,
        directive: { id: directive.id, revision: directive.revision },
        ...EXEC_AUTH,
        ceiling: FULL_EXEC_CEILING,
      }),
    ).rejects.toMatchObject({ code: "attempt_already_consumed" });
  });
});

describe("side-effecting interruption still forces reconciliation (§38/E39/E2)", () => {
  it("§8b an interrupted may_mutate implementation Attempt sets reconciliationRequired, blocks ordinary execution, and demands the reconciliation inspection", async () => {
    const world = await supervisedWorld();
    const { attempt } = await makeSideEffectingIndeterminate(world);

    expect((await world.world.store.unresolvedSideEffectingAttempts(world.run.id, world.window.id)).map((entry) => entry.id)).toEqual([attempt.id]);
    const recovery = (await world.world.store.buildExecutionRecoveryContext(world.run.id, { sessionID: EXEC_AUTH.sessionID }))!;
    expect(recovery.reconciliationRequired).toBe(true);
    expect(recovery.unresolvedSideEffectingAttempts.map((entry) => entry.id)).toEqual([attempt.id]);
    expect(recovery.nonMutatingInterruptedAttempts).toHaveLength(0);

    // Ordinary execution and verification are blocked (§42 reconciliation mode).
    await expect(execRunDirective(world, { objective: "new work" })).rejects.toMatchObject({ code: "reconciliation_required" });
    await expect(execCleanVerification(world, [], { objective: "verify" })).rejects.toMatchObject({ code: "reconciliation_required" });

    // The ONLY issuable work: the reconciliation inspection over the exact set.
    const live = await execLive(world);
    const inspection = await world.world.store.issueExecutionDirective({
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
        reconciliationTargets: [attempt.id],
      },
    });
    expect(inspection.reconciliationTargets).toEqual([attempt.id]);
    void inspection;
  });

  it("§8c a plain reconciliation-inspection-shaped Directive cannot smuggle ordinary work past the mode (targets must equal the side-effecting set)", async () => {
    const world = await supervisedWorld();
    const { attempt } = await makeSideEffectingIndeterminate(world);
    const live = await execLive(world);
    const base = {
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
        objective: "reconcile",
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
      },
    };
    // Partial target set (empty) fails.
    await expect(
      world.world.store.issueExecutionDirective({ ...base, draft: { ...base.draft, reconciliationTargets: [] } } as never),
    ).rejects.toMatchObject({ code: "invalid_scope" });
    // Unknown target fails.
    await expect(
      world.world.store.issueExecutionDirective({
        ...base,
        draft: { ...base.draft, reconciliationTargets: ["ATT-999" as ExecutionAttemptID] },
      } as never),
    ).rejects.toMatchObject({ code: "invalid_scope" });
    // The complete side-effecting set is accepted.
    const inspection = await world.world.store.issueExecutionDirective({
      ...base,
      draft: { ...base.draft, reconciliationTargets: [attempt.id] },
    } as never);
    expect(inspection.reconciliationTargets).toEqual([attempt.id]);
  });
});

describe("mixed effects: only the side-effecting set gates and targets (§4/§7)", () => {
  it("§8d with BOTH kinds unresolved, reconciliation mode is on and the inspection targets ONLY the side-effecting Attempt", async () => {
    const world = await supervisedWorld();
    // Protocol-reachable mixed history: the non-mutating interruption happens
    // FIRST (it never gates anything — §8a), then the side-effecting one.
    const nonMutating = await makeNonMutatingVerificationIndeterminate(world, "interrupted verification");
    const sideEffecting = await makeSideEffectingIndeterminate(world, "interrupted implementation");

    const recovery = (await world.world.store.buildExecutionRecoveryContext(world.run.id, { sessionID: EXEC_AUTH.sessionID }))!;
    expect(recovery.reconciliationRequired).toBe(true);
    expect(recovery.unresolvedSideEffectingAttempts.map((entry) => entry.id)).toEqual([sideEffecting.attempt.id]);
    expect(recovery.nonMutatingInterruptedAttempts.map((entry) => entry.id)).toEqual([nonMutating.attempt.id]);

    // Fresh verification is still blocked — the side-effecting uncertainty gates the window.
    await expect(execCleanVerification(world, [], { objective: "verify" })).rejects.toMatchObject({ code: "reconciliation_required" });

    // The reconciliation inspection must target EXACTLY the side-effecting set.
    const live = await execLive(world);
    const inspection = await world.world.store.issueExecutionDirective({
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
        reconciliationTargets: [sideEffecting.attempt.id],
      },
    });
    expect(inspection.reconciliationTargets).toEqual([sideEffecting.attempt.id]);
  });
});
