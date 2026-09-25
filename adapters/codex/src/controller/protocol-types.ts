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
  return { threadId, parentThreadId };
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
