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
  /**
   * Domain state conflict (workspace identity / session binding): refused by
   * deterministic ownership or identity rules. No Phase 3 CLI path surfaces
   * these yet — the mapping is declared now so error→exit stays total and
   * future surfaces cannot improvise.
   */
  domainState: 6,
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
  STORE_SCHEMA_TOO_NEW: EXIT_CODES.storageEnvironment,
  STORE_SCHEMA_TOO_OLD: EXIT_CODES.storageEnvironment,
  STORE_SCHEMA_INVALID: EXIT_CODES.storageEnvironment,
  STORE_CORRUPT: EXIT_CODES.storageEnvironment,
  STORE_OPEN_FAILED: EXIT_CODES.storageEnvironment,
  STORE_BUSY: EXIT_CODES.storageEnvironment,
  STORE_BACKUP_FAILED: EXIT_CODES.storageEnvironment,
  STORE_MIGRATION_FAILED: EXIT_CODES.storageEnvironment,
  WORKSPACE_NOT_FOUND: EXIT_CODES.domainState,
  WORKSPACE_UNAVAILABLE: EXIT_CODES.domainState,
  WORKSPACE_MISMATCH: EXIT_CODES.domainState,
  SESSION_ALREADY_BOUND: EXIT_CODES.domainState,
  RUN_ALREADY_BOUND: EXIT_CODES.domainState,
  BINDING_NOT_FOUND: EXIT_CODES.domainState,
  BINDING_DETACHED: EXIT_CODES.domainState,
  BINDING_CONFLICT: EXIT_CODES.domainState,
  STALE_SESSION_BINDING: EXIT_CODES.domainState,
  RUN_NOT_FOUND: EXIT_CODES.domainState,
  RUN_TERMINAL: EXIT_CODES.domainState,
  INVALID_RUN_TRANSITION: EXIT_CODES.domainState,
  STALE_RUN_REVISION: EXIT_CODES.domainState,
  INVALID_RUN_GOAL: EXIT_CODES.domainState,
  RUN_STATE_INVALID: EXIT_CODES.domainState,
  MEMORY_ARTIFACT_NOT_FOUND: EXIT_CODES.domainState,
  MEMORY_REVISION_NOT_FOUND: EXIT_CODES.domainState,
  MEMORY_REVISION_CONFLICT: EXIT_CODES.domainState,
  MEMORY_REVISION_INVALID: EXIT_CODES.domainState,
  SNAPSHOT_NOT_FOUND: EXIT_CODES.domainState,
  SNAPSHOT_INVALID: EXIT_CODES.domainState,
  SECTION_DAG_INVALID: EXIT_CODES.domainState,
  STALE_MEMORY_HEAD: EXIT_CODES.domainState,
  MEMORY_HEAD_INVALID: EXIT_CODES.domainState,
  PROPOSAL_NOT_FOUND: EXIT_CODES.domainState,
  PROPOSAL_SUPERSEDED: EXIT_CODES.domainState,
  PROPOSAL_HASH_MISMATCH: EXIT_CODES.domainState,
  PROPOSAL_NOT_AWAITING_APPROVAL: EXIT_CODES.domainState,
  PROPOSAL_ALREADY_COMMITTED: EXIT_CODES.domainState,
  PROPOSAL_ALREADY_AWAITING: EXIT_CODES.domainState,
  PROPOSAL_TYPE_UNAVAILABLE: EXIT_CODES.domainState,
  PROPOSAL_INVALID: EXIT_CODES.domainState,
  CAPABILITY_NOT_AVAILABLE: EXIT_CODES.domainState,
  IDEMPOTENCY_CONFLICT: EXIT_CODES.domainState,
  MEMORY_HEAD_UNCOMMITTED: EXIT_CODES.domainState,
  BLOCKING_QUESTION: EXIT_CODES.domainState,
  BLOCKING_CONFLICT: EXIT_CODES.domainState,
  PLAN_COMMIT_CONFLICT: EXIT_CODES.domainState,
  HOST_SECRET_UNAVAILABLE: EXIT_CODES.storageEnvironment,
  ENTRY_INTENT_REQUIRED: EXIT_CODES.domainState,
  ENTRY_INTENT_INVALID: EXIT_CODES.domainState,
  HOST_CONTEXT_REQUIRED: EXIT_CODES.domainState,
  HOST_CONTEXT_INVALID: EXIT_CODES.domainState,
  HOST_CONTEXT_INPUT_MISMATCH: EXIT_CODES.domainState,
  HOST_CONTEXT_TOOL_MISMATCH: EXIT_CODES.domainState,
  HOST_CONTEXT_WORKSPACE_MISMATCH: EXIT_CODES.domainState,
  MCP_INPUT_INVALID: EXIT_CODES.domainState,
  RUN_SELECTION_REQUIRED: EXIT_CODES.domainState,
  TAKEOVER_REQUIRED: EXIT_CODES.domainState,
  PLAN_MODE_REQUIRED: EXIT_CODES.domainState,
  PLAN_MODE_TRANSITION_FAILED: EXIT_CODES.domainState,
  HOOK_INPUT_INVALID: EXIT_CODES.invocation,
};

export function exitCodeForError(code: RuntimeErrorCode): ExitCode {
  return EXIT_CODE_BY_ERROR[code];
}
