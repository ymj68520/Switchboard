/**
 * ExecutionStage — v0.2.0 Phase 3 (supervised-execution structural layer).
 *
 * An ExecutionStage is the Execution Supervisor's DURABLE EXECUTION
 * DECOMPOSITION of the bound FinalPlan's implementation obligations. It is
 * execution-only organization:
 *
 * - It is NOT a Plan Section, NOT a Plan Memory revision, NOT an approved
 *   Decision, NOT new normative design. Stage creation requires NO user
 *   Plan approval precisely because it must not introduce normative
 *   choices — `planRefs` are exact provenance references INTO the already
 *   approved FinalPlan, validated for exact existence, never resolved to
 *   "latest", never mutated.
 * - Stages can NEVER advance accepted execution truth by themselves; only
 *   the future ExecutionCommit can (SPEC v0.2.0 §12).
 *
 * DEPENDENCY SEMANTICS (directive §9): `dependsOn` holds MANDATORY approved
 * execution dependencies and is supplied explicitly by the Supervisor's
 * decomposition. The FinalPlan's implementationOrder is sequencing
 * GUIDANCE — its normative content is exact Section-revision coverage plus
 * Section-DAG consistency, NOT hard step-to-step dependency edges — so it is
 * deliberately never mechanically converted into Stage dependencies.
 *
 * COMPLETION IS RESERVED (directive §15): `completed` exists in the frozen
 * status vocabulary for forward compatibility, but in Phase 3 no API can
 * produce it — the future ExecutionCommit closes Stage completion
 * obligations and Core then derives Stage.completed.
 */
import { UltraPlanError } from "./errors.js";
import type {
  ConstraintID,
  DecisionID,
  ExecutionRunID,
  ExecutionStageID,
  FinalPlanID,
  SectionID,
  StageCompletionObligationID,
} from "./ids.js";
import type { Timestamp } from "./refs.js";
import type { FinalPlan } from "./types.js";
import type { ExecutionRun } from "./execution-run.js";

export const EXECUTION_STAGE_STATUSES = ["pending", "active", "completed", "superseded"] as const;
export type ExecutionStageStatus = (typeof EXECUTION_STAGE_STATUSES)[number];

/**
 * Phase 6B §6 — the Stage KIND axis (orthogonal to status). `final_closure`
 * is the ONE execution-only integration-closure Stage per run; ordinary
 * Stages are the normal decomposition. LEGACY Stages (pre-6B, field absent)
 * are `ordinary` — the default is load-level, never a stored rewrite. `kind`
 * is fixed at creation: there is deliberately NO ordinary→final_closure or
 * final_closure→ordinary conversion.
 */
export const EXECUTION_STAGE_KINDS = ["ordinary", "final_closure"] as const;
export type ExecutionStageKind = (typeof EXECUTION_STAGE_KINDS)[number];

export function assertExecutionStageKind(value: string): asserts value is ExecutionStageKind {
  if (!(EXECUTION_STAGE_KINDS as readonly string[]).includes(value)) {
    throw new UltraPlanError("invalid_scope", `"${value}" is not an execution stage kind`, {
      value,
      known: EXECUTION_STAGE_KINDS,
    });
  }
}

/** Legacy-missing kind = ordinary (§6 backward compatibility). */
export function executionStageKindOf(stage: Pick<ExecutionStage, "kind">): ExecutionStageKind {
  return stage.kind ?? "ordinary";
}

/**
 * Stage transition table. `pending → completed` does NOT exist (completion
 * is derived by the future ExecutionCommit, never a direct transition), and
 * `active → superseded` is deliberately closed in Phase 3 (minimal
 * supersession: pending only; active-stage split/replace belongs to the
 * Supervisor implementation phase).
 */
export const EXECUTION_STAGE_TRANSITIONS: Readonly<
  Record<ExecutionStageStatus, readonly ExecutionStageStatus[]>
> = {
  pending: ["active", "superseded"],
  // RESERVED: reachable only through the future ExecutionCommit transaction.
  active: ["completed"],
  completed: [],
  superseded: [],
};

export function assertExecutionStageStatus(value: string): asserts value is ExecutionStageStatus {
  if (!(EXECUTION_STAGE_STATUSES as readonly string[]).includes(value)) {
    throw new UltraPlanError("invalid_stage_transition", `"${value}" is not an execution stage status`, {
      value,
      known: EXECUTION_STAGE_STATUSES,
    });
  }
}

export function canTransitionExecutionStage(from: ExecutionStageStatus, to: ExecutionStageStatus): boolean {
  return from !== to && EXECUTION_STAGE_TRANSITIONS[from].includes(to);
}

/**
 * Exact execution provenance refs INTO the run's bound approved FinalPlan.
 * Every variant carries (or names) an exact identity that is validated for
 * existence against the committed FinalPlan record at Stage creation —
 * never resolved to latest, never a new Plan Memory domain.
 */
export type ExecutionPlanRef =
  | { kind: "final_plan"; id: FinalPlanID; revision: number }
  | { kind: "section_revision"; id: SectionID; revision: number }
  | { kind: "decision"; id: DecisionID; revision: number }
  | { kind: "constraint"; id: ConstraintID }
  | { kind: "implementation_step"; order: number };

/** See ExecutionStage.completionObligations (Phase 5). */
export interface ExecutionStageCompletionObligation {
  /** Stage-scoped id (OBS-###) — stable, referenced by coverage declarations and commits. */
  id: StageCompletionObligationID;
  description: string;
  /** Exact FinalPlan-reachable provenance — never a new normative statement. */
  planRefs: ExecutionPlanRef[];
}

/**
 * The durable execution decomposition unit. Phase 5: `completionObligations`
 * identify the execution-closure units whose accepted evidence must exist
 * before the Stage may complete (embedded here — they belong to exactly one
 * Stage, are immutable after creation, and never create Plan Memory truth).
 * OPTIONAL for pre-Phase-5 durability; a Stage WITHOUT explicit obligations
 * can never complete (missing obligations ≠ zero obligations).
 *
 * Phase 6B: `kind` distinguishes the ordinary decomposition from the ONE
 * final_closure integration Stage. Absent = ordinary (legacy durability);
 * fixed at creation, never converted.
 */
export interface ExecutionStage {
  id: ExecutionStageID;
  executionRunID: ExecutionRunID;

  title: string;
  objective: string;

  /** Phase 6B §6 — ordinary (default for legacy records) vs final_closure; immutable. */
  kind?: ExecutionStageKind;

  status: ExecutionStageStatus;

  /** Obligation provenance — exact refs into the bound approved FinalPlan. */
  planRefs: ExecutionPlanRef[];

  /** MANDATORY dependencies (explicit Supervisor input; completed deps gate eligibility). */
  dependsOn: ExecutionStageID[];

  /** Phase 5 — explicit completion obligations; absence means "cannot complete", never "trivially complete". */
  completionObligations?: ExecutionStageCompletionObligation[];

  /** When this Stage replaces an earlier decomposition decision (new id; the old Stage stays durable). */
  supersedes?: ExecutionStageID;

  /** Record concurrency revision (CAS). */
  revision: number;

  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/**
 * Validate `planRefs` for EXACT existence against the run's committed
 * FinalPlan record. No resolution to latest; an unknown ref fails
 * `invalid_scope` at creation time (storage load re-checks shape).
 */
export function validateExecutionPlanRefs(planRefs: readonly ExecutionPlanRef[], finalPlan: FinalPlan): void {
  const sectionSet = new Set(finalPlan.sections.map((ref) => `${ref.id}@${ref.revision}`));
  const decisionSet = new Set(finalPlan.decisions.map((ref) => `${ref.id}@${ref.revision}`));
  const constraintSet = new Set(finalPlan.constraints.map((constraint) => constraint.id as string));
  const stepOrders = new Set(finalPlan.implementationOrder.map((step) => step.order));
  for (const ref of planRefs) {
    switch (ref.kind) {
      case "final_plan":
        if (ref.id !== finalPlan.id || ref.revision !== finalPlan.revision) {
          throw new UltraPlanError(
            "invalid_scope",
            `Stage planRef binds ${ref.id}@${ref.revision}, but the run's approved FinalPlan is ${finalPlan.id}@${finalPlan.revision}`,
            { ref },
          );
        }
        break;
      case "section_revision":
        if (!sectionSet.has(`${ref.id}@${ref.revision}`)) {
          throw new UltraPlanError(
            "invalid_scope",
            `Stage planRef binds unknown/unapproved SectionRevision ${ref.id}@${ref.revision} (the approved FinalPlan does not carry it)`,
            { ref },
          );
        }
        break;
      case "decision":
        if (!decisionSet.has(`${ref.id}@${ref.revision}`)) {
          throw new UltraPlanError(
            "invalid_scope",
            `Stage planRef binds unknown/unapproved Decision ${ref.id}@${ref.revision}`,
            { ref },
          );
        }
        break;
      case "constraint":
        if (!constraintSet.has(ref.id)) {
          throw new UltraPlanError("invalid_scope", `Stage planRef binds unknown committed Constraint ${ref.id}`, { ref });
        }
        break;
      case "implementation_step":
        if (!stepOrders.has(ref.order)) {
          throw new UltraPlanError(
            "invalid_scope",
            `Stage planRef binds implementation step ${ref.order}, which does not exist in the approved FinalPlan implementation order`,
            { ref },
          );
        }
        break;
    }
  }
}

/**
 * THE stage-eligibility predicate (directive §10) — deterministic, ordered
 * only by structure (never array position, createdAt, or stage number):
 *
 *   run.lifecycle == active
 *   stage.status == pending
 *   every mandatory dependency == completed
 *   no other active Stage exists for the run
 *   run.activeStage absent
 *   no open VerificationWindow
 */
export function isStageEligible(input: {
  run: Pick<ExecutionRun, "lifecycle" | "activeStage" | "openWindow">;
  stage: Pick<ExecutionStage, "status" | "dependsOn">;
  stagesForRun: readonly Pick<ExecutionStage, "id" | "status">[];
}): boolean {
  return stageEligibilityViolation(input) === undefined;
}

/** The specific eligibility violation, for deterministic error mapping. */
export function stageEligibilityViolation(input: {
  run: Pick<ExecutionRun, "lifecycle" | "activeStage" | "openWindow">;
  stage: Pick<ExecutionStage, "status" | "dependsOn">;
  stagesForRun: readonly Pick<ExecutionStage, "id" | "status">[];
}): { code: "invalid_execution_lifecycle" | "invalid_stage_transition" | "stage_dependency_unsatisfied" | "active_stage_conflict" | "window_already_open"; reason: string } | undefined {
  const { run, stage, stagesForRun } = input;
  if (run.lifecycle !== "active") {
    return { code: "invalid_execution_lifecycle", reason: `Stage activation requires an active ExecutionRun (run is ${run.lifecycle})` };
  }
  if (stage.status !== "pending") {
    return { code: "invalid_stage_transition", reason: `Only a pending Stage can be activated (stage is ${stage.status})` };
  }
  const unsatisfied = stage.dependsOn.filter((dep) => stagesForRun.find((candidate) => candidate.id === dep)?.status !== "completed");
  if (unsatisfied.length > 0) {
    return { code: "stage_dependency_unsatisfied", reason: `Mandatory Stage dependencies not completed: ${unsatisfied.join(", ")}` };
  }
  if (run.activeStage !== undefined || stagesForRun.some((candidate) => candidate.status === "active")) {
    return { code: "active_stage_conflict", reason: "Another Stage is already active for this ExecutionRun" };
  }
  if (run.openWindow !== undefined) {
    return { code: "window_already_open", reason: "An open VerificationWindow blocks Stage activation" };
  }
  return undefined;
}

/**
 * Cycle/self-dependency detection over the CANDIDATE Stage DAG (existing
 * stages of the run + the creation batch). Mirrors the planning Section DAG
 * DFS (invariants.ts) — the section-typed utility itself is not reusable
 * across types, so this is the execution-layer counterpart with the
 * execution-specific error code.
 */
/**
 * Stage 5 acceptance-precondition helpers. A Stage without EXPLICIT
 * completion obligations can never complete (§10): missing obligations are
 * NOT zero obligations.
 */
export function stageCompletionObligations(
  stage: Pick<ExecutionStage, "completionObligations">,
): readonly ExecutionStageCompletionObligation[] {
  return stage.completionObligations ?? [];
}

export function stageHasExplicitCompletionObligations(
  stage: Pick<ExecutionStage, "completionObligations">,
): boolean {
  return (stage.completionObligations ?? []).length > 0;
}

/**
 * Phase 6B §8 — THE final-closure readiness predicate. Deterministic and
 * structural: the run is active and idle (no active Stage / open Window /
 * running Attempt / unresolved indeterminate Attempt), every ordinary
 * non-superseded Stage is completed (superseded Stages are deliberately NOT
 * required to be completed — they are abandoned decomposition history), and
 * accepted execution progress exists (acceptedHead — never a fake EC-000).
 * The "at least one completed ordinary Stage" rule (§9) falls out of
 * acceptedHead: it exists only after an ordinary Stage-completing commit.
 */
export function isExecutionReadyForFinalClosure(input: {
  run: Pick<ExecutionRun, "lifecycle" | "activeStage" | "openWindow" | "acceptedHead">;
  stagesForRun: readonly Pick<ExecutionStage, "id" | "kind" | "status">[];
  hasRunningAttempt: boolean;
  unresolvedIndeterminateAttempts: number;
}): boolean {
  const { run, stagesForRun, hasRunningAttempt, unresolvedIndeterminateAttempts } = input;
  if (run.lifecycle !== "active") return false;
  if (run.activeStage !== undefined || run.openWindow !== undefined) return false;
  if (hasRunningAttempt || unresolvedIndeterminateAttempts > 0) return false;
  if (run.acceptedHead === undefined) return false;
  const ordinary = stagesForRun.filter((stage) => executionStageKindOf(stage) === "ordinary" && stage.status !== "superseded");
  return ordinary.every((stage) => stage.status === "completed");
}

/** The specific readiness violation, for deterministic gate error mapping (§67). */
export function finalClosureReadinessViolation(input: Parameters<typeof isExecutionReadyForFinalClosure>[0]): string | undefined {
  const { run, stagesForRun, hasRunningAttempt, unresolvedIndeterminateAttempts } = input;
  if (run.lifecycle !== "active") return `the ExecutionRun is ${run.lifecycle}, not active`;
  if (run.activeStage !== undefined) return `the run still has an active Stage (${run.activeStage})`;
  if (run.openWindow !== undefined) return `the run still has an open VerificationWindow (${run.openWindow})`;
  if (hasRunningAttempt) return "a Worker Attempt is still running";
  if (unresolvedIndeterminateAttempts > 0) return `${unresolvedIndeterminateAttempts} unresolved indeterminate Attempt(s) require reconciliation`;
  if (run.acceptedHead === undefined) return "no accepted execution progress exists yet (acceptedHead is absent)";
  const uncompleted = stagesForRun
    .filter((stage) => executionStageKindOf(stage) === "ordinary" && stage.status !== "superseded" && stage.status !== "completed")
    .map((stage) => `${stage.id} (${stage.status})`);
  if (uncompleted.length > 0) return `ordinary Stage(s) not completed: ${uncompleted.join(", ")}`;
  return undefined;
}

export function assertAcyclicStages(stages: readonly Pick<ExecutionStage, "id" | "dependsOn">[]): void {
  const dependencies = new Map<string, readonly string[]>();
  for (const stage of stages) {
    dependencies.set(stage.id, stage.dependsOn);
  }
  const state = new Map<string, "visiting" | "done">();
  const path: string[] = [];
  const visit = (id: string): void => {
    const current = state.get(id);
    if (current === "done") return;
    if (current === "visiting") {
      const start = path.indexOf(id);
      const cycle = start >= 0 ? [...path.slice(start), id] : [id];
      throw new UltraPlanError("stage_dependency_cycle", `ExecutionStage dependency cycle: ${cycle.join(" -> ")}`, { cycle });
    }
    state.set(id, "visiting");
    path.push(id);
    for (const dep of dependencies.get(id) ?? []) {
      if (dependencies.has(dep)) visit(dep);
    }
    path.pop();
    state.set(id, "done");
  };
  for (const id of dependencies.keys()) visit(id);
}
