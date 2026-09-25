import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ModelController,
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

function threadStartedNotification(
  threadId: string,
  parentThreadId: string | null = null,
): { method: string; params: unknown } {
  return {
    method: "thread/started",
    params: { thread: { id: threadId, parentThreadId, cwd: "/tmp", turns: [] } },
  };
}

function statusNotification(threadId: string, statusType: string): { method: string; params: unknown } {
  return {
    method: "thread/status/changed",
    params: { threadId, status: { type: statusType, activeFlags: [] } },
  };
}

describe("Passive subscriber safety", () => {
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

  // Phase 3 §22 — the highest-priority regression gate: a subscribed
  // controller must send ZERO response/error frames for a server request.
  it("sends NO response for an incoming thread-scoped server request", { timeout: 10_000 }, async () => {
    const controller = await listeningController();
    server.broadcast(threadStartedNotification("thr-001"));
    await waitForEvent(events, "threadSubscribed");

    server.sendTo(0, {
      jsonrpc: "2.0",
      id: 9001,
      method: "some/thread/scoped/serverRequest",
      params: {},
    });

    // Generous observation window: a racing -32601 replier would answer
    // within milliseconds.
    await new Promise((resolve) => setTimeout(resolve, 600));

    const responsesTo9001 = server
      .connections()[0]?.received.filter((frame) => frame.id === 9001) ?? [];
    expect(responsesTo9001).toHaveLength(0);
    // The controller stays healthy — ignoring is not an error.
    expect(controller.state).toBe("listening");
    expect(controller.subscription).toBe("subscribed");

    await controller.stop();
  });
});

describe("Subscription state machine", () => {
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

  it("bind → resume success → subscribed", { timeout: 10_000 }, async () => {
    const controller = await listeningController();
    expect(controller.subscription).toBe("none");

    server.broadcast(threadStartedNotification("thr-001"));

    await waitForEvent(events, "threadSubscribed");
    expect(controller.subscription).toBe("subscribed");
    expect(server.resumeRequestCount()).toBe(1);

    await controller.stop();
  });

  it("bind → no-rollout failure → pending (not Disabled)", { timeout: 10_000 }, async () => {
    server.setThreadResumeBehavior("reject");
    const controller = await listeningController();

    server.broadcast(threadStartedNotification("thr-001"));

    const pending = await waitForEvent(events, "threadSubscriptionPending");
    expect(pending.reason).toContain("no rollout found");
    expect(controller.subscription).toBe("pending");
    expect(controller.state).toBe("listening");

    await controller.stop();
  });

  it("pending → current-thread idle → automatic retry → subscribed", { timeout: 10_000 }, async () => {
    server.setThreadResumeBehavior("reject");
    const controller = await listeningController();

    server.broadcast(threadStartedNotification("thr-001"));
    await waitForEvent(events, "threadSubscriptionPending");

    server.setThreadResumeBehavior("ok");
    server.broadcast(statusNotification("thr-001", "idle"));

    await waitForEvent(events, "threadSubscribed");
    expect(controller.subscription).toBe("subscribed");
    expect(server.resumeRequestCount()).toBe(2);

    await controller.stop();
  });

  it("pending performs NO timer polling — resume count stays 1 without events", { timeout: 10_000 }, async () => {
    server.setThreadResumeBehavior("reject");
    const controller = await listeningController();

    server.broadcast(threadStartedNotification("thr-001"));
    await waitForEvent(events, "threadSubscriptionPending");
    expect(server.resumeRequestCount()).toBe(1);

    // No thread/status/changed events at all — only wall-clock time passes.
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(server.resumeRequestCount()).toBe(1);
    expect(controller.subscription).toBe("pending");

    await controller.stop();
  });

  it("keeps at most one resume in flight under an idle burst", { timeout: 10_000 }, async () => {
    server.setThreadResumeBehavior("reject");
    const controller = await listeningController();

    server.broadcast(threadStartedNotification("thr-001"));
    await waitForEvent(events, "threadSubscriptionPending");

    server.setThreadResumeBehavior("ok");
    server.setThreadResumeDelay(250);
    // Three rapid idle transitions while the first retry is still in flight.
    server.broadcast(statusNotification("thr-001", "idle"));
    server.broadcast(statusNotification("thr-001", "idle"));
    server.broadcast(statusNotification("thr-001", "idle"));

    await waitForEvent(events, "threadSubscribed");
    await new Promise((resolve) => setTimeout(resolve, 400));

    // 1 initial (rejected) + exactly 1 retry despite the burst.
    expect(server.resumeRequestCount()).toBe(2);
    expect(controller.subscription).toBe("subscribed");

    await controller.stop();
  });

  it("drops stale resume completions for a replaced thread", { timeout: 10_000 }, async () => {
    server.setThreadResumeDelay(300);
    const controller = await listeningController();

    // Thread A: resume goes in flight…
    server.broadcast(threadStartedNotification("thr-A"));
    await new Promise((resolve) => setTimeout(resolve, 50));

    // …then thread B replaces it before A's response arrives.
    server.broadcast(threadStartedNotification("thr-B"));
    await waitForEvent(events, "threadSubscribed", 2_000, events.length);

    // B is subscribed through its OWN resume; A's late reply must not touch B.
    expect(controller.boundThreadId).toBe("thr-B");
    expect(controller.observedMode).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(controller.boundThreadId).toBe("thr-B");
    expect(controller.observedMode).toBeNull();
    expect(controller.subscription).toBe("subscribed");
    const modeEvents = events.filter(
      (event) => event.type === "initialModeObserved" || event.type === "modeChanged",
    );
    expect(modeEvents).toHaveLength(0);
    const subscribed = events.filter((event) => event.type === "threadSubscribed");
    expect(subscribed).toHaveLength(1);
    expect(subscribed[0]?.threadId).toBe("thr-B");
    expect(server.resumeRequestCount()).toBe(2);

    await controller.stop();
  });
});

describe("Resume-response mode snapshot", () => {
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

  async function listeningControllerWith(result: unknown) {
    server.setThreadResumeResult(result);
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

  it("uses a default snapshot as InitialModeObserved", { timeout: 10_000 }, async () => {
    const controller = await listeningControllerWith({
      thread: { id: null },
      collaborationMode: { mode: "default", settings: { model: "m" } },
    });

    server.broadcast(threadStartedNotification("thr-001"));
    const observed = await waitForEvent(events, "initialModeObserved");
    expect(observed.mode).toBe("default");
    expect(controller.observedMode).toBe("default");

    await controller.stop();
  });

  it("uses a plan snapshot as InitialModeObserved", { timeout: 10_000 }, async () => {
    const controller = await listeningControllerWith({
      thread: { id: null },
      collaborationMode: { mode: "plan", settings: { model: "m" } },
    });

    server.broadcast(threadStartedNotification("thr-001"));
    const observed = await waitForEvent(events, "initialModeObserved");
    expect(observed.mode).toBe("plan");

    await controller.stop();
  });

  it("stays subscribed without guessing when the snapshot is absent", { timeout: 10_000 }, async () => {
    const controller = await listeningControllerWith({ thread: { id: null } });

    server.broadcast(threadStartedNotification("thr-001"));
    await waitForEvent(events, "threadSubscribed");
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(controller.subscription).toBe("subscribed");
    expect(controller.observedMode).toBeNull();
    expect(events.filter((event) => event.type === "initialModeObserved")).toHaveLength(0);

    await controller.stop();
  });

  it("disables on an unknown snapshot mode instead of guessing", { timeout: 10_000 }, async () => {
    const controller = await listeningControllerWith({
      thread: { id: null },
      collaborationMode: { mode: "hyper-autonomous", settings: { model: "m" } },
    });

    server.broadcast(threadStartedNotification("thr-001"));
    const disabled = await waitForEvent(events, "disabled");
    expect(disabled.reason).toContain("unsupported collaboration mode");
    expect(controller.state).toBe("disabled");
  });
});

describe("thread/status/changed handling", () => {
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

  it("ignores idle status for a non-current thread", { timeout: 10_000 }, async () => {
    server.setThreadResumeBehavior("reject");
    const controller = await listeningController();

    server.broadcast(threadStartedNotification("thr-001"));
    await waitForEvent(events, "threadSubscriptionPending");

    server.broadcast(statusNotification("thr-OTHER", "idle"));
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(server.resumeRequestCount()).toBe(1);

    await controller.stop();
  });

  it("does not re-resume when already subscribed", { timeout: 10_000 }, async () => {
    const controller = await listeningController();

    server.broadcast(threadStartedNotification("thr-001"));
    await waitForEvent(events, "threadSubscribed");

    server.broadcast(statusNotification("thr-001", "idle"));
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(server.resumeRequestCount()).toBe(1);
    expect(controller.subscription).toBe("subscribed");

    await controller.stop();
  });

  it("ignores non-retry statuses while pending", { timeout: 10_000 }, async () => {
    server.setThreadResumeBehavior("reject");
    const controller = await listeningController();

    server.broadcast(threadStartedNotification("thr-001"));
    await waitForEvent(events, "threadSubscriptionPending");

    server.broadcast(statusNotification("thr-001", "active"));
    server.broadcast(statusNotification("thr-001", "systemError"));
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(server.resumeRequestCount()).toBe(1);
    expect(controller.subscription).toBe("pending");

    await controller.stop();
  });

  it("treats malformed status notifications as safe noise", { timeout: 10_000 }, async () => {
    const controller = await listeningController();

    server.broadcast({ method: "thread/status/changed", params: { status: { type: "idle" } } });
    server.broadcast({ method: "thread/status/changed", params: { threadId: "x", status: {} } });
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(controller.state).toBe("listening");
    expect(controller.boundThreadId).toBeNull();

    await controller.stop();
  });
});

describe("Unsubscribe cleanup", () => {
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

  it("unsubscribes the old thread when a new top-level thread binds", { timeout: 10_000 }, async () => {
    const controller = await listeningController();

    server.broadcast(threadStartedNotification("thr-A"));
    await waitForEvent(events, "threadSubscribed");

    server.broadcast(threadStartedNotification("thr-B"));
    await waitForEvent(events, "topLevelThreadBound", 2_000, events.length);
    await new Promise((resolve) => setTimeout(resolve, 150));

    const unsubscribes = server.clientRequests("thread/unsubscribe");
    expect(unsubscribes).toHaveLength(1);
    expect(unsubscribes[0]?.params).toEqual({ threadId: "thr-A" });
    expect(controller.boundThreadId).toBe("thr-B");

    await controller.stop();
  });

  it("stop() unsubscribes the current subscription best-effort", { timeout: 10_000 }, async () => {
    const controller = await listeningController();

    server.broadcast(threadStartedNotification("thr-001"));
    await waitForEvent(events, "threadSubscribed");

    await controller.stop();

    const unsubscribes = server.clientRequests("thread/unsubscribe");
    expect(unsubscribes).toHaveLength(1);
    expect(unsubscribes[0]?.params).toEqual({ threadId: "thr-001" });
    expect(controller.state).toBe("stopped");
  });

  it("unsubscribe failure does not block stop()", { timeout: 10_000 }, async () => {
    server.setUnsubscribeBehavior("reject");
    const controller = await listeningController();

    server.broadcast(threadStartedNotification("thr-001"));
    await waitForEvent(events, "threadSubscribed");

    await controller.stop(); // must resolve despite the rejected unsubscribe

    expect(controller.state).toBe("stopped");
    expect(server.unsubscribeRequestCount()).toBe(1);
  });
});
