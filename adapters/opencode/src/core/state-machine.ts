/**
 * Planning state machine — spec §4/§4.1.
 *
 * Stage transitions and lifecycle transitions are separate axes (spec
 * invariant 6). The tables here are the single source of truth for what may
 * move where; the controller and (later) the transaction engine may not
 * improvise transitions.
 */
import { UltraPlanError } from "./errors.js";
import {
  PLANNING_LIFECYCLES,
  PLANNING_STAGES,
  type PlanningLifecycle,
  type PlanningRun,
  type PlanningStage,
} from "./types.js";

/**
 * Stage graph (spec §4.1):
 *
 *   discovery → architecture → detail → synthesis → final
 *                                        └─→ detail (conflict/reopen)
 *
 * VALIDATION in the lifecycle diagram is realized as the deterministic
 * Evidence Audit + Finalization Gate (finalization/gate.ts, Phase 2H — the
 * successor of the Phase 1 checkFinalization placeholder) evaluating the
 * synthesis state; the frozen stage union has no separate `validation` stage.
 * The synthesis → final edge itself is performed ONLY by the Final PlanCommit
 * (Phase 2I) — a FinalPlanCandidate never transitions the stage. See the
 * Phase 1 report.
 */
export const STAGE_TRANSITIONS: Readonly<Record<PlanningStage, readonly PlanningStage[]>> = {
  discovery: ["architecture"],
  architecture: ["detail"],
  detail: ["synthesis"],
  synthesis: ["detail", "final"],
  final: [],
};

/**
 * Lifecycle graph (spec §4.1/§33):
 *
 *   active → handoff_pending → completed
 *   active → aborted; handoff_pending → aborted
 *
 * `completed` and `aborted` are terminal — a completed run can never re-enter
 * active planning.
 */
export const LIFECYCLE_TRANSITIONS: Readonly<
  Record<PlanningLifecycle, readonly PlanningLifecycle[]>
> = {
  active: ["handoff_pending", "aborted"],
  handoff_pending: ["completed", "aborted"],
  completed: [],
  aborted: [],
};

export function assertPlanningStage(value: string): asserts value is PlanningStage {
  if (!(PLANNING_STAGES as readonly string[]).includes(value)) {
    throw new UltraPlanError("unknown_planning_stage", `"${value}" is not a planning stage`, {
      value,
      known: PLANNING_STAGES,
    });
  }
}

export function assertPlanningLifecycle(value: string): asserts value is PlanningLifecycle {
  if (!(PLANNING_LIFECYCLES as readonly string[]).includes(value)) {
    throw new UltraPlanError("unknown_planning_lifecycle", `"${value}" is not a planning lifecycle`, {
      value,
      known: PLANNING_LIFECYCLES,
    });
  }
}

export function canTransitionStage(from: PlanningStage, to: PlanningStage): boolean {
  return from !== to && STAGE_TRANSITIONS[from].includes(to);
}

export function transitionStage(run: PlanningRun, to: PlanningStage): PlanningRun {
  if (!canTransitionStage(run.stage, to)) {
    throw new UltraPlanError(
      "invalid_stage_transition",
      `PlanningRun ${run.id} cannot transition stage ${run.stage} -> ${to}`,
      { from: run.stage, to },
    );
  }
  return { ...run, stage: to };
}

export function canTransitionLifecycle(from: PlanningLifecycle, to: PlanningLifecycle): boolean {
  return from !== to && LIFECYCLE_TRANSITIONS[from].includes(to);
}

export function transitionLifecycle(run: PlanningRun, to: PlanningLifecycle): PlanningRun {
  if (!canTransitionLifecycle(run.lifecycle, to)) {
    throw new UltraPlanError(
      "invalid_lifecycle_transition",
      `PlanningRun ${run.id} cannot transition lifecycle ${run.lifecycle} -> ${to}`,
      { from: run.lifecycle, to },
    );
  }
  // Structural precondition: handoff may only start from the final stage. The
  // full finalization predicate (approvals, blockers, evidence) is enforced by
  // the transaction engine at the Final PlanCommit.
  if (to === "handoff_pending" && run.stage !== "final") {
    throw new UltraPlanError(
      "invalid_lifecycle_transition",
      `PlanningRun ${run.id} cannot enter handoff_pending from stage ${run.stage}`,
      { stage: run.stage, to },
    );
  }
  return { ...run, lifecycle: to };
}

/** A session considers a run "in the way" while it is active or mid-handoff. */
export function isActiveRun(run: Pick<PlanningRun, "lifecycle">): boolean {
  return run.lifecycle === "active" || run.lifecycle === "handoff_pending";
}
