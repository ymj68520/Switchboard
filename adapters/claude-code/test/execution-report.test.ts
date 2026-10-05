/**
 * v0.2.0 E4 — ExecutionReport foundation (E4 §47 focused tests T21–T33, T36).
 *
 * Target state under test: the ONE immutable unified Executor/Verifier report,
 * the frozen result vocabulary, structured blockers, factual candidateMutated,
 * atomic candidateRevision advancement, staleness fail-closed, and the
 * recovery-context projection. No report ever creates accepted progress.
 */
import { describe, expect, it } from "vitest";

import { EXECUTION_BLOCKER_KINDS } from "../src/core/execution-report.js";
import { getExecutionAttemptInTx } from "../src/store/execution-attempts.js";
import { getExecutionReportInTx, getReportForAttemptInTx } from "../src/store/execution-reports.js";
import { getOpenWindowInTx } from "../src/store/execution-structure.js";
import { inspectSchemaState } from "../src/store/schema.js";
import { createExecutionReportService } from "../src/application/execution-report-service.js";
import {
  advanceCandidate,
  codeOf,
  fullEnvelope,
  issueDirective,
  makeActiveExecutionWorld,
  startAttempt,
  submitReport,
  type E4World,
} from "./execution-protocol-helpers.js";
import { createSupervisorBindingService } from "../src/application/supervisor-binding-service.js";
import { renderExecutionRecoveryContext } from "../src/context/execution-recovery.js";

/** Issue → start → submit, one full protocol cycle (only one may run at a time). */
function cycle(
  w: E4World,
  directiveOverrides: Partial<Parameters<typeof issueDirective>[1]>,
  reportOverrides: Partial<Parameters<typeof submitReport>[2]>,
) {
  const directive = issueDirective(w, { directiveId: `DIR-CYC-${Math.random().toString(36).slice(2, 8)}`, ...directiveOverrides });
  const { attempt } = startAttempt(w, {
    directiveId: directive.directiveId,
    revision: directive.revision,
    hash: directive.hash,
  }, { workerRole: directive.kind === "verification" ? "verifier" : "executor" });
  return { directive, attempt, submission: submitReport(w, attempt.attemptId, reportOverrides) };
}

describe("v0.2.0 E4 — ExecutionReport foundation (T21–T33, T36)", () => {
  it("T21: executor and verifier reports are the SAME artifact, table, and parser", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      const executor = cycle(w, { kind: "implementation" }, { result: "completed", candidateMutated: false });
      const verifier = cycle(
        w,
        { kind: "verification" },
        { result: "completed", candidateMutated: false, testsRun: [{ name: "suite", outcome: "pass", detail: null }] },
      );
      const executorRow = w.ctx.store.withRead((tx) => getReportForAttemptInTx(tx, executor.attempt.attemptId));
      const verifierRow = w.ctx.store.withRead((tx) => getReportForAttemptInTx(tx, verifier.attempt.attemptId));
      expect(executorRow!.workerRole).toBe("executor");
      expect(verifierRow!.workerRole).toBe("verifier");
      // Same parser, same shape — only the role differs.
      expect(Object.keys(executorRow!).sort()).toEqual(Object.keys(verifierRow!).sort());
      // No VerificationReport artifact exists anywhere.
      const tables = w.ctx.store.withRead((tx) =>
        tx.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all(),
      ) as Array<{ name: string }>;
      expect(tables.map((row) => row.name)).not.toContain("verification_reports");
      expect(executorRow!.reportId).not.toBe(verifierRow!.reportId);
    } finally {
      w.ctx.store.close();
    }
  });

  it("T22: the full result vocabulary round-trips", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      for (const result of ["completed", "partial", "blocked", "failed"] as const) {
        const { submission } = cycle(
          w,
          {},
          {
            result,
            candidateMutated: false,
            ...(result === "blocked"
              ? { blockers: [{ kind: "MISSING_PREREQUISITE" as const, summary: "s", details: null, relevantRefs: [] }] }
              : {}),
          },
        );
        expect(submission.report.result).toBe(result);
        const persisted = w.ctx.store.withRead((tx) => getReportForAttemptInTx(tx, submission.attempt.attemptId));
        expect(persisted!.result).toBe(result);
      }
    } finally {
      w.ctx.store.close();
    }
  });

  it("T23: result=blocked with zero blockers violates the contract", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      const directive = issueDirective(w, { directiveId: "DIR-B" });
      const { attempt } = startAttempt(w, { directiveId: "DIR-B", revision: 1, hash: directive.hash });
      expect(codeOf(() => submitReport(w, attempt.attemptId, { result: "blocked", candidateMutated: false }))).toBe(
        "REPORT_CONTRACT_VIOLATION",
      );
      // Nothing was persisted by the failed submission.
      expect(w.ctx.store.withRead((tx) => getReportForAttemptInTx(tx, attempt.attemptId))).toBeNull();
      expect(w.ctx.store.withRead((tx) => getExecutionAttemptInTx(tx, attempt.attemptId))!.state).toBe("running");
    } finally {
      w.ctx.store.close();
    }
  });

  it("T24: all structured blocker kinds parse and persist", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      const blockers = EXECUTION_BLOCKER_KINDS.map((kind) => ({
        kind,
        summary: `${kind} summary`,
        details: `${kind} details`,
        relevantRefs: [],
      }));
      const { submission } = cycle(w, {}, { result: "blocked", candidateMutated: false, blockers });
      expect(submission.report.blockers.map((blocker) => blocker.kind)).toEqual([...EXECUTION_BLOCKER_KINDS]);
      const persisted = w.ctx.store.withRead((tx) => getReportForAttemptInTx(tx, submission.attempt.attemptId));
      expect(persisted!.blockers).toEqual(blockers);
    } finally {
      w.ctx.store.close();
    }
  });

  it("T25: a non-mutating report leaves the window revision unchanged", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      const before = w.ctx.store.withRead((tx) => getOpenWindowInTx(tx, w.executionRunId));
      const { submission } = cycle(w, {}, { result: "completed", candidateMutated: false });
      expect(submission.window.candidateRevision).toBe(before!.candidateRevision);
      expect(w.ctx.store.withRead((tx) => getOpenWindowInTx(tx, w.executionRunId))!.candidateRevision).toBe(0);
    } finally {
      w.ctx.store.close();
    }
  });

  it("T26: a mutating report atomically persists the report, reports the attempt, and advances the revision", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      const { submission } = cycle(w, {}, { result: "completed", candidateMutated: true, filesChanged: ["src/a.ts"] });
      expect(submission.report.candidateMutated).toBe(true);
      expect(submission.attempt.state).toBe("reported");
      expect(submission.window.candidateRevision).toBe(1);
      const persisted = w.ctx.store.withRead((tx) => getOpenWindowInTx(tx, w.executionRunId));
      expect(persisted!.candidateRevision).toBe(1);
    } finally {
      w.ctx.store.close();
    }
  });

  it("T27: blocked after partial mutation advances the candidate — blocked ≠ no side effects", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      const { submission } = cycle(
        w,
        {},
        {
          result: "blocked",
          candidateMutated: true,
          filesChanged: ["src/partial.ts"],
          blockers: [{ kind: "EXECUTION_ENVIRONMENT_BLOCKER", summary: "toolchain broke mid-edit", details: null, relevantRefs: [] }],
        },
      );
      expect(submission.report.result).toBe("blocked");
      expect(submission.report.candidateMutated).toBe(true);
      expect(submission.window.candidateRevision).toBe(1);
    } finally {
      w.ctx.store.close();
    }
  });

  it("T28: failed after mutation also advances the candidate", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      const { submission } = cycle(w, {}, { result: "failed", candidateMutated: true, filesChanged: ["src/broken.ts"] });
      expect(submission.report.result).toBe("failed");
      expect(submission.window.candidateRevision).toBe(1);
    } finally {
      w.ctx.store.close();
    }
  });

  it("T29: a verification directive whose verifier unexpectedly mutates keeps the evidence and advances", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      const { submission } = cycle(
        w,
        { kind: "verification" },
        {
          result: "completed",
          candidateMutated: true,
          filesChanged: ["src/fixture-crash.ts"],
          deviations: [{ summary: "verification fixture rewrote a source file", details: null }],
        },
      );
      expect(submission.report.workerRole).toBe("verifier");
      expect(submission.report.candidateMutated).toBe(true);
      expect(w.ctx.store.withRead((tx) => getReportForAttemptInTx(tx, submission.attempt.attemptId))!.candidateMutated).toBe(true);
      expect(w.ctx.store.withRead((tx) => getOpenWindowInTx(tx, w.executionRunId))!.candidateRevision).toBe(1);
    } finally {
      w.ctx.store.close();
    }
  });

  it("T30: a stale report fails closed — the candidate moved past the directive base", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      const directive = issueDirective(w, { directiveId: "DIR-A" });
      const { attempt } = startAttempt(w, { directiveId: "DIR-A", revision: 1, hash: directive.hash });
      // Simulate an external/untracked candidate move (production CAS path).
      advanceCandidate(w, 0);
      expect(
        codeOf(() => submitReport(w, attempt.attemptId, { result: "completed", candidateMutated: false })),
      ).toBe("STALE_CANDIDATE_REVISION");
      // Even a MUTATING report is refused — never guess which mutation came first.
      expect(
        codeOf(() => submitReport(w, attempt.attemptId, { result: "failed", candidateMutated: true })),
      ).toBe("STALE_CANDIDATE_REVISION");
      expect(w.ctx.store.withRead((tx) => getReportForAttemptInTx(tx, attempt.attemptId))).toBeNull();
      expect(w.ctx.store.withRead((tx) => getExecutionAttemptInTx(tx, attempt.attemptId))!.state).toBe("running");
      expect(w.ctx.store.withRead((tx) => getOpenWindowInTx(tx, w.executionRunId))!.candidateRevision).toBe(1);
    } finally {
      w.ctx.store.close();
    }
  });

  it("T31: a persisted Report is immutable — no UPDATE, no DELETE, no edit API", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      const { submission } = cycle(w, {}, { result: "completed", candidateMutated: false });
      const reportId = submission.report.reportId;
      expect(
        w.ctx.store.withWrite((tx) => {
          try {
            tx.prepare("UPDATE execution_reports SET result = 'failed' WHERE report_id = ?").run(reportId);
            return "updated";
          } catch {
            return "rejected";
          }
        }),
      ).toBe("rejected");
      expect(
        w.ctx.store.withWrite((tx) => {
          try {
            tx.prepare("DELETE FROM execution_reports WHERE report_id = ?").run(reportId);
            return "deleted";
          } catch {
            return "rejected";
          }
        }),
      ).toBe("rejected");
      const reportServiceObj = createExecutionReportService(w.ctx.store, w.ctx.clock) as Record<string, unknown>;
      expect(Object.keys(reportServiceObj)).not.toContain("editReport");
      expect(Object.keys(reportServiceObj)).not.toContain("appendBlocker");
      expect(Object.keys(reportServiceObj)).not.toContain("replaceReport");
      expect(w.ctx.store.withRead((tx) => getExecutionReportInTx(tx, reportId))!.result).toBe("completed");
    } finally {
      w.ctx.store.close();
    }
  });

  it("T32: one report per Attempt — a second submission is refused", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      const directive = issueDirective(w, { directiveId: "DIR-A" });
      const { attempt } = startAttempt(w, { directiveId: "DIR-A", revision: 1, hash: directive.hash });
      submitReport(w, attempt.attemptId, { result: "partial", candidateMutated: false });
      expect(codeOf(() => submitReport(w, attempt.attemptId, { result: "completed", candidateMutated: false }))).toBe(
        "REPORT_ALREADY_EXISTS",
      );
      expect(codeOf(() => submitReport(w, attempt.attemptId, { result: "completed", candidateMutated: true }))).toBe(
        "REPORT_ALREADY_EXISTS",
      );
      expect(w.ctx.store.withRead((tx) => getReportForAttemptInTx(tx, attempt.attemptId))!.result).toBe("partial");
    } finally {
      w.ctx.store.close();
    }
  });

  it("T33: report bindings are derived from the Attempt and verified — mismatches fail", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      expect(codeOf(() => submitReport(w, "att_ghost", { result: "completed", candidateMutated: false }))).toBe(
        "REPORT_BINDING_MISMATCH",
      );
      const { submission } = cycle(w, {}, { result: "completed", candidateMutated: false });
      const attempt = w.ctx.store.withRead((tx) => getExecutionAttemptInTx(tx, submission.attempt.attemptId))!;
      const report = w.ctx.store.withRead((tx) => getReportForAttemptInTx(tx, submission.attempt.attemptId))!;
      // Derived identity: report directive/role == attempt directive/role, exactly.
      expect(report.directiveId).toBe(attempt.directiveId);
      expect(report.directiveRevision).toBe(attempt.directiveRevision);
      expect(report.directiveHash).toBe(attempt.directiveHash);
      expect(report.workerRole).toBe(attempt.workerRole);
      expect(report.executionRunId).toBe(attempt.executionRunId);
      // The store validator flags a hand-corrupted binding.
      const corruptProbe = w.ctx.store.withWrite((tx) => {
        try {
          tx.exec("DROP TRIGGER execution_reports_no_update");
          tx.prepare("UPDATE execution_reports SET directive_id = 'DIR-OTHER' WHERE report_id = ?").run(report.reportId);
          tx.exec("CREATE TRIGGER execution_reports_no_update BEFORE UPDATE ON execution_reports BEGIN SELECT RAISE(ABORT, 'execution_reports is immutable'); END");
          return "corrupted";
        } catch {
          return "rejected";
        }
      });
      expect(corruptProbe).toBe("corrupted");
      const state = w.ctx.store.withRead((tx) => inspectSchemaState(tx));
      expect(state.consistent).toBe(false);
      expect(state.problems.some((problem) => problem.includes("execution report"))).toBe(true);
    } finally {
      w.ctx.store.close();
    }
  });

  it("T36: the recovery context projects the exact Directive/Attempt/Report/candidateRevision state", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      const supervisor = createSupervisorBindingService(w.ctx.store, w.ctx.clock);
      // Before any directive: the protocol section reports none issued.
      const facts0 = w.ctx.store.withRead((tx) =>
        supervisor.loadExecutionRecoveryFactsInTx(tx, { executionRunId: w.executionRunId, sessionId: w.f.sessionId }),
      );
      expect(facts0.protocol).toBeNull();
      const text0 = renderExecutionRecoveryContext(facts0);
      expect(text0).toContain("latest directive: none issued");
      expect(text0).toContain("accepted head: execution_start (no accepted commits yet)");

      const directive = issueDirective(w, {
        directiveId: "DIR-RX",
        capabilityEnvelope: fullEnvelope(),
      });
      const { attempt } = startAttempt(w, { directiveId: "DIR-RX", revision: 1, hash: directive.hash });
      const facts1 = w.ctx.store.withRead((tx) =>
        supervisor.loadExecutionRecoveryFactsInTx(tx, { executionRunId: w.executionRunId, sessionId: w.f.sessionId }),
      );
      expect(facts1.protocol!.latestDirective).toMatchObject({
        directiveId: "DIR-RX",
        revision: 1,
        hash: directive.hash,
        baseCandidateRevision: 0,
      });
      expect(facts1.protocol!.attempt).toEqual({
        attemptId: attempt.attemptId,
        workerRole: "executor",
        state: "running",
        // E5 §49 — the host-runtime correlation line joined the projection.
        workerRuntime: "unbound (legacy or not yet launched)",
      });
      expect(facts1.protocol!.latestReport).toBeNull();
      const text1 = renderExecutionRecoveryContext(facts1);
      expect(text1).toContain(`latest directive: DIR-RX@1 (implementation, ${directive.hash}, baseCandidateRevision=0)`);
      expect(text1).toContain(`attempt: ${attempt.attemptId} (executor, running) — runtime resolution pending`);

      submitReport(w, attempt.attemptId, {
        result: "blocked",
        candidateMutated: true,
        blockers: [
          { kind: "AMBIGUOUS_DIRECTIVE", summary: "unclear scope", details: null, relevantRefs: [] },
          { kind: "MISSING_CONTEXT", summary: "missing helper docs", details: null, relevantRefs: [] },
        ],
      });
      const facts2 = w.ctx.store.withRead((tx) =>
        supervisor.loadExecutionRecoveryFactsInTx(tx, { executionRunId: w.executionRunId, sessionId: w.f.sessionId }),
      );
      expect(facts2.protocol!.attempt).toMatchObject({ state: "reported" });
      expect(facts2.protocol!.latestReport).toEqual({
        result: "blocked",
        candidateMutated: true,
        blockerCount: 2,
        blockerKinds: ["AMBIGUOUS_DIRECTIVE", "MISSING_CONTEXT"],
      });
      const text2 = renderExecutionRecoveryContext(facts2);
      expect(text2).toContain(`attempt: ${attempt.attemptId} (executor, reported)`);
      expect(text2).toContain("latest report: result=blocked, candidateMutated=true, blockers=2 [AMBIGUOUS_DIRECTIVE, MISSING_CONTEXT]");
      expect(text2).toContain("candidateRevision=1");
      // Deterministic projection (E2-T13 analog for the protocol section).
      const again = renderExecutionRecoveryContext(facts2);
      expect(again).toBe(text2);
    } finally {
      w.ctx.store.close();
    }
  });
});
