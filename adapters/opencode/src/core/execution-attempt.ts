/**
 * ExecutionAttempt — v0.2.0 Phase 4 (worker transaction protocol).
 *
 * An ExecutionAttempt is the durable record of ONE logical Worker invocation
 * against ONE exact Directive revision. FROZEN INVARIANTS:
 *
 * - One exact Directive revision → AT MOST ONE logical Attempt (durable
 *   uniqueness). Transport-level retry of the same invocation is the SAME
 *   Attempt, never a second one; a consumed (reported/indeterminate)
 *   Directive revision can never start another Attempt — follow-up work
 *   requires a new Directive revision or a new Directive.
 * - One ExecutionRun → AT MOST ONE running Attempt (durable single-writer
 *   execution; no parallel Worker attempts).
 * - State machine (directive §25): running → reported, running →
 *   indeterminate. Both are TERMINAL — there is no path back to running and
 *   no indeterminate → reported shortcut; reconciliation after an
 *   indeterminate Attempt happens through NEW Directives in a later phase.
 *
 * `candidateEffect` is copied from the bound Directive (never re-derived):
 * it is the crash-semantics fact of whether this Attempt could mutate the
 * candidate workspace — the field future commit gates use to identify
 * indeterminate side-effecting work.
 */
import { UltraPlanError } from "./errors.js";
import type { ExecutionAttemptID, ExecutionDirectiveID, ExecutionRunID, ExecutionStageID, VerificationWindowID } from "./ids.js";
import type { Timestamp } from "./refs.js";
import type { DirectiveCandidateEffect } from "./execution-directive.js";

export const WORKER_ROLES = ["executor", "verifier"] as const;
export type WorkerRole = (typeof WORKER_ROLES)[number];

/**
 * Frozen Phase 4 role mapping (directive §20): verification work always runs
 * as a fresh verifier-role invocation, while implementation and inspection
 * work run as executor-role invocations — through the ONE common worker
 * abstraction (never a second Executor/Verifier protocol).
 */
export function workerRoleForDirectiveKind(kind: "implementation" | "inspection" | "verification"): WorkerRole {
  return kind === "verification" ? "verifier" : "executor";
}

export function assertWorkerRole(value: string): asserts value is WorkerRole {
  if (!(WORKER_ROLES as readonly string[]).includes(value)) {
    throw new UltraPlanError("invalid_worker_role", `"${value}" is not a worker role`, { value, known: WORKER_ROLES });
  }
}

export const EXECUTION_ATTEMPT_STATES = ["running", "reported", "indeterminate"] as const;
export type ExecutionAttemptState = (typeof EXECUTION_ATTEMPT_STATES)[number];

/**
 * The complete frozen state machine. `reported → *` and `indeterminate → *`
 * do not exist.
 */
export const EXECUTION_ATTEMPT_TRANSITIONS: Readonly<
  Record<ExecutionAttemptState, readonly ExecutionAttemptState[]>
> = {
  running: ["reported", "indeterminate"],
  reported: [],
  indeterminate: [],
};

export function assertExecutionAttemptState(value: string): asserts value is ExecutionAttemptState {
  if (!(EXECUTION_ATTEMPT_STATES as readonly string[]).includes(value)) {
    throw new UltraPlanError("invalid_attempt_transition", `"${value}" is not an execution attempt state`, {
      value,
      known: EXECUTION_ATTEMPT_STATES,
    });
  }
}

export function canTransitionExecutionAttempt(from: ExecutionAttemptState, to: ExecutionAttemptState): boolean {
  return from !== to && EXECUTION_ATTEMPT_TRANSITIONS[from].includes(to);
}

/** The durable record of one logical Worker invocation. */
export interface ExecutionAttempt {
  id: ExecutionAttemptID;
  executionRunID: ExecutionRunID;
  stageID: ExecutionStageID;
  windowID: VerificationWindowID;

  /** The EXACT consumed Directive revision — id + revision + canonical hash. */
  directive: { id: ExecutionDirectiveID; revision: number; hash: string };

  workerRole: WorkerRole;
  state: ExecutionAttemptState;

  /** Copied from the Directive — the crash-semantics fact, never re-derived. */
  candidateEffect: DirectiveCandidateEffect;

  startedAt: Timestamp;
  endedAt?: Timestamp;

  /** Runtime invocation metadata (correlation only — NEVER authority). */
  workerInvocationRef?: string;
}

export function executionAttemptIndexKey(
  executionRunID: ExecutionRunID,
  directiveID: ExecutionDirectiveID,
  directiveRevision: number,
): string {
  return `${executionRunID}:${directiveID}@${directiveRevision}`;
}
