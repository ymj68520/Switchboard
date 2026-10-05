/**
 * ExecutionRun domain shape (v0.2.0 architecture spec §11, E1 phase §4–§7).
 *
 * PURE core: vocabulary, canonical shape, row validation, and the frozen
 * lifecycle transition authority. No SQLite, no host, no MCP.
 *
 * An ExecutionRun is ONE durable execution instance permanently bound to one
 * exact immutable FinalPlan revision (id@revision + hash) in one stable
 * WorkspaceIdentity. The binding is immutable after creation — there is no
 * update path that rebinds an existing ExecutionRun to another FinalPlan
 * (architecture §9/§52 invariant 4/5).
 *
 * The lifecycle enum is the complete frozen v0.2.0 set NOW (spec §11), but
 * E1's transition authority exposes only:
 *
 *   ABSENT    → prepared   (initial handoff creation)
 *   prepared  → active     (host handoff succeeded)
 *
 * completed / replan_required / aborted are terminal vocabulary reserved for
 * their owning phases — E1 must not pretend those subsystems exist.
 */

import type { RepositoryBaseline } from "./execution-handoff.js";
import { RuntimeError } from "../runtime/errors.js";

/** The complete frozen v0.2.0 ExecutionRun lifecycle (spec §11). */
export const EXECUTION_RUN_LIFECYCLES = [
  "prepared",
  "active",
  "completed",
  "replan_required",
  "aborted",
] as const;

export type ExecutionRunLifecycle = (typeof EXECUTION_RUN_LIFECYCLES)[number];

/** Terminal vocabularies (spec §11): reached only in their owning phases. */
export type TerminalExecutionRunLifecycle = Extract<
  ExecutionRunLifecycle,
  "completed" | "replan_required" | "aborted"
>;

export function isExecutionRunLifecycle(value: string): value is ExecutionRunLifecycle {
  return (EXECUTION_RUN_LIFECYCLES as readonly string[]).includes(value);
}

export function isTerminalExecutionRunLifecycle(
  lifecycle: ExecutionRunLifecycle,
): lifecycle is TerminalExecutionRunLifecycle {
  return lifecycle !== "prepared" && lifecycle !== "active";
}

/** The exact immutable FinalPlan revision an ExecutionRun is bound to. */
export interface ExecutionRunFinalPlanRef {
  id: string;
  revision: number;
  hash: string;
}

/**
 * planningBaseline (spec §10): the exact planning/evidence state represented
 * by FinalPlan finalization — the Final PlanCommit plus the resulting HEAD
 * snapshot it committed. Server-derived from the approved final_plans row;
 * never model-authored.
 */
export interface ExecutionRunPlanningBaseline {
  finalPlanCommitId: string;
  headSnapshotId: string;
}

/**
 * ExecutionRun (v0.2.0 spec §11) — E1 fields only. acceptedHead / activeStage
 * / openWindow are later-phase subsystems and are deliberately absent; later
 * migrations add them when their owning phases arrive.
 */
export interface ExecutionRun {
  executionRunId: string;
  /** The PlanningRun whose approved FinalPlan this run executes. */
  runId: string;
  workspaceId: string;
  /** Immutable exact FinalPlan binding — never changes after creation. */
  finalPlan: ExecutionRunFinalPlanRef;
  lifecycle: ExecutionRunLifecycle;
  planningBaseline: ExecutionRunPlanningBaseline;
  /** The workspace state execution actually starts from (spec §10). */
  executionStartBaseline: RepositoryBaseline;
  /** Optimistic-concurrency token, mirroring the planning_runs convention. */
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Validate a raw database row into an ExecutionRun. Illegal lifecycle
 * vocabulary, non-positive revision, or a broken binding shape is store
 * corruption — surfaced as STORE_SCHEMA_INVALID, never smuggled into the core.
 */
export function parseExecutionRunRow(row: Record<string, unknown>): ExecutionRun {
  const problems: string[] = [];
  if (typeof row.executionRunId !== "string" || row.executionRunId === "") problems.push("execution_run_id");
  if (typeof row.runId !== "string" || row.runId === "") problems.push("run_id");
  if (typeof row.workspaceId !== "string" || row.workspaceId === "") problems.push("workspace_id");
  if (typeof row.finalPlan !== "object" || row.finalPlan === null) {
    problems.push("final_plan");
  } else {
    const ref = row.finalPlan as Record<string, unknown>;
    if (typeof ref.id !== "string" || ref.id === "") problems.push("final_plan.id");
    if (typeof ref.revision !== "number" || !Number.isInteger(ref.revision) || ref.revision < 1) {
      problems.push("final_plan.revision");
    }
    if (typeof ref.hash !== "string" || ref.hash === "") problems.push("final_plan.hash");
  }
  if (typeof row.lifecycle !== "string" || !isExecutionRunLifecycle(row.lifecycle)) problems.push("lifecycle");
  if (typeof row.planningBaseline !== "object" || row.planningBaseline === null) {
    problems.push("planning_baseline");
  } else {
    const baseline = row.planningBaseline as Record<string, unknown>;
    if (typeof baseline.finalPlanCommitId !== "string" || baseline.finalPlanCommitId === "") {
      problems.push("planning_baseline.finalPlanCommitId");
    }
    if (typeof baseline.headSnapshotId !== "string" || baseline.headSnapshotId === "") {
      problems.push("planning_baseline.headSnapshotId");
    }
  }
  if (typeof row.executionStartBaseline !== "object" || row.executionStartBaseline === null) {
    problems.push("execution_start_baseline");
  } else {
    const baseline = row.executionStartBaseline as Record<string, unknown>;
    if (baseline.kind !== "git" && baseline.kind !== "directory") {
      problems.push("execution_start_baseline.kind");
    } else if (baseline.kind === "git" && typeof baseline.revision !== "string") {
      problems.push("execution_start_baseline.revision");
    }
  }
  if (typeof row.revision !== "number" || !Number.isInteger(row.revision) || row.revision < 1) problems.push("revision");
  if (typeof row.createdAt !== "string" || row.createdAt === "") problems.push("created_at");
  if (typeof row.updatedAt !== "string" || row.updatedAt === "") problems.push("updated_at");
  if (problems.length > 0) {
    throw new RuntimeError("STORE_SCHEMA_INVALID", "execution_runs row is corrupt", {
      detail: { fields: problems },
    });
  }
  const finalPlan = row.finalPlan as ExecutionRunFinalPlanRef;
  const planningBaseline = row.planningBaseline as ExecutionRunPlanningBaseline;
  const executionStartBaseline = row.executionStartBaseline as RepositoryBaseline;
  return {
    executionRunId: row.executionRunId as string,
    runId: row.runId as string,
    workspaceId: row.workspaceId as string,
    finalPlan,
    lifecycle: row.lifecycle as ExecutionRunLifecycle,
    planningBaseline,
    executionStartBaseline,
    revision: row.revision as number,
    createdAt: row.createdAt as string,
    updatedAt: row.updatedAt as string,
  };
}

/**
 * The frozen E1 transition authority (E1 phase §12). The legal set is exactly:
 * ABSENT → prepared and prepared → active. Every other pair — including the
 * reserved terminal transitions owned by later phases — is
 * INVALID_EXECUTION_LIFECYCLE, deterministically.
 */
export function requireLegalExecutionRunTransition(
  from: ExecutionRunLifecycle | null,
  to: ExecutionRunLifecycle,
): void {
  const legal = (from === null && to === "prepared") || (from === "prepared" && to === "active");
  if (!legal) {
    throw new RuntimeError(
      "INVALID_EXECUTION_LIFECYCLE",
      `ExecutionRun lifecycle transition ${from ?? "ABSENT"} → ${to} is not authorized in this phase`,
      {
        detail: { from: from ?? "ABSENT", to },
        recoverable: false,
      },
    );
  }
}
