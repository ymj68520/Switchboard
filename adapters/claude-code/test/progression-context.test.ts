/**
 * E7 §18/§19/§33 — the execution progression context (E7-T25) and the §33
 * Stage-completion facts inside the acceptance context.
 *
 * The progression context is a deterministic Store projection: the same
 * durable state always yields the same boundary and eligibility
 * classification. The stageCompletion block tells the Supervisor whether an
 * upcoming accept would be an intermediate or a Stage-completing Commit —
 * Core never decides that from prose (E7 §33/§34).
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  acceptInput,
  acceptanceServiceOf,
  makeAcceptanceWorld,
  runVerificationCycle,
  completeActiveStageFixture,
  supervisorCall,
  type AcceptanceWorld,
} from "./acceptance-helpers.js";
import { createExecutionProgressionService } from "../src/application/execution-progression-service.js";
import { deriveStageCompletionValidationRequirement, stageObjectiveObligation } from "../src/core/stage-completion.js";
import { getExecutionStageInTx } from "../src/store/execution-structure.js";

let world: AcceptanceWorld | null = null;

async function freshWorld(): Promise<AcceptanceWorld> {
  world = await makeAcceptanceWorld(`PC-${Math.random().toString(36).slice(2, 8)}`);
  return world;
}

function progressionOf(w: AcceptanceWorld) {
  return createExecutionProgressionService(w.ctx.store, w.ctx.clock);
}

afterEach(() => {
  world?.ctx.store.close();
  world = null;
});

describe("E7 progression context (§18/§19)", () => {
  it("E7-T25: the same Store state yields the identical boundary and eligibility classification", async () => {
    const w = await freshWorld();
    const service = progressionOf(w);
    const first = service.getExecutionProgressionContext({ executionRunId: w.executionRunId });
    const second = service.getExecutionProgressionContext({ executionRunId: w.executionRunId });
    expect(second).toEqual(first);
    expect(first.progressionBoundary).toBe("active_candidate");
    expect(first.acceptedHead).toBeNull();
    expect(first.pendingStages.map((stage) => stage.sourceStepId)).toEqual(["step-2"]);
    // The classification is also stable across a JSON round trip (no hidden
    // nondeterministic fields).
    expect(JSON.parse(JSON.stringify(second))).toEqual(JSON.parse(JSON.stringify(first)));
  });

  it("E7 §19: each boundary is derivable from the durable state", async () => {
    const w = await freshWorld();
    const service = progressionOf(w);
    // active_candidate: active Stage + open Window.
    expect(service.getExecutionProgressionContext({ executionRunId: w.executionRunId }).progressionBoundary).toBe("active_candidate");
    // post_commit_same_stage: active Stage + no open Window + head exists.
    runVerificationCycle(w);
    acceptanceServiceOf(w).submitSupervisorAssessment(acceptInput(w, { coveredObligations: [] }) as never);
    expect(service.getExecutionProgressionContext({ executionRunId: w.executionRunId }).progressionBoundary).toBe("post_commit_same_stage");
    // between_stages: no active Stage + pending Stages exist. Completing
    // requires an explicit continuation first — the post-commit boundary
    // never auto-opens a window (E7 §21).
    supervisorCall(w, "continue_execution_stage");
    completeActiveStageFixture(w);
    const between = service.getExecutionProgressionContext({ executionRunId: w.executionRunId });
    expect(between.progressionBoundary).toBe("between_stages");
    // all_stages_completed: no active, no pending — run stays active.
    const pendingId = w.ctx.store.withRead(
      (tx) =>
        (tx.prepare("SELECT id FROM execution_stages WHERE execution_run_id = ? AND status = 'pending'").get(w.executionRunId) as { id: string }).id,
    );
    supervisorCall(w, "activate_execution_stage", { target_stage_id: pendingId });
    completeActiveStageFixture(w);
    const done = service.getExecutionProgressionContext({ executionRunId: w.executionRunId });
    expect(done.progressionBoundary).toBe("all_stages_completed");
    expect(done.executionRun.lifecycle).toBe("active");
    expect(done.activeStage).toBeNull();
    expect(done.openWindow).toBeNull();
    expect(done.completedStages).toHaveLength(2);
    expect(done.eligibleStages).toEqual([]);
    expect(done.defaultSuggestedStageId).toBeNull();
  });
});

describe("E7 §33 — stageCompletion in the acceptance context", () => {
  it("the context exposes the exact obligation, required verifier requirement, and live coverage", async () => {
    const w = await freshWorld();
    const stage = w.ctx.store.withRead((tx) => getExecutionStageInTx(tx, w.activeStageId))!;
    const requirement = deriveStageCompletionValidationRequirement(stage);
    const service = acceptanceServiceOf(w);

    // Before any verification: the identity is there, coverage is false.
    const before = service.getExecutionAcceptanceContext({ executionRunId: w.executionRunId });
    expect(before.stageCompletion).not.toBeNull();
    expect(before.stageCompletion?.stageId).toBe(stage.id);
    expect(before.stageCompletion?.objectiveHash).toBe(requirement.detail);
    expect(before.stageCompletion?.requiredVerificationRequirement).toEqual(requirement);
    expect(before.stageCompletion?.currentlyCovered).toBe(false);

    // A GENERIC verifier does not cover Stage completion.
    const genericReport = runVerificationCycle(w);
    const generic = service.getExecutionAcceptanceContext({ executionRunId: w.executionRunId });
    expect(generic.stageCompletion?.currentlyCovered).toBe(false);

    // A verifier whose Directive carries the exact requirement DOES cover it —
    // alongside the earlier generic verifier, which must also be classified.
    const second = runVerificationCycle(w, { directiveOverrides: { validationRequirements: [requirement] } });
    const covered = service.getExecutionAcceptanceContext({ executionRunId: w.executionRunId });
    expect(covered.stageCompletion?.currentlyCovered).toBe(true);
    expect(covered.candidate?.qualifyingVerificationReportIds).toContain(second.reportId);

    // And the gate accepts the Stage-completing assessment on that evidence —
    // every current-candidate report classified (both verifiers).
    const result = service.submitSupervisorAssessment(
      acceptInput(w, {
        reportJudgments: [
          { report_id: genericReport.reportId, disposition: "supporting" },
          { report_id: second.reportId, disposition: "supporting" },
        ],
        coveredObligations: [stageObjectiveObligation(stage)],
      }) as never,
    ) as { stageCompleted: boolean };
    expect(result.stageCompleted).toBe(true);
  });

  it("a run with no active Stage projects stageCompletion: null", async () => {
    const w = await freshWorld();
    completeActiveStageFixture(w);
    const context = acceptanceServiceOf(w).getExecutionAcceptanceContext({ executionRunId: w.executionRunId });
    expect(context.activeStage).toBeNull();
    expect(context.stageCompletion).toBeNull();
    expect(context.boundary).toBe("no-active-stage");
  });
});
