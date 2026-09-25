/**
 * Commit chain snapshots — spec §10.
 *
 * Each PlanCommit materializes an immutable Snapshot of committed Plan Memory.
 * The Context Assembler reads authoritative state from HEAD, never from
 * conversation history. Phase 1 defines the shapes only; snapshot creation
 * happens inside the Phase 2 transaction engine.
 */
import type { CommitID, ConstraintID, DecisionID, PlanID, QuestionID, SnapshotID, SectionID } from "../core/ids.js";
import type { Timestamp, WorkRef } from "../core/refs.js";

/**
 * Materialized committed state at a point in history, as revision pointers.
 * Keyed by artifact id; values are the revision current at this snapshot.
 */
export interface SnapshotState {
  architectureRevision?: number;
  sectionRevisions: Record<SectionID, number>;
  decisionRevisions: Record<DecisionID, number>;
  constraintIDs: ConstraintID[];
  openQuestionIDs: QuestionID[];
  finalPlanRevision?: number;
  /**
   * Phase 2D: the committed Section DAG in CANONICAL ORDER, present even
   * before any SectionRevision exists (decomposition creates design scopes,
   * not designs — there are deliberately no fake revisions to represent the
   * graph). Additive and optional: snapshots created before Phase 2D simply
   * predate decomposition and legitimately carry no section roots — absence
   * is meaningful, not a default to be filled.
   */
  sectionRoots?: SectionRootSnapshot[];
  /**
   * Phase 2E2 (additive, optional): the workflow focus AFTER this commit —
   * the deterministic next Section following an ordinary completion, or the
   * initial focus of the decomposition commit. Absent means no active focus
   * (pre-decomposition snapshots, or the final completion that cleared the
   * focus and entered synthesis) — absence is meaningful, never backfilled.
   */
  activeWork?: WorkRef;
}

/**
 * Root-state projection of one committed Section (no revision content).
 * Phase 2E1 adds the checkpoint pointers additively: a root that has committed
 * SectionRevisions carries its current/approved revision numbers, while the
 * pre-checkpoint decomposition roots legitimately leave both undefined
 * (absence is meaningful, not a default to be filled). The exact revision
 * CONTENT is not duplicated here — `SnapshotState.sectionRevisions` maps each
 * section to its current exact SectionRevision reference.
 */
export interface SectionRootSnapshot {
  id: SectionID;
  title: string;
  objective: string;
  dependencies: SectionID[];
  status: "pending" | "active" | "awaiting_approval" | "approved" | "reopened";
  validation: "valid" | "needs_review";
  /** Phase 2E1: present once the root has at least one committed checkpoint. */
  currentRevision?: number;
  /** Phase 2E1: latest user-approved checkpoint — NOT Section completion. */
  approvedRevision?: number;
}

export interface Snapshot {
  id: SnapshotID;
  planID: PlanID;
  /** The commit that produced this snapshot; null for the initial snapshot. */
  commit: CommitID | null;
  state: SnapshotState;
  createdAt: Timestamp;
}
