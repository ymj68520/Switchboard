/**
 * v0.2.0 Phase 6A Part A — REPLAN_REQUIRED & ExecutionIssue.
 *
 * Covers the Phase 6A directive gates: the durable immutable ExecutionIssue
 * (§5/E1) as execution input — never Plan Memory (§6/E2), the request_replan
 * source-assessment requirement with exact current-candidate binding (§7/E3),
 * exact FinalPlan-reachable affected refs (§8/E5), accepted-history +
 * unaccepted-context capture (§9/§10/E6-E7), the atomic issue+transition
 * transaction with idempotent retry (§11/§17/E8/E15), terminal semantics
 * without rebind (§13/E9-E10), preserved execution structure and workspace
 * (§14/E11-E12), no automatic PlanningRun (§2/§15/E13), the read-only Replan
 * Context projection (§15/§16/§66/E14), malformed-graph fail-closed loads
 * (§59/§60/§92/E56), backward compatibility (§91/E62), durable reopen (§93),
 * and the recovery-context replan facts (§65/E55).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DurablePlanStore,
  computeExecutionIssueHash,
  computeSupervisorAssessmentHashFromRecord,
  executionIssueHashPayload,
  type ExecutionIssueID,
  type SupervisorAssessmentID,
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
  type HandoffPendingWorld,
  type SupervisedWorld,
} from "./execution-world.js";

/** A supervised world whose current candidate carries a request_replan judgment. */
async function replanReadyWorld(loaded?: HandoffPendingWorld): Promise<SupervisedWorld> {
  const world = await supervisedWorld(loaded);
  await execRunDirective(world, {});
  await world.world.store.submitSupervisorAssessment(
    (await execAcceptInput(world, { disposition: "request_replan", rationale: "the approved design cannot deliver obligation 1" })) as never,
  );
  return world;
}

/** The canonical replan transition input for a world (live CAS + source assessment). */
async function replanInput(world: SupervisedWorld, overrides: Record<string, unknown> = {}) {
  const { run, window } = await execLive(world);
  const assessments = await world.world.store.listSupervisorAssessmentsForRun(world.run.id);
  // The source judgment must bind the CURRENT window+candidate (§7).
  const source = assessments.find(
    (assessment) => assessment.disposition === "request_replan" && assessment.windowID === window.id && assessment.candidateRevision === window.candidateRevision,
  )!;
  return {
    executionRunID: world.run.id,
    ...EXEC_AUTH,
    sourceAssessmentID: source.id as SupervisorAssessmentID,
    reason: "normative authority exhausted",
    affectedPlanRefs: [{ kind: "implementation_step" as const, order: 1 }],
    expectedRunRevision: run.revision,
    ...overrides,
  };
}

async function planEvents(world: SupervisedWorld, type: string) {
  const run = (await world.world.store.getExecutionRun(world.run.id))!;
  return (await world.world.store.listEvents(run.planID)).filter((event) => event.detail.type === type);
}

/** `open()` throws synchronously on a corrupt document — wrap for rejects(). */
function corruptOpen(filePath: string): Promise<unknown> {
  try {
    new DurablePlanStore(filePath, { now: () => FIXED }).open();
    return Promise.reject(new Error("expected store_corrupt at open"));
  } catch (error) {
    return Promise.reject(error);
  }
}

describe("REPLAN_REQUIRED atomic transaction (§11/§69/E8)", () => {
  it("issue persistence + active → replan_required are ONE transaction; context refs preserved (§5/§9/§10/E1/E6-E7)", async () => {
    const world = await replanReadyWorld();
    // Accepted history first: one commit, then re-escalate on the fresh window.
    await execCleanVerification(world);
    const { commit } = (await world.world.store.submitSupervisorAssessment(await execAcceptInput(world))) as { commit: { id: string } };
    expect(commit.id).toBe("EC-001");
    await execOpenNextWindow(world);
    await execRunDirective(world, { objective: "next-window work" });
    await world.world.store.submitSupervisorAssessment(
      (await execAcceptInput(world, { disposition: "request_replan", rationale: "second window proves the insufficiency" })) as never,
    );
    const { run, stage, window } = await execLive(world);
    const { issue, run: terminal, created } = await world.world.store.transitionExecutionRunToReplanRequired(await replanInput(world));
    expect(created).toBe(true);
    expect(terminal.lifecycle).toBe("replan_required");
    expect(terminal.revision).toBe(run.revision + 1);
    // §9 — accepted history capture.
    expect(issue.acceptedHead).toBe("EC-001");
    expect(issue.acceptedCommitRefs).toEqual(["EC-001"]);
    // §10 — unaccepted candidate context capture (frozen refs, not copies).
    expect(issue.activeStageID).toBe(stage.id);
    expect(issue.openWindowID).toBe(window.id);
    expect(issue.candidateRevision).toBe(window.candidateRevision);
    expect(issue.sourceAssessmentID).toBeDefined();
    expect(issue.finalPlanRef).toEqual({ id: world.run.finalPlan.id, revision: world.run.finalPlan.revision });
    // Exactly one issue, indexed by run.
    expect(await world.world.store.findExecutionIssueForRun(world.run.id)).toEqual(issue);
    // Audit events: issue_created + replan_required, exactly once each.
    expect(await planEvents(world, "execution.issue_created")).toHaveLength(1);
    expect(await planEvents(world, "execution.replan_required")).toHaveLength(1);
  });

  it("§70/E15 retry: same id + same content returns the SAME issue and terminal run with NO duplicate events", async () => {
    const world = await replanReadyWorld();
    const input = await replanInput(world, { issueID: "ISS-001" as ExecutionIssueID });
    const first = await world.world.store.transitionExecutionRunToReplanRequired(input);
    expect(first.created).toBe(true);
    const eventsBefore = (await planEvents(world, "execution.issue_created")).length + (await planEvents(world, "execution.replan_required")).length;
    const retry = await world.world.store.transitionExecutionRunToReplanRequired(input);
    expect(retry.created).toBe(false);
    expect(retry.issue).toEqual(first.issue);
    expect(retry.run).toEqual(first.run);
    expect(retry.run.lifecycle).toBe("replan_required");
    const eventsAfter = (await planEvents(world, "execution.issue_created")).length + (await planEvents(world, "execution.replan_required")).length;
    expect(eventsAfter).toBe(eventsBefore);
  });

  it("§70 same id + different payload fails execution_issue_conflict (never latest-wins)", async () => {
    const world = await replanReadyWorld();
    const input = await replanInput(world, { issueID: "ISS-001" as ExecutionIssueID });
    await world.world.store.transitionExecutionRunToReplanRequired(input);
    await expect(
      world.world.store.transitionExecutionRunToReplanRequired({ ...input, reason: "a DIFFERENT reason" }),
    ).rejects.toMatchObject({ code: "execution_issue_conflict" });
    expect((await execLive(world)).run.lifecycle).toBe("replan_required");
  });
});

describe("replan preconditions (§7/§12/E3-E4)", () => {
  it("no request_replan assessment → replan_assessment_required; an accept disposition does NOT authorize", async () => {
    const world = await supervisedWorld();
    await execRunDirective(world, {});
    const { run } = await execLive(world);
    await expect(
      world.world.store.transitionExecutionRunToReplanRequired({
        executionRunID: world.run.id,
        ...EXEC_AUTH,
        sourceAssessmentID: "SA-001" as SupervisorAssessmentID,
        reason: "r",
        affectedPlanRefs: [],
        expectedRunRevision: run.revision,
      }),
    ).rejects.toMatchObject({ code: "replan_assessment_required" });
    // An accept disposition closes the window and is NOT a replan judgment:
    // with no current-window request_replan assessment the transition refuses.
    await execCleanVerification(world);
    const accept = (await world.world.store.submitSupervisorAssessment(await execAcceptInput(world, { disposition: "accept" }))).assessment;
    await execOpenNextWindow(world);
    const live = await execLive(world);
    await expect(
      world.world.store.transitionExecutionRunToReplanRequired({
        executionRunID: world.run.id,
        ...EXEC_AUTH,
        sourceAssessmentID: accept.id as SupervisorAssessmentID,
        reason: "r",
        affectedPlanRefs: [],
        expectedRunRevision: live.run.revision,
      }),
    ).rejects.toMatchObject({ code: "replan_assessment_required" });
  });

  it("§71/E4 a request_replan assessment on an OLD candidate is stale — the run must NOT terminalize", async () => {
    const world = await replanReadyWorld();
    const staleAssessment = (await world.world.store.listSupervisorAssessmentsForRun(world.run.id)).find((a) => a.disposition === "request_replan")!;
    // Candidate mutates after the judgment.
    const liveBefore = await execLive(world);
    await world.world.store.advanceCandidateRevision({ executionRunID: world.run.id, ...EXEC_AUTH, expectedCandidateRevision: liveBefore.window.candidateRevision });
    const { run } = await execLive(world);
    await expect(
      world.world.store.transitionExecutionRunToReplanRequired({
        executionRunID: world.run.id,
        ...EXEC_AUTH,
        sourceAssessmentID: staleAssessment.id as SupervisorAssessmentID,
        reason: "r",
        affectedPlanRefs: [],
        expectedRunRevision: run.revision,
      }),
    ).rejects.toMatchObject({ code: "replan_assessment_stale" });
    expect((await execLive(world)).run.lifecycle).toBe("active");
    // Re-assessment at the CURRENT candidate authorizes the transition.
    await world.world.store.submitSupervisorAssessment(
      (await execAcceptInput(world, { disposition: "request_replan", rationale: "re-judged at revision 1" })) as never,
    );
    const { run: terminal } = await world.world.store.transitionExecutionRunToReplanRequired(await replanInput(world));
    expect(terminal.lifecycle).toBe("replan_required");
  });

  it("a running Attempt blocks the transition; an unresolved indeterminate Attempt does NOT (§12)", async () => {
    const world = await replanReadyWorld();
    const live = await execLive(world);
    const readOnly = { repositoryRead: true, repositoryWrite: false, commandExecution: false, networkAccess: false, dependencyMutation: false, gitCommit: false, gitPush: false, externalServiceMutation: false };
    const directive = await world.world.store.issueExecutionDirective({
      executionRunID: world.run.id, stageID: world.stage.id, windowID: world.window.id, ...EXEC_AUTH, ceiling: readOnly,
      expectedRunRevision: live.run.revision, expectedStageRevision: live.stage.revision, expectedWindowRevision: live.window.revision,
      draft: { kind: "inspection", objective: "look", planRefs: [], expectedExecutionScope: {}, capabilityEnvelope: readOnly, candidateEffect: "non_mutating", invariants: [], requiredActions: [], forbiddenActions: [], validationRequirements: [], deliverables: [], stopConditions: [], reportContract: "", body: "" },
    });
    await world.world.store.startExecutionAttempt({ executionRunID: world.run.id, directive: { id: directive.id, revision: directive.revision }, ...EXEC_AUTH, ceiling: readOnly });
    await expect(
      world.world.store.transitionExecutionRunToReplanRequired(await replanInput(world)),
    ).rejects.toMatchObject({ code: "active_attempt_conflict" });
    const running = (await world.world.store.findRunningExecutionAttempt(world.run.id))!;
    await world.world.store.markExecutionAttemptIndeterminate({ executionRunID: world.run.id, attemptID: running.id, ...EXEC_AUTH });
    const { issue } = await world.world.store.transitionExecutionRunToReplanRequired(await replanInput(world));
    expect(issue.unresolvedIndeterminateAttemptRefs).toEqual([running.id]);
  });

  it("§8/E5 invalid affectedPlanRefs fail exact FinalPlan resolution", async () => {
    const world = await replanReadyWorld();
    await expect(
      world.world.store.transitionExecutionRunToReplanRequired(await replanInput(world, { affectedPlanRefs: [{ kind: "implementation_step", order: 99 }] })),
    ).rejects.toMatchObject({ code: "invalid_scope" });
    expect((await execLive(world)).run.lifecycle).toBe("active");
  });
});

describe("terminal semantics & preserved history (§13/§14/§72/E9-E12)", () => {
  it("replan_required is terminal and the run is never rebound; ALL execution history stays exactly as-was", async () => {
    const world = await replanReadyWorld();
    await execCleanVerification(world);
    await world.world.store.submitSupervisorAssessment(await execAcceptInput(world)); // EC-001, window closed
    await execOpenNextWindow(world);
    await execRunDirective(world, { objective: "second window" });
    await world.world.store.submitSupervisorAssessment(
      (await execAcceptInput(world, { disposition: "request_replan", rationale: "escalate" })) as never,
    );
    const before = {
      live: await execLive(world),
      directives: await world.world.store.listExecutionDirectivesForRun(world.run.id),
      attempts: await world.world.store.listExecutionAttemptsForRun(world.run.id),
      reports: await world.world.store.listExecutionReportsForRun(world.run.id),
      assessments: await world.world.store.listSupervisorAssessmentsForRun(world.run.id),
      commits: await world.world.store.listExecutionCommitsForRun(world.run.id),
      binding: await world.world.store.findSupervisorBinding(world.run.id),
    };
    const { run: terminal } = await world.world.store.transitionExecutionRunToReplanRequired(await replanInput(world));
    // Terminal: no transition out.
    await expect(
      world.world.store.activateExecutionRun(world.run.id, { workspace: world.run.workspace, runRevision: terminal.revision, finalPlan: world.run.finalPlan }),
    ).rejects.toMatchObject({ code: "invalid_execution_lifecycle" });
    // §14 — structure/history preserved exactly (frozen refs stay).
    expect(terminal.acceptedHead).toBe("EC-001");
    expect(terminal.activeStage).toBe(before.live.stage.id);
    expect(terminal.openWindow).toBe(before.live.window.id);
    expect(await world.world.store.listExecutionDirectivesForRun(world.run.id)).toEqual(before.directives);
    expect(await world.world.store.listExecutionAttemptsForRun(world.run.id)).toEqual(before.attempts);
    expect(await world.world.store.listExecutionReportsForRun(world.run.id)).toEqual(before.reports);
    expect(await world.world.store.listSupervisorAssessmentsForRun(world.run.id)).toEqual(before.assessments);
    expect(await world.world.store.listExecutionCommitsForRun(world.run.id)).toEqual(before.commits);
    expect(await world.world.store.findSupervisorBinding(world.run.id)).toEqual(before.binding);
    // The window was NOT closed and the Stage was NOT completed.
    expect((await world.world.store.getVerificationWindow(before.live.window.id))!.state).toBe("open");
    expect((await world.world.store.getExecutionStage(world.stage.id))!.status).toBe("active");
  });

  it("§15/§E13 no automatic new PlanningRun: Plan Memory is untouched by the replan transition", async () => {
    const world = await replanReadyWorld();
    const run = (await world.world.store.getExecutionRun(world.run.id))!;
    const sectionsBefore = await world.world.store.listSections(run.planID);
    const decisionsBefore = await world.world.store.listDecisions(run.planID);
    await world.world.store.transitionExecutionRunToReplanRequired(await replanInput(world));
    expect(await world.world.store.listSections(run.planID)).toEqual(sectionsBefore);
    expect(await world.world.store.listDecisions(run.planID)).toEqual(decisionsBefore);
    expect(await planEvents(world, "execution.replan_required")).toHaveLength(1);
  });

  it("the bare replan primitive no longer exists — the gated transaction is the ONLY path (§7/E9)", async () => {
    const world = await supervisedWorld();
    const storeShape = Object.getOwnPropertyNames(Object.getPrototypeOf(world.world.store) as Record<string, unknown>);
    expect(storeShape).not.toContain("markExecutionRunReplanRequired");
    expect(storeShape).toContain("transitionExecutionRunToReplanRequired");
  });
});

describe("Replan Context projection (§15/§16/§66/E14)", () => {
  it("projects issue + exact FinalPlan identity + accepted history + candidate context deterministically; unknown id fails replan_context_unavailable", async () => {
    const world = await replanReadyWorld();
    await execCleanVerification(world);
    await world.world.store.submitSupervisorAssessment(await execAcceptInput(world));
    await execOpenNextWindow(world);
    await execRunDirective(world, { objective: "second window" });
    await world.world.store.submitSupervisorAssessment(
      (await execAcceptInput(world, { disposition: "request_replan", rationale: "escalate" })) as never,
    );
    const { issue } = await world.world.store.transitionExecutionRunToReplanRequired(await replanInput(world));
    const context = await world.world.store.buildExecutionIssueReplanContext(issue.id);
    expect(context.issue).toEqual(issue);
    const run = (await world.world.store.getExecutionRun(world.run.id))!;
    expect(context.finalPlan).toEqual({ id: run.finalPlan.id, revision: run.finalPlan.revision, hash: run.finalPlanHash });
    expect(context.acceptedCommits.map((commit) => commit.id)).toEqual(["EC-001"]);
    expect(context.candidateContext).toMatchObject({ activeStageID: issue.activeStageID, openWindowID: issue.openWindowID, candidateRevision: issue.candidateRevision });
    expect(context.sourceAssessment.disposition).toBe("request_replan");
    expect(context.verificationConflicts).toEqual([]);
    expect(context.reconciliations).toEqual([]);
    await expect(world.world.store.buildExecutionIssueReplanContext("ISS-099" as ExecutionIssueID)).rejects.toMatchObject({ code: "replan_context_unavailable" });
    // Projection ≠ second truth: rebuilding yields the same canonical records.
    expect(await world.world.store.buildExecutionIssueReplanContext(issue.id)).toEqual(context);
  });

  it("recovery context exposes the terminal issue facts (§65/E55)", async () => {
    const world = await replanReadyWorld();
    await world.world.store.transitionExecutionRunToReplanRequired(await replanInput(world));
    const context = await world.world.store.buildExecutionRecoveryContext(world.run.id, { sessionID: EXEC_OWNER });
    expect(context!.lifecycle).toBe("replan_required");
    expect(context!.executionIssue).toBeDefined();
    expect(context!.executionIssue!.reason).toBe("normative authority exhausted");
    expect(context!.verificationCondition).toBe("clear");
    expect(context!.reconciliationRequired).toBe(false);
  });
});

describe("durable persistence & malformed graphs (§59/§60/§91-§93/E56/E62)", () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "ultra-plan-exec-replan-"));
    filePath = path.join(dir, "plan.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("§93 the issue + terminal run survive close/reopen exactly; the replan context re-derives identically", async () => {
    const loaded = await durableHandoffPendingWorld(filePath);
    const world = await replanReadyWorld(loaded as unknown as HandoffPendingWorld);
    const { issue, run } = await world.world.store.transitionExecutionRunToReplanRequired(await replanInput(world));
    (world.world.store as unknown as { close(): void }).close();
    const reopened = new DurablePlanStore(filePath, { now: () => FIXED });
    expect(await reopened.getExecutionIssue(issue.id)).toEqual(issue);
    expect(await reopened.getExecutionRun(world.run.id)).toEqual(run);
    const context = await reopened.buildExecutionIssueReplanContext(issue.id);
    expect(context.issue).toEqual(issue);
    reopened.close();
  });

  it("§92a a replan_required run WITHOUT its issue fails closed on load (§60)", async () => {
    const loaded = await durableHandoffPendingWorld(filePath);
    const world = await replanReadyWorld(loaded as unknown as HandoffPendingWorld);
    await world.world.store.transitionExecutionRunToReplanRequired(await replanInput(world));
    (world.world.store as unknown as { close(): void }).close();
    await tamper(filePath, (raw) => {
      raw["executionIssues"] = {};
      raw["issueByExecutionRun"] = {};
    });
    await expect(corruptOpen(filePath)).rejects.toMatchObject({ code: "store_corrupt" });
  });

  it("§92b an issue attached to an ACTIVE run fails closed (§60 bidirectional)", async () => {
    const loaded = await durableHandoffPendingWorld(filePath);
    const world = await replanReadyWorld(loaded as unknown as HandoffPendingWorld);
    const { run } = await world.world.store.transitionExecutionRunToReplanRequired(await replanInput(world));
    (world.world.store as unknown as { close(): void }).close();
    await tamper(filePath, (raw) => {
      (raw["executionRuns"] as Record<string, Record<string, unknown>>)[run.id]!["lifecycle"] = "active";
    });
    await expect(corruptOpen(filePath)).rejects.toMatchObject({ code: "store_corrupt" });
  });

  it("§92c an issue whose source assessment is not request_replan fails closed (§59)", async () => {
    const loaded = await durableHandoffPendingWorld(filePath);
    const world = await replanReadyWorld(loaded as unknown as HandoffPendingWorld);
    const { issue } = await world.world.store.transitionExecutionRunToReplanRequired(await replanInput(world));
    (world.world.store as unknown as { close(): void }).close();
    await tamper(filePath, (raw) => {
      const assessments = raw["supervisorAssessments"] as Record<string, Record<string, unknown>>;
      const record = assessments[issue.sourceAssessmentID]!;
      record["disposition"] = "rework";
      record["hash"] = computeSupervisorAssessmentHashFromRecord(record as never);
    });
    await expect(corruptOpen(filePath)).rejects.toMatchObject({ code: "store_corrupt" });
  });

  it("§92d an issue with unresolvable affectedPlanRefs fails closed (§59/E5)", async () => {
    const loaded = await durableHandoffPendingWorld(filePath);
    const world = await replanReadyWorld(loaded as unknown as HandoffPendingWorld);
    const { issue } = await world.world.store.transitionExecutionRunToReplanRequired(await replanInput(world));
    (world.world.store as unknown as { close(): void }).close();
    await tamper(filePath, (raw) => {
      const issues = raw["executionIssues"] as Record<string, Record<string, unknown>>;
      const record = issues[issue.id]!;
      record["affectedPlanRefs"] = [{ kind: "implementation_step", order: 99 }];
      record["hash"] = computeExecutionIssueHash(executionIssueHashPayload(record as never));
    });
    await expect(corruptOpen(filePath)).rejects.toMatchObject({ code: "store_corrupt" });
  });

  it("§92e a tampered issue hash fails closed", async () => {
    const loaded = await durableHandoffPendingWorld(filePath);
    const world = await replanReadyWorld(loaded as unknown as HandoffPendingWorld);
    const { issue } = await world.world.store.transitionExecutionRunToReplanRequired(await replanInput(world));
    (world.world.store as unknown as { close(): void }).close();
    await tamper(filePath, (raw) => {
      (raw["executionIssues"] as Record<string, Record<string, unknown>>)[issue.id]!["reason"] = "tampered";
    });
    await expect(corruptOpen(filePath)).rejects.toMatchObject({ code: "store_corrupt" });
  });

  it("§91/E62 a pre-Phase-6A store opens unchanged with empty escalation families", async () => {
    const loaded = await durableHandoffPendingWorld(filePath);
    const world = await supervisedWorld(loaded as unknown as HandoffPendingWorld);
    await execRunDirective(world, {});
    (world.world.store as unknown as { close(): void }).close();
    const { readFile } = await import("node:fs/promises");
    const raw = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
    expect(raw["executionIssues"]).toEqual({});
    expect(raw["verificationConflicts"]).toEqual({});
    expect(raw["attemptReconciliations"]).toEqual({});
    const reopened = new DurablePlanStore(filePath, { now: () => FIXED });
    expect((await reopened.getExecutionRun(world.run.id))!.lifecycle).toBe("active");
    reopened.close();
  });

  it("the v0.1 production handoff still creates NO execution artifacts (§95 regression)", async () => {
    const world = await durableHandoffPendingWorld(filePath);
    await world.controller.recoverExecutionHandoff(world.sessionID);
    // The durable test controller carries no execution runtime, so recovery
    // cannot dispatch — the invariant under test is that WHATEVER the v0.1
    // handoff does, it creates no v0.2 execution artifacts.
    expect(await world.store.listOpenExecutionRuns()).toHaveLength(0);
    const events = (await world.store.listEvents(world.runID)).map((event) => event.detail.type);
    expect(events.filter((type) => type.startsWith("execution."))).toEqual([]);
  });
});

describe("replan retry under a durable writer race (§17)", () => {
  it("two concurrent transitions with the same issue id converge: one creates, one idempotently replays", async () => {
    const raceDir = await mkdtemp(path.join(tmpdir(), "ultra-plan-exec-replan-race-"));
    try {
      const loaded = await durableHandoffPendingWorld(path.join(raceDir, "plan.json"));
      const world = await replanReadyWorld(loaded as unknown as HandoffPendingWorld);
      const input = await replanInput(world, { issueID: "ISS-001" as ExecutionIssueID });
      const outcomes = await Promise.allSettled([
        world.world.store.transitionExecutionRunToReplanRequired(input),
        world.world.store.transitionExecutionRunToReplanRequired(input),
      ]);
      const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
      expect(fulfilled).toHaveLength(2);
      expect(fulfilled.filter((outcome) => (outcome as PromiseFulfilledResult<{ created: boolean }>).value.created === true)).toHaveLength(1);
      expect(fulfilled.every((outcome) => (outcome as PromiseFulfilledResult<{ run: { lifecycle: string } }>).value.run.lifecycle === "replan_required")).toBe(true);
      expect(await planEvents(world, "execution.issue_created")).toHaveLength(1);
    } finally {
      await rm(raceDir, { recursive: true, force: true });
    }
  });
});
