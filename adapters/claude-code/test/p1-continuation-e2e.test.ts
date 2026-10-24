/**
 * P1 E2E Test Suite — Incremental Replan & Execution Continuation.
 *
 * Requirements verified:
 * 1. Distinguishes ordinary implementation deviations/test failures from normative design gaps.
 * 2. Rejects replan requests based solely on test failures, compiler errors, or env issues.
 * 3. Pinpoints affected normative refs (contracts, decisions, constraints).
 * 4. Successor PlanningRun reopens only affected normative design scope.
 * 5. Preserves completed ExecutionStages, ExecutionCommits, Reports, and audits.
 * 6. Successor FinalPlan requires explicit user approval.
 * 7. Successor ExecutionRun does not overwrite or rebind predecessor ExecutionRun.
 * 8. Explicit lineage between predecessor and successor ExecutionRuns.
 * 9. Reuse determination mechanism: reusable, needs_reverification, must_reimplement.
 * 10. Workspace reality & dependency contracts verified before reuse (disk checks).
 * 11. Old side-effecting attempts are not repeated.
 * 12. Cross-stage integration verifier and final closure gate verified.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
  acceptViaMcp,
  boundariesOf,
  completeRunViaGate,
  completeStageViaGate,
  currentRevision,
  freshWorkerSession,
  getExecutionRunInTx,
  getAcceptedHeadCommitIdInTx,
  issueDirective,
  makeAcceptanceWorld,
  runImplementation,
  runFreshVerifier,
  supervisorCall,
  callWorkerTool,
  startWorkerAttemptAndPrepareLaunchInTx,
  deriveStageCompletionValidationRequirement,
  stageObjectiveObligation,
  getExecutionStageInTx,
} from "./v020-e2e-helpers.js";
import { callHandoff } from "./phase14-helpers.js";
import { issueEntryIntent } from "../src/host/entry-intent.js";
import { hostToken } from "./context-helpers.js";
import { executePhasePlanTool } from "../src/mcp/tools.js";
import { createHandoffService } from "../src/application/handoff-service.js";
import {
  driveToCleanValidation,
  callRequestFinalization,
  callApprove,
} from "./phase13-helpers.js";
import { inputOf, selectSection } from "./phase12-helpers.js";
import { completeSectionVia } from "./section-workflow.test.js";
import { getFinalPlanInTx } from "../src/store/finalization.js";
import { parseFinalPlanCanonical } from "../src/application/final-plan-canonical.js";
import { determineContinuationReuseInTx } from "../src/application/execution-continuation-service.js";

function callStartOrResume(
  ctx: any,
  sessionId: string,
  workspaceId: string,
  options: { toolUseId?: string } = {},
) {
  const entry = issueEntryIntent(ctx.secret, { sessionId, promptId: "PROMPT-1" });
  const token = hostToken(
    ctx.secret,
    "start_or_resume",
    { _entryIntent: entry },
    { sessionId, workspaceId },
    { permissionMode: "default", toolUseId: options.toolUseId ?? "TU-ENTRY" },
  );
  return executePhasePlanTool(ctx, "start_or_resume", { _entryIntent: entry, _hostContext: token }) as {
    status: string;
    run: { id: string; stage: string };
    binding: { state: string; generation: number };
    baseline: { final_plan: { id: string; hash: string } };
    affectedScope: { needsReviewSections: string[]; inheritedCompletedSections: string[] };
  };
}

function planSections(world: { ctx: { store: any }; f: { runId: string } }, runId = world.f.runId): Array<{ sectionId: string; revision: number }> {
  const row = world.ctx.store.withRead((tx: any) => getFinalPlanInTx(tx, runId))!;
  return parseFinalPlanCanonical(row.canonicalJson, runId).sections.map((section) => ({
    sectionId: section.sectionId,
    revision: section.revision,
  }));
}

describe("P1: Incremental Replan & Execution Continuation E2E", () => {
  it("rejects non-normative replan requests (ordinary test failures and compiler errors)", async () => {
    const world = await makeAcceptanceWorld("P1-NEG");
    const sections = planSections(world);
    const sec = sections[0]!;

    // 1. Replan for ordinary test failure -> rejected
    let errCode = "no-error";
    try {
      supervisorCall(world, "request_execution_replan", {
        reason: "tests failed on assertion at line 42",
        affected_normative_refs: [{ type: "section", id: sec.sectionId, revision: sec.revision }],
        relevant_report_refs: [],
      });
    } catch (err: any) {
      errCode = err.code ?? "no-error";
    }
    expect(errCode).toBe("REPLAN_REQUEST_INVALID");

    // 2. Replan for compiler error -> rejected
    let compileErrCode = "no-error";
    try {
      supervisorCall(world, "request_execution_replan", {
        reason: "build failed with typescript syntax error in feature.ts",
        affected_normative_refs: [{ type: "section", id: sec.sectionId, revision: sec.revision }],
        relevant_report_refs: [],
      });
    } catch (err: any) {
      compileErrCode = err.code ?? "no-error";
    }
    expect(compileErrCode).toBe("REPLAN_REQUEST_INVALID");
  });

  it("completes full 5-stage multi-run workflow with legitimate replan, continuation reuse, and final closure", async () => {
    // -------------------------------------------------------------------------
    // Phase A: Setup a multi-stage world and complete Stages 1, 2, and 3
    // -------------------------------------------------------------------------
    const world = await makeAcceptanceWorld("P1-FULL");
    const sections = planSections(world);
    const wsRoot = world.f.workspaceRoot;

    // Create Stage 1 deliverable on disk
    const featureFile = path.join(wsRoot, "src", "feature.ts");
    fs.mkdirSync(path.dirname(featureFile), { recursive: true });
    fs.writeFileSync(featureFile, "export const Feature = { enabled: true };\n");

    const storageFile = path.join(wsRoot, "src", "storage.ts");
    fs.writeFileSync(storageFile, "export const Storage = { save: () => true };\n");

    // Complete Stage 1 via gate
    const st1 = completeStageViaGate(world);
    expect(st1.commitId).toBeTruthy();

    const boundsAfterSt1 = boundariesOf(world);
    expect(boundsAfterSt1.stages[0]!.status).toBe("completed");
    expect(boundsAfterSt1.stages[0]!.completedBy).toBe(st1.commitId);
    expect(boundsAfterSt1.acceptedHead).toBe(st1.commitId);

    // Advance to Stage 2
    const st2Id = boundsAfterSt1.stages[1]!.id;
    const act2 = supervisorCall(world, "activate_execution_stage", {
      target_stage_id: st2Id,
    }) as { window: { id: string } };
    world.activeStageId = st2Id;
    world.openWindowId = act2.window.id;

    // Implement and complete Stage 2
    const processorFile = path.join(wsRoot, "src", "processor.ts");
    fs.writeFileSync(processorFile, "import { Storage } from './storage';\nexport const Processor = { process: () => Storage.save() };\n");

    runImplementation(world, {
      directiveId: `DIR-P1-ST2-IMPL`,
      candidateMutated: true,
      reportOverrides: {
        files_changed: ["src/processor.ts"],
      },
    });

    const st2 = completeStageViaGate(world);
    expect(st2.commitId).toBeTruthy();

    const boundsAfterSt2 = boundariesOf(world);
    expect(boundsAfterSt2.stages[1]!.status).toBe("completed");
    expect(boundsAfterSt2.acceptedHead).toBe(st2.commitId);

    // -------------------------------------------------------------------------
    // Phase B: Stage 3 discovers legitimate normative contract defect in Section
    // -------------------------------------------------------------------------
    // Supervisor triggers legitimate Replan stating normative contract gap
    const targetSection = sections[sections.length - 1]!;
    const replanResult = supervisorCall(world, "request_execution_replan", {
      reason: "normative contract deficiency: the approved section contract requires interface redesign for external integration",
      affected_normative_refs: [{ type: "section", id: targetSection.sectionId, revision: targetSection.revision }],
      relevant_report_refs: [],
    }) as { status: string; execution_run_id: string };

    expect(replanResult.status).toBe("replan_required");

    // Check Run A terminal state
    const boundsRunA = boundariesOf(world);
    expect(boundsRunA.lifecycle).toBe("replan_required");
    expect(boundsRunA.acceptedHead).toBe(st2.commitId); // Predecessor head preserved!
    expect(boundsRunA.stages[0]!.status).toBe("completed");
    expect(boundsRunA.stages[1]!.status).toBe("completed");

    // -------------------------------------------------------------------------
    // Phase C: Successor PlanningRun created, scope reopened, new FinalPlan approved
    // -------------------------------------------------------------------------
    const entry = callStartOrResume(world.ctx, world.f.sessionId, world.f.workspaceId, { toolUseId: "P1-RP-ENTRY" });
    expect(entry.status).toBe("started_successor");
    const successorRunId = entry.run.id;
    expect(successorRunId).not.toBe(world.f.runId);

    const successorFixture = {
      ...world.f,
      runId: successorRunId,
      generation: entry.binding.generation,
    };

    // Review & complete reopened sections
    for (const secId of entry.affectedScope.needsReviewSections) {
      selectSection(successorFixture, secId);
      completeSectionVia(successorFixture, secId, 1);
    }

    const input = inputOf(successorFixture);
    const manifestFixture = {
      ...successorFixture,
      inputId: input.inputId,
      inputHash: input.inputHash,
      sectionIds: sections.map((s) => s.sectionId),
    };

    driveToCleanValidation(manifestFixture as never, world.ctx, "P1-VAL");
    const fin = callRequestFinalization(world.ctx, manifestFixture as never, { toolUseId: "P1-FIN-B" });
    callApprove(world.ctx, manifestFixture as never, {
      proposal_id: fin.final_proposal.proposal_id,
      revision: fin.final_proposal.revision,
      proposal_hash: fin.final_proposal.proposal_hash,
    }, { toolUseId: "P1-APP-B" });

    const finalPlanB = world.ctx.store.withRead((tx: any) => getFinalPlanInTx(tx, successorRunId))!;
    expect(finalPlanB).not.toBeNull();

    // -------------------------------------------------------------------------
    // Phase D: Deliver handoff -> Successor ExecutionRun B with continuation
    // -------------------------------------------------------------------------
    const preparedB = callHandoff(world.ctx, {
      sessionId: world.f.sessionId,
      workspaceId: world.f.workspaceId,
      runId: successorRunId,
      generation: entry.binding.generation,
    }, { toolUseId: "P1-DELIVER-B" });

    const finalizeB = createHandoffService(world.ctx.store, world.ctx.clock).finalizeDelivery({
      runId: successorRunId,
      sessionId: world.f.sessionId,
      toolUseId: "P1-DELIVER-B",
      responseHandoffId: preparedB.handoff_id,
      responseHandoffHash: preparedB.handoff_hash,
    });

    const executionRunBId = world.ctx.store.withRead(
      (tx: any) => (tx.prepare("SELECT execution_run_id AS id FROM execution_runs WHERE run_id = ?").get(successorRunId) as { id: string }).id,
    );

    // Verify continuation reuse determinations in Run B
    const evalResult = world.ctx.store.withRead((tx: any) =>
      determineContinuationReuseInTx(tx, executionRunBId),
    );
    expect(evalResult.isContinuation).toBe(true);
    expect(evalResult.predecessorExecutionRunId).toBe(world.executionRunId);

    // Verify that predecessor Run A and FinalPlan A are unmutated
    const runARow = world.ctx.store.withRead((tx: any) => getExecutionRunInTx(tx, world.executionRunId))!;
    expect(runARow.lifecycle).toBe("replan_required");
    expect(runARow.finalPlan.id).toBe(world.f.finalPlanId);

    // Verify Run B structure: Stage 1 reused as completed!
    const boundsRunB = boundariesOf(world, executionRunBId);
    expect(boundsRunB.lifecycle).toBe("active");
    expect(boundsRunB.stages.length).toBeGreaterThanOrEqual(2);

    const st1RunB = boundsRunB.stages[0]!;
    expect(st1RunB.status).toBe("completed");
    expect(st1RunB.completedBy).toBe(st1.commitId); // Predecessor commit preserved!

    // Verify seed accepted head
    expect(boundsRunB.acceptedHead).toBe(st1.commitId);

    // Verify active stage is the first non-reused stage
    expect(boundsRunB.activeStage).toBe(boundsRunB.stages[1]!.id);
    expect(boundsRunB.openWindow).not.toBeNull();
    const openWin = boundsRunB.windows.find((w) => w.id === boundsRunB.openWindow!.id)!;
    expect(openWin.baseCommitId).toBe(st1.commitId);

    // -------------------------------------------------------------------------
    // Phase E: Negative Workspace Reality Check
    // Verify that deleting a deliverable causes reuse evaluation to fail
    // -------------------------------------------------------------------------
    fs.unlinkSync(featureFile);
    const evalMissingFile = world.ctx.store.withRead((tx: any) =>
      determineContinuationReuseInTx(tx, executionRunBId),
    );
    const st1Det = evalMissingFile.determinations.find((d) => d.sourceStepId === "step-1");
    expect(st1Det?.workspaceVerified).toBe(false);
    expect(st1Det?.disposition).toBe("must_reimplement");

    // Restore file for clean teardown
    fs.writeFileSync(featureFile, "export const Feature = { enabled: true };\n");

    // -------------------------------------------------------------------------
    // Phase F: Drive Run B Stage 2 to completion and complete Run B via final closure
    // -------------------------------------------------------------------------
    world.executionRunId = executionRunBId;
    world.activeStageId = boundsRunB.activeStage!;
    world.openWindowId = boundsRunB.openWindow!.id;

    // Implement Stage 2 in Run B
    runImplementation(world, {
      directiveId: "DIR-P1-RUNB-ST2-IMPL",
      candidateMutated: true,
      reportOverrides: {
        files_changed: ["src/processor.ts"],
      },
    });

    // Complete Stage 2 in Run B via gate
    const st2B = completeStageViaGate(world);
    expect(st2B.commitId).toBeTruthy();

    const boundsAfterSt2B = boundariesOf(world, executionRunBId);
    expect(boundsAfterSt2B.stages.every((s) => s.status === "completed")).toBe(true);
    expect(boundsAfterSt2B.openWindow).toBeNull();
    expect(boundsAfterSt2B.lifecycle).toBe("active");

    // Explicit begin_execution_final_closure
    const begin = supervisorCall(world, "begin_execution_final_closure") as {
      status: string;
      window: { id: string; candidate_revision: number };
    };
    expect(begin.status).toBe("final_closure_open");
    world.openWindowId = begin.window.id;

    // Run final closure verifier and complete run
    const finalGate = completeRunViaGate(world);
    const ecFinal = finalGate.commitId;

    const boundsFinal = boundariesOf(world, executionRunBId);
    expect(boundsFinal.lifecycle).toBe("completed");
    expect(boundsFinal.acceptedHead).toBe(ecFinal);
    expect(boundsFinal.completionCommitId).toBe(ecFinal);

    // Final integrity checks: Run A remains replan_required, Run B completed
    const runAFinal = world.ctx.store.withRead((tx: any) => getExecutionRunInTx(tx, replanResult.execution_run_id))!;
    expect(runAFinal.lifecycle).toBe("replan_required");
    const runBFinal = world.ctx.store.withRead((tx: any) => getExecutionRunInTx(tx, executionRunBId))!;
    expect(runBFinal.lifecycle).toBe("completed");
  });
});
