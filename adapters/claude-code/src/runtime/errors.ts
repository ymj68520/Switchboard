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
