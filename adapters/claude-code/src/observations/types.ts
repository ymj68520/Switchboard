/**
 * Observation vocabulary and typed shapes (Phase 9 §5–§7, §14, §19).
 *
 * An Observation is ONE real host tool-result event: automatic, temporary,
 * cheap, NON-authoritative. It has no mutable revision model (§5) — the
 * ledger row is the event. Evidence is a separate, explicit promotion.
 */

export const OBSERVATION_CLASSES = ["source", "locator", "execution"] as const;
export type ObservationClass = (typeof OBSERVATION_CLASSES)[number];

/**
 * Frozen class mapping (§7), grounded in the real host probe (Claude Code
 * 2.1.282 Windows): Read → source; Grep/Glob → locator; the execution tool is
 * named "PowerShell" on this host (Bash is kept for cross-platform hosts).
 * Nothing else is Evidence-capable, and unknown tools are NEVER guessed into
 * a class (§8).
 */
export const EXECUTION_TOOL_NAMES = ["Bash", "PowerShell"] as const;

export type ObservationInputProjection =
  | { kind: "source"; path: string; offset?: number; limit?: number }
  | { kind: "locator"; tool: "Grep" | "Glob"; pattern: string; path?: string; glob?: string }
  | { kind: "execution"; command: string; cwd?: string };

/** Capture-time whole-file fingerprint for static source provenance (§35/§36/§54). */
export interface SourceFingerprint {
  /** Workspace-relative normalized path when under the workspace, else as observed. */
  path: string;
  sha256: string;
  size: number;
  mtimeEpochMs?: number;
}

/** Row-level content types (§16/§19). */
export const PAYLOAD_CONTENT_TYPE_TEXT = "text/plain; charset=utf-8";
export const PAYLOAD_CONTENT_TYPE_BINARY = "application/octet-stream";
export const PAYLOAD_CONTENT_TYPE_OMITTED = "application/x-phase-plan-omitted";

/** §15 sanitization marker for detectable secret-exposure results. */
export const SANITIZED_ENV_DUMP = "env_dump_detected";

/** One PostToolUse-shaped host event handed to capture. */
export interface ObservationCaptureEvent {
  sessionId: string;
  toolName: string;
  toolUseId: string;
  toolInput: Record<string, unknown>;
  toolResponse: unknown;
  /** Host-observed session cwd (attribution context, never authority). */
  cwd?: string;
}

export interface CapturedObservation {
  runId: string;
  workspaceId: string;
  observationId: string;
  observationSeq: number;
  observationClass: ObservationClass;
  toolName: string;
  toolUseId: string;
  input: ObservationInputProjection;
  payloadHash: string | null;
  payloadSize: number | null;
  contentType: string;
  sourceFingerprint: SourceFingerprint | null;
  /** Coarse git HEAD at capture time (§75); null for directory workspaces. */
  repositoryRevision: string | null;
  promotable: boolean;
  sanitized: string | null;
  capturedAt: string;
}

export type CaptureOutcome =
  | { status: "captured" | "duplicate"; observation: CapturedObservation }
  | { status: "skipped"; reason: string };
