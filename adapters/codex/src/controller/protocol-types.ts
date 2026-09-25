/**
 * Narrow protocol views of the Codex app-server surface used by the Model
 * Controller (Phase 2).
 *
 * These are deliberately NOT a vendored Codex schema (Phase 2 directive §31):
 * the controller consumes a tiny subset of the experimental API, so each
 * notification is validated at runtime into a narrow view and unknown fields
 * are tolerated. Divergence is classified explicitly:
 *
 * - structural malformation of a REQUIRED notification → controller failure;
 * - a recognized-but-unknown collaboration mode value → explicit unsupported
 *   mode (never guessed to Default/Plan — Architecture SPEC §13);
 * - unrelated fields / unknown notifications → ignored upstream noise.
 *
 * Empirical protocol facts this encodes (verified against codex-cli 0.156.1):
 * - `thread/started` params: `{ thread: { id, parentThreadId, ... } }`;
 * - `thread/settings/updated` params: `{ threadId, threadSettings:
 *   { ..., collaborationMode: { mode, settings } } }` where `mode` is
 *   "default" | "plan" (snake_case ModeKind);
 * - initialize result carries diagnostics only: `{ userAgent, codexHome,
 *   platformFamily, platformOs }` (no serverInfo object on this version).
 */

/** The only collaboration modes the switcher recognizes (SPEC §13). */
export type CollaborationModeKind = "default" | "plan";

/** Narrow view of `thread/started`. */
export interface ThreadStartedView {
  readonly threadId: string;
  /** null/undefined ⇒ top-level thread; anything else ⇒ child/subagent. */
  readonly parentThreadId: string | null;
  /**
   * Codex thread metadata (Phase 5 empirical payloads, 0.156.1): `ephemeral`
   * threads are internal runtime helpers (observed: TUI thread-title
   * generation) that never persist a rollout. Absent field ⇒ not ephemeral.
   */
  readonly ephemeral: boolean;
  /**
   * Exact thread origin declared by Codex. Observed values: "user" for the
   * TUI's conversation thread, "thread_title" for its internal title
   * generator. null when the server omits the field (tolerant reading).
   */
  readonly threadSource: string | null;
}

/**
 * Narrow view of `thread/settings/updated`. `unsupportedMode` carries the
 * raw value for diagnostics — it must never be mapped onto a known mode.
 */
export type ThreadSettingsUpdatedView =
  | { kind: "ok"; threadId: string; mode: CollaborationModeKind }
  | { kind: "unsupportedMode"; threadId: string | null; rawMode: unknown }
  | { kind: "malformed" };

/** Diagnostics-only subset of the initialize result (SPEC §19: never a gate). */
export interface ServerInfoView {
  readonly userAgent?: unknown;
  readonly codexHome?: unknown;
  readonly platformFamily?: unknown;
  readonly platformOs?: unknown;
}

/** Parse a ModeKind wire value; null = unrecognized (never guessed). */
export function parseModeKind(value: unknown): CollaborationModeKind | null {
  if (value === "default" || value === "plan") {
    return value;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Tolerant reader for `thread/started`. Returns null when required fields
 * (params.thread.id) are missing — a malformed required notification.
 */
export function parseThreadStarted(params: unknown): ThreadStartedView | null {
  if (!isRecord(params) || !isRecord(params.thread)) {
    return null;
  }
  const threadId = asNonEmptyString(params.thread.id);
  if (threadId === null) {
    return null;
  }
  const rawParent = params.thread.parentThreadId;
  const parentThreadId = typeof rawParent === "string" ? rawParent : null;
  const ephemeral = params.thread.ephemeral === true;
  const threadSource =
    typeof params.thread.threadSource === "string" && params.thread.threadSource.length > 0
      ? params.thread.threadSource
      : null;
  return { threadId, parentThreadId, ephemeral, threadSource };
}

/**
 * Tolerant reader for `thread/settings/updated`. Missing required structure
 * (threadId, collaborationMode object) → "malformed"; a present-but-unknown
 * mode string → "unsupportedMode" (explicit, never mapped).
 */
export function parseThreadSettingsUpdated(params: unknown): ThreadSettingsUpdatedView {
  if (!isRecord(params)) {
    return { kind: "malformed" };
  }
  const threadId = asNonEmptyString(params.threadId);
  if (threadId === null || !isRecord(params.threadSettings)) {
    return { kind: "malformed" };
  }
  const collaborationMode = params.threadSettings.collaborationMode;
  if (!isRecord(collaborationMode)) {
    return { kind: "malformed" };
  }
  const mode = parseModeKind(collaborationMode.mode);
  if (mode !== null) {
    return { kind: "ok", threadId, mode };
  }
  return { kind: "unsupportedMode", threadId, rawMode: collaborationMode.mode };
}

/**
 * Tolerant reader for the initialize result. Returns null only when the
 * result is not an object at all; individual diagnostic fields stay optional.
 */
export function parseInitializeResult(result: unknown): ServerInfoView | null {
  if (!isRecord(result)) {
    return null;
  }
  return {
    userAgent: result.userAgent,
    codexHome: result.codexHome,
    platformFamily: result.platformFamily,
    platformOs: result.platformOs,
  };
}

// ---------------------------------------------------------------------------
// Phase 3: subscription reconciliation surfaces
// ---------------------------------------------------------------------------

/** Narrow view of `thread/status/changed` (empirical 0.156.1 shape). */
export interface ThreadStatusChangedView {
  readonly threadId: string;
  /** e.g. "idle" | "active" | "notLoaded" | "systemError". */
  readonly statusType: string;
}

/**
 * Tolerant reader for `thread/status/changed`. This notification is an
 * AUXILIARY input (it only drives pending-subscription retries — directive
 * §11), so structural drift here is safe-ignored by the caller, not fatal.
 */
export function parseThreadStatusChanged(params: unknown): ThreadStatusChangedView | null {
  if (!isRecord(params)) {
    return null;
  }
  const threadId = asNonEmptyString(params.threadId);
  if (threadId === null || !isRecord(params.status)) {
    return null;
  }
  const statusType = asNonEmptyString(params.status.type);
  if (statusType === null) {
    return null;
  }
  return { threadId, statusType };
}

/** Collaboration-mode snapshot carried by a `thread/resume` response. */
export type ResumeModeSnapshotView =
  | { kind: "ok"; mode: CollaborationModeKind }
  | { kind: "absent" }
  | { kind: "unsupported"; rawMode: unknown };

/**
 * Tolerant reader for the effective collaboration mode in a successful
 * `thread/resume` response. On codex 0.156.1 the field lives at the TOP
 * LEVEL of the response (`result.collaborationMode.mode`); the thread
 * summary object does not carry it. Absent → stay subscribed and wait for
 * `thread/settings/updated` — never guess Default (directive §8).
 */
export function parseResumeModeSnapshot(result: unknown): ResumeModeSnapshotView {
  if (!isRecord(result)) {
    return { kind: "absent" };
  }
  const container = isRecord(result.collaborationMode)
    ? result.collaborationMode
    : isRecord(result.threadSettings) && isRecord(result.threadSettings.collaborationMode)
      ? result.threadSettings.collaborationMode
      : null;
  if (container === null || !("mode" in container)) {
    return { kind: "absent" };
  }
  const mode = parseModeKind(container.mode);
  if (mode !== null) {
    return { kind: "ok", mode };
  }
  return { kind: "unsupported", rawMode: container.mode };
}
