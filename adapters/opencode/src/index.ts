/**
 * Ultra Plan for OpenCode — plugin entry point.
 *
 * Registers, using verified @opencode-ai/plugin 1.18 APIs only:
 * - the /ultra-plan command (config hook → `config.command`),
 * - the planning agent (config hook → `config.agent`),
 * - the `ultraplan_start` tool (plugin `tool` hook).
 */
import type { Hooks, Plugin } from "@opencode-ai/plugin";

import { getUltraPlanInstance } from "./runtime/instance.js";
import { ULTRA_PLAN_START_TOOL, createUltraPlanStartTool } from "./tools/ultra-plan.js";

/**
 * Build the Ultra Plan plugin hooks. Input-free factory so embedders and tests
 * can wire the hooks without an OpenCode server connection.
 */
export function createUltraPlanHooks(): Hooks {
  const { runtime, controller } = getUltraPlanInstance();
  return {
    config: async (config) => {
      runtime.applyToConfig(config);
    },
    tool: {
      [ULTRA_PLAN_START_TOOL]: createUltraPlanStartTool(controller),
    },
  };
}

export const UltraPlanPlugin: Plugin = async () => createUltraPlanHooks();

export default UltraPlanPlugin;

// ---------------------------------------------------------------------------
// Public surface for embedders and tests
// ---------------------------------------------------------------------------
export { UltraPlanController } from "./core/controller.js";
export type { StartOrResumeResult } from "./core/controller.js";
export { UltraPlanError, isUltraPlanError } from "./core/errors.js";
export * from "./core/ids.js";
export * from "./core/refs.js";
export * from "./core/types.js";
export * from "./core/state-machine.js";
export * from "./core/invariants.js";
export * from "./transaction/types.js";
export { InMemoryPlanStore } from "./memory/store.js";
export type { PlanStore, CommitTransactionInput } from "./memory/store.js";
export * from "./memory/events.js";
export * from "./memory/snapshots.js";
export { renderStatus } from "./memory/renderer.js";
export type { StatusDetails } from "./memory/renderer.js";
export * from "./context/trace.js";
export * from "./repository/evidence.js";
export * from "./repository/observations.js";
export * from "./runtime/types.js";
export {
  OpenCodeRuntimeAdapter,
  DEFAULT_PLANNING_RUNTIME_SPEC,
  ULTRA_PLAN_COMMAND_TEMPLATE,
} from "./runtime/opencode-plugin.js";
export { getUltraPlanInstance, resetUltraPlanInstance } from "./runtime/instance.js";
export type { UltraPlanInstance } from "./runtime/instance.js";
export { ULTRA_PLAN_START_TOOL, createUltraPlanStartTool } from "./tools/ultra-plan.js";
