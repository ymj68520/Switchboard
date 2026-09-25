/**
 * ModelController — the launcher-internal controller lifecycle, top-level
 * thread binding and native collaboration-mode observation (Phase 2).
 *
 * Phase boundary: the controller ONLY OBSERVES. It has no model fields and
 * never sends `thread/settings/update` — mode transitions are surfaced as
 * domain events for Phase 3 (directive §2, §19-21).
 *
 * Handshake (directive §7-9, verified on codex-cli 0.156.1):
 *   connect → initialize (clientInfo + capabilities.experimentalApi=true)
 *           → exact-id success response → `initialized` notification with
 *             NO params key → LISTENING.
 *
 * Observation semantics (directive §12-19):
 * - only `thread/started` and `thread/settings/updated` are consumed; all
 *   other notifications are ignored (unknown ≠ fatal);
 * - top-level binding uses ONLY `parentThreadId == null` (no heuristics);
 * - a new top-level thread replaces the binding and clears `last_mode`;
 *   a duplicate `thread/started` for the current thread is ignored;
 * - settings for a non-current thread are ignored;
 * - first observed mode emits InitialModeObserved; a changed mode emits
 *   ModeChanged; same-mode updates (including model-only changes) emit
 *   nothing;
 * - an unknown mode value disables the controller (explicit unsupported,
 *   never guessed) — fail-open direction (Architecture SPEC §21.2);
 * - malformed required notifications disable the controller.
 *
 * Thread event subscription (empirical 0.156.1 requirement, reported to the
 * Phase 2 directive §30): `thread/settings/updated` is a THREAD-SCOPED
 * notification on this app-server version. A side client receives it only
 * after attaching to the thread via `thread/resume`. The controller issues
 * exactly one resume per bound thread — purely to join the notification
 * fan-out, NOT session recovery: no state reconstruction, no rebind, no
 * reconnect. A fresh thread without a persisted rollout rejects resume
 * ("no rollout found"); that outcome is a subscription-pending diagnostic
 * (fail-open), never a controller failure, and never retried automatically.
 *
 * Failure model (directive §23): any post-connect protocol failure disables
 * the controller. There is no automatic reconnect.
 */

import {
  AppServerRpcConnection,
  RpcConnectionError,
  RpcRequestError,
  type AppServerRpcOptions,
  type WebSocketFactory,
} from "./app-server-rpc.js";
import {
  parseInitializeResult,
  parseThreadSettingsUpdated,
  parseThreadStarted,
  type CollaborationModeKind,
  type ServerInfoView,
} from "./protocol-types.js";
import type { LoopbackEndpoint } from "../runtime/types.js";

export type ControllerState =
  | "disconnected"
  | "connecting"
  | "initializing"
  | "listening"
  | "disabled"
  | "stopped";

export type ControllerEvent =
  | { type: "topLevelThreadBound"; threadId: string }
  | { type: "initialModeObserved"; threadId: string; mode: CollaborationModeKind }
  | { type: "modeChanged"; threadId: string; from: CollaborationModeKind; to: CollaborationModeKind }
  | { type: "threadSubscribed"; threadId: string }
  | { type: "threadSubscriptionPending"; threadId: string; reason: string }
  | { type: "disabled"; reason: string };

export interface ModelControllerOptions {
  /** Stable client identity for initialize (directive §7). */
  readonly clientName?: string;
  readonly clientVersion?: string;
  readonly requestTimeoutMs?: number;
  readonly initializeTimeoutMs?: number;
  /** Test seam. */
  readonly websocketFactory?: WebSocketFactory;
}

export const CONTROLLER_CLIENT_NAME = "phase-model-controller";

/** Default initialize timeout — the handshake must not hang (§8). */
const INITIALIZE_TIMEOUT_MS = 15_000;

interface ConnectionContext {
  readonly rpc: AppServerRpcConnection;
}

export class ModelController {
  private readonly options: Required<
    Pick<ModelControllerOptions, "clientName" | "clientVersion" | "requestTimeoutMs" | "initializeTimeoutMs">
  > & ModelControllerOptions;

  private controllerState: ControllerState = "disconnected";
  private connection: ConnectionContext | null = null;

  private currentThreadId: string | null = null;
  private lastMode: CollaborationModeKind | null = null;
  private serverInfo: ServerInfoView | null = null;

  private readonly listeners = new Set<(event: ControllerEvent) => void>();
  private stopPromise: Promise<void> | null = null;

  constructor(options: ModelControllerOptions = {}) {
    this.options = {
      clientName: options.clientName ?? CONTROLLER_CLIENT_NAME,
      clientVersion: options.clientVersion ?? "0.0.0",
      requestTimeoutMs: options.requestTimeoutMs ?? 10_000,
      initializeTimeoutMs: options.initializeTimeoutMs ?? INITIALIZE_TIMEOUT_MS,
      websocketFactory: options.websocketFactory,
    };
  }

  get state(): ControllerState {
    return this.controllerState;
  }

  get boundThreadId(): string | null {
    return this.currentThreadId;
  }

  get observedMode(): CollaborationModeKind | null {
    return this.lastMode;
  }

  /** Diagnostics-only server identity from the initialize response (§8). */
  get serverDiagnostics(): ServerInfoView | null {
    return this.serverInfo;
  }

  /** Register a domain-event listener; returns an unsubscribe function. */
  onEvent(listener: (event: ControllerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Connect to the Phase 1 READY endpoint and complete the initialize →
   * initialized handshake. Resolves once LISTENING. A failure before the
   * socket opened leaves the controller disconnected; any later failure
   * disables it (§23).
   */
  async connect(endpoint: LoopbackEndpoint): Promise<void> {
    if (this.controllerState !== "disconnected") {
      throw new RpcConnectionError(
        `connect() requires state "disconnected" (current: ${this.controllerState}); ` +
          "automatic reconnection is not part of the frozen architecture",
      );
    }
    this.controllerState = "connecting";

    const rpc = new AppServerRpcConnection(endpoint.wsUrl, this.rpcOptions());
    const context: ConnectionContext = { rpc };
    try {
      await rpc.open();
    } catch (error) {
      this.controllerState = "disconnected";
      throw error;
    }
    this.connection = context;

    this.controllerState = "initializing";
    try {
      await this.performHandshake(context);
    } catch (error) {
      await this.disableFrom(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
    this.controllerState = "listening";
  }

  /**
   * Deterministic stop (§24): mark stopping, close the socket, reject
   * pending RPCs, stop the dispatch. Idempotent, never kills the app-server
   * (child ownership stays with the Phase 1 runtime).
   */
  async stop(): Promise<void> {
    if (this.stopPromise !== null) {
      return this.stopPromise;
    }
    this.stopPromise = this.performStop();
    return this.stopPromise;
  }

  // ----------------------------------------------------------------------
  // Handshake
  // ----------------------------------------------------------------------

  private async performHandshake(context: ConnectionContext): Promise<void> {
    const result = await context.rpc.request(
      "initialize",
      {
        clientInfo: {
          name: this.options.clientName,
          version: this.options.clientVersion,
        },
        capabilities: {
          experimentalApi: true,
        },
      },
      this.options.initializeTimeoutMs,
    );
    // Diagnostics only — never a capability gate (SPEC §19).
    this.serverInfo = parseInitializeResult(result);

    // `initialized` with NO params — exact frame verified against 0.156.1.
    context.rpc.notify("initialized");
  }

  // ----------------------------------------------------------------------
  // Notification dispatch
  // ----------------------------------------------------------------------

  private rpcOptions(): AppServerRpcOptions {
    return {
      requestTimeoutMs: this.options.requestTimeoutMs,
      websocketFactory: this.options.websocketFactory,
      onNotification: (notification) => this.onNotification(notification.method, notification.params),
      onServerRequest: (request) => {
        // §22: the controller is a non-interactive observer — never execute
        // tools or user interaction; answer with the standard JSON-RPC
        // rejection so the server does not hang on an unanswered request.
        this.connection?.rpc.respondError(
          request.id,
          -32601,
          "Method not supported by controller",
        );
      },
      onProtocolError: (error) => {
        void this.disableFrom(error);
      },
      onClosed: () => {
        if (this.controllerState === "listening" || this.controllerState === "initializing") {
          void this.disableFrom(new RpcConnectionError("connection closed by app-server"));
        }
      },
      onStrayResponse: () => {
        // Diagnostic only (§5): counted upstream, not fatal here.
      },
    };
  }

  private onNotification(method: string, params: unknown): void {
    if (this.controllerState !== "listening") {
      // Pre-listening traffic is ignored; the handshake is in progress.
      return;
    }
    switch (method) {
      case "thread/started":
        this.onThreadStarted(params);
        return;
      case "thread/settings/updated":
        this.onThreadSettingsUpdated(params);
        return;
      default:
        // Unknown notification → ignore safely (§11).
        return;
    }
  }

  private onThreadStarted(params: unknown): void {
    const view = parseThreadStarted(params);
    if (view === null) {
      void this.disableFrom(
        new RpcConnectionError("malformed required notification: thread/started"),
      );
      return;
    }
    // §13: child/subagent threads never enter switching scope.
    if (view.parentThreadId !== null) {
      return;
    }
    // §15: duplicate top-level notification for the current thread → ignore.
    if (view.threadId === this.currentThreadId) {
      return;
    }
    // §14: bind new top-level thread, clear mode state.
    this.currentThreadId = view.threadId;
    this.lastMode = null;
    this.emit({ type: "topLevelThreadBound", threadId: view.threadId });
    this.subscribeToThreadEvents();
  }

  /**
   * One-shot notification fan-out subscription for the CURRENT binding via
   * `thread/resume`. Invoked automatically at bind time; also public for the
   * Phase 3 launcher, because on codex 0.156.1 a freshly created thread
   * cannot be resumed until its rollout exists (after the first turn).
   * Resolves true when subscribed. Never retries internally and never
   * disables the controller — observation gaps stay fail-open (§23).
   */
  subscribeToCurrentThread(): Promise<boolean> {
    const threadId = this.currentThreadId;
    if (threadId === null) {
      return Promise.resolve(false);
    }
    const connection = this.connection;
    if (connection === null || !connection.rpc.isOpen || this.controllerState !== "listening") {
      return Promise.resolve(false);
    }
    return connection.rpc
      .request("thread/resume", { threadId })
      .then(() => {
        if (this.controllerState === "listening" && this.currentThreadId === threadId) {
          this.emit({ type: "threadSubscribed", threadId });
          return true;
        }
        return false;
      })
      .catch((error: unknown) => {
        if (this.controllerState === "listening" && this.currentThreadId === threadId) {
          const reason =
            error instanceof RpcRequestError
              ? `thread/resume rejected: ${error.message}`
              : error instanceof Error
                ? error.message
                : String(error);
          this.emit({ type: "threadSubscriptionPending", threadId, reason });
        }
        return false;
      });
  }

  private subscribeToThreadEvents(): void {
    void this.subscribeToCurrentThread();
  }

  private onThreadSettingsUpdated(params: unknown): void {
    const view = parseThreadSettingsUpdated(params);
    if (view.kind === "malformed") {
      void this.disableFrom(
        new RpcConnectionError("malformed required notification: thread/settings/updated"),
      );
      return;
    }
    if (view.kind === "unsupportedMode") {
      // §18: unknown mode must be explicit, never guessed → disable.
      void this.disableFrom(
        new RpcConnectionError(
          `unsupported collaboration mode: ${JSON.stringify(view.rawMode ?? null)}`,
        ),
      );
      return;
    }
    // §17: only the current top-level thread is observed.
    if (view.threadId !== this.currentThreadId) {
      return;
    }
    const observed = view.mode;
    if (this.lastMode === null) {
      // First observation (§19).
      this.lastMode = observed;
      this.emit({ type: "initialModeObserved", threadId: view.threadId, mode: observed });
      return;
    }
    if (observed === this.lastMode) {
      // Same-mode settings updates (including model-only changes) → nothing.
      return;
    }
    const previous = this.lastMode;
    this.lastMode = observed;
    this.emit({ type: "modeChanged", threadId: view.threadId, from: previous, to: observed });
  }

  // ----------------------------------------------------------------------
  // Lifecycle
  // ----------------------------------------------------------------------

  private async disableFrom(cause: Error): Promise<void> {
    if (this.controllerState === "stopped" || this.controllerState === "disabled") {
      return;
    }
    this.controllerState = "disabled";
    const connection = this.connection;
    this.connection = null;
    if (connection !== null) {
      try {
        await connection.rpc.close();
      } catch {
        // Best-effort close during disable.
      }
    }
    this.emit({ type: "disabled", reason: cause.message });
  }

  private async performStop(): Promise<void> {
    if (this.controllerState === "stopped") {
      return;
    }
    const wasDisabled = this.controllerState === "disabled";
    this.controllerState = "stopped";
    const connection = this.connection;
    this.connection = null;
    if (connection !== null) {
      try {
        await connection.rpc.close();
      } catch {
        // Closing must never block stop().
      }
    }
    if (!wasDisabled) {
      // stop() from disabled state already emitted its disabled event.
    }
  }

  private emit(event: ControllerEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Listener faults must not corrupt controller state.
      }
    }
  }
}
