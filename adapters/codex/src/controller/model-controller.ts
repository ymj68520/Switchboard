/**
 * ModelController — the launcher-internal controller lifecycle, top-level
 * thread binding and native collaboration-mode observation (Phases 2-3).
 *
 * Phase boundary: the controller ONLY OBSERVES. It has no model fields and
 * never sends `thread/settings/update` — mode transitions are surfaced as
 * domain events for the later model-application phase. (Phase 2-3
 * directives §2/§20.)
 *
 * PASSIVE SUBSCRIBER RULE (Phase 3 directive §2 — safety frozen):
 *
 *   incoming server request → observe for diagnostics only → send NO
 *   JSON-RPC response.
 *
 * Once subscribed via `thread/resume`, this connection is one of possibly
 * several thread subscribers; codex may deliver thread-scoped server
 * requests to every subscriber. The controller is not the request owner and
 * has no tool/approval/user-interaction handlers, so ANY response from it
 * could race the authoritative TUI subscriber's response.
 *
 * Handshake (Phase 2 directive §7-9, verified on codex-cli 0.156.1):
 *   connect → initialize (clientInfo + capabilities.experimentalApi=true)
 *           → exact-id success response → `initialized` notification with
 *             NO params key → LISTENING.
 *
 * Subscription convergence (Phase 3, empirically required on 0.156.1):
 * `thread/settings/updated` is a THREAD-SCOPED notification — a side client
 * only receives it after joining the fan-out with `thread/resume`. A fresh
 * thread rejects resume with "no rollout found" until its first turn
 * materializes the rollout. Therefore:
 *
 *   top-level bind → resume attempt
 *     → success                       → subscribed (+ optional mode snapshot)
 *     → "no rollout found" rejection  → pending (expected timing condition,
 *                                       NOT a failure)
 *     → any other failure             → controller failure semantics
 *     pending + current-thread `thread/status/changed(idle)` → one retry
 *
 * Retry is event-driven only: NO timers, NO polling. An in-flight guard
 * keeps at most one resume attempt per controller; a bind-generation token
 * makes late completions for a replaced thread harmless.
 *
 * Failure model: any post-connect protocol failure disables the controller
 * (fail-open direction, Architecture SPEC §21.2). There is no automatic
 * reconnect. Unknown collaboration modes disable the controller — never
 * guessed onto Default/Plan.
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
  parseResumeModeSnapshot,
  parseThreadSettingsUpdated,
  parseThreadStarted,
  parseThreadStatusChanged,
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

/** Transient in-memory subscription state (Phase 3 directive §5). */
export type SubscriptionState = "none" | "pending" | "subscribed";

export type ControllerEvent =
  | { type: "topLevelThreadBound"; threadId: string }
  | { type: "initialModeObserved"; threadId: string; mode: CollaborationModeKind }
  | { type: "modeChanged"; threadId: string; from: CollaborationModeKind; to: CollaborationModeKind }
  | { type: "threadSubscribed"; threadId: string }
  | { type: "threadSubscriptionPending"; threadId: string; reason: string }
  | { type: "disabled"; reason: string };

export interface ModelControllerOptions {
  /** Stable client identity for initialize (Phase 2 directive §7). */
  readonly clientName?: string;
  readonly clientVersion?: string;
  readonly requestTimeoutMs?: number;
  readonly initializeTimeoutMs?: number;
  /** Test seam. */
  readonly websocketFactory?: WebSocketFactory;
}

export const CONTROLLER_CLIENT_NAME = "phase-model-controller";

/** Default initialize timeout — the handshake must not hang. */
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

  private subscriptionState: SubscriptionState = "none";
  /** Increments on every top-level bind; stale resume completions are dropped. */
  private bindGeneration = 0;
  /** Generation of the resume attempt currently in flight, if any. */
  private subscriptionInFlightGeneration: number | null = null;

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

  get subscription(): SubscriptionState {
    return this.subscriptionState;
  }

  /** Diagnostics-only server identity from the initialize response. */
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
   * disables it. After connect(), everything required for subscription is
   * driven by app-server events — callers never orchestrate it.
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
   * Deterministic stop: mark stopping, best-effort unsubscribe the current
   * subscription, close the socket, reject pending RPCs. Idempotent, never
   * blocks on unsubscribe failure, never kills the app-server (child
   * ownership stays with the Phase 1 runtime).
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
    // Diagnostics only — never a capability gate (Architecture SPEC §19).
    this.serverInfo = parseInitializeResult(result);

    // `initialized` with NO params — exact frame verified against 0.156.1.
    context.rpc.notify("initialized");
  }

  // ----------------------------------------------------------------------
  // Incoming dispatch
  // ----------------------------------------------------------------------

  private rpcOptions(): AppServerRpcOptions {
    return {
      requestTimeoutMs: this.options.requestTimeoutMs,
      websocketFactory: this.options.websocketFactory,
      onNotification: (notification) => this.onNotification(notification.method, notification.params),
      // Passive Subscriber Rule: this connection is a passive thread
      // subscriber. Responding to thread-scoped server requests can race
      // with the authoritative TUI subscriber, so incoming server requests
      // are observed for diagnostics only and get NO JSON-RPC response —
      // no -32601, no -32600, no null/empty success. Method names never
      // carry payloads here; tool/approval/prompt contents are untouched.
      onServerRequest: () => {},
      onProtocolError: (error) => {
        void this.disableFrom(error);
      },
      onClosed: () => {
        if (this.controllerState === "listening" || this.controllerState === "initializing") {
          void this.disableFrom(new RpcConnectionError("connection closed by app-server"));
        }
      },
      onStrayResponse: () => {
        // Diagnostic only: never fatal.
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
      case "thread/status/changed":
        this.onThreadStatusChanged(params);
        return;
      default:
        // Unknown notification → ignore safely.
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
    // Child/subagent threads never enter switching scope.
    if (view.parentThreadId !== null) {
      return;
    }
    // Duplicate top-level notification for the current thread → ignore.
    if (view.threadId === this.currentThreadId) {
      return;
    }

    // New top-level thread: discard ALL previous thread state (including a
    // pending or subscribed old subscription) and start the fresh flow.
    const previousThreadId = this.currentThreadId;
    const wasSubscribed = this.subscriptionState === "subscribed";
    this.bindGeneration += 1;
    this.subscriptionInFlightGeneration = null;
    this.currentThreadId = view.threadId;
    this.lastMode = null;
    this.subscriptionState = "none";
    if (previousThreadId !== null && wasSubscribed) {
      this.bestEffortUnsubscribe(previousThreadId);
    }
    this.emit({ type: "topLevelThreadBound", threadId: view.threadId });
    this.attemptSubscription();
  }

  private onThreadStatusChanged(params: unknown): void {
    const view = parseThreadStatusChanged(params);
    if (view === null) {
      // Auxiliary input only — structural drift here is safe-ignored.
      return;
    }
    // Only the current thread's lifecycle drives anything.
    if (view.threadId !== this.currentThreadId) {
      return;
    }
    // Only a settled (idle) transition may signal that the rollout has been
    // materialized; status is never used to infer mode/model/planning state.
    if (view.statusType !== "idle") {
      return;
    }
    if (this.subscriptionState !== "pending") {
      // subscribed → no duplicate resume; none → the bind attempt already ran.
      return;
    }
    // Event-driven retry (no timers). The in-flight guard inside
    // attemptSubscription keeps this to at most one concurrent request.
    this.attemptSubscription();
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
      // Unknown mode must be explicit, never guessed → disable.
      void this.disableFrom(
        new RpcConnectionError(
          `unsupported collaboration mode: ${JSON.stringify(view.rawMode ?? null)}`,
        ),
      );
      return;
    }
    this.observeMode(view.threadId, view.mode);
  }

  /**
   * Single mode-observation transition function (Phase 3 directive §17-18).
   * Both authoritative sources — the resume-response snapshot and the
   * thread/settings/updated notification — funnel through here. No model
   * mutation happens anywhere.
   */
  private observeMode(threadId: string, observed: CollaborationModeKind): void {
    // Only the current top-level thread is observed.
    if (threadId !== this.currentThreadId) {
      return;
    }
    if (this.lastMode === null) {
      this.lastMode = observed;
      this.emit({ type: "initialModeObserved", threadId, mode: observed });
      return;
    }
    if (observed === this.lastMode) {
      // Same-mode settings updates (including model-only changes) → nothing.
      return;
    }
    const previous = this.lastMode;
    this.lastMode = observed;
    this.emit({ type: "modeChanged", threadId, from: previous, to: observed });
  }

  // ----------------------------------------------------------------------
  // Subscription convergence
  // ----------------------------------------------------------------------

  /**
   * One `thread/resume` attempt for the current binding — pure passive
   * attach / notification subscription, no overrides of any kind. At most
   * one attempt in flight; completions from replaced threads are dropped by
   * generation check. No retries except the event-driven idle trigger.
   */
  private attemptSubscription(): void {
    const connection = this.connection;
    if (
      connection === null ||
      !connection.rpc.isOpen ||
      this.controllerState !== "listening" ||
      this.currentThreadId === null ||
      this.subscriptionState === "subscribed" ||
      this.subscriptionInFlightGeneration !== null
    ) {
      return;
    }

    const threadId = this.currentThreadId;
    const generation = this.bindGeneration;
    this.subscriptionInFlightGeneration = generation;

    void connection.rpc
      .request("thread/resume", { threadId })
      .then((result: unknown) => {
        if (this.subscriptionInFlightGeneration !== generation) {
          return; // stale completion for a replaced thread — ignore entirely
        }
        this.subscriptionInFlightGeneration = null;
        if (
          this.controllerState !== "listening" ||
          this.currentThreadId !== threadId ||
          this.subscriptionState === "subscribed"
        ) {
          return;
        }
        this.subscriptionState = "subscribed";
        this.emit({ type: "threadSubscribed", threadId });
        // Optional authoritative initial snapshot (tolerant: absent is fine).
        const snapshot = parseResumeModeSnapshot(result);
        if (snapshot.kind === "ok") {
          this.observeMode(threadId, snapshot.mode);
        } else if (snapshot.kind === "unsupported") {
          void this.disableFrom(
            new RpcConnectionError(
              `unsupported collaboration mode: ${JSON.stringify(snapshot.rawMode ?? null)}`,
            ),
          );
        }
        // absent → remain subscribed and wait for thread/settings/updated.
      })
      .catch((error: unknown) => {
        if (this.subscriptionInFlightGeneration !== generation) {
          return; // stale completion for a replaced thread — ignore entirely
        }
        this.subscriptionInFlightGeneration = null;
        if (
          this.controllerState !== "listening" ||
          this.currentThreadId !== threadId ||
          this.subscriptionState === "subscribed"
        ) {
          return;
        }
        if (isFreshThreadPendingError(error)) {
          // Expected upstream timing condition — never Disabled, never
          // retried on a timer. A later idle status transition re-drives us.
          this.subscriptionState = "pending";
          this.emit({
            type: "threadSubscriptionPending",
            threadId,
            reason: `thread/resume rejected: ${error.message}`,
          });
          return;
        }
        // Any other resume failure is a real controller failure.
        void this.disableFrom(error instanceof Error ? error : new Error(String(error)));
      });
  }

  /**
   * Best-effort `thread/unsubscribe` — sends the request and ignores any
   * outcome. The WebSocket close remains the final cleanup boundary.
   */
  private bestEffortUnsubscribe(threadId: string): void {
    const connection = this.connection;
    if (connection === null || !connection.rpc.isOpen) {
      return;
    }
    void connection.rpc.request("thread/unsubscribe", { threadId }).catch(() => {
      // Unsubscribe failure must never block anything (Phase 3 §15/§31).
    });
  }

  // ----------------------------------------------------------------------
  // Lifecycle
  // ----------------------------------------------------------------------

  private async disableFrom(cause: Error): Promise<void> {
    if (this.controllerState === "stopped" || this.controllerState === "disabled") {
      return;
    }
    this.controllerState = "disabled";
    // Stop subscription retry + mode processing by clearing in-flight state.
    this.subscriptionInFlightGeneration = null;
    if (this.subscriptionState === "subscribed" && this.currentThreadId !== null) {
      this.bestEffortUnsubscribe(this.currentThreadId);
    }
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
    this.controllerState = "stopped";
    this.subscriptionInFlightGeneration = null;
    if (this.subscriptionState === "subscribed" && this.currentThreadId !== null) {
      this.bestEffortUnsubscribe(this.currentThreadId);
    }
    const connection = this.connection;
    this.connection = null;
    if (connection !== null) {
      try {
        await connection.rpc.close();
      } catch {
        // Closing must never block stop().
      }
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

  // ----------------------------------------------------------------------
  // Thread model command primitive (Phase 4)
  // ----------------------------------------------------------------------

  /**
   * Narrow model command: sends `thread/settings/update` with params of
   * EXACTLY `{ threadId, model }` — nothing else. Codex is the
   * collaboration-mode authority, so the controller never sends
   * collaborationMode/effort/sandbox/approval/permission fields alongside a
   * model change (Phase 4 directive §2-3, Architecture SPEC A10).
   *
   * This primitive is deliberately dumb: it does NOT touch last_mode,
   * subscription state, or any retry logic, and it does not track the
   * current model. Failures propagate to the caller (the switcher owns the
   * fail-open policy). Mode-observation semantics are unaffected: the
   * server's same-mode settings echo produces no mode event, so applying a
   * model can never loop.
   */
  async setThreadModel(threadId: string, model: string): Promise<void> {
    const connection = this.connection;
    if (connection === null || !connection.rpc.isOpen || this.controllerState !== "listening") {
      throw new RpcConnectionError("controller is not listening");
    }
    await connection.rpc.request("thread/settings/update", { threadId, model });
  }
}

/**
 * Narrow pending classification (Phase 3 directive §10): ONLY the
 * empirically-confirmed fresh-thread case — a JSON-RPC invalid-request
 * error whose message reports the missing rollout — counts as expected
 * pending. Everything else is a real failure. Deliberately not a general
 * string parser.
 */
function isFreshThreadPendingError(error: unknown): error is RpcRequestError {
  return (
    error instanceof RpcRequestError &&
    error.payload.code === -32600 &&
    typeof error.payload.message === "string" &&
    error.payload.message.includes("no rollout found")
  );
}
