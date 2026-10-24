/**
 * P4 E2E Test Suite — Model Deterministic Transaction Bookkeeping & Current Assessment Context.
 *
 * Requirements verified:
 * 1. Generates multiple ImplementationReports and VerificationReports.
 * 2. Supervisor uses simplified semantic interface (no manual SHA256 obligation hashes).
 * 3. Core automatically associates correct Window, Candidate, Reports, and deterministic obligations.
 * 4. Incomplete report coverage is detected and rejected.
 * 5. Candidate revision change before submission triggers optimistic concurrency fence.
 * 6. Stale assessment is rejected and cannot produce an ExecutionCommit.
 * 7. Refreshing context allows successful submission and stage completion.
 * 8. Duplicate submission of the same assessment converges idempotently without duplicate Commit.
 */

import { describe, expect, it } from "vitest";

import {
  acceptViaMcp,
  boundariesOf,
  currentRevision,
  makeAcceptanceWorld,
  runImplementation,
  runFreshVerifier,
  supervisorCall,
  callWorkerTool,
  freshWorkerSession,
  startWorkerAttemptAndPrepareLaunchInTx,
  getExecutionStageInTx,
  deriveStageCompletionValidationRequirement,
} from "./v020-e2e-helpers.js";

describe("P4: Model Deterministic Transaction Bookkeeping & Current Assessment Context E2E", () => {
  it("relieves model of mechanical hash copying while strictly enforcing optimistic CAS, report coverage, and idempotency", async () => {
    const world = await makeAcceptanceWorld("P4-E2E");

    // -------------------------------------------------------------------------
    // 1. Generate multiple ImplementationReports and VerificationReports
    // -------------------------------------------------------------------------
    // First implementation attempt: candidate 0 -> 1
    const impl1 = runImplementation(world, {
      directiveId: "DIR-P4-IMPL-1",
      candidateMutated: true,
      reportOverrides: {
        actions_performed: [{ action: "code", detail: "added feature logic" }],
        files_changed: ["src/feature.ts"],
      },
    });

    // Two verification attempts at candidate 2: ver1a and ver1b
    const ver1a = runFreshVerifier(world, {
      directiveId: "DIR-P4-VER-1A",
      reportOverrides: {
        tests_run: [{ name: "suite-1a", outcome: "pass", detail: null }],
      },
    });

    const ver1b = runFreshVerifier(world, {
      directiveId: "DIR-P4-VER-1B",
      reportOverrides: {
        tests_run: [{ name: "suite-1b", outcome: "pass", detail: null }],
      },
    });

    expect(currentRevision(world)).toBe(2);

    // -------------------------------------------------------------------------
    // 2. Test Incomplete Report Coverage Detection (Requirement 4)
    // -------------------------------------------------------------------------
    // Retrieve canonical acceptance context
    const ctx1 = supervisorCall(world, "get_execution_acceptance_context", {}) as {
      status: string;
      candidate: { revision: number };
      assessment_token: string;
      open_window: { id: string };
    };
    expect(ctx1.status).toBe("ok");
    expect(ctx1.candidate.revision).toBe(2);
    expect(ctx1.assessment_token).toBeTruthy();

    // Supervisor attempts to submit judgment covering ONLY ver1a.reportId, omitting ver1b
    let coverageErrCode = "no-error";
    try {
      supervisorCall(world, "submit_supervisor_assessment", {
        disposition: "accept",
        rationale: "Only checked ver1a, omitted ver1b",
        assessment_token: ctx1.assessment_token,
        report_judgments: [
          { report_id: ver1a.reportId, disposition: "supporting" },
        ],
      });
    } catch (err: any) {
      coverageErrCode = err.code ?? "no-error";
    }
    expect(coverageErrCode).toBe("ASSESSMENT_REPORT_COVERAGE_INCOMPLETE");

    // -------------------------------------------------------------------------
    // 3. Concurrency / Stale Candidate Protection (Requirements 5, 6)
    // -------------------------------------------------------------------------
    // Another operation mutates the candidate (candidate 2 -> 3)
    const impl2 = runImplementation(world, {
      directiveId: "DIR-P4-IMPL-2",
      candidateMutated: true,
      reportOverrides: {
        actions_performed: [{ action: "refine", detail: "refined feature logic" }],
        files_changed: ["src/feature.ts"],
      },
    });
    expect(currentRevision(world)).toBe(3);

    // Attempting to submit using the OLD assessment_token (bound to revision 2)
    let staleErrCode = "no-error";
    try {
      supervisorCall(world, "submit_supervisor_assessment", {
        disposition: "accept",
        rationale: "Submitting stale assessment",
        assessment_token: ctx1.assessment_token,
        report_judgments: [
          { report_id: ver1a.reportId, disposition: "supporting" },
          { report_id: ver1b.reportId, disposition: "supporting" },
        ],
      });
    } catch (err: any) {
      staleErrCode = err.code ?? "no-error";
    }
    // Optimistic lock prevents stale acceptance!
    expect(staleErrCode).toBe("SUPERVISOR_ASSESSMENT_STALE");

    // Verify NO commit was created
    const boundsAfterStale = boundariesOf(world);
    expect(boundsAfterStale.acceptedHead).toBeNull();
    expect(boundsAfterStale.commits).toHaveLength(0);

    // -------------------------------------------------------------------------
    // 4. Refresh Context, Evaluate All Reports, and Submit Simplified Assessment (Requirements 2, 3, 7)
    // -------------------------------------------------------------------------
    // Run fresh verifier at current candidate (revision 3) covering stage completion
    const stage = world.ctx.store.withRead((tx: any) => getExecutionStageInTx(tx, world.activeStageId))!;
    const stageReq = deriveStageCompletionValidationRequirement(stage);
    const ver2 = runFreshVerifier(world, {
      directiveId: "DIR-P4-VER-2",
      validationRequirements: [stageReq],
      reportOverrides: {
        tests_run: [{ name: "suite-2", outcome: "pass", detail: null }],
      },
    });

    // Refresh acceptance context
    const ctx2 = supervisorCall(world, "get_execution_acceptance_context", {}) as {
      status: string;
      candidate: { revision: number };
      assessment_token: string;
    };
    expect(ctx2.candidate.revision).toBe(3);

    // Simplified semantic submission:
    // - No manual expected_candidate_revision (bound in assessment_token)
    // - No manual covered_obligations with SHA256 hashes (Core auto-attaches stage_objective obligation)
    // - Explicit semantic judgments for all current-candidate reports
    const acceptResult = supervisorCall(world, "submit_supervisor_assessment", {
      disposition: "accept",
      rationale: "All reports evaluated; fresh verification confirms candidate 3 satisfies stage objective",
      assessment_token: ctx2.assessment_token,
      complete_stage: true,
      report_judgments: [
        { report_id: ver2.reportId, disposition: "supporting" },
      ],
    }) as {
      status: string;
      commit: { id: string; sequence: number };
      stage_completed: boolean;
      accepted_head: string;
    };

    expect(acceptResult.status).toBe("accepted");
    expect(acceptResult.commit).toBeDefined();
    expect(acceptResult.stage_completed).toBe(true);
    expect(acceptResult.accepted_head).toBe(acceptResult.commit.id);

    const boundsAfterAccept = boundariesOf(world);
    expect(boundsAfterAccept.acceptedHead).toBe(acceptResult.commit.id);
    expect(boundsAfterAccept.stages[0]!.status).toBe("completed");
    expect(boundsAfterAccept.commits).toHaveLength(1);

    // -------------------------------------------------------------------------
    // 5. Idempotent Retry Convergence (Requirement 8)
    // -------------------------------------------------------------------------
    // Re-submitting the exact same request converges idempotently
    const retryResult = supervisorCall(world, "submit_supervisor_assessment", {
      disposition: "accept",
      rationale: "All reports evaluated; fresh verification confirms candidate 3 satisfies stage objective",
      assessment_token: ctx2.assessment_token,
      complete_stage: true,
      report_judgments: [
        { report_id: ver2.reportId, disposition: "supporting" },
      ],
    }) as {
      status: string;
      commit: { id: string };
      idempotent: boolean;
    };

    expect(retryResult.idempotent).toBe(true);
    expect(retryResult.commit.id).toBe(acceptResult.commit.id);

    // Confirms total commits in the store is still exactly 1 (no duplicate commit)
    const boundsAfterRetry = boundariesOf(world);
    expect(boundsAfterRetry.commits).toHaveLength(1);
  });
});
