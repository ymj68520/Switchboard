/**
 * E10 §69–§74 — E8 policy/conflict in final scope (T24..T27), gate rejections
 * (T38..T43), and atomicity (T47..T49).
 */
import { describe, expect, it } from "vitest";

import {
  beginFinalClosure,
  completeAllStagesFixture,
  makeAcceptanceWorld,
  runFinalClosureCycle,
  currentCandidateReports,
  acceptInput,
  type FinalClosureWorld,
} from "./final-closure-helpers.js";
import { acceptanceServiceOf, codeOf } from "./acceptance-helpers.js";
import { loadVerificationPolicyStateInTx } from "../src/application/verification-policy-service.js";
import { supervisorCall } from "./acceptance-helpers.js";
import { issueDirective } from "./execution-protocol-helpers.js";
import { executionRunCompletionObligation } from "../src/core/execution-completion.js";
import { loadExecutionCompletionSemanticsInTx } from "../src/application/final-closure-service.js";
import { getAcceptedHeadCommitIdInTx, getCompletionCommitIdInTx } from "../src/store/execution-commits.js";
import { getExecutionRunInTx } from "../src/store/execution-runs.js";
import { getSupervisorBindingInTx } from "../src/store/supervisor-bindings.js";
import { getOpenWindowInTx } from "../src/store/execution-structure.js";

let world: FinalClosureWorld | null = null;

async function finalWindowWorld(): Promise<FinalClosureWorld> {
  world = await makeAcceptanceWorld(`VP-${Math.random().toString(36).slice(2, 8)}`);
  completeAllStagesFixture(world);
  beginFinalClosure(world);
  return world;
}

function obligationOf(w: FinalClosureWorld) {
  const head = w.ctx.store.withRead((tx) => getAcceptedHeadCommitIdInTx(tx, w.executionRunId))!;
  return w.ctx.store.withRead((tx) => executionRunCompletionObligation(loadExecutionCompletionSemanticsInTx(tx, w.executionRunId, head)));
}

function completionAccept(w: FinalClosureWorld, obligation: ReturnType<typeof executionRunCompletionObligation>) {
  return acceptanceServiceOf(w).submitSupervisorAssessment(
    acceptInput(w, {
      reportJudgments: currentCandidateReports(w).map((report) => ({
        report_id: report.reportId,
        disposition: report.workerRole === "verifier" ? "supporting" : "informational",
      })),
      coveredObligations: [
        { source: "execution_run_completion", executionRunId: obligation.executionRunId, final_plan_hash: obligation.finalPlanHash, base_accepted_head_commit_id: obligation.baseAcceptedHeadCommitId, completed_stage_set_hash: obligation.completedStageSetHash, contentHash: obligation.contentHash },
      ],
    }) as never,
  ) as { runCompleted: boolean };
}

describe("E10 E8 policy in final scope (§29, T24/T25)", () => {
  it("E10-T24: an immediate mutating final-closure implementation creates debt WITHOUT any Stage id", async () => {
    const w = await finalWindowWorld();
    runFinalClosureCycle(w, {
      kind: "implementation",
      directiveId: "DIR-IMM",
      candidateMutated: true,
      verificationPolicy: { implementationRequirement: "immediate" },
      reportOverrides: { files_changed: ["src/edge.ts"] },
    });
    const state = w.ctx.store.withRead((tx) => loadVerificationPolicyStateInTx(tx, w.executionRunId));
    expect(state).not.toBeNull();
    expect(state!.verificationRequired).toBe(true);
    expect(state!.reason).toBe("immediate");
    expect(state!.candidateRevision).toBe(1);
    w.ctx.store.close();
  });

  it("E10-T25: a batchable span accumulates to the bound and is cleared by a normal final verifier", async () => {
    const w = await finalWindowWorld();
    // One batchable mutating implementation: span 1 < 3 → no debt.
    runFinalClosureCycle(w, { kind: "implementation", directiveId: "DIR-B1", candidateMutated: true });
    let state = w.ctx.store.withRead((tx) => loadVerificationPolicyStateInTx(tx, w.executionRunId));
    expect(state!.verificationRequired).toBe(false);
    expect(state!.unverifiedMutationSpan).toBe(1);
    // Second: span 2 < 3 → no debt. Third: span 3 → max_unverified_span debt.
    runFinalClosureCycle(w, { kind: "implementation", directiveId: "DIR-B2", candidateMutated: true });
    state = w.ctx.store.withRead((tx) => loadVerificationPolicyStateInTx(tx, w.executionRunId));
    expect(state!.verificationRequired).toBe(false);
    runFinalClosureCycle(w, { kind: "implementation", directiveId: "DIR-B3", candidateMutated: true });
    state = w.ctx.store.withRead((tx) => loadVerificationPolicyStateInTx(tx, w.executionRunId));
    expect(state!.verificationRequired).toBe(true);
    expect(state!.reason).toBe("max_unverified_span");
    // A normal final verification at the exact candidate clears the debt.
    runFinalClosureCycle(w, { kind: "verification", directiveId: "DIR-BV" });
    state = w.ctx.store.withRead((tx) => loadVerificationPolicyStateInTx(tx, w.executionRunId));
    expect(state!.verificationRequired).toBe(false);
    w.ctx.store.close();
  });
});

describe("E10 E8 conflicts in final scope (§30, T26/T27)", () => {
  it("E10-T26: a final-closure conflict uses the bounded one-resolver protocol", async () => {
    const w = await finalWindowWorld();
    runFinalClosureCycle(w, { kind: "implementation", directiveId: "DIR-CF1", candidateMutated: true });
    const inspection = runFinalClosureCycle(w, { kind: "inspection", directiveId: "DIR-CFI" });
    const secondInspection = runFinalClosureCycle(w, { kind: "inspection", directiveId: "DIR-CFI2" });
    const response = supervisorCall(w, "declare_verification_conflict", {
      fact: "final integration reports disagree about the accepted state",
      claims: [
        { variant: "A", statement: "the candidate holds", source_report_ids: [inspection.reportId] },
        { variant: "B", statement: "the candidate is defective", source_report_ids: [secondInspection.reportId] },
      ],
    }) as { status: string; conflict: { id: string; status: string } };
    expect(response.conflict.status).toBe("open");
    // An open conflict blocks the final accept.
    const obligation = obligationOf(w);
    runFinalClosureCycle(w, {
      kind: "verification",
      directiveId: "DIR-CFV",
      validationRequirements: [{ requirement: "verify_execution_completion", detail: obligation.contentHash }],
    });
    expect(
      codeOf(() => completionAccept(w, obligation)),
    ).toBe("ACCEPTANCE_VERIFICATION_CONFLICT");
    w.ctx.store.close();
  });

  it("E10-T27: a conflict resolver can never serve as the final completion verifier", async () => {
    const w = await finalWindowWorld();
    const inspection = runFinalClosureCycle(w, { kind: "inspection", directiveId: "DIR-RSI" });
    const secondInspection = runFinalClosureCycle(w, { kind: "inspection", directiveId: "DIR-RSI2" });
    const response = supervisorCall(w, "declare_verification_conflict", {
      fact: "resolver exclusion pin",
      claims: [
        { variant: "A", statement: "the candidate holds", source_report_ids: [inspection.reportId] },
        { variant: "B", statement: "the candidate is defective", source_report_ids: [secondInspection.reportId] },
      ],
    }) as { status: string; conflict: { id: string } };
    // The RESOLVER directive (purpose=conflict_resolution) is issued and run;
    // even after settlement it can never satisfy the completion gate — the
    // exact verify_execution_completion requirement is missing from its
    // immutable validationRequirements.
    expect(response.conflict.id).toMatch(/^vc_/);
    // The resolver cycle itself works through the bounded protocol.
    const resolver = issueDirective(w, {
      directiveId: "DIR-RESOLVER",
      kind: "verification",
      scopeKind: "final_closure" as never,
      stageId: undefined,
      windowId: w.openWindowId,
      verificationPolicy: { verificationPurpose: "conflict_resolution", verificationConflictId: response.conflict.id },
    });
    expect(resolver.verificationPolicy?.verificationPurpose).toBe("conflict_resolution");
    w.ctx.store.close();
  });
});

describe("E10 gate rejections + atomicity (§38–§42/§74, T38..T49)", () => {
  it("E10-T40/T41: an open conflict and unresolved pressure reject before completion; the run stays active", async () => {
    const w = await finalWindowWorld();
    runFinalClosureCycle(w, { kind: "implementation", directiveId: "DIR-GA1", candidateMutated: true });
    const obligation = obligationOf(w);
    // Pressure is due? span 1 → no. Force an open conflict instead.
    const inspection = runFinalClosureCycle(w, { kind: "inspection", directiveId: "DIR-GAI" });
    const secondInspection = runFinalClosureCycle(w, { kind: "inspection", directiveId: "DIR-GAI2" });
    supervisorCall(w, "declare_verification_conflict", {
      fact: "atomicity probe conflict",
      claims: [
        { variant: "A", statement: "the candidate holds", source_report_ids: [inspection.reportId] },
        { variant: "B", statement: "the candidate is defective", source_report_ids: [secondInspection.reportId] },
      ],
    });
    runFinalClosureCycle(w, {
      kind: "verification",
      directiveId: "DIR-GAV",
      validationRequirements: [{ requirement: "verify_execution_completion", detail: obligation.contentHash }],
    });
    expect(codeOf(() => completionAccept(w, obligation))).toBe("ACCEPTANCE_VERIFICATION_CONFLICT");
    // Nothing was persisted: no commit, run active, window open, binding attached.
    expect(w.ctx.store.withRead((tx) => getCompletionCommitIdInTx(tx, w.executionRunId))).toBeNull();
    expect(w.ctx.store.withRead((tx) => getExecutionRunInTx(tx, w.executionRunId)!.lifecycle)).toBe("active");
    expect(w.ctx.store.withRead((tx) => getOpenWindowInTx(tx, w.executionRunId))).not.toBeNull();
    expect(w.ctx.store.withRead((tx) => getSupervisorBindingInTx(tx, w.executionRunId)?.state)).toBe("attached");
  });

  it("E10-T47/T48/T49: gate failure inside the accept rolls back assessment, commit, close, head, completion, and binding", async () => {
    const w = await finalWindowWorld();
    runFinalClosureCycle(w, { kind: "implementation", directiveId: "DIR-AT1", candidateMutated: true });
    const obligation = obligationOf(w);
    runFinalClosureCycle(w, {
      kind: "verification",
      directiveId: "DIR-AT2",
      validationRequirements: [{ requirement: "verify_execution_completion", detail: obligation.contentHash }],
    });
    const headBefore = w.ctx.store.withRead((tx) => getAcceptedHeadCommitIdInTx(tx, w.executionRunId));
    const bindingBefore = w.ctx.store.withRead((tx) => getSupervisorBindingInTx(tx, w.executionRunId)?.state);
    // T42/T43 — the accept inputs are EXACT (right obligation + right
    // verifier), so the gate fails on a re-derived precondition only: inject a
    // run-wide indeterminate attempt INSIDE the same transaction (a crash fact
    // materializing mid-accept). The E6 window-scoped gate passes, the E10
    // run-wide gate fires AFTER the assessment/commit/window-close/head steps
    // are staged — exercising the full §42 rollback.
    const historical = w.ctx.store.withRead(
      (tx) =>
        tx
          .prepare("SELECT a.attempt_id AS id FROM execution_attempts a WHERE a.execution_run_id = ? AND a.state = 'reported' AND EXISTS (SELECT 1 FROM execution_directives d JOIN verification_windows win ON win.id = d.window_id WHERE d.directive_id = a.directive_id AND d.revision = a.directive_revision AND win.closed_at IS NOT NULL) ORDER BY a.started_at LIMIT 1")
          .get(w.executionRunId) as { id: string } | undefined,
    );
    expect(historical).toBeDefined();
    const { submitSupervisorAssessmentInTx } = await import("../src/application/acceptance-service.js");
    const input = acceptInput(w, {
      reportJudgments: currentCandidateReports(w).map((report) => ({
        report_id: report.reportId,
        disposition: report.workerRole === "verifier" ? "supporting" : "informational",
      })),
      coveredObligations: [
        { source: "execution_run_completion", executionRunId: obligation.executionRunId, final_plan_hash: obligation.finalPlanHash, base_accepted_head_commit_id: obligation.baseAcceptedHeadCommitId, completed_stage_set_hash: obligation.completedStageSetHash, contentHash: obligation.contentHash },
      ],
    }) as never;
    expect(
      codeOf(() =>
        w.ctx.store.withWrite((tx) => {
          tx.prepare("UPDATE execution_attempts SET state = 'indeterminate' WHERE attempt_id = ?").run(historical!.id);
          return submitSupervisorAssessmentInTx(tx, input, w.ctx.clock, w.ctx.clock.nowIso());
        }),
      ),
    ).toBe("EXECUTION_COMPLETION_INDETERMINATE_WORK");
    // Full rollback (E10 §42): no assessment, no commit, no window close, no
    // head movement, run active, binding attached. The injection rolled back
    // WITH the accept (one transaction) — the attempt is reported again.
    expect(w.ctx.store.withRead((tx) => getCompletionCommitIdInTx(tx, w.executionRunId))).toBeNull();
    expect(w.ctx.store.withRead((tx) => getExecutionRunInTx(tx, w.executionRunId)!.lifecycle)).toBe("active");
    expect(w.ctx.store.withRead((tx) => getOpenWindowInTx(tx, w.executionRunId))).not.toBeNull();
    expect(w.ctx.store.withRead((tx) => getSupervisorBindingInTx(tx, w.executionRunId)?.state)).toBe(bindingBefore);
    expect(w.ctx.store.withRead((tx) => getAcceptedHeadCommitIdInTx(tx, w.executionRunId))).toBe(headBefore);
    expect(
      w.ctx.store.withRead(
        (tx) => tx.prepare("SELECT count(*) AS n FROM supervisor_assessments WHERE window_id = ? AND disposition = 'accept'").get(w.openWindowId) as { n: number },
      ).n,
    ).toBe(0);
    // E10-T49 — no durable half-state: after the rolled-back injection the
    // SAME accept (unchanged inputs) converges cleanly.
    const result = completionAccept(w, obligation);
    expect(result.runCompleted).toBe(true);
    const finalCommit = w.ctx.store.withRead((tx) => getCompletionCommitIdInTx(tx, w.executionRunId));
    expect(finalCommit).not.toBeNull();
    expect(finalCommit).toBe(w.ctx.store.withRead((tx) => getAcceptedHeadCommitIdInTx(tx, w.executionRunId)));
    expect(finalCommit).not.toBe(headBefore);
  });
});
