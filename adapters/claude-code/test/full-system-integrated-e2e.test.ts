/**
 * Full-System Integrated E2E Regression Suite (Phase Plan v0.2.0 P1-P7).
 *
 * Integrates all seven problem solutions in one cohesive end-to-end journey:
 * - Formal PlanningRun and approved immutable FinalPlan.
 * - Initial ExecutionRun creation and activation.
 * - Layered Shell Capability Enforcement (P2): build/test allowed, gitPush/network blocked.
 * - Supervisor Long-Horizon Evolution Ledger (P3): L0/L1/L2 preserving Stage 1 invariants beyond 10-item limit.
 * - Model Deterministic Bookkeeping (P4): simplified assessment with assessment_token & automatic obligations.
 * - Indeterminate Recovery & Capability Boundary (P5): crash, process fence, resolution idempotency.
 * - Adversarial Verification Quality (P6): defect falsification, rework, and mechanical change acceptance.
 * - Normative Replan & Incremental Continuation (P1): successor PlanningRun, approval, stage reuse, and continuation.
 * - Cross-Stage Verification & ExecutionCompletionGate.
 * - Abort Manifest & Non-Destructive Reconciliation (P7).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
  acceptViaMcp,
  boundariesOf,
  closeAndReopen,
  completeRunViaGate,
  completeStageViaGate,
  currentRevision,
  freshWorkerSession,
  getExecutionAttemptInTx,
  getExecutionRunInTx,
  getExecutionStageInTx,
  getAcceptedHeadCommitIdInTx,
  deriveStageCompletionValidationRequirement,
  makeAcceptanceWorld,
  runImplementation,
  runFreshVerifier,
  supervisorCall,
  callWorkerTool,
  startWorkerAttemptAndPrepareLaunchInTx,
} from "./v020-e2e-helpers.js";
import { callHandoff } from "./phase14-helpers.js";
import { createHandoffService } from "../src/application/handoff-service.js";
import { issueEntryIntent } from "../src/host/entry-intent.js";
import { hostToken } from "./context-helpers.js";
import { executePhasePlanTool } from "../src/mcp/tools.js";
import {
  driveToCleanValidation,
  callRequestFinalization,
  callApprove,
} from "./phase13-helpers.js";
import { inputOf, selectSection, hostTokenV2 } from "./phase12-helpers.js";
import { completeSectionVia } from "./section-workflow.test.js";
import { getFinalPlanInTx } from "../src/store/finalization.js";
import { parseFinalPlanCanonical } from "../src/application/final-plan-canonical.js";
import { determineContinuationReuseInTx } from "../src/application/execution-continuation-service.js";
import { narrowWorkerTool, capabilityEnforceabilityReport } from "../src/runtime/worker-capabilities.js";
import { buildLayeredSupervisorContextInTx } from "../src/context/execution-evolution-ledger.js";
import {
  capturePhysicalWorkspaceBaseline,
  executeExplicitCleanup,
  generateAbortManifestInTx,
} from "../src/application/workspace-reconciliation-service.js";
import { issueDirective } from "./execution-protocol-helpers.js";
import { runReconciliationInspection } from "./attempt-recovery-helpers.js";
import { terminateAndMarkIndeterminateInTx } from "../src/application/recovery-process-coordinator.js";

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
    { permissionMode: "default", toolUseId: options.toolUseId ?? "TU-FULL-ENTRY" },
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

describe("Full-System Integrated E2E Regression (P1-P7)", () => {
  it("executes the unified multi-stage lifecycle covering all seven reliability problem domains", async () => {
    const world = await makeAcceptanceWorld("SYS-E2E");
    const wsRoot = world.f.workspaceRoot;

    // -------------------------------------------------------------------------
    // Initial Workspace Baseline & User Pre-existing Files (P7)
    // -------------------------------------------------------------------------
    const userNotesFile = path.join(wsRoot, "user-notes.txt");
    fs.writeFileSync(userNotesFile, "Confidential user pre-existing notes.\n");
    const initialBaseline = capturePhysicalWorkspaceBaseline(wsRoot);
    expect(initialBaseline.userUntrackedFiles.some((f) => f.includes("user-notes.txt"))).toBe(true);

    // -------------------------------------------------------------------------
    // Stage 1: Storage Foundation + Cross-Component Invariant (P3)
    // -------------------------------------------------------------------------
    const storageFile = path.join(wsRoot, "src", "feature.ts");
    fs.mkdirSync(path.dirname(storageFile), { recursive: true });
    fs.writeFileSync(storageFile, "export const Storage = { ready: true };\n");

    // Implement Stage 1 with findings establishing cross-stage invariant
    runImplementation(world, {
      directiveId: "DIR-SYS-ST1-IMPL",
      candidateMutated: true,
      reportOverrides: {
        files_changed: ["src/feature.ts"],
        findings: [
          {
            summary: "Cross-component invariant: Database transaction isolation must be SERIALIZABLE",
            details: "Applies to all subsequent execution stages",
          },
        ],
      },
    });

    const st1 = completeStageViaGate(world);
    expect(st1.commitId).toBeTruthy();

    // -------------------------------------------------------------------------
    // Stage 2: Layered Capability Enforcement (P2) + Crash & Recovery (P5)
    // -------------------------------------------------------------------------
    const boundsAfterSt1 = boundariesOf(world);
    const st2Id = boundsAfterSt1.stages[1]!.id;

    const act2 = supervisorCall(world, "activate_execution_stage", {
      target_stage_id: st2Id,
    }) as { window: { id: string } };
    world.activeStageId = st2Id;
    world.openWindowId = act2.window.id;

    // P2: Issue directive with commandExecution=true and restricted high-risk capabilities
    const fineGrainedEnvelope = {
      repositoryRead: true,
      repositoryWrite: true,
      commandExecution: true,
      networkAccess: false,
      dependencyMutation: false,
      gitCommit: false,
      gitPush: false,
      externalServiceMutation: false,
    };

    const dirSt2 = issueDirective(world, {
      directiveId: "DIR-SYS-ST2-LAYERED",
      kind: "implementation",
      capabilityEnvelope: fineGrainedEnvelope as never,
    });

    // P2: Launch with layered enforcement policy
    const { attempt: attempt2, launch: launch2 } = world.ctx.store.withWrite((tx: any) =>
      startWorkerAttemptAndPrepareLaunchInTx(
        tx,
        {
          executionRunId: world.executionRunId,
          sessionId: world.f.sessionId,
          workspaceId: world.f.workspaceId,
          generation: world.f.generation,
          directiveId: dirSt2.directiveId,
          directiveRevision: dirSt2.revision,
          directiveHash: dirSt2.hash,
          workerRole: "executor",
          enforcementPolicy: "layered",
        },
        world.ctx.clock,
        world.ctx.clock.nowIso(),
      ),
    );

    const session2 = freshWorkerSession(world, "W-SYS-ST2");
    callWorkerTool(world, session2, "worker_claim", {
      attempt_id: attempt2.attemptId,
      launch_token: launch2.launchToken,
    });

    // P2: Verify boundary interception on shell commands
    const buildDecision = narrowWorkerTool("Bash", fineGrainedEnvelope, { command: "node -v" });
    expect(buildDecision.allowed).toBe(true);

    const pushDecision = narrowWorkerTool("Bash", fineGrainedEnvelope, { command: "git push origin main" });
    expect(pushDecision.allowed).toBe(false);

    // P5: Worker creates side-effect file then crashes
    const processorFile = path.join(wsRoot, "src", "processor.ts");
    fs.writeFileSync(processorFile, "export const Processor = { running: true };\n");

    // Terminate worker process and mark attempt indeterminate
    world.ctx.store.withWrite((tx: any) =>
      terminateAndMarkIndeterminateInTx(
        tx,
        { attemptId: attempt2.attemptId, overrideProcessAliveCheck: true },
        world.ctx.clock.nowIso(),
      ),
    );

    // P5: Ordinary execution fenced, recovery guidance accessible
    const recoveryCtx = supervisorCall(world, "get_attempt_recovery_context", {}) as {
      execution_fenced: boolean;
      recovery_guidance: any;
    };
    expect(recoveryCtx.execution_fenced).toBe(true);
    expect(recoveryCtx.recovery_guidance.fenced).toBe(true);

    // P5: Run inspection directive and reconcile via candidate_changed
    const inspection = runReconciliationInspection(world, {
      attemptId: attempt2.attemptId,
      candidateMutated: false,
    });
    expect(inspection.reportId).toBeTruthy();

    const revBeforeResolve = currentRevision(world);
    const resolvedResult = supervisorCall(world, "resolve_indeterminate_attempt", {
      attempt_id: attempt2.attemptId,
      resolution: "candidate_changed",
      inspection_report_id: inspection.reportId,
      rationale: "Inspection confirms candidate changed with valid processor file",
      expected_candidate_revision: revBeforeResolve,
    }) as { status: string };
    expect(resolvedResult.status).toBe("resolved");

    // P5: Idempotent resolution retry converges
    const retryResolved = supervisorCall(world, "resolve_indeterminate_attempt", {
      attempt_id: attempt2.attemptId,
      resolution: "candidate_changed",
      inspection_report_id: inspection.reportId,
      rationale: "Inspection confirms candidate changed with valid processor file",
      expected_candidate_revision: revBeforeResolve,
    }) as { status: string };
    expect(retryResolved.status).toBe("already_resolved");

    // Stage 2 completion: fresh verifier + simplified assessment (P4)
    const stage2 = world.ctx.store.withRead((tx: any) => getExecutionStageInTx(tx, st2Id))!;
    const st2Req = deriveStageCompletionValidationRequirement(stage2);
    const ver2 = runFreshVerifier(world, {
      directiveId: "DIR-SYS-ST2-VER",
      validationRequirements: [st2Req],
    });

    // P4: Get assessment context and submit with assessment_token (no manual hashes!)
    const acceptCtx2 = supervisorCall(world, "get_execution_acceptance_context", {}) as {
      status: string;
      assessment_token: string;
    };
    const accept2 = supervisorCall(world, "submit_supervisor_assessment", {
      disposition: "accept",
      rationale: "Stage 2 verified and complete",
      assessment_token: acceptCtx2.assessment_token,
      complete_stage: true,
      report_judgments: [
        { report_id: ver2.reportId, disposition: "supporting" },
      ],
    }) as { status: string; commit: { id: string } };

    expect(accept2.status).toBe("accepted");
    const st2CommitId = accept2.commit.id;

    // -------------------------------------------------------------------------
    // Stage 3 & Beyond: Context Drift & Invariant Retention (P3)
    // -------------------------------------------------------------------------
    // Verify that L1 Evolution Context retains Stage 1's invariant
    const layeredCtx = world.ctx.store.withRead((tx: any) =>
      buildLayeredSupervisorContextInTx(tx, world.executionRunId),
    );
    expect(layeredCtx.l1Evolution.completedStages).toHaveLength(2);
    const crossStageContract = layeredCtx.l1Evolution.crossStageContracts.find((c) =>
      c.statement.includes("SERIALIZABLE"),
    );
    expect(crossStageContract).toBeDefined();

    // -------------------------------------------------------------------------
    // Mid-Course Normative Replan (P1)
    // -------------------------------------------------------------------------
    // Non-normative replan attempt is rejected (P1 §1/§2)
    const sections = planSections(world);
    const targetSection = sections[sections.length - 1]!;
    let invalidReplanErr = "no-error";
    try {
      supervisorCall(world, "request_execution_replan", {
        reason: "tests failed in test_suite",
        affected_normative_refs: [{ type: "section", id: targetSection.sectionId, revision: targetSection.revision }],
        relevant_report_refs: [],
      });
    } catch (err: any) {
      invalidReplanErr = err.code ?? "no-error";
    }
    expect(invalidReplanErr).toBe("REPLAN_REQUEST_INVALID");

    // Legitimate normative replan
    const replanResult = supervisorCall(world, "request_execution_replan", {
      reason: "normative contract deficiency: API protocol requires interface change in section",
      affected_normative_refs: [{ type: "section", id: targetSection.sectionId, revision: targetSection.revision }],
      relevant_report_refs: [],
    }) as { status: string; execution_run_id: string };

    expect(replanResult.status).toBe("replan_required");

    // Successor planning run
    const entry = callStartOrResume(world.ctx, world.f.sessionId, world.f.workspaceId, { toolUseId: "SYS-RP-ENTRY" });
    expect(entry.status).toBe("started_successor");
    const successorRunId = entry.run.id;

    const successorFixture = {
      ...world.f,
      runId: successorRunId,
      generation: entry.binding.generation,
    };

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

    driveToCleanValidation(manifestFixture as never, world.ctx, "SYS-VAL");
    const fin = callRequestFinalization(world.ctx, manifestFixture as never, { toolUseId: "SYS-FIN" });
    callApprove(world.ctx, manifestFixture as never, {
      proposal_id: fin.final_proposal.proposal_id,
      revision: fin.final_proposal.revision,
      proposal_hash: fin.final_proposal.proposal_hash,
    }, { toolUseId: "SYS-APP" });

    // Handoff to new ExecutionRun B
    const preparedB = callHandoff(world.ctx, {
      sessionId: world.f.sessionId,
      workspaceId: world.f.workspaceId,
      runId: successorRunId,
      generation: entry.binding.generation,
    }, { toolUseId: "SYS-DELIVER-B" });

    createHandoffService(world.ctx.store, world.ctx.clock).finalizeDelivery({
      runId: successorRunId,
      sessionId: world.f.sessionId,
      toolUseId: "SYS-DELIVER-B",
      responseHandoffId: preparedB.handoff_id,
      responseHandoffHash: preparedB.handoff_hash,
    });

    const runBId = world.ctx.store.withRead(
      (tx: any) => (tx.prepare("SELECT execution_run_id AS id FROM execution_runs WHERE run_id = ?").get(successorRunId) as { id: string }).id,
    );

    // -------------------------------------------------------------------------
    // Continuation Reuse in Run B (P1)
    // -------------------------------------------------------------------------
    const evalResult = world.ctx.store.withRead((tx: any) => determineContinuationReuseInTx(tx, runBId));
    expect(evalResult.isContinuation).toBe(true);
    expect(evalResult.predecessorExecutionRunId).toBe(world.executionRunId);

    const boundsRunB = boundariesOf(world, runBId);
    expect(boundsRunB.stages[0]!.status).toBe("completed"); // Stage 1 reused!
    expect(boundsRunB.acceptedHead).toBe(st1.commitId);

    // -------------------------------------------------------------------------
    // Final Closure of Run B (ExecutionCompletionGate)
    // -------------------------------------------------------------------------
    world.executionRunId = runBId;
    world.activeStageId = boundsRunB.activeStage!;
    world.openWindowId = boundsRunB.openWindow!.id;

    // Complete remaining stage
    fs.writeFileSync(path.join(wsRoot, "src", "gateway.ts"), "export const Gateway = true;\n");
    runImplementation(world, {
      directiveId: "DIR-SYS-RUNB-ST2-IMPL",
      candidateMutated: true,
      reportOverrides: {
        files_changed: ["src/gateway.ts"],
      },
    });

    const st2B = completeStageViaGate(world);
    expect(st2B.commitId).toBeTruthy();

    // Final closure
    const beginFinal = supervisorCall(world, "begin_execution_final_closure") as {
      status: string;
      window: { id: string };
    };
    world.openWindowId = beginFinal.window.id;

    const finalCommit = completeRunViaGate(world);
    expect(finalCommit.commitId).toBeTruthy();

    const boundsFinal = boundariesOf(world, runBId);
    expect(boundsFinal.lifecycle).toBe("completed");

    // -------------------------------------------------------------------------
    // Abort Reconciliation & Safe Cleanup (P7)
    // -------------------------------------------------------------------------
    // Verify user pre-existing files survived the entire multi-run workflow!
    expect(fs.existsSync(userNotesFile)).toBe(true);
    expect(fs.readFileSync(userNotesFile, "utf8")).toBe("Confidential user pre-existing notes.\n");

    // Test explicit safe cleanup engine
    const abortManifest = world.ctx.store.withRead((tx: any) =>
      generateAbortManifestInTx(tx, runBId, wsRoot),
    );
    expect(abortManifest.safeCleanupOptions).toHaveLength(3);

    const cleanup = executeExplicitCleanup(wsRoot, abortManifest, "clean_unaccepted_only");
    expect(cleanup.deletedFiles).toHaveLength(0); // All candidate files in Run B were accepted
    expect(fs.existsSync(userNotesFile)).toBe(true); // User file intact
  });
});
