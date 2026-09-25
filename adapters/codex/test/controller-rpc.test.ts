import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AppServerRpcConnection,
  RpcConnectionError,
  nodeWebSocketFactory,
} from "../src/controller/app-server-rpc.js";
import { startFakeAppServer, type FakeAppServer } from "./helpers/fake-app-server.js";

describe("AppServerRpcConnection", () => {
  let server: FakeAppServer;

  beforeEach(async () => {
    server = await startFakeAppServer();
  });

  afterEach(async () => {
    await server.close();
  });

  function connect(options?: ConstructorParameters<typeof AppServerRpcConnection>[1]) {
    return new AppServerRpcConnection(server.url, {
      websocketFactory: nodeWebSocketFactory,
      requestTimeoutMs: 500,
      ...options,
    });
  }

  it("connects, correlates the initialize request id, and replies", { timeout: 10_000 }, async () => {
    const rpc = connect();
    await rpc.open();

    const result = await rpc.request("initialize", {
      clientInfo: { name: "phase-model-controller", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });

    expect(result).toEqual({ userAgent: "fake-codex/0.0.0" });
    const clientFrame = server.connections()[0]?.received[0];
    expect(clientFrame?.jsonrpc).toBe("2.0");
    expect(clientFrame?.id).toBe(1);
    expect(clientFrame?.method).toBe("initialize");

    await rpc.close();
    expect(rpc.isOpen).toBe(false);
  });

  it("monotonically increases request ids", { timeout: 10_000 }, async () => {
    const rpc = connect();
    await rpc.open();
    await rpc.request("initialize", {});
    await rpc.request("thread/resume", { threadId: "t1" });

    const [, second] = server.connections()[0]?.received ?? [];
    expect(second?.id).toBe(2);

    await rpc.close();
  });

  it("rejects with the server's JSON-RPC error payload", { timeout: 10_000 }, async () => {
    server.failInitializeWith(-32000, "experimental API disabled");
    const rpc = connect();
    await rpc.open();

    await expect(rpc.request("initialize", {})).rejects.toMatchObject({
      name: "RpcRequestError",
      payload: { code: -32000, message: "experimental API disabled" },
    });

    await rpc.close();
  });

  it("treats a mismatched response id as a stray diagnostic, not a resolution", { timeout: 10_000 }, async () => {
    server.silenceInitialize();
    const strays: unknown[] = [];
    const rpc = connect({ onStrayResponse: (id) => strays.push(id) });
    await rpc.open();

    const promise = rpc.request("initialize", {});
    // A response with an id we never issued must not satisfy the request.
    server.sendTo(0, { jsonrpc: "2.0", id: 999, result: { wrong: true } });
    await expect(promise).rejects.toMatchObject({ payload: { code: "timeout" } });
    expect(strays).toContain(999);

    await rpc.close();
  });

  it("sends `initialized` as an exact notification frame with NO params key", { timeout: 10_000 }, async () => {
    const rpc = connect();
    await rpc.open();
    await rpc.request("initialize", {});
    rpc.notify("initialized");

    await new Promise((resolve) => setTimeout(resolve, 100));
    const [, initializedFrame] = server.connections()[0]?.received ?? [];
    expect(initializedFrame).toEqual({ jsonrpc: "2.0", method: "initialized" });
    expect(Object.hasOwn(initializedFrame ?? {}, "params")).toBe(false);

    await rpc.close();
  });

  it("fails fatally on malformed JSON text frames", { timeout: 10_000 }, async () => {
    const protocolErrors: string[] = [];
    const rpc = connect({ onProtocolError: (error) => protocolErrors.push(error.message) });
    await rpc.open();

    const pending = rpc.request("initialize", {});
    server.sendRawTo(0, "this is not json at all");

    await expect(pending).rejects.toBeInstanceOf(RpcConnectionError);
    expect(protocolErrors).toHaveLength(1);
    expect(rpc.isOpen).toBe(false);
  });

  it("ignores binary frames as non-JSON-RPC payloads", { timeout: 10_000 }, async () => {
    const protocolErrors: string[] = [];
    const rpc = connect({ onProtocolError: (error) => protocolErrors.push(error.message) });
    await rpc.open();
    await rpc.request("initialize", {});

    server.sendBinaryTo(0, new Uint8Array([0, 159, 146, 150]));
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(protocolErrors).toHaveLength(0);
    expect(rpc.isOpen).toBe(true);

    await rpc.close();
  });

  it("survives protocol-level pings (auto-pong below the application layer)", { timeout: 10_000 }, async () => {
    const protocolErrors: string[] = [];
    const rpc = connect({ onProtocolError: (error) => protocolErrors.push(error.message) });
    await rpc.open();
    await rpc.request("initialize", {});

    server.pingTo(0);
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(protocolErrors).toHaveLength(0);
    expect(rpc.isOpen).toBe(true);

    await rpc.close();
  });

  it("reports server-initiated requests to the handler", { timeout: 10_000 }, async () => {
    const serverRequests: Array<{ id: unknown; method: string }> = [];
    const rpc = connect({
      onServerRequest: (request) => serverRequests.push({ id: request.id, method: request.method }),
    });
    await rpc.open();
    await rpc.request("initialize", {});

    server.sendTo(0, { jsonrpc: "2.0", id: "srv-1", method: "item/tool/requestApproval", params: {} });
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(serverRequests).toEqual([{ id: "srv-1", method: "item/tool/requestApproval" }]);

    await rpc.close();
  });

  it("responds to server requests with a -32601 rejection when wired", { timeout: 10_000 }, async () => {
    const rpc = connect({
      onServerRequest: (request) => rpc.respondError(request.id, -32601, "Method not supported by controller"),
    });
    await rpc.open();
    await rpc.request("initialize", {});

    server.sendTo(0, { jsonrpc: "2.0", id: 77, method: "some/serverRequest", params: {} });
    await new Promise((resolve) => setTimeout(resolve, 150));

    // The error response travels client → server, so it lands in `received`.
    const errorFrame = server
      .connections()[0]?.received.find((frame) => (frame as Record<string, unknown>).error !== undefined) as
      | Record<string, unknown>
      | undefined;
    expect(errorFrame?.id).toBe(77);
    expect((errorFrame?.error as Record<string, unknown>)?.code).toBe(-32601);

    await rpc.close();
  });

  it("rejects pending requests when the server closes the connection", { timeout: 10_000 }, async () => {
    const rpc = connect({ requestTimeoutMs: 5_000 });
    await rpc.open();

    const pending = rpc.request("initialize", {});
    server.closeConnection(0);

    await expect(pending).rejects.toBeInstanceOf(RpcConnectionError);
  });

  it("close() is idempotent and rejects pending requests exactly once", { timeout: 10_000 }, async () => {
    const rejections: unknown[] = [];
    const rpc = connect();
    await rpc.open();
    const pending = rpc.request("initialize", {}).catch((error) => {
      rejections.push(error);
      return error;
    });

    await Promise.all([rpc.close(), rpc.close()]);
    await pending;
    await rpc.close();

    expect(rejections).toHaveLength(1);
    expect(rpc.isOpen).toBe(false);
  });

  it("times out a request that never receives a response", { timeout: 10_000 }, async () => {
    server.silenceInitialize();
    const rpc = connect({ requestTimeoutMs: 100 });
    await rpc.open();

    await expect(rpc.request("initialize", {})).rejects.toMatchObject({
      payload: { code: "timeout" },
    });

    await rpc.close();
  });

  it("fails fast when the endpoint is unreachable", { timeout: 10_000 }, async () => {
    const rpc = new AppServerRpcConnection("ws://127.0.0.1:1/unreachable", {
      websocketFactory: nodeWebSocketFactory,
    });
    await expect(rpc.open()).rejects.toBeInstanceOf(RpcConnectionError);
    expect(rpc.isOpen).toBe(false);
  });
});
