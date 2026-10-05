/**
 * E6 §60/§61 — Report coverage gate tests (E6-T7, T8, T10–T13) plus the
 * §54/§8 acceptance-context facts (E6-T9).
 *
 * The anti-omission rules are exercised against the real gate: complete
 * current-candidate coverage, foreign-report refusal, historical-stale
 * exemption with commit provenance, blocking refusal, the negative-evidence
 * classification rule, and the superseded-by-a-later-current-report rule.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  acceptInput,
  acceptanceServiceOf,
  codeOf,
  makeAcceptanceWorld,
  runDirectiveCycle,
  runVerificationCycle,
  type AcceptanceWorld,
} from "./acceptance-helpers.js";
import { createAcceptanceService } from "../src/application/acceptance-service.js";
import { listRunCommitsInTx } from "../src/store/execution-commits.js";

let world: AcceptanceWorld | null = null;

async function freshWorld(): Promise<AcceptanceWorld> {
  world = await makeAcceptanceWorld(`AG-${Math.random().toString(36).slice(2, 8)}`);
  return world;
}

afterEach(() => {
  world?.ctx.store.close();
  world = null;
});

describe("E6 acceptance gate — report coverage", () => {
  it("E6-T7: accept must classify every current-candidate report — omission fails", async () => {
    const w = await freshWorld();
    const first = runVerificationCycle(w);
    // A second current-candidate report (an inspection at the same revision).
    runDirectiveCycle(w, { directiveId: "DIR-INS", kind: "inspection" });
    const service = acceptanceServiceOf(w);
    expect(
      codeOf(() =>
        service.submitSupervisorAssessment(
          acceptInput(w, { reportJudgments: [{ report_id: first.reportId, disposition: "supporting" }] }) as never,
        ),
      ),
    ).toBe("ASSESSMENT_REPORT_COVERAGE_INCOMPLETE");
  });

  it("E6-T8: assessments cannot classify a foreign report (another run/window)", async () => {
    const w = await freshWorld();
    runVerificationCycle(w);
    // A report from ANOTHER run entirely.
    const foreign = await makeAcceptanceWorld("AG-FOREIGN");
    try {
      const service = acceptanceServiceOf(w);
      expect(
        codeOf(() =>
          service.submitSupervisorAssessment(
            acceptInput(w, { reportJudgments: [{ report_id: foreign.implReportId, disposition: "supporting" }] }) as never,
          ),
        ),
      ).toBe("ASSESSMENT_REPORT_INVALID");
    } finally {
      foreign.ctx.store.close();
    }
  });

  it("E6-T9: historical stale reports need no judgment but remain in commit provenance", async () => {
    const w = await freshWorld();
    // The implementation report mutated 0 → 1: historical for candidate 1.
    runVerificationCycle(w);
    const service = acceptanceServiceOf(w);
    const result = service.submitSupervisorAssessment(acceptInput(w) as never);
    expect(result.commit).not.toBeNull();
    // Complete provenance includes the historical executor report…
    expect(result.commit?.reportRefs.map((ref) => ref.reportId)).toContain(w.implReportId);
    expect(result.commit?.reportRefs.map((ref) => ref.reportId)).toContain(result.assessment.assessmentId === null ? "" : w.verReportId);
    const commits = w.ctx.store.withRead((tx) => listRunCommitsInTx(tx, w.executionRunId));
    expect(commits[0]?.reportRefs.some((ref) => ref.reportId === w.implReportId)).toBe(true);
  });

  it("E6-T10: a blocking classification prevents acceptance", async () => {
    const w = await freshWorld();
    const verification = runVerificationCycle(w);
    const service = acceptanceServiceOf(w);
    expect(
      codeOf(() =>
        service.submitSupervisorAssessment(
          acceptInput(w, { reportJudgments: [{ report_id: verification.reportId, disposition: "blocking" }] }) as never,
        ),
      ),
    ).toBe("ACCEPTANCE_BLOCKED");
  });

  it("E6-T11: a negative report cannot be marked supporting", async () => {
    const w = await freshWorld();
    // An inspection report with a negative result at the current revision.
    runDirectiveCycle(w, { directiveId: "DIR-INS-NEG", kind: "inspection", reportOverrides: { result: "blocked" } });
    runVerificationCycle(w);
    const service = acceptanceServiceOf(w);
    const inspections = w.ctx.store.withRead(
      (tx) => tx.prepare("SELECT report_id AS id, result FROM execution_reports WHERE result = 'blocked'").all() as Array<{ id: string }>,
    );
    expect(inspections.length).toBeGreaterThan(0);
    const judgments = inspections.map((row) => ({ report_id: row.id, disposition: "supporting" }));
    expect(codeOf(() => service.submitSupervisorAssessment(acceptInput(w, { reportJudgments: judgments }) as never))).toBe(
      "ASSESSMENT_REPORT_INVALID",
    );
  });

  it("E6-T12: a negative current report may be superseded by a valid later current report", async () => {
    const w = await freshWorld();
    // Blocked inspection at candidate N…
    const blocked = runDirectiveCycle(w, {
      directiveId: "DIR-INS-B",
      kind: "inspection",
      reportOverrides: { result: "blocked" },
    });
    // …then a later current-candidate verification that resolves the blocker.
    const verification = runVerificationCycle(w);
    const service = acceptanceServiceOf(w);
    const result = service.submitSupervisorAssessment(
      acceptInput(w, {
        reportJudgments: [
          {
            report_id: blocked.reportId,
            disposition: "superseded",
            superseded_by_report_id: verification.reportId,
            rationale: "the missing context was supplied and the later verification passed.",
          },
          { report_id: verification.reportId, disposition: "supporting" },
        ],
      }) as never,
    );
    expect(result.commit).not.toBeNull();
    expect(result.commit?.reportRefs.length).toBeGreaterThanOrEqual(2);
  });

  it("E6-T13: superseded without a valid later superseding report fails", async () => {
    const w = await freshWorld();
    const blocked = runDirectiveCycle(w, {
      directiveId: "DIR-INS-B2",
      kind: "inspection",
      reportOverrides: { result: "blocked" },
    });
    runVerificationCycle(w);
    const service = acceptanceServiceOf(w);
    // Superseder names a report that is not later (the blocked report itself).
    expect(
      codeOf(() =>
        service.submitSupervisorAssessment(
          acceptInput(w, {
            reportJudgments: [
              {
                report_id: blocked.reportId,
                disposition: "superseded",
                superseded_by_report_id: blocked.reportId,
                rationale: "self-reference is not a superseder.",
              },
              { report_id: w.verReportId, disposition: "supporting" },
            ],
          }) as never,
        ),
      ),
    ).toBe("ASSESSMENT_REPORT_INVALID");
    // Superseder names an unknown report.
    expect(
      codeOf(() =>
        service.submitSupervisorAssessment(
          acceptInput(w, {
            reportJudgments: [
              {
                report_id: blocked.reportId,
                disposition: "superseded",
                superseded_by_report_id: "rep_does_not_exist",
                rationale: "unknown superseder.",
              },
              { report_id: w.verReportId, disposition: "supporting" },
            ],
          }) as never,
        ),
      ),
    ).toBe("ASSESSMENT_REPORT_INVALID");
  });
  it("E6-T42: coveredObligations roundtrip as commit provenance — no Stage completion", async () => {
    const w = await freshWorld();
    // Provenance over EXISTING content only: a validation requirement carried
    // by the verification Directive (deterministic local identity).
    const requirement = { requirement: "verification covers the exact candidate revision", detail: null };
    const verification = runVerificationCycle(w, {
      directiveOverrides: { validationRequirements: [requirement] },
    });
    const { validationRequirementObligation, planRefObligation } = await import("../src/core/supervisor-assessment.js");
    const obligation = validationRequirementObligation(verification.directive, requirement, 0);
    const planRefObligationInput = w.implDirective.planRefs[0] === undefined ? [] : [planRefObligation(w.implDirective.planRefs[0])];
    const service = acceptanceServiceOf(w);
    const result = service.submitSupervisorAssessment(
      acceptInput(w, {
        coveredObligations: [obligation, ...planRefObligationInput],
      }) as never,
    );
    expect(result.commit).not.toBeNull();
    // The obligations persist verbatim on the immutable commit…
    const stored = w.ctx.store.withRead(
      (tx) =>
        tx.prepare("SELECT satisfied_obligations_json AS obligations FROM execution_commits WHERE commit_id = ?").get(
          result.commit!.commitId,
        ) as { obligations: string },
    );
    expect(JSON.parse(stored.obligations)).toEqual([obligation, ...planRefObligationInput]);
    // …and coverage provenance never completes the Stage (E6 §48).
    const stage = w.ctx.store.withRead(
      (tx) => tx.prepare("SELECT status FROM execution_stages WHERE id = ?").get(w.activeStageId) as { status: string },
    );
    expect(stage.status).toBe("active");
  });

  it("E6-T42b: a fabricated obligation (wrong content hash / foreign directive) is refused", async () => {
    const w = await freshWorld();
    const requirement = { requirement: "verification covers the exact candidate revision", detail: null };
    const verification = runVerificationCycle(w, {
      directiveOverrides: { validationRequirements: [requirement] },
    });
    const { validationRequirementObligation } = await import("../src/core/supervisor-assessment.js");
    const service = acceptanceServiceOf(w);
    // Wrong content hash: the provenance does not match persisted content.
    const forged = { ...validationRequirementObligation(verification.directive, requirement, 0), contentHash: "sha256:forged" };
    expect(
      codeOf(() =>
        service.submitSupervisorAssessment(acceptInput(w, { coveredObligations: [forged] }) as never),
      ),
    ).toBe("ASSESSMENT_REPORT_INVALID");
    // Right hash, but bound to a directive that is not in this window.
    const foreign = validationRequirementObligation(
      { ...verification.directive, directiveId: "DIR-ELSEWHERE" },
      requirement,
      0,
    );
    expect(
      codeOf(() =>
        service.submitSupervisorAssessment(acceptInput(w, { coveredObligations: [foreign] }) as never),
      ),
    ).toBe("ASSESSMENT_REPORT_INVALID");
  });
});

describe("E6 acceptance context (§8/§54)", () => {
  it("E6-T9b: the context splits current vs historical evidence and reports qualification", async () => {
    const w = await freshWorld();
    runVerificationCycle(w);
    const service = createAcceptanceService(w.ctx.store, w.ctx.clock);
    const context = service.getExecutionAcceptanceContext({ executionRunId: w.executionRunId });
    expect(context.acceptedHead).toBeNull();
    expect(context.candidate?.revision).toBe(1);
    expect(context.candidate?.currentReports.map((fact) => fact.reportId)).toEqual([w.verReportId]);
    expect(context.candidate?.historicalReports.map((fact) => fact.reportId)).toEqual([w.implReportId]);
    expect(context.candidate?.qualifyingVerificationReportIds).toEqual([w.verReportId]);
    expect(context.boundary).toBeNull();
  });

  it("E6-§54: after a commit the context reports the post-commit boundary", async () => {
    const w = await freshWorld();
    runVerificationCycle(w);
    const service = createAcceptanceService(w.ctx.store, w.ctx.clock);
    service.submitSupervisorAssessment(acceptInput(w) as never);
    const context = service.getExecutionAcceptanceContext({ executionRunId: w.executionRunId });
    expect(context.openWindow).toBeNull();
    expect(context.candidate).toBeNull();
    expect(context.boundary).toBe("post-commit-acceptance-boundary");
    expect(context.acceptedHead?.sequence).toBe(1);
  });
});
