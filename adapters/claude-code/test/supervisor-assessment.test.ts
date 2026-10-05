/**
 * E6 §59 — Assessment required tests (E6-T1..T6).
 *
 * Every assessment flows through the real acceptance gate
 * (submitSupervisorAssessmentInTx / the supervisor MCP tool), never a fixture
 * INSERT: binding, immutability, disposition vocabulary, non-accept
 * non-mutation, candidate staleness, and E2 supervisor fencing.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  acceptInput,
  acceptanceServiceOf,
  codeOf,
  currentRevision,
  makeAcceptanceWorld,
  messageOf,
  runDirectiveCycle,
  runVerificationCycle,
  takeoverTo,
  type AcceptanceWorld,
} from "./acceptance-helpers.js";
import { loadExecutionAcceptanceContextInTx } from "../src/application/acceptance-service.js";

let world: AcceptanceWorld | null = null;

async function freshWorld(): Promise<AcceptanceWorld> {
  world = await makeAcceptanceWorld(`SA-${Math.random().toString(36).slice(2, 8)}`);
  return world;
}

afterEach(() => {
  world?.ctx.store.close();
  world = null;
});

describe("E6 supervisor assessments", () => {
  it("E6-T1: an assessment binds the exact run/stage/window/candidateRevision", async () => {
    const w = await freshWorld();
    runVerificationCycle(w);
    const service = acceptanceServiceOf(w);
    const result = service.submitSupervisorAssessment(
      acceptInput(w, { disposition: "rework", reportJudgments: [] }) as never,
    );
    expect(result.assessment.executionRunId).toBe(w.executionRunId);
    expect(result.assessment.stageId).toBe(w.activeStageId);
    expect(result.assessment.windowId).toBe(w.openWindowId);
    expect(result.assessment.candidateRevision).toBe(currentRevision(w));
    expect(result.commit).toBeNull();
  });

  it("E6-T2: assessments are immutable — update and delete are rejected by DDL", async () => {
    const w = await freshWorld();
    runVerificationCycle(w);
    const service = acceptanceServiceOf(w);
    const { assessment } = service.submitSupervisorAssessment(
      acceptInput(w, { disposition: "blocked", reportJudgments: [] }) as never,
    );
    expect(
      messageOf(() =>
        w.ctx.store.withWrite((tx) => {
          tx.prepare("UPDATE supervisor_assessments SET disposition = 'accept' WHERE assessment_id = ?").run(
            assessment.assessmentId,
          );
        }),
      ),
    ).toContain("immutable");
    expect(
      messageOf(() =>
        w.ctx.store.withWrite((tx) => {
          tx.prepare("DELETE FROM supervisor_assessments WHERE assessment_id = ?").run(assessment.assessmentId);
        }),
      ),
    ).toContain("immutable");
    const reread = w.ctx.store.withRead(
      (tx) =>
        tx.prepare("SELECT disposition FROM supervisor_assessments WHERE assessment_id = ?").get(
          assessment.assessmentId,
        ) as { disposition: string },
    );
    expect(reread.disposition).toBe("blocked");
  });

  it("E6-T3: all five frozen dispositions roundtrip", async () => {
    for (const disposition of ["accept", "rework", "need_more_verification", "blocked", "request_replan"] as const) {
      const w = await freshWorld();
      runVerificationCycle(w);
      const service = acceptanceServiceOf(w);
      const result = service.submitSupervisorAssessment(
        acceptInput(w, disposition === "accept" ? {} : { disposition, reportJudgments: [] }) as never,
      );
      expect(result.assessment.disposition).toBe(disposition);
      const stored = w.ctx.store.withRead(
        (tx) =>
          tx.prepare("SELECT disposition FROM supervisor_assessments WHERE assessment_id = ?").get(
            result.assessment.assessmentId,
          ) as { disposition: string },
      );
      expect(stored.disposition).toBe(disposition);
    }
  });

  it("E6-T4: non-accept dispositions never mutate accepted state", async () => {
    for (const disposition of ["rework", "need_more_verification", "blocked", "request_replan"] as const) {
      const w = await freshWorld();
      runVerificationCycle(w);
      const service = acceptanceServiceOf(w);
      service.submitSupervisorAssessment(acceptInput(w, { disposition, reportJudgments: [] }) as never);
      const state = w.ctx.store.withRead(
        (tx) =>
          ({
            head: tx.prepare("SELECT accepted_head_commit_id AS head FROM execution_runs WHERE execution_run_id = ?").get(w.executionRunId),
            window: tx.prepare("SELECT closed_at FROM verification_windows WHERE id = ?").get(w.openWindowId),
            stage: tx.prepare("SELECT status FROM execution_stages WHERE id = ?").get(w.activeStageId),
            commits: tx.prepare("SELECT count(*) AS n FROM execution_commits").get(),
          }) as { head: { head: string | null }; window: { closed_at: string | null }; stage: { status: string }; commits: { n: number } },
      );
      expect(state.head.head).toBeNull();
      expect(state.window.closed_at).toBeNull();
      expect(state.stage.status).toBe("active");
      expect(state.commits.n).toBe(0);
    }
  });

  it("E6-T5: a stale assessment cannot commit a newer candidate", async () => {
    const w = await freshWorld();
    const service = acceptanceServiceOf(w);
    // Durable non-accept judgment at the CURRENT revision (1).
    const stale = service.submitSupervisorAssessment(
      acceptInput(w, { disposition: "rework", reportJudgments: [], rationale: "pre-mutation judgment" }) as never,
    );
    expect(stale.assessment.candidateRevision).toBe(1);
    // The candidate mutates again: 1 → 2 via a fresh implementation cycle.
    runDirectiveCycle(w, { directiveId: "DIR-I2", kind: "implementation", reportOverrides: { candidate_mutated: true } });
    expect(currentRevision(w)).toBe(2);
    // The old assessment is historical for the new candidate…
    const context = w.ctx.store.withRead((tx) => loadExecutionAcceptanceContextInTx(tx, w.executionRunId));
    expect(context.candidate?.assessments.find((a) => a.assessmentId === stale.assessment.assessmentId)?.isCurrent).toBe(false);
    // …a stale expected revision is refused outright…
    expect(
      codeOf(() => service.submitSupervisorAssessment(acceptInput(w, { expectedCandidateRevision: 1 }) as never)),
    ).toBe("SUPERVISOR_ASSESSMENT_STALE");
    // …and acceptance at the new candidate cannot rest on the old judgment:
    // no fresh verification exists at revision 2, so the gate refuses.
    expect(codeOf(() => service.submitSupervisorAssessment(acceptInput(w) as never))).toBe(
      "ACCEPTANCE_VERIFICATION_REQUIRED",
    );
    const commits = w.ctx.store.withRead((tx) => tx.prepare("SELECT count(*) AS n FROM execution_commits").get() as { n: number });
    expect(commits.n).toBe(0);
  });

  it("E6-T6: a stale former supervisor cannot assess", async () => {
    const w = await freshWorld();
    runVerificationCycle(w);
    takeoverTo(w, "S2");
    const service = acceptanceServiceOf(w);
    // Session S1 keeps its old generation 1 — fenced.
    expect(codeOf(() => service.submitSupervisorAssessment(acceptInput(w, { disposition: "rework" }) as never))).toBe(
      "STALE_SUPERVISOR_BINDING",
    );
    // A worker session is not a supervisor either (E6 §6/§52).
    expect(
      codeOf(() =>
        service.submitSupervisorAssessment(
          acceptInput(w, { disposition: "rework", sessionId: w.execSession.sessionId, generation: 1 }) as never,
        ),
      ),
    ).toBe("STALE_SUPERVISOR_BINDING");
  });
});
