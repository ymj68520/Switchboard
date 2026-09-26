import { describe, expect, it } from "vitest";

import {
  CodexSessionRuntime,
  DEFAULT_APP_SERVER_ARGS,
  ManagedCodexSession,
  type AppServerProcess,
  type ChildExitStatus,
  type ManagedSessionOutcome,
  type ReadyzProbe,
  type SpawnRequest,
} from "../src/index.js";
import { startFakeAppServer, type FakeAppServer } from "./helpers/fake-app-server.js";

/**
 * ManagedCodexSession integration tests (Phase 5 directive §43-47, §16-17,
 * §20-30). The composition root is exercised against:
 *  - a scripted fake app-server PROCESS (the runtime's child) whose stderr
 *    advertises the fake WebSocket server's endpoint;
 *  - the real fake WebSocket app-server (protocol: initialize, resume,
 *    settings/update) so the Controller/Switcher run their real code paths;
 *  - a scripted fake TUI child with resolvable exits.
 * Only the OS process boundary is faked; ownership, races and shutdown
 * ordering run exactly as in production.
 */

const RESOLVED = { program: "codex-resolved", prefixArgs: [] as const };

const PHASE_MODEL = {
  planningModel: "plan-X",
  executionModel: "exec-Y",
  reasoningEffort: "xhigh",
};

const USER_THREAD = {
  thread: {
    id: "aaaaaaaa-0000-0000-0000-000000000001",
    parentThreadId: null,
    ephemeral: false,
    threadSource: "user",
  },
};

const TITLE_THREAD = {
  thread: {
    id: "aaaaaaaa-0000-0000-0000-000000000002",
    parentThreadId: null,
    ephemeral: true,
    threadSource: "thread_title",
  },
};

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Scripted stand-in for the app-server OS process (runtime's child). */
class ScriptedServerProcess implements AppServerProcess {
  readonly pid: number = 424242;
  readonly exits: Promise<ChildExitStatus>;
  private readonly exitControl = deferred<ChildExitStatus>();
  readonly terminateCalls: string[] = [];

  constructor(private readonly endpointUrl: string) {
    this.exits = this.exitControl.promise;
  }

  async *stderrStream(): AsyncIterable<string> {
    yield `websockets: listening on ${this.endpointUrl}\n`;
    // Keep the stream open, like a live server would.
    await new Promise(() => {});
  }

  async *stdoutStream(): AsyncIterable<string> {
    await new Promise(() => {});
  }

  requestTerminate(): void {
    this.terminateCalls.push("request");
    this.exitControl.resolve({ exitCode: 0, signal: null });
  }

  forceKill(): void {
    this.terminateCalls.push("force");
    this.exitControl.resolve({ exitCode: null, signal: "SIGKILL" });
  }

  killImmediate(): void {
    this.terminateCalls.push("immediate");
  }

  crash(exitCode: number): void {
    this.exitControl.resolve({ exitCode, signal: null });
  }
}

/** Scripted stand-in for the real Codex TUI child. */
class FakeTuiProcess {
  readonly pid: number = 55555;
  readonly exits: Promise<ChildExitStatus>;
  private readonly exitControl = deferred<ChildExitStatus>();
  readonly terminateCalls: string[] = [];
  readonly request: SpawnRequest;

  constructor(request: SpawnRequest) {
    this.request = request;
    this.exits = this.exitControl.promise;
  }

  requestTerminate(): void {
    this.terminateCalls.push("request");
    this.exitControl.resolve({ exitCode: 1, signal: null });
  }

  forceKill(): void {
    this.terminateCalls.push("force");
    this.exitControl.resolve({ exitCode: null, signal: "SIGKILL" });
  }

  killImmediate(): void {
    this.terminateCalls.push("immediate");
  }

  exit(exitCode: number): void {
    this.exitControl.resolve({ exitCode, signal: null });
  }
}

interface Harness {
  readonly server: FakeAppServer;
  readonly session: ManagedCodexSession;
  readonly outcome: Promise<ManagedSessionOutcome>;
  readonly spawnedTui: Promise<FakeTuiProcess>;
  readonly serverProcess: ScriptedServerProcess;
  readonly warnings: string[];
}

const readyzAlwaysOk: ReadyzProbe = async () => 200;

async function startHarness(overrides: {
  settingsUpdateBehavior?: "ok" | "reject";
} = {}): Promise<Harness> {
  const server = await startFakeAppServer();
  server.setSettingsUpdateBehavior(overrides.settingsUpdateBehavior ?? "ok");
  server.setThreadResumeBehavior("ok");

  const serverProcess = new ScriptedServerProcess(server.url);
  const warnings: string[] = [];
  const diagnostics: string[] = [];
  let resolveTui!: (tui: FakeTuiProcess) => void;
  const spawnedTui = new Promise<FakeTuiProcess>((resolve) => {
    resolveTui = resolve;
  });

  const session = new ManagedCodexSession({
    phaseModel: PHASE_MODEL,
    resolvedCommand: RESOLVED,
    runtimeOptions: {
      processFactory: () => serverProcess,
      readyzProbe: readyzAlwaysOk,
    },
    tuiFactory: (request: SpawnRequest) => {
      const tui = new FakeTuiProcess(request);
      resolveTui(tui);
      return tui;
    },
    warn: (message: string) => warnings.push(message),
    diagnostics: (message: string) => diagnostics.push(message),
  });

  const outcome = session.run();
  return { server, session, outcome, spawnedTui: spawnedTui.then((tui) => tui), serverProcess, warnings };
}

async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${label}: not satisfied within ${timeoutMs}ms`);
}

describe("ManagedCodexSession (Phase 5)", () => {
  it("starts controller and switcher BEFORE the TUI, passes the frozen argv, and cleans up on TUI exit 0 (§16/§17/§43, P5-E5/E6/E19)", async () => {
    const harness = await startHarness();
    try {
      const tui = await harness.spawnedTui;

      // E5: the controller handshake completed before the TUI was spawned.
      // (Structural in run(): connect() resolves only after `initialized`;
      // the frame's wire arrival just needs a beat.)
      await waitFor(() => harness.server.clientRequests("initialized").length === 1, "handshake before TUI");
      // E7/E8/E10/E11 + §16: exact launcher-owned argv on the TUI child.
      expect(tui.request.command).toBe("codex-resolved");
      expect(tui.request.args).toEqual([
        "--remote",
        harness.server.url,
        "--model",
        "exec-Y",
        "-c",
        'model_reasoning_effort="xhigh"',
        "-c",
        'plan_mode_reasoning_effort="xhigh"',
      ]);
      // The app-server child was launched through the SAME resolution.
      expect(DEFAULT_APP_SERVER_ARGS.length).toBeGreaterThan(0);

      // The runtime owns the app-server child; the TUI factory never pipes it.
      expect(tui.terminateCalls).toEqual([]);

      tui.exit(0);
      const outcome = await harness.outcome;
      expect(outcome).toEqual({ kind: "tui-exit", exitCode: 0, signal: null });
      expect(harness.warnings).toEqual([]);
    } finally {
      await harness.server.close();
    }
  });

  it("preserves a nonzero TUI exit code and still cleans up completely (§44, P5-E20)", async () => {
    const harness = await startHarness();
    try {
      const tui = await harness.spawnedTui;
      tui.exit(7);
      const outcome = await harness.outcome;
      expect(outcome).toEqual({ kind: "tui-exit", exitCode: 7, signal: null });
    } finally {
      await harness.server.close();
    }
  });

  it("treats an app-server crash as terminal: TUI is terminated, automation stopped, failure returned (§25/§26/§45, P5-E21/E22)", async () => {
    const harness = await startHarness();
    try {
      const tui = await harness.spawnedTui;
      // Bind a user thread first so controller-stop side effects are visible.
      harness.server.broadcast({ method: "thread/started", params: USER_THREAD });
      await waitFor(() => harness.server.resumeRequestCount() === 1, "controller bind");

      harness.serverProcess.crash(137);
      const outcome = await harness.outcome;
      expect(outcome.kind).toBe("app-server-crash");
      if (outcome.kind === "app-server-crash") {
        expect(outcome.exitStatus).toEqual({ exitCode: 137, signal: null });
        expect(outcome.message).toContain("exited unexpectedly");
      }
      // The TUI was terminated by the launcher (ownership: composition root).
      expect(tui.terminateCalls).toEqual(["request"]);
      // Exactly-once: an app-server crash is NOT a fail-open warning case.
      expect(harness.warnings).toEqual([]);
    } finally {
      await harness.server.close();
    }
  });

  it("controller failure is fail-open: one warning, TUI keeps running, session continues (§22/§27/§46, P5-E23/E25/E26)", async () => {
    const harness = await startHarness();
    try {
      const tui = await harness.spawnedTui;
      harness.server.closeConnection(0);
      await waitFor(() => harness.warnings.length === 1, "automation warning");
      expect(harness.warnings[0]).toContain(
        "automatic phase model switching has been disabled",
      );
      expect(harness.warnings[0]).toContain("connection closed by app-server");

      // The TUI is untouched by a controller failure (§22).
      expect(tui.terminateCalls).toEqual([]);
      tui.exit(0);
      const outcome = await harness.outcome;
      expect(outcome.kind).toBe("tui-exit");
      expect(harness.warnings.length).toBe(1); // exactly once
    } finally {
      await harness.server.close();
    }
  });

  it("switcher failure is fail-open through the SAME warning surface, with no future writes (§23/§47, P5-E24/E25)", async () => {
    const harness = await startHarness({ settingsUpdateBehavior: "reject" });
    try {
      const tui = await harness.spawnedTui;
      // User thread binds; the fake server ACCEPTS the resume, so the
      // controller is subscribed right after the bind attempt completes.
      harness.server.broadcast({ method: "thread/started", params: USER_THREAD });
      await waitFor(() => harness.server.resumeRequestCount() === 1, "initial resume attempt");
      await new Promise((resolve) => setTimeout(resolve, 50));
      // First observed mode → switcher write → REJECTED by the fake server.
      harness.server.broadcast({
        method: "thread/settings/updated",
        params: {
          threadId: USER_THREAD.thread.id,
          threadSettings: {
            model: "exec-Y",
            collaborationMode: { mode: "default", settings: { model: "exec-Y" } },
          },
        },
      });
      await waitFor(() => harness.warnings.length === 1, "unified warning");
      expect(harness.warnings[0]).toContain("model application failed");

      // No future automatic writes after AutomationDisabled.
      const writes = harness.server.settingsUpdateRequests().length;
      expect(writes).toBe(1);
      harness.server.broadcast({
        method: "thread/settings/updated",
        params: {
          threadId: USER_THREAD.thread.id,
          threadSettings: {
            model: "exec-Y",
            collaborationMode: { mode: "plan", settings: { model: "exec-Y" } },
          },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(harness.server.settingsUpdateRequests().length).toBe(writes);

      // Session continues normally.
      tui.exit(0);
      const outcome = await harness.outcome;
      expect(outcome.kind).toBe("tui-exit");
      expect(harness.warnings.length).toBe(1);
    } finally {
      await harness.server.close();
    }
  });

  it("applies the configured phase models against a subscribed thread (§2/§31, P5-E13)", async () => {
    const harness = await startHarness();
    try {
      const tui = await harness.spawnedTui;
      // Realistic TUI order: an internal title-generation thread arrives
      // first (ignored by the controller), then the real user thread binds.
      harness.server.broadcast({ method: "thread/started", params: TITLE_THREAD });
      await new Promise((resolve) => setTimeout(resolve, 30));
      harness.server.broadcast({ method: "thread/started", params: USER_THREAD });
      await waitFor(() => harness.server.resumeRequestCount() === 1, "initial resume attempt");
      await new Promise((resolve) => setTimeout(resolve, 50));
      // First observation is Default → executionModel must be applied.
      harness.server.broadcast({
        method: "thread/settings/updated",
        params: {
          threadId: USER_THREAD.thread.id,
          threadSettings: {
            model: "exec-Y",
            collaborationMode: { mode: "default", settings: { model: "exec-Y" } },
          },
        },
      });
      await waitFor(() => harness.server.settingsUpdateRequests().length === 1, "initial write");
      expect(harness.server.settingsUpdateRequests()[0]).toEqual({
        threadId: USER_THREAD.thread.id,
        model: "exec-Y",
      });
      // Mode transition Default → Plan → planningModel.
      harness.server.broadcast({
        method: "thread/settings/updated",
        params: {
          threadId: USER_THREAD.thread.id,
          threadSettings: {
            model: "exec-Y",
            collaborationMode: { mode: "plan", settings: { model: "exec-Y" } },
          },
        },
      });
      await waitFor(() => harness.server.settingsUpdateRequests().length === 2, "plan write");
      expect(harness.server.settingsUpdateRequests()[1]).toEqual({
        threadId: USER_THREAD.thread.id,
        model: "plan-X",
      });

      tui.exit(0);
      const outcome = await harness.outcome;
      expect(outcome.kind).toBe("tui-exit");
    } finally {
      await harness.server.close();
    }
  });

  it("signal interruption terminates the TUI and cleans up (§30, P5-E47/E48 direction)", async () => {
    const signals: { handler: ((signal: NodeJS.Signals) => void) | null } = { handler: null };
    const server = await startFakeAppServer();
    const serverProcess = new ScriptedServerProcess(server.url);
    let resolveTui!: (tui: FakeTuiProcess) => void;
    const spawnedTui = new Promise<FakeTuiProcess>((resolve) => {
      resolveTui = resolve;
    });
    try {
      const session = new ManagedCodexSession({
        phaseModel: PHASE_MODEL,
        resolvedCommand: RESOLVED,
        runtimeOptions: { processFactory: () => serverProcess, readyzProbe: readyzAlwaysOk },
        tuiFactory: (request) => {
          const tui = new FakeTuiProcess(request);
          resolveTui(tui);
          return tui;
        },
        warn: () => {},
        onSignal: (handler) => {
          signals.handler = handler;
          return () => {};
        },
      });
      const outcome = session.run();
      const tui = await spawnedTui;
      const handler = signals.handler;
      expect(handler).not.toBeNull();
      handler?.("SIGINT");
      const result = await outcome;
      expect(result).toEqual({ kind: "tui-exit", exitCode: null, signal: null });
      expect(tui.terminateCalls).toEqual(["request"]);
    } finally {
      await server.close();
    }
  });

  it("runtime.onExit observes the app-server child for the §26 race", async () => {
    const runtime = new CodexSessionRuntime({
      command: "codex-resolved",
      args: DEFAULT_APP_SERVER_ARGS,
      processFactory: () => new ScriptedServerProcess("ws://127.0.0.1:1"),
      readyzProbe: readyzAlwaysOk,
    });
    await runtime.start();
    const late: ChildExitStatus[] = [];
    const detach = runtime.onExit((status) => late.push(status));
    runtime.shutdown();
    await waitFor(() => runtime.state === "stopped", "runtime stop");
    await waitFor(() => late.length === 1, "exit listener fired");
    detach();
  });

  // ---- Phase 6 §20 lifecycle audit: pre-TUI bootstrap failure paths ----

  it("readyz failure is a bootstrap failure: no TUI, child cleaned up (§20, P6-E20)", async () => {
    const server = await startFakeAppServer();
    try {
      const serverProcess = new ScriptedServerProcess(server.url);
      let tuiSpawned = false;
      const outcome = await new ManagedCodexSession({
        phaseModel: PHASE_MODEL,
        resolvedCommand: RESOLVED,
        runtimeOptions: {
          processFactory: () => serverProcess,
          readyzProbe: async () => 503,
          timeouts: {
            endpointDiscoveryTimeoutMs: 1_000,
            readyzTimeoutMs: 1_000,
            readyzPollIntervalMs: 25,
            readyzRequestTimeoutMs: 200,
            terminateGraceMs: 200,
            terminateForceGraceMs: 200,
          },
        },
        tuiFactory: (request) => {
          tuiSpawned = true;
          return new FakeTuiProcess(request);
        },
        warn: () => {},
      }).run();
      expect(outcome.kind).toBe("bootstrap-failure");
      if (outcome.kind === "bootstrap-failure") {
        expect(outcome.message).toContain("app-server bootstrap failed");
      }
      expect(tuiSpawned).toBe(false);
      // The runtime terminated the child before the failure was reported.
      expect(serverProcess.terminateCalls.length).toBeGreaterThan(0);
    } finally {
      await server.close();
    }
  });

  it("controller connect failure is a bootstrap failure: runtime child terminated, no TUI (§20, P6-E20)", async () => {
    // Endpoint advertises a CLOSED port — the controller WebSocket cannot
    // connect, which must fail the bootstrap before any TUI exists.
    const serverProcess = new ScriptedServerProcess("ws://127.0.0.1:1");
    let tuiSpawned = false;
    const outcome = await new ManagedCodexSession({
      phaseModel: PHASE_MODEL,
      resolvedCommand: RESOLVED,
      runtimeOptions: {
        processFactory: () => serverProcess,
        readyzProbe: readyzAlwaysOk,
      },
      tuiFactory: (request) => {
        tuiSpawned = true;
        return new FakeTuiProcess(request);
      },
      warn: () => {},
    }).run();
    expect(outcome.kind).toBe("bootstrap-failure");
    if (outcome.kind === "bootstrap-failure") {
      expect(outcome.message).toContain("controller bootstrap failed");
    }
    expect(tuiSpawned).toBe(false);
    expect(serverProcess.terminateCalls.length).toBeGreaterThan(0);
  });

  it("a TUI spawn failure is reported with actionable Codex-missing guidance (Phase 6 §18)", async () => {
    const server = await startFakeAppServer();
    try {
      const serverProcess = new ScriptedServerProcess(server.url);
      const outcome = await new ManagedCodexSession({
        phaseModel: PHASE_MODEL,
        resolvedCommand: RESOLVED,
        runtimeOptions: {
          processFactory: () => serverProcess,
          readyzProbe: readyzAlwaysOk,
        },
        tuiFactory: () => {
          const error = new Error("spawn codex ENOENT") as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error; // Node reports spawn failures through exits rejection.
        },
        warn: () => {},
      }).run();
      expect(outcome.kind).toBe("bootstrap-failure");
      if (outcome.kind === "bootstrap-failure") {
        expect(outcome.message).toContain("Codex CLI");
        expect(outcome.message).toContain("does not install");
      }
    } finally {
      await server.close();
    }
  });
});
