import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  CodexSessionError,
  CodexSessionRuntime,
  DEFAULT_APP_SERVER_ARGS,
  DEFAULT_APP_SERVER_COMMAND,
  isCodexSessionError,
  type AppServerProcess,
  type AppServerProcessFactory,
  type ChildExitStatus,
  type SpawnRequest,
} from "../src/index.js";
import type { BootstrapTimeouts } from "../src/runtime/types.js";

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------

const TEST_TIMEOUTS: BootstrapTimeouts = {
  endpointDiscoveryTimeoutMs: 2_000,
  readyzTimeoutMs: 2_000,
  readyzPollIntervalMs: 25,
  readyzRequestTimeoutMs: 500,
  terminateGraceMs: 500,
  terminateForceGraceMs: 2_000,
};

/** The child pid lives behind the private handle; tests read it directly. */
function childPid(runtime: CodexSessionRuntime): number | undefined {
  return (runtime as unknown as { processHandle?: { pid?: number } }).processHandle?.pid;
}

interface ReadyzServer {
  port: number;
  requestCount(): number;
  setAlwaysFailing(): void;
  close(): Promise<void>;
}

/** Real HTTP server on 127.0.0.1:0 (OS-assigned port, like the app-server). */
async function startReadyzServer(
  responder: (req: number) => { status: number } = () => ({ status: 200 }),
): Promise<ReadyzServer> {
  let count = 0;
  let alwaysFail = false;
  const server: Server = createServer((req, res) => {
    count += 1;
    const status = alwaysFail ? 503 : responder(count).status;
    res.statusCode = status;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    requestCount: () => count,
    setAlwaysFailing: () => {
      alwaysFail = true;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** A stand-in "app-server" child: prints lines to stderr, then idles or exits. */
function fakeAppServerScript(lines: string[], exitAfterMs: number | null): string {
  const idle = "setInterval(() => {}, 60_000);";
  const exit = `setTimeout(() => process.exit(0), ${exitAfterMs ?? 0});`;
  return [
    `const lines = ${JSON.stringify(lines)};`,
    `for (const line of lines) process.stderr.write(line + "\\n");`,
    exitAfterMs === null ? idle : exit,
  ].join("\n");
}

function fakeAppServerRuntime(
  lines: string[],
  overrides: { exitAfterMs?: number | null; timeouts?: Partial<BootstrapTimeouts> } = {},
): CodexSessionRuntime {
  return new CodexSessionRuntime({
    command: process.execPath,
    args: ["-e", fakeAppServerScript(lines, overrides.exitAfterMs ?? null)],
    env: { ...process.env },
    timeouts: { ...TEST_TIMEOUTS, ...overrides.timeouts },
  });
}

async function expectProcessDead(pid: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`child process ${pid} is still alive after cleanup`);
}

async function expectCodexError<T>(
  promise: Promise<T>,
  code: CodexSessionError["code"],
): Promise<CodexSessionError> {
  try {
    await promise;
  } catch (error) {
    expect(isCodexSessionError(error)).toBe(true);
    const codexError = error as CodexSessionError;
    expect(codexError.code).toBe(code);
    return codexError;
  }
  throw new Error(`expected promise to reject with ${code}`);
}

/** Controllable fake used to exercise the termination ladder precisely. */
class LadderFakeProcess implements AppServerProcess {
  readonly pid = 424_242;
  readonly exits: Promise<ChildExitStatus>;
  readonly spawnRequest: SpawnRequest;
  readonly calls: string[] = [];

  private settle: ((status: ChildExitStatus) => void) | null = null;

  constructor(
    private readonly options: { dieOnTerminate?: boolean; dieOnForce?: boolean },
    spawnRequest: SpawnRequest,
  ) {
    this.spawnRequest = spawnRequest;
    this.exits = new Promise<ChildExitStatus>((resolve) => {
      this.settle = resolve;
    });
  }

  private die(signal: "SIGTERM" | "SIGKILL"): void {
    this.settle?.({ exitCode: null, signal });
    this.settle = null;
  }

  stderrStream(): AsyncIterable<string> {
    return (async function* () {
      yield "ws://127.0.0.1:41111\n";
    })();
  }

  stdoutStream(): AsyncIterable<string> {
    return (async function* () {})();
  }

  requestTerminate(): void {
    this.calls.push("requestTerminate");
    if (this.options.dieOnTerminate) {
      this.die("SIGTERM");
    }
  }

  forceKill(): void {
    this.calls.push("forceKill");
    if (this.options.dieOnForce) {
      this.die("SIGKILL");
    }
  }

  killImmediate(): void {
    this.calls.push("killImmediate");
  }
}

function ladderFactory(
  options: { dieOnTerminate?: boolean; dieOnForce?: boolean },
  captured: { process?: LadderFakeProcess },
): AppServerProcessFactory {
  return (request) => {
    const proc = new LadderFakeProcess(options, request);
    captured.process = proc;
    return proc;
  };
}

// ----------------------------------------------------------------------
// Bootstrap success paths (§12.2)
// ----------------------------------------------------------------------

describe("CodexSessionRuntime bootstrap", () => {
  const servers: ReadyzServer[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await server.close();
    }
  });

  it("discovers the endpoint, passes /readyz and reaches Ready", { timeout: 15_000 }, async () => {
    const readyz = await startReadyzServer();
    servers.push(readyz);
    const runtime = fakeAppServerRuntime([`listening on: ws://127.0.0.1:${readyz.port}`]);

    const endpoint = await runtime.start();

    expect(runtime.state).toBe("ready");
    expect(endpoint.host).toBe("127.0.0.1");
    expect(endpoint.port).toBe(readyz.port);
    expect(endpoint.wsUrl).toBe(`ws://127.0.0.1:${readyz.port}`);
    expect(endpoint.httpBaseUrl).toBe(`http://127.0.0.1:${readyz.port}`);
    expect(runtime.endpoint).toEqual(endpoint);

    await runtime.shutdown();
    expect(runtime.state).toBe("stopped");
  });

  it("polls /readyz until it returns 200 (discovery alone is not ready)", { timeout: 15_000 }, async () => {
    const readyz = await startReadyzServer((n) => ({ status: n < 3 ? 503 : 200 }));
    servers.push(readyz);
    const runtime = fakeAppServerRuntime([`ws://127.0.0.1:${readyz.port}`]);

    await runtime.start();

    expect(runtime.state).toBe("ready");
    expect(readyz.requestCount()).toBeGreaterThanOrEqual(3);

    await runtime.shutdown();
  });

  it("skips invalid endpoint tokens and accepts the later valid one", { timeout: 15_000 }, async () => {
    const readyz = await startReadyzServer();
    servers.push(readyz);
    const runtime = fakeAppServerRuntime([
      "rejected: ws://127.0.0.1:0",
      `accepted: ws://127.0.0.1:${readyz.port}`,
    ]);

    const endpoint = await runtime.start();
    expect(endpoint.port).toBe(readyz.port);

    await runtime.shutdown();
  });

  it("spawns the frozen default argv when no override is configured", { timeout: 15_000 }, async () => {
    let capturedRequest: SpawnRequest | undefined;
    const factory: AppServerProcessFactory = (request) => {
      capturedRequest = request;
      return {
        pid: undefined,
        exits: Promise.resolve({ exitCode: 0, signal: null }),
        stderrStream: () => (async function* () {})(),
        stdoutStream: () => (async function* () {})(),
        requestTerminate: () => {},
        forceKill: () => {},
        killImmediate: () => {},
      };
    };
    const runtime = new CodexSessionRuntime({ processFactory: factory });

    // The fake child "exits" with code 0 immediately → exited_before_endpoint,
    // but the spawn request is captured first.
    await expectCodexError(runtime.start(), "exited_before_endpoint");

    expect(capturedRequest?.command).toBe("codex");
    expect(capturedRequest?.args).toEqual(DEFAULT_APP_SERVER_ARGS);
    expect(DEFAULT_APP_SERVER_ARGS).toEqual(["app-server", "--listen", "ws://127.0.0.1:0"]);
    expect(DEFAULT_APP_SERVER_COMMAND).toBe("codex");
  });
});

// ----------------------------------------------------------------------
// Bootstrap failure paths (§12.3) + cleanup after failure (§12.4)
// ----------------------------------------------------------------------

describe("CodexSessionRuntime failure paths", () => {
  const servers: ReadyzServer[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await server.close();
    }
  });

  it("fails immediately when the child exits before the endpoint appears", { timeout: 15_000 }, async () => {
    const runtime = new CodexSessionRuntime({
      command: process.execPath,
      args: ["-e", 'process.stderr.write("dying soon\\n"); process.exit(7);'],
      env: { ...process.env },
      timeouts: TEST_TIMEOUTS,
    });

    const error = await expectCodexError(runtime.start(), "exited_before_endpoint");
    expect((error.detail?.exit as ChildExitStatus)?.exitCode).toBe(7);
    expect(String(error.detail?.outputTail)).toContain("dying soon");
    expect(runtime.state).toBe("failed");
    expect(runtime.endpoint).toBeNull();
  });

  it("fails when the child exits after discovery but before /readyz succeeds", { timeout: 15_000 }, async () => {
    const readyz = await startReadyzServer(() => ({ status: 503 }));
    servers.push(readyz);
    const runtime = new CodexSessionRuntime({
      command: process.execPath,
      args: [
        "-e",
        [
          `process.stderr.write("ws://127.0.0.1:${readyz.port}\\n");`,
          "setTimeout(() => process.exit(3), 80);",
        ].join("\n"),
      ],
      env: { ...process.env },
      timeouts: { ...TEST_TIMEOUTS, readyzTimeoutMs: 5_000, readyzPollIntervalMs: 40 },
    });

    await expectCodexError(runtime.start(), "exited_before_readyz");
    expect(runtime.state).toBe("failed");
  });

  it("fails with endpoint_not_discovered when only garbage is printed, and cleans up the child", { timeout: 15_000 }, async () => {
    const runtime = fakeAppServerRuntime(["just some log line"], {
      timeouts: { endpointDiscoveryTimeoutMs: 300 },
    });

    const startPromise = runtime.start();
    const pid = childPid(runtime);
    await expectCodexError(startPromise, "endpoint_not_discovered");
    expect(runtime.state).toBe("failed");

    if (typeof pid === "number") {
      await expectProcessDead(pid);
    }
  });

  it("records rejected endpoint candidates on discovery timeout", { timeout: 15_000 }, async () => {
    const runtime = new CodexSessionRuntime({
      command: process.execPath,
      args: [
        "-e",
        ['process.stderr.write("ws://127.0.0.1:0\\n");', "setInterval(() => {}, 60_000);"].join(
          "\n",
        ),
      ],
      env: { ...process.env },
      timeouts: { ...TEST_TIMEOUTS, endpointDiscoveryTimeoutMs: 300 },
    });

    const startPromise = runtime.start();
    const pid = childPid(runtime);
    const error = await expectCodexError(startPromise, "endpoint_not_discovered");
    expect(error.detail?.rejectedEndpointCandidates).toEqual([
      { token: "ws://127.0.0.1:0", reason: "port_zero" },
    ]);

    if (typeof pid === "number") {
      await expectProcessDead(pid);
    }
  });

  it("fails with readyz_timeout when /readyz never returns 200, and cleans up the child", { timeout: 15_000 }, async () => {
    const readyz = await startReadyzServer();
    readyz.setAlwaysFailing();
    servers.push(readyz);
    const runtime = fakeAppServerRuntime([`ws://127.0.0.1:${readyz.port}`], {
      timeouts: { readyzTimeoutMs: 400 },
    });

    const startPromise = runtime.start();
    const pid = childPid(runtime);
    await expectCodexError(startPromise, "readyz_timeout");
    expect(runtime.state).toBe("failed");

    if (typeof pid === "number") {
      await expectProcessDead(pid);
    }
  });

  it("fails fast on a fatal probe error", { timeout: 15_000 }, async () => {
    const runtime = new CodexSessionRuntime({
      command: process.execPath,
      args: ["-e", fakeAppServerScript(["ws://127.0.0.1:41112"], null)],
      env: { ...process.env },
      timeouts: TEST_TIMEOUTS,
      readyzProbe: async () => {
        throw new RangeError("injected fatal probe failure");
      },
    });

    const startPromise = runtime.start();
    const pid = childPid(runtime);
    const error = await expectCodexError(startPromise, "readyz_failed");
    expect((error.detail?.probeError as Record<string, unknown>)?.message).toBe(
      "injected fatal probe failure",
    );

    if (typeof pid === "number") {
      await expectProcessDead(pid);
    }
  });

  it("reports an unavailable codex executable as codex_executable_unavailable", { timeout: 15_000 }, async () => {
    const runtime = new CodexSessionRuntime({
      command: "definitely-not-a-real-codex-binary",
      timeouts: TEST_TIMEOUTS,
    });

    await expectCodexError(runtime.start(), "codex_executable_unavailable");
    expect(runtime.state).toBe("failed");
  });

  it("aborts bootstrap when the caller's AbortSignal fires, and cleans up", { timeout: 15_000 }, async () => {
    const readyz = await startReadyzServer(() => ({ status: 503 }));
    servers.push(readyz);
    const runtime = fakeAppServerRuntime([`ws://127.0.0.1:${readyz.port}`]);
    const controller = new AbortController();

    const startPromise = runtime.start({ signal: controller.signal });
    const pid = childPid(runtime);
    setTimeout(() => controller.abort(), 150);

    await expectCodexError(startPromise, "startup_aborted");
    expect(runtime.state).toBe("failed");

    if (typeof pid === "number") {
      await expectProcessDead(pid);
    }
  });

  it("rejects a second start() while running or after use", { timeout: 15_000 }, async () => {
    const readyz = await startReadyzServer();
    servers.push(readyz);
    const runtime = fakeAppServerRuntime([`ws://127.0.0.1:${readyz.port}`]);

    await runtime.start();
    await expectCodexError(runtime.start(), "invalid_runtime_state");

    await runtime.shutdown();
    await expectCodexError(runtime.start(), "invalid_runtime_state");
  });

  it("rejects shutdown() before start()", async () => {
    const runtime = new CodexSessionRuntime({});
    await expectCodexError(runtime.shutdown(), "invalid_runtime_state");
  });
});

// ----------------------------------------------------------------------
// Shutdown / cleanup (§12.4)
// ----------------------------------------------------------------------

describe("CodexSessionRuntime shutdown", () => {
  it("cleans up the child on normal shutdown and preserves the exit status", { timeout: 15_000 }, async () => {
    const readyz = await startReadyzServer();
    const runtime = fakeAppServerRuntime([`ws://127.0.0.1:${readyz.port}`]);

    await runtime.start();
    expect(runtime.state).toBe("ready");
    const pid = childPid(runtime);

    await runtime.shutdown();

    expect(runtime.state).toBe("stopped");
    expect(runtime.exitStatus).not.toBeNull();
    if (typeof pid === "number") {
      await expectProcessDead(pid);
    }
    await readyz.close();
  });

  it("shutdown() during bootstrap cancels startup and leaves no child", { timeout: 15_000 }, async () => {
    const readyz = await startReadyzServer(() => ({ status: 503 }));
    const runtime = fakeAppServerRuntime([`ws://127.0.0.1:${readyz.port}`]);

    const startPromise = runtime.start();
    await new Promise((resolve) => setTimeout(resolve, 150));
    const pid = childPid(runtime);
    const shutdownPromise = runtime.shutdown();

    await expectCodexError(startPromise, "startup_aborted");
    const exit = await shutdownPromise;
    expect(runtime.state).toBe("stopped");
    expect(exit).not.toBeNull();

    if (typeof pid === "number") {
      await expectProcessDead(pid);
    }
    await readyz.close();
  });

  it("shutdown() is idempotent after stopping", { timeout: 15_000 }, async () => {
    const readyz = await startReadyzServer();
    const runtime = fakeAppServerRuntime([`ws://127.0.0.1:${readyz.port}`]);

    await runtime.start();
    const first = await runtime.shutdown();
    const second = await runtime.shutdown();

    expect(second).toEqual(first);
    expect(runtime.state).toBe("stopped");
    await readyz.close();
  });

  it("terminates via forceKill when the child ignores the termination request", { timeout: 15_000 }, async () => {
    const captured: { process?: LadderFakeProcess } = {};
    const runtime = new CodexSessionRuntime({
      processFactory: ladderFactory({ dieOnTerminate: false, dieOnForce: true }, captured),
      timeouts: { ...TEST_TIMEOUTS, terminateGraceMs: 100 },
      readyzProbe: async () => 200,
    });

    await runtime.start();
    const exit = await runtime.shutdown();

    expect(captured.process?.calls[0]).toBe("requestTerminate");
    expect(captured.process?.calls).toContain("forceKill");
    expect(exit).toEqual({ exitCode: null, signal: "SIGKILL" });
    expect(runtime.state).toBe("stopped");
  });

  it("fails with shutdown_failed when the child refuses to die", { timeout: 15_000 }, async () => {
    const captured: { process?: LadderFakeProcess } = {};
    const runtime = new CodexSessionRuntime({
      processFactory: ladderFactory({ dieOnTerminate: false, dieOnForce: false }, captured),
      timeouts: { ...TEST_TIMEOUTS, terminateGraceMs: 100, terminateForceGraceMs: 100 },
      readyzProbe: async () => 200,
    });

    await runtime.start();
    await expectCodexError(runtime.shutdown(), "shutdown_failed");
    expect(captured.process?.calls).toContain("requestTerminate");
    expect(captured.process?.calls).toContain("forceKill");
  });
});
