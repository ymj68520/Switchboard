/**
 * ExecutionRun — v0.2.0 supervised-execution foundation (docs/SPEC/
 * claude-code-phase-plan-v0.2.0-architecture-spec.md §8-§11/§48, Phase 1).
 *
 * The authoritative execution lifecycle object, translated to this
 * repository's provider-neutral core. It permanently binds:
 *
 * - the EXACT approved FinalPlan revision (id + revision + content hash) —
 *   never "latest", never rebindable in place (SPEC §9);
 * - a stable WorkspaceIdentity — the host-trusted workspace key this
 *   adapter already freezes (the trusted project/workspace identity that
 *   scopes one durable store; same Git repository + different worktree =
 *   different identity, SPEC §48/invariant 64);
 * - two DISTINCT baselines (SPEC §10): planningBaseline = the approval-time
 *   authority snapshot the FinalPlan itself records (FinalPlan.baseSnapshot /
 *   baseCommit), executionStartBaseline = the actual RepositoryRevision
 *   observed when the run is prepared (repository/evidence.ts representation).
 *
 * Deliberately ABSENT in Phase 1 (SPEC §11 fields that belong to later
 * phases): acceptedHead, activeStage, openWindow. There is no fake
 * ExecutionStage/VerificationWindow/ExecutionCommit and no placeholder
 * EC-000 — accepted-head semantics arrive with ExecutionCommit.
 *
 * The lifecycle is intentionally small (SPEC §11): prepared → active →
 * {completed | replan_required | aborted}, plus prepared → aborted for the
 * explicit cancellation of a not-yet-activated handoff (the same escape the
 * v0.1 planning lifecycle freezes for handoff_pending → aborted). Ordinary
 * implementation failure, verification failure, blocking, or environment
 * trouble are NOT lifecycle states.
 */
import { UltraPlanError } from "./errors.js";
import type { CommitID, ExecutionCommitID, ExecutionRunID, ExecutionStageID, PlanID, VerificationWindowID } from "./ids.js";
import type { FinalPlanRef, SnapshotRef, Timestamp } from "./refs.js";
import type { RepositoryRevision } from "../repository/evidence.js";
import { stableStringify } from "./invariants.js";

export const EXECUTION_LIFECYCLES = ["prepared", "active", "completed", "replan_required", "aborted"] as const;
export type ExecutionLifecycle = (typeof EXECUTION_LIFECYCLES)[number];

/**
 * Lifecycle graph (SPEC §11):
 *
 *   prepared → active
 *   prepared → aborted            (explicit cancel of a prepared handoff)
 *   active → completed
 *   active → replan_required
 *   active → aborted
 *
 * `completed`, `replan_required`, and `aborted` are terminal. replan_required
 * carries REPLAN_REQUIRED semantics at the lifecycle/storage level only — the
 * replan workflow itself is later-phase work.
 */
export const EXECUTION_LIFECYCLE_TRANSITIONS: Readonly<
  Record<ExecutionLifecycle, readonly ExecutionLifecycle[]>
> = {
  prepared: ["active", "aborted"],
  active: ["completed", "replan_required", "aborted"],
  completed: [],
  replan_required: [],
  aborted: [],
};

/**
 * Opaque, stable workspace identity. The value is the authority-side
 * (Harness/host) trusted workspace key — in this adapter, the trusted
 * project/workspace identity that already scopes the durable store
 * (runtime/instance.ts). It is NEVER model-supplied and never re-derived
 * from mutable paths at use time.
 */
export interface WorkspaceIdentity {
  key: string;
}

export function workspaceKey(identity: WorkspaceIdentity): string {
  return identity.key;
}

export function workspaceIdentityEquals(a: WorkspaceIdentity, b: WorkspaceIdentity): boolean {
  return stableStringify(a) === stableStringify(b);
}

/**
 * SPEC §10 planning baseline — the durable reference answering "which
 * approved planning state did this ExecutionRun start from?". Derived ONCE at
 * run creation from the exact FinalPlan record (its own provenance fields);
 * never re-derived, never updated.
 */
export interface PlanningBaselineRef {
  /** The exact pre-final-commit HEAD Snapshot the FinalPlan was frozen against. */
  snapshot: SnapshotRef;
  /** The final PlanCommit, when the planning run had commits. */
  finalCommit: CommitID | null;
}

/**
 * The ExecutionRun record (SPEC §11, Phase 1 subset). Immutable authority
 * fields: id, planID, initialHandoffKey, workspace, finalPlan (+hash),
 * planningBaseline, executionStartBaseline, createdAt. Only lifecycle,
 * revision, and updatedAt ever change.
 */
export interface ExecutionRun {
  id: ExecutionRunID;
  /** The source PlanningRun that produced the bound FinalPlan. */
  planID: PlanID;
  /**
   * The initial-handoff identity this run was prepared under. Deterministic
   * for one handoff of one FinalPlan (see executionInitialHandoffKey);
   * idempotency binds to THIS, never to the FinalPlan alone (SPEC §9 allows
   * several runs per FinalPlan for genuinely distinct executions).
   */
  initialHandoffKey: string;

  workspace: WorkspaceIdentity;

  /** Exact approved FinalPlan binding — id + revision, immutable after creation. */
  finalPlan: FinalPlanRef;
  /** The approved FinalPlan's canonical content hash at binding time. */
  finalPlanHash: string;

  planningBaseline: PlanningBaselineRef;
  /** Actual workspace state observed when the run was prepared (SPEC §10). */
  executionStartBaseline: RepositoryRevision;

  lifecycle: ExecutionLifecycle;

  /**
   * v0.2.0 Phase 3 — the single active Stage (SPEC §11/§13.4: at most one).
   * Mutated ONLY by the atomic Stage activation/closure transactions; there
   * is deliberately no setActiveStage setter. A terminal run's value is
   * frozen history (never deleted).
   */
  activeStage?: ExecutionStageID;

  /**
   * v0.2.0 Phase 3 — the single open VerificationWindow (SPEC §11/§14.3).
   * Mutated ONLY by the window-opening transaction (closure is reserved for
   * the future ExecutionCommit); no setter exists.
   */
  openWindow?: VerificationWindowID;

  /**
   * v0.2.0 Phase 5 — the authoritative accepted execution progress: the tip
   * of the linear ExecutionCommit chain. Mutated ONLY inside the accept
   * transaction (there is no setAcceptedHead); absent means the current
   * accepted state is still the executionStartBaseline — never a fake EC-000.
   */
  acceptedHead?: ExecutionCommitID;

  /**
   * v0.2.0 Phase 6B — the ExecutionCompletionRecord that documents this run's
   * passage through the ExecutionCompletionGate. SET ONLY by the gate
   * transaction. Absent on a completed run = LEGACY completion provenance
   * (pre-6B records remain loadable; no normal API can create that shape
   * anymore, §51/§53).
   */
  completionRecord?: import("./ids.js").ExecutionCompletionID;

  /** Monotonic; bumped on every persisted mutation. */
  revision: number;

  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/**
 * THE unified accepted-state reference (Phase 5 §5): with no commit yet the
 * accepted state IS the run's executionStartBaseline; afterwards it is the
 * acceptedHead commit. There is deliberately no fake EC-000.
 */
export type AcceptedExecutionStateRef =
  | { kind: "execution_start"; executionRunID: ExecutionRunID }
  | { kind: "execution_commit"; executionCommitID: ExecutionCommitID };

export function currentAcceptedState(run: Pick<ExecutionRun, "id" | "acceptedHead">): AcceptedExecutionStateRef {
  return run.acceptedHead !== undefined
    ? { kind: "execution_commit", executionCommitID: run.acceptedHead }
    : { kind: "execution_start", executionRunID: run.id };
}

export function assertExecutionLifecycle(value: string): asserts value is ExecutionLifecycle {
  if (!(EXECUTION_LIFECYCLES as readonly string[]).includes(value)) {
    throw new UltraPlanError("invalid_execution_lifecycle", `"${value}" is not an execution lifecycle`, {
      value,
      known: EXECUTION_LIFECYCLES,
    });
  }
}

export function canTransitionExecutionLifecycle(from: ExecutionLifecycle, to: ExecutionLifecycle): boolean {
  return from !== to && EXECUTION_LIFECYCLE_TRANSITIONS[from].includes(to);
}

/**
 * Pure domain transition. Structural preconditions only (lifecycle legality);
 * store-level binding/revision/workspace checks happen in the store's
 * validated mutation operations.
 */
export function transitionExecutionRun(run: ExecutionRun, to: ExecutionLifecycle): ExecutionRun {
  if (!canTransitionExecutionRun(run, to)) {
    throw new UltraPlanError(
      "invalid_execution_lifecycle",
      `ExecutionRun ${run.id} cannot transition lifecycle ${run.lifecycle} -> ${to}`,
      { from: run.lifecycle, to },
    );
  }
  return { ...run, lifecycle: to };
}

/** Full legality including the no-op guard, for callers that validate first. */
export function canTransitionExecutionRun(run: Pick<ExecutionRun, "lifecycle">, to: ExecutionLifecycle): boolean {
  return canTransitionExecutionLifecycle(run.lifecycle, to);
}

/**
 * The immutable authority binding. Every persisted ExecutionRun mutation must
 * keep every field below exactly equal — there is no rebind, no workspace
 * migration, no baseline rewrite (SPEC §9/§48).
 */
const IMMUTABLE_EXECUTION_RUN_FIELDS = [
  "id",
  "planID",
  "initialHandoffKey",
  "workspace",
  "finalPlan",
  "finalPlanHash",
  "planningBaseline",
  "executionStartBaseline",
  "createdAt",
] as const;

export function assertExecutionRunBindingUnchanged(before: ExecutionRun, after: ExecutionRun): void {
  for (const field of IMMUTABLE_EXECUTION_RUN_FIELDS) {
    if (stableStringify(before[field]) !== stableStringify(after[field])) {
      throw new UltraPlanError(
        "final_plan_binding_mismatch",
        `ExecutionRun ${before.id} authority field "${field}" is immutable and may never change in place`,
        { executionRunID: before.id, field },
      );
    }
  }
}

/**
 * The deterministic default initial-handoff identity for one FinalPlan:
 * `<planID>/<finalPlanID>@<revision>/initial`. The same handoff retried after
 * a crash recomputes exactly this key; a genuinely distinct future execution
 * of the same FinalPlan passes a DIFFERENT explicit key, so the architecture
 * stays capable of 0..N runs per FinalPlan (SPEC §9).
 */
export function executionInitialHandoffKey(planID: PlanID, finalPlan: FinalPlanRef): string {
  return `${planID}/${finalPlan.id}@${finalPlan.revision}/initial`;
}

/** The store's handoff-identity index key (plan-scoped, like commitByProposal). */
export function executionHandoffIndexKey(planID: PlanID, initialHandoffKey: string): string {
  return `${planID}:${initialHandoffKey}`;
}
