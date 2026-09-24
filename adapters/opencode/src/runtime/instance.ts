/**
 * Shared Ultra Plan instance for the OpenCode server process.
 *
 * OpenCode loads plugin/tool modules once per server process, so a
 * module-scope singleton gives the plugin entry and the tool definitions one
 * shared store + controller. Phase 1 uses the in-memory store (integration
 * validation only); Phase 2 replaces it with durable persistence, at which
 * point planning state survives process restarts and this module just wraps
 * the durable store.
 */
import { UltraPlanController } from "../core/controller.js";
import { InMemoryPlanStore } from "../memory/store.js";
import type { PlanStore } from "../memory/store.js";
import { OpenCodeRuntimeAdapter } from "./opencode-plugin.js";
import type { UltraPlanRuntime } from "./types.js";

export interface UltraPlanInstance {
  store: PlanStore;
  runtime: UltraPlanRuntime;
  controller: UltraPlanController;
}

let current: UltraPlanInstance | undefined;

export function getUltraPlanInstance(): UltraPlanInstance {
  if (!current) {
    const store = new InMemoryPlanStore();
    const runtime: UltraPlanRuntime = new OpenCodeRuntimeAdapter();
    current = { store, runtime, controller: new UltraPlanController({ store, runtime }) };
  }
  return current;
}

/** Test seam: drop the singleton so the next get builds a fresh instance. */
export function resetUltraPlanInstance(): void {
  current = undefined;
}
