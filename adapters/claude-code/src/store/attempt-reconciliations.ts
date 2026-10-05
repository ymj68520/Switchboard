/**
 * Attempt-reconciliation persistence (v0.2.0 E11 §8/§9/§53/§54).
 *
 * Cardinality laws are DDL-enforced (migration 024), never commented into
 * existence:
 *
 *   AR-01  ONE immutable binding per indeterminate Attempt (UNIQUE(attempt_id))
 *          — the one-logical-reconciliation-Directive rule (E11 §9)
 *   AR-02  at most ONE final resolution per Attempt (UNIQUE(attempt_id)) —
 *          a second resolution is impossible at the DDL level (E11 §8)
 *   AR-03  bindings and resolutions are append-only (no_update/no_delete
 *          triggers); the original Attempt is never mutated (E11 §4)
 *
 * The single production callers are the attempt-recovery application service
 * operations. There is deliberately no model-facing reconciliation-row CRUD
 * (E11 §11).
 */

import {
  parseAttemptReconciliationBindingRow,
  parseAttemptReconciliationRow,
  type AttemptReconciliation,
  type AttemptReconciliationBinding,
} from "../core/attempt-reconciliation.js";
import { RuntimeError } from "../runtime/errors.js";
import type { StoreTx } from "./transaction.js";

const BINDING_COLUMNS =
  "attempt_id AS attemptId, execution_run_id AS executionRunId, directive_id AS directiveId, "
  + "first_directive_revision AS firstDirectiveRevision, created_at AS createdAt";

const RECONCILIATION_COLUMNS =
  "reconciliation_id AS reconciliationId, attempt_id AS attemptId, execution_run_id AS executionRunId, "
  + "directive_id AS directiveId, directive_revision AS directiveRevision, "
  + "source_window_id AS sourceWindowId, resolution, inspection_report_id AS inspectionReportId, "
  + "candidate_revision_before AS candidateRevisionBefore, candidate_revision_after AS candidateRevisionAfter, "
  + "rationale, created_at AS createdAt";

export function getReconciliationBindingForAttemptInTx(
  tx: StoreTx,
  attemptId: string,
): AttemptReconciliationBinding | null {
  const raw = tx
    .prepare(`SELECT ${BINDING_COLUMNS} FROM execution_attempt_reconciliation_bindings WHERE attempt_id = ?`)
    .get(attemptId) as Record<string, unknown> | undefined;
  return raw === undefined ? null : parseAttemptReconciliationBindingRow(raw);
}

/** The binding a logical reconciliation Directive id belongs to (revisions allowed). */
export function getReconciliationBindingForDirectiveInTx(
  tx: StoreTx,
  directiveId: string,
): AttemptReconciliationBinding | null {
  const raw = tx
    .prepare(`SELECT ${BINDING_COLUMNS} FROM execution_attempt_reconciliation_bindings WHERE directive_id = ?`)
    .get(directiveId) as Record<string, unknown> | undefined;
  return raw === undefined ? null : parseAttemptReconciliationBindingRow(raw);
}

/**
 * Persist the immutable binding (E11 §9/§53): the target must still be an
 * indeterminate same-run Attempt and the bound Directive a same-run inspection;
 * UNIQUE(attempt_id) rejects a second logical binding for the same Attempt.
 */
export function insertReconciliationBindingInTx(
  tx: StoreTx,
  binding: AttemptReconciliationBinding,
): void {
  const attempt = tx
    .prepare("SELECT execution_run_id AS executionRunId, state FROM execution_attempts WHERE attempt_id = ?")
    .get(binding.attemptId) as { executionRunId: string; state: string } | undefined;
  if (attempt === undefined) {
    throw new RuntimeError(
      "ATTEMPT_RECONCILIATION_TARGET_INVALID",
      `no ExecutionAttempt exists for '${binding.attemptId}'`,
      { detail: { attemptId: binding.attemptId }, recoverable: false },
    );
  }
  if (attempt.state !== "indeterminate") {
    throw new RuntimeError(
      "ATTEMPT_RECONCILIATION_TARGET_INVALID",
      `attempt '${binding.attemptId}' is ${attempt.state}; only an indeterminate Attempt can be bound for reconciliation`,
      { detail: { attemptId: binding.attemptId, state: attempt.state }, recoverable: false },
    );
  }
  if (attempt.executionRunId !== binding.executionRunId) {
    throw new RuntimeError(
      "ATTEMPT_RECONCILIATION_TARGET_INVALID",
      `attempt '${binding.attemptId}' belongs to run '${attempt.executionRunId}', not '${binding.executionRunId}'`,
      { detail: { attemptId: binding.attemptId, expected: attempt.executionRunId, detected: binding.executionRunId }, recoverable: false },
    );
  }
  const directive = tx
    .prepare("SELECT execution_run_id AS executionRunId, kind FROM execution_directives WHERE directive_id = ? AND revision = ?")
    .get(binding.directiveId, binding.firstDirectiveRevision) as { executionRunId: string; kind: string } | undefined;
  if (directive === undefined || directive.executionRunId !== binding.executionRunId || directive.kind !== "inspection") {
    throw new RuntimeError(
      "ATTEMPT_RECONCILIATION_TARGET_INVALID",
      `directive '${binding.directiveId}@${binding.firstDirectiveRevision}' is not a same-run inspection`,
      { detail: { directiveId: binding.directiveId }, recoverable: false },
    );
  }
  try {
    tx.prepare(
      `INSERT INTO execution_attempt_reconciliation_bindings (
         attempt_id, execution_run_id, directive_id, first_directive_revision, created_at
       ) VALUES (?, ?, ?, ?, ?)`,
    ).run(
      binding.attemptId,
      binding.executionRunId,
      binding.directiveId,
      binding.firstDirectiveRevision,
      binding.createdAt,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("UNIQUE constraint failed: execution_attempt_reconciliation_bindings.attempt_id")) {
      throw new RuntimeError(
        "ATTEMPT_RECONCILIATION_TARGET_INVALID",
        `attempt '${binding.attemptId}' already has a bound reconciliation Directive (E11 §9 — one logical reconciliation Directive per Attempt)`,
        { detail: { attemptId: binding.attemptId }, recoverable: false },
      );
    }
    throw err;
  }
}

export function getReconciliationForAttemptInTx(tx: StoreTx, attemptId: string): AttemptReconciliation | null {
  const raw = tx
    .prepare(`SELECT ${RECONCILIATION_COLUMNS} FROM execution_attempt_reconciliations WHERE attempt_id = ?`)
    .get(attemptId) as Record<string, unknown> | undefined;
  return raw === undefined ? null : parseAttemptReconciliationRow(raw);
}

/** Every final resolution of one run (gate/policy/snapshot derivations). */
export function listRunReconciliationsInTx(tx: StoreTx, executionRunId: string): AttemptReconciliation[] {
  return (tx
    .prepare(`SELECT ${RECONCILIATION_COLUMNS} FROM execution_attempt_reconciliations WHERE execution_run_id = ? ORDER BY created_at, reconciliation_id`)
    .all(executionRunId) as Record<string, unknown>[]).map(parseAttemptReconciliationRow);
}

/**
 * Persist the immutable final resolution (E11 §8/§54). The target must STILL
 * be indeterminate and unresolved; UNIQUE(attempt_id) is the fence — any race
 * loses deterministically here.
 */
export function insertAttemptReconciliationInTx(tx: StoreTx, reconciliation: AttemptReconciliation): void {
  const attempt = tx
    .prepare("SELECT execution_run_id AS executionRunId, state FROM execution_attempts WHERE attempt_id = ?")
    .get(reconciliation.attemptId) as { executionRunId: string; state: string } | undefined;
  if (attempt === undefined || attempt.state !== "indeterminate") {
    throw new RuntimeError(
      "ATTEMPT_RECONCILIATION_TARGET_INVALID",
      attempt === undefined
        ? `no ExecutionAttempt exists for '${reconciliation.attemptId}'`
        : `attempt '${reconciliation.attemptId}' is ${attempt.state}; only an indeterminate Attempt can be reconciled (E11 §54)`,
      { detail: { attemptId: reconciliation.attemptId, state: attempt?.state ?? null }, recoverable: false },
    );
  }
  try {
    tx.prepare(
      `INSERT INTO execution_attempt_reconciliations (
         reconciliation_id, attempt_id, execution_run_id, directive_id, directive_revision,
         source_window_id, resolution, inspection_report_id,
         candidate_revision_before, candidate_revision_after, rationale, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      reconciliation.reconciliationId,
      reconciliation.attemptId,
      reconciliation.executionRunId,
      reconciliation.directiveId,
      reconciliation.directiveRevision,
      reconciliation.sourceWindowId,
      reconciliation.resolution,
      reconciliation.inspectionReportId,
      reconciliation.candidateRevisionBefore,
      reconciliation.candidateRevisionAfter,
      reconciliation.rationale,
      reconciliation.createdAt,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("UNIQUE constraint failed: execution_attempt_reconciliations.attempt_id")) {
      throw new RuntimeError(
        "ATTEMPT_RECONCILIATION_ALREADY_RESOLVED",
        `attempt '${reconciliation.attemptId}' already carries a final reconciliation resolution (E11 §8)`,
        { detail: { attemptId: reconciliation.attemptId }, recoverable: false },
      );
    }
    throw err;
  }
}
