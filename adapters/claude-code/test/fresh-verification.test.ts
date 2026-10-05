/**
 * E6 §61 — Fresh independent verification gate tests (E6-T14..T21).
 *
 * Only a verification Directive at the exact current candidate, executed as a
 * verifier Attempt through the real E5 Worker runtime and reported completed
 * and non-mutating, satisfies the acceptance prerequisite — and its judgment
 * must be `supporting`. Executor self-checks, inspections, stale revisions,
 * mutating verifiers, and negative verifier results never qualify.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  acceptInput,
  acceptanceServiceOf,
  codeOf,
  currentRevision,
  makeAcceptanceWorld,
  runDirectiveCycle,
  runVerificationCycle,
  runWorkerAttempt,
  type AcceptanceWorld,
} from "./acceptance-helpers.js";
import { issueDirective, makeActiveExecutionWorld, type E4World } from "./execution-protocol-helpers.js";
import { freshWorkerSession, type WorkerSession } from "./execution-worker-helpers.js";
import { startWorkerAttemptAndPrepareLaunchInTx } from "../src/application/worker-runtime-service.js";
import type { ExecutionDirective } from "../src/core/execution-directive.js";

let world: AcceptanceWorld | null = null;

async function freshWorld(): Promise<AcceptanceWorld> {
  world = await makeAcceptanceWorld(`FV-${Math.random().toString(36).slice(2, 8)}`);
  return world;
}

afterEach(() => {
  world?.ctx.store.close();
  world = null;
});

/** Start one worker attempt for a directive; returns the prepared launch. */
function startLaunch(w: E4World, directive: ExecutionDirective, workerRole: "executor" | "verifier") {
  return w.ctx.store.withWrite((tx) =>
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
        workerRole,
      },
      w.ctx.clock,
      w.ctx.clock.nowIso(),
    ),
  );
}

describe("E6 fresh independent verification", () => {
  it("E6-T14: executor completed but no verifier — no commit", async () => {
    const w = await freshWorld();
    const service = acceptanceServiceOf(w);
    expect(codeOf(() => service.submitSupervisorAssessment(acceptInput(w) as never))).toBe(
      "ACCEPTANCE_VERIFICATION_REQUIRED",
    );
  });

  it("E6-T15: an executor self-check cannot satisfy the verification gate", async () => {
    const base = await makeActiveExecutionWorld(`FV-SC-${Math.random().toString(36).slice(2, 8)}`);
    try {
      const directive = issueDirective(base, { directiveId: "DIR-SC", kind: "implementation" });
      const { attempt, launch } = startLaunch(base, directive, "executor");
      const session = freshWorkerSession(base, "SC");
      // Non-mutating implementation completion: the candidate stays at 0 and
      // the executor's self-report is the ONLY current-candidate evidence.
      const selfReportId = runWorkerAttempt(
        { ...base, launch, attemptId: attempt.attemptId },
        session,
        { candidate_mutated: false },
      );
      const service = acceptanceServiceOf(base);
      expect(
        codeOf(() =>
          service.submitSupervisorAssessment(
            acceptInput(
              { ...base, implDirective: directive, execSession: session, implReportId: selfReportId, verDirective: null, verSession: null, verReportId: null },
              { reportJudgments: [{ report_id: selfReportId, disposition: "supporting" }] },
            ) as never,
          ),
        ),
      ).toBe("ACCEPTANCE_VERIFICATION_REQUIRED");
    } finally {
      base.ctx.store.close();
    }
  });

  it("E6-T16: an inspection report cannot satisfy the verification gate", async () => {
    const w = await freshWorld();
    // Replace the world's evidence: no verifier; only a completed inspection
    // at the current revision (plus the historical executor report).
    runDirectiveCycle(w, { directiveId: "DIR-INS-ONLY", kind: "inspection" });
    const service = acceptanceServiceOf(w);
    const currentRev = currentRevision(w);
    const inspectionReportId = w.ctx.store.withRead(
      (tx) =>
        tx
          .prepare(
            "SELECT r.report_id AS id FROM execution_reports r JOIN execution_attempts a ON a.attempt_id = r.attempt_id "
            + "JOIN execution_directives d ON d.directive_id = a.directive_id AND d.revision = a.directive_revision "
            + "WHERE d.kind = 'inspection' AND d.base_candidate_revision = ? AND r.candidate_mutated = 0",
          )
          .get(currentRev) as { id: string } | undefined,
    )?.id;
    expect(inspectionReportId).toBeDefined();
    expect(
      codeOf(() =>
        service.submitSupervisorAssessment(
          acceptInput(w, { reportJudgments: [{ report_id: inspectionReportId, disposition: "supporting" }] }) as never,
        ),
      ),
    ).toBe("ACCEPTANCE_VERIFICATION_REQUIRED");
  });

  it("E6-T17: a fresh completed verifier at the exact candidate satisfies the gate", async () => {
    const w = await freshWorld();
    const verification = runVerificationCycle(w);
    const service = acceptanceServiceOf(w);
    const result = service.submitSupervisorAssessment(acceptInput(w) as never);
    expect(result.commit).not.toBeNull();
    expect(result.commit?.supervisorAssessmentId).toBe(result.assessment.assessmentId);
    expect(verification.reportId).toBeTruthy();
  });

  it("E6-T18: a verifier at candidate N cannot accept N+1", async () => {
    const w = await freshWorld();
    runVerificationCycle(w); // verifier at candidate 1
    // The candidate moves again: 1 → 2 via a fresh mutating implementation.
    runDirectiveCycle(w, { directiveId: "DIR-I2", kind: "implementation", reportOverrides: { candidate_mutated: true } });
    expect(currentRevision(w)).toBe(2);
    const service = acceptanceServiceOf(w);
    // The old verifier report is historical — never classifiable (E6 §41) —
    // so the honest submission carries no judgments and still refuses.
    expect(
      codeOf(() => service.submitSupervisorAssessment(acceptInput(w, { reportJudgments: [] }) as never)),
    ).toBe("ACCEPTANCE_VERIFICATION_STALE");
    // Judging the historical verifier report is itself refused.
    expect(codeOf(() => service.submitSupervisorAssessment(acceptInput(w) as never))).toBe(
      "ASSESSMENT_REPORT_INVALID",
    );
  });

  it("E6-T19: a mutating verifier report advances the candidate and cannot qualify", async () => {
    const w = await freshWorld();
    // A verification directive whose report factually mutated the candidate.
    runDirectiveCycle(w, { directiveId: "DIR-VM", kind: "verification", reportOverrides: { candidate_mutated: true } });
    expect(currentRevision(w)).toBe(2);
    const service = acceptanceServiceOf(w);
    expect(
      codeOf(() => service.submitSupervisorAssessment(acceptInput(w, { reportJudgments: [] }) as never)),
    ).toBe("ACCEPTANCE_VERIFICATION_STALE");
  });

  it("E6-T20: a failed/blocked/partial verifier cannot be the mandatory supporting verification", async () => {
    const w = await freshWorld();
    runDirectiveCycle(w, { directiveId: "DIR-VF", kind: "verification", reportOverrides: { result: "failed" } });
    const service = acceptanceServiceOf(w);
    const failedReportId = w.ctx.store.withRead(
      (tx) =>
        tx.prepare("SELECT report_id AS id FROM execution_reports WHERE result = 'failed'").get() as { id: string },
    ).id;
    // supporting is refused outright for a negative result…
    expect(
      codeOf(() =>
        service.submitSupervisorAssessment(
          acceptInput(w, { reportJudgments: [{ report_id: failedReportId, disposition: "supporting" }] }) as never,
        ),
      ),
    ).toBe("ASSESSMENT_REPORT_INVALID");
    // …and blocking classification blocks acceptance — either way no commit.
    expect(
      codeOf(() =>
        service.submitSupervisorAssessment(
          acceptInput(w, { reportJudgments: [{ report_id: failedReportId, disposition: "blocking" }] }) as never,
        ),
      ),
    ).toBe("ACCEPTANCE_BLOCKED");
  });

  it("E6-T21: the supporting verifier's worker session must differ from relied-upon executor sessions", async () => {
    const w = await freshWorld();
    // A current-candidate executor report claimed by session S_EXEC…
    const execDirective = issueDirective(w, { directiveId: "DIR-EX", kind: "implementation" });
    const execAttempt = startLaunch(w, execDirective, "executor");
    const execReportId = runWorkerAttempt(
      { ...w, launch: execAttempt.launch, attemptId: execAttempt.attempt.attemptId },
      w.execSession,
      { candidate_mutated: false },
    );
    // …and the verifier attempt claimed by the SAME worker session (fresh
    // agent id, identical session identity — session reuse, not role strings).
    const verDirective = issueDirective(w, { directiveId: "DIR-V-REUSE", kind: "verification" });
    const verAttempt = startLaunch(w, verDirective, "verifier");
    const reusedSession: WorkerSession = {
      sessionId: w.execSession.sessionId,
      agentId: "agent-REUSE",
      workspaceId: w.f.workspaceId,
    };
    const reusedReportId = runWorkerAttempt(
      { ...w, launch: verAttempt.launch, attemptId: verAttempt.attempt.attemptId },
      reusedSession,
      { candidate_mutated: false },
    );
    const service = acceptanceServiceOf(w);
    expect(
      codeOf(() =>
        service.submitSupervisorAssessment(
          acceptInput(w, {
            reportJudgments: [
              { report_id: execReportId, disposition: "supporting" },
              { report_id: reusedReportId, disposition: "supporting" },
            ],
          }) as never,
        ),
      ),
    ).toBe("ACCEPTANCE_VERIFICATION_REQUIRED");
  });
});
