/**
 * Reference types linking planning artifacts together.
 *
 * Refs that point at *committed* design content carry an exact revision
 * (e.g. DecisionRef, SectionRevisionRef, FinalPlanRef). Refs that act as
 * "current position" pointers (SectionRef) resolve their revision through the
 * artifact record itself.
 */
import type {
  CommitID,
  ConflictID,
  ConstraintID,
  DecisionID,
  EvidenceID,
  FinalPlanID,
  ProposalID,
  QuestionID,
  SectionID,
  SnapshotID,
} from "./ids.js";

/** ISO-8601 timestamp string. Clocks are injected (controller/store) for determinism. */
export type Timestamp = string;

export interface ArchitectureRef {
  /** The Architecture singleton artifact; the spec pins its id to "ARCH". */
  id: "ARCH";
  revision: number;
}

export interface SectionRef {
  id: SectionID;
}

export interface SectionRevisionRef {
  id: SectionID;
  /** Exact revision — required wherever committed section content is referenced. */
  revision: number;
}

export interface DecisionRef {
  id: DecisionID;
  /** Exact revision — approved decisions are immutable, so a ref pins one revision. */
  revision: number;
}

export interface SnapshotRef {
  id: SnapshotID;
}

/** Spec §9.1 `createdFrom: MemorySnapshotRef`. */
export type MemorySnapshotRef = SnapshotRef;

export interface FinalPlanRef {
  id: FinalPlanID;
  revision: number;
}

export interface EvidenceRef {
  id: EvidenceID;
  revision?: number;
}

export interface ProposalRef {
  id: ProposalID;
  revision?: number;
}

/**
 * A reference to any first-class Plan Memory object. Used by conflicts,
 * proposals, and context traces. Refs pointing at committed content may carry
 * an exact revision; where present, the revision is normative.
 */
export type MemoryRef =
  | { kind: "architecture"; revision?: number }
  | { kind: "section"; id: SectionID; revision?: number }
  | { kind: "decision"; id: DecisionID; revision?: number }
  | { kind: "constraint"; id: ConstraintID }
  | { kind: "question"; id: QuestionID }
  | { kind: "conflict"; id: ConflictID }
  | { kind: "evidence"; id: EvidenceID; revision?: number }
  | { kind: "proposal"; id: ProposalID; revision?: number }
  | { kind: "snapshot"; id: SnapshotID }
  | { kind: "commit"; id: CommitID }
  | { kind: "final_plan"; id: FinalPlanID; revision?: number };

/**
 * The artifact the run is currently working on (PlanningRun.activeWork).
 * Mirrors the L1 run-state projection in spec §14.
 */
export type WorkRef =
  | { type: "architecture" }
  | { type: "section"; id: SectionID; title?: string };
