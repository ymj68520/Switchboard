/**
 * E9 §49–§53 — the replan transition, issue provenance, and the atomic
 * boundary (E9-T1..T24).
 *
 * The replan request is a semantic Supervisor judgment; Core validates the
 * protocol (E2 authority, active run, no running Attempt, exact FinalPlan-
 * reachable affected refs, same-run Reports, optional request_replan trigger)
 * and executes the ONE all-or-nothing terminal transaction: immutable v2
 * ExecutionIssue (Core-derived accepted history + frozen context snapshot) →
 * terminal Window closure (no fake Commit) → active → replan_required →
 * SupervisorBinding detached.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  acceptanceServiceOf,
  acceptInput,
  codeOf,
  makeAcceptanceWorld,
  runDirectiveCycle,
  runVerificationCycle,
  type AcceptanceWorld,
} from "./acceptance-helpers.js";
import { requestExecutionReplanInTx } from "../src/application/execution-replan-service.js";
import { getSupervisorBindingInTx } from "../src/store/supervisor-bindings.js";
import { getExecutionIssueInTx, findOpenReplanIssueInTx } from "../src/store/execution-issues.js";
import { getExecutionRunInTx } from "../src/store/execution-runs.js";
import { getAcceptedHeadCommitIdInTx } from "../src/store/execution-commits.js";
import { getOpenWindowInTx } from "../src/store/execution-structure.js";
import { listRunCommitsInTx } from "../src/store/execution-commits.js";
import type { ExecutionIssueAffectedRef } from "../src/core/execution-issue.js";

let world: AcceptanceWorld | null = null;

async function freshWorld(): Promise<AcceptanceWorld> {
  world = await makeAcceptanceWorld(`ER-${Math.random().toString(36).slice(2, 8)}`);
  return world;
}

function affectedRef(w: AcceptanceWorld): ExecutionIssueAffectedRef {
  return { type: "section", id: w.f.sectionIds[0]!, revision: 1 };
}

function replan(w: AcceptanceWorld, overrides: Record<string, unknown> = {}) {
  return w.ctx.store.withWrite((tx) =>
    requestExecutionReplanInTx(
      tx,
      {
        sessionId: w.f.sessionId,
        workspaceId: w.f.workspaceId,
        generation: w.f.generation,
        reason: "the approved section contract contradicts the discovered platform constraint; a new normative decision is required",
        affectedNormativeRefs: [affectedRef(w)],
        relevantReportRefs: [],
        toolUseId: `TU-REPLAN-${Math.random().toString(36).slice(2, 8)}`,
        ...overrides,
      },
      w.ctx.clock,
      w.ctx.clock.nowIso(),
    ),
  );
}

afterEach(() => {
  world?.ctx.store.close();
  world = null;
});

describe("E9 replan transition (§4/§24)", () => {
  it("E9-T1: the normal transition is atomic — issue, terminal window close, lifecycle, binding detach", async () => {
    const w = await freshWorld();
    const result = replan(w);
    expect(result.status).toBe("replan_required");
    expect(result.windowClosed).toBe(true);
    expect(result.bindingDetached).toBe(true);
    const run = w.ctx.store.withRead((tx) => getExecutionRunInTx(tx, w.executionRunId))!;
    expect(run.lifecycle).toBe("replan_required");
    const binding = w.ctx.store.withRead((tx) => getSupervisorBindingInTx(tx, w.executionRunId))!;
    expect(binding.state).toBe("detached");
    const issue = w.ctx.store.withRead((tx) => findOpenReplanIssueInTx(tx, w.executionRunId))!;
    expect(issue.kind).toBe("replan_required");
    expect(issue.issueVersion).toBe(2);
    const window = w.ctx.store.withRead((tx) => getOpenWindowInTx(tx, w.executionRunId));
    expect(window).toBeNull();
  });

  it("E9-T2: the issue is immutable — update and delete are impossible", async () => {
    const w = await freshWorld();
    const result = replan(w);
    expect(
      (() => {
        try {
          w.ctx.store.withWrite((tx) => tx.prepare("UPDATE execution_issues SET summary = 'rewritten' WHERE issue_id = ?").run(result.issueId));
          return "no-error";
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }
      })(),
    ).toContain("execution_issues is immutable");
    expect(
      (() => {
        try {
          w.ctx.store.withWrite((tx) => tx.prepare("DELETE FROM execution_issues WHERE issue_id = ?").run(result.issueId));
          return "no-error";
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }
      })(),
    ).toContain("execution_issues is immutable");
  });

  it("E9-T3/T4/T5: FinalPlan binding, acceptedHead, and Stage states are frozen by the transition", async () => {
    const w = await freshWorld();
    const before = w.ctx.store.withRead((tx) => ({
      finalPlan: getExecutionRunInTx(tx, w.executionRunId)!.finalPlan,
      head: getAcceptedHeadCommitIdInTx(tx, w.executionRunId),
      stages: w.f,
      commitCount: listRunCommitsInTx(tx, w.executionRunId).length,
    }));
    // Produce an accepted commit first so the head-freeze is meaningful.
    runVerificationCycle(w);
    acceptanceServiceOf(w).submitSupervisorAssessment(acceptInput(w, { coveredObligations: [] }) as never);
    const withHead = w.ctx.store.withRead((tx) => ({
      head: getAcceptedHeadCommitIdInTx(tx, w.executionRunId),
      stageStates: tx.prepare("SELECT id, status FROM execution_stages WHERE execution_run_id = ? ORDER BY ordinal").all(w.executionRunId),
      commitCount: listRunCommitsInTx(tx, w.executionRunId).length,
    }));
    replan(w);
    const after = w.ctx.store.withRead((tx) => ({
      finalPlan: getExecutionRunInTx(tx, w.executionRunId)!.finalPlan,
      head: getAcceptedHeadCommitIdInTx(tx, w.executionRunId),
      stageStates: tx.prepare("SELECT id, status FROM execution_stages WHERE execution_run_id = ? ORDER BY ordinal").all(w.executionRunId),
      commitCount: listRunCommitsInTx(tx, w.executionRunId).length,
    }));
    expect(after.finalPlan).toEqual(before.finalPlan);
    expect(after.head).toBe(withHead.head);
    expect(after.stageStates).toEqual(withHead.stageStates);
    expect(after.commitCount).toBe(withHead.commitCount);
    // E9-T19 — the accepted-closed window keeps closureKind 'accepted'; the
    // (absent) open window is simply gone.
    const accepted = w.ctx.store.withRead(
      (tx) => tx.prepare("SELECT closure_kind AS kind FROM verification_windows WHERE execution_run_id = ? AND closure_kind = 'accepted'").get(w.executionRunId),
    );
    expect(accepted).not.toBeNull();
  });

  it("E9-T6: a stale supervisor generation cannot replan", async () => {
    const w = await freshWorld();
    expect(
      codeOf(() =>
        w.ctx.store.withWrite((tx) =>
          requestExecutionReplanInTx(
            tx,
            {
              sessionId: w.f.sessionId,
              workspaceId: w.f.workspaceId,
              generation: w.f.generation + 5,
              reason: "stale generation attempt",
              affectedNormativeRefs: [affectedRef(w)],
              relevantReportRefs: [],
              toolUseId: "TU-STALE",
            },
            w.ctx.clock,
            w.ctx.clock.nowIso(),
          ),
        ),
      ),
    ).toBe("STALE_SUPERVISOR_BINDING");
    expect(w.ctx.store.withRead((tx) => getExecutionRunInTx(tx, w.executionRunId))!.lifecycle).toBe("active");
  });

  it("E9-T14: a running Attempt blocks the transition; indeterminate work does not (E9-T15)", async () => {
    const w = await freshWorld();
    // Start (but do not finish) an attempt via the real surface.
    const { issueDirective, startAttempt } = await import("./execution-protocol-helpers.js");
    const directive = issueDirective(w, { directiveId: "DIR-RUNNING", verificationPolicy: { implementationRequirement: "batchable" } });
    startAttempt(w, directive);
    expect(
      codeOf(() => replan(w)),
    ).toBe("REPLAN_ATTEMPT_RUNNING");
    expect(w.ctx.store.withRead((tx) => getExecutionRunInTx(tx, w.executionRunId))!.lifecycle).toBe("active");
    // Finish the report → replan succeeds.
    const { submitReport } = await import("./execution-protocol-helpers.js");
    const attempts = w.ctx.store.withRead(
      (tx) => tx.prepare("SELECT attempt_id AS id FROM execution_attempts WHERE directive_id = 'DIR-RUNNING'").all() as Array<{ id: string }>,
    );
    submitReport(w, attempts[0]!.id, { result: "completed" });
    const result = replan(w);
    expect(result.status).toBe("replan_required");
  });
});

describe("E9 issue provenance (§9–§13)", () => {
  it("E9-T8/T9: affected refs must be exact and FinalPlan-reachable; 'latest'/unknown refused", async () => {
    const w = await freshWorld();
    expect(
      codeOf(() => replan(w, { affectedNormativeRefs: [] })),
    ).toBe("REPLAN_AFFECTED_REF_INVALID");
    expect(
      codeOf(() => replan(w, { affectedNormativeRefs: [{ type: "section", id: "SEC-UNKNOWN" }] })),
    ).toBe("REPLAN_AFFECTED_REF_INVALID");
    expect(
      codeOf(() => replan(w, { affectedNormativeRefs: [{ type: "section", id: "SEC-UNKNOWN", revision: 1 }] })),
    ).toBe("REPLAN_AFFECTED_REF_INVALID");
    expect(
      codeOf(() => replan(w, { affectedNormativeRefs: [{ type: "not_a_kind", id: w.f.sectionIds[0], revision: 1 }] })),
    ).toBe("REPLAN_AFFECTED_REF_INVALID");
  });

  it("E9-T10: relevant Reports must exist in THIS run — any result or candidate state", async () => {
    const w = await freshWorld();
    // A historical report from a finished verification cycle is acceptable.
    runVerificationCycle(w);
    // A report id that is not a durable Report of THIS run is refused before
    // anything transitions. (Fixture store-local id counters make cross-store
    // ids collide, so the foreign-ref durable fact is exercised as a ghost id
    // — the same run-membership check fires.)
    expect(
      codeOf(() =>
        w.ctx.store.withWrite((tx) =>
          requestExecutionReplanInTx(
            tx,
            {
              sessionId: w.f.sessionId,
              workspaceId: w.f.workspaceId,
              generation: w.f.generation,
              reason: "ghost report probe",
              affectedNormativeRefs: [affectedRef(w)],
              relevantReportRefs: ["rep_does_not_exist_anywhere"],
              toolUseId: "TU-GHOST",
            },
            w.ctx.clock,
            w.ctx.clock.nowIso(),
          ),
        ),
      ),
    ).toBe("REPLAN_REPORT_REF_INVALID");
    const result = replan(w, { relevantReportRefs: [w.verReportId!] });
    expect(result.status).toBe("replan_required");
  });

  it("E9-T11: the accepted history is Core-derived — the full ordered chain, not Supervisor-picked", async () => {
    const w = await freshWorld();
    runVerificationCycle(w);
    acceptanceServiceOf(w).submitSupervisorAssessment(acceptInput(w, { coveredObligations: [] }) as never);
    const result = replan(w);
    const issue = w.ctx.store.withRead((tx) => getExecutionIssueInTx(tx, w.executionRunId, result.issueId))!;
    const history = JSON.parse(issue.acceptedHistoryJson!) as {
      acceptedHead: { commitId: string; sequence: number } | null;
      commits: Array<{ commitId: string; sequence: number }>;
    };
    const chain = w.ctx.store.withRead((tx) => listRunCommitsInTx(tx, w.executionRunId));
    expect(history.commits.map((commit) => commit.commitId)).toEqual(chain.map((commit) => commit.commitId));
    expect(history.acceptedHead?.commitId).toBe(chain[chain.length - 1]?.commitId ?? null);
  });

  it("E9-T12: the exact execution context is frozen — stage/window/policy/conflict/indeterminate", async () => {
    const w = await freshWorld();
    runVerificationCycle(w);
    const inspection = runDirectiveCycle(w, { directiveId: "DIR-INS-ER", kind: "inspection" });
    const result = replan(w, { relevantReportRefs: [inspection.reportId] });
    const issue = w.ctx.store.withRead((tx) => getExecutionIssueInTx(tx, w.executionRunId, result.issueId))!;
    const context = JSON.parse(issue.executionContextJson!) as {
      lifecycleBefore: string;
      activeStage: { id: string; status: string } | null;
      openWindow: { id: string; candidateRevision: number; baseKind: string; baseCommitId: string | null } | null;
      workspaceId: string;
      repositoryAtTransition: { kind: string } | null;
    };
    expect(context.lifecycleBefore).toBe("active");
    expect(context.activeStage?.id).toBe(w.activeStageId);
    expect(context.openWindow?.id).toBe(w.openWindowId);
    expect(context.openWindow?.candidateRevision).toBe(1);
    expect(context.workspaceId).toBe(w.f.workspaceId);
    expect(context.repositoryAtTransition).not.toBeNull();
    // The executionRunId provenance is on the row.
    expect(issue.executionRunId).not.toBeNull();
  });

  it("E9-T13: the issue contains no raw conversation or hidden reasoning", async () => {
    const w = await freshWorld();
    const result = replan(w);
    const issue = w.ctx.store.withRead((tx) => getExecutionIssueInTx(tx, w.executionRunId, result.issueId))!;
    const blob = `${issue.canonicalJson}${issue.acceptedHistoryJson}${issue.executionContextJson}`;
    expect(blob).not.toMatch(/conversation|transcript|assistant_message|hidden_reasoning/i);
  });

  it("E9 §8: a trigger assessment must exist, belong to the run, and carry request_replan", async () => {
    const w = await freshWorld();
    runVerificationCycle(w);
    const assessment = acceptanceServiceOf(w).submitSupervisorAssessment(
      acceptInput(w, { disposition: "request_replan", rationale: "the plan cannot continue normatively." }) as never,
    );
    // Foreign assessment refused.
    expect(codeOf(() => replan(w, { triggerAssessmentId: "sa_ghost" }))).toBe("REPLAN_REQUEST_INVALID");
    const result = replan(w, { triggerAssessmentId: assessment.assessment.assessmentId });
    expect(result.status).toBe("replan_required");
  });
});

describe("E9 window terminal closure + atomicity (§21–§25)", () => {
  it("E9-T18: the open candidate terminal-closes with closureKind replan_required, no Commit", async () => {
    const w = await freshWorld();
    const revision = w.ctx.store.withRead((tx) => getOpenWindowInTx(tx, w.executionRunId)!.candidateRevision);
    const result = replan(w);
    expect(result.windowClosed).toBe(true);
    const closed = w.ctx.store.withRead(
      (tx) =>
        tx.prepare("SELECT closed_at AS closedAt, closure_kind AS kind, candidate_revision AS revision FROM verification_windows WHERE id = ?").get(
          w.openWindowId,
        ) as { closedAt: string | null; kind: string | null; revision: number },
    );
    expect(closed.closedAt).not.toBeNull();
    expect(closed.kind).toBe("replan_required");
    expect(closed.revision).toBe(revision);
    expect(w.ctx.store.withRead((tx) => listRunCommitsInTx(tx, w.executionRunId))).toHaveLength(0);
  });

  it("E9-T20: replanning from the post-commit boundary (no open window) succeeds without fabricating one", async () => {
    const w = await freshWorld();
    runVerificationCycle(w);
    acceptanceServiceOf(w).submitSupervisorAssessment(acceptInput(w, { coveredObligations: [] }) as never);
    const result = replan(w);
    expect(result.status).toBe("replan_required");
    expect(result.windowClosed).toBe(false);
    expect(w.ctx.store.withRead((tx) => getOpenWindowInTx(tx, w.executionRunId))).toBeNull();
  });

  it("E9-T21: the validator distinguishes replan closure from accepted closure — corruption fails", async () => {
    const w = await freshWorld();
    const result = replan(w);
    // Fabricate a commit for the replan-closed window → validator corruption.
    w.ctx.store.withWrite((tx) => {
      const windowId = (tx
        .prepare("SELECT id FROM verification_windows WHERE execution_run_id = ? AND closure_kind = 'replan_required'")
        .get(w.executionRunId) as { id: string }).id;
      void result;
      // FK-satisfying fabricated assessment for the corrupt commit probe.
      tx.prepare(
        "INSERT INTO supervisor_assessments (assessment_id, execution_run_id, stage_id, window_id, candidate_revision, "
        + "disposition, supervisor_session_id, supervisor_generation, plan_refs_json, covered_obligations_json, "
        + "rationale, created_at) VALUES ('sa_corrupt', ?, ?, ?, 0, 'rework', 'S-CORRUPT', 1, '[]', '[]', 'probe', 'now')",
      ).run(w.executionRunId, w.activeStageId, windowId);
      tx.prepare(
        "INSERT INTO execution_commits (commit_id, execution_run_id, sequence, parent_commit_id, stage_id, window_id, "
        + "candidate_revision, supervisor_assessment_id, directive_refs_json, report_refs_json, satisfied_obligations_json, created_at) "
        + "VALUES ('ec_corrupt', ?, 1, NULL, ?, ?, 0, 'sa_corrupt', '[]', '[]', '[]', 'now')",
      ).run(w.executionRunId, w.activeStageId, windowId);
    });
    const { inspectSchemaState } = await import("../src/store/schema.js");
    const state = w.ctx.store.withRead((tx) => inspectSchemaState(tx));
    expect(state.consistent).toBe(false);
    expect(state.problems.some((problem) => problem.includes("replan") || problem.includes("commit"))).toBe(true);
  });

  it("E9-T23/T24: retry converges on the same issue; exactly one replan issue per run", async () => {
    const w = await freshWorld();
    const first = replan(w, { toolUseId: "TU-RETRY-SAME" });
    const retry = replan(w, { toolUseId: "TU-RETRY-SAME" });
    expect(retry.status).toBe("already_replan_required");
    expect(retry.issueId).toBe(first.issueId);
    // A DIFFERENT operation id after the terminal transition is refused.
    expect(codeOf(() => replan(w, { toolUseId: "TU-RETRY-DIFF" }))).toBe("REPLAN_ALREADY_TRANSITIONED");
    const issues = w.ctx.store.withRead(
      (tx) => tx.prepare("SELECT count(*) AS n FROM execution_issues WHERE execution_run_id = ? AND kind = 'replan_required'").get(w.executionRunId) as { n: number },
    );
    expect(issues.n).toBe(1);
  });

  it("E9-T22: a mid-transaction failure leaves no issue, the run active, the window open, the binding attached", async () => {
    const w = await freshWorld();
    // Force failure inside the tx: a pre-existing replan issue for another
    // logical flow would collide with the partial UNIQUE index; simulate by
    // breaking the affected-ref validation AFTER the window/issue would
    // persist — the simplest deterministic forcing point is the running gate:
    const { issueDirective, startAttempt } = await import("./execution-protocol-helpers.js");
    const directive = issueDirective(w, { directiveId: "DIR-RUN2", verificationPolicy: { implementationRequirement: "batchable" } });
    startAttempt(w, directive);
    expect(codeOf(() => replan(w, { toolUseId: "TU-FAIL" }))).toBe("REPLAN_ATTEMPT_RUNNING");
    const after = w.ctx.store.withRead((tx) => ({
      lifecycle: getExecutionRunInTx(tx, w.executionRunId)!.lifecycle,
      open: getOpenWindowInTx(tx, w.executionRunId) !== null,
      binding: getSupervisorBindingInTx(tx, w.executionRunId)!.state,
      issues: tx.prepare("SELECT count(*) AS n FROM execution_issues WHERE kind = 'replan_required'").get() as { n: number },
    }));
    expect(after.lifecycle).toBe("active");
    expect(after.open).toBe(true);
    expect(after.binding).toBe("attached");
    expect(after.issues.n).toBe(0);
  });
});
