/**
 * E10 §70–§72 — completion obligation, Final ExecutionCommit, and the
 * ExecutionCompletionGate (E10-T28..T49) plus terminality (T50..T55).
 */
import { describe, expect, it } from "vitest";

import {
  beginFinalClosure,
  currentCandidateReports,
  completeAllStagesFixture,
  makeAcceptanceWorld,
  runFinalClosureCycle,
  runFinalCompletionFixture,
  acceptInput,
  type FinalClosureWorld,
} from "./final-closure-helpers.js";
import { acceptanceServiceOf, codeOf, takeoverTo } from "./acceptance-helpers.js";
import { executionRunCompletionObligation } from "../src/core/execution-completion.js";
import { loadExecutionCompletionSemanticsInTx } from "../src/application/final-closure-service.js";
import { getExecutionRunInTx } from "../src/store/execution-runs.js";
import { getAcceptedHeadCommitIdInTx, getCompletionCommitIdInTx } from "../src/store/execution-commits.js";
import { getSupervisorBindingInTx } from "../src/store/supervisor-bindings.js";
import { listRunAttemptsInTx } from "../src/store/execution-attempts.js";

import { issueDirective } from "./execution-protocol-helpers.js";
import { startExecutionAttemptInTx } from "../src/application/execution-attempt-service.js";

let world: FinalClosureWorld | null = null;

async function finalWindowWorld(): Promise<FinalClosureWorld> {
  world = await makeAcceptanceWorld(`GC-${Math.random().toString(36).slice(2, 8)}`);
  completeAllStagesFixture(world);
  beginFinalClosure(world);
  return world;
}

describe("E10 completion obligation (§21–§26, T28..T32)", () => {
  it("E10-T28: the obligation is deterministic over the same run/plan/stage-set/head", async () => {
    const w = await makeAcceptanceWorld(`OB-${Math.random().toString(36).slice(2, 8)}`);
    completeAllStagesFixture(w);
    const head = w.ctx.store.withRead((tx) => getAcceptedHeadCommitIdInTx(tx, w.executionRunId))!;
    const a = w.ctx.store.withRead((tx) => executionRunCompletionObligation(loadExecutionCompletionSemanticsInTx(tx, w.executionRunId, head)));
    const b = w.ctx.store.withRead((tx) => executionRunCompletionObligation(loadExecutionCompletionSemanticsInTx(tx, w.executionRunId, head)));
    expect(a).toEqual(b);
    w.ctx.store.close();
  });

  it("E10-T29: different completion provenance yields a different obligation identity", async () => {
    const w = await makeAcceptanceWorld(`OB2-${Math.random().toString(36).slice(2, 8)}`);
    completeAllStagesFixture(w);
    const head = w.ctx.store.withRead((tx) => getAcceptedHeadCommitIdInTx(tx, w.executionRunId))!;
    const semantics = w.ctx.store.withRead((tx) => loadExecutionCompletionSemanticsInTx(tx, w.executionRunId, head));
    const real = executionRunCompletionObligation(semantics);
    // A different Stage-set hash (e.g. one Stage completed by another commit)
    // changes the identity.
    const mutated = { ...semantics, completedStages: semantics.completedStages.map((stage, index) => (index === 0 ? { ...stage, completedByCommitId: "ec_other" } : stage)) };
    const other = executionRunCompletionObligation(mutated);
    expect(other.completedStageSetHash).not.toBe(real.completedStageSetHash);
    expect(other.contentHash).not.toBe(real.contentHash);
    // A different base head changes the identity too.
    const otherBase = executionRunCompletionObligation({ ...semantics, baseAcceptedHeadCommitId: "ec_other_base" });
    expect(otherBase.contentHash).not.toBe(real.contentHash);
    w.ctx.store.close();
  });

  it("E10-T30: a wrong/stale completion obligation is rejected", async () => {
    const w = await finalWindowWorld();
    runFinalClosureCycle(w, { kind: "implementation", directiveId: "DIR-O1", candidateMutated: true });
    const head = w.ctx.store.withRead((tx) => getAcceptedHeadCommitIdInTx(tx, w.executionRunId))!;
    const semantics = w.ctx.store.withRead((tx) => loadExecutionCompletionSemanticsInTx(tx, w.executionRunId, head));
    const obligation = executionRunCompletionObligation(semantics);
    runFinalClosureCycle(w, {
      kind: "verification",
      directiveId: "DIR-O2",
      validationRequirements: [{ requirement: "verify_execution_completion", detail: obligation.contentHash }],
    });
    // A fabricated contentHash fails the re-derivation.
    expect(
      codeOf(() =>
        acceptanceServiceOf(w).submitSupervisorAssessment(
          acceptInput(w, {
            reportJudgments: currentCandidateReports(w).map((report) => ({ report_id: report.reportId, disposition: report.workerRole === "verifier" ? "supporting" : "informational" })),
            coveredObligations: [
              { source: "execution_run_completion", executionRunId: obligation.executionRunId, final_plan_hash: obligation.finalPlanHash, base_accepted_head_commit_id: obligation.baseAcceptedHeadCommitId, completed_stage_set_hash: obligation.completedStageSetHash, contentHash: "sha256:" + "0".repeat(64) },
            ],
          }) as never,
        ),
      ),
    ).toBe("EXECUTION_COMPLETION_OBLIGATION_INVALID");
    // A missing obligation fails REQUIRED.
    expect(
      codeOf(() =>
        acceptanceServiceOf(w).submitSupervisorAssessment(acceptInput(w, { coveredObligations: [] }) as never),
      ),
    ).toBe("EXECUTION_COMPLETION_OBLIGATION_REQUIRED");
  });

  it("E10-T31/T32: a generic verifier cannot complete the run; the exact requirement satisfies the special gate", async () => {
    const w = await finalWindowWorld();
    runFinalClosureCycle(w, { kind: "implementation", directiveId: "DIR-G1", candidateMutated: true });
    const head = w.ctx.store.withRead((tx) => getAcceptedHeadCommitIdInTx(tx, w.executionRunId))!;
    const obligation = w.ctx.store.withRead((tx) => executionRunCompletionObligation(loadExecutionCompletionSemanticsInTx(tx, w.executionRunId, head)));
    // GENERIC verifier: a normal completed verification WITHOUT the completion
    // requirement. The accept must fail with EXECUTION_COMPLETION_VERIFICATION_REQUIRED.
    runFinalClosureCycle(w, { kind: "verification", directiveId: "DIR-G2" });
    expect(
      codeOf(() =>
        acceptanceServiceOf(w).submitSupervisorAssessment(
          acceptInput(w, {
            reportJudgments: currentCandidateReports(w).map((report) => ({ report_id: report.reportId, disposition: report.workerRole === "verifier" ? "supporting" : "informational" })),
            coveredObligations: [
              { source: "execution_run_completion", executionRunId: obligation.executionRunId, final_plan_hash: obligation.finalPlanHash, base_accepted_head_commit_id: obligation.baseAcceptedHeadCommitId, completed_stage_set_hash: obligation.completedStageSetHash, contentHash: obligation.contentHash },
            ],
          }) as never,
        ),
      ),
    ).toBe("EXECUTION_COMPLETION_VERIFICATION_REQUIRED");
    // EXACT verifier: a fresh verifier whose directive carries the requirement.
    runFinalClosureCycle(w, {
      kind: "verification",
      directiveId: "DIR-G3",
      validationRequirements: [{ requirement: "verify_execution_completion", detail: obligation.contentHash }],
    });
    const result = acceptanceServiceOf(w).submitSupervisorAssessment(
      acceptInput(w, {
        reportJudgments: currentCandidateReports(w).map((report) => ({ report_id: report.reportId, disposition: report.workerRole === "verifier" ? "supporting" : "informational" })),
        coveredObligations: [
          { source: "execution_run_completion", executionRunId: obligation.executionRunId, final_plan_hash: obligation.finalPlanHash, base_accepted_head_commit_id: obligation.baseAcceptedHeadCommitId, completed_stage_set_hash: obligation.completedStageSetHash, contentHash: obligation.contentHash },
        ],
      }) as never,
    ) as { runCompleted: boolean };
    expect(result.runCompleted).toBe(true);
  });
});

describe("E10 Final ExecutionCommit (§34–§37, T33..T36)", () => {
  it("E10-T33/T34/T35/T36: the final accept produces the final-closure commit on the same linear chain with complete provenance", async () => {
    const w = await makeAcceptanceWorld(`FC-${Math.random().toString(36).slice(2, 8)}`);
    completeAllStagesFixture(w);
    beginFinalClosure(w);
    runFinalClosureCycle(w, { kind: "implementation", directiveId: "DIR-C1", candidateMutated: true });
    const completion = runFinalCompletionFixture(w);
    expect(completion.runCompleted).toBe(true);
    const commit = w.ctx.store.withRead((tx) => {
      const row = tx
        .prepare("SELECT commit_id AS id, scope_kind AS scopeKind, stage_id AS stageId, parent_commit_id AS parent, window_id AS windowId, candidate_revision AS revision, directive_refs_json AS directives, report_refs_json AS reports FROM execution_commits WHERE execution_run_id = ? ORDER BY sequence")
        .all(w.executionRunId) as Array<{ id: string; scopeKind: string; stageId: string | null; parent: string | null; windowId: string; revision: number; directives: string; reports: string }>;
      return row;
    });
    expect(commit.length).toBeGreaterThanOrEqual(3);
    const final = commit[commit.length - 1]!;
    expect(final.scopeKind).toBe("final_closure");
    expect(final.stageId).toBeNull();
    expect(final.id).toBe(completion.commitId);
    // The parent is the LAST STAGE commit (the acceptedHead before closure).
    const priorHead = commit[commit.length - 2]!;
    expect(final.parent).toBe(priorHead.id);
    expect(priorHead.scopeKind).toBe("stage");
    // Provenance: all final-window directives and reports.
    const directives = JSON.parse(final.directives) as unknown[];
    const reports = JSON.parse(final.reports) as unknown[];
    expect(directives.length).toBeGreaterThanOrEqual(2);
    expect(reports.length).toBeGreaterThanOrEqual(2);
    // acceptedHead == completion_commit_id == final commit.
    const run = w.ctx.store.withRead((tx) => getExecutionRunInTx(tx, w.executionRunId)!);
    expect(run.lifecycle).toBe("completed");
    const head = w.ctx.store.withRead((tx) => getAcceptedHeadCommitIdInTx(tx, w.executionRunId));
    const completionCommit = w.ctx.store.withRead((tx) => getCompletionCommitIdInTx(tx, w.executionRunId));
    expect(head).toBe(final.id);
    expect(completionCommit).toBe(final.id);
  });
});

describe("E10 ExecutionCompletionGate (§38–§45, T37..T49)", () => {
  it("E10-T37: valid final closure atomically completes (lifecycle, provenance, detached binding)", async () => {
    const w = await makeAcceptanceWorld(`GA-${Math.random().toString(36).slice(2, 8)}`);
    completeAllStagesFixture(w);
    beginFinalClosure(w);
    const completion = runFinalCompletionFixture(w);
    expect(completion.runCompleted).toBe(true);
    const binding = w.ctx.store.withRead((tx) => getSupervisorBindingInTx(tx, w.executionRunId));
    expect(binding?.state).toBe("detached");
    // The generation is preserved (detach is not takeover).
    expect(binding?.generation).toBe(w.f.generation);
  });

  it("E10-T44/T45: an unresolved indeterminate Attempt blocks completion and is never replayed", async () => {
    const w = await finalWindowWorld();
    // E10-T44 — ANY indeterminate attempt ANYWHERE in the run fails the gate.
    // The fixture marks a HISTORICAL (earlier-stage-window) attempt
    // indeterminate the way a real crash-recovery path records it; the current
    // window's evidence is clean, so the E6 window gate passes and the E10
    // run-wide gate is what fires.
    const historical = w.ctx.store.withRead(
      (tx) =>
        tx
          .prepare("SELECT a.attempt_id AS id FROM execution_attempts a WHERE a.execution_run_id = ? AND a.state = 'reported' AND EXISTS (SELECT 1 FROM execution_directives d JOIN verification_windows w ON w.id = d.window_id WHERE d.directive_id = a.directive_id AND d.revision = a.directive_revision AND w.closed_at IS NOT NULL) ORDER BY a.started_at LIMIT 1")
          .get(w.executionRunId) as { id: string } | undefined,
    );
    expect(historical).toBeDefined();
    w.ctx.store.withWrite((tx) => {
      tx.prepare("UPDATE execution_attempts SET state = 'indeterminate' WHERE attempt_id = ?").run(historical!.id);
    });
    runFinalClosureCycle(w, { kind: "implementation", directiveId: "DIR-IND", candidateMutated: true });
    const head = w.ctx.store.withRead((tx) => getAcceptedHeadCommitIdInTx(tx, w.executionRunId))!;
    const obligation = w.ctx.store.withRead((tx) => executionRunCompletionObligation(loadExecutionCompletionSemanticsInTx(tx, w.executionRunId, head)));
    runFinalClosureCycle(w, {
      kind: "verification",
      directiveId: "DIR-INDV",
      validationRequirements: [{ requirement: "verify_execution_completion", detail: obligation.contentHash }],
    });
    expect(
      codeOf(() =>
        acceptanceServiceOf(w).submitSupervisorAssessment(
          acceptInput(w, {
            reportJudgments: currentCandidateReports(w).map((report) => ({ report_id: report.reportId, disposition: report.workerRole === "verifier" ? "supporting" : "informational" })),
            coveredObligations: [
              { source: "execution_run_completion", executionRunId: obligation.executionRunId, final_plan_hash: obligation.finalPlanHash, base_accepted_head_commit_id: obligation.baseAcceptedHeadCommitId, completed_stage_set_hash: obligation.completedStageSetHash, contentHash: obligation.contentHash },
            ],
          }) as never,
        ),
      ),
    ).toBe("EXECUTION_COMPLETION_INDETERMINATE_WORK");
    // E10-T45 — the indeterminate attempt is untouched (no replay, no report).
    const attempt = w.ctx.store.withRead((tx) => listRunAttemptsInTx(tx, w.executionRunId).find((a) => a.attemptId === historical!.id));
    expect(attempt?.state).toBe("indeterminate");
  });

  it("E10-T46: a running Attempt blocks the gate", async () => {
    const w = await finalWindowWorld();
    runFinalClosureCycle(w, { kind: "implementation", directiveId: "DIR-RUN", candidateMutated: true });
    const head = w.ctx.store.withRead((tx) => getAcceptedHeadCommitIdInTx(tx, w.executionRunId))!;
    const obligation = w.ctx.store.withRead((tx) => executionRunCompletionObligation(loadExecutionCompletionSemanticsInTx(tx, w.executionRunId, head)));
    // A final-closure inspection whose attempt is started and NEVER reports.
    const pending = issueDirective(w, { directiveId: "DIR-RUNV", kind: "inspection", scopeKind: "final_closure" as never, stageId: undefined, windowId: w.openWindowId });
    w.ctx.store.withWrite((tx) =>
      startExecutionAttemptInTx(
        tx,
        {
          executionRunId: w.executionRunId,
          sessionId: w.f.sessionId,
          workspaceId: w.f.workspaceId,
          generation: w.f.generation,
          directiveId: pending.directiveId,
          directiveRevision: pending.revision,
          directiveHash: pending.hash,
          workerRole: "executor",
        },
        w.ctx.clock,
        w.ctx.clock.nowIso(),
      ),
    );
    expect(
      codeOf(() =>
        acceptanceServiceOf(w).submitSupervisorAssessment(
          acceptInput(w, {
            reportJudgments: currentCandidateReports(w).map((report) => ({ report_id: report.reportId, disposition: report.workerRole === "verifier" ? "supporting" : "informational" })),
            coveredObligations: [
              { source: "execution_run_completion", executionRunId: obligation.executionRunId, final_plan_hash: obligation.finalPlanHash, base_accepted_head_commit_id: obligation.baseAcceptedHeadCommitId, completed_stage_set_hash: obligation.completedStageSetHash, contentHash: obligation.contentHash },
            ],
          }) as never,
        ),
      ),
    ).toBe("ACCEPTANCE_ATTEMPT_RUNNING");
    const lifecycle = w.ctx.store.withRead((tx) => getExecutionRunInTx(tx, w.executionRunId)!.lifecycle);
    expect(lifecycle).toBe("active");
  });

  it("E10-T50..T55: a completed run is terminal — no mutation path reopens it", async () => {
    const w = await makeAcceptanceWorld(`TB-${Math.random().toString(36).slice(2, 8)}`);
    completeAllStagesFixture(w);
    beginFinalClosure(w);
    runFinalCompletionFixture(w);
    // No directive issuance (supervisor authority requires an active run).
    expect(codeOf(() => issueDirective(w, { directiveId: "DIR-DEAD", kind: "inspection" }))).toBe("SUPERVISOR_BINDING_REQUIRED");
    // No attempt start.
    expect(
      codeOf(() =>
        w.ctx.store.withWrite((tx) =>
          startExecutionAttemptInTx(
            tx,
            {
              executionRunId: w.executionRunId,
              sessionId: w.f.sessionId,
              workspaceId: w.f.workspaceId,
              generation: w.f.generation,
              directiveId: "DIR-ANY",
              directiveRevision: 1,
              directiveHash: "sha256:x",
              workerRole: "executor",
            },
            w.ctx.clock,
            w.ctx.clock.nowIso(),
          ),
        ),
      ),
    ).toBe("SUPERVISOR_BINDING_REQUIRED");
    // No Stage progression.
    const { continueExecutionStageInTx, activateExecutionStageInTx } = await import("../src/application/execution-progression-service.js");
    expect(
      codeOf(() =>
        w.ctx.store.withWrite((tx) =>
          continueExecutionStageInTx(tx, { executionRunId: w.executionRunId, sessionId: w.f.sessionId, workspaceId: w.f.workspaceId, generation: w.f.generation }, w.ctx.clock, w.ctx.clock.nowIso()),
        ),
      ),
    ).toBe("SUPERVISOR_BINDING_REQUIRED");
    expect(
      codeOf(() =>
        w.ctx.store.withWrite((tx) =>
          activateExecutionStageInTx(tx, { executionRunId: w.executionRunId, sessionId: w.f.sessionId, workspaceId: w.f.workspaceId, generation: w.f.generation, targetStageId: "stage_x" }, w.ctx.clock, w.ctx.clock.nowIso()),
        ),
      ),
    ).toBe("SUPERVISOR_BINDING_REQUIRED");
    // No execution replan (E9 request requires active supervisor + run).
    const { requestExecutionReplanInTx } = await import("../src/application/execution-replan-service.js");
    expect(
      codeOf(() =>
        w.ctx.store.withWrite((tx) =>
          requestExecutionReplanInTx(
            tx,
            { sessionId: w.f.sessionId, workspaceId: w.f.workspaceId, generation: w.f.generation, reason: "normative gap", affectedNormativeRefs: [], relevantReportRefs: [], toolUseId: "TU-TERMINAL" },
            w.ctx.clock,
            w.ctx.clock.nowIso(),
          ),
        ),
      ),
    ).toBe("REPLAN_REQUEST_INVALID");
    // No supervisor takeover (terminal runs never reacquire supervision).
    expect(codeOf(() => takeoverTo(w, "S-DEAD"))).toBe("INVALID_EXECUTION_LIFECYCLE");
    // The lifecycle never changed.
    expect(w.ctx.store.withRead((tx) => getExecutionRunInTx(tx, w.executionRunId)!.lifecycle)).toBe("completed");
  });
});
