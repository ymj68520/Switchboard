import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ModelController,
  PhaseModelConfigError,
  PhaseModelSwitcher,
  desiredModel,
  validatePhaseModelConfig,
  type ControllerEvent,
  type PhaseModelConfig,
  type SwitcherEvent,
} from "../src/index.js";
import { createLoopbackEndpoint } from "../src/runtime/types.js";
import { nodeWebSocketFactory } from "../src/controller/app-server-rpc.js";
import { startFakeAppServer, type FakeAppServer } from "./helpers/fake-app-server.js";

async function waitForEvent<T extends ControllerEvent["type"] | SwitcherEvent["type"]>(
  events: Array<ControllerEvent | SwitcherEvent>,
  type: T,
  timeoutMs = 2_000,
  fromIndex = 0,
): Promise<Extract<ControllerEvent | SwitcherEvent, { type: T }>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = events.slice(fromIndex).find((event) => event.type === type);
    if (found !== undefined) {
      return found as Extract<ControllerEvent | SwitcherEvent, { type: T }>;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`expected a ${type} event; saw: ${events.map((e) => e.type).join(", ") || "(none)"}`);
}

async function waitForPredicate(
  predicate: () => boolean,
  timeoutMs = 3_000,
  label = "condition",
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

function threadStartedNotification(threadId: string): { method: string; params: unknown } {
  return {
    method: "thread/started",
    params: { thread: { id: threadId, parentThreadId: null, cwd: "/tmp", turns: [] } },
  };
}

function settingsNotification(
  threadId: string,
  mode: string,
  model = "user-model",
): { method: string; params: unknown } {
  return {
    method: "thread/settings/updated",
    params: {
      threadId,
      threadSettings: {
        model,
        effort: "high",
        collaborationMode: { mode, settings: { model } },
      },
    },
  };
}

const CONFIG: PhaseModelConfig = { planningModel: "plan-model-X", executionModel: "exec-model-Y" };

describe("Phase → model routing (pure)", () => {
  it("maps Default → executionModel and Plan → planningModel", () => {
    expect(desiredModel("default", CONFIG)).toBe("exec-model-Y");
    expect(desiredModel("plan", CONFIG)).toBe("plan-model-X");
  });

  it("rejects an unknown mode as a programming invariant violation", () => {
    expect(() => desiredModel("quantum" as never, CONFIG)).toThrow(/invariant/);
  });

  it("validates config: distinct, same, empty, whitespace", () => {
    expect(validatePhaseModelConfig({ planningModel: " a ", executionModel: "b" })).toEqual({
      planningModel: "a",
      executionModel: "b",
    });
    // Same model for both phases is explicitly allowed.
    expect(
      validatePhaseModelConfig({ planningModel: "one-model", executionModel: "one-model" }),
    ).toEqual({ planningModel: "one-model", executionModel: "one-model" });
    expect(() => validatePhaseModelConfig({ planningModel: "", executionModel: "b" })).toThrow(
      PhaseModelConfigError,
    );
    expect(() => validatePhaseModelConfig({ planningModel: "a", executionModel: "" })).toThrow(
      PhaseModelConfigError,
    );
    expect(() =>
      validatePhaseModelConfig({ planningModel: "   ", executionModel: "b" }),
    ).toThrow(/planningModel/);
    expect(() =>
      validatePhaseModelConfig({ planningModel: "a", executionModel: "  \t " }),
    ).toThrow(/executionModel/);
  });
});

describe("PhaseModelSwitcher application", () => {
  let server: FakeAppServer;
  let events: Array<ControllerEvent | SwitcherEvent>;
  let detach: (() => void) | null = null;

  beforeEach(async () => {
    server = await startFakeAppServer();
    events = [];
  });

  afterEach(async () => {
    detach?.();
    detach = null;
    await server.close();
  });

  async function startedSwitcher(config: PhaseModelConfig = CONFIG) {
    const controller = new ModelController({
      clientVersion: "0.1.0",
      requestTimeoutMs: 500,
      websocketFactory: nodeWebSocketFactory,
    });
    detach = controller.onEvent((event) => events.push(event));
    const parsed = createLoopbackEndpoint("127.0.0.1", server.port);
    if (parsed === null) throw new Error("unreachable");
    await controller.connect(parsed);

    const switcher = new PhaseModelSwitcher(controller, config);
    detach = switcher.onEvent((event) => events.push(event));
    switcher.start();
    return { controller, switcher };
  }

  async function bindSubscribedThread(controller: ModelController, threadId: string) {
    server.broadcast(threadStartedNotification(threadId));
    await waitForEvent(events, "threadSubscribed");
    void controller;
  }

  it("applies executionModel on InitialModeObserved(Default)", { timeout: 10_000 }, async () => {
    const { controller, switcher } = await startedSwitcher();
    await bindSubscribedThread(controller, "thr-001");

    server.broadcast(settingsNotification("thr-001", "default"));
    const applied = await waitForEvent(events, "modelApplied");

    expect(applied).toEqual({
      type: "modelApplied",
      threadId: "thr-001",
      mode: "default",
      model: "exec-model-Y",
    });
    expect(server.settingsUpdateRequests()).toEqual([
      { threadId: "thr-001", model: "exec-model-Y" },
    ]);

    await switcher.stop();
  });

  it("applies planningModel on InitialModeObserved(Plan)", { timeout: 10_000 }, async () => {
    const { controller, switcher } = await startedSwitcher();
    await bindSubscribedThread(controller, "thr-001");

    server.broadcast(settingsNotification("thr-001", "plan"));
    const applied = await waitForEvent(events, "modelApplied");

    expect(applied.model).toBe("plan-model-X");
    expect(applied.mode).toBe("plan");
    expect(server.settingsUpdateRequests()).toEqual([
      { threadId: "thr-001", model: "plan-model-X" },
    ]);

    await switcher.stop();
  });

  it("applies planningModel on Default → Plan and executionModel on Plan → Default", { timeout: 10_000 }, async () => {
    const { controller, switcher } = await startedSwitcher();
    await bindSubscribedThread(controller, "thr-001");

    server.broadcast(settingsNotification("thr-001", "default"));
    await waitForEvent(events, "modelApplied");

    server.broadcast(settingsNotification("thr-001", "plan"));
    await waitForEvent(events, "modelApplied", 2_000, events.length);
    server.broadcast(settingsNotification("thr-001", "default"));
    await waitForEvent(events, "modelApplied", 2_000, events.length);

    expect(server.settingsUpdateRequests().map((params) => params.model)).toEqual([
      "exec-model-Y",
      "plan-model-X",
      "exec-model-Y",
    ]);

    await switcher.stop();
  });

  it("sends params of EXACTLY {threadId, model} — no other settings keys", { timeout: 10_000 }, async () => {
    const { controller, switcher } = await startedSwitcher();
    await bindSubscribedThread(controller, "thr-001");

    server.broadcast(settingsNotification("thr-001", "plan"));
    await waitForEvent(events, "modelApplied");

    const [params] = server.settingsUpdateRequests();
    expect(params).toEqual({ threadId: "thr-001", model: "plan-model-X" });
    expect(Object.keys(params ?? {})).toEqual(["threadId", "model"]);

    await switcher.stop();
  });

  it("never overrides a same-mode manual model change (…/model out of scope)", { timeout: 10_000 }, async () => {
    const { controller, switcher } = await startedSwitcher();
    await bindSubscribedThread(controller, "thr-001");

    // Initial Plan → planning model applied once.
    server.broadcast(settingsNotification("thr-001", "plan"));
    await waitForEvent(events, "modelApplied");
    expect(server.settingsUpdateRequests()).toHaveLength(1);

    // User ran /model user-model while staying in Plan: same-mode update.
    server.broadcast(settingsNotification("thr-001", "plan", "user-model"));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(server.settingsUpdateRequests()).toHaveLength(1); // no second write

    // The manual choice stands until the next REAL phase transition.
    expect(
      events.some(
        (event) => event.type === "modelApplied" && event.model === "user-model",
      ),
    ).toBe(false);

    // Plan → Default → executionModel reapplied.
    server.broadcast(settingsNotification("thr-001", "default", "user-model"));
    await waitForEvent(events, "modelApplied", 2_000, events.length);
    expect(server.settingsUpdateRequests()).toEqual([
      { threadId: "thr-001", model: "plan-model-X" },
      { threadId: "thr-001", model: "exec-model-Y" },
    ]);

    await switcher.stop();
  });

  it("does not loop on its own same-mode settings echo", { timeout: 10_000 }, async () => {
    const { controller, switcher } = await startedSwitcher();
    await bindSubscribedThread(controller, "thr-001");

    server.broadcast(settingsNotification("thr-001", "plan"));
    await waitForEvent(events, "modelApplied");

    // Server echoes the applied state: mode unchanged, model == planning.
    server.broadcast(settingsNotification("thr-001", "plan", "plan-model-X"));
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(server.settingsUpdateRequests()).toHaveLength(1);

    await switcher.stop();
  });

  it("serializes bursts: one write in flight, applied in event order", { timeout: 10_000 }, async () => {
    server.setSettingsUpdateDelay(250);
    const { controller, switcher } = await startedSwitcher();
    await bindSubscribedThread(controller, "thr-001");

    // Rapid event sequence: Default, Plan, Default.
    server.broadcast(settingsNotification("thr-001", "default"));
    await new Promise((resolve) => setTimeout(resolve, 60)); // first write in flight
    expect(server.settingsUpdateRequests()).toHaveLength(1); // max 1 in flight

    server.broadcast(settingsNotification("thr-001", "plan"));
    server.broadcast(settingsNotification("thr-001", "default"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Still only the first write while it is in flight.
    expect(server.settingsUpdateRequests()).toHaveLength(1);

    await waitForEvent(events, "modelApplied", 3_000, events.length);
    await waitForPredicate(
      () => server.settingsUpdateRequests().length === 3,
      3_000,
      "all three serialized writes",
    );

    const appliedModels = server.settingsUpdateRequests().map((params) => params.model);
    expect(appliedModels).toEqual(["exec-model-Y", "plan-model-X", "exec-model-Y"]);

    await switcher.stop();
  });

  it("skips a stale unsent action when the thread is replaced", { timeout: 10_000 }, async () => {
    server.setSettingsUpdateDelay(250);
    const { controller, switcher } = await startedSwitcher();
    await bindSubscribedThread(controller, "thr-A");

    // Thread A: initial Default write goes in flight…
    server.broadcast(settingsNotification("thr-A", "default"));
    await new Promise((resolve) => setTimeout(resolve, 40));

    // …a Plan event queues the (never-sent) planning write…
    server.broadcast(settingsNotification("thr-A", "plan"));

    // …and then thread B replaces A entirely.
    server.broadcast(threadStartedNotification("thr-B"));
    await waitForEvent(events, "threadSubscribed", 2_000, events.length);
    server.broadcast(settingsNotification("thr-B", "default"));
    await waitForEvent(events, "modelApplied", 3_000, events.length);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const requests = server.settingsUpdateRequests();
    expect(requests).toEqual([
      { threadId: "thr-A", model: "exec-model-Y" }, // A: was already in flight
      { threadId: "thr-B", model: "exec-model-Y" }, // B: its own initial write
    ]);
    // The queued A/planning write was skipped; B never received A's model.
    expect(requests.some((params) => params.model === "plan-model-X")).toBe(false);

    await switcher.stop();
  });

  it("skips writes when the controller subscription is not subscribed", { timeout: 10_000 }, async () => {
    server.setThreadResumeBehavior("reject");
    const controller = new ModelController({
      clientVersion: "0.1.0",
      requestTimeoutMs: 500,
      websocketFactory: nodeWebSocketFactory,
    });
    detach = controller.onEvent((event) => events.push(event));
    const parsed = createLoopbackEndpoint("127.0.0.1", server.port);
    if (parsed === null) throw new Error("unreachable");
    await controller.connect(parsed);
    const switcher = new PhaseModelSwitcher(controller, CONFIG);
    detach = switcher.onEvent((event) => events.push(event));
    switcher.start();

    // Thread binds but subscription stays pending; a mode event arrives.
    server.broadcast(threadStartedNotification("thr-001"));
    await waitForEvent(events, "threadSubscriptionPending");
    server.broadcast({ method: "thread/settings/updated", params: {
      threadId: "thr-001",
      threadSettings: { model: "m", collaborationMode: { mode: "plan", settings: { model: "m" } } },
    } });
    // The controller drops settings for a non-subscribed thread only by its
    // own observation rules; here subscription IS pending, so the event is
    // still dispatched and the switcher must defensively skip the write.
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(server.settingsUpdateRequests()).toHaveLength(0);
    expect(switcher.state).toBe("active"); // skip is not a failure

    await switcher.stop();
  });
});

describe("PhaseModelSwitcher failure handling", () => {
  let server: FakeAppServer;
  let events: Array<ControllerEvent | SwitcherEvent>;
  let detach: (() => void) | null = null;

  beforeEach(async () => {
    server = await startFakeAppServer();
    events = [];
  });

  afterEach(async () => {
    detach?.();
    detach = null;
    await server.close();
  });

  async function startedSwitcher(requestTimeoutMs = 500) {
    const controller = new ModelController({
      clientVersion: "0.1.0",
      requestTimeoutMs,
      websocketFactory: nodeWebSocketFactory,
    });
    detach = controller.onEvent((event) => events.push(event));
    const parsed = createLoopbackEndpoint("127.0.0.1", server.port);
    if (parsed === null) throw new Error("unreachable");
    await controller.connect(parsed);
    const switcher = new PhaseModelSwitcher(controller, CONFIG);
    detach = switcher.onEvent((event) => events.push(event));
    switcher.start();
    return { controller, switcher };
  }

  async function bindAndTriggerDefault() {
    server.broadcast(threadStartedNotification("thr-001"));
    await waitForEvent(events, "threadSubscribed");
    server.broadcast(settingsNotification("thr-001", "default"));
  }

  it("fails open on a JSON-RPC error and disables exactly once", { timeout: 10_000 }, async () => {
    server.setSettingsUpdateBehavior("reject");
    const { controller, switcher } = await startedSwitcher();
    await bindAndTriggerDefault();

    const disabled = await waitForEvent(events, "automationDisabled");
    expect(disabled.reason).toContain("model application failed");
    expect(switcher.state).toBe("disabled");
    // The controller stays healthy — only the AUTOMATION is disabled.
    expect(controller.state).toBe("listening");

    // Further mode events produce zero writes and zero extra warnings.
    server.broadcast(settingsNotification("thr-001", "plan"));
    await new Promise((resolve) => setTimeout(resolve, 200));
    server.broadcast(settingsNotification("thr-001", "default"));
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(server.settingsUpdateRequests()).toHaveLength(1); // only the failed one
    expect(events.filter((event) => event.type === "automationDisabled")).toHaveLength(1);

    await switcher.stop();
  });

  it("fails open on timeout", { timeout: 10_000 }, async () => {
    server.setSettingsUpdateDelay(1_500);
    const { controller, switcher } = await startedSwitcher(300); // tight budget
    await bindAndTriggerDefault();

    await waitForEvent(events, "automationDisabled");
    expect(switcher.state).toBe("disabled");
    expect(controller.state).toBe("listening");

    await switcher.stop();
  });

  it("fails open on connection close without killing the app-server", { timeout: 10_000 }, async () => {
    const { controller, switcher } = await startedSwitcher();
    await bindAndTriggerDefault();
    // Close the socket WHILE the write is in flight.
    server.closeConnection(0);

    await waitForEvent(events, "automationDisabled");
    expect(switcher.state).toBe("disabled");
    // The controller observes the same closure independently (fail-open).
    await waitForEvent(events, "disabled");
    expect(controller.state).toBe("disabled");

    await switcher.stop();
  });

  it("treats a rejected configured model as an automation failure (no fallback)", { timeout: 10_000 }, async () => {
    server.setSettingsUpdateBehavior("reject");
    const { switcher } = await startedSwitcher();
    await bindAndTriggerDefault();

    await waitForEvent(events, "automationDisabled");
    expect(switcher.state).toBe("disabled");
    // No substitute model was attempted.
    expect(
      server.settingsUpdateRequests().some((params) => params.model !== "exec-model-Y"),
    ).toBe(false);

    await switcher.stop();
  });

  it("stops applying when the ModelController itself disables", { timeout: 10_000 }, async () => {
    const { switcher } = await startedSwitcher();
    await bindAndTriggerDefault();

    // Controller-level failure (e.g. protocol loss): switcher must disable.
    server.sendRawTo(0, "broken json frame");
    await waitForEvent(events, "automationDisabled");
    expect(switcher.state).toBe("disabled");

    await switcher.stop();
    expect(switcher.state).toBe("stopped");
  });
});

describe("PhaseModelSwitcher lifecycle", () => {
  let server: FakeAppServer;
  let events: Array<ControllerEvent | SwitcherEvent>;
  let detach: (() => void) | null = null;

  beforeEach(async () => {
    server = await startFakeAppServer();
    events = [];
  });

  afterEach(async () => {
    detach?.();
    detach = null;
    await server.close();
  });

  it("start() requires idle; stop() is idempotent and settles the in-flight write", { timeout: 10_000 }, async () => {
    server.setSettingsUpdateDelay(250);
    const controller = new ModelController({
      clientVersion: "0.1.0",
      requestTimeoutMs: 500,
      websocketFactory: nodeWebSocketFactory,
    });
    detach = controller.onEvent((event) => events.push(event));
    const parsed = createLoopbackEndpoint("127.0.0.1", server.port);
    if (parsed === null) throw new Error("unreachable");
    await controller.connect(parsed);

    const switcher = new PhaseModelSwitcher(controller, CONFIG);
    detach = switcher.onEvent((event) => events.push(event));
    switcher.start();
    expect(switcher.state).toBe("active");
    expect(() => switcher.start()).toThrow(/idle/);

    server.broadcast(threadStartedNotification("thr-001"));
    await waitForEvent(events, "threadSubscribed");
    server.broadcast(settingsNotification("thr-001", "default"));
    await waitForPredicate(
      () => server.settingsUpdateRequests().length === 1,
      2_000,
      "in-flight write observable",
    );

    const began = Date.now();
    await switcher.stop();
    await switcher.stop();
    // stop() waited for the in-flight write to settle.
    expect(Date.now() - began).toBeGreaterThanOrEqual(200);
    expect(switcher.state).toBe("stopped");
    expect(server.settingsUpdateRequests()).toHaveLength(1);

    // After stop(), further mode events produce no writes.
    server.broadcast(settingsNotification("thr-001", "plan"));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(server.settingsUpdateRequests()).toHaveLength(1);
  });
});
