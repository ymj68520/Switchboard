/**
 * Canonical core domain model — PlanningRun and its working artifacts.
 *
 * Translated from the frozen architecture specification (docs/opencode/spec/
 * opencode-ultra-plan-architecture.md §4-§8). Support types that the spec
 * references but does not define (Goal, WorkRef shape, Component, Boundary,
 * DataFlow, Principle, InterfaceSpec, FailureMode, Dependency, Alternative)
 * are defined here in minimal form and flagged; refining them is part of the
 * "Planning Agent Protocol + Tool Contract" layer the spec leaves open (§38).
 */
import type {
  ArchitectureID,
  CommitID,
  ConflictID,
  ConstraintID,
  DecisionID,
  PlanID,
  QuestionID,
  SectionID,
  SnapshotID,
} from "./ids.js";
import type {
  ArchitectureRef,
  DecisionRef,
  EvidenceRef,
  FinalPlanRef,
  MemoryRef,
  SectionRef,
  Timestamp,
  WorkRef,
} from "./refs.js";

/** Spec §4 — execution is deliberately NOT a planning stage. */
export const PLANNING_STAGES = ["discovery", "architecture", "detail", "synthesis", "final"] as const;
export type PlanningStage = (typeof PLANNING_STAGES)[number];

/**
 * Spec §4 lifecycle union names three values, but §4.1/§33 and invariant 20
 * require `handoff_pending` (recoverable final handoff). Included here; see
 * the Phase 1 report ("Deviations From Frozen Spec").
 */
export const PLANNING_LIFECYCLES = ["active", "handoff_pending", "completed", "aborted"] as const;
export type PlanningLifecycle = (typeof PLANNING_LIFECYCLES)[number];

/** Spec references `goal: Goal` but never defines it; minimal Phase 1 shape. */
export interface Goal {
  statement: string;
}

/**
 * The planning run — spec §4 verbatim, plus the `handoff_pending` lifecycle
 * value documented above.
 */
export interface PlanningRun {
  id: PlanID;
  sessionID: string;

  lifecycle: PlanningLifecycle;
  stage: PlanningStage;

  /** Bumped on every persisted header mutation (see PlanStore.saveRun). */
  revision: number;
  activeWork?: WorkRef;

  goal: Goal;
  constraints: Constraint[];

  architecture?: ArchitectureRef;
  sections: SectionRef[];
  decisions: DecisionRef[];

  openQuestions: OpenQuestion[];
  conflicts: Conflict[];

  finalPlan?: FinalPlanRef;

  headCommit?: CommitID;
  headSnapshot?: SnapshotID;

  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/** Spec §5.1 — conditions the design must satisfy. */
export interface Constraint {
  id: ConstraintID;
  source: "user" | "repository" | "environment" | "runtime";
  statement: string;
  severity: "hard" | "soft";
  status: "active" | "superseded";
}

/** Referenced by Decision.alternatives; not defined by the spec. */
export interface Alternative {
  description: string;
  rejectedBecause?: string;
}

/** Spec §5.2 — atomic units of durable design knowledge. */
export interface Decision {
  id: DecisionID;
  revision: number;

  title: string;
  status: "proposed" | "approved" | "superseded";

  statement: string;
  rationale: string;

  alternatives?: Alternative[];
  consequences?: string[];

  scope: {
    architecture?: boolean;
    sections?: SectionID[];
  };

  evidence?: EvidenceRef[];
  supersedes?: DecisionRef;
  approvedAt?: Timestamp;
}

/** Spec §5.3 — approved top-level design snapshot. */
export interface Architecture {
  id: ArchitectureID;
  revision: number;

  status: "draft" | "awaiting_approval" | "approved" | "superseded";

  summary: string;

  components: Component[];
  boundaries: Boundary[];
  dataFlows: DataFlow[];
  principles: Principle[];

  unresolved: OpenQuestion[];
  basedOn: DecisionID[];
}

/** Minimal Phase 1 shape — spec does not define Component. */
export interface Component {
  name: string;
  summary: string;
}

/** Minimal Phase 1 shape — spec does not define Boundary. */
export interface Boundary {
  name: string;
  description: string;
}

/** Minimal Phase 1 shape — spec does not define DataFlow. */
export interface DataFlow {
  from: string;
  to: string;
  description: string;
}

/** Minimal Phase 1 shape — spec does not define Principle. */
export interface Principle {
  statement: string;
}

/** Spec §6 — node of the project-specific Section DAG. */
export interface Section {
  id: SectionID;
  title: string;
  objective: string;

  dependencies: SectionID[];

  status: "pending" | "active" | "awaiting_approval" | "approved" | "reopened";
  validation: "valid" | "needs_review";

  currentRevision?: number;
  approvedRevision?: number;
}

/** Minimal Phase 1 shape — spec references InterfaceSpec but does not define it. */
export interface InterfaceSpec {
  name: string;
  description: string;
  signature?: string;
}

/** Reference to an interface provided by an approved section contract. */
export interface InterfaceRef {
  name: string;
  providedBy?: SectionID;
}

/** Minimal Phase 1 shape — spec references FailureMode but does not define it. */
export interface FailureMode {
  description: string;
  mitigation?: string;
}

/** Minimal Phase 1 shape — spec references Dependency (§6.1) but does not define it. */
export interface Dependency {
  sectionID: SectionID;
  /** What this revision consumes from the dependency (contract `provides` names). */
  consumes: string[];
}

/** Spec §6.1 — immutable content revision of a section. */
export interface SectionRevision {
  sectionID: SectionID;
  revision: number;

  status: "draft" | "awaiting_approval" | "approved" | "superseded";

  problem: string;
  design: string;

  interfaces: InterfaceSpec[];
  invariants: string[];
  failureModes: FailureMode[];
  dependencies: Dependency[];

  decisions: DecisionID[];
  openQuestions: QuestionID[];
  impacts: SectionID[];

  projection: {
    compact: string;
    contract: SectionContract;
  };

  createdAt: Timestamp;
}

/** Spec §6.2 — immutable contract projection of an approved section. */
export interface SectionContract {
  sectionID: SectionID;
  revision: number;

  provides: string[];
  requires: string[];

  invariants: string[];
  interfaces: InterfaceRef[];
  decisions: DecisionRef[];
}

/** Spec §7 — first-class planning object; blocking questions prevent finalization. */
export interface OpenQuestion {
  id: QuestionID;
  question: string;
  blocking: boolean;

  scope: ArchitectureRef | SectionRef;

  status: "open" | "resolved";
  resolution?: string;
  resolvedBy?: DecisionID;

  /**
   * Phase 2A.1 (Correction A): CANDIDATE resolution recorded by the planning
   * model. Never authorizes the open → resolved transition — the question
   * remains blocking until a Proposal containing `resolve_question` is
   * approved and applied by a PlanCommit, which moves this value into
   * `resolution`/`resolvedBy`.
   */
  proposedResolution?: { text: string; proposedAt: Timestamp };
}

/** Spec §7 — first-class conflict; blocking conflicts prevent finalization. */
export interface Conflict {
  id: ConflictID;

  type: "decision" | "constraint" | "section" | "interface";

  refs: MemoryRef[];
  description: string;

  severity: "warning" | "blocking";
  status: "open" | "resolved";

  resolution?: {
    action: "revise_proposal" | "amend_decision" | "amend_architecture";
    ref: MemoryRef;
  };
}
