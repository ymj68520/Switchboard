/**
 * Centralized process exit code policy (frozen plan §14). Numbers are part of
 * the doctor contract: the doctor JSON report and the process exit code must
 * stay semantically consistent, so every mapping lives here and is pinned by
 * tests.
 */

import type { RuntimeErrorCode } from "./errors.js";

export const EXIT_CODES = {
  /** Success (doctor: overall READY). */
  success: 0,
  /** Invocation/config error: unknown command/flag, hook event, bad usage. */
  invocation: 2,
  /** Runtime prerequisite failure: Node version, node:sqlite. */
  runtimePrerequisite: 3,
  /** Host capability failure: Claude CLI missing/unreadable, capability unsupported. */
  hostCapability: 4,
  /** Storage/environment preflight failure: plugin data unavailable/unwritable. */
  storageEnvironment: 5,
  /** Internal error (unexpected failure — bug). */
  internal: 10,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

/**
 * The single error-code → exit-code mapping. Business code must call this
 * instead of hardcoding numbers; exhaustiveness is enforced at compile time
 * (the mapped record covers every RuntimeErrorCode) and by test.
 */
const EXIT_CODE_BY_ERROR: Readonly<Record<RuntimeErrorCode, ExitCode>> = {
  UNSUPPORTED_NODE_VERSION: EXIT_CODES.runtimePrerequisite,
  SQLITE_UNAVAILABLE: EXIT_CODES.runtimePrerequisite,
  CLAUDE_CLI_NOT_FOUND: EXIT_CODES.hostCapability,
  CLAUDE_VERSION_UNREADABLE: EXIT_CODES.hostCapability,
  CLAUDE_CAPABILITY_UNSUPPORTED: EXIT_CODES.hostCapability,
  PLUGIN_DATA_UNAVAILABLE: EXIT_CODES.storageEnvironment,
  PLUGIN_DATA_NOT_WRITABLE: EXIT_CODES.storageEnvironment,
  INVALID_RUNTIME_COMMAND: EXIT_CODES.invocation,
  HOOK_NOT_IMPLEMENTED: EXIT_CODES.invocation,
  MCP_BOOTSTRAP_FAILED: EXIT_CODES.internal,
  INTERNAL_ERROR: EXIT_CODES.internal,
};

export function exitCodeForError(code: RuntimeErrorCode): ExitCode {
  return EXIT_CODE_BY_ERROR[code];
}
