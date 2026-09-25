/**
 * ManagedCodexSession — the production composition root (Phase 5 directive
 * §1, §3, §16-30). It ASSEMBLES the frozen Phase 1/2/3/4 components into
 * the managed session a user actually runs; it re-implements none of them:
 *
 *        ManagedCodexSession (owns the lifecycle, the TUI child, warnings)
 *          ├── CodexSessionRuntime      (owns the app-server child)
 *          ├── ModelController          (owns the controller WebSocket)
 *          ├── PhaseModelSwitcher       (owns routing application state)
 *          └── Codex TUI child          (owns the user terminal)
 *
 * Frozen startup order (directive §16, Architecture SPEC §8/§18.1 — the
 * Controller MUST be listening and the Switcher MUST be active before the
 * TUI spawns, so no thread/started or first-mode event is ever missed):
 *
 *   1. resolve the shared Codex installation (§38-39, one resolution for
 *      both children — no version drift)
 *   2. start the dedicated app-server (runtime: spawn → endpoint discovery
 *      → /readyz == 200)
 *   3. connect + initialize the ModelController
 *   4. start the PhaseModelSwitcher (registers controller listeners)
 *   5. spawn the real TUI: --remote <endpoint> --model <executionModel>
 *      with both native effort overrides (§7-9)
 *   6. supervise: race(TUI exit, app-server unexpected exit)  (§26)
 *
 * Frozen failure semantics (directive §20-27):
 *   - TUI exit            → normal session end: stop switcher → stop
 *                           controller → shutdown runtime → exit with the
 *                           TUI's exit code (§21);
 *   - bootstrap failure   → TUI is never launched; launcher-specific
 *                           nonzero result (§21, SPEC §21.1);
 *   - app-server crash    → TERMINAL (SPEC §21.4/A14): stop switcher →
 *                           stop controller → terminate the TUI → cleanup;
 *                           never restarted;
 *   - controller failure  → FAIL OPEN (SPEC §21.2/A13): one human-visible
 *                           warning, automation off, TUI keeps running; a
 *                           controller failure NEVER resolves the session
 *                           race (§27);
 *   - switcher failure    → same unified warn-once surface (§23) —
 *                           controller and switcher failures share ONE
 *                           exactly-once warning flag (§22-24);
 *   - SIGINT/SIGTERM      → best-effort orderly cleanup; no orphan
 *                           app-server, no orphan TUI (§30).
 */

import { ModelController, type ControllerEvent, type ModelControllerOptions } from "../controller/model-controller.js";
import { PhaseModelSwitcher, type SwitcherEvent } from "../switcher/phase-model-switcher.js";
import { CodexSessionRuntime } from "../runtime/session-runtime.js";
import {
  type ChildExitStatus,
  type CodexSessionRuntimeConfig,
  type LoopbackEndpoint,
  DEFAULT_APP_SERVER_ARGS,
} from "../runtime/types.js";
import type { CodexPhaseModelConfig } from "../config/phase-model-config.js";
import { resolveCodexCommand, type ResolvedCodexCommand } from "./command-resolution.js";
import { buildCodexTuiArgs } from "./tui-args.js";
import { nodeCodexTuiProcessFactory, type CodexTuiProcess, type CodexTuiProcessFactory } from "./tui-process.js";

/** Terminal results of a managed session (directive §21: no error-code zoo). */
export type ManagedSessionOutcome =
  | { kind: "tui-exit"; exitCode: number | null; signal: NodeJS.Signals | null }
  | { kind: "bootstrap-failure"; message: string }
  | { kind: "app-server-crash"; message: string; exitStatus: ChildExitStatus | null };

export interface ManagedCodexSessionOptions {
  /** Fully-resolved user configuration (directive §5). Validated on run(). */
  readonly phaseModel: CodexPhaseModelConfig;
  /** Codex args passthrough after the launcher-owned ones (directive §10). */
  readonly passthroughArgs?: readonly string[];
  /** seams for the app-server runtime (tests). */
  readonly runtimeOptions?: Partial<CodexSessionRuntimeConfig>;
  /** seams for the controller (tests). */
  readonly controllerOptions?: ModelControllerOptions;
  /** seam for the TUI child (tests). */
  readonly tuiFactory?: CodexTuiProcessFactory;
  /** Diagnostic warning sink (§24). Default: one stderr line. */
  readonly warn?: (message: string) => void;
  /** One-shot startup diagnostic sink (endpoint + models). Default: warn. */
  readonly diagnostics?: (message: string) => void;
  /** Test seam: overrides resolveCodexCommand(). */
  readonly resolvedCommand?: ResolvedCodexCommand;
  /** Test seam: subscribes a cleanup signal handler; default SIGINT/SIGTERM. */
  readonly onSignal?: (handler: (signal: NodeJS.Signals) => void) => () => void;
}

/** Grace period before a TUI termination escalates to a force kill. */
const TUI_TERMINATE_GRACE_MS = 3_000;

const AUTOMATION_WARNING_PREFIX =
  "Warning: automatic phase model switching has been disabled " +
  "for the remainder of this Codex session.";

export class ManagedCodexSession {
  private readonly options: ManagedCodexSessionOptions;

  /** Exactly-once automation warning flag shared by BOTH fail-open sources (§23). */
  private automationWarningEmitted = false;

  constructor(options: ManagedCodexSessionOptions) {
    this.options = options;
  }

  /** Single-use. Resolves only when the managed session has ended. */
  async run(): Promise<ManagedSessionOutcome> {
    const phaseModel = this.options.phaseModel;
    const resolved = this.options.resolvedCommand ?? resolveCodexCommand();

    // ---- 1-2. dedicated app-server (runtime owns the child) -----------
    const runtime = new CodexSessionRuntime({
      command: resolved.program,
      args: [...resolved.prefixArgs, ...DEFAULT_APP_SERVER_ARGS],
      ...this.options.runtimeOptions,
    });

    let endpoint: LoopbackEndpoint;
    try {
      endpoint = await runtime.start();
    } catch (error) {
      // The runtime guarantees child cleanup on bootstrap failure (Phase 1).
      return {
        kind: "bootstrap-failure",
        message: `app-server bootstrap failed: ${describeError(error)}`,
      };
    }

    // ---- 3. Controller LISTENING --------------------------------------
    const controller = new ModelController(this.options.controllerOptions);
    try {
      await controller.connect({
        host: endpoint.host,
        port: endpoint.port,
        wsUrl: endpoint.wsUrl,
        httpBaseUrl: endpoint.httpBaseUrl,
      });
    } catch (error) {
      await runtime.shutdown();
      return {
        kind: "bootstrap-failure",
        message: `controller bootstrap failed: ${describeError(error)}`,
      };
    }

    // ---- 4. Switcher ACTIVE before the TUI exists (§17) ---------------
    const switcher = new PhaseModelSwitcher(controller, {
      planningModel: phaseModel.planningModel,
      executionModel: phaseModel.executionModel,
    });
    const detachControllerWarnings = controller.onEvent((event: ControllerEvent) => {
      if (event.type === "disabled") {
        // §22/§27: fail-open — warn once, keep the TUI running, never
        // resolve the terminal race from a controller failure.
        this.emitAutomationWarning(event.reason);
      }
    });
    const detachSwitcherWarnings = switcher.onEvent((event: SwitcherEvent) => {
      if (event.type === "automationDisabled") {
        this.emitAutomationWarning(event.reason);
      }
    });
    switcher.start();

    const diagnostics =
      this.options.diagnostics ??
      this.options.warn ??
      ((message: string) => process.stderr.write(`${message}\n`));
    diagnostics(
      `phase-model: managed Codex session started ` +
        `(endpoint ${endpoint.wsUrl}, planning ${phaseModel.planningModel}, ` +
        `execution ${phaseModel.executionModel}, effort ${phaseModel.reasoningEffort})`,
    );

    // ---- 5. real Codex TUI, explicitly attached to the endpoint -------
    let tui: CodexTuiProcess;
    try {
      tui = this.spawnTui(resolved, endpoint);
    } catch (error) {
      await this.stopAutomation(switcher, controller, detachSwitcherWarnings, detachControllerWarnings);
      await runtime.shutdown();
      return {
        kind: "bootstrap-failure",
        message: `TUI launch failed: ${describeError(error)}`,
      };
    }

    // ---- 6. supervised session (§26): TUI exit vs app-server death ----
    // Resolver holders are wired immediately below; the no-op defaults make
    // early signals / exits harmless no-ops.
    type TuiExitNotification =
      | { kind: "exited"; status: ChildExitStatus }
      | { kind: "spawn-failed"; error: unknown }
      | { kind: "signal-interrupted" };
    let resolveTuiExit: (notification: TuiExitNotification) => void = () => {};
    let resolveAppServerCrash: (status: ChildExitStatus) => void = () => {};

    let sessionEnding = false;
    const endByTuiExit = (notification: TuiExitNotification): void => {
      if (!sessionEnding) {
        sessionEnding = true;
        resolveTuiExit(notification);
      }
    };

    const detachAppServerExit = runtime.onExit((status) => {
      if (!sessionEnding) {
        sessionEnding = true;
        resolveAppServerCrash(status);
      }
    });

    const detachSignals = this.installSignalHandler(() => {
      // §30: best-effort orderly cleanup; resolve like a TUI exit.
      endByTuiExit({ kind: "signal-interrupted" });
    });

    const appServerCrash = new Promise<ChildExitStatus>((resolve) => {
      resolveAppServerCrash = resolve;
    });
    const tuiExit = new Promise<TuiExitNotification>((resolve) => {
      resolveTuiExit = resolve;
    });
    void tui.exits
      .then((status) => endByTuiExit({ kind: "exited", status }))
      .catch((error: unknown) => endByTuiExit({ kind: "spawn-failed", error }));

    const winner = await Promise.race([
      tuiExit,
      appServerCrash.then((status) => ({ race: "app-server" as const, status })),
    ]);
    sessionEnding = true;

    await this.stopAutomation(switcher, controller, detachSwitcherWarnings, detachControllerWarnings);
    detachAppServerExit();
    detachSignals();

    if ("race" in winner) {
      // ---- app-server failure: TERMINAL (§25, §28 crash path) ---------
      await terminateTui(tui);
      await runtime.shutdown();
      return {
        kind: "app-server-crash",
        message: `the dedicated app-server exited unexpectedly (${describeExit(winner.status)}); ` +
          "the managed session cannot continue",
        exitStatus: winner.status,
      };
    }

    if (winner.kind === "spawn-failed") {
      // The TUI child could not be started at all — a bootstrap-class
      // failure: no interactive session ever existed.
      await runtime.shutdown();
      return {
        kind: "bootstrap-failure",
        message: `TUI launch failed: ${describeError(winner.error)}`,
      };
    }

    if (winner.kind === "exited") {
      // ---- normal TUI exit (§20, §28 normal path) ----------------------
      await runtime.shutdown();
      return {
        kind: "tui-exit",
        exitCode: winner.status.exitCode,
        signal: winner.status.signal,
      };
    }

    // ---- signal-interrupted: terminate the still-running TUI ----------
    await terminateTui(tui);
    await runtime.shutdown();
    return { kind: "tui-exit", exitCode: null, signal: null };
  }

  private spawnTui(resolved: ResolvedCodexCommand, endpoint: LoopbackEndpoint): CodexTuiProcess {
    const tuiArgs = buildCodexTuiArgs({
      endpoint,
      executionModel: this.options.phaseModel.executionModel,
      reasoningEffort: this.options.phaseModel.reasoningEffort,
      passthroughArgs: this.options.passthroughArgs ?? [],
    });
    const factory = this.options.tuiFactory ?? nodeCodexTuiProcessFactory;
    return factory({
      command: resolved.program,
      args: [...resolved.prefixArgs, ...tuiArgs],
    });
  }

  /** Unified stop order (§28): switcher → controller. Never throws. */
  private async stopAutomation(
    switcher: PhaseModelSwitcher,
    controller: ModelController,
    detachSwitcherWarnings: () => void,
    detachControllerWarnings: () => void,
  ): Promise<void> {
    detachControllerWarnings();
    detachSwitcherWarnings();
    try {
      await switcher.stop();
    } catch {
      // stop() never rejects today; guard anyway — cleanup must proceed.
    }
    try {
      await controller.stop();
    } catch {
      // Closing must never block the shutdown sequence.
    }
  }

  /** Exactly-once human-visible warning shared by controller AND switcher. */
  private emitAutomationWarning(reason: string): void {
    if (this.automationWarningEmitted) {
      return;
    }
    this.automationWarningEmitted = true;
    const warn = this.options.warn ?? ((message: string) => process.stderr.write(`${message}\n`));
    warn(`${AUTOMATION_WARNING_PREFIX} (${reason})`);
  }

  private installSignalHandler(handler: () => void): () => void {
    if (this.options.onSignal !== undefined) {
      return this.options.onSignal(() => handler());
    }
    const wrapped = (): void => handler();
    process.on("SIGINT", wrapped);
    process.on("SIGTERM", wrapped);
    return () => {
      process.off("SIGINT", wrapped);
      process.off("SIGTERM", wrapped);
    };
  }
}

/**
 * TUI termination ladder using the shared Phase 1 process-tree primitives
 * (§29): request → grace → force. No platform-specific code here.
 */
async function terminateTui(tui: CodexTuiProcess): Promise<ChildExitStatus | null> {
  if (tui.pid === undefined) {
    return null;
  }
  tui.requestTerminate();
  const settled = await Promise.race([
    tui.exits.then(
      (status) => ({ kind: "exited" as const, status }),
      () => ({ kind: "exited" as const, status: null }),
    ),
    new Promise<{ kind: "timeout" }>((resolve) =>
      setTimeout(() => resolve({ kind: "timeout" }), TUI_TERMINATE_GRACE_MS),
    ),
  ]);
  if (settled.kind === "exited") {
    return settled.status;
  }
  tui.forceKill();
  return tui.exits.catch(() => null);
}

function describeExit(status: ChildExitStatus): string {
  if (status.signal !== null) {
    return `killed by signal ${status.signal}`;
  }
  return `exit code ${status.exitCode}`;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
