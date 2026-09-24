/**
 * Proposal → Approval → PlanCommit transaction types.
 *
 * Phase 2B1 freezes the change vocabulary as a CLOSED discriminated union of
 * fully-resolved committed intents. Since 2A.1, the Harness assigns IDs and
 * resulting revision numbers AT PROPOSAL FREEZE, so the user approves exact
 * resulting objects (spec §35 invariant 10 — no HEAD-relative ambiguity, no
 * `content: unknown` in committed mutations, nothing filled in after
 * approval).
 */
import type {
  DecisionID,
  PlanID,
  ProposalID,
  QuestionID,
  SectionID,
} from "../core/ids.js";
import type {
  ArchitectureRef,
  DecisionRef,
  MemoryRef,
  MemorySnapshotRef,
  SectionRef,
  SectionRevisionRef,
  Timestamp,
} from "../core/refs.js";
import type {
  Decision,
  FailureMode,
  InterfaceRef,
  InterfaceSpec,
  OpenQuestion,
  Dependency,
  Section,
} from "../core/types.js";

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

/** Vocabulary of committed mutations. */
export type ProposalChangeKind =
  | "add_decision"
  | "amend_decision"
  | "amend_section"
  | "raise_question"
  | "resolve_question"
  | "complete_architecture"
  | "complete_section";

/**
 * Content of a NEW decision as approved. The Harness assigned id/revision at
 * freeze; `status` is frozen to "approved" with `approvedAt` set at freeze, so
 * the committed object is written VERBATIM at commit time (no regeneration).
 */
export type ApprovedDecision = Decision & { status: "approved"; approvedAt: Timestamp };

/**
 * Content of a NEW section revision as approved (an add via decomposition or
 * an amend). Frozen with sectionID/revision/status/createdAt assigned; written
 * verbatim at commit.
 */
export type ApprovedSectionRevision = {
  sectionID: SectionID;
  revision: number;
  status: "approved";
  problem: string;
  design: string;
  interfaces: InterfaceSpec[];
  invariants: string[];
  failureModes: FailureMode[];
  dependencies: Dependency[];
  decisions: DecisionID[];
  openQuestions: QuestionID[];
  impacts: SectionID[];
  projection: { compact: string; contract: SectionRevisionContract };
  createdAt: Timestamp;
};

export interface SectionRevisionContract {
  sectionID: SectionID;
  revision: number;
  provides: string[];
  requires: string[];
  invariants: string[];
  interfaces: InterfaceRef[];
  decisions: DecisionRef[];
}

/**
 * The authoritative resolution of an open question — the ONLY shape that may
 * perform `open → resolved`, applied exclusively inside a PlanCommit.
 */
export interface QuestionResolution {
  questionID: QuestionID;
  resolution: string;
  /** Optional decision linked as the basis of the resolution. */
  resolvedBy?: DecisionID;
}

/**
 * A frozen committed mutation. Every variant carries everything the commit
 * engine needs — it never asks the model (or anyone) for missing content.
 */
export type ProposalChange =
  | { kind: "add_decision"; decision: ApprovedDecision }
  | { kind: "amend_decision"; supersedes: DecisionRef; decision: ApprovedDecision }
  | { kind: "amend_section"; supersedes: SectionRevisionRef; revision: ApprovedSectionRevision }
  | { kind: "raise_question"; question: OpenQuestion }
  | { kind: "resolve_question"; resolution: QuestionResolution }
  | { kind: "complete_architecture"; target: ArchitectureRef }
  | { kind: "complete_section"; target: SectionRevisionRef };

/** Minimal section-revision content the model supplies; the Harness freezes the rest. */
export interface SectionRevisionDraft {
  problem: string;
  design: string;
  interfaces: InterfaceSpec[];
  invariants: string[];
  failureModes: FailureMode[];
  dependencies: Dependency[];
  decisions: DecisionID[];
  openQuestions: QuestionID[];
  impacts: SectionID[];
  compactProjection: string;
  contract: {
    provides: string[];
    requires: string[];
    invariants: string[];
    interfaces: InterfaceRef[];
    decisions: DecisionRef[];
  };
}

/** Minimal decision content the model supplies; the Harness freezes the rest. */
export interface DecisionDraft {
  title: string;
  statement: string;
  rationale: string;
  alternatives?: Decision["alternatives"];
  consequences?: string[];
  scope?: Decision["scope"];
  evidence?: Decision["evidence"];
}

/**
 * Record of what a PlanCommit actually applied, derived from the approved
 * changes by the engine (never supplied by the caller).
 */
export interface CommittedChange {
  kind: ProposalChangeKind;
  ref?: MemoryRef;
  resultingRevision?: number;
}

/** Spec §9.3 — approval binds to the exact immutable proposal revision via
 * revision + hash. "What the user approves is exactly what gets committed." */
export interface Approval {
  id: import("../core/ids.js").ApprovalID;

  proposalID: ProposalID;
  proposalRevision: number;
  proposalHash: string;

  actor: "user";
  createdAt: Timestamp;
}

/** Spec §9.4 — the ONLY mechanism that may mutate committed Plan Memory. */
export interface PlanCommit {
  id: import("../core/ids.js").CommitID;

  proposalID: ProposalID;
  approvalID: Approval["id"];

  parentCommit: import("../core/ids.js").CommitID | null;

  changes: CommittedChange[];
  resultingSnapshot: import("../core/ids.js").SnapshotID;

  createdAt: Timestamp;
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

  /**
   * Phase 2A extension: canonical content hash (SHA-256 over the approval
   * payload — see transaction/hash.ts). A user Approval binds to proposalID +
   * revision + this hash, making "what the user approves is exactly what gets
   * committed" verifiable.
   */
  hash?: string;
}

export type { PlanID, Section, SectionRef as SectionScopeRef };
