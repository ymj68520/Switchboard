/**
 * Execution model policy — v0.2.0 Phase 7A (directive §14-§17).
 *
 * Extends the adapter's tier→model policy with the supervised-execution
 * roles. Resolution is DETERMINISTIC and never hardcodes vendor model names:
 *
 * - supervisorModel = explicit supervisorModel ?? planningModel — the
 *   Supervisor always runs on the frontier/planning tier (§15); the Build
 *   model never defaults into the Supervisor seat.
 * - workerModel     = explicit workerModel ?? executionModel — the existing
 *   execution/build tier stays the default Executor (§16).
 * - verifierModel   = explicit verifierModel ?? resolved workerModel — the
 *   architecture does not require a stronger verifier (§16).
 */
import type { PlanningRuntimeSpec } from "./types.js";

/** The resolved per-role model policy ("provider/model" strings or undefined = host default). */
export interface ResolvedExecutionModelPolicy {
  planningModel: string | undefined;
  supervisorModel: string | undefined;
  workerModel: string | undefined;
  verifierModel: string | undefined;
}

export function resolveExecutionModelPolicy(spec: PlanningRuntimeSpec): ResolvedExecutionModelPolicy {
  const workerModel = spec.workerModel ?? spec.executionModel;
  return {
    planningModel: spec.planningModel,
    supervisorModel: spec.supervisorModel ?? spec.planningModel,
    workerModel,
    verifierModel: spec.verifierModel ?? workerModel,
  };
}

/** Parse an optional "provider/model" spec value into the SDK binding shape. */
export function modelBinding(
  value: string | undefined,
): { providerID: string; modelID: string } | undefined {
  if (!value) return undefined;
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) return undefined;
  return { providerID: value.slice(0, separator), modelID: value.slice(separator + 1) };
}
