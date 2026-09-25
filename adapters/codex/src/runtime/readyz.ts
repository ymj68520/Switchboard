/**
 * /readyz readiness probing (Architecture SPEC §7.4).
 *
 * Discovery of the endpoint does NOT imply readiness: the runtime polls
 * `GET http://127.0.0.1:<port>/readyz` until HTTP 200. Probe-level failures
 * are classified as retryable (server not accepting yet, attempt timeout)
 * versus fatal (anything else), so a truly broken probe fails fast instead
 * of burning the whole readiness budget.
 */

import type { ReadyzProbe } from "./types.js";

/**
 * Default probe built on global fetch (Node >= 20, no dependencies).
 * Resolves with the HTTP status; network-level failures reject.
 */
export const defaultReadyzProbe: ReadyzProbe = async (endpoint, signal) => {
  const response = await fetch(`${endpoint.httpBaseUrl}/readyz`, {
    signal,
    redirect: "manual",
  });
  try {
    // Drain the body so the socket is released back to the pool.
    await response.arrayBuffer();
  } catch {
    // Body read failures must not mask the status result.
  }
  return response.status;
};

const RETRYABLE_ERRNO = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EPROTO",
]);

/**
 * Retryable = the server is not reachable *yet* or this single attempt timed
 * out (AbortError from our combined signal, TimeoutError from
 * AbortSignal.timeout). Everything else (e.g. ERR_INVALID_URL, injected
 * programming errors) is fatal and must surface immediately.
 */
export function isRetryableProbeError(error: unknown): boolean {
  if (error instanceof Error) {
    if (error.name === "AbortError" || error.name === "TimeoutError") {
      return true;
    }
  }
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    const code = (current as NodeJS.ErrnoException).code;
    if (typeof code === "string" && RETRYABLE_ERRNO.has(code)) {
      return true;
    }
    current = current.cause;
  }
  return false;
}
