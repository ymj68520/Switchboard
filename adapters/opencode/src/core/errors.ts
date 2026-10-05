/**
 * Typed error surface for Ultra Plan. All domain violations carry a machine
 * readable `code` so callers (tools, plugin hooks) can react deterministically
 * instead of parsing error text.
 */

export type UltraPlanErrorCode =
  | "unknown_planning_stage"
  | "unknown_planning_lifecycle"
  | "invalid_stage_transition"
  | "invalid_lifecycle_transition"
  | "multiple_active_runs"
  | "duplicate_plan_id"
  | "run_not_found"
  | "duplicate_revision"
  | "non_monotonic_revision"
  | "section_dependency_cycle"
  | "unknown_section"
  | "dependency_incomplete"
  | "commit_gated_run_field"
  // Phase 2A — planning agent protocol boundary
  | "no_active_run"
  | "capability_not_available"
  | "invalid_scope"
  | "unknown_reference"
  | "revision_mismatch"
  | "missing_provenance"
  | "proposal_type_invalid"
  | "proposal_kind_unsupported"
  | "proposal_immutable"
  | "finalization_blocked"
  // Phase 2A.1 — authority boundary corrections
  | "start_not_authorized"
  | "proposal_not_approvable"
  | "proposal_status_invalid"
  | "approval_mismatch"
  // Phase 2B1 — transaction engine
  | "approval_not_found"
  | "head_snapshot_mismatch"
  | "already_committed"
  | "transaction_validation_failed"
  // Phase 2C — discovery → architecture workflow
  | "goal_required"
  // Phase 2E2 — section completion & work progression
  | "section_needs_review"
  | "revision_missing"
  | "stale_active_work"
  | "evidence_not_fresh"
  // Phase 2F — derived synthesis artifacts
  | "synthesis_entry_invalid"
  | "synthesis_input_missing"
  | "synthesis_input_stale"
  | "provenance_missing"
  | "provenance_invalid"
  | "cross_section_invalid"
  | "implementation_coverage_gap"
  | "implementation_order_violation"
  | "finding_invalid"
  // Phase 2G — read-only semantic validation & reopen admission
  | "synthesis_manifest_missing"
  | "validator_unavailable"
  | "validation_already_running"
  | "validation_output_invalid"
  | "validation_identity_changed"
  | "validation_report_missing"
  | "reopen_reason_invalid"
  | "reopen_target_unsupported"
  // Phase 2H — evidence audit & deterministic finalization gate
  | "finalization_stale"
  // Phase 2I — final proposal / Final PlanCommit
  | "final_proposal_stale"
  | "final_plan_type_invalid"
  | "final_plan_change_invalid"
  | "final_plan_stage_invalid"
  | "final_plan_already_exists"
  | "final_plan_scope_invalid"
  // Phase 2J — recoverable ExecutionHandoff & Build transition (§60 categories)
  | "handoff_not_allowed"
  | "execution_policy_unresolved"
  | "execution_runtime_unavailable"
  | "handoff_dispatch_failed"
  | "handoff_delivery_ambiguous"
  | "handoff_receipt_invalid"
  | "handoff_session_mismatch"
  // v0.2.0 Phase 1 — ExecutionRun supervised-execution foundation (SPEC §8-§11)
  | "execution_run_not_found"
  | "invalid_execution_lifecycle"
  | "stale_execution_run"
  | "final_plan_binding_mismatch"
  | "workspace_mismatch"
  | "initial_handoff_conflict"
  | "duplicate_execution_run_id"
  // v0.2.0 Phase 2 — SupervisorBinding, fencing & execution recovery
  | "supervisor_binding_not_found"
  | "supervisor_binding_conflict"
  | "stale_supervisor_binding"
  | "supervisor_session_mismatch"
  | "takeover_requires_authorization"
  // v0.2.0 Phase 3 — ExecutionStage & VerificationWindow foundation
  | "execution_stage_not_found"
  | "invalid_stage_transition"
  | "stage_not_eligible"
  | "active_stage_conflict"
  | "stage_dependency_unsatisfied"
  | "stale_execution_stage"
  | "stage_dependency_cycle"
  | "window_not_found"
  | "window_already_open"
  | "window_not_open"
  | "stale_candidate_revision"
  | "stage_window_mismatch"
  // v0.2.0 Phase 4 — Directive / Attempt / Report / Worker transaction protocol
  | "execution_directive_not_found"
  | "directive_hash_mismatch"
  | "directive_revision_conflict"
  | "directive_not_current"
  | "execution_attempt_not_found"
  | "attempt_already_consumed"
  | "active_attempt_conflict"
  | "invalid_attempt_transition"
  | "execution_report_conflict"
  | "report_directive_mismatch"
  | "invalid_worker_role"
  // v0.2.0 Phase 5 — SupervisorAssessment, verification acceptance & ExecutionCommit
  | "supervisor_assessment_not_found"
  | "assessment_conflict"
  | "assessment_stale"
  | "verification_required"
  | "blocking_verification_result"
  | "stale_execution_head"
  | "execution_commit_not_found"
  | "execution_commit_conflict"
  | "window_already_committed"
  | "stage_completion_obligations_missing"
  | "stage_completion_incomplete"
  // v0.2.0 Phase 6A — escalation, replanning, verification conflict resolution
  // & indeterminate reconciliation
  | "execution_issue_not_found"
  | "execution_issue_conflict"
  | "replan_assessment_required"
  | "replan_assessment_stale"
  | "verification_conflict_not_found"
  | "verification_conflict_conflict"
  | "conflict_resolution_already_used"
  | "verification_conflict_open"
  | "verification_blocked"
  | "invalid_verification_evidence_ref"
  | "reconciliation_required"
  | "reconciliation_inconclusive"
  | "reconciliation_conflict"
  | "attempt_already_reconciled"
  | "replan_context_unavailable"
  // v0.2.0 Phase 6B — final closure & ExecutionCompletionGate
  | "final_closure_not_ready"
  | "final_closure_already_exists"
  | "invalid_final_closure_obligations"
  | "ordinary_stage_exists_after_closure_started"
  | "execution_completion_not_ready"
  | "execution_completion_conflict"
  | "execution_already_completed"
  | "final_closure_commit_required"
  | "execution_completion_provenance_invalid"
  // v0.2.0 Phase 7A — dormant supervised-execution runtime boundary
  | "unknown_execution_tool"
  | "invalid_tool_arguments"
  | "supervisor_turn_already_mutated"
  | "worker_output_invalid"
  | "ambiguous_execution_run"
  // v0.2.0 Phase 7B — production supervised cutover
  | "execution_baseline_unavailable"
  | "replan_not_available"
  // v0.2.0 Phase 8 — host tool inventory isolation (§13 fail-closed)
  | "supervisor_tool_isolation_blocked"
  // R1 — blocker cure, deadlock freedom & architecture remediation
  | "conflict_resolution_invalid"
  | "abort_not_allowed"
  | "amendment_base_mismatch"
  | "amendment_stage_invalid"
  // R2 — context architecture (brief §17/§93)
  | "context_state_invalid"
  | "context_budget_exceeded"
  // Phase 2B2 — durable store
  | "store_version_unsupported"
  | "store_corrupt"
  | "store_busy";

export class UltraPlanError extends Error {
  readonly code: UltraPlanErrorCode;
  readonly detail?: Record<string, unknown>;

  constructor(code: UltraPlanErrorCode, message: string, detail?: Record<string, unknown>) {
    super(message);
    this.name = "UltraPlanError";
    this.code = code;
    this.detail = detail;
  }
}

export function isUltraPlanError(value: unknown): value is UltraPlanError {
  return value instanceof UltraPlanError;
}
