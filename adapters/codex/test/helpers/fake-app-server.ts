/**
 * Minimal fake WebSocket JSON-RPC app-server for controller tests
 * (Phase 2 directive §29): accepts connections, captures the handshake,
 * replies to `initialize` per configuration, lets tests inject arbitrary
 * frames/notifications, and closes connections on demand.
 *
 * It deliberately does NOT emulate Codex semantics — only enough JSON-RPC
 * mechanics to test OUR transport, controller state, thread binding and mode
 * observation against real sockets.
 */

import { WebSocketServer, WebSocket, type RawData } from "ws";

export interface FakeConnectionView {
  /** Parsed JSON-RPC frames received FROM the tested client. */
  readonly received: Array<Record<string, unknown>>;
  /** Raw text frames received (for non-JSON client output probing). */
  readonly receivedRaw: readonly string[];
  /** Every frame the fake server sent to this connection. */
  readonly sent: readonly unknown[];
  /** True once the socket close handshake completed. */
  readonly closed: boolean;
}

export interface FakeAppServer {
  readonly url: string;
  readonly port: number;
  connections(): FakeConnectionView[];
  connectionCount(): number;
  /** Server → every connection: JSON-RPC notification. */
  broadcast(notification: { method: string; params?: unknown }): void;
  /** Server → one connection: any JSON frame. */
  sendTo(index: number, frame: unknown): void;
  /** Server → one connection: raw text (e.g. malformed JSON). */
  sendRawTo(index: number, text: string): void;
  /** Server → one connection: binary frame (must be ignored as payload). */
  sendBinaryTo(index: number, bytes: Uint8Array): void;
  /** Server → one connection: protocol-level ping (auto-ponged by clients). */
  pingTo(index: number): void;
  /** Override the initialize reply before/after connect(). */
  respondToInitializeWith(result: unknown): void;
  failInitializeWith(code: number, message: string): void;
  /** Stop replying to initialize at all (timeout tests). */
  silenceInitialize(): void;
  /** How `thread/resume` is answered: "ok" (default) or rejected. */
  setThreadResumeBehavior(behavior: "ok" | "reject"): void;
  closeConnection(index: number, code?: number): void;
  close(): Promise<void>;
}

interface ConnectionRecord {
  socket: WebSocket;
  received: Array<Record<string, unknown>>;
  receivedRaw: string[];
  sent: unknown[];
  closed: boolean;
}

export async function startFakeAppServer(): Promise<FakeAppServer> {
  let initializeResult: unknown = { userAgent: "fake-codex/0.0.0" };
  let initializeFailure: { code: number; message: string } | null = null;
  let respondToInitialize = true;
  let threadResumeBehavior: "ok" | "reject" = "ok";

  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => wss.on("listening", resolve));
  const address = wss.address();
  if (address === null || typeof address === "string") {
    throw new Error("fake app-server failed to bind");
  }

  const records: ConnectionRecord[] = [];

  const replyInitialize = (record: ConnectionRecord, frame: Record<string, unknown>): void => {
    if (!respondToInitialize) {
      return;
    }
    if (initializeFailure !== null) {
      send(record, {
        jsonrpc: "2.0",
        id: frame.id,
        error: { code: initializeFailure.code, message: initializeFailure.message },
      });
      return;
    }
    send(record, { jsonrpc: "2.0", id: frame.id, result: initializeResult });
  };

  const handleMessage = (record: ConnectionRecord, data: RawData): void => {
    const text = data.toString();
    record.receivedRaw.push(text);
    let frame: unknown;
    try {
      frame = JSON.parse(text);
    } catch {
      return; // client sent garbage; recorded for diagnostics
    }
    if (typeof frame !== "object" || frame === null) {
      return;
    }
    const typed = frame as Record<string, unknown>;
    record.received.push(typed);
    if (typed.method === "initialize" && typeof typed.id !== "undefined") {
      replyInitialize(record, typed);
      return;
    }
    if (typed.method === "thread/resume" && typeof typed.id !== "undefined") {
      if (threadResumeBehavior === "ok") {
        send(record, { jsonrpc: "2.0", id: typed.id, result: { thread: { id: null } } });
      } else {
        send(record, {
          jsonrpc: "2.0",
          id: typed.id,
          error: { code: -32600, message: "no rollout found for thread id (fake)" },
        });
      }
    }
    // `initialized` and anything else: recorded only.
  };

  wss.on("connection", (socket: WebSocket) => {
    const record: ConnectionRecord = {
      socket,
      received: [],
      receivedRaw: [],
      sent: [],
      closed: false,
    };
    records.push(record);
    socket.on("message", (data: RawData) => handleMessage(record, data));
    socket.on("close", () => {
      record.closed = true;
    });
  });

  function send(record: ConnectionRecord, frame: unknown): void {
    record.sent.push(frame);
    record.socket.send(JSON.stringify(frame));
  }

  const viewOf = (record: ConnectionRecord): FakeConnectionView => ({
    received: record.received,
    receivedRaw: record.receivedRaw,
    sent: record.sent,
    closed: record.closed,
  });

  return {
    url: `ws://127.0.0.1:${address.port}`,
    port: address.port,
    connections: () => records.map(viewOf),
    connectionCount: () => records.length,
    broadcast: (notification) => {
      for (const record of records) {
        send(record, { jsonrpc: "2.0", ...notification });
      }
    },
    sendTo: (index, frame) => {
      const record = records[index];
      if (record !== undefined) {
        send(record, frame);
      }
    },
    sendRawTo: (index, text) => {
      records[index]?.socket.send(text);
    },
    sendBinaryTo: (index, bytes) => {
      records[index]?.socket.send(Buffer.from(bytes), { binary: true });
    },
    pingTo: (index) => {
      records[index]?.socket.ping();
    },
    respondToInitializeWith: (result) => {
      initializeResult = result;
      initializeFailure = null;
      respondToInitialize = true;
    },
    failInitializeWith: (code, message) => {
      initializeFailure = { code, message };
      respondToInitialize = true;
    },
    silenceInitialize: () => {
      respondToInitialize = false;
    },
    setThreadResumeBehavior: (behavior) => {
      threadResumeBehavior = behavior;
    },
    closeConnection: (index, code) => {
      records[index]?.socket.close(code ?? 1000);
    },
    close: () =>
      new Promise((resolve) => {
        for (const record of records) {
          record.socket.terminate();
        }
        wss.close(() => resolve());
      }),
  };
}
