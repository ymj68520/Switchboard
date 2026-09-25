/**
 * PhaseModelSwitcher — phase-triggered model application (Phase 4).
 *
 * Sits ABOVE the ModelController and consumes ONLY its domain events
 * (directive §7-8): the switcher never parses raw JSON-RPC, and the
 * transport never learns Plan/Default semantics.
 *
 *    ModelController ──domain events──▶ PhaseModelSwitcher
 *                                          │ setThreadModel(threadId, model)
 *                                          ▼
 *                          thread/settings/update { threadId, model }
 *
 * Product semantics (Architecture SPEC §2.2, §15):
 *
 *   InitialModeObserved(Default) → executionModel
 *   InitialModeObserved(Plan)    → planningModel
 *   ModeChanged(Default → Plan)  → planningModel
 *   ModeChanged(Plan  → Default) → executionModel
 *   same-mode settings updates (including manual /model) → nothing
 *
 * There is NO current-model tracking and NO per-turn enforcement: triggers
 * are exactly the two mode-event kinds, and every trigger applies its
 * configured model unconditionally (initial application doubles as the
 * first settings-control capability probe).
 *
 * Concurrency: applications run through a single promise chain — one model
 * write at a time, in domain-event order. Each queued action carries its
 * threadId and is skipped if that thread is no longer the current binding,
 * so a replaced thread's unsent action can never leak into the new thread.
 * An already-sent request is not cancelled: the RPC is thread-scoped.
 *
 * Failure model — FAIL OPEN (directive §22-25): any application failure
 * (JSON-RPC error, timeout, connection failure, rejected configured model)
 * disables the switcher, emits exactly one `automationDisabled` event, and
 * stops all future automatic writes. Codex continues; nothing is killed,
 * retried, or substituted. A controller-level Disabled also disables the
 * switcher.
 */

import type { ModelController } from "../controller/model-controller.js";
import type { CollaborationModeKind } from "../controller/protocol-types.js";
import {
  desiredModel,
  validatePhaseModelConfig,
  type PhaseModelConfig,
} from "./routing.js";

export type SwitcherState = "idle" | "active" | "disabled" | "stopped";

export type SwitcherEvent =
  | { type: "modelApplied"; threadId: string; mode: CollaborationModeKind; model: string }
  | { type: "automationDisabled"; reason: string };

interface PendingApplication {
  readonly threadId: string;
  readonly mode: CollaborationModeKind;
  readonly model: string;
}

export class PhaseModelSwitcher {
  /** Validated (trimmed) at construction; invalid config never constructs. */
  readonly config: PhaseModelConfig;

  private readonly controller: ModelController;
  private readonly listeners = new Set<(event: SwitcherEvent) => void>();
  private detachController: (() => void) | null = null;

  private switcherState: SwitcherState = "idle";
  private applicationChain: Promise<void> = Promise.resolve();
  private stopPromise: Promise<void> | null = null;

  constructor(controller: ModelController, config: PhaseModelConfig) {
    this.controller = controller;
    this.config = validatePhaseModelConfig(config);
  }

  get state(): SwitcherState {
    return this.switcherState;
  }

  /** Register a switcher domain-event listener; returns an unsubscribe fn. */
  onEvent(listener: (event: SwitcherEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Begin reacting to mode events (idle → active). Single-use. */
  start(): void {
    if (this.switcherState !== "idle") {
      throw new Error(
        `PhaseModelSwitcher.start() requires state "idle" (current: ${this.switcherState})`,
      );
    }
    this.switcherState = "active";
    this.detachController = this.controller.onEvent((event) => {
      switch (event.type) {
        case "initialModeObserved":
          this.handleModeTrigger(event.threadId, event.mode);
          return;
        case "modeChanged":
          this.handleModeTrigger(event.threadId, event.to);
          return;
        case "disabled":
          // Controller failure stops all future model writes (directive §25).
          this.disable(`controller disabled: ${event.reason}`);
          return;
        default:
          return;
      }
    });
  }

  /**
   * Deterministic stop: stop accepting mode events, stop issuing writes,
   * and wait for the in-flight application (bounded by the RPC request
   * timeout) to settle. Never touches the controller, the app-server child,
   * or the WebSocket — ownership stays with the launcher/runtime. Idempotent.
   */
  async stop(): Promise<void> {
    if (this.stopPromise !== null) {
      return this.stopPromise;
    }
    this.stopPromise = this.performStop();
    return this.stopPromise;
  }

  private async performStop(): Promise<void> {
    if (this.switcherState === "stopped") {
      return;
    }
    this.switcherState = "stopped";
    this.detachController?.();
    this.detachController = null;
    // Let the in-flight application settle; queued-but-unsent actions are
    // skipped by the state check inside execute().
    await this.applicationChain.catch(() => {});
  }

  // ----------------------------------------------------------------------
  // Trigger handling
  // ----------------------------------------------------------------------

  private handleModeTrigger(threadId: string, mode: CollaborationModeKind): void {
    if (this.switcherState !== "active") {
      return;
    }
    // Unknown modes never appear here (the controller disables itself on
    // them), so desiredModel cannot legitimately throw.
    const model = desiredModel(mode, this.config);
    this.enqueue({ threadId, mode, model });
  }

  /**
   * Single-channel serialized application (directive §16-17): a promise
   * chain, not a job system. Order of enqueue == order of wire writes.
   */
  private enqueue(action: PendingApplication): void {
    this.applicationChain = this.applicationChain.then(() => this.execute(action));
    // The chain itself must never reject — failures disable the switcher.
    this.applicationChain.catch(() => {});
  }

  private async execute(action: PendingApplication): Promise<void> {
    if (this.switcherState !== "active") {
      return;
    }
    // Defensive command boundary (directive §18-19): only the CURRENT
    // thread, only while subscribed. Stale actions are skipped; an already
    // in-flight request needs no cancellation (thread-scoped by protocol).
    if (this.controller.boundThreadId !== action.threadId) {
      return;
    }
    if (this.controller.subscription !== "subscribed") {
      return;
    }
    if (this.controller.state !== "listening") {
      return;
    }

    try {
      await this.controller.setThreadModel(action.threadId, action.model);
    } catch (error) {
      // FAIL OPEN: disable once, keep Codex alive, never retry, never
      // substitute a fallback model (directive §22-23).
      this.disable(
        `model application failed (${action.mode} → ${action.model}): ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    if (this.switcherState === "active") {
      this.emit({
        type: "modelApplied",
        threadId: action.threadId,
        mode: action.mode,
        model: action.model,
      });
    }
  }

  // ----------------------------------------------------------------------
  // Failure / lifecycle
  // ----------------------------------------------------------------------

  private disable(reason: string): void {
    if (this.switcherState !== "active") {
      return; // exactly-one AutomationDisabled surface (directive §24)
    }
    this.switcherState = "disabled";
    this.emit({ type: "automationDisabled", reason });
  }

  private emit(event: SwitcherEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Listener faults must not corrupt switcher state.
      }
    }
  }
}
