/**
 * ExecutionStage domain shape (v0.2.0 architecture spec §13, E3 §4–§11).
 *
 * PURE core: vocabulary, canonical shape, row validation. No SQLite, no host,
 * no MCP.
 *
 * An ExecutionStage is a durable EXECUTION-decomposition object under one
 * ExecutionRun — Execution Memory, never Plan Memory (E3 §5): materializing or
 * activating a Stage must not mutate FinalPlan/Architecture/Section/Decision/
 * Constraint/PlanCommit rows.
 *
 * The status vocabulary is the complete frozen set NOW, but E3's only ordinary
 * progress transition is pending → active (deterministic bootstrap or, in
 * later phases, a Supervisor request validated by Core). Stage COMPLETION
 * requires a future accepted ExecutionCommit — E3 provides no path that sets
 * it, and `superseded` exists purely as frozen vocabulary for later Supervisor
 * refinement (E3 §11).
 *
 * Ordering semantics (E3 §8): `ordinal` is the DEFAULT execution sequence
 * derived from the approved FinalPlan implementation order; `dependsOn` holds
 * the EXPLICIT mandatory predecessor step ids approved in that same order.
 * Default order is never promoted into a fake hard dependency.
 */

import { RuntimeError } from "../runtime/errors.js";

export const EXECUTION_STAGE_STATUSES = ["pending", "active", "completed", "superseded"] as const;

export type ExecutionStageStatus = (typeof EXECUTION_STAGE_STATUSES)[number];

export function isExecutionStageStatus(value: string): value is ExecutionStageStatus {
  return (EXECUTION_STAGE_STATUSES as readonly string[]).includes(value);
}

/** True only for the statuses that satisfy a mandatory predecessor (E3 §27). */
export function isSatisfyingStageStatus(status: ExecutionStageStatus): boolean {
  return status === "completed";
}

/** One exact approved plan reference carried as stage provenance (E3 §7). */
export interface ExecutionStageSourceRef {
  kind: string;
  id: string;
  revision: number;
}

export interface ExecutionStage {
  id: string;
  /** The ExecutionRun this stage decomposes (execution_runs.execution_run_id). */
  executionRunId: string;
  /** 1..N deterministic default position from the FinalPlan implementation order. */
  ordinal: number;
  status: ExecutionStageStatus;
  objective: string;
  /** The exact approved ImplementationStep this stage materialized (if any). */
  sourceStepId: string | null;
  /** Explicit MANDATORY predecessor step ids from the approved FinalPlan. */
  dependsOn: string[];
  /** Exact approved plan refs backing this stage's provenance. */
  sourceRefs: ExecutionStageSourceRef[];
  /**
   * E7 §12 — the exact ExecutionCommit whose satisfied obligations completed
   * this Stage. Null for every non-completed Stage; once set it never changes
   * (schema-v20 trigger), and completion is derived only inside the acceptance
   * transaction (E7 §7/§14).
   */
  completedByCommitId: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Validate a raw database row into an ExecutionStage. Illegal status
 * vocabulary, non-positive ordinal/revision, or broken provenance shape is
 * store corruption — surfaced as STORE_SCHEMA_INVALID, never smuggled into the
 * core.
 */
export function parseExecutionStageRow(row: Record<string, unknown>): ExecutionStage {
  const problems: string[] = [];
  if (typeof row.id !== "string" || row.id === "") problems.push("id");
  if (typeof row.executionRunId !== "string" || row.executionRunId === "") problems.push("execution_run_id");
  if (typeof row.ordinal !== "number" || !Number.isInteger(row.ordinal) || row.ordinal < 1) problems.push("ordinal");
  if (typeof row.status !== "string" || !isExecutionStageStatus(row.status)) problems.push("status");
  if (typeof row.objective !== "string" || row.objective === "") problems.push("objective");
  if (row.sourceStepId !== null && typeof row.sourceStepId !== "string") problems.push("source_step_id");
  if (!Array.isArray(row.dependsOn) || row.dependsOn.some((d) => typeof d !== "string")) problems.push("depends_on");
  if (!Array.isArray(row.sourceRefs)) {
    problems.push("source_refs");
  } else {
    for (const ref of row.sourceRefs) {
      if (typeof ref !== "object" || ref === null || typeof (ref as ExecutionStageSourceRef).kind !== "string" || typeof (ref as ExecutionStageSourceRef).id !== "string" || typeof (ref as ExecutionStageSourceRef).revision !== "number") {
        problems.push("source_refs");
        break;
      }
    }
  }
  if (typeof row.revision !== "number" || !Number.isInteger(row.revision) || row.revision < 1) problems.push("revision");
  if (row.completedByCommitId !== null && typeof row.completedByCommitId !== "string") problems.push("completed_by_commit_id");
  if (typeof row.createdAt !== "string" || row.createdAt === "") problems.push("created_at");
  if (typeof row.updatedAt !== "string" || row.updatedAt === "") problems.push("updated_at");
  if (problems.length > 0) {
    throw new RuntimeError("STORE_SCHEMA_INVALID", "execution_stages row is corrupt", {
      detail: { fields: problems },
    });
  }
  return {
    id: row.id as string,
    executionRunId: row.executionRunId as string,
    ordinal: row.ordinal as number,
    status: row.status as ExecutionStageStatus,
    objective: row.objective as string,
    sourceStepId: row.sourceStepId as string | null,
    dependsOn: row.dependsOn as string[],
    sourceRefs: row.sourceRefs as ExecutionStageSourceRef[],
    completedByCommitId: (row.completedByCommitId as string | null) ?? null,
    revision: row.revision as number,
    createdAt: row.createdAt as string,
    updatedAt: row.updatedAt as string,
  };
}
