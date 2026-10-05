/**
 * ExecutionAbort provenance store (v0.2.0 E13 §14/§15/§59).
 *
 * `execution_abort_records` is AUDIT provenance, never accepted progress: one
 * row per aborted ExecutionRun (PRIMARY KEY execution_run_id — E13 §15 "exactly one
 * abort fact"), bound to the EXACTLY ONE consumed run-control authorization
 * (UNIQUE control_id → run_control_authorizations, operation='abort' — E13
 * §59). The migration's append-only triggers make the fact immutable.
 *
 * Written ONLY by the human-authorized abort transaction, read by the schema
 * validator and the recovery renderer.
 */

import type { StoreTx } from "./transaction.js";
import { RuntimeError } from "../runtime/errors.js";

export interface ExecutionAbortRecord {
  executionRunId: string;
  controlId: string;
  requestedBySessionId: string;
  reason: string;
  acceptedHeadCommitId: string | null;
  activeStageId: string | null;
  openWindowId: string | null;
  activeAttemptId: string | null;
  createdAt: string;
}

export interface InsertExecutionAbortRecordInput {
  executionRunId: string;
  /** A1 §16 — source PlanningRun provenance (execution_runs.run_id). */
  runId: string;
  controlId: string;
  requestedBySessionId: string;
  reason: string;
  acceptedHeadCommitId: string | null;
  activeStageId: string | null;
  openWindowId: string | null;
  activeAttemptId: string | null;
}

export function insertExecutionAbortRecordInTx(
  tx: StoreTx,
  input: InsertExecutionAbortRecordInput,
  now: string,
): ExecutionAbortRecord {
  try {
    tx.prepare(
      "INSERT INTO execution_abort_records (execution_run_id, run_id, control_id, requested_by_session_id, reason, "
      + "accepted_head_commit_id, active_stage_id, open_window_id, active_attempt_id, created_at) "
      + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      input.executionRunId,
      input.runId,
      input.controlId,
      input.requestedBySessionId,
      input.reason,
      input.acceptedHeadCommitId,
      input.activeStageId,
      input.openWindowId,
      input.activeAttemptId,
      now,
    );
  } catch (err) {
    // The PK(execution_run_id) is the structural §15 fence: a second abort fact for the
    // same run can never exist. The abort service's lifecycle gate makes this
    // unreachable in production; it fails closed here regardless.
    throw new RuntimeError(
      "RUN_TERMINAL",
      `ExecutionRun '${input.executionRunId}' already carries an abort fact (E13 §15)`,
      { cause: err instanceof Error ? err.message : String(err), recoverable: false },
    );
  }
  return {
    ...input,
    createdAt: now,
  };
}

const ABORT_COLUMNS =
  "execution_run_id AS executionRunId, control_id AS controlId, requested_by_session_id AS requestedBySessionId, reason, "
  + "accepted_head_commit_id AS acceptedHeadCommitId, active_stage_id AS activeStageId, "
  + "open_window_id AS openWindowId, active_attempt_id AS activeAttemptId, created_at AS createdAt";

export function getExecutionAbortRecordInTx(tx: StoreTx, executionRunId: string): ExecutionAbortRecord | null {
  const raw = tx
    .prepare(`SELECT ${ABORT_COLUMNS} FROM execution_abort_records WHERE execution_run_id = ?`)
    .get(executionRunId) as Record<string, unknown> | undefined;
  return raw === undefined ? null : (raw as unknown as ExecutionAbortRecord);
}

/** Whether ANY abort fact exists (schema-validator / guard helper). */
export function hasExecutionAbortRecordInTx(tx: StoreTx, executionRunId: string): boolean {
  return (
    tx.prepare("SELECT 1 AS x FROM execution_abort_records WHERE execution_run_id = ?").get(executionRunId) !== undefined
  );
}
