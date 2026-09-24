/**
 * Commit chain snapshots — spec §10.
 *
 * Each PlanCommit materializes an immutable Snapshot of committed Plan Memory.
 * The Context Assembler reads authoritative state from HEAD, never from
 * conversation history. Phase 1 defines the shapes only; snapshot creation
 * happens inside the Phase 2 transaction engine.
 */
import type { CommitID, ConstraintID, DecisionID, PlanID, QuestionID, SnapshotID, SectionID } from "../core/ids.js";
import type { Timestamp } from "../core/refs.js";

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
}

export interface Snapshot {
  id: SnapshotID;
  planID: PlanID;
  /** The commit that produced this snapshot; null for the initial snapshot. */
  commit: CommitID | null;
  state: SnapshotState;
  createdAt: Timestamp;
}
