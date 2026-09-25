/**
 * Phase 2F — derived synthesis artifacts (frozen architecture §31; Phase 2F
 * brief §4-§6, §22, §25-§27, §31).
 *
 * AUTHORITY CLASS: everything in this module is a DERIVED artifact — a
 * Harness/model projection OVER committed Plan Memory, never new normative
 * design. SynthesisInput and SynthesisManifest are durable, immutable,
 * content-hashed, exact-ref-based, and auditable, but their creation does NOT
 * require Proposal → Approval → PlanCommit and must never move HEAD (brief
 * §4/§48/§49). The shapes are the smallest coherent v0.1 the frozen
 * architecture supports: ImplementationStep/DerivedStatement/ValidationFinding
 * are referenced but not defined by the spec, so they are frozen here in
 * minimal form (brief §2) instead of a large synthesis DSL.
 */
import type {
  CommitID,
  ConflictID,
  ConstraintID,
  DecisionID,
  EvidenceID,
  PlanID,
  QuestionID,
  SectionID,
  SynthesisInputID,
  SynthesisManifestID,
} from "../core/ids.js";
import type {
  ArchitectureRef,
  DecisionRef,
  SnapshotRef,
  Timestamp,
} from "../core/refs.js";
import type { Constraint } from "../core/types.js";

/**
 * Exact provenance source a derived statement may cite (brief §25/§33).
 * Every form is EXACT — sections/decisions/evidence carry mandatory revisions;
 * constraint/question/conflict are identity-only domain objects, so the id IS
 * the exact reference. Only refs inside the frozen SynthesisInput authority
 * set resolve (findings may additionally cite blockers raised after the
 * freeze — brief §53).
 */
export type SynthesisSourceRef =
  | { kind: "architecture" }
  | { kind: "section"; id: SectionID; revision: number }
  | { kind: "decision"; id: DecisionID; revision: number }
  | { kind: "constraint"; id: ConstraintID }
  | { kind: "question"; id: QuestionID }
  | { kind: "conflict"; id: ConflictID }
  | { kind: "evidence"; id: EvidenceID; revision: number };

/** A derived statement: approved-design organization that MUST cite exact sources. */
export interface DerivedStatement {
  statement: string;
  sources: SynthesisSourceRef[];
}

/**
 * One step of the derived implementation order. `order` is HARNESS-assigned
 * from array position (brief §27) — the model never supplies a sequence
 * number. A Section may legitimately participate in several steps (brief §28).
 */
export interface ImplementationStep {
  order: number;
  title: string;
  description: string;
  sections: { id: SectionID; revision: number }[];
  sources: SynthesisSourceRef[];
}

/**
 * v0.1 finding categories a synthesis manifest may report (brief §31). These
 * are SYNTHESIS-side categories only — the independent semantic validator
 * (Phase 2G) owns the full report vocabulary (unsupported_new_fact,
 * incorrect_derivation, clean); they are deliberately not unified here.
 */
export const SYNTHESIS_FINDING_CATEGORIES = [
  "contradiction",
  "missing_design",
  "missing_dependency",
  "coverage_gap",
] as const;
export type SynthesisFindingCategory = (typeof SYNTHESIS_FINDING_CATEGORIES)[number];

/** Smallest v0.1 ValidationFinding: a detector/report, never a design mutation (brief §32). */
export interface ValidationFinding {
  category: SynthesisFindingCategory;
  statement: string;
  /** Exact provenance where applicable (brief §31); findings may also cite blockers raised after the freeze. */
  sources?: SynthesisSourceRef[];
}

/** Frozen copy of a Question's state at freeze time (brief §14) — may be unresolved. */
export interface FrozenQuestionState {
  id: QuestionID;
  question: string;
  blocking: boolean;
  status: "open" | "resolved";
}

/** Frozen copy of a Conflict's state at freeze time (brief §14) — may be unresolved. */
export interface FrozenConflictState {
  id: ConflictID;
  type: "decision" | "constraint" | "section" | "interface";
  description: string;
  severity: "warning" | "blocking";
  status: "open" | "resolved";
}

/**
 * Frozen Evidence state for records structurally reachable through the one
 * chain the domain represents — Architecture / SectionRevision → Decisions →
 * Evidence refs (brief §15). Exact revision plus the state later reasoning
 * needs. This is NOT the global Evidence Audit (spec §30).
 */
export interface FrozenEvidenceState {
  id: EvidenceID;
  revision: number;
  confidence: "direct" | "derived" | "uncertain";
  criticality: "critical" | "supporting" | "informational";
  freshness: "fresh" | "needs_validation" | "stale";
  status: "active" | "stale" | "invalidated";
}

/** One approved Section bound into a SynthesisInput: exact revision + DAG position. */
export interface FrozenSectionState {
  ref: { id: SectionID; revision: number };
  title: string;
  /** Structural dependencies of the Section root (drives implementation-order validation, brief §29). */
  dependencies: SectionID[];
}

/**
 * The pre-identity authority payload the Harness freezes into a
 * SynthesisInput. This exact object is the canonical hash payload (see
 * synthesis/hash.ts): id, createdAt, and hash are excluded so that freezing
 * the same authoritative state twice is byte-identical (brief §16/§17).
 */
export interface SynthesisInputPayload {
  planID: PlanID;
  baseSnapshot: SnapshotRef;
  /** The commit that produced the base snapshot; null for the initial snapshot. */
  baseCommit: CommitID | null;
  architecture: ArchitectureRef;
  /** Exact approved revision per required Section, canonical DAG order (brief §9). */
  sections: FrozenSectionState[];
  /** Exact committed Decision revisions represented by HEAD (brief §12). */
  decisions: DecisionRef[];
  /**
   * Committed Constraints only — frozen copies of the records HEAD binds
   * (constraints are identity-only in the domain; no revisions are invented,
   * brief §13).
   */
  constraints: Constraint[];
  questions: FrozenQuestionState[];
  conflicts: FrozenConflictState[];
  evidence: FrozenEvidenceState[];
}

/**
 * The frozen synthesis authority anchor (brief §6/§7): built from the exact
 * HEAD Snapshot, immutable, content-hashed, never mutated (brief §42).
 * `hash` covers the complete authority payload EXCLUDING id/createdAt/hash
 * itself (brief §16) so identical authoritative state produces an identical
 * hash and freeze is idempotent.
 */
export interface SynthesisInput {
  id: SynthesisInputID;
  planID: PlanID;
  baseSnapshot: SnapshotRef;
  baseCommit: CommitID | null;
  architecture: ArchitectureRef;
  sections: FrozenSectionState[];
  decisions: DecisionRef[];
  constraints: Constraint[];
  questions: FrozenQuestionState[];
  conflicts: FrozenConflictState[];
  evidence: FrozenEvidenceState[];
  createdAt: Timestamp;
  hash: string;
}

/** Harness-level draft the controller hands to the store after structural validation. */
export interface SynthesisManifestDraft {
  inputID: SynthesisInputID;
  crossSectionLinks: DerivedStatement[];
  implementationOrder: { title: string; description: string; sections: { id: SectionID; revision: number }[]; sources: SynthesisSourceRef[] }[];
  limitations: DerivedStatement[];
  unresolvedFindings: ValidationFinding[];
}

/**
 * The immutable derived synthesis output (brief §22). Deliberately carries NO
 * authority fields (approved/final/handoff/validation-passed — brief §23/§35)
 * and no model-supplied identity: id/revision/input binding/refs/hash are all
 * Harness-assigned. `hash` covers the derived content payload EXCLUDING
 * id/revision/createdAt/hash (brief §38) so exact resubmission is idempotent
 * (brief §37).
 */
export interface SynthesisManifest {
  id: SynthesisManifestID;
  /** Harness-assigned; 1..n contiguous per id; prior revisions stay immutable (brief §36). */
  revision: number;
  input: { id: SynthesisInputID };
  baseSnapshot: SnapshotRef;
  inputHash: string;
  architecture: ArchitectureRef;
  sections: FrozenSectionState[];
  crossSectionLinks: DerivedStatement[];
  implementationOrder: ImplementationStep[];
  limitations: DerivedStatement[];
  unresolvedFindings: ValidationFinding[];
  createdAt: Timestamp;
  hash: string;
}
