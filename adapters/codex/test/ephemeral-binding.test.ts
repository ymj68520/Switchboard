import { afterEach, describe, expect, it } from "vitest";

import { ModelController } from "../src/index.js";
import { startFakeAppServer, type FakeAppServer } from "./helpers/fake-app-server.js";

/**
 * Phase 5 binding-scope regression tests (empirical 0.156.1 finding).
 *
 * The REAL Codex TUI spawns short-lived internal helper threads for thread
 * title generation. On the wire they are TOP-LEVEL (parentThreadId == null —
 * structurally so: ThreadStartParams has no parent field) but are marked
 * `ephemeral: true` + `threadSource: "thread_title"`, never persist a
 * rollout (path: null), and are NOT the conversation thread. Binding one
 * would permanently hijack the controller away from the real thread: its
 * subscription can never converge and the real thread's mode events would
 * be ignored. These tests pin the metadata-exact filter.
 */

const USER_THREAD_PARAMS = {
  threadId: "11111111-1111-1111-1111-111111111111",
  thread: {
    id: "11111111-1111-1111-1111-111111111111",
    parentThreadId: null,
    ephemeral: false,
    threadSource: "user",
  },
};

const TITLE_THREAD_PARAMS = {
  threadId: "22222222-2222-2222-2222-222222222222",
  thread: {
    id: "22222222-2222-2222-2222-222222222222",
    parentThreadId: null,
    ephemeral: true,
    threadSource: "thread_title",
  },
};

async function connectedController(server: FakeAppServer): Promise<ModelController> {
  const controller = new ModelController();
  const withoutScheme = server.url.replace("ws://", "");
  const colon = withoutScheme.indexOf(":");
  const host = withoutScheme.slice(0, colon) === "127.0.0.1" ? ("127.0.0.1" as const) : "127.0.0.1";
  const port = Number(withoutScheme.slice(colon + 1));
  await controller.connect({
    host,
    port,
    wsUrl: server.url,
    httpBaseUrl: `http://127.0.0.1:${port}`,
  });
  return controller;
}

describe("controller binding ignores internal helper threads (Phase 5)", () => {
  const servers: FakeAppServer[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await server.close();
    }
  });

  it("does not bind an ephemeral thread_title thread", async () => {
    const server = await startFakeAppServer();
    servers.push(server);
    const controller = await connectedController(server);
    try {
      server.broadcast({ method: "thread/started", params: TITLE_THREAD_PARAMS });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(controller.boundThreadId).toBeNull();
      expect(server.resumeRequestCount()).toBe(0);
      expect(controller.state).toBe("listening");
    } finally {
      await controller.stop();
    }
  });

  it("keeps binding the real user thread that arrives BEFORE the title thread", async () => {
    const server = await startFakeAppServer();
    servers.push(server);
    const controller = await connectedController(server);
    try {
      // Real TUI order: user conversation thread first (TUI startup), then
      // the title-generation thread when the first prompt is submitted.
      server.broadcast({ method: "thread/started", params: USER_THREAD_PARAMS });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(controller.boundThreadId).toBe(USER_THREAD_PARAMS.threadId);

      server.broadcast({ method: "thread/started", params: TITLE_THREAD_PARAMS });
      await new Promise((resolve) => setTimeout(resolve, 100));
      // The binding must NOT move to the helper thread.
      expect(controller.boundThreadId).toBe(USER_THREAD_PARAMS.threadId);
      // Resume: exactly the user-thread attempts (bind + none for title).
      expect(server.resumeRequestCount()).toBe(1);

      // Mode observation still works on the REAL thread after the helper.
      server.broadcast({
        method: "thread/settings/updated",
        params: {
          threadId: USER_THREAD_PARAMS.threadId,
          threadSettings: {
            model: "m",
            collaborationMode: { mode: "default", settings: { model: "m" } },
          },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(controller.observedMode).toBe("default");
    } finally {
      await controller.stop();
    }
  });

  it("still binds a top-level thread when ephemeral/threadSource fields are absent (tolerant reading)", async () => {
    const server = await startFakeAppServer();
    servers.push(server);
    const controller = await connectedController(server);
    try {
      server.broadcast({
        method: "thread/started",
        params: { thread: { id: "33333333-3333-3333-3333-333333333333", parentThreadId: null } },
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(controller.boundThreadId).toBe("33333333-3333-3333-3333-333333333333");
    } finally {
      await controller.stop();
    }
  });
});
