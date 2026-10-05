/**
 * ExecutionAttempt domain shape (v0.2.0 architecture spec, E4 §16–§22).
 *
 * PURE core: vocabulary, canonical shape, row validation, frozen transition
 * authority. No SQLite, no host, no MCP.
 *
 * An ExecutionAttempt is ONE logical execution of ONE exact Directive revision.
 * It permanently binds that revision AND its hash (E4 §16) — never "the latest
 * revision". One exact Directive revision has AT MOST one logical Attempt
 * (E4 §17) and at most one Attempt per ExecutionRun is ever state=running
 * (E4 §18); both cardinalities are DDL-enforced (migration 017).
 *
 * Legal E4 transitions (E4 §21):
 *
 *   ABSENT   → running
 *   running  → reported       (with the one immutable ExecutionReport)
 *   running  → indeterminate  (future crash recovery; NO report fabricated)
 *
 * reported / indeterminate are TERMINAL. retry/restarted/failed/blocked do not
 * exist as Attempt states — they live in the Report result vocabulary or in a
 * new Directive revision. There is no generic attempt-state setter.
 */

import { RuntimeError } from "../runtime/errors.js";

export const WORKER_ROLES = ["executor", "verifier"] as const;

export type WorkerRole = (typeof WORKER_ROLES)[number];

export function isWorkerRole(value: string): value is WorkerRole {
  return (WORKER_ROLES as readonly string[]).includes(value);
}

export const EXECUTION_ATTEMPT_STATES = ["running", "reported", "indeterminate"] as const;

export type ExecutionAttemptState = (typeof EXECUTION_ATTEMPT_STATES)[number];

export function isExecutionAttemptState(value: string): value is ExecutionAttemptState {
  return (EXECUTION_ATTEMPT_STATES as readonly string[]).includes(value);
}

export interface ExecutionAttempt {
  attemptId: string;
  /** The ExecutionRun this attempt executes under (execution_runs.execution_run_id). */
  executionRunId: string;
  directiveId: string;
  directiveRevision: number;
  /** The EXACT Directive revision hash — never resolved to "latest" later. */
  directiveHash: string;
  workerRole: WorkerRole;
  state: ExecutionAttemptState;
  startedAt: string;
  endedAt: string | null;
}

/**
 * Validate a raw database row into an ExecutionAttempt. Illegal vocabulary or
 * broken identity is store corruption — STORE_SCHEMA_INVALID.
 */
export function parseExecutionAttemptRow(row: Record<string, unknown>): ExecutionAttempt {
  const problems: string[] = [];
  if (typeof row.attemptId !== "string" || row.attemptId === "") problems.push("attempt_id");
  if (typeof row.executionRunId !== "string" || row.executionRunId === "") problems.push("execution_run_id");
  if (typeof row.directiveId !== "string" || row.directiveId === "") problems.push("directive_id");
  if (
    typeof row.directiveRevision !== "number" || !Number.isInteger(row.directiveRevision) || row.directiveRevision < 1
  ) {
    problems.push("directive_revision");
  }
  if (typeof row.directiveHash !== "string" || row.directiveHash === "") problems.push("directive_hash");
  if (typeof row.workerRole !== "string" || !isWorkerRole(row.workerRole)) problems.push("worker_role");
  if (typeof row.state !== "string" || !isExecutionAttemptState(row.state)) problems.push("state");
  if (typeof row.startedAt !== "string" || row.startedAt === "") problems.push("started_at");
  if (row.endedAt !== null && typeof row.endedAt !== "string") problems.push("ended_at");
  if (problems.length > 0) {
    throw new RuntimeError("STORE_SCHEMA_INVALID", "execution_attempts row is corrupt", {
      detail: { fields: problems },
    });
  }
  return {
    attemptId: row.attemptId as string,
    executionRunId: row.executionRunId as string,
    directiveId: row.directiveId as string,
    directiveRevision: row.directiveRevision as number,
    directiveHash: row.directiveHash as string,
    workerRole: row.workerRole as WorkerRole,
    state: row.state as ExecutionAttemptState,
    startedAt: row.startedAt as string,
    endedAt: row.endedAt as string | null,
  };
}

/**
 * The frozen E4 transition authority (E4 §21). Legal set exactly:
 * ABSENT → running, running → reported, running → indeterminate. Every other
 * pair — including terminal revivals and terminal ↔ terminal moves — is
 * INVALID_ATTEMPT_TRANSITION, deterministically.
 */
export function requireLegalExecutionAttemptTransition(
  from: ExecutionAttemptState | null,
  to: ExecutionAttemptState,
): void {
  const legal =
    (from === null && to === "running")
    || (from === "running" && (to === "reported" || to === "indeterminate"));
  if (!legal) {
    throw new RuntimeError(
      "INVALID_ATTEMPT_TRANSITION",
      `ExecutionAttempt state transition ${from ?? "ABSENT"} → ${to} is not authorized`,
      { detail: { from: from ?? "ABSENT", to }, recoverable: false },
    );
  }
}
