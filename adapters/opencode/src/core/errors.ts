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
