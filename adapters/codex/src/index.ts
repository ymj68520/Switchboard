/**
 * Public surface of the Switchboard Codex adapter (Phase 1: session runtime
 * foundation only).
 *
 * Deliberately exported: the session runtime, its types/errors, and the pure
 * endpoint parser. Everything else (Controller, model routing, TUI
 * integration) belongs to later phases and does not exist here yet.
 */

export {
  CodexSessionRuntime,
} from "./runtime/session-runtime.js";
export {
  CodexSessionError,
  isCodexSessionError,
  type CodexSessionErrorCode,
} from "./runtime/errors.js";
export {
  createLoopbackEndpoint,
  DEFAULT_APP_SERVER_ARGS,
  DEFAULT_APP_SERVER_COMMAND,
  DEFAULT_BOOTSTRAP_TIMEOUTS,
  FROZEN_LISTEN_ENDPOINT,
  LOOPBACK_HOST,
  type BootstrapTimeouts,
  type ChildExitStatus,
  type CodexSessionRuntimeConfig,
  type LoopbackEndpoint,
  type ReadyzProbe,
  type RuntimeState,
} from "./runtime/types.js";
export {
  parseLoopbackWsEndpoint,
  scanLoopbackWsEndpoints,
  stripAnsiEscapes,
  type EndpointScanResult,
  type RejectedEndpointCandidate,
} from "./runtime/endpoint-parser.js";
export {
  NodeAppServerProcess,
  nodeAppServerProcessFactory,
  type AppServerProcess,
  type AppServerProcessFactory,
  type SpawnRequest,
} from "./runtime/app-server-process.js";
export { defaultReadyzProbe, isRetryableProbeError } from "./runtime/readyz.js";
