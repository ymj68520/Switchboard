/**
 * Runtime error envelope for the Phase Plan Claude Code runtime (frozen spec
 * §38 error semantics adapted to the Phase 1 bootstrap surface). Every failure
 * carries a stable machine-readable `code`; callers must never branch on raw
 * exception text.
 */

export type RuntimeErrorCode =
  | "UNSUPPORTED_NODE_VERSION"
  | "SQLITE_UNAVAILABLE"
  | "CLAUDE_CLI_NOT_FOUND"
  | "CLAUDE_VERSION_UNREADABLE"
  | "CLAUDE_CAPABILITY_UNSUPPORTED"
  | "PLUGIN_DATA_UNAVAILABLE"
  | "PLUGIN_DATA_NOT_WRITABLE"
  | "INVALID_RUNTIME_COMMAND"
  | "HOOK_NOT_IMPLEMENTED"
  | "MCP_BOOTSTRAP_FAILED"
  | "INTERNAL_ERROR"
  // Phase 2 — Plan Store foundation (storage/environment family, exit 5)
  | "STORE_SCHEMA_TOO_NEW"
  | "STORE_SCHEMA_TOO_OLD"
  | "STORE_SCHEMA_INVALID"
  | "STORE_CORRUPT"
  | "STORE_OPEN_FAILED"
  | "STORE_BUSY"
  | "STORE_BACKUP_FAILED"
  | "STORE_MIGRATION_FAILED"
  // Phase 3 — workspace identity / session binding domain (exit 6)
  | "WORKSPACE_NOT_FOUND"
  | "WORKSPACE_UNAVAILABLE"
  | "WORKSPACE_MISMATCH"
  | "SESSION_ALREADY_BOUND"
  | "RUN_ALREADY_BOUND"
  | "BINDING_NOT_FOUND"
  | "BINDING_DETACHED"
  | "BINDING_CONFLICT"
  | "STALE_SESSION_BINDING"
  // Phase 4 — PlanningRun / state machine domain (exit 6)
  | "RUN_NOT_FOUND"
  | "RUN_TERMINAL"
  | "INVALID_RUN_TRANSITION"
  | "STALE_RUN_REVISION"
  | "INVALID_RUN_GOAL"
  | "RUN_STATE_INVALID"
  // Phase 5 — Plan Memory immutable revision model (exit 6)
  | "MEMORY_ARTIFACT_NOT_FOUND"
  | "MEMORY_REVISION_NOT_FOUND"
  | "MEMORY_REVISION_CONFLICT"
  | "MEMORY_REVISION_INVALID"
  | "SNAPSHOT_NOT_FOUND"
  | "SNAPSHOT_INVALID"
  | "SECTION_DAG_INVALID"
  | "STALE_MEMORY_HEAD"
  | "MEMORY_HEAD_INVALID"
  // Phase 6 — Proposal / Approval / PlanCommit transaction engine (exit 6)
  | "PROPOSAL_NOT_FOUND"
  | "PROPOSAL_SUPERSEDED"
  | "PROPOSAL_HASH_MISMATCH"
  | "PROPOSAL_NOT_AWAITING_APPROVAL"
  | "PROPOSAL_ALREADY_COMMITTED"
  | "PROPOSAL_ALREADY_AWAITING"
  | "PROPOSAL_TYPE_UNAVAILABLE"
  | "PROPOSAL_INVALID"
  | "CAPABILITY_NOT_AVAILABLE"
  | "IDEMPOTENCY_CONFLICT"
  | "MEMORY_HEAD_UNCOMMITTED"
  | "BLOCKING_QUESTION"
  | "BLOCKING_CONFLICT"
  | "PLAN_COMMIT_CONFLICT"
  // Phase 8 — context projection / recovery capsule / read tools
  | "CONTEXT_NOT_AVAILABLE"
  | "CONTEXT_BUDGET_EXCEEDED"
  | "MEMORY_REF_INVALID"
  | "MEMORY_DETAIL_UNAVAILABLE"
  // Phase 9 — Observation ledger / Evidence promotion foundation (§77)
  | "OBSERVATION_NOT_FOUND"
  | "OBSERVATION_CONFLICT"
  | "OBSERVATION_CAPTURE_FAILED"
  | "OBSERVATION_BLOB_MISSING"
  | "OBSERVATION_BLOB_CORRUPT"
  | "OBSERVATION_NOT_PROMOTABLE"
  | "EVIDENCE_NOT_FOUND"
  | "EVIDENCE_REVISION_NOT_FOUND"
  | "EVIDENCE_REVISION_CONFLICT"
  | "EVIDENCE_PROVENANCE_INVALID"
  | "EVIDENCE_SOURCE_FINGERPRINT_UNAVAILABLE"
  | "EVIDENCE_SCOPE_INVALID"
  // Phase 10 — Evidence freshness / revalidation (§53)
  | "EVIDENCE_NEEDS_VALIDATION"
  | "EVIDENCE_STATE_INVALID"
  | "EVIDENCE_REVISION_NOT_CURRENT"
  | "EVIDENCE_REVALIDATION_INVALID"
  | "EVIDENCE_PROVENANCE_STALE"
  // Phase 11 — Architecture / Section workflow (§73)
  | "SECTION_NOT_FOUND"
  | "SECTION_WORKFLOW_INVALID"
  | "SECTION_NOT_ACTIVE"
  | "SECTION_ALREADY_COMPLETED"
  | "SECTION_NEEDS_REVIEW"
  | "SECTION_DEPENDENCY_INCOMPLETE"
  | "SECTION_WORKFLOW_INCOMPLETE"
  | "ACTIVE_PROPOSAL_SCOPE_CONFLICT"
  // Phase 12 — Frozen synthesis + isolated semantic validator (§94)
  | "SYNTHESIS_INPUT_REQUIRED"
  | "SYNTHESIS_INPUT_NOT_READY"
  | "SYNTHESIS_STALE"
  | "SYNTHESIS_REF_INVALID"
  | "SYNTHESIS_MANIFEST_INVALID"
  | "SYNTHESIS_ALREADY_SUBMITTED"
  | "VALIDATOR_CALLER_REQUIRED"
  | "VALIDATOR_MUTATION_FORBIDDEN"
  | "VALIDATION_REPORT_INVALID"
  | "VALIDATION_STALE"
  | "VALIDATION_ALREADY_SUBMITTED"
  | "REOPEN_REQUEST_INVALID"
  // Phase 13 — deterministic FinalizationGate + Final Plan authorization (§90)
  | "FINALIZATION_DENIED"
  | "FINALIZATION_ALREADY_PREPARED"
  | "FINAL_PLAN_CANDIDATE_REQUIRED"
  | "FINAL_PLAN_CANDIDATE_STALE"
  | "FINAL_PLAN_ALREADY_APPROVED"
  | "FINAL_PLAN_PROPOSAL_INVALID"
  | "EVIDENCE_AUDIT_FAILED"
  // Phase 14 — ExecutionHandoff, Plan → Build transition, Build read-side (§103)
  | "HANDOFF_NOT_AUTHORIZED"
  | "HANDOFF_ALREADY_DELIVERED"
  | "HANDOFF_DELIVERY_PENDING"
  | "HANDOFF_DELIVERY_INVALID"
  | "EXECUTION_BINDING_REQUIRED"
  | "STALE_EXECUTION_BINDING"
  | "EXECUTION_CONTEXT_NOT_AVAILABLE"
  | "EXECUTION_MEMORY_REF_NOT_AUTHORIZED"
  | "EXECUTION_REPLAN_NOT_AVAILABLE"
  // Phase 15 — ExecutionIssue / successor replanning (§86)
  | "EXECUTION_ISSUE_REQUIRED"
  | "EXECUTION_ISSUE_NOT_FOUND"
  | "EXECUTION_ISSUE_SCOPE_INVALID"
  | "EXECUTION_ISSUE_ALREADY_ADOPTED"
  | "EXECUTION_REPLAN_REQUIRED"
  | "SUCCESSOR_RUN_ALREADY_STARTED"
  | "SUCCESSOR_BASELINE_REQUIRED"
  | "SUCCESSOR_BASELINE_STALE"
  | "SUCCESSOR_BASELINE_NOT_MATERIALIZED"
  | "SUCCESSOR_BASELINE_MATERIALIZATION_FAILED"
  | "BASELINE_MEMORY_REF_NOT_AUTHORIZED"
  | "COMPLETED_RUN_REACTIVATION_FORBIDDEN"
  // Phase 16 — run control: takeover / abort (§50)
  | "TAKEOVER_NOT_REQUIRED"
  | "TAKEOVER_NOT_AVAILABLE"
  | "TAKEOVER_NOT_AVAILABLE_DURING_HANDOFF"
  | "ABORT_NOT_AVAILABLE"
  | "ABORT_NOT_AVAILABLE_DURING_HANDOFF"
  | "ABORT_HOST_TRANSITION_FAILED"
  | "RUN_CONTROL_AUTHORIZATION_REQUIRED"
  // v0.2.0 E1 — ExecutionRun foundation (architecture spec §11/§51)
  | "INVALID_EXECUTION_LIFECYCLE"
  | "EXECUTION_RUN_FINALPLAN_MISMATCH"
  | "EXECUTION_RUN_NOT_FOUND"
  | "EXECUTION_RUN_AMBIGUOUS"
  | "EXECUTION_HANDOFF_INVARIANT"
  // v0.2.0 E2 — SupervisorBinding ownership/fencing (architecture spec §43/§51)
  | "SUPERVISOR_BINDING_REQUIRED"
  | "STALE_SUPERVISOR_BINDING"
  // v0.2.0 E3 — ExecutionStage & VerificationWindow foundation (architecture spec §13/§14/§51)
  | "EXECUTION_STAGE_REQUIRED"
  | "EXECUTION_STAGE_NOT_ELIGIBLE"
  | "EXECUTION_STAGE_ALREADY_ACTIVE"
  | "INVALID_EXECUTION_STAGE_TRANSITION"
  | "VERIFICATION_WINDOW_REQUIRED"
  | "VERIFICATION_WINDOW_ALREADY_OPEN"
  | "WINDOW_STAGE_MISMATCH"
  | "STALE_CANDIDATE_REVISION"
  | "INVALID_CANDIDATE_REVISION"
  // v0.2.0 E4 — ExecutionDirective / ExecutionAttempt / ExecutionReport protocol
  // (architecture spec §51). STALE_CANDIDATE_REVISION is REUSED from E3 — the
  // stale-candidate semantics are the same durable window fact.
  | "DIRECTIVE_NOT_CURRENT"
  | "DIRECTIVE_HASH_MISMATCH"
  | "DIRECTIVE_REVISION_CONFLICT"
  | "DIRECTIVE_ALREADY_ATTEMPTED"
  // A1-I closure §3 — the logical Directive lineage is owned by its issuing
  // ExecutionRun; a revision under a different run fails closed.
  | "DIRECTIVE_LINEAGE_FOREIGN_RUN"
  | "ACCEPTED_BASE_INVALID"
  | "PLAN_REF_INVALID"
  | "CAPABILITY_ENVELOPE_INVALID"
  | "ATTEMPT_ROLE_INVALID"
  | "ATTEMPT_ALREADY_RUNNING"
  | "ATTEMPT_NOT_RUNNING"
  | "ATTEMPT_ALREADY_REPORTED"
  | "ATTEMPT_INDETERMINATE"
  | "INVALID_ATTEMPT_TRANSITION"
  | "REPORT_ALREADY_EXISTS"
  | "REPORT_CONTRACT_VIOLATION"
  | "REPORT_BINDING_MISMATCH"
  // v0.2.0 E5 — ExecutionWorker runtime / invocation boundary (architecture
  // spec; E5 §50). ATTEMPT_NOT_RUNNING / DIRECTIVE_NOT_CURRENT /
  // STALE_CANDIDATE_REVISION / REPORT_CONTRACT_VIOLATION are REUSED from E4.
  | "WORKER_LAUNCH_INVALID"
  | "WORKER_CLAIM_TOKEN_INVALID"
  | "WORKER_ATTEMPT_ALREADY_CLAIMED"
  | "WORKER_SESSION_MISMATCH"
  | "WORKER_AUTHORITY_REQUIRED"
  | "WORKER_INVOCATION_FINISHED"
  | "INVALID_WORKER_INVOCATION_TRANSITION"
  | "CAPABILITY_DENIED"
  | "CAPABILITY_ENFORCEMENT_UNAVAILABLE"
  | "SUPERVISOR_DIRECT_TOOL_FORBIDDEN"
  // v0.2.0 E6 — SupervisorAssessment / Acceptance Gate / ExecutionCommit /
  // acceptedHead. STALE_CANDIDATE_REVISION (E3), VERIFICATION_WINDOW_REQUIRED
  // (E3), and STALE_SUPERVISOR_BINDING (E2) are REUSED where the semantics are
  // the same durable fact.
  | "SUPERVISOR_ASSESSMENT_STALE"
  | "ASSESSMENT_REPORT_COVERAGE_INCOMPLETE"
  | "ASSESSMENT_REPORT_INVALID"
  | "ACCEPTANCE_BLOCKED"
  | "ACCEPTANCE_VERIFICATION_REQUIRED"
  | "ACCEPTANCE_VERIFICATION_STALE"
  | "ACCEPTANCE_INDETERMINATE_WORK"
  | "ACCEPTANCE_ATTEMPT_RUNNING"
  | "EXECUTION_COMMIT_CONFLICT"
  | "EXECUTION_COMMIT_ALREADY_EXISTS"
  | "STALE_EXECUTION_HEAD"
  | "WINDOW_BASE_MISMATCH"
  // v0.2.0 E7 — Stage completion + next-Stage progression + verification-window
  // orchestration. EXECUTION_STAGE_REQUIRED / EXECUTION_STAGE_NOT_ELIGIBLE /
  // EXECUTION_STAGE_ALREADY_ACTIVE (E3), VERIFICATION_WINDOW_ALREADY_OPEN (E3),
  // ACCEPTANCE_ATTEMPT_RUNNING (E6), and STALE_EXECUTION_HEAD (E6) are REUSED
  // where the semantics are the same durable fact.
  | "STAGE_COMPLETION_OBLIGATION_INVALID"
  | "STAGE_COMPLETION_VERIFICATION_REQUIRED"
  | "STAGE_ALREADY_COMPLETED"
  | "NO_ACTIVE_STAGE"
  | "STAGE_CONTINUATION_NOT_ALLOWED"
  | "EXECUTION_PROGRESSION_BOUNDARY_INVALID"
  | "ALL_STAGES_COMPLETED"
  // v0.2.0 E8 — verification insertion policy + bounded conflict-resolution
  // orchestration. STALE_CANDIDATE_REVISION (E3), WORKER_SESSION_MISMATCH
  // (E5), and the E6 acceptance codes are REUSED where the semantics are the
  // same durable fact.
  | "DIRECTIVE_POLICY_UPGRADE_REQUIRED"
  | "VERIFICATION_REQUIREMENT_DOWNGRADE"
  | "VERIFICATION_REQUIRED"
  | "VERIFICATION_POLICY_INVALID"
  | "VERIFICATION_CONFLICT_INVALID"
  | "VERIFICATION_CONFLICT_ALREADY_EXISTS"
  | "VERIFICATION_CONFLICT_STALE"
  | "VERIFICATION_CONFLICT_RESOLVER_EXISTS"
  | "VERIFICATION_CONFLICT_RESOLUTION_INVALID"
  | "ACCEPTANCE_VERIFICATION_CONFLICT"
  // v0.2.0 E9 — REPLAN_REQUIRED + ExecutionIssue + controlled return to
  // planning. STALE_SUPERVISOR_BINDING (E2), INVALID_EXECUTION_LIFECYCLE (E1),
  // EXECUTION_ISSUE_REQUIRED (v0.1), and SUCCESSOR_RUN_ALREADY_STARTED (v0.1)
  // are REUSED where the semantics are the same durable fact.
  | "REPLAN_REQUIRED"
  | "REPLAN_REQUEST_INVALID"
  | "REPLAN_ATTEMPT_RUNNING"
  | "REPLAN_AFFECTED_REF_INVALID"
  | "REPLAN_REPORT_REF_INVALID"
  | "REPLAN_ALREADY_TRANSITIONED"
  | "EXECUTION_ISSUE_AMBIGUOUS"
  | "SUCCESSOR_PLANNING_RUN_MISMATCH"
  // v0.2.0 E10 — final execution closure + ExecutionCompletionGate.
  // INVALID_EXECUTION_LIFECYCLE (E1), STALE_EXECUTION_HEAD (E6),
  // VERIFICATION_REQUIRED (E6), ACCEPTANCE_VERIFICATION_CONFLICT (E8), and
  // STALE_SUPERVISOR_BINDING (E2) are REUSED where the semantics are the same
  // durable fact (E10 §64).
  | "FINAL_CLOSURE_NOT_READY"
  | "FINAL_CLOSURE_ALREADY_OPEN"
  | "FINAL_CLOSURE_REQUIRED"
  | "EXECUTION_SCOPE_INVALID"
  | "EXECUTION_COMPLETION_OBLIGATION_REQUIRED"
  | "EXECUTION_COMPLETION_OBLIGATION_INVALID"
  | "EXECUTION_COMPLETION_VERIFICATION_REQUIRED"
  | "EXECUTION_COMPLETION_ATTEMPT_RUNNING"
  | "EXECUTION_COMPLETION_INDETERMINATE_WORK"
  | "EXECUTION_COMPLETION_GATE_FAILED"
  | "EXECUTION_ALREADY_COMPLETED"
  // v0.2.0 E11 — crash/interruption recovery + indeterminate attempt
  // reconciliation. STALE_CANDIDATE_REVISION (E3), ATTEMPT_NOT_RUNNING (E4),
  // INVALID_EXECUTION_LIFECYCLE (E1), and STALE_SUPERVISOR_BINDING (E2) are
  // REUSED where the semantics are the same durable fact (E11 §55).
  | "ATTEMPT_RECONCILIATION_REQUIRED"
  | "ATTEMPT_RECONCILIATION_ALREADY_RESOLVED"
  | "ATTEMPT_RECONCILIATION_TARGET_INVALID"
  | "ATTEMPT_RECONCILIATION_REPORT_REQUIRED"
  | "ATTEMPT_RECONCILIATION_REPORT_INVALID"
  | "ATTEMPT_RECONCILIATION_STALE"
  | "ATTEMPT_RECONCILIATION_SIDE_EFFECT_RISK"
  // v0.2.0 E12 — conversation/session recovery matrix. The remaining §56
  // vocabulary REUSES frozen codes: EXECUTION_SUPERVISOR_OWNED_BY_OTHER_SESSION
  // and EXECUTION_TAKEOVER_REQUIRED ≡ STALE_SUPERVISOR_BINDING /
  // SUPERVISOR_BINDING_REQUIRED (E2); WORKER_LAUNCH_CREDENTIAL_STALE ≡
  // WORKER_CLAIM_TOKEN_INVALID (E5 — the rotated/revoked hash fails the claim
  // token match); WORKSPACE_MISMATCH (Phase 3) is unchanged.
  | "EXECUTION_RUN_AMBIGUOUS"
  | "EXECUTION_SESSION_NOT_OWNER"
  | "WORKER_LIVENESS_UNCERTAIN"
  | "WORKER_LAUNCH_RETRY_NOT_ALLOWED"
  // v0.2.0 A1-II — explicit same-FinalPlan reexecution (amendment A1 §29–§33;
  // directive §48). IDEMPOTENCY_CONFLICT (Phase 6), RUN_NOT_FOUND (Phase 4),
  // EXECUTION_RUN_NOT_FOUND (E1/E12), and WORKSPACE_UNAVAILABLE (Phase 3) are
  // REUSED where the semantics are the same durable fact. SQLite uniqueness
  // surfaces are never public semantics — the workspace singleton pre-check
  // owns WORKSPACE_EXECUTION_ACTIVE (directive §48).
  | "FINAL_PLAN_NOT_FOUND"
  | "FINAL_PLAN_MISMATCH"
  | "INITIAL_DELIVERY_NOT_COMPLETE"
  | "WORKSPACE_EXECUTION_ACTIVE"
  // Phase 7 — host authority / approval bridge
  | "HOST_SECRET_UNAVAILABLE"
  | "ENTRY_INTENT_REQUIRED"
  | "ENTRY_INTENT_INVALID"
  | "HOST_CONTEXT_REQUIRED"
  | "HOST_CONTEXT_INVALID"
  | "HOST_CONTEXT_INPUT_MISMATCH"
  | "HOST_CONTEXT_TOOL_MISMATCH"
  | "HOST_CONTEXT_WORKSPACE_MISMATCH"
  | "MCP_INPUT_INVALID"
  | "RUN_SELECTION_REQUIRED"
  | "TAKEOVER_REQUIRED"
  | "PLAN_MODE_REQUIRED"
  | "PLAN_MODE_TRANSITION_FAILED"
  // Hook-layer parser failure (fail-closed exit policy lives in hooks/run.ts)
  | "HOOK_INPUT_INVALID";

/** Plain serializable envelope (frozen plan §13). */
export interface RuntimeErrorEnvelope {
  code: RuntimeErrorCode;
  message: string;
  cause?: string;
  recoverable: boolean;
}

export class RuntimeError extends Error {
  readonly code: RuntimeErrorCode;
  readonly causeText?: string;
  /** Whether the caller can realistically retry or work around the failure. */
  readonly recoverable: boolean;
  /** Optional structured facts (e.g. supported/detected schema versions). */
  readonly detail?: Record<string, unknown>;

  constructor(
    code: RuntimeErrorCode,
    message: string,
    options?: { cause?: string; recoverable?: boolean; detail?: Record<string, unknown> },
  ) {
    super(message);
    this.name = "RuntimeError";
    this.code = code;
    this.causeText = options?.cause;
    this.recoverable = options?.recoverable ?? false;
    this.detail = options?.detail;
  }

  toEnvelope(): RuntimeErrorEnvelope {
    return {
      code: this.code,
      message: this.message,
      ...(this.causeText === undefined ? {} : { cause: this.causeText }),
      ...(this.detail === undefined ? {} : { detail: this.detail }),
      recoverable: this.recoverable,
    };
  }
}

export function isRuntimeError(value: unknown): value is RuntimeError {
  return value instanceof RuntimeError;
}

/** Normalize an arbitrary thrown value into a RuntimeError envelope. */
export function toRuntimeError(
  value: unknown,
  fallbackCode: RuntimeErrorCode = "INTERNAL_ERROR",
): RuntimeError {
  if (isRuntimeError(value)) {
    return value;
  }
  const message = value instanceof Error ? value.message : String(value);
  return new RuntimeError(fallbackCode, message, {
    cause: value instanceof Error ? (value.stack ?? value.name) : undefined,
    recoverable: false,
  });
}

export function errorEnvelope(value: unknown, fallbackCode?: RuntimeErrorCode): RuntimeErrorEnvelope {
  return toRuntimeError(value, fallbackCode).toEnvelope();
}
