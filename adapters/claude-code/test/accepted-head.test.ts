/**
 * E6 §64/§66 — acceptedHead CAS + commit-transaction atomicity tests
 * (E6-T29, T30) and the successor-window boundary (E6-T31/T33/T34 live in the
 * boundary suite; the CAS unit tests live here).
 *
 * The CAS is the ONLY acceptedHead advancement mechanism; a stale expectation
 * fails closed with STALE_EXECUTION_HEAD, and a gate failure leaves the store
 * exactly as it was — no assessment, no commit, no window close, no head.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  acceptInput,
  acceptanceServiceOf,
  codeOf,
  makeAcceptanceWorld,
  openSuccessorWindow,
  runVerificationCycle,
  runDirectiveCycle,
  currentRevision,
  type AcceptanceWorld,
} from "./acceptance-helpers.js";
import { advanceAcceptedHeadInTx, getAcceptedHeadCommitIdInTx, listRunCommitsInTx } from "../src/store/execution-commits.js";

let world: AcceptanceWorld | null = null;

async function freshWorld(): Promise<AcceptanceWorld> {
  world = await makeAcceptanceWorld(`AH-${Math.random().toString(36).slice(2, 8)}`);
  return world;
}

afterEach(() => {
  world?.ctx.store.close();
  world = null;
});

describe("E6 acceptedHead", () => {
  it("E6-T29: a gate failure leaves no assessment, no commit, no window close, no head", async () => {
    const w = await freshWorld();
    // First candidate accepted legitimately: EC-001, head set, W1 closed.
    runVerificationCycle(w);
    const service = acceptanceServiceOf(w);
    const first = service.submitSupervisorAssessment(acceptInput(w) as never);
    expect(first.commit?.sequence).toBe(1);
    // Successor window W2 (base EC-001) + a full accept-ready cycle in it.
    openSuccessorWindow(w);
    runDirectiveCycle(w, { directiveId: "DIR-I3", kind: "implementation", reportOverrides: { candidate_mutated: true } });
    runVerificationCycle(w);
    // Force an acceptedHead/Window conflict: a foreign commit becomes the head,
    // so W2's frozen base no longer equals the current head.
    const foreignCommitId = w.ctx.store.withWrite((tx) => {
      tx.prepare(
        "INSERT INTO verification_windows (id, execution_run_id, stage_id, candidate_revision, opened_at, closed_at, base_kind, base_commit_id, closure_kind) "
        + "VALUES ('win_foreign', ?, ?, 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'execution_start', NULL, 'accepted')",
      ).run(w.executionRunId, w.activeStageId);
      tx.prepare(
        "INSERT INTO supervisor_assessments (assessment_id, execution_run_id, stage_id, window_id, candidate_revision, disposition, "
        + "supervisor_session_id, supervisor_generation, plan_refs_json, covered_obligations_json, rationale, created_at) "
        + "VALUES ('sa_foreign', ?, ?, 'win_foreign', 0, 'rework', 'S-FOREIGN', 1, '[]', '[]', 'foreign', '2026-01-01T00:00:00Z')",
      ).run(w.executionRunId, w.activeStageId);
      tx.prepare(
        "INSERT INTO execution_commits (commit_id, execution_run_id, sequence, parent_commit_id, stage_id, window_id, "
        + "candidate_revision, supervisor_assessment_id, directive_refs_json, report_refs_json, satisfied_obligations_json, created_at) "
        + "VALUES ('ec_foreign', ?, 2, ?, ?, 'win_foreign', 0, 'sa_foreign', '[]', '[]', '[]', '2026-01-01T00:00:00Z')",
      ).run(w.executionRunId, first.commit!.commitId, w.activeStageId);
      tx.prepare("UPDATE execution_runs SET accepted_head_commit_id = 'ec_foreign' WHERE execution_run_id = ?").run(w.executionRunId);
      return "ec_foreign";
    });
    const before = w.ctx.store.withRead(
      (tx) =>
        ({
          head: getAcceptedHeadCommitIdInTx(tx, w.executionRunId),
          window: tx.prepare("SELECT closed_at FROM verification_windows WHERE closed_at IS NULL AND execution_run_id = ?").get(w.executionRunId),
          commits: tx.prepare("SELECT count(*) AS n FROM execution_commits").get(),
          assessments: tx.prepare("SELECT count(*) AS n FROM supervisor_assessments").get(),
        }) as { head: string | null; window: { closed_at: string | null } | undefined; commits: { n: number }; assessments: { n: number } },
    );
    expect(before.head).toBe(foreignCommitId);
    expect(before.commits.n).toBe(2);
    const assessmentsBefore = before.assessments.n; // includes the SQL fixture row
    expect(codeOf(() => service.submitSupervisorAssessment(acceptInput(w) as never))).toBe("WINDOW_BASE_MISMATCH");
    const after = w.ctx.store.withRead(
      (tx) =>
        ({
          head: getAcceptedHeadCommitIdInTx(tx, w.executionRunId),
          openWindows: tx.prepare("SELECT count(*) AS n FROM verification_windows WHERE closed_at IS NULL AND execution_run_id = ?").get(w.executionRunId),
          commits: tx.prepare("SELECT count(*) AS n FROM execution_commits").get(),
          assessments: tx.prepare("SELECT count(*) AS n FROM supervisor_assessments").get(),
        }) as { head: string | null; openWindows: { n: number }; commits: { n: number }; assessments: { n: number } },
    );
    expect(after.head).toBe(foreignCommitId);
    expect(after.openWindows.n).toBe(1); // W2 still open
    expect(after.commits.n).toBe(2); // no new commit
    expect(after.assessments.n).toBe(assessmentsBefore); // no new assessment
  });

  it("E6-T30: the acceptedHead CAS refuses stale expectations", async () => {
    const w = await freshWorld();
    runVerificationCycle(w);
    const { commit } = acceptanceServiceOf(w).submitSupervisorAssessment(acceptInput(w) as never);
    expect(commit).not.toBeNull();
    // A first-commit expectation (null) after the head exists — stale.
    expect(
      codeOf(() =>
        w.ctx.store.withWrite((tx) =>
          advanceAcceptedHeadInTx(tx, { executionRunId: w.executionRunId, expectedHeadCommitId: null, commitId: "ec_new" }, w.ctx.clock.nowIso()),
        ),
      ),
    ).toBe("STALE_EXECUTION_HEAD");
    // A wrong expected head — stale.
    expect(
      codeOf(() =>
        w.ctx.store.withWrite((tx) =>
          advanceAcceptedHeadInTx(
            tx,
            { executionRunId: w.executionRunId, expectedHeadCommitId: "ec_wrong", commitId: "ec_new" },
            w.ctx.clock.nowIso(),
          ),
        ),
      ),
    ).toBe("STALE_EXECUTION_HEAD");
    // The head is unchanged by the failed attempts.
    expect(w.ctx.store.withRead((tx) => getAcceptedHeadCommitIdInTx(tx, w.executionRunId))).toBe(commit!.commitId);
  });

  it("E6-T30b: the CAS admits exactly the matching successor", async () => {
    const w = await freshWorld();
    runVerificationCycle(w);
    const { commit } = acceptanceServiceOf(w).submitSupervisorAssessment(acceptInput(w) as never);
    w.ctx.store.withWrite((tx) => {
      tx.prepare(
        "INSERT INTO verification_windows (id, execution_run_id, stage_id, candidate_revision, opened_at, closed_at, base_kind, base_commit_id, closure_kind) "
        + "VALUES ('win_cas', ?, ?, 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'execution_start', NULL, 'accepted')",
      ).run(w.executionRunId, w.activeStageId);
      tx.prepare(
        "INSERT INTO supervisor_assessments (assessment_id, execution_run_id, stage_id, window_id, candidate_revision, disposition, "
        + "supervisor_session_id, supervisor_generation, plan_refs_json, covered_obligations_json, rationale, created_at) "
        + "VALUES ('sa_cas', ?, ?, 'win_cas', 0, 'rework', ?, 1, '[]', '[]', 'cas', '2026-01-01T00:00:00Z')",
      ).run(w.executionRunId, w.activeStageId, w.f.sessionId);
      tx.prepare(
        "INSERT INTO execution_commits (commit_id, execution_run_id, sequence, parent_commit_id, stage_id, window_id, "
        + "candidate_revision, supervisor_assessment_id, directive_refs_json, report_refs_json, satisfied_obligations_json, created_at) "
        + "VALUES ('ec_next', ?, 2, ?, ?, 'win_cas', 0, 'sa_cas', '[]', '[]', '[]', '2026-01-01T00:00:00Z')",
      ).run(w.executionRunId, commit!.commitId, w.activeStageId);
    });
    w.ctx.store.withWrite((tx) =>
      advanceAcceptedHeadInTx(tx, { executionRunId: w.executionRunId, expectedHeadCommitId: commit!.commitId, commitId: "ec_next" }, w.ctx.clock.nowIso()),
    );
    expect(w.ctx.store.withRead((tx) => getAcceptedHeadCommitIdInTx(tx, w.executionRunId))).toBe("ec_next");
    expect(w.ctx.store.withRead((tx) => listRunCommitsInTx(tx, w.executionRunId))).toHaveLength(2);
  });

  it("E6-T31/T39: the successor window starts at revision 0 rooted in the exact head", async () => {
    const w = await freshWorld();
    runVerificationCycle(w);
    const { commit } = acceptanceServiceOf(w).submitSupervisorAssessment(acceptInput(w) as never);
    const successor = openSuccessorWindow(w);
    expect(successor.window.candidateRevision).toBe(0);
    expect(successor.window.baseKind).toBe("execution_commit");
    expect(successor.window.baseCommitId).toBe(commit!.commitId);
    expect(currentRevision(w)).toBe(0);
  });

  it("E6-§35: the successor primitive refuses a run without an accepted head", async () => {
    const w = await freshWorld();
    const { createAcceptanceService } = await import("../src/application/acceptance-service.js");
    expect(
      codeOf(() => createAcceptanceService(w.ctx.store, w.ctx.clock).openNextWindowForActiveStage({ executionRunId: w.executionRunId })),
    ).toBe("WINDOW_BASE_MISMATCH");
  });
});
