/**
 * Loopback WebSocket endpoint discovery parser.
 *
 * Extracts the first VALID `ws://127.0.0.1:<port>` token from app-server
 * startup output (Architecture SPEC §7.3):
 *
 * - no reliance on human-readable prefixes such as "listening on:";
 * - only exact `ws` scheme + exact `127.0.0.1` host qualify (`wss`, other
 *   hosts, hostnames, `0.0.0.0` and port 0 are all rejected by construction);
 * - ANSI escape sequences in the output are stripped before scanning.
 *
 * Tokens that match the ws://127.0.0.1:port shape but violate the port
 * invariants (0, >65535) are recorded as rejected candidates (for
 * diagnostics) and skipped so a later valid token can still be found.
 */

import { createLoopbackEndpoint, type LoopbackEndpoint } from "./types.js";

/** Candidate token of the right shape that violated a port invariant. */
export interface RejectedEndpointCandidate {
  readonly token: string;
  readonly reason: "port_zero" | "port_out_of_range";
}

export interface EndpointScanResult {
  readonly endpoint: LoopbackEndpoint | null;
  readonly rejected: readonly RejectedEndpointCandidate[];
}

/**
 * Strips ANSI escape sequences: CSI (e.g. colors), OSC (window title etc.),
 * and the remaining single-character escape family, so startup banners that
 * are decorated for terminals cannot corrupt token scanning.
 */
export function stripAnsiEscapes(text: string): string {
  return text
    // OSC: ESC ] ... BEL or ESC ] ... ESC \
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    // CSI: ESC [ parameters (0-9;:? space ...) intermediate then final byte
    .replace(/\x1b\[[0-9;:?]*[ -/]*[@-~]/g, "")
    // Remaining two-byte escapes (ESC followed by a feed/esc byte range)
    .replace(/\x1b[@-Z\\-_]/g, "");
}

/**
 * ws://127.0.0.1:<digits> with word boundaries:
 * - not preceded by a word char, `-`, `.` or `/` so tokens embedded in
 *   longer words ("xws://...") or path fragments ("/guides/ws://...") do
 *   not match;
 * - not followed by a digit so the maximal digit run is always the port.
 */
const LOOPBACK_WS_TOKEN = /(?<![\w./-])ws:\/\/127\.0\.0\.1:(\d+)(?!\d)/g;

/**
 * Scan startup output and return the first valid loopback WebSocket
 * endpoint, or null when output contains none.
 */
export function parseLoopbackWsEndpoint(text: string): LoopbackEndpoint | null {
  return scanLoopbackWsEndpoints(text).endpoint;
}

/** Full scan result including rejected near-miss candidates for diagnostics. */
export function scanLoopbackWsEndpoints(text: string): EndpointScanResult {
  const clean = stripAnsiEscapes(text);
  const rejected: RejectedEndpointCandidate[] = [];

  for (const match of clean.matchAll(LOOPBACK_WS_TOKEN)) {
    const rawPort = match[1];
    if (rawPort === undefined) {
      continue;
    }
    const token = match[0];
    const port = Number.parseInt(rawPort, 10);
    const endpoint = createLoopbackEndpoint("127.0.0.1", port);
    if (endpoint !== null) {
      return { endpoint, rejected };
    }
    rejected.push({
      token,
      reason: port === 0 ? "port_zero" : "port_out_of_range",
    });
  }

  return { endpoint: null, rejected };
}
