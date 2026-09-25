/**
 * Minimal JSON-RPC connection over a loopback WebSocket to the dedicated
 * Codex app-server (Phase 2 directive §4-6).
 *
 * Responsibilities (transport only — no controller semantics):
 * - argv-free, dependency-free client via Node's built-in WebSocket
 *   (injectable factory for tests);
 * - `request()` with strict response-id correlation and per-request timeout
 *   (ids are local monotonic integers — directive §5);
 * - `notify()` emitting exact JSON-RPC notification frames;
 * - incoming dispatch: correlated responses, notifications, and a minimal
 *   protocol-correct rejection for server-initiated requests (§22);
 * - deterministic close that rejects every pending request exactly once.
 *
 * Message policy (§6): only JSON text frames are JSON-RPC payloads. A JSON
 * parse failure is a protocol failure (surfaced via `onProtocolError`, then
 * the socket is closed) — never an unhandled rejection. Binary frames and
 * protocol-level ping/pong are handled below this layer and ignored here.
 * A response with an unknown id is a diagnostic (counted + reported), not a
 * fatal error — the controller must not treat arbitrary traffic as its own.
 */

export interface RpcNotification {
  readonly method: string;
  readonly params?: unknown;
}

/** Server-initiated JSON-RPC request (controller is not an interactive client). */
export interface RpcServerRequest {
  readonly id: unknown;
  readonly method: string;
  readonly params?: unknown;
}

/** Minimal socket surface satisfied by Node's global WebSocket and by `ws`. */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: { code?: number; data?: unknown; reason?: unknown }) => void,
  ): void;
  removeEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: { code?: number; data?: unknown; reason?: unknown }) => void,
  ): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

/** Default factory: Node's built-in (undici) WebSocket client. */
export const nodeWebSocketFactory: WebSocketFactory = (url) => {
  const ws = new WebSocket(url);
  return ws as unknown as WebSocketLike;
};

export class RpcConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RpcConnectionError";
  }
}

/** JSON-RPC error object returned by the server (or synthesized locally). */
export interface RpcErrorPayload {
  readonly code: number | unknown;
  readonly message: string;
  readonly data?: unknown;
}

export class RpcRequestError extends Error {
  readonly payload: RpcErrorPayload;
  constructor(payload: RpcErrorPayload) {
    super(`JSON-RPC error ${String(payload.code)}: ${payload.message}`);
    this.name = "RpcRequestError";
    this.payload = payload;
  }
}

export interface AppServerRpcOptions {
  /** Per-request timeout; initialize uses `Math.max(this, 10s)` headroom. */
  readonly requestTimeoutMs?: number;
  /** Socket seam for tests; defaults to Node's built-in WebSocket client. */
  readonly websocketFactory?: WebSocketFactory;
  readonly onNotification?: (notification: RpcNotification) => void;
  /** Server-initiated requests. Default: JSON-RPC -32601 rejection (§22). */
  readonly onServerRequest?: (request: RpcServerRequest) => void;
  /** Malformed text frame or protocol-level violation. Fatal to the socket. */
  readonly onProtocolError?: (error: RpcConnectionError) => void;
  /** Socket closed (after open). Pending requests are already rejected. */
  readonly onClosed?: (info: { code: number | undefined }) => void;
  /** Stray response id — diagnostic only. */
  readonly onStrayResponse?: (id: unknown) => void;
}

interface PendingRequest {
  readonly id: number;
  readonly timer: NodeJS.Timeout;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export class AppServerRpcConnection {
  private readonly url: string;
  private readonly options: AppServerRpcOptions;
  private readonly factory: WebSocketFactory;
  private readonly pending = new Map<number, PendingRequest>();

  private socket: WebSocketLike | null = null;
  private nextRequestId = 1;
  private opened = false;
  private closeRequested = false;
  private closePromise: Promise<void> | null = null;

  constructor(url: string, options: AppServerRpcOptions = {}) {
    this.url = url;
    this.options = options;
    this.factory = options.websocketFactory ?? nodeWebSocketFactory;
  }

  get isOpen(): boolean {
    return this.opened && !this.closeRequested;
  }

  /** Open the socket; resolves on `open`, rejects on `error`/close-first. */
  async open(): Promise<void> {
    if (this.socket !== null) {
      throw new RpcConnectionError("connection already opened");
    }
    const socket = this.factory(this.url);
    this.socket = socket;
    socket.addEventListener("message", this.handleMessageEvent);
    socket.addEventListener("close", this.handleCloseEvent);
    socket.addEventListener("error", this.handleErrorEvent);

    await new Promise<void>((resolve, reject) => {
      const onOpen = (): void => {
        cleanup();
        this.opened = true;
        resolve();
      };
      const onClose = (event: { code?: number }): void => {
        cleanup();
        reject(new RpcConnectionError(`connection closed before opening (code ${event.code ?? "?"})`));
      };
      const onError = (): void => {
        cleanup();
        reject(new RpcConnectionError("connection error before opening"));
      };
      const cleanup = (): void => {
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("close", onClose);
        socket.removeEventListener("error", onError);
      };
      socket.addEventListener("open", onOpen);
      socket.addEventListener("close", onClose);
      socket.addEventListener("error", onError);
    });
  }

  /** Send a JSON-RPC request and await the exactly-correlated response. */
  async request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.socket === null || !this.opened || this.closeRequested) {
      throw new RpcConnectionError("connection is not open");
    }
    const id = this.nextRequestId++;
    const effectiveTimeout = timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const request = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcRequestError({ code: "timeout", message: `${method} timed out after ${effectiveTimeout}ms` }));
      }, effectiveTimeout);
      this.pending.set(id, {
        id,
        timer,
        resolve,
        reject,
      });
    });
    this.sendFrame({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
    return request;
  }

  /** Send a JSON-RPC notification. `initialized` must carry NO params key. */
  notify(method: string, params?: unknown): void {
    if (this.socket === null || !this.opened || this.closeRequested) {
      throw new RpcConnectionError("connection is not open");
    }
    this.sendFrame({
      jsonrpc: "2.0",
      method,
      ...(params !== undefined ? { params } : {}),
    });
  }

  /**
   * Respond to a server-initiated request with a JSON-RPC error (§22) so the
   * server does not hang waiting on a non-interactive observer client.
   */
  respondError(id: unknown, code: number, message: string): void {
    if (this.socket === null || !this.opened || this.closeRequested) {
      return;
    }
    this.sendFrame({ jsonrpc: "2.0", id, error: { code, message } });
  }

  /**
   * Deterministic close: reject/cancel pending requests, stop the dispatch
   * loop, wait for the socket close event. Idempotent.
   */
  async close(): Promise<void> {
    if (this.closePromise !== null) {
      return this.closePromise;
    }
    this.closePromise = this.performClose();
    return this.closePromise;
  }

  private async performClose(): Promise<void> {
    this.closeRequested = true;
    this.rejectAllPending(new RpcConnectionError("connection closed by client"));
    const socket = this.socket;
    if (socket === null) {
      return;
    }
    if (!this.opened) {
      return;
    }
    await new Promise<void>((resolve) => {
      let timeout: NodeJS.Timeout | undefined;
      const finish = (): void => {
        if (timeout !== undefined) {
          clearTimeout(timeout);
          timeout = undefined;
        }
        socket.removeEventListener("close", onClose);
        resolve();
      };
      const onClose = (): void => {
        finish();
      };
      socket.addEventListener("close", onClose);
      try {
        socket.close(1000, "controller shutdown");
      } catch {
        // Already closing/closed — the close event resolves us.
      }
      timeout = setTimeout(finish, 3_000);
    });
  }

  // ----------------------------------------------------------------------
  // Incoming dispatch
  // ----------------------------------------------------------------------

  private readonly handleMessageEvent = (event: { data?: unknown }): void => {
    if (this.closeRequested) {
      return;
    }
    const data = event.data;
    if (typeof data !== "string") {
      // Binary frames are not JSON-RPC application payloads (§6) — ignored.
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(data);
    } catch {
      this.protocolFailure(`non-JSON text frame: ${data.slice(0, 120)}`);
      return;
    }
    if (typeof message !== "object" || message === null || Array.isArray(message)) {
      this.protocolFailure(`non-object JSON-RPC frame: ${data.slice(0, 120)}`);
      return;
    }
    const record = message as Record<string, unknown>;
    const hasId = record.id !== undefined && record.id !== null;
    const method = typeof record.method === "string" ? record.method : null;

    if (hasId && method !== null) {
      // Server-initiated request — never treated as a notification (§22).
      this.options.onServerRequest?.({ id: record.id, method, params: record.params });
      return;
    }
    if (hasId) {
      this.handleResponse(record);
      return;
    }
    if (method !== null) {
      this.options.onNotification?.({ method, params: record.params });
      return;
    }
    // Neither request nor response — malformed frame.
    this.protocolFailure(`unroutable JSON-RPC frame: ${data.slice(0, 120)}`);
  };

  private handleResponse(record: Record<string, unknown>): void {
    const id = record.id;
    const numericId = typeof id === "number" ? id : Number.NaN;
    const pending = this.pending.get(numericId);
    if (pending === undefined) {
      // Unknown/mismatched response id: diagnostic, never fatal (§5).
      this.options.onStrayResponse?.(id);
      return;
    }
    this.pending.delete(numericId);
    clearTimeout(pending.timer);
    if (record.error !== undefined) {
      const err = record.error as Record<string, unknown> | undefined;
      pending.reject(
        new RpcRequestError({
          code: err?.code ?? "unknown",
          message: typeof err?.message === "string" ? err.message : "unknown JSON-RPC error",
          data: err?.data,
        }),
      );
      return;
    }
    pending.resolve(record.result);
  }

  private protocolFailure(detail: string): void {
    const error = new RpcConnectionError(`protocol failure: ${detail}`);
    this.options.onProtocolError?.(error);
    // A protocol failure poisons the frame stream: drop the socket.
    this.closeRequested = true;
    this.rejectAllPending(error);
    try {
      this.socket?.close(1002, "protocol error");
    } catch {
      // Socket already gone.
    }
  }

  private readonly handleErrorEvent = (): void => {
    if (!this.opened) {
      return;
    }
    this.rejectAllPending(new RpcConnectionError("connection error"));
  };

  private readonly handleCloseEvent = (event: { code?: number }): void => {
    const wasOpen = this.opened;
    this.opened = false;
    this.rejectAllPending(new RpcConnectionError(`connection closed (code ${event.code ?? "?"})`));
    if (wasOpen) {
      this.options.onClosed?.({ code: event.code });
    }
  };

  private rejectAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private sendFrame(frame: Record<string, unknown>): void {
    try {
      this.socket?.send(JSON.stringify(frame));
    } catch (error) {
      throw new RpcConnectionError(
        `send failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
