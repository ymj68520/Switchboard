import type { AppServerProcessFactory } from "./app-server-process.js";

/**
 * Minimal runtime types for the Codex CLI Phase Model Switcher (Phase 1).
 *
 * Phase 1 covers ONLY the session runtime foundation: spawn a session-dedicated
 * `codex app-server` bound to `ws://127.0.0.1:0`, discover the OS-assigned
 * loopback endpoint from startup output, confirm `/readyz == 200`, and provide
 * deterministic shutdown. Model routing, the Controller, WebSocket JSON-RPC,
 * thread tracking and collaboration modes are later phases and deliberately
 * absent here (Architecture SPEC v0.0.1 §14 of the Phase 1 directive, SPEC §3).
 */

/**
 * Readiness probe seam: performs GET /readyz against the endpoint and
 * resolves with the HTTP status code. The default implementation uses
 * global fetch (Node >= 20). Tests may inject a stub.
 */
export type ReadyzProbe = (endpoint: LoopbackEndpoint, signal: AbortSignal) => Promise<number>;

/**
 * The single frozen loopback host for the app-server transport
 * (Architecture SPEC §7.1, invariant A4). No other host is acceptable.
 */
export const LOOPBACK_HOST = "127.0.0.1";

/**
 * Frozen app-server bind endpoint: port 0 forces the OS to assign an
 * ephemeral port (Architecture SPEC §7.2, invariant A5). The launcher never
 * picks or probes candidate ports itself.
 */
export const FROZEN_LISTEN_ENDPOINT = "ws://127.0.0.1:0";

/**
 * Structured value for the discovered app-server endpoint. Kept as parsed
 * fields (not a raw log string) so Phase 2's Controller and Codex TUI can
 * both connect to the exact same explicit endpoint (invariant A3).
 */
export interface LoopbackEndpoint {
  /** Always "127.0.0.1" — anything else is rejected before construction. */
  readonly host: typeof LOOPBACK_HOST;
  /** OS-assigned port, 1..65535, never 0. */
  readonly port: number;
  /** Canonical WebSocket URL, e.g. "ws://127.0.0.1:53142". */
  readonly wsUrl: string;
  /** HTTP base for readiness probes, e.g. "http://127.0.0.1:53142". */
  readonly httpBaseUrl: string;
}

/**
 * Construct a LoopbackEndpoint from validated parts, or return null when the
 * port violates the frozen loopback invariants (host must be 127.0.0.1,
 * port must be a non-zero value within 1..65535).
 */
export function createLoopbackEndpoint(host: string, port: number): LoopbackEndpoint | null {
  if (host !== LOOPBACK_HOST) return null;
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) return null;
  return {
    host: LOOPBACK_HOST,
    port,
    wsUrl: `ws://${LOOPBACK_HOST}:${port}`,
    httpBaseUrl: `http://${LOOPBACK_HOST}:${port}`,
  };
}

/**
 * Runtime state machine (Phase 1 scope):
 *
 *   idle → starting → ready → stopping → stopped
 *              │
 *              └→ failed (bootstrap failure; child always cleaned up)
 *
 * Restart/resume states are intentionally absent: Architecture SPEC §21-22
 * forbids app-server restart, session recovery and transparent resume.
 */
export type RuntimeState =
  | "idle"
  | "starting"
  | "ready"
  | "stopping"
  | "stopped"
  | "failed";

/**
 * How the app-server child process ended. The exit status is preserved so
 * diagnostics can report exactly what happened to the authoritative runtime.
 */
export interface ChildExitStatus {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

/**
 * Minimal configuration actually consumed by the Phase 1 runtime. Model
 * routing configuration (planning_model / execution_model / reasoning_effort)
 * is NOT defined here — Phase 1 does not consume it, and the final
 * configuration surface is frozen in a later implementation phase.
 */
export interface CodexSessionRuntimeConfig {
  /**
   * Executable used to launch the app-server. Defaults to "codex" resolved
   * via PATH. The default args always use the frozen `ws://127.0.0.1:0` bind.
   */
  readonly command?: string;
  /**
   * Overrides are for tests/injection harnesses only; production callers get
   * the frozen default (SPEC §8 step 2).
   */
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeouts?: Partial<BootstrapTimeouts>;
  /** Test seam: replaces real child-process creation. */
  readonly processFactory?: AppServerProcessFactory;
  /** Test seam: replaces the default fetch-based /readyz probe. */
  readonly readyzProbe?: ReadyzProbe;
}

/** Default frozen argv: `codex app-server --listen ws://127.0.0.1:0`. */
export const DEFAULT_APP_SERVER_COMMAND = "codex";
export const DEFAULT_APP_SERVER_ARGS: readonly string[] = [
  "app-server",
  "--listen",
  FROZEN_LISTEN_ENDPOINT,
];

/**
 * Centralized bootstrap/shutdown budgets. Values are implementation details
 * (SPEC §28.5) but must stay defined in one place, not scattered as magic
 * numbers. All are conservative upper bounds; every phase of bootstrap fails
 * fast when its budget elapses.
 */
export interface BootstrapTimeouts {
  /** Max wall-clock time to discover a valid loopback endpoint in output. */
  readonly endpointDiscoveryTimeoutMs: number;
  /** Max wall-clock time for /readyz to return 200 after discovery. */
  readonly readyzTimeoutMs: number;
  /** Delay between /readyz attempts. */
  readonly readyzPollIntervalMs: number;
  /** Per-attempt HTTP timeout for a single /readyz request. */
  readonly readyzRequestTimeoutMs: number;
  /** Grace period after a termination request before forcing the kill. */
  readonly terminateGraceMs: number;
  /** Grace period after the forced kill before declaring shutdown failed. */
  readonly terminateForceGraceMs: number;
}

export const DEFAULT_BOOTSTRAP_TIMEOUTS: BootstrapTimeouts = {
  endpointDiscoveryTimeoutMs: 15_000,
  readyzTimeoutMs: 15_000,
  readyzPollIntervalMs: 250,
  readyzRequestTimeoutMs: 3_000,
  terminateGraceMs: 3_000,
  terminateForceGraceMs: 3_000,
};
