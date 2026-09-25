/**
 * Error surface for the Codex session runtime (Phase 1).
 *
 * Phase 1 only needs a flat bootstrap-failure taxonomy (Phase 1 directive
 * §10) — no deeper hierarchy. Each failure carries machine-readable `code`
 * plus bounded diagnostic `detail` (never an unbounded stderr dump).
 */

export type CodexSessionErrorCode =
  | "invalid_runtime_state"
  | "codex_executable_unavailable"
  | "spawn_failed"
  | "exited_before_endpoint"
  | "exited_before_readyz"
  | "endpoint_not_discovered"
  | "readyz_timeout"
  | "readyz_failed"
  | "startup_aborted"
  | "shutdown_failed";

export class CodexSessionError extends Error {
  readonly code: CodexSessionErrorCode;
  readonly detail?: Record<string, unknown>;

  constructor(code: CodexSessionErrorCode, message: string, detail?: Record<string, unknown>) {
    super(message);
    this.name = "CodexSessionError";
    this.code = code;
    this.detail = detail;
  }
}

export function isCodexSessionError(error: unknown): error is CodexSessionError {
  return error instanceof CodexSessionError;
}
