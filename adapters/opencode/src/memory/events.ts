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
  // Phase 2E2 — Harness-owned workflow focus transition (workflow state, not
  // a PlanCommit; automatic in-commit progression is auditable through
  // PlanCommit.changes instead).
  | { type: "run.active_work_changed"; from: import("../core/refs.js").WorkRef | undefined; to: import("../core/refs.js").WorkRef }
  | { type: "run.lifecycle_changed"; from: PlanningLifecycle; to: PlanningLifecycle }
  | { type: "runtime.activated"; mechanism: readonly string[]; unsupported: readonly string[] }
  | { type: "status.reported" }
  // Phase 2A.1 / 2B1 — approval + transaction audit trail
  | { type: "proposal.awaiting_approval"; proposalID: ProposalID; proposalHash: string }
  | { type: "proposal.rejected"; proposalID: ProposalID }
  | { type: "approval.recorded"; approvalID: ApprovalID; proposalID: ProposalID; proposalHash: string }
  | { type: "artifact.revised"; kind: "decision" | "section_revision" | "architecture" | "constraint" | "question" | "final_plan"; id: string; revision: number }
  // Phase 2D — initial Section DAG creation (root objects, not revisions)
  | { type: "section.added"; sectionID: import("../core/ids.js").SectionID; title: string; dependencies: import("../core/ids.js").SectionID[] }
  | { type: "question.resolved"; questionID: import("../core/ids.js").QuestionID; resolution: string }
  | { type: "transaction.committed"; commitID: CommitID; proposalID: ProposalID; approvalID: ApprovalID; snapshotID: SnapshotID }
  | { type: "head.moved"; from: CommitID | null; to: CommitID }
  // Phase 2F — derived synthesis artifacts (Harness-frozen workflow state,
  // never a PlanCommit; HEAD does not move for these).
  | { type: "synthesis.input_frozen"; inputID: import("../core/ids.js").SynthesisInputID; hash: string; baseSnapshot: string }
  | { type: "synthesis.manifest_saved"; manifestID: import("../core/ids.js").SynthesisManifestID; revision: number; inputID: import("../core/ids.js").SynthesisInputID; hash: string }
  // Phase 2G — semantic validation (a durable derived artifact; never a
  // PlanCommit, never HEAD movement). One event per actually-persisted report;
  // an idempotent anti-laundering replay emits nothing new. A findings report
  // and a clean report use the SAME event shape — result rides in the detail.
  | { type: "validation.report_saved"; reportID: import("../core/ids.js").ValidationReportID; result: "clean" | "findings"; inputID: import("../core/ids.js").SynthesisInputID; manifestID: import("../core/ids.js").SynthesisManifestID; manifestRevision: number; hash: string }
  // Phase 2H — finalization derived artifacts (same authority class: durable,
  // immutable, never a PlanCommit, never HEAD movement, no stage change). One
  // event per actually-persisted audit/candidate; an idempotent replay emits
  // nothing new. A blocked audit and a passing audit use the SAME audit event
  // shape — result and blocker count ride in the detail.
  | { type: "finalization.audit_saved"; auditID: import("../core/ids.js").EvidenceAuditID; result: "pass" | "blocked"; blockers: number; evidenceStateHash: string; hash: string }
  | { type: "finalization.candidate_saved"; candidateID: import("../core/ids.js").FinalPlanCandidateID; revision: number; auditID: import("../core/ids.js").EvidenceAuditID; hash: string }
  // Phase 2J — runtime handoff workflow events (NOT PlanCommits, §65). Emitted
  // only on the actual first durable transition of each state (§114) — an
  // idempotent recovery replay appends nothing.
  | { type: "handoff.prepared"; handoffID: import("../core/ids.js").HandoffID; finalPlan: string; deliveryKey: string }
  | { type: "handoff.dispatch_started"; handoffID: import("../core/ids.js").HandoffID; attempt: number; deliveryKey: string }
  | { type: "handoff.delivered"; handoffID: import("../core/ids.js").HandoffID; sessionID: string; messageID: string; deliveryKey: string };

export interface PlanEvent {
  /** 1-based sequence within the run. */
  seq: number;
  planID: PlanID;
  at: Timestamp;
  detail: PlanEventDetail;
}
