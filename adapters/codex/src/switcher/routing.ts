/**
 * Phase → configured-model routing policy (Phase 4).
 *
 * This module is the ENTIRE routing vocabulary of the switcher: a minimal
 * two-field configuration and one pure mapping function. Model identifiers
 * always come from configuration — no provider/model slugs are hardcoded
 * anywhere in production code (Architecture SPEC §2.1: Sol/Luna are role
 * expressions, not literals).
 *
 * Deliberately absent: reasoningEffort, modelProvider, fallbackModel,
 * aliases, cost policies, routing rules (Phase 4 directive §4).
 */

import type { CollaborationModeKind } from "../controller/protocol-types.js";

/** Minimal routing configuration (Phase 4 directive §4). */
export interface PhaseModelConfig {
  /** Applied when the native collaboration mode is Plan. */
  readonly planningModel: string;
  /** Applied when the native collaboration mode is Default. */
  readonly executionModel: string;
}

/** Configuration rejected by `validatePhaseModelConfig`. */
export class PhaseModelConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhaseModelConfigError";
  }
}

/**
 * Validate and normalize (trim) the routing config. Both identifiers must
 * be non-empty strings after trimming; `planningModel === executionModel`
 * is explicitly ALLOWED (a user may want one model for both phases).
 * Codex remains the model-ID validity authority — no model/list probing
 * happens here (Architecture SPEC §20).
 */
export function validatePhaseModelConfig(config: PhaseModelConfig): PhaseModelConfig {
  const planningModel = typeof config.planningModel === "string" ? config.planningModel.trim() : "";
  const executionModel =
    typeof config.executionModel === "string" ? config.executionModel.trim() : "";
  if (planningModel.length === 0) {
    throw new PhaseModelConfigError("planningModel must be a non-empty string");
  }
  if (executionModel.length === 0) {
    throw new PhaseModelConfigError("executionModel must be a non-empty string");
  }
  return { planningModel, executionModel };
}

/**
 * The phase → model mapping (Phase 4 directive §10). Unknown modes are a
 * programming invariant violation — they must never reach this function
 * (the controller never emits mode events for unrecognized modes), so there
 * is deliberately NO fallback to the execution model.
 */
export function desiredModel(mode: CollaborationModeKind, config: PhaseModelConfig): string {
  switch (mode) {
    case "default":
      return config.executionModel;
    case "plan":
      return config.planningModel;
    default: {
      const exhaustive: never = mode;
      throw new Error(`programming invariant violation: unknown collaboration mode ${String(exhaustive)}`);
    }
  }
}
