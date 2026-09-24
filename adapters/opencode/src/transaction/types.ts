/**
 * Proposal → Approval → Commit transaction types — spec §9-§11.
 *
 * Phase 1 establishes the canonical shapes only. The transaction ENGINE
 * (validation, atomic apply, snapshot creation) is Phase 2; see
 * PlanStore.commitTransaction. ProposalChange/CommittedChange `content` is
 * intentionally coarse until the Planning Agent Protocol + Tool Contract layer
 * (spec §38) freezes the change vocabulary.
 */
import type {
  ApprovalID,
  CommitID,
  DecisionID,
  ProposalID,
  SectionID,
  SnapshotID,
} from "../core/ids.js";
import type {
  ArchitectureRef,
  MemoryRef,
  MemorySnapshotRef,
  SectionRef,
  Timestamp,
} from "../core/refs.js";

export type ProposalType =
  | "design_checkpoint"
  | "architecture_completion"
  | "section_completion"
  | "amendment"
  | "final_plan";

export type ProposalStatus =
  | "draft"
  | "ready"
  | "awaiting_approval"
  | "approved"
  | "rejected"
  | "superseded";

/**
 * The atomic change vocabulary of a proposal. `content` carries the working
 * design payload; its exact per-kind shape is fixed by the Phase 2 planning
 * agent tool contract, so it is typed `unknown` here rather than loosely
 * invented.
 */
export type ProposalChangeKind =
  | "add_architecture"
  | "amend_architecture"
  | "complete_architecture"
  | "add_section"
  | "amend_section"
  | "complete_section"
  | "add_decision"
  | "amend_decision"
  | "raise_question"
  | "resolve_question"
  | "raise_conflict"
  | "resolve_conflict"
  | "add_constraint"
  | "supersede_constraint"
  | "finalize_plan";

export interface ProposalChange {
  kind: ProposalChangeKind;
  ref?: MemoryRef;
  content: unknown;
}

/** Minimal Phase 1 shape — spec references ImpactAnalysis but does not define it. */
export interface ImpactAnalysis {
  affectedSections: SectionID[];
  affectedDecisions: DecisionID[];
  notes?: string;
}

/** Spec §9.1 — the atomic approval unit. */
export interface Proposal {
  id: ProposalID;

  type: ProposalType;

  scope: ArchitectureRef | SectionRef;

  revision: number;

  status: ProposalStatus;

  title: string;
  summary: string;

  changes: ProposalChange[];
  dependencies: MemoryRef[];
  impact: ImpactAnalysis;

  createdFrom: MemorySnapshotRef;
}

/**
 * Spec §9.3 — approval binds to the exact immutable proposal revision via
 * revision + hash. "What the user approves is exactly what gets committed."
 */
export interface Approval {
  id: ApprovalID;

  proposalID: ProposalID;
  proposalRevision: number;
  proposalHash: string;

  actor: "user";
  createdAt: Timestamp;
}

/** Committed counterpart of ProposalChange, produced by the transaction engine. */
export interface CommittedChange {
  kind: ProposalChangeKind;
  ref?: MemoryRef;
  resultingRevision?: number;
}

/** Spec §9.4 — the ONLY mechanism that may mutate committed Plan Memory. */
export interface PlanCommit {
  id: CommitID;

  proposalID: ProposalID;
  approvalID: ApprovalID;

  parentCommit: CommitID | null;

  changes: CommittedChange[];
  resultingSnapshot: SnapshotID;

  createdAt: Timestamp;
}
