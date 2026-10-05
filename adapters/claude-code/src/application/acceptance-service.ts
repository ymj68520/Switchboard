/**
 * Acceptance application service (v0.2.0 E6 §8–§21/§31/§35/§54).
 *
 * Authority model (E6 §1/§15): the Supervisor reads canonical candidate
 * evidence, submits an immutable semantic judgment, and CORE deterministically
 * validates the acceptance prerequisites. An `accept` disposition atomically
 * creates the ExecutionCommit, closes the exact Window, and CAS-advances the
 * acceptedHead — a report, a completed verifier, and the assessment itself can
 * never do that (E6 §1/§I14/§I15). Non-accept dispositions persist the
 * judgment only and never mutate accepted state (E6 §20).
 *
 * Fresh independent verification (E6 §13/§14) is proven from durable facts
 * only: a verification Directive at the exact current candidate, a verifier
 * Attempt executed through the real E5 Worker runtime (claimed invocation,
 * finished through the report path), and a completed non-mutating Report.
 * Independence is validated from the persisted worker-session identities where
 * the data permits — never from role strings or model families alone.
 *
 * The current-candidate rule (E6 §9) is deterministic: a Report is
 * current-candidate evidence exactly when its Directive operated against the
 * Window's current candidateRevision. Timestamps never decide freshness.
 */

import type { ExecutionRun } from "../core/execution-run.js";
import type { ExecutionStage } from "../core/execution-stage.js";
import type { VerificationWindow } from "../core/verification-window.js";
import type { ExecutionDirective, DirectivePlanRef } from "../core/execution-directive.js";
import type { ExecutionAttempt } from "../core/execution-attempt.js";
import type { ExecutionReport } from "../core/execution-report.js";
import type { ExecutionCommit } from "../core/execution-commit.js";
import {
  isNegativeReportResult,
  parseCoveredObligation,
  parseReportJudgmentInput,
  validationRequirementObligation,
  type CoveredObligation,
  type ReportJudgment,
  type SupervisorAssessment,
  type SupervisorAssessmentDisposition,
} from "../core/supervisor-assessment.js";
import { isQualifyingNormalVerification } from "../core/verification-policy.js";
import { listBlockingConflictsInTx } from "./verification-conflict-service.js";
import {
  directiveCarriesStageCompletionVerification,
  deriveStageCompletionValidationRequirement,
  stageObjectiveObligation,
} from "../core/stage-completion.js";
import {
  deriveExecutionCompletionValidationRequirement,
  directiveCarriesExecutionCompletionVerification,
  executionRunCompletionObligation,
} from "../core/execution-completion.js";
import { runExecutionCompletionGateInTx, loadExecutionCompletionSemanticsInTx } from "./final-closure-service.js";
import { isAttemptUnresolvedIndeterminateInTx } from "./recovery-fence.js";
import { RuntimeError } from "../runtime/errors.js";
import { getExecutionRunInTx } from "../store/execution-runs.js";
import { getFinalPlanInTx } from "../store/finalization.js";
import {
  getActiveExecutionStageInTx,
  getOpenWindowInTx,
  requireActiveStageInTx,
  requireOpenWindowInTx,
  requireOpenStageWindowInTx,
  closeWindowByExecutionCommitInTx,
  completeStageByExecutionCommitInTx,
  insertOpenWindowInTx,
} from "../store/execution-structure.js";
import { requireCurrentSupervisorAuthorityInTx, detachSupervisorBindingInTx } from "../store/supervisor-bindings.js";
import {
  listWindowDirectivesInTx,
} from "../store/execution-directives.js";
import { listWindowAttemptsInTx, getRunningAttemptInTx } from "../store/execution-attempts.js";
import { getReportForAttemptInTx } from "../store/execution-reports.js";
import { getWorkerInvocationInTx } from "../store/worker-invocations.js";
import {
  insertExecutionCommitInTx,
  advanceAcceptedHeadInTx,
  getAcceptedHeadCommitIdInTx,
  getExecutionCommitInTx,
} from "../store/execution-commits.js";
import {
  insertSupervisorAssessmentInTx,
  insertAcceptanceEventInTx,
  listWindowAssessmentsInTx,
} from "../store/supervisor-assessments.js";
import { requirePlanRefsUnderFinalPlan } from "./execution-directive-service.js";
import { parseFinalPlanCanonical } from "./final-plan-canonical.js";
import type { StoreClock } from "../store/migration-runner.js";
import type { PlanStore } from "../store/sqlite-store.js";
import type { StoreTx } from "../store/transaction.js";

function acceptanceError(
  code:
    | "SUPERVISOR_ASSESSMENT_STALE"
    | "ASSESSMENT_REPORT_COVERAGE_INCOMPLETE"
    | "ASSESSMENT_REPORT_INVALID"
    | "ACCEPTANCE_BLOCKED"
    | "ACCEPTANCE_VERIFICATION_REQUIRED"
    | "ACCEPTANCE_VERIFICATION_STALE"
    | "ACCEPTANCE_INDETERMINATE_WORK"
    | "ACCEPTANCE_ATTEMPT_RUNNING"
    | "EXECUTION_COMMIT_CONFLICT"
    | "EXECUTION_COMMIT_ALREADY_EXISTS"
    | "STALE_EXECUTION_HEAD"
    | "WINDOW_BASE_MISMATCH"
    // v0.2.0 E7 — Stage completion inside the acceptance gate (§35/§36).
    | "STAGE_COMPLETION_OBLIGATION_INVALID"
    | "STAGE_COMPLETION_VERIFICATION_REQUIRED"
    | "STAGE_ALREADY_COMPLETED"
    // v0.2.0 E8 — the conflict fence (§40).
    | "ACCEPTANCE_VERIFICATION_CONFLICT"
    // v0.2.0 E10 — final closure + ExecutionCompletionGate (§32/§64).
    | "EXECUTION_COMPLETION_OBLIGATION_REQUIRED"
    | "EXECUTION_COMPLETION_OBLIGATION_INVALID"
    | "EXECUTION_COMPLETION_VERIFICATION_REQUIRED"
    | "EXECUTION_SCOPE_INVALID",
  message: string,
  detail?: Record<string, unknown>,
): RuntimeError {
  return new RuntimeError(code, message, { detail, recoverable: false });
}

// ---------------------------------------------------------------------------
// Canonical evidence enumeration (E6 §8/§9) — Store-derived, never
// Supervisor-enumerated.
// ---------------------------------------------------------------------------

/** One Report's canonical acceptance facts (no repository text, no hidden
 * reasoning — Store facts only, E6 §8). */
export interface WindowReportFact {
  reportId: string;
  attemptId: string;
  workerRole: "executor" | "verifier";
  directiveId: string;
  directiveRevision: number;
  directiveKind: string;
  directiveObjective: string;
  baseCandidateRevision: number;
  result: ExecutionReport["result"];
  candidateMutated: boolean;
  attemptStartedAt: string;
  reportCreatedAt: string;
  workerSessionId: string | null;
  invocationState: string | null;
  /** E6 §9 — bound to the Window's CURRENT candidateRevision, non-mutating. */
  isCurrentCandidate: boolean;
  /** E6 §13 — satisfies the fresh-independent-verification shape. */
  isQualifyingVerification: boolean;
  findingCount: number;
  deviationCount: number;
  blockerCount: number;
  blockerKinds: string[];
  testOutcomeSummary: string[];
}

interface WindowEvidence {
  window: VerificationWindow;
  /** E10 — null exactly for the final-closure window (run-level, no Stage). */
  stage: ExecutionStage | null;
  directives: ExecutionDirective[];
  attempts: Array<{ attempt: ExecutionAttempt; directive: ExecutionDirective }>;
  facts: WindowReportFact[];
  currentFacts: WindowReportFact[];
  historicalFacts: WindowReportFact[];
}

/**
 * E6 §9 — deterministic current-candidate rule: a Report is current-candidate
 * evidence exactly when its Directive's baseCandidateRevision equals the
 * Window's CURRENT candidateRevision (mutating reports at N have already
 * advanced the Window, so they are historical for N by construction).
 * Timestamps never decide freshness.
 */
function buildWindowEvidenceInTx(tx: StoreTx, window: VerificationWindow, stage: ExecutionStage | null): WindowEvidence {
  const directives = listWindowDirectivesInTx(tx, window.id);
  const directiveById = new Map(directives.map((d) => [`${d.directiveId}@${d.revision}`, d] as const));
  const attempts = listWindowAttemptsInTx(tx, window.id).flatMap((attempt) => {
    const directive = directiveById.get(`${attempt.directiveId}@${attempt.directiveRevision}`);
    return directive === undefined ? [] : [{ attempt, directive }];
  });
  const facts: WindowReportFact[] = [];
  for (const { attempt, directive } of attempts) {
    const report = getReportForAttemptInTx(tx, attempt.attemptId);
    if (report === null) {
      continue;
    }
    const invocation = getWorkerInvocationInTx(tx, attempt.attemptId);
    const isCurrentCandidate = directive.baseCandidateRevision === window.candidateRevision && !report.candidateMutated;
    // E8 §11/§34 — the E6 fresh-verification predicate and the E8
    // normal-verification predicate are THE SAME predicate: a v2 Directive
    // qualifies only with verificationPurpose=normal (a conflict resolver is
    // never candidate verification), while v1 history keeps its frozen
    // interpretation.
    const isQualifyingVerification = isQualifyingNormalVerification({
      directive,
      report,
      attemptId: attempt.attemptId,
      attemptState: attempt.state,
      workerRole: attempt.workerRole,
      invocationState: invocation?.state ?? null,
      attemptStartedAt: attempt.startedAt,
      reportCreatedAt: report.createdAt,
    });
    facts.push({
      reportId: report.reportId,
      attemptId: attempt.attemptId,
      workerRole: attempt.workerRole,
      directiveId: directive.directiveId,
      directiveRevision: directive.revision,
      directiveKind: directive.kind,
      directiveObjective: directive.objective,
      baseCandidateRevision: directive.baseCandidateRevision,
      result: report.result,
      candidateMutated: report.candidateMutated,
      attemptStartedAt: attempt.startedAt,
      reportCreatedAt: report.createdAt,
      workerSessionId: invocation?.workerSessionId ?? null,
      invocationState: invocation?.state ?? null,
      isCurrentCandidate,
      isQualifyingVerification,
      findingCount: report.findings.length,
      deviationCount: report.deviations.length,
      blockerCount: report.blockers.length,
      blockerKinds: report.blockers.map((blocker) => blocker.kind),
      testOutcomeSummary: report.testsRun.map((test) => `${test.name}: ${test.outcome}`),
    });
  }
  return {
    window,
    stage,
    directives,
    attempts,
    facts,
    currentFacts: facts.filter((fact) => fact.isCurrentCandidate),
    historicalFacts: facts.filter((fact) => !fact.isCurrentCandidate),
  };
}

/** Deterministic protocol order for "created later" comparisons (E6 §11). */
function protocolOrder(fact: WindowReportFact): string {
  return `${fact.attemptStartedAt}|${fact.reportCreatedAt}|${fact.attemptId}|${fact.reportId}`;
}

/** Copy snake_case model-boundary keys onto their canonical camelCase names. */
export function normalizeSnakeRecord(
  record: Record<string, unknown>,
  pairs: ReadonlyArray<readonly [string, string]>,
): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...record };
  for (const [snake, camel] of pairs) {
    if (normalized[camel] === undefined && normalized[snake] !== undefined) {
      normalized[camel] = normalized[snake];
    }
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// Acceptance context (E6 §8/§40/§54) — read-only Supervisor surface.
// ---------------------------------------------------------------------------

export interface ExecutionAcceptanceContext {
  executionRun: Pick<ExecutionRun, "executionRunId" | "lifecycle">;
  /** E6 §25 — null = the execution-start baseline is the accepted base. */
  acceptedHead: { commitId: string; sequence: number; createdAt: string } | null;
  activeStage: { id: string; objective: string } | null;
  /** E6 §54 — null is the valid post-commit acceptance boundary. */
  openWindow: null | {
    id: string;
    /** E10 §7 — the window's execution scope. */
    scopeKind: "stage" | "final_closure";
    candidateRevision: number;
    baseKind: VerificationWindow["baseKind"];
    baseCommitId: string | null;
    openedAt: string;
  };
  boundary: "no-active-stage" | "post-commit-acceptance-boundary" | null;
  /**
   * E7 §33 — the exact Stage-completion facts for the ACTIVE Stage: the
   * deterministic obligation identity, the required verifier requirement, and
   * whether current evidence already covers it. This lets the Supervisor know
   * whether an upcoming accept assessment would be an intermediate Commit or a
   * Stage-completing Commit. Core never decides that from prose.
   */
  stageCompletion: null | {
    stageId: string;
    objectiveHash: string;
    requiredVerificationRequirement: { requirement: string; detail: string };
    currentlyCovered: boolean;
  };
  candidate: null | {
    revision: number;
    directives: Array<{
      directiveId: string;
      revision: number;
      kind: string;
      baseCandidateRevision: number;
      objective: string;
      validationRequirements: Array<{ requirement: string; detail: string | null }>;
    }>;
    attempts: Array<{
      attemptId: string;
      workerRole: string;
      state: string;
      directiveId: string;
      directiveRevision: number;
    }>;
    /** E6 §9 — current-candidate evidence; the classification obligation. */
    currentReports: WindowReportFact[];
    /** Historical (stale-revision) evidence — commit provenance only (E6-T9). */
    historicalReports: WindowReportFact[];
    /** E6 §13 — the reports that currently satisfy the verification shape. */
    qualifyingVerificationReportIds: string[];
    /** E6 §40 — assessments split by exact candidateRevision. */
    assessments: Array<{
      assessmentId: string;
      disposition: SupervisorAssessmentDisposition;
      candidateRevision: number;
      isCurrent: boolean;
      createdAt: string;
    }>;
  };
}

export function loadExecutionAcceptanceContextInTx(tx: StoreTx, executionRunId: string): ExecutionAcceptanceContext {
  const run = getExecutionRunInTx(tx, executionRunId);
  if (run === null) {
    throw acceptanceError("WINDOW_BASE_MISMATCH", `no ExecutionRun exists for '${executionRunId}'`, {
      executionRunId,
    });
  }
  const headCommitId = getAcceptedHeadCommitIdInTx(tx, executionRunId);
  const headCommit = headCommitId === null ? null : getExecutionCommitInTx(tx, headCommitId);
  const stage = getActiveExecutionStageInTx(tx, executionRunId);
  // E10 §31 — the open window drives the scope: a final-closure window is
  // acceptance surface for a run with NO active Stage.
  const openWindow = run.lifecycle === "active" ? getOpenWindowInTx(tx, executionRunId) : null;
  const evidence =
    run.lifecycle === "active" && openWindow !== null
      ? buildWindowEvidenceInTx(tx, openWindow, stage)
      : null;
  const requiredCompletion = stage === null ? null : deriveStageCompletionValidationRequirement(stage);
  const context: ExecutionAcceptanceContext = {
    executionRun: { executionRunId: run.executionRunId, lifecycle: run.lifecycle },
    acceptedHead:
      headCommit === null
        ? null
        : { commitId: headCommit.commitId, sequence: headCommit.sequence, createdAt: headCommit.createdAt },
    activeStage: stage === null ? null : { id: stage.id, objective: stage.objective },
    openWindow:
      openWindow === null
        ? null
        : {
            id: openWindow.id,
            scopeKind: openWindow.scopeKind,
            candidateRevision: openWindow.candidateRevision,
            baseKind: openWindow.baseKind,
            baseCommitId: openWindow.baseCommitId,
            openedAt: openWindow.openedAt,
          },
    boundary:
      stage === null
        ? "no-active-stage"
        : openWindow === null && run.lifecycle === "active"
          ? "post-commit-acceptance-boundary"
          : null,
    stageCompletion:
      stage === null || requiredCompletion === null
        ? null
        : {
            stageId: stage.id,
            objectiveHash: requiredCompletion.detail,
            requiredVerificationRequirement: requiredCompletion,
            currentlyCovered:
              evidence !== null
              && evidence.currentFacts.some((fact) => {
                if (!fact.isQualifyingVerification) {
                  return false;
                }
                const directive = evidence.directives.find(
                  (candidate) =>
                    candidate.directiveId === fact.directiveId && candidate.revision === fact.directiveRevision,
                );
                return directive !== undefined && directiveCarriesStageCompletionVerification(directive, stage);
              }),
          },
    candidate: null,
  };
  if (evidence === null || openWindow === null) {
    return context;
  }
  const assessments = listWindowAssessmentsInTx(tx, openWindow.id).map((assessment) => ({
    assessmentId: assessment.assessmentId,
    disposition: assessment.disposition,
    candidateRevision: assessment.candidateRevision,
    isCurrent: assessment.candidateRevision === openWindow.candidateRevision,
    createdAt: assessment.createdAt,
  }));
  context.candidate = {
    revision: openWindow.candidateRevision,
    directives: evidence.directives.map((directive) => ({
      directiveId: directive.directiveId,
      revision: directive.revision,
      kind: directive.kind,
      baseCandidateRevision: directive.baseCandidateRevision,
      objective: directive.objective,
      validationRequirements: directive.validationRequirements,
    })),
    attempts: evidence.attempts.map(({ attempt, directive }) => ({
      attemptId: attempt.attemptId,
      workerRole: attempt.workerRole,
      state: attempt.state,
      directiveId: directive.directiveId,
      directiveRevision: directive.revision,
    })),
    currentReports: evidence.currentFacts,
    historicalReports: evidence.historicalFacts,
    qualifyingVerificationReportIds: evidence.currentFacts
      .filter((fact) => fact.isQualifyingVerification)
      .map((fact) => fact.reportId),
    assessments,
  };
  return context;
}

// ---------------------------------------------------------------------------
// The acceptance gate (E6 §21) — one atomic transaction per assessment.
// ---------------------------------------------------------------------------

export interface SubmitSupervisorAssessmentInput {
  executionRunId: string;
  /** Signed HostContext session — never model-supplied authority (E6 §6). */
  sessionId: string;
  workspaceId: string;
  /** The caller's known supervision fencing generation. */
  generation: number;
  disposition: SupervisorAssessmentDisposition;
  /** Non-empty audit provenance (E6 §45) — never parsed by Core. */
  rationale: string;
  reportJudgments: unknown[];
  coveredObligations: unknown[];
  /** Optional exact approved refs, validated like Directive planRefs (E6 §19). */
  planRefs?: DirectivePlanRef[];
  /** Stale-precondition fence over the Window's current candidateRevision. */
  expectedCandidateRevision: number;
}

export interface SupervisorAssessmentResult {
  assessment: SupervisorAssessment;
  /** Present exactly when disposition == accept — the commit this gate created. */
  commit: ExecutionCommit | null;
  window: VerificationWindow;
  acceptedHeadCommitId: string | null;
  /**
   * E7 §11 — true exactly when this accepted Commit carried the exact
   * stage_objective obligation and Core completed the Stage atomically.
   */
  stageCompleted: boolean;
  /**
   * E10 §37/§42 — true exactly when this was the FINAL accept: the
   * ExecutionCompletionGate transitioned the run active → completed inside
   * the same transaction (completion provenance + binding detach included).
   */
  runCompleted: boolean;
}

/**
 * The authoritative assessment submission (E6 §19/§20/§21). For non-accept
 * dispositions exactly ONE durable thing happens: the immutable assessment
 * (+ judgments) is persisted. For `accept` the ENTIRE acceptance operation —
 * gates, assessment, commit, window close, head CAS — is one transaction: any
 * failure leaves no assessment, no commit, no window close, no head movement
 * (E6 §21). An `accept` assessment can therefore never exist without its
 * commit.
 */
export function submitSupervisorAssessmentInTx(
  tx: StoreTx,
  input: SubmitSupervisorAssessmentInput,
  clock: StoreClock,
  now: string,
): SupervisorAssessmentResult {
  // E6 §6 — the E2 fence: current active run, exact workspace, CURRENT
  // attached supervisor session + generation. A Worker (attempt-scoped
  // authority, E5 §34) and a stale former Supervisor both fail closed here.
  requireCurrentSupervisorAuthorityInTx(tx, {
    executionRunId: input.executionRunId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    generation: input.generation,
  });
  if (typeof input.rationale !== "string" || input.rationale.trim() === "") {
    throw acceptanceError("ASSESSMENT_REPORT_INVALID", "assessment rationale must be a non-empty string (E6 §45)");
  }
  // E10 §31 — the open WINDOW decides the scope: a final-closure window is
  // the acceptance surface for a run with NO active Stage (never a fake one);
  // a stage window keeps the exact E6/E7 stage authority triangle.
  const openWindowPre = requireOpenWindowInTx(tx, input.executionRunId);
  const finalClosure = openWindowPre.scopeKind === "final_closure";
  const stage = finalClosure ? null : requireActiveStageInTx(tx, input.executionRunId);
  const window = finalClosure ? openWindowPre : requireOpenStageWindowInTx(tx, input.executionRunId);
  if (input.expectedCandidateRevision !== window.candidateRevision) {
    throw acceptanceError(
      "SUPERVISOR_ASSESSMENT_STALE",
      `assessment expected candidate revision ${input.expectedCandidateRevision}; the open window is at ${window.candidateRevision}`,
      { expected: input.expectedCandidateRevision, detected: window.candidateRevision },
    );
  }

  // E6 §18 — acceptance cannot occur while Worker work is in progress.
  const running = getRunningAttemptInTx(tx, input.executionRunId);
  if (running !== null) {
    throw acceptanceError(
      "ACCEPTANCE_ATTEMPT_RUNNING",
      `attempt '${running.attemptId}' is still running; no acceptance while Worker work is in progress (E6 §18)`,
      { attemptId: running.attemptId },
    );
  }
  const evidence = buildWindowEvidenceInTx(tx, window, stage);

  // E6 §17 — an unresolved indeterminate Attempt blocks acceptance; no
  // reconciliation-resolution protocol exists yet, so there is no path past
  // this gate and no Report may be fabricated for it.
  // E11 §36 — only UNRESOLVED indeterminate Attempts block acceptance; a
  // reconciled historical indeterminate Attempt never poisons execution (its
  // history remains queryable).
  const indeterminate = evidence.attempts.filter(
    ({ attempt }) => isAttemptUnresolvedIndeterminateInTx(tx, attempt),
  );
  if (indeterminate.length > 0) {
    throw acceptanceError(
      "ACCEPTANCE_INDETERMINATE_WORK",
      `attempt '${indeterminate[0]!.attempt.attemptId}' is indeterminate; unresolved indeterminate work blocks acceptance (E6 §17)`,
      { attemptIds: indeterminate.map(({ attempt }) => attempt.attemptId) },
    );
  }

  // E6 §10/§19 — parse and validate the semantic input. The model boundary may
  // speak snake_case; normalize to the canonical shape before parsing.
  const judgments: ReportJudgment[] = input.reportJudgments.map((raw) =>
    parseReportJudgmentInput(
      typeof raw === "object" && raw !== null
        ? normalizeSnakeRecord(raw as Record<string, unknown>, [
            ["report_id", "reportId"],
            ["superseded_by_report_id", "supersededByReportId"],
          ])
        : raw,
    ),
  );
  const factsByReportId = new Map(evidence.facts.map((fact) => [fact.reportId, fact] as const));
  const currentByReportId = new Map(evidence.currentFacts.map((fact) => [fact.reportId, fact] as const));
  const seenReportIds = new Set<string>();
  for (const judgment of judgments) {
    if (seenReportIds.has(judgment.reportId)) {
      throw acceptanceError(
        "ASSESSMENT_REPORT_COVERAGE_INCOMPLETE",
        `report '${judgment.reportId}' carries duplicate judgments; exactly one judgment per report`,
        { reportId: judgment.reportId },
      );
    }
    seenReportIds.add(judgment.reportId);
    const fact = factsByReportId.get(judgment.reportId);
    if (fact === undefined) {
      throw acceptanceError(
        "ASSESSMENT_REPORT_INVALID",
        `judgment names report '${judgment.reportId}' which does not exist in this run/window`,
        { reportId: judgment.reportId },
      );
    }
    if (!fact.isCurrentCandidate) {
      throw acceptanceError(
        "ASSESSMENT_REPORT_INVALID",
        `judgment names report '${judgment.reportId}' from another candidate revision (base ${fact.baseCandidateRevision}); historical reports are never classified`,
        { reportId: judgment.reportId, baseCandidateRevision: fact.baseCandidateRevision },
      );
    }
    // E6 §11 — negative results may never carry a `supporting` judgment.
    if (isNegativeReportResult(fact.result) && judgment.disposition === "supporting") {
      throw acceptanceError(
        "ASSESSMENT_REPORT_INVALID",
        `report '${judgment.reportId}' has result=${fact.result}; a negative report cannot be classified supporting (E6 §11)`,
        { reportId: judgment.reportId, result: fact.result },
      );
    }
    if (judgment.disposition === "superseded") {
      const superseder = judgment.supersededByReportId === undefined ? null : currentByReportId.get(judgment.supersededByReportId);
      if (
        superseder === undefined
        || superseder === null
        || protocolOrder(superseder) <= protocolOrder(fact)
        || superseder.reportId === judgment.reportId
      ) {
        throw acceptanceError(
          "ASSESSMENT_REPORT_INVALID",
          `superseded judgment for '${judgment.reportId}' must name a LATER current-candidate report in this window (E6 §11)`,
          {
            reportId: judgment.reportId,
            supersededByReportId: judgment.supersededByReportId ?? null,
          },
        );
      }
    }
  }

  const obligations: CoveredObligation[] = input.coveredObligations.map((raw) =>
    parseCoveredObligation(
      typeof raw === "object" && raw !== null
        ? normalizeSnakeRecord(raw as Record<string, unknown>, [
            ["directive_id", "directiveId"],
            ["directive_revision", "directiveRevision"],
            ["stage_id", "stageId"],
            ["objective_hash", "objectiveHash"],
            // E10 §22 — execution_run_completion identity fields (snake boundary).
            ["execution_run_id", "executionRunId"],
            ["final_plan_hash", "finalPlanHash"],
            ["base_accepted_head_commit_id", "baseAcceptedHeadCommitId"],
            ["completed_stage_set_hash", "completedStageSetHash"],
          ])
        : raw,
    ),
  );
  validateCoveredObligations(tx, evidence, obligations);

  if (input.planRefs !== undefined && input.planRefs.length > 0) {
    // A1 §16 — the approved FinalPlan is planning-scoped; resolve it through
    // the execution run's source-planning provenance.
    const planningRunId = getExecutionRunInTx(tx, input.executionRunId)?.runId ?? input.executionRunId;
    const finalPlanRow = getFinalPlanInTx(tx, planningRunId);
    if (finalPlanRow === null) {
      throw acceptanceError("WINDOW_BASE_MISMATCH", `no approved FinalPlan exists for run '${input.executionRunId}'`, {
        executionRunId: input.executionRunId,
      });
    }
    requirePlanRefsUnderFinalPlan(input.planRefs, parseFinalPlanCanonical(finalPlanRow.canonicalJson, input.executionRunId));
  }

  const assessmentId = `sa_${clock.newId()}`;
  const assessment: SupervisorAssessment = {
    assessmentId,
    executionRunId: input.executionRunId,
    stageId: stage === null ? null : stage.id,
    windowId: window.id,
    candidateRevision: window.candidateRevision,
    disposition: input.disposition,
    supervisorSessionId: input.sessionId,
    supervisorGeneration: input.generation,
    planRefs: input.planRefs ?? [],
    coveredObligations: obligations,
    rationale: input.rationale,
    createdAt: now,
  };

  // E6 §20 — non-accept: persist the durable semantic judgment ONLY.
  if (input.disposition !== "accept") {
    insertSupervisorAssessmentInTx(tx, { assessment, judgments });
    insertAcceptanceEventInTx(tx, { executionRunId: input.executionRunId, eventType: "ASSESSMENT_RECORDED", assessmentId }, now);
    return {
      assessment,
      commit: null,
      window,
      acceptedHeadCommitId: getAcceptedHeadCommitIdInTx(tx, input.executionRunId),
      stageCompleted: false,
      runCompleted: false,
    };
  }

  // --- The accept gate (E6 §12/§13/§41/§42) --------------------------------

  // E8 §40 — the conflict fence: a current-candidate conflict that is open,
  // resolving, or verification_blocked blocks acceptance; only `resolved` is
  // non-blocking. Core enumerates the conflicts itself — the Supervisor can
  // never omit a durable conflict from the assessment.
  const blockingConflicts = listBlockingConflictsInTx(tx, input.executionRunId);
  if (blockingConflicts.length > 0) {
    throw acceptanceError(
      "ACCEPTANCE_VERIFICATION_CONFLICT",
      `verification conflict '${blockingConflicts[0]!.conflictId}' is ${blockingConflicts[0]!.status}; current unresolved conflicts block acceptance of this candidate (E8 §40)`,
      {
        conflictIds: blockingConflicts.map((conflict) => conflict.conflictId),
        statuses: blockingConflicts.map((conflict) => conflict.status),
      },
    );
  }

  // E6 §41 — complete current-candidate coverage: the Supervisor may not hide
  // a current Report by omitting it.
  for (const fact of evidence.currentFacts) {
    if (!seenReportIds.has(fact.reportId)) {
      throw acceptanceError(
        "ASSESSMENT_REPORT_COVERAGE_INCOMPLETE",
        `current-candidate report '${fact.reportId}' is unclassified; an accept assessment must classify every current report (E6 §41)`,
        { reportId: fact.reportId },
      );
    }
  }
  const judgmentByReportId = new Map(judgments.map((judgment) => [judgment.reportId, judgment] as const));

  // E6 §12 — blocking evidence prevents acceptance.
  const blocking = judgments.filter((judgment) => judgment.disposition === "blocking");
  if (blocking.length > 0) {
    throw acceptanceError(
      "ACCEPTANCE_BLOCKED",
      `report '${blocking[0]!.reportId}' is classified blocking; a blocked accept assessment creates no commit (E6 §12)`,
      { reportIds: blocking.map((judgment) => judgment.reportId) },
    );
  }

  // E6 §13/§42 — fresh independent verification: a qualifying current-candidate
  // verifier Report classified supporting.
  const qualifyingSupporting = evidence.currentFacts.filter(
    (fact) => fact.isQualifyingVerification && judgmentByReportId.get(fact.reportId)?.disposition === "supporting",
  );
  if (qualifyingSupporting.length === 0) {
    const staleVerifierExists = evidence.facts.some(
      (fact) =>
        fact.directiveKind === "verification"
        && fact.workerRole === "verifier"
        && fact.result === "completed"
        && (!fact.isCurrentCandidate || fact.candidateMutated),
    );
    throw staleVerifierExists
      ? acceptanceError(
          "ACCEPTANCE_VERIFICATION_STALE",
          "completed verification exists only for another candidate revision or mutated the candidate; a fresh verifier at the exact current candidate is required (E6 §13/§38/§39)",
          { windowId: window.id, candidateRevision: window.candidateRevision },
        )
      : acceptanceError(
          "ACCEPTANCE_VERIFICATION_REQUIRED",
          "no fresh independent verification covers the exact current candidate (E6 §13)",
          { windowId: window.id, candidateRevision: window.candidateRevision },
        );
  }

  // E6 §14 — verifier independence from persisted session identities: a
  // supporting verifier must not be the same worker session as any relied-upon
  // executor report. Legacy unbound attempts (pre-E5) cannot be compared and
  // are skipped — fresh invocation identity is the requirement, role strings
  // and model families are never compared.
  const reliedExecutorSessions = new Set(
    evidence.currentFacts
      .filter(
        (fact) =>
          fact.workerRole === "executor"
          && fact.workerSessionId !== null
          && (judgmentByReportId.get(fact.reportId)?.disposition === "supporting"
            || judgmentByReportId.get(fact.reportId)?.disposition === "informational"),
      )
      .map((fact) => fact.workerSessionId as string),
  );
  for (const verifier of qualifyingSupporting) {
    if (verifier.workerSessionId !== null && reliedExecutorSessions.has(verifier.workerSessionId)) {
      throw acceptanceError(
        "ACCEPTANCE_VERIFICATION_REQUIRED",
        `verifier report '${verifier.reportId}' comes from worker session '${verifier.workerSessionId}' which also produced relied-upon executor evidence; independent session identity is required (E6 §14)`,
        { reportId: verifier.reportId, workerSessionId: verifier.workerSessionId },
      );
    }
  }

  // E7 §34/§35/§36 — a Stage-completion claim needs exact obligation identity
  // AND fresh verification explicitly covering Stage completion; any defect
  // rejects the whole accept transaction before anything is persisted.
  // E10 §26/§32 — the final-closure accept instead requires the exact
  // execution_run_completion obligation and a fresh verifier explicitly
  // covering run completion; stage vocabulary never proves run completion
  // (E10 §21).
  if (finalClosure) {
    validateExecutionCompletionClaim(tx, evidence, input.executionRunId, obligations, judgmentByReportId);
  } else {
    validateStageCompletionClaim(evidence, stage as ExecutionStage, obligations, judgmentByReportId);
  }

  // E6 §21/§29 — the Window's frozen base must equal the CURRENT accepted head.
  const headCommitId = getAcceptedHeadCommitIdInTx(tx, input.executionRunId);
  if (window.baseKind === "execution_start" && headCommitId !== null) {
    throw acceptanceError(
      "WINDOW_BASE_MISMATCH",
      `window '${window.id}' is rooted in execution_start but the run already has accepted head '${headCommitId}'`,
      { windowId: window.id, acceptedHead: headCommitId },
    );
  }
  if (window.baseKind === "execution_commit" && headCommitId !== window.baseCommitId) {
    throw acceptanceError(
      "WINDOW_BASE_MISMATCH",
      `window '${window.id}' is rooted in commit '${window.baseCommitId}' but the current accepted head is '${headCommitId}'`,
      { windowId: window.id, base: window.baseCommitId, acceptedHead: headCommitId },
    );
  }

  // E6 §24/§26 — linear chain + CAS expectation from the CURRENT head.
  const parent = headCommitId === null ? null : getExecutionCommitInTx(tx, headCommitId);
  if (headCommitId !== null && parent === null) {
    throw acceptanceError("WINDOW_BASE_MISMATCH", `accepted head '${headCommitId}' references a missing commit`, {
      acceptedHead: headCommitId,
    });
  }
  const sequence = parent === null ? 1 : parent.sequence + 1;

  // E6 §27 — complete Window provenance is derived from the Store: ALL
  // immutable Directive revisions and ALL Reports of the Window (including
  // historical stale-revision and adverse evidence), in deterministic order.
  const directiveRefs = evidence.directives.map((directive) => ({
    directiveId: directive.directiveId,
    revision: directive.revision,
    hash: directive.hash,
  }));
  const reportRefs = evidence.facts.map((fact) => ({
    reportId: fact.reportId,
    attemptId: fact.attemptId,
    workerRole: fact.workerRole,
    result: fact.result,
  }));

  const commit: ExecutionCommit = {
    commitId: `ec_${clock.newId()}`,
    executionRunId: input.executionRunId,
    sequence,
    parentCommitId: parent === null ? null : parent.commitId,
    // E10 §34 — the Final ExecutionCommit carries NO Stage ref: scope
    // final_closure, stage_id null (E10 §35).
    scopeKind: finalClosure ? "final_closure" : "stage",
    stageId: stage === null ? null : stage.id,
    windowId: window.id,
    candidateRevision: window.candidateRevision,
    supervisorAssessmentId: assessmentId,
    directiveRefs,
    reportRefs,
    satisfiedObligations: obligations,
    createdAt: now,
  };

  // E6 §21 — persist everything atomically; ANY failure below rolls back the
  // assessment too, so a durable accept assessment always has its commit.
  // E7 §11 — the Stage transition (when the Commit carries the exact
  // stage_objective obligation) joins the SAME transaction, after the commit,
  // window close, and head CAS: a completion failure rolls back the assessment,
  // the commit, the window close, the head movement, and the transition.
  // E10 §42 — the FINAL accept runs the ExecutionCompletionGate in the same
  // position (after commit + window close + head CAS): the gate re-derives
  // every condition, transitions active → completed with exact provenance,
  // and detaches the SupervisorBinding. Any gate failure rolls back everything.
  const stageCompleting = !finalClosure && obligations.some((obligation) => obligation.source === "stage_objective");
  insertSupervisorAssessmentInTx(tx, { assessment, judgments });
  insertExecutionCommitInTx(tx, commit);
  closeWindowByExecutionCommitInTx(tx, { windowId: window.id }, now);
  advanceAcceptedHeadInTx(
    tx,
    { executionRunId: input.executionRunId, expectedHeadCommitId: headCommitId, commitId: commit.commitId },
    now,
  );
  let runCompleted = false;
  if (finalClosure) {
    runExecutionCompletionGateInTx(tx, {
      executionRunId: input.executionRunId,
      finalCommitId: commit.commitId,
      windowId: window.id,
      now,
    });
    runCompleted = true;
    // E10 §46 — the binding detaches with generation/history preserved; no
    // execution takeover is legal for a completed run.
    detachSupervisorBindingInTx(tx, { executionRunId: input.executionRunId, sessionId: input.sessionId }, now);
  }
  if (stageCompleting) {
    completeStageByExecutionCommitInTx(tx, { stageId: stage!.id, commitId: commit.commitId }, now);
  }
  insertAcceptanceEventInTx(tx, { executionRunId: input.executionRunId, eventType: "ASSESSMENT_RECORDED", assessmentId }, now);
  insertAcceptanceEventInTx(
    tx,
    { executionRunId: input.executionRunId, eventType: "EXECUTION_COMMIT_CREATED", assessmentId, commitId: commit.commitId },
    now,
  );
  return {
    assessment,
    commit,
    window: { ...window, closedAt: now },
    acceptedHeadCommitId: commit.commitId,
    stageCompleted: stageCompleting,
    runCompleted,
  };
}

/**
 * E6 §16 — obligation provenance must resolve into EXISTING persisted content:
 * a directive_validation_requirement resolves into that exact immutable
 * revision's requirement at the given index with a matching content hash; a
 * plan_ref must be an exact approved ref of the Window's Directives or the
 * Stage provenance. No normative obligation is invented (E6 §16).
 */
function validateCoveredObligations(tx: StoreTx, evidence: WindowEvidence, obligations: CoveredObligation[]): void {
  const stageRefs = evidence.stage === null ? [] : evidence.stage.sourceRefs;
  const approvedPlanRefs = new Set(
    evidence.directives
      .flatMap((directive) => directive.planRefs)
      .concat(stageRefs)
      .map((ref) => `${ref.kind}|${ref.id}|${ref.revision}`),
  );
  for (const obligation of obligations) {
    // E7 §5/§7 — a stage_objective claim is provenance over the ACTIVE Stage's
    // immutable semantics; Core re-derives the identity at the accept gate
    // (never from the Supervisor's string). Shape was validated at parse time,
    // so there is no Window-local resolution to do here — and a claim inside a
    // NON-accept assessment persists as a judgment only and never completes a
    // Stage (E7 §7). E10 §22/§32 — an execution_run_completion claim is
    // provenance over the Core-derived run-completion identity; the final
    // accept path (and the CompletionGate) re-derive and compare it exactly.
    if (obligation.source === "stage_objective") {
      continue;
    }
    if (obligation.source === "execution_run_completion") {
      continue;
    }
    if (obligation.source === "plan_ref") {
      const ref = obligation.ref as DirectivePlanRef;
      if (!approvedPlanRefs.has(`${ref.kind}|${ref.id}|${ref.revision}`)) {
        throw acceptanceError(
          "ASSESSMENT_REPORT_INVALID",
          `plan_ref obligation ${ref.kind}|${ref.id}@${ref.revision} is not an approved ref of this Window's Directives or the Stage provenance (E6 §16)`,
          { ref },
        );
      }
      continue;
    }
    const directive = evidence.directives.find(
      (candidate) => candidate.directiveId === obligation.directiveId && candidate.revision === obligation.directiveRevision,
    );
    if (directive === undefined) {
      throw acceptanceError(
        "ASSESSMENT_REPORT_INVALID",
        `obligation binds directive '${obligation.directiveId}@${obligation.directiveRevision}' which does not belong to this Window`,
        { directiveId: obligation.directiveId, directiveRevision: obligation.directiveRevision },
      );
    }
    const requirement = directive.validationRequirements[obligation.index as number];
    if (requirement === undefined) {
      throw acceptanceError(
        "ASSESSMENT_REPORT_INVALID",
        `obligation index ${obligation.index} is outside the validation requirements of '${directive.directiveId}@${directive.revision}'`,
        { index: obligation.index },
      );
    }
    const expected = validationRequirementObligation(directive, requirement, obligation.index as number);
    if (expected.contentHash !== obligation.contentHash) {
      throw acceptanceError(
        "ASSESSMENT_REPORT_INVALID",
        `obligation content hash does not match the persisted requirement content (E6 §16 — deterministic local identity)`,
        { directiveId: obligation.directiveId, revision: directive.revision, index: obligation.index },
      );
    }
  }
}

/**
 * E7 §34/§35/§36 — semantic validation of a Stage-completion claim at the
 * accept gate. The claim must name the CURRENT active Stage with the exact
 * deterministically derived objective identity, and the fresh supporting
 * verification must EXPLICITLY cover Stage completion (the derived
 * `verify_stage_completion` requirement carried by the verifier's own
 * immutable Directive) — generic "tests passed" coverage never closes a Stage
 * (E7 §8/§9). Any refusal rejects the WHOLE accept transaction (E7 §36): no
 * assessment, no commit, no window close, no head movement, no transition.
 */
function validateStageCompletionClaim(
  evidence: WindowEvidence,
  stage: ExecutionStage,
  obligations: CoveredObligation[],
  judgmentByReportId: Map<string, ReportJudgment>,
): void {
  const claims = obligations.filter((obligation) => obligation.source === "stage_objective");
  if (claims.length === 0) {
    return;
  }
  if (claims.length > 1) {
    throw acceptanceError(
      "STAGE_COMPLETION_OBLIGATION_INVALID",
      `the assessment carries ${claims.length} stage_objective claims; at most one Stage completion per accepted candidate (E7 §35)`,
      { stageIds: claims.map((claim) => claim.stageId) },
    );
  }
  const claim = claims[0]!;
  if (stage.status === "completed") {
    throw acceptanceError(
      "STAGE_ALREADY_COMPLETED",
      `stage '${claim.stageId}' is already completed; completion provenance is immutable (E7 §12/§35)`,
      { stageId: claim.stageId },
    );
  }
  if (claim.stageId !== stage.id) {
    throw acceptanceError(
      "STAGE_COMPLETION_OBLIGATION_INVALID",
      `stage_objective names stage '${claim.stageId}' which is not the current active stage '${stage.id}' (E7 §6/§35)`,
      { claimedStageId: claim.stageId, activeStageId: stage.id },
    );
  }
  const expected = stageObjectiveObligation(stage);
  if (claim.objectiveHash !== expected.objectiveHash || claim.contentHash !== expected.contentHash) {
    throw acceptanceError(
      "STAGE_COMPLETION_OBLIGATION_INVALID",
      `stage_objective identity does not match the persisted immutable Stage semantics — stale or fabricated objectiveHash (E7 §35)`,
      { stageId: stage.id, claimedObjectiveHash: claim.objectiveHash, expectedObjectiveHash: expected.objectiveHash },
    );
  }
  const covering = evidence.currentFacts.filter((fact) => {
    if (!fact.isQualifyingVerification) {
      return false;
    }
    if (judgmentByReportId.get(fact.reportId)?.disposition !== "supporting") {
      return false;
    }
    const directive = evidence.directives.find(
      (candidate) => candidate.directiveId === fact.directiveId && candidate.revision === fact.directiveRevision,
    );
    return directive !== undefined && directiveCarriesStageCompletionVerification(directive, stage);
  });
  if (covering.length === 0) {
    const required = deriveStageCompletionValidationRequirement(stage);
    throw acceptanceError(
      "STAGE_COMPLETION_VERIFICATION_REQUIRED",
      `no fresh supporting verifier explicitly covers Stage completion; the verification directive must carry the exact requirement '${required.requirement}' binding objectiveHash ${required.detail} (E7 §8/§9)`,
      { stageId: stage.id, requiredVerificationRequirement: required },
    );
  }
}

/**
 * E10 §26/§32 — semantic validation of the run-completion claim at the FINAL
 * accept gate. The assessment must carry EXACTLY the current Core-derived
 * execution_run_completion obligation (absent → EXECUTION_COMPLETION_OBLIGATION_REQUIRED,
 * wrong/stale → EXECUTION_COMPLETION_OBLIGATION_INVALID), and the fresh
 * supporting verification must EXPLICITLY cover run completion — a supporting
 * verifier whose immutable Directive carries the exact
 * `verify_execution_completion` requirement binding the exact identity.
 * A generic normal verifier is insufficient (E10 §26). Any refusal rejects the
 * WHOLE accept transaction: no assessment, no Final Commit, no window close,
 * no head movement, no completion.
 */
function validateExecutionCompletionClaim(
  tx: StoreTx,
  evidence: WindowEvidence,
  executionRunId: string,
  obligations: CoveredObligation[],
  judgmentByReportId: Map<string, ReportJudgment>,
): void {
  const claims = obligations.filter((obligation) => obligation.source === "execution_run_completion");
  if (claims.length === 0) {
    throw acceptanceError(
      "EXECUTION_COMPLETION_OBLIGATION_REQUIRED",
      "the final accept assessment carries no execution_run_completion obligation (E10 §32)",
      { executionRunId },
    );
  }
  if (claims.length > 1) {
    throw acceptanceError(
      "EXECUTION_COMPLETION_OBLIGATION_INVALID",
      `the assessment carries ${claims.length} execution_run_completion claims; exactly one run completion per final accept (E10 §32)`,
      { executionRunId, count: claims.length },
    );
  }
  if (evidence.window.baseCommitId === null) {
    throw acceptanceError(
      "EXECUTION_SCOPE_INVALID",
      `window '${evidence.window.id}' is not rooted in an accepted commit; a final-closure window closes over the acceptedHead (E10 §9)`,
      { windowId: evidence.window.id },
    );
  }
  const semantics = loadExecutionCompletionSemanticsInTx(tx, executionRunId, evidence.window.baseCommitId);
  const expected = executionRunCompletionObligation(semantics);
  const claim = claims[0]!;
  if (
    claim.executionRunId !== expected.executionRunId
    || claim.finalPlanHash !== expected.finalPlanHash
    || claim.baseAcceptedHeadCommitId !== expected.baseAcceptedHeadCommitId
    || claim.completedStageSetHash !== expected.completedStageSetHash
    || claim.contentHash !== expected.contentHash
  ) {
    throw acceptanceError(
      "EXECUTION_COMPLETION_OBLIGATION_INVALID",
      "execution_run_completion identity does not match the Core-derived obligation — stale or fabricated (E10 §24/§32)",
      {
        executionRunId,
        claimedContentHash: claim.contentHash,
        expectedContentHash: expected.contentHash,
      },
    );
  }
  const covering = evidence.currentFacts.filter((fact) => {
    if (!fact.isQualifyingVerification) {
      return false;
    }
    if (judgmentByReportId.get(fact.reportId)?.disposition !== "supporting") {
      return false;
    }
    const directive = evidence.directives.find(
      (candidate) =>
        candidate.directiveId === fact.directiveId && candidate.revision === fact.directiveRevision,
    );
    return directive !== undefined && directiveCarriesExecutionCompletionVerification(directive, semantics);
  });
  if (covering.length === 0) {
    const required = deriveExecutionCompletionValidationRequirement(semantics);
    throw acceptanceError(
      "EXECUTION_COMPLETION_VERIFICATION_REQUIRED",
      `no fresh supporting verifier explicitly covers run completion; the verification directive must carry the exact requirement '${required.requirement}' binding ${required.detail} (E10 §26)`,
      { executionRunId, requiredVerificationRequirement: required },
    );
  }
}

// ---------------------------------------------------------------------------
// The internal successor-window primitive (E6 §35) — NOT model-facing.
// ---------------------------------------------------------------------------

export interface SuccessorWindowResult {
  window: VerificationWindow;
  baseCommitId: string;
}

/**
 * E6 §35 — `openNextWindowForActiveStage`: requires an active Run, an active
 * Stage, NO open window (the post-commit acceptance boundary, E6 §33), and an
 * EXISTING acceptedHead (genesis bootstrap owns the first window). Creates the
 * NEW window at candidateRevision 0 rooted in the exact acceptedHead. Later
 * Stage/orchestration logic owns when this is invoked; it is never a broad MCP
 * tool.
 */
export function openNextWindowForActiveStageInTx(
  tx: StoreTx,
  input: { executionRunId: string },
  clock: StoreClock,
  now: string,
): SuccessorWindowResult {
  const run = getExecutionRunInTx(tx, input.executionRunId);
  if (run === null || run.lifecycle !== "active") {
    throw acceptanceError("WINDOW_BASE_MISMATCH", `ExecutionRun '${input.executionRunId}' is missing or not active`, {
      executionRunId: input.executionRunId,
    });
  }
  const stage = requireActiveStageInTx(tx, input.executionRunId);
  const headCommitId = getAcceptedHeadCommitIdInTx(tx, input.executionRunId);
  if (headCommitId === null) {
    throw acceptanceError(
      "WINDOW_BASE_MISMATCH",
      `execution run '${input.executionRunId}' has no accepted head; the genesis bootstrap owns the first window (E6 §34)`,
      { executionRunId: input.executionRunId },
    );
  }
  const head = getExecutionCommitInTx(tx, headCommitId);
  if (head === null) {
    throw acceptanceError("WINDOW_BASE_MISMATCH", `accepted head '${headCommitId}' references a missing commit`, {
      acceptedHead: headCommitId,
    });
  }
  const window = insertOpenWindowInTx(
    tx,
    {
      executionRunId: input.executionRunId,
      stageId: stage.id,
      windowId: `win_${clock.newId()}`,
      base: { kind: "execution_commit", commitId: head.commitId },
    },
    now,
  );
  return { window, baseCommitId: head.commitId };
}

export function createAcceptanceService(store: PlanStore, clock: StoreClock) {
  return {
    /** Read-only acceptance context (E6 §8/§54). */
    getExecutionAcceptanceContext(input: { executionRunId: string }): ExecutionAcceptanceContext {
      return store.withRead((tx) => loadExecutionAcceptanceContextInTx(tx, input.executionRunId));
    },

    /** The E6 §21 acceptance gate — Supervisor-facing submission core. */
    submitSupervisorAssessment(input: SubmitSupervisorAssessmentInput): SupervisorAssessmentResult {
      return store.withWrite((tx) =>
        submitSupervisorAssessmentInTx(tx, input, clock, clock.nowIso()),
      );
    },

    /** The E6 §35 internal successor-window primitive (not model-facing). */
    openNextWindowForActiveStage(input: { executionRunId: string }): SuccessorWindowResult {
      return store.withWrite((tx) => openNextWindowForActiveStageInTx(tx, input, clock, clock.nowIso()));
    },
  };
}
