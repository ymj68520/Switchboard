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
  | "ContextTraceID";

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
