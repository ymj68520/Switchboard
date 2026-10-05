/**
 * Verification insertion policy (v0.2.0 E8 §10–§25).
 *
 * PURE core: the adapter's frozen pressure bound and the DETERMINISTIC
 * derivation of verification debt from durable execution facts only — window
 * candidateRevision, Directive protocol/policy, Attempts, Reports, and real
 * Worker invocation identities. No second authoritative state machine exists
 * (E8 §10): the Store is canonical and this module derives state from it on
 * every read.
 *
 * The policy answers exactly one question (E8 §11):
 *   "Has independent verification happened?" / "Must verification happen
 *    before more implementation?"
 * It NEVER answers "should we accept?" — that remains the E6
 * SupervisorAssessment's semantic judgment.
 */

import type { ExecutionDirective, DirectiveVerificationPolicy } from "./execution-directive.js";
import type { ExecutionReport } from "./execution-report.js";

/**
 * E8 §14 — the Claude adapter implementation policy. NOT a v0.2 architecture
 * constant: it is isolated here so later implementation revisions can tune it
 * without touching protocol semantics.
 */
export const MAX_UNVERIFIED_MUTATIONS = 3;

export type VerificationDebtReason =
  | "immediate"
  | "max_unverified_span"
  | "unexpected_mutation"
  | "legacy_policy_unknown";

/** The minimal report fact the derivation needs (Store-derived, never model-enumerated). */
export interface VerificationPolicyFact {
  directive: Pick<ExecutionDirective, "directiveId" | "revision" | "kind" | "baseCandidateRevision" | "protocolVersion" | "verificationPolicy">;
  report: Pick<ExecutionReport, "reportId" | "result" | "candidateMutated"> | null;
  /** Attempt protocol facts. */
  attemptId: string | null;
  attemptState: string | null;
  workerRole: "executor" | "verifier" | null;
  /** Real E5 invocation state ("finished" proves the E5 runtime ran it). */
  invocationState: string | null;
  attemptStartedAt: string;
  reportCreatedAt: string;
}

export interface VerificationPolicyState {
  windowId: string;
  candidateRevision: number;
  /** Greatest candidate revision with a qualifying NORMAL verification; 0 = none. */
  latestVerifiedRevision: number;
  unverifiedMutationSpan: number;
  maxUnverifiedMutations: number;
  verificationRequired: boolean;
  reason: VerificationDebtReason | null;
  /** The report (or directive) that created the debt, when applicable. */
  blockingReportRef: { reportId: string; directiveId: string; revision: number; baseCandidateRevision: number } | null;
  /** Report ids that currently count as qualifying NORMAL verification evidence. */
  normalVerificationReports: string[];
  /** True when the unverified span contains mutation under a policy-unknown v1 Directive. */
  legacyPolicyPresent: boolean;
}

/**
 * E8 §11 — does this fact count as completed independent NORMAL verification?
 * Directive.kind == verification; v2 purpose == normal (v1 history keeps its
 * frozen interpretation — its purpose is explicitly unknown and is never
 * backfilled, E8 §46); verifier role; real finished E5 invocation; completed,
 * non-mutating report. It verifies exactly the Directive's baseCandidateRevision.
 */
export function isQualifyingNormalVerification(fact: VerificationPolicyFact): boolean {
  if (fact.directive.kind !== "verification") return false;
  const policy = fact.directive.verificationPolicy;
  // v2 AND v3 carry the structured policy (E10 §20 — the E8 rules apply to
  // final-closure verifiers unchanged); a resolver is never candidate
  // verification. v1 history keeps its frozen interpretation — its purpose is
  // explicitly unknown and is never backfilled (E8 §46).
  if (fact.directive.protocolVersion >= 2 && policy?.verificationPurpose !== "normal") return false;
  return (
    fact.attemptState === "reported"
    && fact.workerRole === "verifier"
    && fact.invocationState === "finished"
    && fact.report !== null
    && fact.report.result === "completed"
    && !fact.report.candidateMutated
  );
}

/**
 * E8 §12–§19 — derive the deterministic verification-pressure state for one
 * Window at its CURRENT candidateRevision.
 *
 * Debt reasons, in precedence order (each fires whenever present in the
 * unverified span, regardless of span size — E8 §15/§17/§18):
 *   1. immediate             — a mutating immediate implementation Report
 *   2. unexpected_mutation   — a mutating inspection/verification Report
 *   3. legacy_policy_unknown — a mutating policy-unknown v1 implementation
 *   4. max_unverified_span   — span reached the frozen bound (E8 §14/§16)
 *
 * A qualifying NORMAL verification at the exact current revision clears ALL
 * debt (E8 §19) even with findings — insertion ≠ acceptance.
 */
export function deriveVerificationPolicyState(input: {
  windowId: string;
  candidateRevision: number;
  facts: VerificationPolicyFact[];
}): VerificationPolicyState {
  const normalVerificationReports: string[] = [];
  let immediateDebt: VerificationPolicyFact | null = null;
  let unexpectedDebt: VerificationPolicyFact | null = null;
  let legacyDebt: VerificationPolicyFact | null = null;
  let legacyPolicyPresent = false;

  // Pass 1 — the qualifying NORMAL verifications (E8 §11/§12): the greatest
  // base revision actually verified. 0 remains the span-arithmetic default —
  // no verification event is fabricated at revision 0 (E8 §12).
  let latestVerifiedRevision = 0;
  for (const fact of input.facts) {
    if (isQualifyingNormalVerification(fact) && fact.directive.baseCandidateRevision <= input.candidateRevision) {
      normalVerificationReports.push(fact.report!.reportId);
      latestVerifiedRevision = Math.max(latestVerifiedRevision, fact.directive.baseCandidateRevision);
    }
  }
  // Pass 2 — the debt facts. A mutating report at or below a REAL verified
  // revision is historical; with latestVerifiedRevision = 0 nothing has been
  // verified, so nothing is excluded yet.
  for (const fact of input.facts) {
    if (isQualifyingNormalVerification(fact)) {
      continue;
    }
    if (
      fact.report === null
      || fact.directive.baseCandidateRevision > input.candidateRevision
      || (latestVerifiedRevision > 0 && fact.directive.baseCandidateRevision <= latestVerifiedRevision)
    ) {
      continue;
    }
    if (!fact.report.candidateMutated) {
      continue;
    }
    const policy: DirectiveVerificationPolicy | null = fact.directive.verificationPolicy;
    if (fact.directive.kind === "implementation") {
      if (fact.directive.protocolVersion === 1) {
        legacyPolicyPresent = true;
        legacyDebt = legacyDebt ?? fact;
      } else if (policy?.implementationRequirement === "immediate") {
        immediateDebt = immediateDebt ?? fact;
      }
    } else {
      // inspection or verification mutating the candidate is ALWAYS unexpected
      // (E8 §17) — regardless of protocol version.
      unexpectedDebt = unexpectedDebt ?? fact;
    }
  }

  const unverifiedMutationSpan = input.candidateRevision - latestVerifiedRevision;
  let verificationRequired = false;
  let reason: VerificationDebtReason | null = null;
  let blockingReportRef: VerificationPolicyState["blockingReportRef"] = null;
  if (immediateDebt !== null) {
    verificationRequired = true;
    reason = "immediate";
  } else if (unexpectedDebt !== null) {
    verificationRequired = true;
    reason = "unexpected_mutation";
  } else if (legacyDebt !== null) {
    verificationRequired = true;
    reason = "legacy_policy_unknown";
  } else if (unverifiedMutationSpan >= MAX_UNVERIFIED_MUTATIONS) {
    verificationRequired = true;
    reason = "max_unverified_span";
  }
  const blockingFact = immediateDebt ?? unexpectedDebt ?? legacyDebt;
  if (blockingFact !== null && blockingFact.report !== null) {
    blockingReportRef = {
      reportId: blockingFact.report.reportId,
      directiveId: blockingFact.directive.directiveId,
      revision: blockingFact.directive.revision,
      baseCandidateRevision: blockingFact.directive.baseCandidateRevision,
    };
  }
  return {
    windowId: input.windowId,
    candidateRevision: input.candidateRevision,
    latestVerifiedRevision,
    unverifiedMutationSpan,
    maxUnverifiedMutations: MAX_UNVERIFIED_MUTATIONS,
    verificationRequired,
    reason,
    blockingReportRef,
    normalVerificationReports,
    legacyPolicyPresent,
  };
}
