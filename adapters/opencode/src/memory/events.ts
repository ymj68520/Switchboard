/**
 * Plan event log types — spec §12 ("Event Log" component of Plan Memory).
 *
 * The event log records state transitions of a PlanningRun. Events are
 * append-only; sequence numbers are assigned per run by the store. Phase 2B1
 * adds the transaction/approval events with recovery/audit meaning; failed
 * transactions intentionally append NOTHING (a failure must leave state —
 * including the event log — exactly unchanged; operational diagnostics are
 * logged outside transactional state).
 */
import type { ApprovalID, CommitID, PlanID, ProposalID, SnapshotID } from "../core/ids.js";
import type { PlanningLifecycle, PlanningStage } from "../core/types.js";
import type { Timestamp } from "../core/refs.js";

export type PlanEventDetail =
  | { type: "run.created"; sessionID: string }
  | { type: "run.resumed"; sessionID: string }
  | { type: "run.stage_changed"; from: PlanningStage; to: PlanningStage }
  | { type: "run.lifecycle_changed"; from: PlanningLifecycle; to: PlanningLifecycle }
  | { type: "runtime.activated"; mechanism: readonly string[]; unsupported: readonly string[] }
  | { type: "status.reported" }
  // Phase 2A.1 / 2B1 — approval + transaction audit trail
  | { type: "proposal.awaiting_approval"; proposalID: ProposalID; proposalHash: string }
  | { type: "proposal.rejected"; proposalID: ProposalID }
  | { type: "approval.recorded"; approvalID: ApprovalID; proposalID: ProposalID; proposalHash: string }
  | { type: "artifact.revised"; kind: "decision" | "section_revision" | "architecture" | "question"; id: string; revision: number }
  | { type: "question.resolved"; questionID: import("../core/ids.js").QuestionID; resolution: string }
  | { type: "transaction.committed"; commitID: CommitID; proposalID: ProposalID; approvalID: ApprovalID; snapshotID: SnapshotID }
  | { type: "head.moved"; from: CommitID | null; to: CommitID };

export interface PlanEvent {
  /** 1-based sequence within the run. */
  seq: number;
  planID: PlanID;
  at: Timestamp;
  detail: PlanEventDetail;
}
