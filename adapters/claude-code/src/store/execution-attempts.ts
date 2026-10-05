/**
 * ExecutionAttempt persistence (v0.2.0 E4 §17–§22).
 *
 * Cardinality laws are DDL-enforced (migration 017), never commented into
 * existence:
 *
 *   AT-01  one logical Attempt per EXACT Directive revision
 *          (UNIQUE(directive_id, directive_revision)) — a retried transport
 *          can never fabricate a second logical Attempt (E4 §17)
 *   AT-02  at most ONE state=running Attempt per run (partial unique index) —
 *          no concurrent logical Workers in v0.2.0 (E4 §18)
 *   AT-03  attempt identity (which exact revision/role it runs, when it
 *          started) is immutable; only state/ended_at move, and ONLY through
 *          the Core conditional transitions here — there is no generic
 *          attempt-state setter (E4 §21)
 *   AT-04  no delete
 */

import {
  parseExecutionAttemptRow,
  requireLegalExecutionAttemptTransition,
  type ExecutionAttempt,
  type WorkerRole,
} from "../core/execution-attempt.js";
import { RuntimeError } from "../runtime/errors.js";
import type { StoreTx } from "./transaction.js";

const ATTEMPT_COLUMNS =
  "attempt_id AS attemptId, execution_run_id AS executionRunId, directive_id AS directiveId, "
  + "directive_revision AS directiveRevision, directive_hash AS directiveHash, "
  + "worker_role AS workerRole, state, started_at AS startedAt, ended_at AS endedAt";

function attemptError(
  code:
    | "ATTEMPT_ALREADY_RUNNING"
    | "ATTEMPT_NOT_RUNNING"
    | "ATTEMPT_ALREADY_REPORTED"
    | "ATTEMPT_INDETERMINATE"
    | "INVALID_ATTEMPT_TRANSITION"
    | "DIRECTIVE_ALREADY_ATTEMPTED"
    | "DIRECTIVE_NOT_CURRENT"
    | "ATTEMPT_ROLE_INVALID",
  message: string,
  detail?: Record<string, unknown>,
): RuntimeError {
  return new RuntimeError(code, message, { detail, recoverable: false });
}

function mapAttemptRow(raw: Record<string, unknown>): ExecutionAttempt {
  return parseExecutionAttemptRow(raw);
}

export function getExecutionAttemptInTx(tx: StoreTx, attemptId: string): ExecutionAttempt | null {
  const raw = tx
    .prepare(`SELECT ${ATTEMPT_COLUMNS} FROM execution_attempts WHERE attempt_id = ?`)
    .get(attemptId) as Record<string, unknown> | undefined;
  return raw === undefined ? null : mapAttemptRow(raw);
}

export function getAttemptForDirectiveInTx(
  tx: StoreTx,
  directiveId: string,
  directiveRevision: number,
): ExecutionAttempt | null {
  const raw = tx
    .prepare(
      `SELECT ${ATTEMPT_COLUMNS} FROM execution_attempts WHERE directive_id = ? AND directive_revision = ?`,
    )
    .get(directiveId, directiveRevision) as Record<string, unknown> | undefined;
  return raw === undefined ? null : mapAttemptRow(raw);
}

export function getRunningAttemptInTx(tx: StoreTx, executionRunId: string): ExecutionAttempt | null {
  const raw = tx
    .prepare(`SELECT ${ATTEMPT_COLUMNS} FROM execution_attempts WHERE execution_run_id = ? AND state = 'running'`)
    .get(executionRunId) as Record<string, unknown> | undefined;
  return raw === undefined ? null : mapAttemptRow(raw);
}

/** The run's attempts, newest started first (recovery projection input). */
export function listRunAttemptsInTx(tx: StoreTx, executionRunId: string): ExecutionAttempt[] {
  return (tx
    .prepare(`SELECT ${ATTEMPT_COLUMNS} FROM execution_attempts WHERE execution_run_id = ? ORDER BY started_at DESC, attempt_id DESC`)
    .all(executionRunId) as Record<string, unknown>[]).map(mapAttemptRow);
}

/**
 * E6 §9/§27 — every Attempt whose Directive belongs to the given Window, in
 * deterministic protocol order (oldest started first). The current-candidate
 * and complete-provenance enumerations both derive from this list.
 */
export function listWindowAttemptsInTx(tx: StoreTx, windowId: string): ExecutionAttempt[] {
  return (tx
    .prepare(
      `SELECT a.attempt_id AS attemptId, a.execution_run_id AS executionRunId, a.directive_id AS directiveId, `
      + "a.directive_revision AS directiveRevision, a.directive_hash AS directiveHash, "
      + "a.worker_role AS workerRole, a.state, a.started_at AS startedAt, a.ended_at AS endedAt "
      + "FROM execution_attempts a JOIN execution_directives d ON d.directive_id = a.directive_id "
      + "AND d.revision = a.directive_revision WHERE d.window_id = ? ORDER BY a.started_at, a.attempt_id",
    )
    .all(windowId) as Record<string, unknown>[]).map(mapAttemptRow);
}

/** E4 §20 — the frozen role/kind consistency rule; inspection is deliberately unconstrained. */
export function requireAttemptRoleConsistency(kind: string, workerRole: WorkerRole): void {
  if (kind === "implementation" && workerRole === "verifier") {
    throw attemptError(
      "ATTEMPT_ROLE_INVALID",
      "an implementation Directive cannot run as the verifier role",
      { kind, workerRole },
    );
  }
  if (kind === "verification" && workerRole !== "verifier") {
    throw attemptError(
      "ATTEMPT_ROLE_INVALID",
      "a verification Directive must run as the verifier role",
      { kind, workerRole },
    );
  }
}

/**
 * Create the ONE logical running Attempt for an exact Directive revision
 * (E4 §19 start gate): the directive must exist with the exact hash, still be
 * fresh (run active, stage active, window open, base candidate revision
 * current), never attempted before, role-consistent, and uncontended. The
 * conditional INSERT plus the two unique indexes make duplicates impossible at
 * the DDL level.
 */
export function insertRunningExecutionAttemptInTx(
  tx: StoreTx,
  input: {
    executionRunId: string;
    attemptId: string;
    directiveId: string;
    directiveRevision: number;
    directiveHash: string;
    workerRole: WorkerRole;
    /** The Directive's authority context, re-verified against current state. */
    directiveStageId: string | null;
    directiveScopeKind: "stage" | "final_closure";
    directiveWindowId: string;
    directiveBaseCandidateRevision: number;
    directiveKind: string;
  },
  now: string,
): ExecutionAttempt {
  const run = tx
    .prepare("SELECT lifecycle FROM execution_runs WHERE execution_run_id = ?")
    .get(input.executionRunId) as { lifecycle: string } | undefined;
  if (run === undefined || run.lifecycle !== "active") {
    throw attemptError(
      "DIRECTIVE_NOT_CURRENT",
      `ExecutionRun '${input.executionRunId}' is ${run?.lifecycle ?? "missing"}; attempts start only on an active run`,
      { executionRunId: input.executionRunId, lifecycle: run?.lifecycle ?? null },
    );
  }
  if (input.directiveScopeKind !== "final_closure") {
    // E10 — a stage-scoped Directive re-verifies its Stage's liveness; a
    // final-closure Directive has no Stage and binds only the open window.
    const stage = tx
      .prepare("SELECT status FROM execution_stages WHERE id = ?")
      .get(input.directiveStageId) as { status: string } | undefined;
    if (stage === undefined || stage.status !== "active") {
      throw attemptError(
        "DIRECTIVE_NOT_CURRENT",
        `directive stage '${input.directiveStageId}' is ${stage?.status ?? "missing"}; no longer the active stage`,
        { stageId: input.directiveStageId, status: stage?.status ?? null },
      );
    }
  }
  const window = tx
    .prepare(
      "SELECT candidate_revision AS candidateRevision FROM verification_windows "
      + "WHERE id = ? AND closed_at IS NULL",
    )
    .get(input.directiveWindowId) as { candidateRevision: number } | undefined;
  if (window === undefined) {
    throw attemptError(
      "DIRECTIVE_NOT_CURRENT",
      `directive window '${input.directiveWindowId}' is closed or missing`,
      { windowId: input.directiveWindowId },
    );
  }
  if (window.candidateRevision !== input.directiveBaseCandidateRevision) {
    throw attemptError(
      "DIRECTIVE_NOT_CURRENT",
      `directive base candidate revision ${input.directiveBaseCandidateRevision} is stale; current window revision is ${window.candidateRevision}`,
      { base: input.directiveBaseCandidateRevision, detected: window.candidateRevision },
    );
  }
  requireAttemptRoleConsistency(input.directiveKind, input.workerRole);
  const existing = getAttemptForDirectiveInTx(tx, input.directiveId, input.directiveRevision);
  if (existing !== null) {
    throw attemptError(
      "DIRECTIVE_ALREADY_ATTEMPTED",
      `directive '${input.directiveId}@${input.directiveRevision}' was already attempted ('${existing.attemptId}')`,
      { directiveId: input.directiveId, revision: input.directiveRevision, attemptId: existing.attemptId },
    );
  }
  const running = getRunningAttemptInTx(tx, input.executionRunId);
  if (running !== null) {
    throw attemptError(
      "ATTEMPT_ALREADY_RUNNING",
      `ExecutionRun '${input.executionRunId}' already has a running attempt ('${running.attemptId}')`,
      { executionRunId: input.executionRunId, runningAttemptId: running.attemptId },
    );
  }
  requireLegalExecutionAttemptTransition(null, "running");
  tx.prepare(
    `INSERT INTO execution_attempts (
       attempt_id, execution_run_id, directive_id, directive_revision, directive_hash,
       worker_role, state, started_at, ended_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, NULL)`,
  ).run(
    input.attemptId,
    input.executionRunId,
    input.directiveId,
    input.directiveRevision,
    input.directiveHash,
    input.workerRole,
    now,
  );
  return getExecutionAttemptInTx(tx, input.attemptId) as ExecutionAttempt;
}

/**
 * running → reported (E4 §18/§24), Core-owned conditional transition. The
 * caller persists the Report in the SAME transaction; nothing else may move a
 * running Attempt to reported.
 */
export function markAttemptReportedInTx(tx: StoreTx, attemptId: string, now: string): ExecutionAttempt {
  const attempt = getExecutionAttemptInTx(tx, attemptId);
  if (attempt === null) {
    throw attemptError("ATTEMPT_NOT_RUNNING", `no ExecutionAttempt exists for '${attemptId}'`, { attemptId });
  }
  requireLegalExecutionAttemptTransition(attempt.state, "reported");
  const updated = tx
    .prepare("UPDATE execution_attempts SET state = 'reported', ended_at = ? WHERE attempt_id = ? AND state = 'running'")
    .run(now, attemptId) as { changes?: number | bigint };
  if (Number(updated.changes ?? 0) !== 1) {
    throw attemptError("ATTEMPT_NOT_RUNNING", `attempt '${attemptId}' raced a concurrent transition`, { attemptId });
  }
  return getExecutionAttemptInTx(tx, attemptId) as ExecutionAttempt;
}

/**
 * running → indeterminate (E4 §22) — the internal crash-recovery primitive.
 * It records only the durable fact that the attempt's outcome is unknown; it
 * creates NO report, replays nothing, rolls nothing back. Session disconnects
 * must NOT call this (a Worker may legally continue after its Supervisor
 * detaches) — E5's runtime decides genuine liveness.
 */
export function markAttemptIndeterminateInTx(tx: StoreTx, attemptId: string, now: string): ExecutionAttempt {
  const attempt = getExecutionAttemptInTx(tx, attemptId);
  if (attempt === null) {
    throw attemptError("ATTEMPT_NOT_RUNNING", `no ExecutionAttempt exists for '${attemptId}'`, { attemptId });
  }
  requireLegalExecutionAttemptTransition(attempt.state, "indeterminate");
  const updated = tx
    .prepare("UPDATE execution_attempts SET state = 'indeterminate', ended_at = ? WHERE attempt_id = ? AND state = 'running'")
    .run(now, attemptId) as { changes?: number | bigint };
  if (Number(updated.changes ?? 0) !== 1) {
    throw attemptError("ATTEMPT_NOT_RUNNING", `attempt '${attemptId}' raced a concurrent transition`, { attemptId });
  }
  return getExecutionAttemptInTx(tx, attemptId) as ExecutionAttempt;
}
