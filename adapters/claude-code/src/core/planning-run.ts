/**
 * PlanningRun domain shape (frozen plan §5/§6/§16).
 *
 * `revision` is the runtime/root-state optimistic-concurrency token. It is
 * NOT the future Plan Memory HEAD: HEAD Snapshot/Commit (committed planning
 * memory) is a separate concurrency domain that arrives in a later phase and
 * will coexist with this revision. Never name revision "head"/"commit"/
 * "snapshot".
 */

import { isPlanningLifecycle, isPlanningStage, type PlanningLifecycle, type PlanningStage } from "./state-machine.js";
import { RuntimeError } from "../runtime/errors.js";

export interface PlanningRun {
  runId: string;
  workspaceId: string;
  lifecycle: PlanningLifecycle;
  stage: PlanningStage;
  revision: number;
  goal: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Validate a raw database row into a PlanningRun. Illegal lifecycle/stage
 * vocabulary, non-positive revision, or an empty goal is store corruption —
 * surfaced as STORE_SCHEMA_INVALID, never smuggled into the core.
 */
/**
 * Validate a raw database row into a PlanningRun. Illegal lifecycle/stage
 * vocabulary, non-positive revision, or an empty goal is store corruption —
 * surfaced as STORE_SCHEMA_INVALID, never smuggled into the core.
 */
export function parsePlanningRunRow(row: Record<string, unknown>): PlanningRun {
  const problems: string[] = [];
  if (typeof row.runId !== "string" || row.runId === "") problems.push("run_id");
  if (typeof row.workspaceId !== "string" || row.workspaceId === "") problems.push("workspace_id");
  if (typeof row.lifecycle !== "string" || !isPlanningLifecycle(row.lifecycle)) problems.push("lifecycle");
  if (typeof row.stage !== "string" || !isPlanningStage(row.stage)) problems.push("stage");
  if (typeof row.revision !== "number" || !Number.isInteger(row.revision) || row.revision < 1) problems.push("revision");
  if (typeof row.goal !== "string" || row.goal.trim() === "") problems.push("goal");
  if (typeof row.createdAt !== "string" || row.createdAt === "") problems.push("created_at");
  if (typeof row.updatedAt !== "string" || row.updatedAt === "") problems.push("updated_at");
  if (problems.length > 0) {
    throw new RuntimeError("STORE_SCHEMA_INVALID", "planning_runs row is corrupt", {
      detail: { fields: problems },
    });
  }
  const lifecycle = row.lifecycle as PlanningLifecycle;
  const stage = row.stage as PlanningStage;
  if (lifecycle === "completed" && stage !== "final") {
    throw new RuntimeError("STORE_SCHEMA_INVALID", "completed run must be at stage final", {
      detail: { runId: row.runId, stage },
    });
  }
  return {
    runId: row.runId as string,
    workspaceId: row.workspaceId as string,
    lifecycle,
    stage,
    revision: row.revision as number,
    goal: row.goal as string,
    createdAt: row.createdAt as string,
    updatedAt: row.updatedAt as string,
  };
}
