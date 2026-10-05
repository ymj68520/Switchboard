/**
 * ExecutionAttempt application service (v0.2.0 E4 §16–§22, §41–§42).
 *
 * The start gate (E4 §19) revalidates EVERYTHING at launch — run active,
 * exact Directive revision/hash, run/stage/window still matching the current
 * structure, base candidate revision still current, never attempted, no other
 * running Attempt — so a stale Directive never starts. Supervisor authority
 * (E2 fence) is required for the operation that initiates work (E4 §41).
 *
 * markAttemptIndeterminate is an INTERNAL Core/Application primitive (E4 §22)
 * for future runtime crash recovery. It is deliberately NOT reachable from any
 * model-facing tool, and the SessionStart hook must NOT call it merely because
 * a Supervisor session reconnected (E4 §39) — a Worker may legally continue
 * after its Supervisor detaches; E5 owns real liveness decisions.
 *
 * E4 §42: submitExecutionReport lives in its own service; neither surface is
 * exposed as an unauthenticated model-callable tool — Worker invocation
 * identity/authentication belongs to E5.
 */

import type { ExecutionDirective } from "../core/execution-directive.js";
import type { ExecutionAttempt, WorkerRole } from "../core/execution-attempt.js";
import { RuntimeError } from "../runtime/errors.js";
import { getExecutionDirectiveInTx } from "../store/execution-directives.js";
import {
  insertProtocolEventInTx,
} from "../store/execution-directives.js";
import {
  getAttemptForDirectiveInTx,
  getExecutionAttemptInTx,
  getRunningAttemptInTx,
  insertRunningExecutionAttemptInTx,
  listRunAttemptsInTx,
  markAttemptIndeterminateInTx,
} from "../store/execution-attempts.js";
import { requireCurrentSupervisorAuthorityInTx } from "../store/supervisor-bindings.js";
import { requireImplementationPolicyClearInTx } from "./verification-policy-service.js";
import { requireNoUnresolvedIndeterminateFenceInTx } from "./recovery-fence.js";
import type { StoreClock } from "../store/migration-runner.js";
import type { PlanStore } from "../store/sqlite-store.js";
import type { StoreTx } from "../store/transaction.js";

export interface StartExecutionAttemptInput {
  executionRunId: string;
  sessionId: string;
  workspaceId: string;
  generation: number;
  /** Logical Attempt id; generated when omitted. */
  attemptId?: string;
  directiveId: string;
  directiveRevision: number;
  /** The caller's recorded Directive revision hash — must match exactly (E4-T16). */
  directiveHash: string;
  workerRole: WorkerRole;
}

/**
 * The authoritative Attempt start core (E4 §19). Runs inside the caller's
 * write transaction. A stale Directive (candidate moved after issuance, window
 * no longer open, stage no longer active) is NEVER started: the Directive
 * remains an immutable historical artifact and the Supervisor must issue a new
 * or revised Directive.
 */
export function startExecutionAttemptInTx(
  tx: StoreTx,
  input: StartExecutionAttemptInput,
  clock: StoreClock,
  now: string,
): { attempt: ExecutionAttempt; directive: ExecutionDirective } {
  requireCurrentSupervisorAuthorityInTx(tx, {
    executionRunId: input.executionRunId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    generation: input.generation,
  });
  const directive = getExecutionDirectiveInTx(tx, input.directiveId, input.directiveRevision);
  if (directive === null) {
    throw new RuntimeError(
      "DIRECTIVE_NOT_CURRENT",
      `no ExecutionDirective '${input.directiveId}@${input.directiveRevision}' exists`,
      { detail: { directiveId: input.directiveId, revision: input.directiveRevision }, recoverable: false },
    );
  }
  if (directive.hash !== input.directiveHash) {
    throw new RuntimeError(
      "DIRECTIVE_HASH_MISMATCH",
      `attempt hash does not match the persisted '${input.directiveId}@${input.directiveRevision}' revision`,
      { detail: { expected: directive.hash, detected: input.directiveHash }, recoverable: false },
    );
  }
  if (directive.executionRunId !== input.executionRunId) {
    throw new RuntimeError(
      "DIRECTIVE_NOT_CURRENT",
      `directive '${input.directiveId}@${input.directiveRevision}' belongs to run '${directive.executionRunId}'`,
      { detail: { expected: directive.executionRunId, detected: input.executionRunId }, recoverable: false },
    );
  }
  // E8 §22 — Attempt startup independently re-checks the verification policy:
  // an unattempted legacy v1 implementation Directive must first be upgraded
  // to a v2 revision, and pressure that became due after issuance still blocks
  // the start.
  requireImplementationPolicyClearInTx(tx, directive);
  // E11 §14 — the pre-issued bypass fence: a normal Directive issued before a
  // crash must NOT start while reconciliation is pending. The bound
  // reconciliation Directive's own attempts pass (E11 §9/§13).
  requireNoUnresolvedIndeterminateFenceInTx(tx, input.executionRunId, directive.directiveId);
  const attemptId = input.attemptId ?? `att_${clock.newId()}`;
  const attempt = insertRunningExecutionAttemptInTx(
    tx,
    {
      executionRunId: input.executionRunId,
      attemptId,
      directiveId: directive.directiveId,
      directiveRevision: directive.revision,
      directiveHash: directive.hash,
      workerRole: input.workerRole,
      directiveStageId: directive.stageId,
      directiveScopeKind: directive.scopeKind,
      directiveWindowId: directive.windowId,
      directiveBaseCandidateRevision: directive.baseCandidateRevision,
      directiveKind: directive.kind,
    },
    now,
  );
  insertProtocolEventInTx(
    tx,
    {
      executionRunId: input.executionRunId,
      eventType: "ATTEMPT_STARTED",
      directiveId: directive.directiveId,
      directiveRevision: directive.revision,
      attemptId,
    },
    now,
  );
  return { attempt, directive };
}

/**
 * running → indeterminate (E4 §22). Internal crash-recovery primitive: records
 * the durable fact that the outcome is unknown, sets endedAt, preserves the
 * exact Directive binding, creates NO report, and neither rolls back nor
 * replays anything.
 */
export function markExecutionAttemptIndeterminateInTx(
  tx: StoreTx,
  input: { attemptId: string },
  now: string,
): ExecutionAttempt {
  const attempt = markAttemptIndeterminateInTx(tx, input.attemptId, now);
  insertProtocolEventInTx(tx, { executionRunId: attempt.executionRunId, eventType: "ATTEMPT_INDETERMINATE", attemptId: attempt.attemptId }, now);
  return attempt;
}

export function createExecutionAttemptService(store: PlanStore, clock: StoreClock) {
  return {
    /** Authoritative Attempt launch (E4 §19/§41). */
    startExecutionAttempt(input: StartExecutionAttemptInput): { attempt: ExecutionAttempt; directive: ExecutionDirective } {
      return store.withWrite((tx) => startExecutionAttemptInTx(tx, input, clock, clock.nowIso()));
    },

    /** Internal crash-recovery primitive (E4 §22) — never model-facing. */
    markIndeterminate(input: { attemptId: string }): ExecutionAttempt {
      return store.withWrite((tx) => markExecutionAttemptIndeterminateInTx(tx, input, clock.nowIso()));
    },

    getAttempt(input: { attemptId: string }): ExecutionAttempt | null {
      return store.withRead((tx) => getExecutionAttemptInTx(tx, input.attemptId));
    },

    getRunningAttempt(input: { executionRunId: string }): ExecutionAttempt | null {
      return store.withRead((tx) => getRunningAttemptInTx(tx, input.executionRunId));
    },

    getAttemptForDirective(input: { directiveId: string; revision: number }): ExecutionAttempt | null {
      return store.withRead((tx) => getAttemptForDirectiveInTx(tx, input.directiveId, input.revision));
    },

    listRunAttempts(input: { executionRunId: string }): ExecutionAttempt[] {
      return store.withRead((tx) => listRunAttemptsInTx(tx, input.executionRunId));
    },
  };
}
