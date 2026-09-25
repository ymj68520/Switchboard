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
  | "RUN_STATE_INVALID";

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
