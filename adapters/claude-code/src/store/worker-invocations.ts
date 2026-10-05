/**
 * WorkerInvocationBinding persistence (v0.2.0 E5 §45/§46/§47).
 *
 * Cardinality and identity laws are DDL-enforced (migration 018):
 *
 *   WI-01  ONE invocation binding per Attempt (PRIMARY KEY(attempt_id))
 *   WI-02  attempt/run/role identity immutable; launch token stored only as a
 *          sha256 hash (never plaintext)
 *   WI-03  the claimed worker session is set AT MOST ONCE and never moved
 *          (partial-update trigger)
 *   WI-04  a finished invocation can never return to claimed/prepared
 *          (terminal trigger)
 *   WI-05  at most ONE claimed invocation per worker session (partial unique
 *          index) — one claimed session owns at most its exact Attempt
 *          authority (E5 §46, preferred v0.2.0 shape)
 *   WI-06  no delete
 *
 * State transitions move ONLY through the Core conditional transitions here.
 * This is runtime correlation, never a second authoritative work lifecycle
 * (E5 §47) — Attempt remains running/reported/indeterminate.
 */

import { parseWorkerInvocationRow, requireLegalWorkerInvocationTransition, type WorkerInvocationBinding } from "../core/worker-invocation.js";
import { createHash, randomUUID } from "node:crypto";
import { RuntimeError } from "../runtime/errors.js";
import type { StoreTx } from "./transaction.js";

const INVOCATION_COLUMNS =
  "attempt_id AS attemptId, execution_run_id AS executionRunId, worker_role AS workerRole, state, "
  + "worker_session_id AS workerSessionId, worker_agent_id AS workerAgentId, "
  + "launch_token_hash AS launchTokenHash, created_at AS createdAt, "
  + "claimed_at AS claimedAt, finished_at AS finishedAt";

/** sha256 of a launch token — the only form ever persisted (E5 §9/§46). */
export function hashLaunchToken(token: string): string {
  return `sha256:${createHash("sha256").update(token, "utf8").digest("hex")}`;
}

function invocationError(
  code:
    | "WORKER_LAUNCH_INVALID"
    | "WORKER_CLAIM_TOKEN_INVALID"
    | "WORKER_ATTEMPT_ALREADY_CLAIMED"
    | "WORKER_SESSION_MISMATCH"
    | "WORKER_AUTHORITY_REQUIRED"
    | "WORKER_INVOCATION_FINISHED"
    | "ATTEMPT_NOT_RUNNING"
    | "INVALID_WORKER_INVOCATION_TRANSITION"
    | "WORKER_LAUNCH_RETRY_NOT_ALLOWED"
    | "INVALID_EXECUTION_LIFECYCLE",
  message: string,
  detail?: Record<string, unknown>,
): RuntimeError {
  return new RuntimeError(code, message, { detail, recoverable: false });
}

function mapInvocationRow(raw: Record<string, unknown>): WorkerInvocationBinding {
  return parseWorkerInvocationRow(raw);
}

export function getWorkerInvocationInTx(tx: StoreTx, attemptId: string): WorkerInvocationBinding | null {
  const raw = tx
    .prepare(`SELECT ${INVOCATION_COLUMNS} FROM execution_worker_invocations WHERE attempt_id = ?`)
    .get(attemptId) as Record<string, unknown> | undefined;
  return raw === undefined ? null : mapInvocationRow(raw);
}

/** The claimed invocation of a worker session (there is at most one). */
export function getClaimedInvocationForSessionInTx(tx: StoreTx, workerSessionId: string): WorkerInvocationBinding | null {
  const raw = tx
    .prepare(
      `SELECT ${INVOCATION_COLUMNS} FROM execution_worker_invocations WHERE worker_session_id = ? AND state = 'claimed'`,
    )
    .get(workerSessionId) as Record<string, unknown> | undefined;
  return raw === undefined ? null : mapInvocationRow(raw);
}

/**
 * The session's claimed-or-finished invocation (its own history). Used by the
 * authority chain to distinguish "no authority" (WORKER_AUTHORITY_REQUIRED)
 * from "authority consumed" (WORKER_INVOCATION_FINISHED).
 */
export function getOwnInvocationForSessionInTx(tx: StoreTx, workerSessionId: string): WorkerInvocationBinding | null {
  const raw = tx
    .prepare(
      `SELECT ${INVOCATION_COLUMNS} FROM execution_worker_invocations WHERE worker_session_id = ? AND state IN ('claimed', 'finished') `
      + "ORDER BY claimed_at DESC, attempt_id DESC LIMIT 1",
    )
    .get(workerSessionId) as Record<string, unknown> | undefined;
  return raw === undefined ? null : mapInvocationRow(raw);
}

export function listRunWorkerInvocationsInTx(tx: StoreTx, executionRunId: string): WorkerInvocationBinding[] {
  return (tx
    .prepare(`SELECT ${INVOCATION_COLUMNS} FROM execution_worker_invocations WHERE execution_run_id = ? ORDER BY created_at, attempt_id`)
    .all(executionRunId) as Record<string, unknown>[]).map(mapInvocationRow);
}

/**
 * Create the ONE prepared invocation binding for an exact running Attempt
 * (E5 §9). The plaintext token never reaches this layer — callers pass the
 * hash. The attempt must exist, belong to the run, and still be running.
 */
export function insertPreparedWorkerInvocationInTx(
  tx: StoreTx,
  input: {
    attemptId: string;
    executionRunId: string;
    workerRole: "executor" | "verifier";
    launchTokenHash: string;
    /** The directive revision/hash the launch binds (verified against store). */
    directiveId: string;
    directiveRevision: number;
    directiveHash: string;
  },
  now: string,
): void {
  const attempt = tx
    .prepare("SELECT execution_run_id AS executionRunId, directive_id AS directiveId, directive_revision AS directiveRevision, directive_hash AS directiveHash, worker_role AS workerRole, state FROM execution_attempts WHERE attempt_id = ?")
    .get(input.attemptId) as Record<string, unknown> | undefined;
  if (attempt === undefined) {
    throw invocationError("WORKER_LAUNCH_INVALID", `no ExecutionAttempt exists for '${input.attemptId}'`, {
      attemptId: input.attemptId,
    });
  }
  if (attempt.state !== "running") {
    throw invocationError("WORKER_LAUNCH_INVALID", `attempt '${input.attemptId}' is ${String(attempt.state)}; only a running attempt can be launched`, {
      attemptId: input.attemptId,
      state: String(attempt.state),
    });
  }
  if (
    attempt.executionRunId !== input.executionRunId
    || attempt.directiveId !== input.directiveId
    || attempt.directiveRevision !== input.directiveRevision
    || attempt.directiveHash !== input.directiveHash
    || attempt.workerRole !== input.workerRole
  ) {
    throw invocationError(
      "WORKER_LAUNCH_INVALID",
      `launch does not bind the exact attempt identity of '${input.attemptId}'`,
      { attemptId: input.attemptId },
    );
  }
  const existing = getWorkerInvocationInTx(tx, input.attemptId);
  if (existing !== null) {
    // E5 §11 — a re-launch of the SAME prepared (unclaimed) invocation with
    // the same ticket is host transport retry and resolves to the same
    // binding, never a duplicate.
    if (
      existing.state === "prepared"
      && existing.launchTokenHash === input.launchTokenHash
      && existing.workerRole === input.workerRole
      && existing.executionRunId === input.executionRunId
    ) {
      return;
    }
    throw invocationError(
      existing.state === "claimed" ? "WORKER_ATTEMPT_ALREADY_CLAIMED" : "WORKER_LAUNCH_INVALID",
      `attempt '${input.attemptId}' already has a ${existing.state} invocation binding`,
      { attemptId: input.attemptId, state: existing.state },
    );
  }
  requireLegalWorkerInvocationTransition(null, "prepared");
  tx.prepare(
    `INSERT INTO execution_worker_invocations (
       attempt_id, execution_run_id, worker_role, state, worker_session_id, worker_agent_id,
       launch_token_hash, created_at, claimed_at, finished_at
     ) VALUES (?, ?, ?, 'prepared', NULL, NULL, ?, ?, NULL, NULL)`,
  ).run(input.attemptId, input.executionRunId, input.workerRole, input.launchTokenHash, now);
  insertInvocationEventInTx(tx, { attemptId: input.attemptId, eventType: "PREPARED" }, now);
}

/**
 * prepared → claimed (E5 §10): verify attempt running + binding prepared +
 * token hash + role; then atomically bind the authoritative worker session
 * (from the signed HostContext, never a model argument) and consume the
 * token. A second session can never claim (PK + claimed-state check + DDL).
 */
export function claimWorkerInvocationInTx(
  tx: StoreTx,
  input: { attemptId: string; launchToken: string; workerSessionId: string; workerAgentId: string; workspaceId: string; executionRunId: string },
  now: string,
): WorkerInvocationBinding {
  const binding = getWorkerInvocationInTx(tx, input.attemptId);
  if (binding === null) {
    throw invocationError("WORKER_CLAIM_TOKEN_INVALID", `no worker invocation exists for attempt '${input.attemptId}'`, {
      attemptId: input.attemptId,
    });
  }
  if (binding.executionRunId !== input.executionRunId) {
    throw invocationError("WORKER_SESSION_MISMATCH", "the attempt belongs to a different execution run", {
      expected: binding.executionRunId,
      detected: input.executionRunId,
    });
  }
  if (binding.state === "claimed") {
    throw invocationError(
      "WORKER_ATTEMPT_ALREADY_CLAIMED",
      `attempt '${input.attemptId}' is already claimed by another worker session`,
      { attemptId: input.attemptId },
    );
  }
  if (binding.state === "finished") {
    throw invocationError("WORKER_INVOCATION_FINISHED", `attempt '${input.attemptId}' invocation is finished`, {
      attemptId: input.attemptId,
    });
  }
  if (binding.launchTokenHash !== hashLaunchToken(input.launchToken)) {
    throw invocationError("WORKER_CLAIM_TOKEN_INVALID", "the launch token does not match the prepared invocation", {
      attemptId: input.attemptId,
    });
  }
  const attempt = tx
    .prepare("SELECT state FROM execution_attempts WHERE attempt_id = ?")
    .get(input.attemptId) as { state: string } | undefined;
  if (attempt === undefined || attempt.state !== "running") {
    throw invocationError(
      "ATTEMPT_NOT_RUNNING",
      `attempt '${input.attemptId}' is ${attempt?.state ?? "missing"}; claims require a running attempt`,
      { attemptId: input.attemptId, state: attempt?.state ?? null },
    );
  }
  // E13 §26/§27/§47 — Run lifecycle participates in claim authorization: a
  // terminal ExecutionRun (aborted/completed/replan_required) revokes all
  // FUTURE worker authority even while the Attempt row still says running
  // (E13 §24 — the attempt row is preserved history; the terminal Run
  // lifecycle overrides protocol liveness). The prepared token of an aborted
  // run can never claim.
  const runLifecycle = tx
    .prepare("SELECT lifecycle FROM execution_runs WHERE execution_run_id = ?")
    .get(binding.executionRunId) as { lifecycle: string } | undefined;
  if (runLifecycle === undefined || runLifecycle.lifecycle !== "active") {
    throw invocationError(
      "INVALID_EXECUTION_LIFECYCLE",
      `execution run '${binding.executionRunId}' is ${runLifecycle?.lifecycle ?? "missing"}; claims require an active run (E13 §27)`,
      { attemptId: input.attemptId, executionRunId: binding.executionRunId, lifecycle: runLifecycle?.lifecycle ?? null },
    );
  }
  requireLegalWorkerInvocationTransition(binding.state, "claimed");
  const updated = tx
    .prepare(
      "UPDATE execution_worker_invocations SET state = 'claimed', worker_session_id = ?, worker_agent_id = ?, claimed_at = ? "
      + "WHERE attempt_id = ? AND state = 'prepared' AND worker_session_id IS NULL",
    )
    .run(input.workerSessionId, input.workerAgentId, now, input.attemptId) as { changes?: number | bigint };
  if (Number(updated.changes ?? 0) !== 1) {
    throw invocationError("WORKER_ATTEMPT_ALREADY_CLAIMED", `attempt '${input.attemptId}' raced a concurrent claim`, {
      attemptId: input.attemptId,
    });
  }
  insertInvocationEventInTx(tx, { attemptId: input.attemptId, eventType: "CLAIMED", workerSessionId: input.workerSessionId }, now);
  return getWorkerInvocationInTx(tx, input.attemptId) as WorkerInvocationBinding;
}

/**
 * claimed → finished (E5 §35/§36). `outcome` records only which authoritative
 * signal resolved the invocation: the durable report (normal completion) or
 * the host stop event (unreported exit). No report/replay/rollback happens
 * here.
 */
export function finishWorkerInvocationInTx(
  tx: StoreTx,
  input: { attemptId: string; workerSessionId: string },
  now: string,
): WorkerInvocationBinding {
  const binding = getWorkerInvocationInTx(tx, input.attemptId);
  if (binding === null) {
    throw invocationError("WORKER_AUTHORITY_REQUIRED", `no worker invocation exists for attempt '${input.attemptId}'`, {
      attemptId: input.attemptId,
    });
  }
  if (binding.workerSessionId !== input.workerSessionId) {
    throw invocationError("WORKER_SESSION_MISMATCH", "only the claimed worker session may finish its invocation", {
      attemptId: input.attemptId,
    });
  }
  if (binding.state === "finished") {
    return binding;
  }
  requireLegalWorkerInvocationTransition(binding.state, "finished");
  const updated = tx
    .prepare("UPDATE execution_worker_invocations SET state = 'finished', finished_at = ? WHERE attempt_id = ? AND state = 'claimed'")
    .run(now, input.attemptId) as { changes?: number | bigint };
  if (Number(updated.changes ?? 0) !== 1) {
    throw invocationError("INVALID_WORKER_INVOCATION_TRANSITION", `attempt '${input.attemptId}' raced a concurrent transition`, {
      attemptId: input.attemptId,
    });
  }
  insertInvocationEventInTx(tx, { attemptId: input.attemptId, eventType: "FINISHED", workerSessionId: input.workerSessionId }, now);
  return getWorkerInvocationInTx(tx, input.attemptId) as WorkerInvocationBinding;
}

/** Mark an UNCLAIMED (prepared) invocation finished after a pre-claim stop. */
export function abortPreparedInvocationInTx(tx: StoreTx, attemptId: string, now: string): WorkerInvocationBinding {
  const binding = getWorkerInvocationInTx(tx, attemptId);
  if (binding === null || binding.state !== "prepared") {
    throw invocationError("WORKER_LAUNCH_INVALID", `no prepared invocation exists for attempt '${attemptId}'`, {
      attemptId,
    });
  }
  requireLegalWorkerInvocationTransition(binding.state, "finished");
  const updated = tx
    .prepare("UPDATE execution_worker_invocations SET state = 'finished', finished_at = ? WHERE attempt_id = ? AND state = 'prepared'")
    .run(now, attemptId) as { changes?: number | bigint };
  if (Number(updated.changes ?? 0) !== 1) {
    throw invocationError("INVALID_WORKER_INVOCATION_TRANSITION", `attempt '${attemptId}' raced a concurrent transition`, {
      attemptId,
    });
  }
  insertInvocationEventInTx(tx, { attemptId, eventType: "FINISHED" }, now);
  return getWorkerInvocationInTx(tx, attemptId) as WorkerInvocationBinding;
}

/**
 * E11 §40/§41 — launch-credential ROTATION on the SAME prepared, unclaimed
 * invocation binding: the old token hash is invalidated, the new hash
 * persisted, the Attempt and binding unchanged. This is runtime credential
 * recovery, never a semantic retry — the attempt identity, Directive revision,
 * and role are frozen. A claimed or finished binding can never rotate
 * (WORKER_LAUNCH_RETRY_NOT_ALLOWED — the Worker already received authority).
 */
export function rotatePreparedLaunchTokenInTx(
  tx: StoreTx,
  input: { attemptId: string; newTokenHash: string },
  now: string,
): WorkerInvocationBinding {
  const binding = getWorkerInvocationInTx(tx, input.attemptId);
  if (binding === null) {
    throw invocationError("WORKER_LAUNCH_RETRY_NOT_ALLOWED", `no worker invocation exists for attempt '${input.attemptId}'`, {
      attemptId: input.attemptId,
    });
  }
  if (binding.state !== "prepared" || binding.workerSessionId !== null) {
    throw invocationError(
      "WORKER_LAUNCH_RETRY_NOT_ALLOWED",
      `attempt '${input.attemptId}' has a ${binding.state} invocation${binding.workerSessionId === null ? "" : " already bound to a worker session"}; only an unclaimed prepared launch can rotate its credential`,
      { attemptId: input.attemptId, state: binding.state, workerSessionId: binding.workerSessionId },
    );
  }
  const updated = tx
    .prepare(
      "UPDATE execution_worker_invocations SET launch_token_hash = ? "
      + "WHERE attempt_id = ? AND state = 'prepared' AND worker_session_id IS NULL",
    )
    .run(input.newTokenHash, input.attemptId) as { changes?: number | bigint };
  if (Number(updated.changes ?? 0) !== 1) {
    throw invocationError("WORKER_LAUNCH_RETRY_NOT_ALLOWED", `attempt '${input.attemptId}' raced a concurrent claim`, {
      attemptId: input.attemptId,
    });
  }
  insertInvocationEventInTx(tx, { attemptId: input.attemptId, eventType: "ROTATED" }, now);
  return getWorkerInvocationInTx(tx, input.attemptId) as WorkerInvocationBinding;
}

/**
 * E12 §37/§38 — the takeover-side credential fence: EVERY prepared, unclaimed
 * launch credential of the run is invalidated in the ownership-change
 * transaction itself. The old hash is replaced with a fresh random hash that
 * is NEVER returned to any caller (there is no plaintext to hand out), so a
 * launch package held only by the fenced Supervisor can no longer create a
 * Worker claim. The Attempt and its binding are untouched — the new Supervisor
 * re-credentials the SAME Attempt through retry_unclaimed_worker_launch (E11).
 * Claimed and finished invocations are never touched (§36 — takeover never
 * rewrites claimed Worker authority; §40 — this fence belongs to the takeover
 * generation change, never to an ordinary detach).
 */
export function revokePreparedLaunchCredentialsForRunInTx(tx: StoreTx, executionRunId: string, now: string): string[] {
  const prepared = (tx
    .prepare(
      `SELECT ${INVOCATION_COLUMNS} FROM execution_worker_invocations WHERE execution_run_id = ? AND state = 'prepared' AND worker_session_id IS NULL ORDER BY created_at, attempt_id`,
    )
    .all(executionRunId) as Record<string, unknown>[]).map(mapInvocationRow);
  const revoked: string[] = [];
  for (const binding of prepared) {
    // A fresh random hash no caller ever receives: the exact §38 shape —
    // invalidate the old credential without producing a new plaintext one.
    const deadHash = hashLaunchToken(`revoked:${randomUUID()}`);
    const updated = tx
      .prepare(
        "UPDATE execution_worker_invocations SET launch_token_hash = ? "
        + "WHERE attempt_id = ? AND state = 'prepared' AND worker_session_id IS NULL",
      )
      .run(deadHash, binding.attemptId) as { changes?: number | bigint };
    if (Number(updated.changes ?? 0) === 1) {
      insertInvocationEventInTx(tx, { attemptId: binding.attemptId, eventType: "ROTATED" }, now);
      revoked.push(binding.attemptId);
    }
  }
  return revoked;
}

/** Append-only runtime correlation event (E5 §47). */
export function insertInvocationEventInTx(
  tx: StoreTx,
  input: { attemptId: string; eventType: "PREPARED" | "CLAIMED" | "FINISHED" | "ROTATED"; workerSessionId?: string },
  now: string,
): void {
  const head = tx
    .prepare("SELECT MAX(event_seq) AS seq FROM execution_worker_invocation_events WHERE attempt_id = ?")
    .get(input.attemptId) as { seq: number | null };
  tx.prepare(
    "INSERT INTO execution_worker_invocation_events (attempt_id, event_seq, event_type, worker_session_id, created_at) "
    + "VALUES (?, ?, ?, ?, ?)",
  ).run(input.attemptId, (head.seq ?? 0) + 1, input.eventType, input.workerSessionId ?? null, now);
}

export interface WorkerInvocationEventRow {
  eventType: string;
  workerSessionId: string | null;
  createdAt: string;
}

export function listInvocationEventsInTx(tx: StoreTx, attemptId: string): WorkerInvocationEventRow[] {
  return tx
    .prepare(
      "SELECT event_type AS eventType, worker_session_id AS workerSessionId, created_at AS createdAt "
      + "FROM execution_worker_invocation_events WHERE attempt_id = ? ORDER BY event_seq",
    )
    .all(attemptId) as WorkerInvocationEventRow[];
}
