/**
 * SupervisorBinding — v0.2.0 Phase 2 (supervised-execution control plane).
 *
 * A durable record answering, per ExecutionRun: WHICH trusted OpenCode
 * session currently holds WRITABLE supervision authority, at WHICH fencing
 * generation, in WHICH attachment state. It is deliberately ORTHOGONAL to
 * ExecutionRun.lifecycle: attach/detach/takeover never move the run's
 * lifecycle, and session crash / close / /clear / compaction never moves it
 * either — only the frozen Phase 1 transitions may.
 *
 * FROZEN INVARIANT (directive §7): one ExecutionRun has AT MOST ONE writable
 * Supervisor owner. The binding record is keyed by executionRunID, so a
 * second writable owner is unrepresentable; a different session acquires
 * authority ONLY through an explicit, authorized takeover that bumps the
 * monotonic generation, after which every authority check carrying the old
 * generation fails `stale_supervisor_binding` — deterministically, with no
 * dependence on process liveness.
 *
 * Identity is TRUSTED BOUNDARY state (directive §9): the owner is the
 * host-supplied OpenCode sessionID (hooks/ToolContext — the same source the
 * PlanningRun subsystem already treats as authoritative), never a model
 * business payload. There is deliberately no Worker/Executor/Verifier
 * binding: workers are ephemeral Directive→Attempt invocations of later
 * phases; only the Supervisor owns a long-lived session binding.
 */
import { UltraPlanError } from "./errors.js";
import type { ExecutionRunID } from "./ids.js";
import type { Timestamp } from "./refs.js";
import { stableStringify } from "./invariants.js";
import type { ExecutionRun, WorkspaceIdentity } from "./execution-run.js";

/** Attachment state — the ONLY mutable axis besides generation/owner. */
export const SUPERVISOR_BINDING_STATES = ["attached", "detached"] as const;
export type SupervisorBindingState = (typeof SUPERVISOR_BINDING_STATES)[number];

/**
 * The durable supervisor-ownership record for ONE ExecutionRun (at most one
 * exists per run). `generation` is 1-based and monotonic (the repository's
 * frozen numbering convention); the FIRST attach mints generation 1.
 */
export interface SupervisorBinding {
  executionRunID: ExecutionRunID;
  /** Trusted current owner session — exactly the host-supplied sessionID. */
  ownerSessionID: string;
  /** Must equal the bound ExecutionRun's workspace for the binding to be valid. */
  workspace: WorkspaceIdentity;
  /** Monotonic fencing generation (1 on first attach; +1 per takeover). */
  generation: number;
  state: SupervisorBindingState;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export function supervisorBindingEquals(a: SupervisorBinding, b: SupervisorBinding): boolean {
  return stableStringify(a) === stableStringify(b);
}

/**
 * The authority evidence an operation must present. Everything comes from the
 * trusted host context (session/workspace) and the caller's known binding
 * state (generation) — never from model-supplied business payload.
 */
export interface ExecutionSupervisorAuthority {
  executionRunID: ExecutionRunID;
  /** Trusted current session (host-supplied OpenCode sessionID). */
  sessionID: string;
  workspace: WorkspaceIdentity;
  /** The caller's known binding generation; a stale value is fenced out. */
  generation: number;
}

/**
 * Directive §14 — the takeover authorization precondition abstraction. Only
 * an explicitly user-authorized takeover passes; there is no automatic or
 * model-initiated arbitrary-session takeover in this phase.
 */
export type SupervisorTakeoverAuthorization =
  | { kind: "user_authorized"; reason: string }
  | { kind: "unauthorized" };

export function assertSupervisorTakeoverAuthorized(
  authorization: SupervisorTakeoverAuthorization,
): void {
  if (authorization.kind !== "user_authorized") {
    throw new UltraPlanError(
      "takeover_requires_authorization",
      "Writable supervisor takeover is an explicitly user-authorized action; no automatic or model-initiated takeover exists",
      { authorizationKind: authorization.kind },
    );
  }
}

export function assertSupervisorBindingState(value: string): asserts value is SupervisorBindingState {
  if (!(SUPERVISOR_BINDING_STATES as readonly string[]).includes(value)) {
    throw new UltraPlanError("supervisor_binding_conflict", `"${value}" is not a supervisor binding state`, {
      value,
      known: SUPERVISOR_BINDING_STATES,
    });
  }
}

/** A run is supervisable while it can still execute: prepared or active. */
export function isSupervisableExecutionRun(run: Pick<ExecutionRun, "lifecycle">): boolean {
  return run.lifecycle === "prepared" || run.lifecycle === "active";
}

/**
 * THE reusable authority boundary (directive §8). Every future supervised
 * mutation — Directive issue, Assessment submission, Stage transition,
 * replan request — must pass through this ONE check; no service writes its
 * own session check.
 *
 * Verifies, in order (each failure is a stable machine-readable error):
 *   1. run exists                                   → execution_run_not_found
 *   2. run not terminal (and lifecycle requirement) → invalid_execution_lifecycle
 *   3. binding exists                               → supervisor_binding_not_found
 *   4. binding is writable (attached)               → supervisor_binding_conflict
 *   5. binding workspace == run workspace           → workspace_mismatch
 *   6. presented generation == current generation   → stale_supervisor_binding
 *   7. binding owner == trusted session             → supervisor_session_mismatch
 *
 * The generation fence is checked BEFORE the owner on purpose (directive
 * §29): after a takeover, the OLD owner presenting the OLD generation must
 * see the fencing error — the stale generation is what killed its authority,
 * deterministically, with no dependence on process liveness.
 */
export function assertExecutionSupervisorAuthority(
  run: ExecutionRun,
  binding: SupervisorBinding | undefined,
  authority: Pick<ExecutionSupervisorAuthority, "sessionID" | "workspace" | "generation">,
  options: { requireSupervisableRun?: boolean } = {},
): void {
  if (options.requireSupervisableRun !== false && !isSupervisableExecutionRun(run)) {
    throw new UltraPlanError(
      "invalid_execution_lifecycle",
      `ExecutionRun ${run.id} is terminal (${run.lifecycle}); no supervision authority applies`,
      { executionRunID: run.id, lifecycle: run.lifecycle },
    );
  }
  if (!binding) {
    throw new UltraPlanError(
      "supervisor_binding_not_found",
      `ExecutionRun ${run.id} has no SupervisorBinding; attach a supervisor first`,
      { executionRunID: run.id },
    );
  }
  if (binding.executionRunID !== run.id) {
    throw new UltraPlanError(
      "supervisor_binding_conflict",
      `SupervisorBinding belongs to ${binding.executionRunID}, not ${run.id}`,
      { executionRunID: run.id, bindingRun: binding.executionRunID },
    );
  }
  if (binding.state !== "attached") {
    throw new UltraPlanError(
      "supervisor_binding_conflict",
      `SupervisorBinding for ${run.id} is detached; no writable supervision authority exists until an attach or authorized takeover`,
      { executionRunID: run.id, state: binding.state },
    );
  }
  if (stableStringify(binding.workspace) !== stableStringify(authority.workspace)) {
    throw new UltraPlanError(
      "workspace_mismatch",
      `SupervisorBinding for ${run.id} is bound to workspace ${JSON.stringify(binding.workspace)}, not the caller's ${JSON.stringify(authority.workspace)}`,
      { executionRunID: run.id },
    );
  }
  if (binding.generation !== authority.generation) {
    throw new UltraPlanError(
      "stale_supervisor_binding",
      `SupervisorBinding for ${run.id} is at generation ${binding.generation}; the presented generation ${authority.generation} is fenced out`,
      { executionRunID: run.id, currentGeneration: binding.generation, presentedGeneration: authority.generation },
    );
  }
  if (binding.ownerSessionID !== authority.sessionID) {
    throw new UltraPlanError(
      "supervisor_session_mismatch",
      `SupervisorBinding for ${run.id} is owned by another session; the current session holds no writable authority`,
      { executionRunID: run.id },
    );
  }
}
