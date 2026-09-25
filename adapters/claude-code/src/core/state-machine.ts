/**
 * PlanningRun state machine — PURE core (frozen plan §36/§37).
 *
 * This module encodes the frozen stage graph and lifecycle vocabulary and
 * nothing else: no SQLite, no Claude, no MCP, no filesystem, no env. It is
 * the single authority for "what may happen next"; Proposal/Commit layers
 * reuse it directly in later phases.
 *
 * callers declare what happened (event); the machine decides the resulting
 * stage. Illegal stage/event combinations are INVALID_RUN_TRANSITION — never
 * best-effort, never skipped-ahead.
 *
 * Deliberately absent: BUILD and handoff_pending are NOT planning stages
 * (frozen architecture §7), and there is no final→completed transition —
 * completion structurally exists in the lifecycle vocabulary but Phase 4
 * exposes no production transition into it (the sole legal path — Final
 * Approval → Final PlanCommit → handoff_pending → successful handoff —
 * arrives in the handoff phase).
 */

export const PLANNING_LIFECYCLES = ["active", "completed", "aborted"] as const;
export type PlanningLifecycle = (typeof PLANNING_LIFECYCLES)[number];

export const PLANNING_STAGES = [
  "discovery",
  "architecture",
  "detail",
  "synthesis",
  "validation",
  "final",
] as const;
export type PlanningStage = (typeof PLANNING_STAGES)[number];

/** Internal, declarative run events. Callers never name a target stage. */
export const PLANNING_RUN_EVENTS = [
  "DISCOVERY_COMPLETE",
  "ARCHITECTURE_APPROVED",
  "DETAIL_COMPLETE",
  "SYNTHESIS_SUBMITTED",
  "REOPEN_DETAIL",
  "REOPEN_ARCHITECTURE",
  "VALIDATION_CLEAN",
] as const;
export type PlanningRunEvent = (typeof PLANNING_RUN_EVENTS)[number];

export function isPlanningLifecycle(value: string): value is PlanningLifecycle {
  return (PLANNING_LIFECYCLES as readonly string[]).includes(value);
}

export function isPlanningStage(value: string): value is PlanningStage {
  return (PLANNING_STAGES as readonly string[]).includes(value);
}

export function isPlanningRunEvent(value: string): value is PlanningRunEvent {
  return (PLANNING_RUN_EVENTS as readonly string[]).includes(value);
}

/** completed and aborted are terminal; only active runs may mutate. */
export function isTerminalLifecycle(lifecycle: PlanningLifecycle): boolean {
  return lifecycle !== "active";
}

/**
 * The frozen v0.1 transition matrix (frozen plan §18). Forward path plus
 * explicit reopen paths — reopening the top-level architecture must be
 * reachable from detail/synthesis/validation/final because later stages can
 * discover the architecture itself is wrong.
 */
const TRANSITIONS: Readonly<Record<PlanningStage, Partial<Record<PlanningRunEvent, PlanningStage>>>> = {
  discovery: {
    DISCOVERY_COMPLETE: "architecture",
  },
  architecture: {
    ARCHITECTURE_APPROVED: "detail",
  },
  detail: {
    DETAIL_COMPLETE: "synthesis",
  },
  synthesis: {
    SYNTHESIS_SUBMITTED: "validation",
    REOPEN_DETAIL: "detail",
    REOPEN_ARCHITECTURE: "architecture",
  },
  validation: {
    VALIDATION_CLEAN: "final",
    REOPEN_DETAIL: "detail",
    REOPEN_ARCHITECTURE: "architecture",
  },
  final: {
    REOPEN_DETAIL: "detail",
    REOPEN_ARCHITECTURE: "architecture",
  },
};

/** The frozen forward path: discovery → architecture → detail → synthesis → validation → final. */
export const FORWARD_STAGE_PATH: readonly PlanningStage[] = [
  "discovery",
  "architecture",
  "detail",
  "synthesis",
  "validation",
  "final",
];

export function isLegalTransition(currentStage: PlanningStage, event: PlanningRunEvent): boolean {
  return TRANSITIONS[currentStage][event] !== undefined;
}

/**
 * Pure transition function. Throws INVALID_RUN_TRANSITION for any
 * stage/event pair absent from the frozen matrix — the caller-supplied
 * event describes what happened; the target stage is never caller-chosen.
 */
export function nextStage(currentStage: PlanningStage, event: PlanningRunEvent): PlanningStage {
  const target = TRANSITIONS[currentStage][event];
  if (target === undefined) {
    throw new Error(`INVALID_RUN_TRANSITION:${currentStage}+${event}`);
  }
  return target;
}

/** Initial deterministic run state (frozen plan §13) — not caller-suppliable. */
export const INITIAL_RUN_STATE: {
  lifecycle: PlanningLifecycle;
  stage: PlanningStage;
  revision: number;
} = {
  lifecycle: "active",
  stage: "discovery",
  revision: 1,
};
