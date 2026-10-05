/**
 * E7 §48 — dependency-gated eligibility (E7-T11..T16, plus the §40 DAG walk).
 *
 * Eligibility follows ONLY the approved explicit dependsOn edges (E7 §15):
 * a pending Stage is eligible iff every explicit predecessor maps to a
 * materialized same-Run Stage AND that Stage is completed. Ordinal is never a
 * dependency (E7-I12); unknown/corrupt predecessor mapping fails closed
 * (E7 §16) and is flagged as store corruption by the schema-v20 validator.
 *
 * The world ships the §40 example DAG through the REAL planning pipeline:
 * A (root); B, C depend on A; D depends on B AND C.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  makeSynthesisFixture,
  toolContextOf,
  callSubmitSynthesis,
  callSubmitValidation,
} from "./phase12-helpers.js";
import { callRequestFinalization, callApprove } from "./phase13-helpers.js";
import { callHandoff } from "./phase14-helpers.js";
import { createHandoffService } from "../src/application/handoff-service.js";
import { getFinalPlanInTx } from "../src/store/finalization.js";
import { createExecutionProgressionService, type ExecutionProgressionContext } from "../src/application/execution-progression-service.js";
import { inspectSchemaState } from "../src/store/schema.js";
import { executePhasePlanTool } from "../src/mcp/tools.js";
import { executionToken } from "./phase14-helpers.js";
import { issueDirective } from "./execution-protocol-helpers.js";
import { callWorkerTool, freshWorkerSession } from "./execution-worker-helpers.js";
import { startWorkerAttemptAndPrepareLaunchInTx } from "../src/application/worker-runtime-service.js";
import { deriveStageCompletionValidationRequirement, stageObjectiveObligation } from "../src/core/stage-completion.js";
import { randomUUID } from "node:crypto";
import type { E4World } from "./execution-protocol-helpers.js";

interface DagWorld extends E4World {
  stageByStep: Map<string, string>;
}

/** The §40 DAG: A root; B,C ← A; D ← B+C. */
const DAG_STEPS = [
  { stepId: "step-A", title: "Implement A", description: "foundation", dependsOn: [] as string[] },
  { stepId: "step-B", title: "Implement B", description: "left branch", dependsOn: ["step-A"] },
  { stepId: "step-C", title: "Implement C", description: "right branch", dependsOn: ["step-A"] },
  { stepId: "step-D", title: "Integrate D", description: "needs B and C", dependsOn: ["step-B", "step-C"] },
];

const CLEAN_FINDINGS = [
  {
    kind: "clean" as const,
    summary: "The manifest is a faithful derivation of the frozen input.",
    detail: "No unsupported facts, contradictions, or derivation gaps found.",
    subjectRefs: [],
    supportingRefs: [],
  },
];

async function makeDagWorld(sessionId = `SD-${Math.random().toString(36).slice(2, 8)}`): Promise<DagWorld> {
  const base = await makeSynthesisFixture(sessionId);
  const ctx = toolContextOf(base);
  const sectionRefs = base.sectionIds.map((id) => ({ kind: "section" as const, id, revision: 1 }));
  const ref = sectionRefs[0]!;
  const manifest = {
    version: 1 as const,
    inputId: base.inputId,
    inputHash: base.inputHash,
    crossSectionLinks: [{ statement: "The DAG shares the approved boundary", supportingRefs: sectionRefs }],
    implementationOrder: DAG_STEPS.map((step) => ({ ...step, supportingRefs: [ref] })),
    limitations: [{ statement: "Runtime behavior is bounded by the committed constraints", supportingRefs: sectionRefs }],
    unresolvedFindings: [],
  };
  const synthesis = callSubmitSynthesis(ctx, base, manifest, { toolUseId: `${sessionId}-SYN` });
  if (synthesis.status !== "ok") throw new Error(`synthesis failed: ${JSON.stringify(synthesis)}`);
  const validation = callSubmitValidation(
    ctx,
    base,
    { manifest_id: synthesis.manifest_id, manifest_hash: synthesis.manifest_hash, findings: CLEAN_FINDINGS },
    { toolUseId: `${sessionId}-VAL`, agent: { agentId: "agent_v", agentType: "phase-plan:validator" } },
  );
  if (!validation.is_clean) throw new Error("fixture validation was not clean");
  const fin = callRequestFinalization(ctx, base, { toolUseId: `${sessionId}-FIN` });
  const approval = callApprove(
    ctx,
    base,
    {
      proposal_id: fin.final_proposal.proposal_id,
      revision: fin.final_proposal.revision,
      proposal_hash: fin.final_proposal.proposal_hash,
    },
    { toolUseId: `${sessionId}-APP` },
  );
  const planRow = ctx.store.withRead((tx) => getFinalPlanInTx(tx, base.runId));
  if (planRow === null) throw new Error("fixture failed to reach an approved FinalPlan");
  const prepared = callHandoff(ctx, base, { toolUseId: `${sessionId}-DELIVER` });
  const result = createHandoffService(ctx.store, ctx.clock).finalizeDelivery({
    runId: base.runId,
    sessionId: base.sessionId,
    toolUseId: `${sessionId}-DELIVER`,
    responseHandoffId: prepared.handoff_id,
    responseHandoffHash: prepared.handoff_hash,
  });
  if (result.executionRun === null) throw new Error("fixture activation failed");
  const executionRunId = result.executionRun.executionRunId;
  const stages = ctx.store.withRead(
    (tx) =>
      tx.prepare("SELECT id, source_step_id AS step FROM execution_stages WHERE execution_run_id = ? ORDER BY ordinal").all(executionRunId) as Array<{
        id: string;
        step: string | null;
      }>,
  );
  const stageByStep = new Map(stages.filter((stage) => stage.step !== null).map((stage) => [stage.step as string, stage.id]));
  const activeStageId = ctx.store.withRead(
    (tx) =>
      (tx.prepare("SELECT id FROM execution_stages WHERE execution_run_id = ? AND status = 'active'").get(executionRunId) as { id: string }).id,
  );
  const openWindowId = ctx.store.withRead(
    (tx) =>
      (tx.prepare("SELECT id FROM verification_windows WHERE execution_run_id = ? AND closed_at IS NULL").get(executionRunId) as { id: string }).id,
  );
  return {
    f: {
      ...base,
      manifestId: synthesis.manifest_id,
      manifestHash: synthesis.manifest_hash,
      reportId: validation.report_id,
      finalPlanId: planRow.finalPlanId,
      finalPlanHash: planRow.finalPlanHash,
      commitId: approval.commit_id,
      workspaceRoot: "",
    },
    ctx,
    executionRunId,
    activeStageId,
    openWindowId,
    stageByStep,
  };
}

function progressionOf(w: DagWorld) {
  return createExecutionProgressionService(w.ctx.store, w.ctx.clock);
}

function contextOf(w: DagWorld): ExecutionProgressionContext {
  return progressionOf(w).getExecutionProgressionContext({ executionRunId: w.executionRunId });
}

/** Complete the DAG world's CURRENT active Stage (fixture-grade, real gate). */
function completeActiveStage(w: DagWorld): void {
  // Refresh the pointers continuation/activation may have moved.
  w.openWindowId = w.ctx.store.withRead(
    (tx) =>
      (tx.prepare("SELECT id FROM verification_windows WHERE execution_run_id = ? AND closed_at IS NULL").get(w.executionRunId) as { id: string }).id,
  );
  w.activeStageId = w.ctx.store.withRead(
    (tx) =>
      (tx.prepare("SELECT id FROM execution_stages WHERE execution_run_id = ? AND status = 'active'").get(w.executionRunId) as { id: string }).id,
  );
  const stageId = w.activeStageId;
  const stage = w.ctx.store.withRead(
    (tx) =>
      tx
        .prepare(
          "SELECT id, execution_run_id AS runId, ordinal, status, objective, source_step_id AS sourceStepId, depends_on_json AS dependsOnJson, "
          + "source_refs_json AS sourceRefsJson, completed_by_commit_id AS completedByCommitId, revision, created_at AS createdAt, updated_at AS updatedAt "
          + "FROM execution_stages WHERE id = ?",
        )
        .get(stageId) as Record<string, unknown>,
  );
  const dependsOn = JSON.parse(String(stage.dependsOnJson)) as string[];
  const sourceRefs = JSON.parse(String(stage.sourceRefsJson)) as Array<{ kind: string; id: string; revision: number }>;
  const semantics = {
    executionRunId: w.executionRunId,
    id: stageId,
    sourceStepId: (stage.sourceStepId as string | null) ?? null,
    objective: stage.objective as string,
    sourceRefs,
    dependsOn,
  };
  const requirement = deriveStageCompletionValidationRequirement(semantics);
  // One verification cycle whose Directive carries the Stage-completion
  // requirement, then the accept with the exact obligation — through the real
  // E4/E5 protocol surfaces.
  const directive = issueDirective(w as never, {
    directiveId: `DIR-VER-${randomUUID().slice(0, 8)}`,
    kind: "verification",
    validationRequirements: [requirement],
  });
  const { attempt, launch } = w.ctx.store.withWrite((tx) =>
    startWorkerAttemptAndPrepareLaunchInTx(
      tx,
      {
        executionRunId: w.executionRunId,
        sessionId: w.f.sessionId,
        workspaceId: w.f.workspaceId,
        generation: w.f.generation,
        directiveId: directive.directiveId,
        directiveRevision: directive.revision,
        directiveHash: directive.hash,
        workerRole: "verifier",
      },
      w.ctx.clock,
      w.ctx.clock.nowIso(),
    ),
  );
  const session = freshWorkerSession({ f: w.f } as never, `V-${randomUUID().slice(0, 4).toUpperCase()}`);
  const launchable = { ctx: w.ctx, launch, attemptId: attempt.attemptId } as never;
  callWorkerTool(launchable, session, "worker_claim", {
    attempt_id: attempt.attemptId,
    launch_token: launch.launchToken,
  });
  const ack = callWorkerTool(launchable, session, "worker_submit_report", {
    result: "completed",
    candidate_mutated: false,
    actions_performed: [],
    files_examined: [],
    files_changed: [],
    commands_run: [],
    tests_run: [],
    findings: [],
    deviations: [],
    blockers: [],
    deliverables: [],
  }) as { report_id: string };
  // The accept, through the REAL MCP dispatcher (supervisor-signed) — the
  // token's business hash must cover the exact business payload.
  const business = {
    disposition: "accept",
    rationale: "Stage objective satisfied and verified by the fresh independent verifier.",
    report_judgments: [{ report_id: ack.report_id, disposition: "supporting" }],
    covered_obligations: [stageObjectiveObligation(semantics)],
    expected_candidate_revision: currentRevisionOf(w),
  };
  const token = executionToken(w.ctx, {
    sessionId: w.f.sessionId,
    workspaceId: w.f.workspaceId,
    runId: w.executionRunId,
    finalPlanId: w.f.finalPlanId,
    generation: w.f.generation,
    tool: "submit_supervisor_assessment",
    business,
  });
  const response = executePhasePlanTool(w.ctx, "submit_supervisor_assessment", {
    ...business,
    _hostContext: token,
  }) as { status: string; stage_completed?: boolean };
  if (response.status !== "accepted" || response.stage_completed !== true) {
    throw new Error(`fixture stage completion failed: ${JSON.stringify(response)}`);
  }
}

function activate(w: DagWorld, stepId: string): void {
  const stageId = w.stageByStep.get(stepId);
  if (stageId === undefined) throw new Error(`no stage for step ${stepId}`);
  const token = executionToken(w.ctx, {
    sessionId: w.f.sessionId,
    workspaceId: w.f.workspaceId,
    runId: w.executionRunId,
    finalPlanId: w.f.finalPlanId,
    generation: w.f.generation,
    tool: "activate_execution_stage",
    business: { target_stage_id: stageId },
  });
  const response = executePhasePlanTool(w.ctx, "activate_execution_stage", {
    target_stage_id: stageId,
    _hostContext: token,
  }) as { status: string };
  if (response.status !== "activated") throw new Error(`activation failed: ${JSON.stringify(response)}`);
}

function currentRevisionOf(w: DagWorld): number {
  return w.ctx.store.withRead((tx) => {
    const row = tx
      .prepare("SELECT candidate_revision AS revision FROM verification_windows WHERE execution_run_id = ? AND closed_at IS NULL")
      .get(w.executionRunId) as { revision: number } | undefined;
    return row?.revision ?? -1;
  });
}

let world: DagWorld | null = null;

afterEach(() => {
  world?.ctx.store.close();
  world = null;
});

describe("E7 dependency-gated eligibility (§15/§16/§40)", () => {
  it("E7-T11: the bootstrap activates the dependency-free root; dependents of the ACTIVE stage are ineligible", async () => {
    world = await makeDagWorld();
    const context = contextOf(world);
    expect(context.progressionBoundary).toBe("active_candidate");
    expect(context.activeStage?.id).toBe(world.stageByStep.get("step-A"));
    expect(context.ineligibleStages.map((stage) => stage.id).sort()).toEqual(
      [world.stageByStep.get("step-B"), world.stageByStep.get("step-C"), world.stageByStep.get("step-D")].sort(),
    );
  });

  it("E7-T12: a Stage whose predecessors are active/pending stays ineligible, listed with unsatisfied predecessors", async () => {
    world = await makeDagWorld();
    const context = contextOf(world);
    const d = context.ineligibleStages.find((stage) => stage.id === world!.stageByStep.get("step-D"));
    expect(d?.unsatisfiedPredecessors.sort()).toEqual(["step-B", "step-C"]);
    expect(context.eligibleStages.map((stage) => stage.id)).not.toContain(world.stageByStep.get("step-D"));
  });

  it("E7-T13: a completed predecessor makes its dependents eligible", async () => {
    world = await makeDagWorld();
    completeActiveStage(world);
    const context = contextOf(world);
    expect(context.progressionBoundary).toBe("between_stages");
    expect(context.eligibleStages.map((stage) => stage.id).sort()).toEqual(
      [world.stageByStep.get("step-B"), world.stageByStep.get("step-C")].sort(),
    );
    expect(context.ineligibleStages.map((stage) => stage.id)).toEqual([world.stageByStep.get("step-D")]);
  });

  it("E7-T14: ordinal is not a dependency — the higher-ordinal C is eligible alongside B before either runs", async () => {
    world = await makeDagWorld();
    completeActiveStage(world);
    const context = contextOf(world);
    // B (ordinal 2) and C (ordinal 3) are BOTH eligible: nothing forced B to
    // run before C merely because of ordinal order.
    expect(context.eligibleStages.map((stage) => stage.id).sort()).toEqual(
      [world.stageByStep.get("step-B"), world.stageByStep.get("step-C")].sort(),
    );
    expect(context.defaultSuggestedStageId).toBe(world.stageByStep.get("step-B"));
  });

  it("E7-T15: a multi-predecessor Stage stays ineligible until ALL explicit predecessors are completed", async () => {
    world = await makeDagWorld();
    completeActiveStage(world); // A completed
    activate(world, "step-B");
    completeActiveStage(world); // B completed
    let context = contextOf(world);
    expect(context.eligibleStages.map((stage) => stage.id)).toEqual([world.stageByStep.get("step-C")]);
    expect(context.ineligibleStages.find((stage) => stage.id === world!.stageByStep.get("step-D"))?.unsatisfiedPredecessors).toEqual(["step-C"]);
    activate(world, "step-C");
    completeActiveStage(world); // C completed
    context = contextOf(world);
    expect(context.eligibleStages.map((stage) => stage.id)).toEqual([world.stageByStep.get("step-D")]);
  });

  it("E7-T16: a corrupt (unknown) predecessor mapping fails closed AND is flagged as store corruption", async () => {
    world = await makeDagWorld();
    world.ctx.store.withWrite((tx) => {
      tx.prepare(
        "INSERT INTO execution_stages (id, execution_run_id, ordinal, status, objective, source_step_id, depends_on_json, "
        + "source_refs_json, completed_by_commit_id, revision, created_at, updated_at) "
        + "VALUES ('stage_ghost', ?, 9, 'pending', 'corrupt fixture', NULL, '[\"step-GHOST\"]', '[]', NULL, 1, 'now', 'now')",
      ).run(world!.executionRunId);
    });
    const context = contextOf(world);
    const ghost = context.ineligibleStages.find((stage) => stage.id === "stage_ghost");
    expect(ghost?.unsatisfiedPredecessors).toEqual(["step-GHOST"]);
    expect(context.eligibleStages.map((stage) => stage.id)).not.toContain("stage_ghost");
    const state = world.ctx.store.withRead((tx) => inspectSchemaState(tx));
    expect(state.consistent).toBe(false);
    expect(state.problems.some((problem) => problem.includes("depends on unknown step 'step-GHOST'"))).toBe(true);
  });

  it("E7 §40 walk: the Supervisor selects C (higher ordinal) first; D unlocks only after BOTH B and C complete", async () => {
    world = await makeDagWorld();
    completeActiveStage(world); // A completed
    activate(world, "step-C");
    completeActiveStage(world); // C completed — before B ever ran
    let context = contextOf(world);
    expect(context.eligibleStages.map((stage) => stage.id)).toEqual([world.stageByStep.get("step-B")]);
    expect(context.ineligibleStages.map((stage) => stage.id)).toEqual([world.stageByStep.get("step-D")]);
    activate(world, "step-B");
    completeActiveStage(world); // B completed
    context = contextOf(world);
    expect(context.progressionBoundary).toBe("between_stages");
    expect(context.eligibleStages.map((stage) => stage.id)).toEqual([world.stageByStep.get("step-D")]);
  });
});
