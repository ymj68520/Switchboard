/**
 * Attempt recovery application service (v0.2.0 E11 §7/§11–§24/§40–§46).
 *
 * Authority model: an indeterminate Attempt is PERMANENT history (E11 §4) —
 * no transition out of `indeterminate` exists and no Report is ever fabricated
 * for it (E11 §5). Recovery is expressed by two separate durable facts: the
 * immutable Attempt↔reconciliation-Directive binding (E11 §9) and the final
 * immutable AttemptReconciliation resolution (E11 §8). Every operation runs
 * under the current Supervisor fence and re-reads the Store inside the
 * transaction (E11 §47) — rendered recovery text is never authority.
 *
 * The unresolved/reconciled distinction (E11 §7) is DERIVED, never stored on
 * the Attempt: indeterminate + no final resolution = unresolved (fences
 * ordinary execution, E11 §13); indeterminate + valid resolution = reconciled
 * (history only). Candidate-revision advancement for candidate_changed is the
 * SECOND semantic writer of candidateRevision (E11 §26/§28), sharing the E3
 * CAS primitive with the Report-driven writer.
 */

import type { ExecutionAttempt } from "../core/execution-attempt.js";
import type { ExecutionDirective } from "../core/execution-directive.js";
import type { ExecutionRun } from "../core/execution-run.js";
import type { WorkerInvocationBinding } from "../core/worker-invocation.js";
import {
  isSideEffectCapable,
  type AttemptReconciliation,
  type AttemptReconciliationResolution,
} from "../core/attempt-reconciliation.js";
import { RuntimeError } from "../runtime/errors.js";
import { getExecutionAttemptInTx, listRunAttemptsInTx } from "../store/execution-attempts.js";
import { getExecutionDirectiveInTx, listWindowDirectivesInTx } from "../store/execution-directives.js";
import { getExecutionRunInTx } from "../store/execution-runs.js";
import { getOpenWindowInTx } from "../store/execution-structure.js";
import { getAcceptedHeadCommitIdInTx } from "../store/execution-commits.js";
import { getReportForAttemptInTx, getExecutionReportInTx } from "../store/execution-reports.js";
import { getWorkerInvocationInTx, hashLaunchToken, rotatePreparedLaunchTokenInTx } from "../store/worker-invocations.js";
import {
  getReconciliationBindingForAttemptInTx,
  getReconciliationForAttemptInTx,
  insertAttemptReconciliationInTx,
  insertReconciliationBindingInTx,
} from "../store/attempt-reconciliations.js";
import { requireCurrentSupervisorAuthorityInTx } from "../store/supervisor-bindings.js";
import { advanceCandidateRevisionInTx } from "../store/execution-structure.js";
import { issueExecutionDirectiveInTx } from "./execution-directive-service.js";
import { newLaunchToken } from "./worker-runtime-service.js";
import type { StoreClock } from "../store/migration-runner.js";
import type { PlanStore } from "../store/sqlite-store.js";
import type { StoreTx } from "../store/transaction.js";

function recoveryError(
  code:
    | "ATTEMPT_RECONCILIATION_REQUIRED"
    | "ATTEMPT_RECONCILIATION_ALREADY_RESOLVED"
    | "ATTEMPT_RECONCILIATION_TARGET_INVALID"
    | "ATTEMPT_RECONCILIATION_REPORT_REQUIRED"
    | "ATTEMPT_RECONCILIATION_REPORT_INVALID"
    | "ATTEMPT_RECONCILIATION_STALE"
    | "ATTEMPT_RECONCILIATION_SIDE_EFFECT_RISK"
    | "WORKER_LIVENESS_UNCERTAIN"
    | "WORKER_LAUNCH_RETRY_NOT_ALLOWED",
  message: string,
  detail?: Record<string, unknown>,
): RuntimeError {
  return new RuntimeError(code, message, { detail, recoverable: false });
}

// ---------------------------------------------------------------------------
// Derived unresolved/reconciled facts (E11 §7) — Store-derived, never stored.
// ---------------------------------------------------------------------------

export {
  isAttemptUnresolvedIndeterminateInTx,
  listUnresolvedIndeterminateInTx,
  requireNoUnresolvedIndeterminateFenceInTx,
} from "./recovery-fence.js";
import { listUnresolvedIndeterminateInTx as listUnresolvedIndeterminateLeafInTx } from "./recovery-fence.js";

function attemptDirectiveWindowIdInTx(tx: StoreTx, attempt: ExecutionAttempt): string {
  const directive = getExecutionDirectiveInTx(tx, attempt.directiveId, attempt.directiveRevision);
  return directive?.windowId ?? "";
}

// ---------------------------------------------------------------------------
// Runtime recovery classification (E11 §45) — Store-derived projection facts.
// ---------------------------------------------------------------------------

export type AttemptRuntimeState =
  | "prepared-unclaimed"
  | "claimed"
  | "reported-but-runtime-not-finished"
  | "authoritative-stop"
  | "liveness-unknown";

export type AttemptReconciliationState =
  | "not-required"
  | "required"
  | "in-progress"
  | "resolved-no-effect"
  | "resolved-no-effect-by-capability"
  | "resolved-candidate-changed";

export interface AttemptRecoveryFact {
  attemptId: string;
  directiveId: string;
  directiveRevision: number;
  directiveHash: string;
  workerRole: string;
  logicalState: "running" | "indeterminate";
  runtimeState: AttemptRuntimeState;
  reconciliation: AttemptReconciliationState;
  /** True exactly when the SAME logical Attempt can be relaunched (E11 §40). */
  unclaimedRetryAvailable: boolean;
}

/**
 * E11 §45 — the per-Attempt recovery classification, reconstructed solely from
 * the Store. No timeout participates (E11 §44): a claimed invocation without a
 * Report and without an authoritative stop is `liveness-unknown` forever.
 */
export function classifyAttemptRecoveryInTx(tx: StoreTx, attempt: ExecutionAttempt): AttemptRecoveryFact {
  const invocation = getWorkerInvocationInTx(tx, attempt.attemptId);
  const report = getReportForAttemptInTx(tx, attempt.attemptId);
  let runtimeState: AttemptRuntimeState;
  if (invocation === null || invocation.state === "prepared") {
    runtimeState = "prepared-unclaimed";
  } else if (invocation.state === "claimed") {
    runtimeState = report !== null ? "reported-but-runtime-not-finished" : "claimed";
  } else {
    // finished: the authoritative-stop convergence leaves the Attempt
    // indeterminate; a finished runtime without an authoritative convergence
    // fact (pre-claim stop) stays honestly unresolved-at-runtime.
    runtimeState = attempt.state === "indeterminate" ? "authoritative-stop" : "liveness-unknown";
  }
  const binding = getReconciliationBindingForAttemptInTx(tx, attempt.attemptId);
  const resolution = getReconciliationForAttemptInTx(tx, attempt.attemptId);
  let reconciliation: AttemptReconciliationState;
  if (attempt.state !== "indeterminate") {
    reconciliation = "not-required";
  } else if (resolution !== null) {
    reconciliation =
      resolution.resolution === "no_effect"
        ? "resolved-no-effect"
        : resolution.resolution === "no_effect_by_capability"
          ? "resolved-no-effect-by-capability"
          : "resolved-candidate-changed";
  } else {
    reconciliation = binding === null ? "required" : "in-progress";
  }
  const unclaimedRetryAvailable =
    attempt.state === "running"
    && invocation !== null
    && invocation.state === "prepared"
    && invocation.workerSessionId === null
    && report === null;
  return {
    attemptId: attempt.attemptId,
    directiveId: attempt.directiveId,
    directiveRevision: attempt.directiveRevision,
    directiveHash: attempt.directiveHash,
    workerRole: attempt.workerRole,
    logicalState: attempt.state === "running" ? "running" : "indeterminate",
    runtimeState,
    reconciliation,
    unclaimedRetryAvailable,
  };
}

// ---------------------------------------------------------------------------
// Shared authority + exactness fences (E11 §11/§24).
// ---------------------------------------------------------------------------

interface RecoveryAuthority {
  executionRunId: string;
  sessionId: string;
  workspaceId: string;
  generation: number;
}

function requireRecoveryAuthorityInTx(tx: StoreTx, input: RecoveryAuthority): { run: ExecutionRun; windowId: string; candidateRevision: number } {
  // E11 §51/T51 — the terminal-lifecycle check precedes the E2 fence: a
  // terminal (replan_required/completed) run is never reopened for recovery,
  // regardless of binding state (E9 detaches the binding at the terminal
  // transition; the deeper fact is the lifecycle itself).
  const run = getExecutionRunInTx(tx, input.executionRunId);
  if (run === null) {
    throw recoveryError("ATTEMPT_RECONCILIATION_TARGET_INVALID", `no ExecutionRun exists for '${input.executionRunId}'`, {
      executionRunId: input.executionRunId,
    });
  }
  if (run.lifecycle !== "active") {
    throw recoveryError(
      "ATTEMPT_RECONCILIATION_TARGET_INVALID",
      `ExecutionRun '${run.executionRunId}' is ${run.lifecycle}; recovery operations require an active run (E11 §51/T51)`,
      { executionRunId: input.executionRunId, lifecycle: run.lifecycle },
    );
  }
  requireCurrentSupervisorAuthorityInTx(tx, {
    executionRunId: input.executionRunId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    generation: input.generation,
  });
  const openWindow = getOpenWindowInTx(tx, input.executionRunId);
  if (openWindow === null) {
    throw recoveryError(
      "ATTEMPT_RECONCILIATION_TARGET_INVALID",
      `ExecutionRun '${run.executionRunId}' has no open window; recovery binds the CURRENT open window (E11 §12)`,
      { executionRunId: input.executionRunId },
    );
  }
  return { run, windowId: openWindow.id, candidateRevision: openWindow.candidateRevision };
}

function requireReconcilableTargetInTx(
  tx: StoreTx,
  executionRunId: string,
  windowId: string,
  attemptId: string,
): { attempt: ExecutionAttempt; originalDirective: ExecutionDirective; invocation: WorkerInvocationBinding | null } {
  const attempt = getExecutionAttemptInTx(tx, attemptId);
  if (attempt === null || attempt.executionRunId !== executionRunId) {
    throw recoveryError(
      "ATTEMPT_RECONCILIATION_TARGET_INVALID",
      `attempt '${attemptId}' does not exist in run '${executionRunId}'`,
      { attemptId, executionRunId },
    );
  }
  if (attempt.state !== "indeterminate") {
    throw recoveryError(
      "ATTEMPT_RECONCILIATION_TARGET_INVALID",
      `attempt '${attemptId}' is ${attempt.state}; only an indeterminate Attempt is a reconciliation target (E11 §11)`,
      { attemptId, state: attempt.state },
    );
  }
  const originalDirective = getExecutionDirectiveInTx(tx, attempt.directiveId, attempt.directiveRevision);
  if (originalDirective === null) {
    throw recoveryError(
      "ATTEMPT_RECONCILIATION_TARGET_INVALID",
      `attempt '${attemptId}' binds a missing Directive revision`,
      { attemptId },
    );
  }
  // E11 §11 — the target belongs to the CURRENT open execution scope.
  if (attemptDirectiveWindowIdInTx(tx, attempt) !== windowId) {
    throw recoveryError(
      "ATTEMPT_RECONCILIATION_TARGET_INVALID",
      `attempt '${attemptId}' does not belong to the current open window '${windowId}' (E11 §11/§12)`,
      { attemptId, expectedWindowId: windowId },
    );
  }
  const existing = getReconciliationForAttemptInTx(tx, attemptId);
  if (existing !== null) {
    throw recoveryError(
      "ATTEMPT_RECONCILIATION_ALREADY_RESOLVED",
      `attempt '${attemptId}' already carries reconciliation '${existing.reconciliationId}' (${existing.resolution})`,
      { attemptId, resolution: existing.resolution },
    );
  }
  const invocation = getWorkerInvocationInTx(tx, attemptId);
  return { attempt, originalDirective, invocation };
}

// ---------------------------------------------------------------------------
// issue_attempt_reconciliation (E11 §11/§12/§20) — binding + Directive in ONE
// transaction; the requiredAction hash-covers the target (E11 §10 option 1).
// ---------------------------------------------------------------------------

export interface IssueAttemptReconciliationResult {
  directive: ExecutionDirective;
  binding: { attemptId: string; directiveId: string };
  sideEffectCapable: boolean;
  windowId: string;
  candidateRevision: number;
}

export function issueAttemptReconciliationInTx(
  tx: StoreTx,
  input: RecoveryAuthority & {
    attemptId: string;
    objective: string;
    body: string;
    capabilityEnvelope: ExecutionDirective["capabilityEnvelope"];
    reportContract: ExecutionDirective["reportContract"];
  },
  clock: StoreClock,
  now: string,
): IssueAttemptReconciliationResult {
  const { windowId, candidateRevision } = requireRecoveryAuthorityInTx(tx, input);
  const { attempt, originalDirective } = requireReconcilableTargetInTx(tx, input.executionRunId, windowId, input.attemptId);
  const existingBinding = getReconciliationBindingForAttemptInTx(tx, input.attemptId);
  if (existingBinding !== null) {
    throw recoveryError(
      "ATTEMPT_RECONCILIATION_TARGET_INVALID",
      `attempt '${input.attemptId}' is already bound to reconciliation Directive '${existingBinding.directiveId}'; issue a new REVISION of that logical id (E11 §9)`,
      { attemptId: input.attemptId, boundDirectiveId: existingBinding.directiveId },
    );
  }
  // E11 §12 — the reconciliation uses the CURRENT open window's scope: a
  // stage window binds that Stage, the final-closure window binds
  // final_closure. No synthetic Window/Stage/Commit exists.
  const directive = issueExecutionDirectiveInTx(
    tx,
    {
      executionRunId: input.executionRunId,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      generation: input.generation,
      directiveId: `dir_rec_${clock.newId()}`,
      kind: "inspection",
      windowId,
      objective: input.objective,
      body: input.body,
      requiredActions: [{ action: "reconcile_indeterminate_attempt", detail: attempt.attemptId }],
      capabilityEnvelope: input.capabilityEnvelope,
      reportContract: input.reportContract,
      skipRecoveryFence: true,
      ...(windowScopeKindInTx(tx, windowId) === "final_closure"
        ? { scopeKind: "final_closure" as const }
        : { stageId: windowStageIdInTx(tx, windowId) as string }),
    },
    clock,
    now,
  );
  const binding = {
    attemptId: attempt.attemptId,
    executionRunId: input.executionRunId,
    directiveId: directive.directiveId,
    firstDirectiveRevision: directive.revision,
    createdAt: now,
  };
  // Binding + Directive land in ONE transaction (E11 §11).
  insertReconciliationBindingInTx(tx, binding);
  void originalDirective;
  return {
    directive,
    binding: { attemptId: attempt.attemptId, directiveId: directive.directiveId },
    sideEffectCapable: isSideEffectCapable(originalDirective.capabilityEnvelope),
    windowId,
    candidateRevision,
  };
}



function windowScopeKindInTx(tx: StoreTx, windowId: string): string {
  return (
    (tx.prepare("SELECT scope_kind AS kind FROM verification_windows WHERE id = ?").get(windowId) as { kind: string })
      ?.kind ?? "stage"
  );
}

function windowStageIdInTx(tx: StoreTx, windowId: string): string | null {
  return (
    (tx.prepare("SELECT stage_id AS id FROM verification_windows WHERE id = ?").get(windowId) as { id: string | null })
      ?.id ?? null
  );
}

// ---------------------------------------------------------------------------
// resolve_indeterminate_attempt (E11 §16/§24–§27) — the final immutable
// resolution. candidate_changed is the SECOND candidateRevision writer.
// ---------------------------------------------------------------------------

export interface ResolveIndeterminateAttemptResult {
  reconciliation: AttemptReconciliation;
  status: "resolved" | "already_resolved";
  window: { id: string; candidateRevision: number };
}

export function resolveIndeterminateAttemptInTx(
  tx: StoreTx,
  input: RecoveryAuthority & {
    attemptId: string;
    resolution: AttemptReconciliationResolution;
    inspectionReportId?: string;
    rationale: string;
    expectedCandidateRevision: number;
  },
  clock: StoreClock,
  now: string,
): ResolveIndeterminateAttemptResult {
  const { windowId, candidateRevision } = requireRecoveryAuthorityInTx(tx, input);
  if (input.expectedCandidateRevision !== candidateRevision) {
    throw recoveryError(
      "ATTEMPT_RECONCILIATION_STALE",
      `stale expected candidate revision ${input.expectedCandidateRevision}; the open window is at ${candidateRevision} (E11 §29)`,
      { expected: input.expectedCandidateRevision, detected: candidateRevision },
    );
  }
  // E11 §37 — an existing final resolution converges the retry: identical
  // (resolution, report) returns the durable fact; anything else is refused
  // without a second resolution or revision advance.
  const existing = getReconciliationForAttemptInTx(tx, input.attemptId);
  if (existing !== null) {
    if (existing.resolution === input.resolution && existing.inspectionReportId === (input.inspectionReportId ?? null)) {
      return {
        reconciliation: existing,
        status: "already_resolved",
        window: { id: windowId, candidateRevision },
      };
    }
    throw recoveryError(
      "ATTEMPT_RECONCILIATION_ALREADY_RESOLVED",
      `attempt '${input.attemptId}' already carries reconciliation '${existing.reconciliationId}' (${existing.resolution}) (E11 §8)`,
      { attemptId: input.attemptId, resolution: existing.resolution },
    );
  }
  const { attempt, originalDirective, invocation } = requireReconcilableTargetInTx(tx, input.executionRunId, windowId, input.attemptId);
  if (typeof input.rationale !== "string" || input.rationale.trim() === "") {
    throw recoveryError(
      "ATTEMPT_RECONCILIATION_REPORT_INVALID",
      "a reconciliation resolution requires a non-empty rationale (E11 §8)",
      { attemptId: input.attemptId },
    );
  }

  // E11 §16 — the deterministic capability proof needs NO inspection: the
  // interrupted Directive's effective envelope was provably non-mutating and
  // the candidate never moved. Any effectful capability refuses the shortcut.
  if (input.resolution === "no_effect_by_capability") {
    if (isSideEffectCapable(originalDirective.capabilityEnvelope)) {
      throw recoveryError(
        "ATTEMPT_RECONCILIATION_SIDE_EFFECT_RISK",
        `directive '${originalDirective.directiveId}@${originalDirective.revision}' carries side-effect-capable authority; only a fresh inspection reconciliation may resolve its indeterminate Attempt (E11 §16/§18)`,
        { attemptId: input.attemptId, directiveId: originalDirective.directiveId },
      );
    }
    if (candidateRevision !== attemptDirectiveBaseRevisionInTx(tx, attempt)) {
      // The candidate must be where the interrupted attempt left it — any
      // movement since the crash is unexplained and needs an inspection.
      throw recoveryError(
        "ATTEMPT_RECONCILIATION_STALE",
        "the candidate moved since the interruption; a capability-only no-effect proof requires the exact interrupted candidate (E11 §16)",
        { attemptId: input.attemptId, candidateRevision },
      );
    }
    const reconciliation = buildReconciliation(tx, input, attempt, windowId, null, candidateRevision, candidateRevision, clock, now);
    insertAttemptReconciliationInTx(tx, reconciliation);
    return { reconciliation, status: "resolved", window: { id: windowId, candidateRevision } };
  }

  // E11 §24/§54 — an inspection-backed resolution: the exact completed
  // non-mutating Report of the bound reconciliation Directive lineage.
  const binding = getReconciliationBindingForAttemptInTx(tx, input.attemptId);
  if (binding === null) {
    throw recoveryError(
      "ATTEMPT_RECONCILIATION_REPORT_REQUIRED",
      `attempt '${input.attemptId}' has no bound reconciliation Directive; issue_attempt_reconciliation first (E11 §9/§18)`,
      { attemptId: input.attemptId },
    );
  }
  if (typeof input.inspectionReportId !== "string" || input.inspectionReportId === "") {
    throw recoveryError(
      "ATTEMPT_RECONCILIATION_REPORT_REQUIRED",
      `resolution '${input.resolution}' requires the exact completed reconciliation inspection Report (E11 §24)`,
      { attemptId: input.attemptId },
    );
  }
  const report = getExecutionReportInTx(tx, input.inspectionReportId);
  if (report === null || report.executionRunId !== input.executionRunId) {
    throw recoveryError(
      "ATTEMPT_RECONCILIATION_REPORT_INVALID",
      `report '${input.inspectionReportId}' does not exist in this run`,
      { reportId: input.inspectionReportId },
    );
  }
  // E11 §54 — the Report belongs to the BOUND reconciliation Directive lineage.
  if (report.directiveId !== binding.directiveId) {
    throw recoveryError(
      "ATTEMPT_RECONCILIATION_REPORT_INVALID",
      `report '${report.reportId}' belongs to directive '${report.directiveId}'; only the bound reconciliation Directive '${binding.directiveId}' may resolve the Attempt (E11 §54)`,
      { reportId: report.reportId, boundDirectiveId: binding.directiveId },
    );
  }
  if (report.result !== "completed" || report.candidateMutated !== false) {
    throw recoveryError(
      "ATTEMPT_RECONCILIATION_REPORT_INVALID",
      `report '${report.reportId}' is result=${report.result}, candidateMutated=${report.candidateMutated}; only a completed non-mutating reconciliation inspection may resolve the Attempt (E11 §22/§54)`,
      { reportId: report.reportId, result: report.result, candidateMutated: report.candidateMutated },
    );
  }
  // E11 §19 — freshness where authoritative identity exists: the reconciliation
  // worker session must differ from the interrupted attempt's worker session.
  const reportInvocation = getWorkerInvocationInTx(tx, report.attemptId);
  if (
    invocation?.workerSessionId !== null
    && invocation?.workerSessionId !== undefined
    && reportInvocation?.workerSessionId === invocation.workerSessionId
  ) {
    throw recoveryError(
      "ATTEMPT_RECONCILIATION_REPORT_INVALID",
      "the reconciliation inspection reused the interrupted Worker's session; a fresh worker invocation is required (E11 §19)",
      { attemptId: input.attemptId, workerSessionId: invocation.workerSessionId },
    );
  }
  // E11 §13 — a Report from an earlier window/candidate cannot resolve: the
  // inspection must have observed the CURRENT candidate of the CURRENT window.
  const reportDirective = getExecutionDirectiveInTx(tx, report.directiveId, report.directiveRevision);
  if (reportDirective === null || reportDirective.windowId !== windowId || reportDirective.baseCandidateRevision !== candidateRevision) {
    throw recoveryError(
      "ATTEMPT_RECONCILIATION_STALE",
      `report '${report.reportId}' observed window '${reportDirective?.windowId ?? "none"}'@${reportDirective?.baseCandidateRevision ?? -1}; the current window is '${windowId}'@${candidateRevision} (E11 §22/§29)`,
      { reportId: report.reportId },
    );
  }
  void attempt;
  const before = candidateRevision;
  const after = input.resolution === "candidate_changed" ? candidateRevision + 1 : candidateRevision;
  // E11 §26/§29 — the reconciliation-driven candidate advance shares the E3
  // CAS primitive with the Report-driven writer; a moved candidate rolls the
  // whole resolution back.
  const reconciliation = buildReconciliation(tx, input, attempt, windowId, input.inspectionReportId, before, after, clock, now);
  insertAttemptReconciliationInTx(tx, reconciliation);
  if (input.resolution === "candidate_changed") {
    advanceCandidateRevisionInTx(tx, { executionRunId: input.executionRunId, expectedRevision: before });
  }
  return {
    reconciliation,
    status: "resolved",
    window: { id: windowId, candidateRevision: after },
  };
}

function attemptDirectiveBaseRevisionInTx(tx: StoreTx, attempt: ExecutionAttempt): number {
  const directive = getExecutionDirectiveInTx(tx, attempt.directiveId, attempt.directiveRevision);
  return directive?.baseCandidateRevision ?? -1;
}

function buildReconciliation(
  tx: StoreTx,
  input: RecoveryAuthority & { attemptId: string; resolution: AttemptReconciliationResolution; rationale: string },
  attempt: ExecutionAttempt,
  windowId: string,
  inspectionReportId: string | null,
  before: number,
  after: number,
  clock: StoreClock,
  now: string,
): AttemptReconciliation {
  // The resolving Directive: the capability proof resolves under the ORIGINAL
  // interrupted Directive (its envelope IS the proof); an inspection-backed
  // resolution resolves under the exact completed reconciliation revision.
  let directiveId: string;
  let directiveRevision: number;
  if (inspectionReportId === null) {
    directiveId = attempt.directiveId;
    directiveRevision = attempt.directiveRevision;
  } else {
    const binding = getReconciliationBindingForAttemptInTx(tx, attempt.attemptId);
    const report = getExecutionReportInTx(tx, inspectionReportId as string);
    directiveId = binding?.directiveId ?? report?.directiveId ?? attempt.directiveId;
    directiveRevision = report?.directiveRevision ?? binding?.firstDirectiveRevision ?? attempt.directiveRevision;
  }
  return {
    reconciliationId: `rec_${clock.newId()}`,
    attemptId: attempt.attemptId,
    executionRunId: input.executionRunId,
    directiveId,
    directiveRevision,
    sourceWindowId: windowId,
    resolution: input.resolution,
    inspectionReportId,
    candidateRevisionBefore: before,
    candidateRevisionAfter: after,
    rationale: input.rationale,
    createdAt: now,
  };
}

// ---------------------------------------------------------------------------
// retry_unclaimed_worker_launch (E11 §40/§41) — credential rotation on the
// SAME logical Attempt and invocation binding; never a second Attempt.
// ---------------------------------------------------------------------------

export interface RetryUnclaimedLaunchResult {
  attemptId: string;
  directive: { id: string; revision: number; hash: string };
  workerRole: string;
  /** The NEW plaintext token — returned ONCE; the old token is invalidated. */
  launchToken: string;
  workerAgentType: string;
}

export function retryUnclaimedLaunchInTx(
  tx: StoreTx,
  input: RecoveryAuthority & { attemptId: string },
  now: string,
): RetryUnclaimedLaunchResult {
  requireCurrentSupervisorAuthorityInTx(tx, {
    executionRunId: input.executionRunId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    generation: input.generation,
  });
  const run = getExecutionRunInTx(tx, input.executionRunId);
  if (run === null || run.lifecycle !== "active") {
    throw recoveryError(
      "WORKER_LAUNCH_RETRY_NOT_ALLOWED",
      `ExecutionRun '${input.executionRunId}' is ${run?.lifecycle ?? "missing"}; launch retry requires an active run (E11 §40)`,
      { executionRunId: input.executionRunId },
    );
  }
  const attempt = getExecutionAttemptInTx(tx, input.attemptId);
  if (attempt === null || attempt.executionRunId !== input.executionRunId) {
    throw recoveryError(
      "WORKER_LAUNCH_RETRY_NOT_ALLOWED",
      `attempt '${input.attemptId}' does not exist in run '${input.executionRunId}'`,
      { attemptId: input.attemptId },
    );
  }
  const directive = getExecutionDirectiveInTx(tx, attempt.directiveId, attempt.directiveRevision);
  if (directive === null || directive.hash !== attempt.directiveHash) {
    throw recoveryError(
      "WORKER_LAUNCH_RETRY_NOT_ALLOWED",
      `attempt '${input.attemptId}' binds a missing or mismatched Directive revision; the launch is no longer exact/current (E11 §40)`,
      { attemptId: input.attemptId },
    );
  }
  const invocation = getWorkerInvocationInTx(tx, input.attemptId);
  if (invocation === null || invocation.state !== "prepared" || invocation.workerSessionId !== null) {
    throw recoveryError(
      "WORKER_LAUNCH_RETRY_NOT_ALLOWED",
      `attempt '${input.attemptId}' has a ${invocation?.state ?? "missing"} invocation; only a prepared unclaimed launch may retry (E11 §40)`,
      { attemptId: input.attemptId, state: invocation?.state ?? null },
    );
  }
  // The directive must STILL be exact/current against the open window (§40).
  const openWindow = getOpenWindowInTx(tx, input.executionRunId);
  if (openWindow === null || openWindow.id !== directive.windowId || openWindow.candidateRevision !== directive.baseCandidateRevision) {
    throw recoveryError(
      "WORKER_LAUNCH_RETRY_NOT_ALLOWED",
      `the Directive is no longer current for the open window; a new Directive revision is required (E11 §40)`,
      { attemptId: input.attemptId, windowId: openWindow?.id ?? null },
    );
  }
  const token = newLaunchToken();
  rotatePreparedLaunchTokenInTx(tx, { attemptId: input.attemptId, newTokenHash: hashLaunchToken(token) }, now);
  return {
    attemptId: attempt.attemptId,
    directive: { id: attempt.directiveId, revision: attempt.directiveRevision, hash: attempt.directiveHash },
    workerRole: attempt.workerRole,
    launchToken: token,
    workerAgentType: "phase-plan:execution-worker",
  };
}

// ---------------------------------------------------------------------------
// get_attempt_recovery_context (E11 §46) — read-only Supervisor surface.
// ---------------------------------------------------------------------------

export interface AttemptRecoveryContext {
  executionRun: Pick<ExecutionRun, "executionRunId" | "lifecycle">;
  acceptedHead: string | null;
  openWindow: { id: string; scopeKind: string; candidateRevision: number } | null;
  attempts: Array<
    AttemptRecoveryFact & {
      originalDirective: {
        directiveId: string;
        revision: number;
        hash: string;
        kind: string;
        baseCandidateRevision: number;
        sideEffectCapable: boolean;
        windowId: string;
      };
      reconciliationDirectiveId: string | null;
      reconciliationRevisions: Array<{ revision: number; reportId: string | null; result: string | null }>;
      resolution: {
        reconciliationId: string;
        resolution: AttemptReconciliationResolution;
        candidateRevisionBefore: number;
        candidateRevisionAfter: number;
      } | null;
    }
  >;
  unresolvedIndeterminateAttemptIds: string[];
  executionFenced: boolean;
  capabilityResolutionAvailable: Array<{ attemptId: string }>;
}

export function loadAttemptRecoveryContextInTx(tx: StoreTx, executionRunId: string): AttemptRecoveryContext {
  const run = getExecutionRunInTx(tx, executionRunId);
  if (run === null) {
    throw recoveryError("ATTEMPT_RECONCILIATION_TARGET_INVALID", `no ExecutionRun exists for '${executionRunId}'`, {
      executionRunId,
    });
  }
  const openWindow = getOpenWindowInTx(tx, executionRunId);
  const attempts = listRunAttemptsInTx(tx, executionRunId);
  const unresolved = listUnresolvedIndeterminateLeafInTx(tx, executionRunId);
  const unresolvedWindowScoped = openWindow === null
    ? []
    : unresolved.filter((attempt) => attemptDirectiveWindowIdInTx(tx, attempt) === openWindow.id);
  const attemptsView = attempts
    .filter((attempt) => attempt.state !== "reported")
    .map((attempt) => {
      const fact = classifyAttemptRecoveryInTx(tx, attempt);
      const originalDirective = getExecutionDirectiveInTx(tx, attempt.directiveId, attempt.directiveRevision);
      const binding = getReconciliationBindingForAttemptInTx(tx, attempt.attemptId);
      const resolution = getReconciliationForAttemptInTx(tx, attempt.attemptId);
      const reconciliationRevisions = binding === null
        ? []
        : listRunDirectivesByIdInTx(tx, binding.directiveId).map((directive) => {
            const report = getReportForAttemptByDirectiveInTx(tx, directive.directiveId, directive.revision);
            return {
              revision: directive.revision,
              reportId: report?.reportId ?? null,
              result: report?.result ?? null,
            };
          });
      return {
        ...fact,
        originalDirective: {
          directiveId: attempt.directiveId,
          revision: attempt.directiveRevision,
          hash: attempt.directiveHash,
          kind: originalDirective?.kind ?? "unknown",
          baseCandidateRevision: originalDirective?.baseCandidateRevision ?? -1,
          sideEffectCapable: originalDirective === null ? true : isSideEffectCapable(originalDirective.capabilityEnvelope),
          windowId: originalDirective?.windowId ?? "",
        },
        reconciliationDirectiveId: binding?.directiveId ?? null,
        reconciliationRevisions,
        resolution:
          resolution === null
            ? null
            : {
                reconciliationId: resolution.reconciliationId,
                resolution: resolution.resolution,
                candidateRevisionBefore: resolution.candidateRevisionBefore,
                candidateRevisionAfter: resolution.candidateRevisionAfter,
              },
      };
    });
  const capabilityResolutionAvailable = unresolved
    .filter((attempt) => {
      const directive = getExecutionDirectiveInTx(tx, attempt.directiveId, attempt.directiveRevision);
      return directive !== null && !isSideEffectCapable(directive.capabilityEnvelope);
    })
    .map((attempt) => ({ attemptId: attempt.attemptId }));
  return {
    executionRun: { executionRunId: run.executionRunId, lifecycle: run.lifecycle },
    acceptedHead: getAcceptedHeadCommitIdInTx(tx, executionRunId),
    openWindow:
      openWindow === null
        ? null
        : { id: openWindow.id, scopeKind: openWindow.scopeKind, candidateRevision: openWindow.candidateRevision },
    attempts: attemptsView,
    unresolvedIndeterminateAttemptIds: unresolved.map((attempt) => attempt.attemptId),
    executionFenced: unresolvedWindowScoped.length > 0,
    capabilityResolutionAvailable,
  };
}

function listRunDirectivesByIdInTx(tx: StoreTx, directiveId: string): ExecutionDirective[] {
  return listWindowDirectivesByIdInTx(tx, directiveId);
}

function listWindowDirectivesByIdInTx(tx: StoreTx, directiveId: string): ExecutionDirective[] {
  const rows = tx
    .prepare(
      "SELECT window_id AS windowId FROM execution_directives WHERE directive_id = ? ORDER BY revision LIMIT 1",
    )
    .get(directiveId) as { windowId: string } | undefined;
  if (rows === undefined) return [];
  return listWindowDirectivesInTx(tx, rows.windowId).filter((directive) => directive.directiveId === directiveId);
}

function getReportForAttemptByDirectiveInTx(tx: StoreTx, directiveId: string, revision: number): { reportId: string; result: string } | null {
  const row = tx
    .prepare(
      "SELECT report_id AS reportId, result FROM execution_reports WHERE directive_id = ? AND directive_revision = ?",
    )
    .get(directiveId, revision) as { reportId: string; result: string } | undefined;
  return row ?? null;
}

// Service wrapper.
export function createAttemptRecoveryService(store: PlanStore, clock: StoreClock) {
  return {
    /** E11 §46 — read-only recovery context. */
    getAttemptRecoveryContext(input: { executionRunId: string }): AttemptRecoveryContext {
      return store.withRead((tx) => loadAttemptRecoveryContextInTx(tx, input.executionRunId));
    },

    /** E11 §11 — binding + reconciliation Directive in one transaction. */
    issueAttemptReconciliation(
      input: RecoveryAuthority & {
        attemptId: string;
        objective: string;
        body: string;
        capabilityEnvelope: ExecutionDirective["capabilityEnvelope"];
        reportContract: ExecutionDirective["reportContract"];
      },
    ): IssueAttemptReconciliationResult {
      return store.withWrite((tx) => issueAttemptReconciliationInTx(tx, input, clock, clock.nowIso()));
    },

    /** E11 §24 — the final immutable resolution. */
    resolveIndeterminateAttempt(
      input: RecoveryAuthority & {
        attemptId: string;
        resolution: AttemptReconciliationResolution;
        inspectionReportId?: string;
        rationale: string;
        expectedCandidateRevision: number;
      },
    ): ResolveIndeterminateAttemptResult {
      return store.withWrite((tx) => resolveIndeterminateAttemptInTx(tx, input, clock, clock.nowIso()));
    },

    /** E11 §40 — the same-Attempt launch credential retry. */
    retryUnclaimedLaunch(
      input: RecoveryAuthority & { attemptId: string },
    ): RetryUnclaimedLaunchResult {
      return store.withWrite((tx) => retryUnclaimedLaunchInTx(tx, input, clock.nowIso()));
    },
  };
}
