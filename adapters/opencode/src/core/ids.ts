/**
 * Canonical strongly-typed identifiers for Ultra Plan.
 *
 * IDs are branded opaque strings so that e.g. a DecisionID can never be passed
 * where a SectionID is expected. The runtime representation is the display
 * form (e.g. "PLAN-001", "DEC-014"), so `String(id)` is always the
 * human-visible identifier used in projections and status output.
 */

declare const brand: unique symbol;

export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type PlanID = Brand<string, "PlanID">;
export type ConstraintID = Brand<string, "ConstraintID">;
export type DecisionID = Brand<string, "DecisionID">;
export type SectionID = Brand<string, "SectionID">;
export type QuestionID = Brand<string, "QuestionID">;
export type ConflictID = Brand<string, "ConflictID">;
export type ProposalID = Brand<string, "ProposalID">;
export type ApprovalID = Brand<string, "ApprovalID">;
export type CommitID = Brand<string, "CommitID">;
export type SnapshotID = Brand<string, "SnapshotID">;
export type FinalPlanID = Brand<string, "FinalPlanID">;
export type EvidenceID = Brand<string, "EvidenceID">;
export type ObservationID = Brand<string, "ObservationID">;
export type ContextTraceID = Brand<string, "ContextTraceID">;
/**
 * Phase 2F — derived synthesis artifacts. These are NOT committed design:
 * Harness-frozen workflow artifacts anchored to exact HEAD state (see
 * synthesis/types.ts). "SYN-IN" for inputs, "SYN" for manifests (the short
 * prefix keeps manifest revisions readable: SYN-001@2).
 */
export type SynthesisInputID = Brand<string, "SynthesisInputID">;
export type SynthesisManifestID = Brand<string, "SynthesisManifestID">;
/**
 * Phase 2G — read-only semantic validation artifacts (see validation/types.ts).
 * Reports are "VAL-###"; findings inside a report are "VF-###" (Harness-assigned
 * per report — the validator never names them).
 */
export type ValidationReportID = Brand<string, "ValidationReportID">;
export type ValidationFindingID = Brand<string, "ValidationFindingID">;
/**
 * Phase 2H — finalization derived artifacts (see finalization/types.ts). The
 * Evidence Audit is "AUD-###" (one immutable id per distinct audited state);
 * the FinalPlanCandidate family is "FPC-###" with per-gate-identity revisions
 * (FPC-001@1, FPC-001@2, …) mirroring the SynthesisManifest revision model.
 */
export type EvidenceAuditID = Brand<string, "EvidenceAuditID">;
export type FinalPlanCandidateID = Brand<string, "FinalPlanCandidateID">;
/**
 * Phase 2J — the ExecutionHandoff derived artifact ("HANDOFF-###"). ONE
 * canonical handoff exists per approved FinalPlan (§16): recovery reuses the
 * same id forever — there is no HANDOFF-002 for the same plan.
 */
export type HandoffID = Brand<string, "HandoffID">;
/**
 * v0.2.0 supervised-execution foundation — the ExecutionRun ("EXEC-###").
 * Unlike HANDOFF ids (one per plan forever), EXEC ids are allocated per
 * ExecutionRun: the same FinalPlan may legitimately produce several runs over
 * its lifetime (spec v0.2.0 §9), while crash/retry of the SAME initial
 * handoff always recovers the SAME run (idempotency is by handoff identity,
 * never by call count).
 */
export type ExecutionRunID = Brand<string, "ExecutionRunID">;
/**
 * v0.2.0 Phase 3 — the ExecutionStage ("STAGE-###") and VerificationWindow
 * ("WIN-###"). Stage ids are never reused: a superseded Stage stays durable
 * under its original id forever, and any decomposition correction creates
 * NEW Stage ids.
 */
export type ExecutionStageID = Brand<string, "ExecutionStageID">;
export type VerificationWindowID = Brand<string, "VerificationWindowID">;
/**
 * v0.2.0 Phase 4 — the worker transaction protocol: ExecutionDirective
 * ("DIR-###", revised in place as DIR-###@N with every revision durable),
 * ExecutionAttempt ("ATT-###", one logical Attempt per exact Directive
 * revision), and the unified ExecutionReport ("RPT-###", one per Attempt).
 */
export type ExecutionDirectiveID = Brand<string, "ExecutionDirectiveID">;
export type ExecutionAttemptID = Brand<string, "ExecutionAttemptID">;
export type ExecutionReportID = Brand<string, "ExecutionReportID">;
/**
 * v0.2.0 Phase 5 — acceptance layer: SupervisorAssessment ("SA-###"), the
 * ExecutionCommit chain ("EC-###", linear per ExecutionRun), and Stage
 * completion obligation ids ("OBS-###", scoped to one Stage).
 */
export type SupervisorAssessmentID = Brand<string, "SupervisorAssessmentID">;
export type ExecutionCommitID = Brand<string, "ExecutionCommitID">;
export type StageCompletionObligationID = Brand<string, "StageCompletionObligationID">;
/**
 * v0.2.0 Phase 6A — the abnormal/escalation control plane: ExecutionIssue
 * ("ISS-###", the durable replan justification), VerificationConflict
 * ("VCF-###", one disputed fact), and AttemptReconciliation ("REC-###", the
 * durable resolution of indeterminate-Attempt uncertainty).
 */
export type ExecutionIssueID = Brand<string, "ExecutionIssueID">;
export type VerificationConflictID = Brand<string, "VerificationConflictID">;
export type AttemptReconciliationID = Brand<string, "AttemptReconciliationID">;
/**
 * v0.2.0 Phase 6B — the final-closure layer: the ExecutionCompletionRecord
 * ("CMPL-###", ONE per completed ExecutionRun — the durable provenance of the
 * ExecutionCompletionGate, exactly like ExecutionIssue is for replan).
 */
export type ExecutionCompletionID = Brand<string, "ExecutionCompletionID">;

/**
 * The Architecture artifact is a singleton per planning run; the frozen spec
 * pins its identifier to the literal "ARCH" (spec §5.3).
 */
export type ArchitectureID = "ARCH";

export type UltraPlanIDBrand =
  | "PlanID"
  | "ConstraintID"
  | "DecisionID"
  | "SectionID"
  | "QuestionID"
  | "ConflictID"
  | "ProposalID"
  | "ApprovalID"
  | "CommitID"
  | "SnapshotID"
  | "FinalPlanID"
  | "EvidenceID"
  | "ObservationID"
  | "ContextTraceID"
  | "SynthesisInputID"
  | "SynthesisManifestID"
  | "ValidationReportID"
  | "ValidationFindingID"
  | "EvidenceAuditID"
  | "FinalPlanCandidateID"
  | "HandoffID"
  | "ExecutionRunID"
  | "ExecutionStageID"
  | "VerificationWindowID"
  | "ExecutionDirectiveID"
  | "ExecutionAttemptID"
  | "ExecutionReportID"
  | "SupervisorAssessmentID"
  | "ExecutionCommitID"
  | "StageCompletionObligationID"
  | "ExecutionIssueID"
  | "VerificationConflictID"
  | "AttemptReconciliationID"
  | "ExecutionCompletionID";

export interface IDFactory<B extends UltraPlanIDBrand> {
  /** Canonical display prefix, e.g. "PLAN" for PLAN-001. */
  readonly prefix: string;
  /** Build an ID from a sequence number: 1 -> "PLAN-001". */
  from(seq: number): Brand<string, B>;
  /**
   * Re-brand an externally stored ID string. This performs no format
   * validation; it exists for hydrating persisted state, not for building new
   * identifiers at runtime.
   */
  cast(raw: string): Brand<string, B>;
}

export function formatID(prefix: string, seq: number): string {
  return `${prefix}-${String(seq).padStart(3, "0")}`;
}

function idFactory<B extends UltraPlanIDBrand>(prefix: string): IDFactory<B> {
  return {
    prefix,
    from(seq: number): Brand<string, B> {
      return formatID(prefix, seq) as Brand<string, B>;
    },
    cast(raw: string): Brand<string, B> {
      return raw as Brand<string, B>;
    },
  };
}

export const PlanIDs: IDFactory<"PlanID"> = idFactory("PLAN");
export const ConstraintIDs: IDFactory<"ConstraintID"> = idFactory("CON");
export const DecisionIDs: IDFactory<"DecisionID"> = idFactory("DEC");
export const SectionIDs: IDFactory<"SectionID"> = idFactory("SEC");
export const QuestionIDs: IDFactory<"QuestionID"> = idFactory("Q");
export const ConflictIDs: IDFactory<"ConflictID"> = idFactory("CONF");
export const ProposalIDs: IDFactory<"ProposalID"> = idFactory("PROP");
export const ApprovalIDs: IDFactory<"ApprovalID"> = idFactory("APPR");
export const CommitIDs: IDFactory<"CommitID"> = idFactory("COMMIT");
export const SnapshotIDs: IDFactory<"SnapshotID"> = idFactory("SNAP");
export const FinalPlanIDs: IDFactory<"FinalPlanID"> = idFactory("FINAL");
export const EvidenceIDs: IDFactory<"EvidenceID"> = idFactory("EVD");
export const ObservationIDs: IDFactory<"ObservationID"> = idFactory("OBS");
export const ContextTraceIDs: IDFactory<"ContextTraceID"> = idFactory("TRACE");
export const SynthesisInputIDs: IDFactory<"SynthesisInputID"> = idFactory("SYN-IN");
export const SynthesisManifestIDs: IDFactory<"SynthesisManifestID"> = idFactory("SYN");
export const ValidationReportIDs: IDFactory<"ValidationReportID"> = idFactory("VAL");
export const ValidationFindingIDs: IDFactory<"ValidationFindingID"> = idFactory("VF");
export const EvidenceAuditIDs: IDFactory<"EvidenceAuditID"> = idFactory("AUD");
export const FinalPlanCandidateIDs: IDFactory<"FinalPlanCandidateID"> = idFactory("FPC");
export const HandoffIDs: IDFactory<"HandoffID"> = idFactory("HANDOFF");
export const ExecutionRunIDs: IDFactory<"ExecutionRunID"> = idFactory("EXEC");
export const ExecutionStageIDs: IDFactory<"ExecutionStageID"> = idFactory("STAGE");
export const VerificationWindowIDs: IDFactory<"VerificationWindowID"> = idFactory("WIN");
export const ExecutionDirectiveIDs: IDFactory<"ExecutionDirectiveID"> = idFactory("DIR");
export const ExecutionAttemptIDs: IDFactory<"ExecutionAttemptID"> = idFactory("ATT");
export const ExecutionReportIDs: IDFactory<"ExecutionReportID"> = idFactory("RPT");
export const SupervisorAssessmentIDs: IDFactory<"SupervisorAssessmentID"> = idFactory("SA");
export const ExecutionCommitIDs: IDFactory<"ExecutionCommitID"> = idFactory("EC");
export const StageCompletionObligationIDs: IDFactory<"StageCompletionObligationID"> = idFactory("OBS");
export const ExecutionIssueIDs: IDFactory<"ExecutionIssueID"> = idFactory("ISS");
export const VerificationConflictIDs: IDFactory<"VerificationConflictID"> = idFactory("VCF");
export const AttemptReconciliationIDs: IDFactory<"AttemptReconciliationID"> = idFactory("REC");
export const ExecutionCompletionIDs: IDFactory<"ExecutionCompletionID"> = idFactory("CMPL");

/**
 * Next free sequence number for a `PREFIX-###` id family, given the ids
 * already in use. Deterministic (max + 1); used by the Harness when assigning
 * artifact ids so the model never names authoritative objects.
 */
export function nextSequence(existing: readonly string[], prefix: string): number {
  let max = 0;
  for (const raw of existing) {
    if (!raw.startsWith(`${prefix}-`)) continue;
    const seq = Number.parseInt(raw.slice(prefix.length + 1), 10);
    if (Number.isInteger(seq) && seq > max) max = seq;
  }
  return max + 1;
}
