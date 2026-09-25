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
  Architecture,
  Component,
  Boundary,
  DataFlow,
  Principle,
  Constraint,
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
  | "add_section_revision"
  | "amend_section"
  | "add_architecture"
  | "add_constraint"
  | "add_section"
  | "select_initial_section"
  | "raise_question"
  | "resolve_question"
  | "complete_architecture"
  | "complete_section"
  /**
   * Phase 2G — sanctioned Section reopen (brief §40). NOT part of the generic
   * `ultraplan_prepare_proposal` vocabulary: only the narrow
   * `ultraplan_request_reopen` operation freezes it, binding the exact target
   * SectionRevision, the exact semantic-validation report (id + hash + finding
   * ids) or the dependency-review state. Applied only by a user-approved
   * `amendment` PlanCommit.
   */
  | "reopen_section"
  /**
   * Phase 2I — the Final PlanCommit mutation (brief §5). Legal ONLY inside
   * `Proposal.type = "final_plan"` (and a final_plan Proposal carries exactly
   * one), and NOT part of the generic model-facing proposal vocabulary: the
   * only entry path is the dedicated `ultraplan_prepare_final_plan` operation,
   * which freezes the complete exact resulting FinalPlan payload projected
   * from the current FinalPlanCandidate (no model-authored content).
   */
  | "add_final_plan";

/**
 * Why a Section is being reopened (Phase 2G brief §40). `semantic_validation`
 * binds the EXACT ValidationReport (id + hash) and the exact finding ids the
 * user authorizes; `dependency_review` binds the invalidated Section state for
 * the detail-stage review loop (brief §49/§50).
 */
export type ReopenSectionReason =
  | {
      type: "semantic_validation";
      reportID: import("../core/ids.js").ValidationReportID;
      reportHash: string;
      findingIDs: import("../core/ids.js").ValidationFindingID[];
    }
  | { type: "dependency_review"; validation: Section["validation"] };

/**
 * Content of a NEW decision as approved. The Harness assigned id/revision at
 * freeze; `status` is frozen to "approved" with `approvedAt` set at freeze, so
 * the committed object is written VERBATIM at commit time (no regeneration).
 */
export type ApprovedDecision = Decision & { status: "approved"; approvedAt: Timestamp };

/**
 * Content of a NEW section revision as approved. Frozen with
 * sectionID/revision/status/createdAt assigned; written verbatim at commit.
 *
 * Two frozen paths exist (Phase 2E1, protocol §6): `add_section_revision` is
 * the FIRST checkpoint of a revision-less Section (resulting revision 1);
 * `amend_section` is every later checkpoint, bound to the exact superseded
 * revision. Both carry the complete SectionRevision including its contract
 * projection — the user approves full design + compact projection + contract
 * as one payload.
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
 * Content of the INITIAL Architecture revision as approved (Phase 2C). The
 * Harness assigns id="ARCH", revision, and the resulting refs at Proposal
 * freeze time; `status` is frozen to "approved" so the commit writes the exact
 * approved object VERBATIM — no architecture content is generated or rewritten
 * during commit. The initial path is `ARCH@1`; amendment/reopen of an existing
 * Architecture is later-phase work and `add_architecture` is rejected when a
 * committed Architecture already exists.
 */
export type ApprovedArchitecture = Architecture & { id: "ARCH"; status: "approved" };

/**
 * Content of a NEW committed constraint as approved (Phase 2C constraint
 * authority resolution). The Harness assigns the id at freeze; `status` is
 * frozen to "active". Model-inferred constraints never become authoritative
 * through working state — only this approved, committed shape is Plan Memory.
 */
export type ApprovedConstraint = Constraint & { status: "active" };

/**
 * Content of a NEW Section ROOT as approved (Phase 2D initial decomposition).
 * The Harness assigns the authoritative SEC id at freeze; workflow values are
 * Harness-assigned (`status: "pending"`, `validation: "valid"`, no revisions)
 * — decomposition creates design SCOPES, never designs (no SectionRevision,
 * no SectionContract). Dependency edges are exact SectionIDs, resolved from
 * draft-local keys at freeze.
 */
export type ApprovedSectionRoot = Section & {
  status: "pending";
  validation: "valid";
  currentRevision?: undefined;
  approvedRevision?: undefined;
};

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
  | {
      kind: "add_section_revision";
      revision: ApprovedSectionRevision;
    }
  | { kind: "amend_section"; supersedes: SectionRevisionRef; revision: ApprovedSectionRevision }
  | { kind: "add_architecture"; architecture: ApprovedArchitecture }
  | { kind: "add_constraint"; constraint: ApprovedConstraint }
  | { kind: "add_section"; section: ApprovedSectionRoot }
  | { kind: "select_initial_section"; section: SectionRef }
  | { kind: "raise_question"; question: OpenQuestion }
  | { kind: "resolve_question"; resolution: QuestionResolution }
  | { kind: "complete_architecture"; target: ArchitectureRef }
  | {
      kind: "complete_section";
      /**
       * Phase 2E2: the EXACT current approved checkpoint (SectionRevisionRef).
       * There is no "complete latest" resolution — the exact revision is bound
       * at freeze and inside the Proposal hash; the engine independently
       * re-validates it against staged state.
       */
      target: SectionRevisionRef;
      /**
       * Harness-captured deterministic state projection at freeze (brief §33):
       * identity/presentation metadata for the approval view — NOT design
       * content. The completion authorizes no design facts; the committed
       * revision and its contract stay immutable and are never re-approved.
       */
      completion?: {
        sectionTitle: string;
        validation: Section["validation"];
        dependencies: { id: SectionID; status: Section["status"] }[];
      };
    }
  | {
      kind: "reopen_section";
      /**
       * Phase 2G §40/§44: the EXACT approved revision being reopened
       * (Harness-resolved — the model never supplies it). The reopen creates
       * NO new revision; pointers are unchanged; the approved revision and its
       * contract stay immutable (§45).
       */
      target: SectionRevisionRef;
      reason: ReopenSectionReason;
      /**
       * Harness-captured deterministic projection at freeze for the approval
       * view (§43) — identity/state metadata only, never design content and
       * never model-generated prose after the freeze.
       */
      reopen: {
        sectionTitle: string;
        validation: Section["validation"];
        fromStage: import("../core/types.js").PlanningRun["stage"];
        /** Freeze-captured summary of each cited finding (semantic_validation only). */
        findings?: { id: string; category: string; statement: string }[];
      };
    }
  | {
      kind: "add_final_plan";
      /**
       * Phase 2I §5/§15: the COMPLETE exact resulting semantic FinalPlan
       * payload, projected from the bound FinalPlanCandidate by the shared
       * `buildFinalPlanFromCandidate` at freeze. `approvedAt` is deliberately
       * absent — the Proposal freezes every SEMANTIC field; approvedAt is
       * system transaction metadata (= the exact user Approval's createdAt),
       * stamped by the engine at commit (brief §15's narrow exception to
       * freeze-time exactness). `status` is frozen as the committed "approved"
       * by construction: only the commit creates the record.
       */
      finalPlan: import("../finalization/plan.js").FinalPlanContent;
    };

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

/**
 * Typed Architecture input contract (Phase 2C, protocol §6): the model's
 * proposed top-level design in closed shapes. The Harness validates the
 * shapes, resolves `unresolvedQuestionIDs` against recorded open questions and
 * `basedOn` against committed decisions, and freezes the rest.
 */
export interface ArchitectureDraft {
  summary: string;
  components: Component[];
  boundaries: Boundary[];
  dataFlows: DataFlow[];
  principles: Principle[];
  /** Ids of run open questions carried into `Architecture.unresolved` verbatim. */
  unresolvedQuestionIDs?: QuestionID[];
  /** Committed decisions the design stands on (`Architecture.basedOn`). */
  basedOn?: DecisionID[];
}

/** Minimal constraint content the model supplies; the Harness freezes the rest. */
export interface ConstraintDraft {
  statement: string;
  source: Constraint["source"];
  severity: Constraint["severity"];
}

/**
 * Draft-local decomposition input (Phase 2D). `key` is PROPOSAL-DRAFT-LOCAL
 * only — it exists so dependency edges and the initial focus can be expressed
 * before authoritative identities exist; the Harness resolves every key to an
 * exact `SEC-###` at freeze time and the draft key is never persisted as an
 * authoritative identity.
 */
export interface SectionDecompositionDraft {
  key: string;
  title: string;
  objective: string;
  /** Draft-local keys of the sections this scope depends on (no cycles). */
  dependsOn?: string[];
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
