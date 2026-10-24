/**
 * The unresolved-indeterminate recovery fence (v0.2.0 E11 §7/§13/§36/§37).
 *
 * LEAF module: imports Store + Core only, so every gate that needs the fence
 * (Directive issuance, Attempt start, Stage progression, E6 acceptance, E10
 * completion) can share it without import cycles.
 *
 * The unresolved/reconciled distinction is DERIVED (E11 §7): an indeterminate
 * Attempt with a final AttemptReconciliation resolution is history; without
 * one it fences ordinary execution so later work is never layered on unknown
 * repository reality.
 */

import type { ExecutionAttempt } from "../core/execution-attempt.js";
import { RuntimeError } from "../runtime/errors.js";
import { listRunAttemptsInTx } from "../store/execution-attempts.js";
import { getExecutionDirectiveInTx } from "../store/execution-directives.js";
import { getOpenWindowInTx } from "../store/execution-structure.js";
import {
  getReconciliationBindingForDirectiveInTx,
  getReconciliationForAttemptInTx,
} from "../store/attempt-reconciliations.js";
import type { StoreTx } from "../store/transaction.js";

/** E11 §7 — unresolved = indeterminate AND no final reconciliation resolution. */
export function isAttemptUnresolvedIndeterminateInTx(tx: StoreTx, attempt: ExecutionAttempt): boolean {
  if (attempt.state !== "indeterminate") return false;
  return getReconciliationForAttemptInTx(tx, attempt.attemptId) === null;
}

function attemptDirectiveWindowIdInTx(tx: StoreTx, attempt: ExecutionAttempt): string {
  return getExecutionDirectiveInTx(tx, attempt.directiveId, attempt.directiveRevision)?.windowId ?? "";
}

/** The run's unresolved indeterminate Attempts, oldest first (deterministic). */
export function listUnresolvedIndeterminateInTx(
  tx: StoreTx,
  executionRunId: string,
  options: { windowId?: string } = {},
): ExecutionAttempt[] {
  const unresolved = listRunAttemptsInTx(tx, executionRunId).filter((attempt) =>
    isAttemptUnresolvedIndeterminateInTx(tx, attempt),
  );
  if (options.windowId === undefined) {
    return unresolved;
  }
  return unresolved.filter((attempt) => attemptDirectiveWindowIdInTx(tx, attempt) === options.windowId);
}

/**
 * True when the logical Directive id is the bound reconciliation Directive of
 * some indeterminate Attempt — its revisions stay issuable/startable while the
 * fence is active (E11 §9/§13; the recovery workflow must proceed).
 */
export function isReconciliationDirectiveIdInTx(tx: StoreTx, directiveId: string): boolean {
  return getReconciliationBindingForDirectiveInTx(tx, directiveId) !== null;
}

/**
 * E11 §13 — the recovery fence. While an unresolved indeterminate Attempt
 * exists in the CURRENT open window, ordinary issuance/start/progression is
 * refused. Reconciliation-Directive revisions and the state/read surfaces pass.
 */
export function requireNoUnresolvedIndeterminateFenceInTx(
  tx: StoreTx,
  executionRunId: string,
  directiveId?: string,
): void {
  const openWindow = getOpenWindowInTx(tx, executionRunId);
  if (openWindow === null) {
    return;
  }
  const unresolved = listUnresolvedIndeterminateInTx(tx, executionRunId, { windowId: openWindow.id });
  if (unresolved.length === 0) {
    return;
  }
  if (directiveId !== undefined && isReconciliationDirectiveIdInTx(tx, directiveId)) {
    return;
  }
  throw new RuntimeError(
    "ATTEMPT_RECONCILIATION_REQUIRED",
    `attempt '${unresolved[0]!.attemptId}' is indeterminate and unresolved; ordinary execution is fenced until the Attempt is reconciled (E11 §13)`,
    {
      detail: {
        attemptIds: unresolved.map((attempt) => attempt.attemptId),
        windowId: openWindow.id,
        recoveryGuidance: {
          fenced: true,
          unresolvedAttemptId: unresolved[0]!.attemptId,
          allowedRecoveryOperations: [
            "get_attempt_recovery_context",
            "issue_attempt_reconciliation",
            "resolve_indeterminate_attempt",
            "request_execution_replan",
          ],
          recommendedAction: "Call get_attempt_recovery_context to inspect recovery state, or issue_attempt_reconciliation to begin inspection (P5)",
        },
      },
      recoverable: false,
    },
  );
}
