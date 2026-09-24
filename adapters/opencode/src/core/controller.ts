/**
 * Ultra Plan Controller — spec §3 (entry point flow).
 *
 * Owns the /ultra-plan → PlanningRun lifecycle: find the session's active run
 * or create exactly one, put the session into the planning runtime
 * configuration, append events, and return deterministic status. All
 * state-changing rules live in the state machine / invariants / store; the
 * controller orchestrates them.
 */
import { PlanIDs } from "./ids.js";
import { renderStatus } from "../memory/renderer.js";
import type { PlanStore } from "../memory/store.js";
import type {
  RuntimeActivationInput,
  RuntimeActivationResult,
  UltraPlanRuntime,
} from "../runtime/types.js";
import type { PlanningRun } from "./types.js";
import type { Timestamp } from "./refs.js";

export interface ControllerOptions {
  store: PlanStore;
  runtime?: UltraPlanRuntime;
  now?: () => Timestamp;
}

export interface StartOrResumeResult {
  run: PlanningRun;
  /** True when this call created the run; false when an active run was resumed. */
  created: boolean;
  /** Runtime activation result; null when no runtime is bound. */
  activation: RuntimeActivationResult | null;
  /** Deterministic status block rendered from structured state. */
  statusText: string;
}

export class UltraPlanController {
  private readonly store: PlanStore;
  private readonly runtime: UltraPlanRuntime | undefined;
  private readonly now: () => Timestamp;

  constructor(options: ControllerOptions) {
    this.store = options.store;
    this.runtime = options.runtime;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /**
   * `/ultra-plan` semantics (spec §3): create-or-resume the session's single
   * active PlanningRun, bind it to the session, activate the planning
   * runtime, and enter DISCOVERY.
   */
  async startOrResume(sessionID: string, goal?: string): Promise<StartOrResumeResult> {
    const existing = await this.store.findActiveRunBySession(sessionID);

    if (existing) {
      await this.store.appendEvent(existing.id, { type: "run.resumed", sessionID });
      const activation = await this.activate(existing);
      const run = (await this.store.getRun(existing.id)) ?? existing;
      return finish(this.store, run, false, activation);
    }

    const at = this.now();
    const seq = await this.store.nextPlanSequence();
    const run = await this.store.createRun({
      id: PlanIDs.from(seq),
      sessionID,
      lifecycle: "active",
      stage: "discovery",
      revision: 1,
      goal: { statement: goal ?? "" },
      constraints: [],
      sections: [],
      decisions: [],
      openQuestions: [],
      conflicts: [],
      createdAt: at,
      updatedAt: at,
    });
    await this.store.appendEvent(run.id, { type: "run.created", sessionID });
    const activation = await this.activate(run);
    return finish(this.store, run, true, activation);
  }

  /** Deterministic status for the session's active run, or null. */
  async statusOf(sessionID: string): Promise<string | null> {
    const run = await this.store.findActiveRunBySession(sessionID);
    return run ? renderStatus(run) : null;
  }

  private async activate(run: PlanningRun): Promise<RuntimeActivationResult | null> {
    if (!this.runtime) return null;
    const input: RuntimeActivationInput = { planID: run.id, sessionID: run.sessionID };
    const result = await this.runtime.activatePlanningRuntime(input);
    await this.store.appendEvent(run.id, {
      type: "runtime.activated",
      mechanism: result.mechanism,
      unsupported: result.unsupported,
    });
    return result;
  }
}

async function finish(
  store: PlanStore,
  run: PlanningRun,
  created: boolean,
  activation: RuntimeActivationResult | null,
): Promise<StartOrResumeResult> {
  await store.appendEvent(run.id, { type: "status.reported" });
  return { run, created, activation, statusText: renderStatus(run) };
}
