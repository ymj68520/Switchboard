/**
 * Verification-policy application service (v0.2.0 E8 §10–§25).
 *
 * The DERIVED read/gate layer over core/verification-policy.ts. There is no
 * second authoritative state machine (E8 §10): every call re-derives the
 * verification-pressure state from the Store's durable facts — the current
 * Window, its Directives (with E8 protocol/policy fields), Attempts, Reports,
 * and real E5 Worker invocation identities — and nothing is cached.
 *
 * Core owns WHEN verification is mandatory (E8 §27); the Supervisor still
 * authors every VerificationDirective's semantic content (E8 §24).
 */

import {
  deriveVerificationPolicyState,
  type VerificationPolicyFact,
  type VerificationPolicyState,
} from "../core/verification-policy.js";
import type { ExecutionDirective } from "../core/execution-directive.js";
import { RuntimeError } from "../runtime/errors.js";
import { getOpenWindowInTx } from "../store/execution-structure.js";
import {
  getExecutionDirectiveInTx,
  listWindowDirectivesInTx,
} from "../store/execution-directives.js";
import { listWindowAttemptsInTx } from "../store/execution-attempts.js";
import { getReportForAttemptInTx } from "../store/execution-reports.js";
import { getWorkerInvocationInTx } from "../store/worker-invocations.js";
import { getAttemptForDirectiveInTx, getExecutionAttemptInTx } from "../store/execution-attempts.js";
import { listRunReconciliationsInTx } from "../store/attempt-reconciliations.js";
import type { StoreTx } from "../store/transaction.js";

function policyError(
  code: "DIRECTIVE_POLICY_UPGRADE_REQUIRED" | "VERIFICATION_REQUIRED",
  message: string,
  detail?: Record<string, unknown>,
): RuntimeError {
  return new RuntimeError(code, message, { detail, recoverable: false });
}

/** Build the Store-derived fact list for one open Window (E8 §10). */
export function loadWindowPolicyFactsInTx(tx: StoreTx, windowId: string): VerificationPolicyFact[] {
  const directives = listWindowDirectivesInTx(tx, windowId);
  const directiveById = new Map(directives.map((d) => [`${d.directiveId}@${d.revision}`, d] as const));
  return listWindowAttemptsInTx(tx, windowId).flatMap((attempt) => {
    const directive = directiveById.get(`${attempt.directiveId}@${attempt.directiveRevision}`);
    if (directive === undefined) {
      return [];
    }
    const report = getReportForAttemptInTx(tx, attempt.attemptId);
    const invocation = getWorkerInvocationInTx(tx, attempt.attemptId);
    return [
      {
        directive,
        report,
        attemptId: attempt.attemptId,
        attemptState: attempt.state,
        workerRole: attempt.workerRole,
        invocationState: invocation?.state ?? null,
        attemptStartedAt: attempt.startedAt,
        reportCreatedAt: report?.createdAt ?? "",
      },
    ];
  });
}

/**
 * The deterministic verification-pressure state of the run's CURRENT open
 * Window (null when no window is open — the derivation only exists inside a
 * verification window).
 */
export function loadVerificationPolicyStateInTx(tx: StoreTx, runId: string): VerificationPolicyState | null {
  const window = getOpenWindowInTx(tx, runId);
  if (window === null) {
    return null;
  }
  const derived = deriveVerificationPolicyState({
    windowId: window.id,
    candidateRevision: window.candidateRevision,
    facts: loadWindowPolicyFactsInTx(tx, window.id),
  });
  // E11 §30–§34 — a candidate_changed reconciliation is a REAL candidate
  // mutation fact. No fake ExecutionReport exists: the recovered debt merges
  // into the derived state under the frozen E8 precedence, exactly like the
  // interrupted Directive had reported the mutation itself.
  return mergeReconciliationDebtInTx(tx, runId, window.candidateRevision, derived);
}

const DEBT_PRECEDENCE: Record<NonNullable<VerificationPolicyState["reason"]>, number> = {
  immediate: 3,
  unexpected_mutation: 2,
  legacy_policy_unknown: 1,
  max_unverified_span: 0,
};

function mergeReconciliationDebtInTx(
  tx: StoreTx,
  runId: string,
  candidateRevision: number,
  derived: VerificationPolicyState,
): VerificationPolicyState {
  if (candidateRevision <= derived.latestVerifiedRevision) {
    // E8 §19 — a qualifying normal verification at the current revision clears
    // ALL debt, reconciliation-recovered debt included.
    return derived;
  }
  let reason: NonNullable<VerificationPolicyState["reason"]> | null = null;
  let blockingDirective: ExecutionDirective | null = null;
  let blockingReportId: string | null = null;
  for (const reconciliation of listRunReconciliationsInTx(tx, runId)) {
    if (reconciliation.resolution !== "candidate_changed") continue;
    if (reconciliation.candidateRevisionAfter !== candidateRevision) continue;
    const attempt = getExecutionAttemptInTx(tx, reconciliation.attemptId);
    if (attempt === null) continue;
    const original = voidDirectiveOf(tx, attempt);
    if (original === null) continue;
    // §31/§32/§33/§34 — the recovered mutation carries the ORIGINAL
    // Directive's policy: immediate fires immediate; a batchable contributes
    // its span increment (already accounted by the candidate advance); an
    // inspection/verification mutation is unexpected; a v1 implementation is
    // conservatively legacy-unknown.
    let candidateReason: NonNullable<VerificationPolicyState["reason"]> | null = null;
    if (original.kind === "implementation") {
      if (original.protocolVersion === 1) {
        candidateReason = "legacy_policy_unknown";
      } else if (original.verificationPolicy?.implementationRequirement === "immediate") {
        candidateReason = "immediate";
      }
    } else {
      candidateReason = "unexpected_mutation";
    }
    if (candidateReason !== null && (reason === null || DEBT_PRECEDENCE[candidateReason] > DEBT_PRECEDENCE[reason])) {
      reason = candidateReason;
      blockingDirective = original;
      blockingReportId = reconciliation.inspectionReportId;
    }
  }
  if (reason === null) {
    return derived;
  }
  const derivedRank = derived.reason === null ? -1 : DEBT_PRECEDENCE[derived.reason];
  if (DEBT_PRECEDENCE[reason] <= derivedRank) {
    return derived;
  }
  return {
    ...derived,
    verificationRequired: true,
    reason,
    blockingReportRef:
      blockingDirective === null
        ? derived.blockingReportRef
        : {
            reportId: blockingReportId ?? `reconciled:${blockingDirective.directiveId}@${blockingDirective.revision}`,
            directiveId: blockingDirective.directiveId,
            revision: blockingDirective.revision,
            baseCandidateRevision: blockingDirective.baseCandidateRevision,
          },
  };
}

function voidDirectiveOf(tx: StoreTx, attempt: { directiveId: string; directiveRevision: number }): ExecutionDirective | null {
  return getExecutionDirectiveInTx(tx, attempt.directiveId, attempt.directiveRevision);
}

/**
 * E8 §9 — an UNATTEMPTED legacy v1 implementation Directive has no explicit
 * verification policy; Core refuses to start it so the Supervisor must issue
 * a v2 revision first (conservative upgrade, E8 §8). Already
 * running/reported v1 history is never rewritten.
 */
function requireUpgradedDirectivePolicy(tx: StoreTx, directive: ExecutionDirective): void {
  if (directive.protocolVersion !== 1 || directive.kind !== "implementation") {
    return;
  }
  const priorAttempt = getAttemptForDirectiveInTx(tx, directive.directiveId, directive.revision);
  if (priorAttempt === null) {
    throw policyError(
      "DIRECTIVE_POLICY_UPGRADE_REQUIRED",
      `implementation directive '${directive.directiveId}@${directive.revision}' is a legacy v1 revision with no explicit verification policy; issue a v2 revision (implementationRequirement=immediate) before starting it (E8 §8/§9)`,
      { directiveId: directive.directiveId, revision: directive.revision },
    );
  }
}

/**
 * E8 §21/§22 — the verification-pressure gate alone (used at issuance, where
 * the Directive being issued is definitionally v2). Implementation issuance is
 * refused while verification is due; inspection, normal verification, and
 * conflict-resolution verification are never blocked by it (E8 §21).
 */
export function requireVerificationPressureClearInTx(tx: StoreTx, runId: string): void {
  const state = loadVerificationPolicyStateInTx(tx, runId);
  if (state === null || !state.verificationRequired) {
    return;
  }
  throw policyError(
    "VERIFICATION_REQUIRED",
    `verification is required before further implementation (reason=${state.reason}, unverifiedMutationSpan=${state.unverifiedMutationSpan}/${state.maxUnverifiedMutations}); issue and complete a fresh normal verification first (E8 §14–§22)`,
    {
      reason: state.reason,
      candidateRevision: state.candidateRevision,
      latestVerifiedRevision: state.latestVerifiedRevision,
      unverifiedMutationSpan: state.unverifiedMutationSpan,
      maxUnverifiedMutations: state.maxUnverifiedMutations,
      blockingReportRef: state.blockingReportRef,
    },
  );
}

/**
 * E8 §22 — the FULL attempt-startup gate: the §9 conservative upgrade rule for
 * unattempted legacy v1 implementation Directives, then an INDEPENDENT re-check
 * of the verification pressure (a pre-issued Directive cannot bypass pressure
 * that became due after its issuance).
 */
export function requireImplementationPolicyClearInTx(tx: StoreTx, directive: ExecutionDirective): void {
  if (directive.kind !== "implementation") {
    return;
  }
  requireUpgradedDirectivePolicy(tx, directive);
  requireVerificationPressureClearInTx(tx, directive.runId);
}
