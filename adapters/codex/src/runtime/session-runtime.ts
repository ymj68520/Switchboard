/**
 * Codex session runtime — Phase 1 foundation of the Codex CLI Phase Model
 * Switcher.
 *
 * Owns exactly one session-dedicated authoritative `codex app-server` child
 * (Architecture SPEC §5.1, invariant A2):
 *
 *   spawn `codex app-server --listen ws://127.0.0.1:0`
 *     → discover the OS-assigned loopback endpoint from startup output
 *     → poll GET /readyz until HTTP 200
 *     → READY (structured endpoint available for Phase 2 Controller + TUI)
 *     → deterministic shutdown (graceful termination, force fallback)
 *
 * Every bootstrap failure path (early exit, discovery timeout, readiness
 * timeout, fatal probe error, caller abort) terminates and reaps the child
 * before the failure surfaces. There is no restart, no recovery, no daemon
 * reconnect (SPEC §21-22): instances are single-use.
 */

import { BoundedStartupOutput } from "./bounded-output.js";
import { scanLoopbackWsEndpoints, type RejectedEndpointCandidate } from "./endpoint-parser.js";
import { CodexSessionError } from "./errors.js";
import {
  nodeAppServerProcessFactory,
  type AppServerProcess,
  type AppServerProcessFactory,
} from "./app-server-process.js";
import { defaultReadyzProbe, isRetryableProbeError } from "./readyz.js";
import {
  DEFAULT_APP_SERVER_ARGS,
  DEFAULT_APP_SERVER_COMMAND,
  DEFAULT_BOOTSTRAP_TIMEOUTS,
  type BootstrapTimeouts,
  type ChildExitStatus,
  type CodexSessionRuntimeConfig,
  type LoopbackEndpoint,
  type ReadyzProbe,
  type RuntimeState,
} from "./types.js";

/** Bound the stderr excerpt carried inside error details (directive §10). */
const ERROR_OUTPUT_TAIL_CHARS = 4_000;

type BootstrapAbortReason = "caller" | "shutdown";

type ExitWatchOutcome =
  | { kind: "exit"; status: ChildExitStatus }
  | { kind: "spawnError"; error: unknown };

type DiscoveryOutcome =
  | { kind: "endpoint"; endpoint: LoopbackEndpoint }
  | { kind: "exitWatch"; outcome: ExitWatchOutcome }
  | { kind: "deadline" }
  | { kind: "abort"; reason: BootstrapAbortReason };

type ReadinessOutcome =
  | { kind: "probeStatus"; status: number }
  | { kind: "probeFatal"; error: unknown }
  | { kind: "exitWatch"; outcome: ExitWatchOutcome }
  | { kind: "deadline" }
  | { kind: "abort"; reason: BootstrapAbortReason }
  | { kind: "poll" };

export class CodexSessionRuntime {
  private readonly config: CodexSessionRuntimeConfig;
  private readonly timeouts: BootstrapTimeouts;

  private runtimeState: RuntimeState = "idle";
  private discovered: LoopbackEndpoint | null = null;
  private recordedExit: ChildExitStatus | null = null;

  private startPromise: Promise<LoopbackEndpoint> | null = null;
  private shutdownPromise: Promise<ChildExitStatus | null> | null = null;
  private processHandle: AppServerProcess | null = null;
  private exitGuard: (() => void) | null = null;
  private abortBootstrap: ((reason: BootstrapAbortReason) => void) | null = null;
  private rejectedEndpointCandidates: readonly RejectedEndpointCandidate[] = [];

  constructor(config: CodexSessionRuntimeConfig = {}) {
    this.config = config;
    this.timeouts = { ...DEFAULT_BOOTSTRAP_TIMEOUTS, ...config.timeouts };
  }

  get state(): RuntimeState {
    return this.runtimeState;
  }

  /** The discovered endpoint; non-null only once the runtime is READY. */
  get endpoint(): LoopbackEndpoint | null {
    return this.discovered;
  }

  /** Exit status of the app-server child once it has exited, else null. */
  get exitStatus(): ChildExitStatus | null {
    return this.recordedExit;
  }

  /**
   * Bootstrap the session-dedicated app-server to READY. Single-use: only
   * legal from state "idle". Rejects only after the child has been cleaned
   * up.
   */
  async start(options: { signal?: AbortSignal } = {}): Promise<LoopbackEndpoint> {
    if (this.runtimeState !== "idle" || this.startPromise !== null) {
      throw new CodexSessionError(
        "invalid_runtime_state",
        `start() requires a fresh runtime (current state: ${this.runtimeState}); ` +
          "restart is not supported by the frozen architecture",
      );
    }
    this.runtimeState = "starting";
    const bootstrapPromise = this.bootstrap(options.signal);
    this.startPromise = bootstrapPromise;
    // Keep the rejection "handled" even when shutdown() awaits this promise
    // through its own catch instead.
    bootstrapPromise.catch(() => {});
    try {
      const endpoint = await bootstrapPromise;
      this.runtimeState = "ready";
      this.discovered = endpoint;
      return endpoint;
    } catch (error) {
      if (this.runtimeState === "starting") {
        this.runtimeState = "failed";
      }
      throw error;
    }
  }

  /**
   * Deterministic shutdown. Allowed from "starting" (cancels bootstrap) and
   * "ready"; idempotent afterwards. Always terminates the child before
   * resolving; resolves with the preserved exit status.
   */
  async shutdown(): Promise<ChildExitStatus | null> {
    if (this.runtimeState === "idle") {
      throw new CodexSessionError(
        "invalid_runtime_state",
        "shutdown() requires a runtime that was started",
      );
    }
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }
    this.shutdownPromise = this.performShutdown();
    return this.shutdownPromise;
  }

  private async performShutdown(): Promise<ChildExitStatus | null> {
    if (this.runtimeState === "starting") {
      this.abortBootstrap?.("shutdown");
      const startPromise = this.startPromise;
      if (startPromise) {
        await startPromise.catch(() => {});
      }
    } else if (this.runtimeState === "ready") {
      this.runtimeState = "stopping";
    }

    const handle = this.processHandle;
    if (handle !== null) {
      await this.terminateChild(handle);
    }
    this.runtimeState = "stopped";
    this.unregisterExitGuard();
    return this.recordedExit;
  }

  // ------------------------------------------------------------------
  // Bootstrap
  // ------------------------------------------------------------------

  private async bootstrap(callerSignal?: AbortSignal): Promise<LoopbackEndpoint> {
    const factory: AppServerProcessFactory =
      this.config.processFactory ?? nodeAppServerProcessFactory;
    const handle = factory({
      command: this.config.command ?? DEFAULT_APP_SERVER_COMMAND,
      args: this.config.args ?? DEFAULT_APP_SERVER_ARGS,
      cwd: this.config.cwd,
      env: this.config.env,
    });
    this.processHandle = handle;
    this.installExitGuard(handle);

    const abortController = new AbortController();
    this.abortBootstrap = (reason) => abortController.abort(reason);
    const abortSignal = abortController.signal;

    const onCallerAbort = () => abortController.abort("caller");
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });

    const output = new BoundedStartupOutput();

    try {
      // Child exit / spawn-failure watcher. Never rejects, so it is safe to
      // race anywhere. Any exit during bootstrap is an immediate startup
      // failure (directive §5.7 / P1-E8).
      const exitWatch = handle.exits.then(
        (status): ExitWatchOutcome => {
          this.recordedExit = status;
          return { kind: "exit", status };
        },
        (error): ExitWatchOutcome => ({ kind: "spawnError", error }),
      );

      // Drain both startup streams and scan for the endpoint. Draining keeps
      // running until the streams close so the child can never block on a
      // full stdio pipe.
      const endpointFound = this.watchOutput(handle, output);

      // ---- Phase A: endpoint discovery --------------------------------
      const discovery = await this.awaitDiscovery(endpointFound, exitWatch, abortSignal);
      switch (discovery.kind) {
        case "endpoint":
          break;
        case "abort":
          return await this.failBootstrap(handle, abortedError(discovery.reason), output);
        case "exitWatch":
          return await this.failBootstrap(
            handle,
            exitWatchFailure(discovery.outcome, "exited_before_endpoint", output),
            output,
          );
        case "deadline":
          return await this.failBootstrap(
            handle,
            new CodexSessionError(
              "endpoint_not_discovered",
              "No valid ws://127.0.0.1:<port> endpoint appeared in app-server startup " +
                `output within ${this.timeouts.endpointDiscoveryTimeoutMs}ms`,
              this.bootstrapDetail(output),
            ),
            output,
          );
      }

      const endpoint = discovery.endpoint;

      // ---- Phase B: readiness ------------------------------------------
      const readiness = await this.awaitReadiness(endpoint, exitWatch, abortSignal);
      switch (readiness.kind) {
        case "probeStatus":
          return endpoint;
        case "probeFatal":
          return await this.failBootstrap(
            handle,
            new CodexSessionError(
              "readyz_failed",
              `Readiness probe against ${endpoint.httpBaseUrl}/readyz failed fatally`,
              {
                ...this.bootstrapDetail(output),
                probeError: describeError(readiness.error),
              },
            ),
            output,
          );
        case "exitWatch":
          return await this.failBootstrap(
            handle,
            exitWatchFailure(readiness.outcome, "exited_before_readyz", output),
            output,
          );
        case "deadline":
        case "poll":
          return await this.failBootstrap(
            handle,
            new CodexSessionError(
              "readyz_timeout",
              `GET ${endpoint.httpBaseUrl}/readyz did not return HTTP 200 within ` +
                `${this.timeouts.readyzTimeoutMs}ms`,
              this.bootstrapDetail(output),
            ),
            output,
          );
        case "abort":
          return await this.failBootstrap(handle, abortedError(readiness.reason), output);
        default: {
          // Compile-time exhaustiveness check; never reached at runtime.
          const exhaustive: never = readiness;
          throw new CodexSessionError(
            "invalid_runtime_state",
            `Unreachable readiness outcome: ${String(exhaustive)}`,
          );
        }
      }
    } finally {
      callerSignal?.removeEventListener("abort", onCallerAbort);
      this.abortBootstrap = null;
    }
  }

  /** Drain stderr+stdout, resolving with the first valid loopback endpoint. */
  private watchOutput(
    handle: AppServerProcess,
    output: BoundedStartupOutput,
  ): Promise<LoopbackEndpoint> {
    let settled = false;
    let resolveEndpoint: ((endpoint: LoopbackEndpoint) => void) | null = null;

    const found = new Promise<LoopbackEndpoint>((resolve) => {
      resolveEndpoint = resolve;
    });

    const scan = (): void => {
      if (settled || resolveEndpoint === null) {
        return;
      }
      const result = scanLoopbackWsEndpoints(output.text());
      this.rejectedEndpointCandidates = result.rejected;
      if (result.endpoint !== null) {
        settled = true;
        resolveEndpoint(result.endpoint);
      }
    };

    const drain = async (stream: AsyncIterable<string>): Promise<void> => {
      for await (const chunk of stream) {
        output.append(chunk);
        scan();
      }
    };

    // Stream errors (e.g. child death mid-read) surface through the exit
    // watcher; draining just ends here.
    void Promise.allSettled([drain(handle.stderrStream()), drain(handle.stdoutStream())]);

    return found;
  }

  private async awaitDiscovery(
    endpointFound: Promise<LoopbackEndpoint>,
    exitWatch: Promise<ExitWatchOutcome>,
    abortSignal: AbortSignal,
  ): Promise<DiscoveryOutcome> {
    const deadlinePromise = timerPromise(this.timeouts.endpointDiscoveryTimeoutMs);
    const abortPromise = abortPromiseOf(abortSignal);

    const discovery = await Promise.race([
      endpointFound.then((endpoint): DiscoveryOutcome => ({ kind: "endpoint", endpoint })),
      exitWatch.then((outcome): DiscoveryOutcome => ({ kind: "exitWatch", outcome })),
      deadlinePromise.then((): DiscoveryOutcome => ({ kind: "deadline" })),
      abortPromise.then((reason): DiscoveryOutcome => ({ kind: "abort", reason })),
    ]);
    deadlinePromise.clear();
    return discovery;
  }

  private async awaitReadiness(
    endpoint: LoopbackEndpoint,
    exitWatch: Promise<ExitWatchOutcome>,
    abortSignal: AbortSignal,
  ): Promise<ReadinessOutcome> {
    const probe = this.config.readyzProbe ?? defaultReadyzProbe;
    const readyDeadline = Date.now() + this.timeouts.readyzTimeoutMs;
    const abortPromise = abortPromiseOf(abortSignal);

    while (true) {
      const remainingMs = readyDeadline - Date.now();
      if (remainingMs <= 0) {
        return { kind: "deadline" };
      }
      const deadlinePromise = timerPromise(remainingMs);

      const outcome: ReadinessOutcome = await Promise.race([
        exitWatch.then((o): ReadinessOutcome => ({ kind: "exitWatch", outcome: o })),
        this.attemptProbe(probe, endpoint, abortSignal),
        deadlinePromise.then((): ReadinessOutcome => ({ kind: "deadline" })),
        abortPromise.then((reason): ReadinessOutcome => ({ kind: "abort", reason })),
      ]);
      deadlinePromise.clear();

      if (outcome.kind === "probeStatus") {
        if (outcome.status === 200) {
          return outcome;
        }
        // Server reachable but not ready yet — fall through to the
        // poll-interval wait and try again.
      } else if (outcome.kind !== "poll") {
        return outcome;
      }

      // Poll-interval wait, still observing exit/abort/deadline.
      const intervalPromise = timerPromise(this.timeouts.readyzPollIntervalMs);
      const waitOutcome = await Promise.race([
        exitWatch.then((o): ReadinessOutcome => ({ kind: "exitWatch", outcome: o })),
        deadlinePromise.then((): ReadinessOutcome => ({ kind: "deadline" })),
        abortPromise.then((reason): ReadinessOutcome => ({ kind: "abort", reason })),
        intervalPromise.then((): ReadinessOutcome => ({ kind: "poll" })),
      ]);
      deadlinePromise.clear();
      intervalPromise.clear();
      if (waitOutcome.kind !== "poll") {
        return waitOutcome;
      }
    }
  }

  private async attemptProbe(
    probe: ReadyzProbe,
    endpoint: LoopbackEndpoint,
    bootstrapSignal: AbortSignal,
  ): Promise<ReadinessOutcome> {
    const perAttemptSignal = AbortSignal.any([
      bootstrapSignal,
      AbortSignal.timeout(this.timeouts.readyzRequestTimeoutMs),
    ]);
    try {
      const status = await probe(endpoint, perAttemptSignal);
      // Server reachable: 200 is ready; anything else is "not ready yet".
      return { kind: "probeStatus", status };
    } catch (error) {
      if (isRetryableProbeError(error)) {
        return { kind: "poll" };
      }
      return { kind: "probeFatal", error };
    }
  }

  // ------------------------------------------------------------------
  // Failure & cleanup
  // ------------------------------------------------------------------

  /**
   * Terminate and reap the child, then surface `error`. If cleanup itself
   * fails, the cleanup failure wins (a lingering child is the worse
   * outcome); the original bootstrap failure is preserved in its detail.
   */
  private async failBootstrap(
    handle: AppServerProcess,
    error: CodexSessionError,
    output: BoundedStartupOutput,
  ): Promise<never> {
    try {
      await this.terminateChild(handle);
    } catch (cleanupError) {
      throw new CodexSessionError(
        "shutdown_failed",
        "App-server cleanup failed during bootstrap failure handling; " +
          "the child may still be running",
        {
          bootstrapFailure: { code: error.code, message: error.message },
          cleanup: describeError(cleanupError),
          outputTail: output.tail(ERROR_OUTPUT_TAIL_CHARS),
        },
      );
    }
    throw error;
  }

  /**
   * Deterministic termination ladder: request termination → wait for exit
   * → force kill → wait for exit → shutdown_failed. Terminating an already
   * dead child is a harmless no-op, and the pending exit race then resolves
   * immediately, so this is safe to call on any handle.
   */
  private async terminateChild(handle: AppServerProcess): Promise<ChildExitStatus | null> {
    const exitSettled = (): Promise<boolean> =>
      handle.exits.then(
        () => true,
        () => true,
      );

    handle.requestTerminate();
    const graceful = await Promise.race([
      exitSettled(),
      timerPromise(this.timeouts.terminateGraceMs, false),
    ]);
    if (graceful) {
      return this.recordedExit;
    }

    handle.forceKill();
    const forced = await Promise.race([
      exitSettled(),
      timerPromise(this.timeouts.terminateForceGraceMs, false),
    ]);
    if (forced) {
      return this.recordedExit;
    }

    throw new CodexSessionError(
      "shutdown_failed",
      `App-server child (pid ${handle.pid ?? "unknown"}) did not exit after ` +
        `termination request, force kill and ${this.timeouts.terminateForceGraceMs}ms`,
    );
  }

  // ------------------------------------------------------------------
  // Orphan guard
  // ------------------------------------------------------------------

  /**
   * Best-effort synchronous guard: if the launcher process itself exits
   * while the app-server is still running, kill the child so no managed
   * orphan survives a normal launcher death. (An OS-level hard kill of the
   * launcher cannot be intercepted by any supervisor.)
   */
  private installExitGuard(handle: AppServerProcess): void {
    const guard = (): void => {
      if (process.platform !== "win32" && handle.pid !== undefined) {
        try {
          process.kill(-handle.pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
      handle.killImmediate();
    };
    process.once("exit", guard);
    this.exitGuard = guard;
  }

  private unregisterExitGuard(): void {
    if (this.exitGuard !== null) {
      process.off("exit", this.exitGuard);
      this.exitGuard = null;
    }
  }

  private bootstrapDetail(output: BoundedStartupOutput): Record<string, unknown> {
    const detail: Record<string, unknown> = {
      outputTail: output.tail(ERROR_OUTPUT_TAIL_CHARS),
    };
    if (this.rejectedEndpointCandidates.length > 0) {
      detail.rejectedEndpointCandidates = this.rejectedEndpointCandidates;
    }
    return detail;
  }
}

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------

function exitWatchFailure(
  outcome: ExitWatchOutcome,
  code: "exited_before_endpoint" | "exited_before_readyz",
  output: BoundedStartupOutput,
): CodexSessionError {
  if (outcome.kind === "spawnError") {
    return spawnFailure(outcome.error);
  }
  return new CodexSessionError(
    code,
    `App-server exited during bootstrap (${describeExit(outcome.status)})`,
    { exit: outcome.status, outputTail: output.tail(ERROR_OUTPUT_TAIL_CHARS) },
  );
}

function spawnFailure(error: unknown): CodexSessionError {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOENT") {
    return new CodexSessionError(
      "codex_executable_unavailable",
      "The codex executable could not be found; install the Codex CLI or configure " +
        "CodexSessionRuntimeConfig.command",
      { spawnError: describeError(error) },
    );
  }
  return new CodexSessionError("spawn_failed", "The codex app-server process could not be spawned", {
    spawnError: describeError(error),
  });
}

function abortedError(reason: BootstrapAbortReason): CodexSessionError {
  return new CodexSessionError(
    "startup_aborted",
    reason === "shutdown"
      ? "Bootstrap aborted because shutdown() was requested while starting"
      : "Bootstrap aborted by the caller's AbortSignal",
  );
}

function describeExit(status: ChildExitStatus): string {
  if (status.signal !== null) {
    return `terminated by signal ${status.signal}`;
  }
  return `exit code ${status.exitCode}`;
}

function describeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const described: Record<string, unknown> = { name: error.name, message: error.message };
    const code = (error as NodeJS.ErrnoException).code;
    if (typeof code === "string") {
      described.code = code;
    }
    return described;
  }
  return { value: String(error) };
}

interface ClearablePromise<T> extends Promise<T> {
  clear(): void;
}

/** Resolves after `ms` with `value`; the timer keeps running until cleared. */
function timerPromise<T>(ms: number, value?: T): ClearablePromise<T> {
  let timer: NodeJS.Timeout | undefined;
  const promise = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(value as T), ms);
  }) as ClearablePromise<T>;
  promise.clear = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  return promise;
}

function abortPromiseOf(signal: AbortSignal): Promise<BootstrapAbortReason> {
  return new Promise<BootstrapAbortReason>((resolve) => {
    if (signal.aborted) {
      resolve(signal.reason as BootstrapAbortReason);
      return;
    }
    signal.addEventListener("abort", () => resolve(signal.reason as BootstrapAbortReason), {
      once: true,
    });
  });
}
