/**
 * ExecutionReport application service (v0.2.0 E4 §23–§33).
 *
 * The unified Executor/Verifier report submission protocol. E4 §42 boundary:
 * submitExecutionReportInTx is an INTERNAL Application/Core protocol primitive
 * for tests and future adapter integration — there is deliberately NO
 * model-callable unauthenticated report-submission tool. Worker invocation
 * identity/authentication belongs to E5.
 *
 * Submission (one transaction, fail closed):
 *
 *   1. the Attempt exists, is state=running, and has no Report yet
 *   2. the Directive identity/role on the report are DERIVED from the Attempt
 *      (E4 §25) — redundant model-supplied ids are never trusted
 *   3. freshness (E4 §31/§32): the run's open Window is still the Directive's
 *      Window AND its candidateRevision still equals the Directive's
 *      baseCandidateRevision — for MUTATING and NON-MUTATING reports alike, so
 *      every Report binds the exact candidate state the Worker operated against
 *   4. deterministic contract validation (E4 §34): the Directive's persisted
 *      reportContract sections are non-empty; result=blocked carries at least
 *      one structured blocker; blockers are invalid on non-blocked results
 *   5. persist the immutable Report + transition Attempt running → reported
 *      (E4 §24/§18); when candidateMutated is factual, advance the Window
 *      candidateRevision N → N+1 through the E3 CAS primitive (E4 §30) — the
 *      previous candidate revision is stale for ANY directive kind and ANY
 *      result vocabulary value (blocked/failed may still have edited files).
 *
 * A Report NEVER creates accepted execution progress: no acceptedHead, no
 * ExecutionCommit, no window close, no stage completion (E4 §1/§26).
 */

import type { ExecutionAttempt } from "../core/execution-attempt.js";
import {
  parseExecutionReportRow,
  validateReportAgainstContract,
  type ExecutionBlocker,
  type ExecutionReport,
  type ExecutionReportResult,
} from "../core/execution-report.js";
import type { VerificationWindow } from "../core/verification-window.js";
import { RuntimeError } from "../runtime/errors.js";
import { getExecutionAttemptInTx } from "../store/execution-attempts.js";
import {
  getExecutionDirectiveInTx,
  insertProtocolEventInTx,
} from "../store/execution-directives.js";
import { getOpenWindowInTx, requireOpenWindowInTx } from "../store/execution-structure.js";
import { advanceCandidateRevisionInTx } from "../store/execution-structure.js";
import {
  getReportForAttemptInTx,
  insertExecutionReportInTx,
} from "../store/execution-reports.js";
import { markAttemptReportedInTx } from "../store/execution-attempts.js";
import type { DirectivePlanRef } from "../core/execution-directive.js";
import type { StoreClock } from "../store/migration-runner.js";
import type { PlanStore } from "../store/sqlite-store.js";
import type { StoreTx } from "../store/transaction.js";

export interface SubmitExecutionReportInput {
  attemptId: string;
  /** Logical report id; generated when omitted. */
  reportId?: string;
  result: ExecutionReportResult;
  /** Explicit factual mutation record — the E4 source of truth (E4 §29). */
  candidateMutated: boolean;
  actionPerformed?: Array<{ action: string; detail: string | null }>;
  filesExamined?: string[];
  filesChanged?: string[];
  commandsRun?: Array<{ command: string; detail: string | null }>;
  testsRun?: Array<{ name: string; outcome: string; detail: string | null }>;
  findings?: Array<{ summary: string; details: string | null }>;
  deviations?: Array<{ summary: string; details: string | null }>;
  blockers?: ExecutionBlocker[];
  deliverables?: Array<{ name: string; ref: DirectivePlanRef | null; detail: string | null }>;
}

export interface SubmissionResult {
  report: ExecutionReport;
  attempt: ExecutionAttempt;
  /** The Window state after submission (candidateRevision advanced when mutated). */
  window: VerificationWindow;
}

/**
 * The authoritative submission core. Runs inside the caller's write
 * transaction; any failure rolls the whole protocol step back.
 */
export function submitExecutionReportInTx(
  tx: StoreTx,
  input: SubmitExecutionReportInput,
  clock: StoreClock,
  now: string,
): SubmissionResult {
  const attempt = getExecutionAttemptInTx(tx, input.attemptId);
  if (attempt === null) {
    throw new RuntimeError(
      "REPORT_BINDING_MISMATCH",
      `no ExecutionAttempt exists for '${input.attemptId}'`,
      { detail: { attemptId: input.attemptId }, recoverable: false },
    );
  }
  const existingReport = getReportForAttemptInTx(tx, attempt.attemptId);
  if (existingReport !== null) {
    // P5 §4 — idempotent recognition of delayed or re-submitted report
    const existingDirective = getExecutionDirectiveInTx(tx, attempt.directiveId, attempt.directiveRevision);
    const window = existingDirective
      ? (getOpenWindowInTx(tx, attempt.executionRunId) ?? requireOpenWindowInTx(tx, attempt.executionRunId))
      : requireOpenWindowInTx(tx, attempt.executionRunId);
    return {
      report: existingReport,
      attempt,
      window,
    };
  }
  if (attempt.state === "reported") {
    throw new RuntimeError(
      "ATTEMPT_ALREADY_REPORTED",
      `attempt '${attempt.attemptId}' is already reported`,
      { detail: { attemptId: attempt.attemptId }, recoverable: false },
    );
  }
  if (attempt.state === "indeterminate") {
    throw new RuntimeError(
      "ATTEMPT_INDETERMINATE",
      `attempt '${attempt.attemptId}' is indeterminate; its outcome is unknown and no report may be fabricated`,
      { detail: { attemptId: attempt.attemptId }, recoverable: false },
    );
  }
  const directive = getExecutionDirectiveInTx(tx, attempt.directiveId, attempt.directiveRevision);
  if (directive === null || directive.hash !== attempt.directiveHash) {
    throw new RuntimeError(
      "REPORT_BINDING_MISMATCH",
      `attempt '${attempt.attemptId}' binds a missing or mismatched Directive revision`,
      { detail: { attemptId: attempt.attemptId }, recoverable: false },
    );
  }
  // E4 §31/§32 — the open window must STILL be the Directive's window, and
  // its candidate revision must STILL equal the Directive's base — regardless
  // of candidateMutated. Fail closed otherwise; never guess which mutation
  // came first.
  const open = requireOpenWindowInTx(tx, attempt.executionRunId);
  if (open.id !== directive.windowId) {
    throw new RuntimeError(
      "DIRECTIVE_NOT_CURRENT",
      `the run's open window '${open.id}' is no longer the directive's window '${directive.windowId}'`,
      { detail: { expected: directive.windowId, detected: open.id }, recoverable: false },
    );
  }
  if (open.candidateRevision !== directive.baseCandidateRevision) {
    throw new RuntimeError(
      "STALE_CANDIDATE_REVISION",
      `directive base candidate revision ${directive.baseCandidateRevision} is stale; the open window is at ${open.candidateRevision}`,
      { detail: { expected: open.candidateRevision, detected: directive.baseCandidateRevision }, recoverable: false },
    );
  }
  if (typeof input.candidateMutated !== "boolean") {
    throw new RuntimeError(
      "REPORT_CONTRACT_VIOLATION",
      "candidateMutated must be an explicit boolean — it is never inferred from the directive kind",
      { detail: { attemptId: attempt.attemptId }, recoverable: false },
    );
  }
  const report: ExecutionReport = {
    reportId: input.reportId ?? `rep_${clock.newId()}`,
    executionRunId: attempt.executionRunId,
    attemptId: attempt.attemptId,
    directiveId: attempt.directiveId,
    directiveRevision: attempt.directiveRevision,
    directiveHash: attempt.directiveHash,
    workerRole: attempt.workerRole,
    result: input.result,
    candidateMutated: input.candidateMutated,
    actionPerformed: input.actionPerformed ?? [],
    filesExamined: input.filesExamined ?? [],
    filesChanged: input.filesChanged ?? [],
    commandsRun: input.commandsRun ?? [],
    testsRun: input.testsRun ?? [],
    findings: input.findings ?? [],
    deviations: input.deviations ?? [],
    blockers: input.blockers ?? [],
    deliverables: input.deliverables ?? [],
    createdAt: now,
  };
  validateReportAgainstContract(report, directive.reportContract);
  // E14 §1 bug fix — the canonical read parser is the report's shape law; a
  // payload that would not parse must be refused BEFORE durability, never
  // stored as a row every later read rejects as corrupt.
  try {
    parseExecutionReportRow(report as unknown as Record<string, unknown>);
  } catch (err) {
    throw new RuntimeError("STORE_SCHEMA_INVALID", "submitted ExecutionReport content is structurally invalid", {
      detail: {
        attemptId: attempt.attemptId,
        violations: err instanceof RuntimeError ? (err.detail?.violations ?? []) : [String(err)],
      },
      recoverable: false,
      cause: err instanceof Error ? err.message : String(err),
    });
  }
  insertExecutionReportInTx(tx, report);
  markAttemptReportedInTx(tx, attempt.attemptId, now);
  const window =
    report.candidateMutated
      ? advanceCandidateRevisionInTx(tx, { executionRunId: attempt.executionRunId, expectedRevision: directive.baseCandidateRevision })
      : (getOpenWindowInTx(tx, attempt.executionRunId) as VerificationWindow);
  insertProtocolEventInTx(
    tx,
    {
      executionRunId: attempt.executionRunId,
      eventType: "ATTEMPT_REPORTED",
      directiveId: attempt.directiveId,
      directiveRevision: attempt.directiveRevision,
      attemptId: attempt.attemptId,
    },
    now,
  );
  return {
    report: report,
    attempt: getExecutionAttemptInTx(tx, attempt.attemptId) as ExecutionAttempt,
    window,
  };
}

export function createExecutionReportService(store: PlanStore, clock: StoreClock) {
  return {
    /** Internal protocol primitive (E4 §42) — never a model-callable tool in E4. */
    submitExecutionReport(input: SubmitExecutionReportInput): SubmissionResult {
      return store.withWrite((tx) => submitExecutionReportInTx(tx, input, clock, clock.nowIso()));
    },

    getReport(input: { reportId: string }): ExecutionReport | null {
      return store.withRead((tx) => getReportForAttemptInTx(tx, input.reportId) ?? null);
    },

    getReportForAttempt(input: { attemptId: string }): ExecutionReport | null {
      return store.withRead((tx) => getReportForAttemptInTx(tx, input.attemptId));
    },
  };
}
