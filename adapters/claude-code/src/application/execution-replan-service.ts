/**
 * Execution replan application service (v0.2.0 E9 §4–§30).
 *
 * Authority model: replanning is a SEMANTIC Supervisor judgment (E9 §5) —
 * Core validates the protocol (E2 authority, run state, exact ref shapes) and
 * never the natural-language truth of the judgment. The authoritative
 * transaction (E9 §24) is all-or-nothing:
 *
 *   retry convergence → revalidate Supervisor authority → require active run
 *   → require no running Attempt → validate affected normative refs /
 *   relevant Reports / optional trigger Assessment → derive accepted history
 *   + current context → persist the ONE immutable replan ExecutionIssue →
 *   terminal-close the open Window (no fake Commit) → ExecutionRun active →
 *   replan_required → detach the SupervisorBinding → audit event.
 *
 * Any failure leaves no issue, the run active, the window unchanged, and the
 * binding untouched. `replan_required` is TERMINAL (E9 §4): recovery, /clear,
 * takeover, rewind, or a new FinalPlan never reactivates it.
 *
 * Core DERIVES the run, workspace identity, accepted head, stages, windows,
 * and candidate state from authoritative context — the model supplies semantic
 * intent only (E9 §6).
 */

import {
  deriveAcceptedHistorySnapshot,
  executionIssueV2Hash,
  EXECUTION_ISSUE_VERSION_2,
  REPLAN_ISSUE_KIND,
  type AcceptedExecutionHistorySnapshot,
  type ExecutionIssueContextSnapshot,
  type ExecutionIssueV2,
} from "../core/execution-replan.js";
import {
  affectedRefProblems,
  isExecutionIssueRefType,
  type ExecutionIssueAffectedRef,
} from "../core/execution-issue.js";
import { canonicalJson } from "../core/canonical-json.js";
import { RuntimeError } from "../runtime/errors.js";
import { getExecutionRunInTx, replanExecutionRunInTx } from "../store/execution-runs.js";
import { getFinalPlanInTx } from "../store/finalization.js";
import { parseFinalPlanCanonical } from "./final-plan-canonical.js";
import { deriveRepositoryBaseline } from "./handoff-service.js";
import { requireCurrentSupervisorAuthorityInTx, detachSupervisorBindingInTx } from "../store/supervisor-bindings.js";
import { getRunningAttemptInTx, listRunAttemptsInTx, listWindowAttemptsInTx } from "../store/execution-attempts.js";
import { isAttemptUnresolvedIndeterminateInTx } from "./recovery-fence.js";
import { listRunReconciliationsInTx } from "../store/attempt-reconciliations.js";
import { listRunCommitsInTx, getAcceptedHeadCommitIdInTx } from "../store/execution-commits.js";
import {
  getActiveExecutionStageInTx,
  getOpenWindowInTx,
  closeWindowForReplanInTx,
} from "../store/execution-structure.js";
import { listWindowConflictsInTx } from "../store/verification-conflicts.js";
import { loadVerificationPolicyStateInTx } from "./verification-policy-service.js";
import { listRunAssessmentsInTx } from "../store/supervisor-assessments.js";
import { getExecutionReportInTx } from "../store/execution-reports.js";
import {
  findExecutionIssueByOperationInTx,
  insertReplanIssueInTx,
  type ExecutionIssueRefRow,
} from "../store/execution-issues.js";
import type { StoreClock } from "../store/migration-runner.js";
import type { PlanStore } from "../store/sqlite-store.js";
import type { StoreTx } from "../store/transaction.js";

function replanError(
  code:
    | "REPLAN_REQUEST_INVALID"
    | "REPLAN_ATTEMPT_RUNNING"
    | "REPLAN_AFFECTED_REF_INVALID"
    | "REPLAN_REPORT_REF_INVALID"
    | "REPLAN_ALREADY_TRANSITIONED",
  message: string,
  detail?: Record<string, unknown>,
): RuntimeError {
  return new RuntimeError(code, message, { detail, recoverable: false });
}

export interface RequestExecutionReplanInput {
  /** The signed HostContext session — never model-supplied authority (E9 §7). */
  sessionId: string;
  workspaceId: string;
  /** The caller's known supervision fencing generation (E2 fence). */
  generation: number;
  /** Non-empty semantic intent — Core never judges its truth (E9 §5). */
  reason: string;
  /** Exact Plan refs reachable from the bound FinalPlan (E9 §9); ≥ 1. */
  affectedNormativeRefs: unknown[];
  /** Exact relevant Report ids of THIS run, any state (E9 §10). */
  relevantReportRefs: string[];
  /** Optional immutable request_replan assessment as trigger provenance (E9 §8). */
  triggerAssessmentId?: string;
  /** The signed toolUseId — the idempotency operation identity (E9 §25). */
  toolUseId: string;
}

export interface ReplanTransitionResult {
  status: "replan_required" | "already_replan_required";
  executionRunId: string;
  runId: string;
  issueId: string;
  issueHash: string;
  windowClosed: boolean;
  bindingDetached: boolean;
}

/**
 * The authoritative replan request (E9 §24) — ONE atomic transaction. All
 * model arguments beyond semantic intent are refused by shape: the run,
 * lifecycle target, acceptedHead, stage, window, candidate, and generation
 * bound into the issue are Core-derived (E9 §6).
 */
export function requestExecutionReplanInTx(
  tx: StoreTx,
  input: RequestExecutionReplanInput,
  clock: StoreClock,
  now: string,
): ReplanTransitionResult {
  // E9 §25/§4 — before any state gate: this session's replan-bound runs are
  // terminal. A retry with the SAME operation identity converges on the same
  // durable issue; a different identity on an already-transitioned run is
  // refused as REPLAN_ALREADY_TRANSITIONED (never a second issue).
  for (const binding of listSessionReplanCandidateBindingsInTx(tx, input.sessionId)) {
    const run = getExecutionRunInTx(tx, binding.executionRunId);
    if (run === null || run.lifecycle !== "replan_required") continue;
    const existing = findExecutionIssueByOperationInTx(tx, binding.executionRunId, input.toolUseId);
    if (existing !== null && existing.kind === REPLAN_ISSUE_KIND) {
      return {
        status: "already_replan_required",
        executionRunId: existing.executionRunId ?? "",
        runId: run.runId,
        issueId: existing.issueId,
        issueHash: existing.issueHash,
        windowClosed: true,
        bindingDetached: true,
      };
    }
    const terminalIssue = tx
      .prepare(
        "SELECT issue_id AS id FROM execution_issues WHERE run_id = ? AND kind = 'replan_required' ORDER BY created_at LIMIT 1",
      )
      .get(run.runId) as { id: string } | undefined;
    throw replanError(
      "REPLAN_ALREADY_TRANSITIONED",
      `ExecutionRun for this session is already replan_required (issue '${terminalIssue?.id ?? "unknown"}'); replanning is terminal and never repeats (E9 §4/§25)`,
      { runId: run.runId, issueId: terminalIssue?.id ?? null },
    );
  }

  // E9 §6/§7 — Core derives the run from the session's CURRENT attached
  // supervisor authority, then runs the frozen E2 fence against it (active
  // run, exact workspace, session, generation). A Worker context and a stale
  // former Supervisor fail closed.
  const binding = tx
    .prepare(
      "SELECT execution_run_id AS executionRunId FROM supervisor_bindings WHERE session_id = ? AND state = 'attached' LIMIT 1",
    )
    .get(input.sessionId) as { executionRunId: string } | undefined;
  if (binding === undefined) {
    throw replanError("REPLAN_REQUEST_INVALID", "replanning requires the session's current attached supervisor authority", {
      sessionId: input.sessionId,
    });
  }
  const runId = binding.executionRunId;
  requireCurrentSupervisorAuthorityInTx(tx, {
    executionRunId: runId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    generation: input.generation,
  });
  const run = getExecutionRunInTx(tx, runId);
  if (run === null || run.lifecycle !== "active") {
    throw replanError(
      "REPLAN_ALREADY_TRANSITIONED",
      run === null
        ? `no ExecutionRun exists for '${runId}'`
        : `ExecutionRun '${run.executionRunId}' is ${run.lifecycle}; only an active run transitions to replan_required (E9 §4)`,
      { executionRunId: run?.executionRunId ?? null, lifecycle: run?.lifecycle ?? null },
    );
  }
  // A1 §16 — planning-side reads and Class-D provenance are scoped by the
  // source PlanningRunID; every execution-side read by the canonical ID.
  const planningRunId = run.runId;

  // E9 §16 — a running Worker Attempt prevents the terminal transition (it
  // could still mutate the workspace or report after it). No cancellation
  // exists in E9.
  const running = getRunningAttemptInTx(tx, runId);
  if (running !== null) {
    throw replanError(
      "REPLAN_ATTEMPT_RUNNING",
      `attempt '${running.attemptId}' is still running; the terminal replan transition requires a quiet candidate (E9 §16)`,
      { attemptId: running.attemptId },
    );
  }

  // E9 §5/§11 — semantic intent shape.
  if (typeof input.reason !== "string" || input.reason.trim() === "") {
    throw replanError("REPLAN_REQUEST_INVALID", "reason must be a non-empty statement of the normative insufficiency (E9 §5)", {});
  }

  // P1 §1/§2 — replan requires a genuine normative design gap (contract/interface/
  // decision/constraint insufficiency in the approved FinalPlan), not ordinary
  // test failures, compiler/syntax errors, implementation difficulties, file path
  // adjustments, or temporary environment blockers.
  const reasonText = input.reason.trim();
  const nonNormativePatterns = [
    /^tests?\s*(failed|failing|failure)s?(\b|[.:!]|$)/i,
    /^build\s*(failed|failure|error)s?(\b|[.:!]|$)/i,
    /^compile(r)?\s*(failed|failure|error)s?(\b|[.:!]|$)/i,
    /^flaky\s*tests?(\b|[.:!]|$)/i,
    /^file\s*(path\s*)?(changed|missing|not\s*found)(\b|[.:!]|$)/i,
    /^(temporary|transient)\s*(environment|network|system)\s*(issue|error|glitch)(\b|[.:!]|$)/i,
    /^syntax\s*errors?(\b|[.:!]|$)/i,
    /^implementation\s*(difficulty|hard|struggling)(\b|[.:!]|$)/i,
  ];
  if (
    nonNormativePatterns.some((pattern) => pattern.test(reasonText))
    && !/(contract|interface|normative|specification|architecture|decision|constraint|finalplan|invariant)/i.test(reasonText)
  ) {
    throw replanError(
      "REPLAN_REQUEST_INVALID",
      "replan requires a genuine normative design gap (contract/interface/architecture/decision/constraint insufficiency in the approved FinalPlan), not ordinary test failures, implementation difficulties, file path changes, or environment blockers (P1 §1/§2)",
      { reason: input.reason },
    );
  }

  // E9 §9 — affected normative refs: exact, structured, reachable from the
  // bound FinalPlan; at least one anchor. "latest", unversioned ids, and
  // arbitrary strings are unrepresentable here.
  const finalPlanRow = getFinalPlanInTx(tx, planningRunId);
  if (finalPlanRow === null) {
    throw replanError("REPLAN_REQUEST_INVALID", `no approved FinalPlan exists for run '${runId}'`, { runId });
  }
  const plan = parseFinalPlanCanonical(finalPlanRow.canonicalJson, planningRunId);
  if (!Array.isArray(input.affectedNormativeRefs) || input.affectedNormativeRefs.length === 0) {
    throw replanError("REPLAN_AFFECTED_REF_INVALID", "at least one affected normative anchor is required (E9 §9)", {});
  }
  const affectedRefs: ExecutionIssueAffectedRef[] = input.affectedNormativeRefs.map((raw) => {
    if (typeof raw !== "object" || raw === null) {
      throw replanError("REPLAN_AFFECTED_REF_INVALID", "an affected normative ref is not an object", { ref: raw });
    }
    const record = raw as Record<string, unknown>;
    const type = typeof record.type === "string" && isExecutionIssueRefType(record.type) ? record.type : null;
    const id = typeof record.id === "string" ? record.id : null;
    const revision = typeof record.revision === "number" && Number.isInteger(record.revision) && record.revision >= 1 ? record.revision : null;
    if (type === null || id === null || id === "" || revision === null) {
      throw replanError(
        "REPLAN_AFFECTED_REF_INVALID",
        "affected refs must be exact {type, id, revision} Plan references — never 'latest' or unversioned ids (E9 §9)",
        { ref: raw },
      );
    }
    return { type, id, revision };
  });
  const problems = affectedRefProblems(plan, affectedRefs);
  if (problems.length > 0) {
    throw replanError(
      "REPLAN_AFFECTED_REF_INVALID",
      `affected ref '${problems[0]!.ref.type}|${problems[0]!.ref.id}@${problems[0]!.ref.revision}' is not reachable from the bound FinalPlan (${problems[0]!.problem}) (E9 §9)`,
      { problems },
    );
  }

  // E9 §10 — relevant Reports: exact, this run, ANY state/result (a planning
  // defect may have been discovered long before the current Window).
  const relevantReportRefs = [...new Set(input.relevantReportRefs)];
  for (const reportId of relevantReportRefs) {
    const report = typeof reportId === "string" ? getExecutionReportInTx(tx, reportId) : null;
    if (report === null || report.executionRunId !== runId) {
      throw replanError(
        "REPLAN_REPORT_REF_INVALID",
        `relevant report '${reportId}' does not exist in this ExecutionRun (E9 §10)`,
        { reportId },
      );
    }
  }

  // E9 §8 — the optional trigger Assessment: same run, disposition
  // request_replan. NOT required: between-stage/post-commit boundaries may
  // have no open Window to assess.
  let triggerAssessmentId: string | null = null;
  if (input.triggerAssessmentId !== undefined) {
    if (typeof input.triggerAssessmentId !== "string" || input.triggerAssessmentId === "") {
      throw replanError("REPLAN_REQUEST_INVALID", "triggerAssessmentId must be an exact assessment id (E9 §8)", {});
    }
    const assessment = listRunAssessmentsInTx(tx, runId).find(
      (candidate) => candidate.assessmentId === input.triggerAssessmentId,
    );
    if (assessment === undefined) {
      throw replanError("REPLAN_REQUEST_INVALID", `trigger assessment '${input.triggerAssessmentId}' does not belong to this run (E9 §8)`, {
        triggerAssessmentId: input.triggerAssessmentId,
      });
    }
    if (assessment.disposition !== "request_replan") {
      throw replanError(
        "REPLAN_REQUEST_INVALID",
        `assessment '${assessment.assessmentId}' has disposition '${assessment.disposition}'; only a request_replan assessment can trigger replanning (E9 §8)`,
        { assessmentId: assessment.assessmentId, disposition: assessment.disposition },
      );
    }
    triggerAssessmentId = assessment.assessmentId;
  }

  // E9 §12 — the accepted history is Core-derived: the FULL ordered chain up
  // to the head. The Supervisor can never omit an accepted Commit.
  const commits = listRunCommitsInTx(tx, runId);
  const headCommitId = getAcceptedHeadCommitIdInTx(tx, runId);
  const acceptedHistory: AcceptedExecutionHistorySnapshot = deriveAcceptedHistorySnapshot(commits, headCommitId);

  // E9 §13/§17/§18 — the compact current context snapshot. Indeterminate
  // attempts and conflict state are RECORDED, never replayed or resolved.
  const activeStage = getActiveExecutionStageInTx(tx, runId);
  const openWindow = getOpenWindowInTx(tx, runId);
  const policyState = loadVerificationPolicyStateInTx(tx, runId);
  const indeterminateAttempts = openWindow === null ? [] : listWindowAttemptsInTx(tx, openWindow.id).filter((attempt) => attempt.state === "indeterminate");
  const latestAssessment = listRunAssessmentsInTx(tx, runId)[0] ?? null;
  const workspaceRow = tx
    .prepare("SELECT workspace_id AS id FROM workspaces WHERE workspace_id = ?")
    .get(run.workspaceId) as { id: string } | undefined;
  const executionContext: ExecutionIssueContextSnapshot = {
    lifecycleBefore: "active",
    activeStage: activeStage === null ? null : { id: activeStage.id, status: activeStage.status },
    openWindow:
      openWindow === null
        ? null
        : {
            id: openWindow.id,
            candidateRevision: openWindow.candidateRevision,
            baseKind: openWindow.baseKind,
            baseCommitId: openWindow.baseCommitId,
          },
    verificationPolicy:
      policyState === null
        ? null
        : {
            required: policyState.verificationRequired,
            reason: policyState.reason,
            unverifiedMutationSpan: policyState.unverifiedMutationSpan,
            maxUnverifiedMutations: policyState.maxUnverifiedMutations,
            latestVerifiedRevision: policyState.latestVerifiedRevision,
          },
    currentConflicts:
      openWindow === null
        ? []
        : listWindowConflictsInTx(tx, openWindow.id)
            .filter((conflict) => conflict.candidateRevision === openWindow.candidateRevision)
            .map((conflict) => ({ conflictId: conflict.conflictId, status: conflict.status, candidateRevision: conflict.candidateRevision })),
    runningAttemptId: null,
    // E11 §38 — unresolved indeterminate work is RECORDED, never resolved, by
    // replanning; reconciled indeterminate history carries its resolution.
    indeterminateAttemptIds: indeterminateAttempts
      .filter((attempt) => isAttemptUnresolvedIndeterminateInTx(tx, attempt))
      .map((attempt) => attempt.attemptId),
    reconciledIndeterminateRefs: listRunReconciliationsInTx(tx, runId)
      .filter((reconciliation) => {
        const attempt = listRunAttemptsInTx(tx, runId).find((candidate) => candidate.attemptId === reconciliation.attemptId);
        return attempt?.state === "indeterminate";
      })
      .map((reconciliation) => ({ attemptId: reconciliation.attemptId, resolution: reconciliation.resolution })),
    latestAssessment:
      latestAssessment === null
        ? null
        : { assessmentId: latestAssessment.assessmentId, disposition: latestAssessment.disposition, candidateRevision: latestAssessment.candidateRevision },
    workspaceId: workspaceRow?.id ?? run.workspaceId,
    repositoryAtTransition: null,
  };
  // §35 — the CURRENT workspace reality is captured server-side; never a
  // rollback target.
  const workspaceRoot = tx
    .prepare("SELECT kind, canonical_root AS canonicalRoot FROM workspaces WHERE workspace_id = ?")
    .get(run.workspaceId) as { kind: string; canonicalRoot: string } | undefined;
  if (workspaceRoot !== undefined) {
    executionContext.repositoryAtTransition = deriveRepositoryBaseline(workspaceRoot.kind, workspaceRoot.canonicalRoot);
  }

  // E9 §11 — the immutable v2 issue, hashed over canonical content.
  const payload: ExecutionIssueV2 = {
    version: EXECUTION_ISSUE_VERSION_2,
    kind: REPLAN_ISSUE_KIND,
    executionRunId: run.executionRunId,
    runId: planningRunId,
    finalPlanRef: { id: finalPlanRow.finalPlanId, hash: finalPlanRow.finalPlanHash },
    reason: input.reason.trim(),
    affectedNormativeRefs: affectedRefs,
    relevantReportRefs,
    triggerAssessmentId,
    acceptedHistory,
    executionContext,
  };
  const issueId = `xi_replan_${clock.newId()}`;
  const issueHash = executionIssueV2Hash(payload);
  const refs: ExecutionIssueRefRow[] = affectedRefs
    .map((ref, index) => ({ position: index + 1, refType: ref.type, artifactId: ref.id, revision: ref.revision }));
  insertReplanIssueInTx(
    tx,
    {
      runId: planningRunId,
      issueId,
      finalPlanId: finalPlanRow.finalPlanId,
      finalPlanHash: finalPlanRow.finalPlanHash,
      handoffId: (tx.prepare("SELECT handoff_id AS id FROM execution_handoffs WHERE run_id = ? ORDER BY created_at DESC LIMIT 1").get(planningRunId) as { id: string } | undefined)?.id ?? "",
      handoffHash: (tx.prepare("SELECT handoff_hash AS hash FROM execution_handoffs WHERE run_id = ? ORDER BY created_at DESC LIMIT 1").get(planningRunId) as { hash: string } | undefined)?.hash ?? "",
      summary: input.reason.trim(),
      detail: input.reason.trim(),
      canonicalJson: canonicalJson(payload),
      issueHash,
      repositoryKind: (executionContext.repositoryAtTransition?.kind ?? "directory") as "git" | "directory",
      repositoryRevision: executionContext.repositoryAtTransition?.revision ?? null,
      operationId: input.toolUseId,
      sessionId: input.sessionId,
      executionRunId: run.executionRunId,
      triggerAssessmentId,
      relevantReports: relevantReportRefs.map((reportId) => ({ reportId })),
      acceptedHistory,
      executionContext,
    },
    refs,
    now,
  );

  // E9 §21/§23 — terminal-close the open Window (if any): no fake Commit, the
  // candidate stays unaccepted reality.
  let windowClosed = false;
  if (openWindow !== null) {
    closeWindowForReplanInTx(tx, { windowId: openWindow.id }, now);
    windowClosed = true;
  }

  // E9 §4/§26 — the ONE active → replan_required transition.
  replanExecutionRunInTx(tx, { executionRunId: runId, issueId }, now);

  // E9 §27 — the SupervisorBinding detaches (generation + history preserved,
  // never deleted); no execution takeover is legal for a terminal Run.
  const detached = detachSupervisorBindingInTx(tx, { executionRunId: runId, sessionId: input.sessionId }, now);

  return {
    status: "replan_required",
    executionRunId: run.executionRunId,
    runId,
    issueId,
    issueHash,
    windowClosed,
    bindingDetached: detached !== null,
  };
}

/** The session's replan-eligible run bindings (retry convergence lookup). */
function listSessionReplanCandidateBindingsInTx(tx: StoreTx, sessionId: string): Array<{ executionRunId: string }> {
  return (
    tx
      .prepare("SELECT execution_run_id AS executionRunId FROM supervisor_bindings WHERE session_id = ? ORDER BY created_at, execution_run_id")
      .all(sessionId) as Array<{ executionRunId: string }>
  );
}

export function createExecutionReplanService(store: PlanStore, clock: StoreClock) {
  return {
    /** E9 §24 — the authoritative replan request (Supervisor-only). */
    requestExecutionReplan(input: RequestExecutionReplanInput): ReplanTransitionResult {
      return store.withWrite((tx) => requestExecutionReplanInTx(tx, input, clock, clock.nowIso()));
    },

    /** E9 §28 — the compact read-only replan boundary projection. */
    getReplanBoundary(input: { runId: string }): {
      lifecycle: string;
      executionRunId: string | null;
      openReplanIssueId: string | null;
    } {
      return store.withRead((tx) => {
        const run = getExecutionRunInTx(tx, input.runId);
        const issue = tx
          .prepare(
            "SELECT issue_id AS id FROM execution_issues WHERE run_id = ? AND kind = 'replan_required' "
            + "AND NOT EXISTS (SELECT 1 FROM execution_issue_adoptions a WHERE a.run_id = execution_issues.run_id AND a.issue_id = execution_issues.issue_id) "
            + "ORDER BY created_at LIMIT 1",
          )
          .get(input.runId) as { id: string } | undefined;
        return {
          lifecycle: run?.lifecycle ?? "missing",
          executionRunId: run?.executionRunId ?? null,
          openReplanIssueId: issue?.id ?? null,
        };
      });
    },
  };
}
