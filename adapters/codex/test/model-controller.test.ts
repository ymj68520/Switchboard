import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ModelController,
  type CollaborationModeKind,
  type ControllerEvent,
} from "../src/index.js";
import { createLoopbackEndpoint } from "../src/runtime/types.js";
import { nodeWebSocketFactory } from "../src/controller/app-server-rpc.js";
import { startFakeAppServer, type FakeAppServer } from "./helpers/fake-app-server.js";

async function waitForEvent<T extends ControllerEvent["type"]>(
  events: ControllerEvent[],
  type: T,
  timeoutMs = 2_000,
  fromIndex = 0,
): Promise<Extract<ControllerEvent, { type: T }>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = events.slice(fromIndex).find((event) => event.type === type);
    if (found !== undefined) {
      return found as Extract<ControllerEvent, { type: T }>;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`expected a ${type} event; saw: ${events.map((e) => e.type).join(", ") || "(none)"}`);
}

function settingsNotification(
  threadId: string,
  mode: string,
  model = "some-model",
): { method: string; params: unknown } {
  return {
    method: "thread/settings/updated",
    params: {
      threadId,
      threadSettings: {
        cwd: "/tmp",
        approvalPolicy: "on-request",
        sandboxPolicy: { type: "readOnly" },
        model,
        modelProvider: "custom",
        effort: "high",
        collaborationMode: { mode, settings: { model, reasoningEffort: null } },
        totallyUnknownFutureField: { deep: true },
      },
    },
  };
}

function threadStartedNotification(
  threadId: string,
  parentThreadId: string | null = null,
): { method: string; params: unknown } {
  return {
    method: "thread/started",
    params: {
      thread: {
        id: threadId,
        parentThreadId,
        cwd: "/tmp",
        ephemeral: false,
        modelProvider: "custom",
        turns: [],
      },
    },
  };
}

describe("ModelController handshake", () => {
  let server: FakeAppServer;
  let events: ControllerEvent[];
  let unsubscribe: (() => void) | null = null;

  beforeEach(async () => {
    server = await startFakeAppServer();
    events = [];
  });

  afterEach(async () => {
    unsubscribe?.();
    await server.close();
  });

  function makeController(options?: Partial<ConstructorParameters<typeof ModelController>[0]>) {
    const controller = new ModelController({
      clientVersion: "0.1.0",
      requestTimeoutMs: 500,
      initializeTimeoutMs: 600,
      websocketFactory: nodeWebSocketFactory,
      ...options,
    });
    unsubscribe = controller.onEvent((event) => events.push(event));
    return controller;
  }

  function endpoint() {
    const parsed = createLoopbackEndpoint("127.0.0.1", server.port);
    if (parsed === null) throw new Error("unreachable");
    return parsed;
  }

  it("completes initialize + initialized and reaches Listening", { timeout: 10_000 }, async () => {
    const controller = makeController();
    await controller.connect(endpoint());
    // The frame is sent in-process; give the socket a beat to deliver it.
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(controller.state).toBe("listening");

    const frames = server.connections()[0]?.received ?? [];
    const initializeIndex = frames.findIndex((frame) => frame.method === "initialize");
    const initializeFrame = frames[initializeIndex];
    expect(initializeFrame?.id).toBe(1);
    expect(initializeFrame?.params).toEqual({
      clientInfo: { name: "phase-model-controller", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });

    // initialized must be sent only AFTER the initialize response, without params.
    const initializedIndex = frames.findIndex((frame) => frame.method === "initialized");
    expect(initializedIndex).toBeGreaterThan(initializeIndex);
    expect(Object.hasOwn(frames[initializedIndex] ?? {}, "params")).toBe(false);

    expect(controller.serverDiagnostics).toEqual({ userAgent: "fake-codex/0.0.0" });

    await controller.stop();
    expect(controller.state).toBe("stopped");
  });

  it("fails when initialize returns a JSON-RPC error", { timeout: 10_000 }, async () => {
    server.failInitializeWith(-32000, "experimental API disabled");
    const controller = makeController();

    await expect(controller.connect(endpoint())).rejects.toThrow(/experimental API disabled/);
    expect(controller.state).toBe("disabled");
    await waitForEvent(events, "disabled");
  });

  it("fails when the connection closes during initialize", { timeout: 10_000 }, async () => {
    server.silenceInitialize();
    const controller = makeController();
    const connectPromise = controller.connect(endpoint());
    await new Promise((resolve) => setTimeout(resolve, 80));
    server.closeConnection(0);

    await expect(connectPromise).rejects.toBeInstanceOf(Error);
    expect(controller.state).toBe("disabled");
  });

  it("fails on initialize timeout", { timeout: 10_000 }, async () => {
    server.silenceInitialize();
    const controller = makeController();

    await expect(controller.connect(endpoint())).rejects.toThrow(/timed out/);
    expect(controller.state).toBe("disabled");
  });

  it("does not accept an initialize response with the wrong id", { timeout: 10_000 }, async () => {
    // The fake answers initialize (id=1). Poison the socket BEFORE connect:
    // pre-connect frames cannot be injected, so instead we replace the reply
    // path: silence the fake and answer manually with a wrong id.
    server.silenceInitialize();
    const controller = makeController();
    const connectPromise = controller.connect(endpoint());
    // Wait for the initialize frame to arrive, then answer with the wrong id.
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && server.connectionCount() === 0) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    while (Date.now() < deadline && (server.connections()[0]?.received.length ?? 0) === 0) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    server.sendTo(0, { jsonrpc: "2.0", id: 42, result: { userAgent: "fake" } });

    await expect(connectPromise).rejects.toThrow(/timed out/);
    expect(controller.state).toBe("disabled");
  });

  it("refuses connect() when not disconnected (no auto-reconnect)", { timeout: 10_000 }, async () => {
    const controller = makeController();
    await controller.connect(endpoint());
    await expect(controller.connect(endpoint())).rejects.toThrow(/disconnected/);
    await controller.stop();
  });
});

describe("ModelController notification dispatch", () => {
  let server: FakeAppServer;
  let events: ControllerEvent[];
  let unsubscribe: (() => void) | null = null;

  beforeEach(async () => {
    server = await startFakeAppServer();
    events = [];
  });

  afterEach(async () => {
    unsubscribe?.();
    await server.close();
  });

  async function listeningController() {
    const controller = new ModelController({
      clientVersion: "0.1.0",
      requestTimeoutMs: 500,
      websocketFactory: nodeWebSocketFactory,
    });
    unsubscribe = controller.onEvent((event) => events.push(event));
    const parsed = createLoopbackEndpoint("127.0.0.1", server.port);
    if (parsed === null) throw new Error("unreachable");
    await controller.connect(parsed);
    return controller;
  }

  it("ignores unknown notifications without disabling", { timeout: 10_000 }, async () => {
    const controller = await listeningController();

    server.broadcast({ method: "configWarning", params: { summary: "noise" } });
    server.broadcast({ method: "remoteControl/status/changed", params: { status: "disabled" } });
    server.broadcast({ method: "account/rateLimits/updated", params: {} });
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(controller.state).toBe("listening");
    expect(events).toEqual([]);

    await controller.stop();
  });

  it("dispatches thread/started and binds the top-level thread", { timeout: 10_000 }, async () => {
    const controller = await listeningController();

    server.broadcast(threadStartedNotification("thr-001"));

    const bound = await waitForEvent(events, "topLevelThreadBound");
    expect(bound.threadId).toBe("thr-001");
    expect(controller.boundThreadId).toBe("thr-001");

    await controller.stop();
  });

  it("dispatches thread/settings/updated into mode observation", { timeout: 10_000 }, async () => {
    const controller = await listeningController();
    server.broadcast(threadStartedNotification("thr-001"));
    await waitForEvent(events, "topLevelThreadBound");

    server.broadcast(settingsNotification("thr-001", "plan"));

    const observed = await waitForEvent(events, "initialModeObserved");
    expect(observed.mode).toBe<CollaborationModeKind>("plan");
    expect(controller.observedMode).toBe<CollaborationModeKind>("plan");

    await controller.stop();
  });

  it("tolerates extra fields and unparsed payload noise", { timeout: 10_000 }, async () => {
    const controller = await listeningController();
    server.broadcast(threadStartedNotification("thr-001"));
    await waitForEvent(events, "topLevelThreadBound");

    server.broadcast(settingsNotification("thr-001", "default"));
    await waitForEvent(events, "initialModeObserved");

    expect(controller.state).toBe("listening");
    await controller.stop();
  });

  it("disables the controller on a malformed required notification", { timeout: 10_000 }, async () => {
    const controller = await listeningController();

    server.broadcast({ method: "thread/started", params: { thread: { parentThreadId: null } } });

    const disabled = await waitForEvent(events, "disabled");
    expect(disabled.reason).toContain("malformed");
    expect(controller.state).toBe("disabled");
  });

  it("disables the controller on malformed thread/settings/updated", { timeout: 10_000 }, async () => {
    const controller = await listeningController();
    server.broadcast(threadStartedNotification("thr-001"));
    await waitForEvent(events, "topLevelThreadBound");

    server.broadcast({ method: "thread/settings/updated", params: { threadSettings: {} } });

    const disabled = await waitForEvent(events, "disabled");
    expect(disabled.reason).toContain("malformed");
    expect(controller.state).toBe("disabled");
  });

  it("disables the controller on a non-JSON text frame", { timeout: 10_000 }, async () => {
    const controller = await listeningController();

    server.sendRawTo(0, "{{{ not json");

    await waitForEvent(events, "disabled");
    expect(controller.state).toBe("disabled");
  });
});

describe("ModelController thread binding", () => {
  let server: FakeAppServer;
  let events: ControllerEvent[];
  let unsubscribe: (() => void) | null = null;

  beforeEach(async () => {
    server = await startFakeAppServer();
    events = [];
  });

  afterEach(async () => {
    unsubscribe?.();
    await server.close();
  });

  async function listeningController() {
    const controller = new ModelController({
      clientVersion: "0.1.0",
      requestTimeoutMs: 500,
      websocketFactory: nodeWebSocketFactory,
    });
    unsubscribe = controller.onEvent((event) => events.push(event));
    const parsed = createLoopbackEndpoint("127.0.0.1", server.port);
    if (parsed === null) throw new Error("unreachable");
    await controller.connect(parsed);
    return controller;
  }

  it("binds only top-level threads and ignores child/subagent threads", { timeout: 10_000 }, async () => {
    const controller = await listeningController();

    server.broadcast(threadStartedNotification("thr-child", "thr-001"));
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(controller.boundThreadId).toBeNull();

    server.broadcast(threadStartedNotification("thr-001", null));
    await waitForEvent(events, "topLevelThreadBound");
    expect(controller.boundThreadId).toBe("thr-001");

    await controller.stop();
  });

  it("subscribes to the bound thread's event fan-out via thread/resume", { timeout: 10_000 }, async () => {
    const controller = await listeningController();

    server.broadcast(threadStartedNotification("thr-001"));
    await waitForEvent(events, "topLevelThreadBound");
    await waitForEvent(events, "threadSubscribed");

    const resumeFrame = server
      .connections()[0]?.received.find((frame) => frame.method === "thread/resume");
    expect(resumeFrame?.params).toEqual({ threadId: "thr-001" });

    await controller.stop();
  });

  it("reports subscription-pending (fail-open) when the thread is not yet resumable", { timeout: 10_000 }, async () => {
    server.setThreadResumeBehavior("reject");
    const controller = await listeningController();

    server.broadcast(threadStartedNotification("thr-001"));
    await waitForEvent(events, "topLevelThreadBound");
    const pending = await waitForEvent(events, "threadSubscriptionPending");
    expect(pending.reason).toContain("no rollout found");
    expect(controller.subscription).toBe("pending");
    // Observation continues — subscription gaps are fail-open, not fatal.
    expect(controller.state).toBe("listening");

    await controller.stop();
  });

  it("ignores duplicate thread/started for the current top-level thread", { timeout: 10_000 }, async () => {
    const controller = await listeningController();

    server.broadcast(threadStartedNotification("thr-001"));
    await waitForEvent(events, "topLevelThreadBound");

    server.broadcast(threadStartedNotification("thr-001"));
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(events.filter((event) => event.type === "topLevelThreadBound")).toHaveLength(1);
    expect(controller.boundThreadId).toBe("thr-001");

    await controller.stop();
  });

  it("replaces the binding on a new top-level thread and clears the mode", { timeout: 10_000 }, async () => {
    const controller = await listeningController();

    server.broadcast(threadStartedNotification("thr-001"));
    await waitForEvent(events, "topLevelThreadBound");
    server.broadcast(settingsNotification("thr-001", "plan"));
    await waitForEvent(events, "initialModeObserved");
    expect(controller.observedMode).toBe<CollaborationModeKind>("plan");

    server.broadcast(threadStartedNotification("thr-002"));
    const rebound = await waitForEvent(events, "topLevelThreadBound", 2_000, events.length);
    expect(rebound.threadId).toBe("thr-002");
    expect(controller.boundThreadId).toBe("thr-002");
    expect(controller.observedMode).toBeNull();

    await controller.stop();
  });

  it("ignores settings for a non-current thread", { timeout: 10_000 }, async () => {
    const controller = await listeningController();

    server.broadcast(threadStartedNotification("thr-001"));
    await waitForEvent(events, "topLevelThreadBound");

    server.broadcast(settingsNotification("thr-other", "plan"));
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(controller.observedMode).toBeNull();
    expect(events.filter((event) => event.type === "initialModeObserved")).toHaveLength(0);
    expect(controller.state).toBe("listening");

    await controller.stop();
  });
});

describe("ModelController mode observation", () => {
  let server: FakeAppServer;
  let events: ControllerEvent[];
  let unsubscribe: (() => void) | null = null;

  beforeEach(async () => {
    server = await startFakeAppServer();
    events = [];
  });

  afterEach(async () => {
    unsubscribe?.();
    await server.close();
  });

  async function listeningController() {
    const controller = new ModelController({
      clientVersion: "0.1.0",
      requestTimeoutMs: 500,
      websocketFactory: nodeWebSocketFactory,
    });
    unsubscribe = controller.onEvent((event) => events.push(event));
    const parsed = createLoopbackEndpoint("127.0.0.1", server.port);
    if (parsed === null) throw new Error("unreachable");
    await controller.connect(parsed);
    server.broadcast(threadStartedNotification("thr-001"));
    await waitForEvent(events, "topLevelThreadBound");
    return controller;
  }

  it("records the first default observation without a transition", { timeout: 10_000 }, async () => {
    const controller = await listeningController();

    server.broadcast(settingsNotification("thr-001", "default"));
    const observed = await waitForEvent(events, "initialModeObserved");
    expect(observed.mode).toBe<CollaborationModeKind>("default");
    expect(events.filter((event) => event.type === "modeChanged")).toHaveLength(0);

    await controller.stop();
  });

  it("records the first plan observation without a transition", { timeout: 10_000 }, async () => {
    const controller = await listeningController();

    server.broadcast(settingsNotification("thr-001", "plan"));
    const observed = await waitForEvent(events, "initialModeObserved");
    expect(observed.mode).toBe<CollaborationModeKind>("plan");

    await controller.stop();
  });

  it("recognizes default → plan transitions", { timeout: 10_000 }, async () => {
    const controller = await listeningController();

    server.broadcast(settingsNotification("thr-001", "default"));
    await waitForEvent(events, "initialModeObserved");
    server.broadcast(settingsNotification("thr-001", "plan"));

    const changed = await waitForEvent(events, "modeChanged");
    expect(changed).toMatchObject({ threadId: "thr-001", from: "default", to: "plan" });
    expect(controller.observedMode).toBe<CollaborationModeKind>("plan");

    await controller.stop();
  });

  it("recognizes plan → default transitions", { timeout: 10_000 }, async () => {
    const controller = await listeningController();

    server.broadcast(settingsNotification("thr-001", "plan"));
    await waitForEvent(events, "initialModeObserved");
    server.broadcast(settingsNotification("thr-001", "default"));

    const changed = await waitForEvent(events, "modeChanged");
    expect(changed).toMatchObject({ threadId: "thr-001", from: "plan", to: "default" });

    await controller.stop();
  });

  it("emits nothing for same-mode updates (default → default)", { timeout: 10_000 }, async () => {
    const controller = await listeningController();

    server.broadcast(settingsNotification("thr-001", "default"));
    await waitForEvent(events, "initialModeObserved");
    server.broadcast(settingsNotification("thr-001", "default"));
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(events.filter((event) => event.type === "modeChanged")).toHaveLength(0);
    expect(events.filter((event) => event.type === "initialModeObserved")).toHaveLength(1);

    await controller.stop();
  });

  it("emits nothing for same-mode model changes (the future /model baseline)", { timeout: 10_000 }, async () => {
    const controller = await listeningController();

    server.broadcast(settingsNotification("thr-001", "plan", "model-a"));
    await waitForEvent(events, "initialModeObserved");

    // User ran /model → model changed, mode unchanged.
    server.broadcast(settingsNotification("thr-001", "plan", "model-b"));
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(controller.observedMode).toBe<CollaborationModeKind>("plan");
    expect(events.filter((event) => event.type === "modeChanged")).toHaveLength(0);
    expect(controller.state).toBe("listening");

    await controller.stop();
  });

  it("disables on an unknown collaboration mode instead of guessing", { timeout: 10_000 }, async () => {
    const controller = await listeningController();

    server.broadcast(settingsNotification("thr-001", "autonomous-ultra"));

    const disabled = await waitForEvent(events, "disabled");
    expect(disabled.reason).toContain("unsupported collaboration mode");
    expect(controller.observedMode).toBeNull();
    expect(controller.state).toBe("disabled");
  });
});

describe("ModelController lifecycle", () => {
  let server: FakeAppServer;
  let events: ControllerEvent[];
  let unsubscribe: (() => void) | null = null;

  beforeEach(async () => {
    server = await startFakeAppServer();
    events = [];
  });

  afterEach(async () => {
    unsubscribe?.();
    await server.close();
  });

  it("stop() is idempotent and closes the socket", { timeout: 10_000 }, async () => {
    const controller = new ModelController({
      clientVersion: "0.1.0",
      websocketFactory: nodeWebSocketFactory,
    });
    unsubscribe = controller.onEvent((event) => events.push(event));
    const parsed = createLoopbackEndpoint("127.0.0.1", server.port);
    if (parsed === null) throw new Error("unreachable");
    await controller.connect(parsed);

    await Promise.all([controller.stop(), controller.stop(), controller.stop()]);
    expect(controller.state).toBe("stopped");

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(server.connections()[0]?.closed ?? false).toBe(true);
  });

  it("enters Disabled on connection loss and never reconnects", { timeout: 10_000 }, async () => {
    const controller = new ModelController({
      clientVersion: "0.1.0",
      websocketFactory: nodeWebSocketFactory,
    });
    unsubscribe = controller.onEvent((event) => events.push(event));
    const parsed = createLoopbackEndpoint("127.0.0.1", server.port);
    if (parsed === null) throw new Error("unreachable");
    await controller.connect(parsed);

    server.closeConnection(0, 1001);
    await waitForEvent(events, "disabled");

    expect(controller.state).toBe("disabled");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(controller.state).toBe("disabled"); // no reconnect
    expect(server.connectionCount()).toBe(1); // no new connection attempts
  });

  it("stop() before connect() is allowed and stays stopped", async () => {
    const controller = new ModelController({});
    await controller.stop();
    expect(controller.state).toBe("stopped");
  });
});
