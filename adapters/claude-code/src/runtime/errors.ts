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
  | "INTERNAL_ERROR";

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

  constructor(
    code: RuntimeErrorCode,
    message: string,
    options?: { cause?: string; recoverable?: boolean },
  ) {
    super(message);
    this.name = "RuntimeError";
    this.code = code;
    this.causeText = options?.cause;
    this.recoverable = options?.recoverable ?? false;
  }

  toEnvelope(): RuntimeErrorEnvelope {
    return {
      code: this.code,
      message: this.message,
      ...(this.causeText === undefined ? {} : { cause: this.causeText }),
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
