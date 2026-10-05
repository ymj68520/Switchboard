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
  | { type: "handoff.delivered"; handoffID: import("../core/ids.js").HandoffID; sessionID: string; messageID: string; deliveryKey: string }
  // v0.2.0 Phase 1 — ExecutionRun foundation events on the source plan's log
  // (workflow state, NOT PlanCommits: no HEAD movement, no FinalPlan change).
  // `execution.run_prepared` fires only on the actual first durable creation —
  // an idempotent handoff-identity replay appends nothing.
  | { type: "execution.run_prepared"; executionRunID: import("../core/ids.js").ExecutionRunID; finalPlan: string; initialHandoffKey: string }
  | { type: "execution.run_lifecycle_changed"; executionRunID: import("../core/ids.js").ExecutionRunID; from: import("../core/execution-run.js").ExecutionLifecycle; to: import("../core/execution-run.js").ExecutionLifecycle }
  // v0.2.0 Phase 2 — supervisor ownership audit. ONE event type + reason
  // carries old/new owner+generation with enough information to audit every
  // attach/reattach/detach/takeover — never a full Recovery Context.
  | { type: "execution.supervisor_binding_changed"; executionRunID: import("../core/ids.js").ExecutionRunID; reason: "attached" | "reattached" | "detached" | "taken_over"; from?: { ownerSessionID: string; generation: number }; to: { ownerSessionID: string; generation: number; state: import("../core/supervisor-binding.js").SupervisorBindingState } }
  // v0.2.0 Phase 3 — ExecutionStage / VerificationWindow audit events
  // (workflow state, NOT PlanCommits: no HEAD movement, no Plan Memory
  // change). Enough provenance to audit every structural transition; never a
  // full Recovery Context.
  | { type: "execution.stage_created"; executionRunID: import("../core/ids.js").ExecutionRunID; stageID: import("../core/ids.js").ExecutionStageID; title: string; dependsOn: readonly string[] }
  | { type: "execution.stage_activated"; executionRunID: import("../core/ids.js").ExecutionRunID; stageID: import("../core/ids.js").ExecutionStageID; runRevision: number; stageRevision: number }
  | { type: "execution.stage_superseded"; executionRunID: import("../core/ids.js").ExecutionRunID; stageID: import("../core/ids.js").ExecutionStageID; stageRevision: number }
  | { type: "execution.window_opened"; executionRunID: import("../core/ids.js").ExecutionRunID; windowID: import("../core/ids.js").VerificationWindowID; stageID: import("../core/ids.js").ExecutionStageID; baseAcceptedState: string }
  | { type: "execution.window_candidate_advanced"; executionRunID: import("../core/ids.js").ExecutionRunID; windowID: import("../core/ids.js").VerificationWindowID; from: number; to: number }
  // v0.2.0 Phase 4 — worker transaction protocol events. `attempt_reported`
  // carries the report ref + provenance (one event instead of a redundant
  // attempt/report pair, per the Phase 4 directive's event-economy rule).
  | { type: "execution.directive_issued"; executionRunID: import("../core/ids.js").ExecutionRunID; directiveID: import("../core/ids.js").ExecutionDirectiveID; revision: number; kind: string; baseCandidateRevision: number; hash: string }
  | { type: "execution.attempt_started"; executionRunID: import("../core/ids.js").ExecutionRunID; attemptID: import("../core/ids.js").ExecutionAttemptID; directive: string; workerRole: string }
  | { type: "execution.attempt_reported"; executionRunID: import("../core/ids.js").ExecutionRunID; attemptID: import("../core/ids.js").ExecutionAttemptID; reportID: import("../core/ids.js").ExecutionReportID; directive: string; result: string; candidateMutation: string; resultingCandidateRevision: number }
  | { type: "execution.attempt_indeterminate"; executionRunID: import("../core/ids.js").ExecutionRunID; attemptID: import("../core/ids.js").ExecutionAttemptID; directive: string }
  | { type: "execution.unexpected_candidate_mutation"; executionRunID: import("../core/ids.js").ExecutionRunID; attemptID: import("../core/ids.js").ExecutionAttemptID; reportID: import("../core/ids.js").ExecutionReportID; candidateEffect: string }
  // v0.2.0 Phase 5 — acceptance layer events. The commit event carries the
  // full binding set (assessment/window/candidate/obligations/parent) so the
  // audit trail can reconstruct who/what/which evidence without hidden
  // reasoning.
  | { type: "execution.supervisor_assessment_recorded"; executionRunID: import("../core/ids.js").ExecutionRunID; assessmentID: import("../core/ids.js").SupervisorAssessmentID; windowID: import("../core/ids.js").VerificationWindowID; candidateRevision: number; disposition: string; acceptanceScope: string }
  | { type: "execution.commit_created"; executionRunID: import("../core/ids.js").ExecutionRunID; commitID: import("../core/ids.js").ExecutionCommitID; assessmentID: import("../core/ids.js").SupervisorAssessmentID; windowID: import("../core/ids.js").VerificationWindowID; candidateRevision: number; parent: string; satisfiedObligations: readonly string[]; stageCompleted: boolean }
  | { type: "execution.window_closed"; executionRunID: import("../core/ids.js").ExecutionRunID; windowID: import("../core/ids.js").VerificationWindowID; commitID: import("../core/ids.js").ExecutionCommitID }
  | { type: "execution.stage_completed"; executionRunID: import("../core/ids.js").ExecutionRunID; stageID: import("../core/ids.js").ExecutionStageID; commitID: import("../core/ids.js").ExecutionCommitID }
  // v0.2.0 Phase 6A — escalation / conflict / reconciliation audit events
  // (workflow state, NOT PlanCommits). Provenance only — never hidden
  // reasoning, never a full projection.
  | { type: "execution.issue_created"; executionRunID: import("../core/ids.js").ExecutionRunID; issueID: import("../core/ids.js").ExecutionIssueID; sourceAssessmentID: import("../core/ids.js").SupervisorAssessmentID }
  | { type: "execution.replan_required"; executionRunID: import("../core/ids.js").ExecutionRunID; issueID: import("../core/ids.js").ExecutionIssueID; from: import("../core/execution-run.js").ExecutionLifecycle }
  | { type: "execution.verification_conflict_created"; executionRunID: import("../core/ids.js").ExecutionRunID; conflictID: import("../core/ids.js").VerificationConflictID; windowID: import("../core/ids.js").VerificationWindowID; candidateRevision: number }
  | { type: "execution.verification_conflict_resolved"; executionRunID: import("../core/ids.js").ExecutionRunID; conflictID: import("../core/ids.js").VerificationConflictID; reportID: import("../core/ids.js").ExecutionReportID; outcome: string }
  | { type: "execution.verification_blocked"; executionRunID: import("../core/ids.js").ExecutionRunID; conflictID: import("../core/ids.js").VerificationConflictID; reportID: import("../core/ids.js").ExecutionReportID }
  | { type: "execution.attempt_reconciled"; executionRunID: import("../core/ids.js").ExecutionRunID; reconciliationID: import("../core/ids.js").AttemptReconciliationID; windowID: import("../core/ids.js").VerificationWindowID; observation: string; from: number; to: number }
  // v0.2.0 Phase 6B — final closure & ExecutionCompletionGate audit events
  // (workflow state, NOT PlanCommits). The completion event carries the full
  // binding set (run/plan/final Stage/Window/Assessment/Commit/record +
  // supervisor generation) so the audit trail can reconstruct the gate
  // decision without hidden reasoning.
  | { type: "execution.final_closure_prepared"; executionRunID: import("../core/ids.js").ExecutionRunID; stageID: import("../core/ids.js").ExecutionStageID; dependsOn: readonly string[]; obligations: number }
  | { type: "execution.completion_recorded"; executionRunID: import("../core/ids.js").ExecutionRunID; completionID: import("../core/ids.js").ExecutionCompletionID; finalClosureStageID: import("../core/ids.js").ExecutionStageID; finalWindowID: import("../core/ids.js").VerificationWindowID; finalCommitID: import("../core/ids.js").ExecutionCommitID; finalAssessmentID: import("../core/ids.js").SupervisorAssessmentID; supervisorGeneration: number }
  | { type: "execution.run_completed"; executionRunID: import("../core/ids.js").ExecutionRunID; completionID: import("../core/ids.js").ExecutionCompletionID };

export interface PlanEvent {
  /** 1-based sequence within the run. */
  seq: number;
  planID: PlanID;
  at: Timestamp;
  detail: PlanEventDetail;
}
