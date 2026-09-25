/**
 * PlanningRun persistence (frozen plan §38/§39). SQL lives HERE; the core
 * state machine never touches SQL and the application layer never writes SQL
 * strings. Rows are mapped through the validating parser so illegal database
 * state becomes STORE_SCHEMA_INVALID before it can reach the core.
 */

import { parsePlanningRunRow, type PlanningRun } from "../core/planning-run.js";
import { INITIAL_RUN_STATE } from "../core/state-machine.js";
import { RuntimeError } from "../runtime/errors.js";
import type { StoreClock } from "./migration-runner.js";
import type { PlanStore } from "./sqlite-store.js";

export function runStateError(
  code: "RUN_NOT_FOUND" | "RUN_TERMINAL" | "INVALID_RUN_TRANSITION" | "STALE_RUN_REVISION" | "INVALID_RUN_GOAL",
  message: string,
  detail?: Record<string, unknown>,
): RuntimeError {
  return new RuntimeError(code, message, { detail, recoverable: false });
}

const RUN_COLUMNS =
  "run_id AS runId, workspace_id AS workspaceId, lifecycle, stage, revision, goal, created_at AS createdAt, updated_at AS updatedAt";

export interface CreatePlanningRunRecordInput {
  runId: string;
  workspaceId: string;
  goal: string;
}

/** Insert a deterministic active/discovery/revision-1 run. Caller owns the tx. */
export function insertPlanningRunRecord(
  tx: { prepare(sql: string): { run(...params: unknown[]): unknown } },
  input: CreatePlanningRunRecordInput,
  clock: StoreClock,
): PlanningRun {
  const now = clock.nowIso();
  tx.prepare(
    "INSERT INTO planning_runs (run_id, workspace_id, lifecycle, stage, revision, goal, created_at, updated_at) VALUES (?, ?, 'active', 'discovery', 1, ?, ?, ?)",
  ).run(input.runId, input.workspaceId, input.goal, now, now);
  return {
    runId: input.runId,
    workspaceId: input.workspaceId,
    ...INITIAL_RUN_STATE,
    goal: input.goal,
    createdAt: now,
    updatedAt: now,
  };
}

export function getPlanningRunRecord(store: PlanStore, runId: string): PlanningRun | null {
  return store.withRead((tx) => {
    const row = tx.prepare(`SELECT ${RUN_COLUMNS} FROM planning_runs WHERE run_id = ?`).get(runId) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? null : parsePlanningRunRow(row);
  });
}

export function getPlanningRunForSessionRecord(
  store: PlanStore,
  sessionId: string,
): PlanningRun | null {
  return store.withRead((tx) => {
    const row = tx
      .prepare(
        `SELECT ${RUN_COLUMNS} FROM planning_runs r JOIN session_bindings b ON b.run_id = r.run_id WHERE b.session_id = ? AND b.state = 'attached'`,
      )
      .get(sessionId) as Record<string, unknown> | undefined;
    return row === undefined ? null : parsePlanningRunRow(row);
  });
}

export function listPlanningRunsForWorkspaceRecord(
  store: PlanStore,
  workspaceId: string,
  options: { lifecycle?: PlanningRun["lifecycle"] } = {},
): PlanningRun[] {
  return store.withRead((tx) => {
    const rows = (
      options.lifecycle === undefined
        ? tx
            .prepare(`SELECT ${RUN_COLUMNS} FROM planning_runs WHERE workspace_id = ? ORDER BY created_at, run_id`)
            .all(workspaceId)
        : tx
            .prepare(
              `SELECT ${RUN_COLUMNS} FROM planning_runs WHERE workspace_id = ? AND lifecycle = ? ORDER BY created_at, run_id`,
            )
            .all(workspaceId, options.lifecycle)
    ) as Record<string, unknown>[];
    return rows.map(parsePlanningRunRow);
  });
}

export function runStateDetail(run: PlanningRun): Record<string, unknown> {
  return {
    runId: run.runId,
    workspaceId: run.workspaceId,
    lifecycle: run.lifecycle,
    stage: run.stage,
    revision: run.revision,
  };
}
