/**
 * Human-Authorized ExecutionRun Abort service (v0.2.0 E13 §4–§15/§34–§46).
 *
 * ONE atomic abort transaction (E13 §38): consume the exact trusted
 * run-control authorization (the durable record of the mandatory host
 * user-confirmation dialog — the SAME mechanism as takeover_run, E13 §4), close
 * the open VerificationWindow as `aborted` if one exists (never fabricated),
 * invalidate every prepared/unclaimed Worker launch credential of the run,
 * transition ExecutionRun active → aborted through the single Core writer,
 * detach the SupervisorBinding (generation PRESERVED — E13 §34), and persist
 * the one-to-one abort provenance binding the consumed authorization.
 *
 * Abort is a CONTROL-PLANE exception (E13 §6): it does NOT require current
 * writable Supervisor ownership — a crashed/detached/fenced session must never
 * make the human owner's Run impossible to terminate. The authority is the
 * exact target run + the trusted human authorization, never a binding
 * generation. The transaction NEVER touches acceptedHead, candidateRevision,
 * Stage status, Attempt state, Reports, Assessments, Commits, or Issues
 * (E13 §16–§18/§24/§25/§49–§51) — abort is not acceptance, failure, rollback,
 * or replanning, and it performs no repository command of any kind (E13 §50).
 *
 * Any failure rolls the whole transaction back: the run stays active, the
 * window stays open, the prepared token stays usable, and the authorization
 * row vanishes with it (it is written INSIDE this transaction — E13 §39).
 */

import type { PlanStore } from "../store/sqlite-store.js";
import type { StoreClock } from "../store/migration-runner.js";
import type { ExecutionRun } from "../core/execution-run.js";
import { getExecutionRunInTx, abortExecutionRunInTx } from "../store/execution-runs.js";
import { getExecutionAbortRecordInTx, insertExecutionAbortRecordInTx } from "../store/execution-aborts.js";
import {
  findControlAuthorizationByOperationInTx,
  insertControlAuthorizationInTx,
} from "../store/run-control.js";
import { getSupervisorBindingInTx, detachSupervisorBindingInTx } from "../store/supervisor-bindings.js";
import { getExecutionStructureInTx } from "./execution-structure-service.js";
import { closeWindowForAbortInTx } from "../store/execution-structure.js";
import { getAcceptedHeadCommitIdInTx } from "../store/execution-commits.js";
import { listRunAttemptsInTx } from "../store/execution-attempts.js";
import { revokePreparedLaunchCredentialsForRunInTx } from "../store/worker-invocations.js";
import { RuntimeError, type RuntimeErrorCode } from "../runtime/errors.js";

export interface ExecutionAbortAuthorizationInput {
  /** `mcp-control:<signed toolUseId>` — the host-authorization proof. */
  authorizationRequestId: string;
  /** `abort-execution:<toolUseId>` — the idempotency identity. */
  operationId: string;
  requestHash: string;
}

export interface AbortExecutionRunInput {
  /** The EXACT target (E13 §8 — never "newest active", never inferred). */
  executionRunId: string;
  /** The Host-visible WorkspaceIdentity of the requesting session. */
  workspaceId: string;
  /** The requesting host session (provenance; authority is the human dialog). */
  requesterSessionId: string;
  /** Required non-empty (E13 §5) — the reason the user approved. */
  reason: string;
  authorization: ExecutionAbortAuthorizationInput;
}

export interface ExecutionAbortResult {
  executionRun: ExecutionRun;
  controlId: string;
  idempotent: boolean;
  /** The window closed as `aborted`, when one was open (E13 §19/§21). */
  closedWindowId: string | null;
  /** Attempts whose prepared-unclaimed launch credentials were invalidated. */
  revokedLaunchCredentials: string[];
}

function abortError(code: RuntimeErrorCode, message: string, detail?: Record<string, unknown>): RuntimeError {
  return new RuntimeError(code, message, { detail, recoverable: false });
}

/**
 * The ONE production caller of abortExecutionRunInTx / closeWindowForAbortInTx
 * (E13 §22/§40). Transport retries of the SAME authorized invocation replay
 * idempotently on the durable terminal result (E13 §10/§15); a replay whose
 * hash/workspace/operation differs from the recorded authorization fails
 * closed (IDEMPOTENCY_CONFLICT — an authorization can never serve a different
 * request, E13 §9).
 */
export function createExecutionAbortService(store: PlanStore, clock: StoreClock): {
  abortExecutionRun(input: AbortExecutionRunInput): ExecutionAbortResult;
} {
  return {
    abortExecutionRun(input: AbortExecutionRunInput): ExecutionAbortResult {
      return store.withWrite((tx) => {
        // §10/§53 — the SAME authorized invocation retrying after a transport
        // failure replays the already-terminal result. The recorded hash pins
        // the exact authorized request (§9): a replay for a different run,
        // workspace, or reason never converges.
        const replay = findControlAuthorizationByOperationInTx(tx, input.authorization.operationId);
        if (replay !== null) {
          // A1 §49 — an execution abort replays only its own target kind; a
          // legacy_pre_a1/planning row can never authorize or replay here.
          if (replay.targetKind !== "execution_run" || replay.executionRunId === null) {
            throw abortError(
              "IDEMPOTENCY_CONFLICT",
              `control operation '${input.authorization.operationId}' was authorized for a different target kind`,
              { operationId: input.authorization.operationId },
            );
          }
          if (
            replay.operation !== "abort"
            || replay.workspaceId !== input.workspaceId
            || replay.requestHash !== input.authorization.requestHash
          ) {
            throw abortError(
              "IDEMPOTENCY_CONFLICT",
              `control operation '${input.authorization.operationId}' was authorized for a different request`,
              { operationId: input.authorization.operationId },
            );
          }
          const replayedRun = getExecutionRunInTx(tx, replay.executionRunId);
          if (replayedRun === null || replayedRun.lifecycle !== "aborted") {
            throw abortError(
              "IDEMPOTENCY_CONFLICT",
              `control operation '${input.authorization.operationId}' replays but run '${replay.executionRunId}' is not aborted`,
              { executionRunId: replay.executionRunId, lifecycle: replayedRun?.lifecycle ?? null },
            );
          }
          const replayedAbort = getExecutionAbortRecordInTx(tx, replay.executionRunId);
          return {
            executionRun: replayedRun,
            controlId: replay.controlId,
            idempotent: true,
            closedWindowId: replayedAbort?.openWindowId ?? null,
            revokedLaunchCredentials: [],
          };
        }

        // §8 — the EXACT target from the Store; an invalid or foreign id fails
        // closed. Human approval of one run can never authorize another.
        const run = getExecutionRunInTx(tx, input.executionRunId);
        if (run === null) {
          throw abortError("RUN_NOT_FOUND", `no ExecutionRun exists for '${input.executionRunId}'`, { executionRunId: input.executionRunId });
        }
        if (run.workspaceId !== input.workspaceId) {
          throw abortError(
            "WORKSPACE_MISMATCH",
            `ExecutionRun '${input.executionRunId}' belongs to a different workspace`,
            { expected: run.workspaceId, detected: input.workspaceId },
          );
        }
        // §12/§45/§44/§46 — ONLY active → aborted. completed/replan_required/
        // aborted are terminal forever; abort loses every race against
        // completion, replan, and takeover by construction (same-transaction
        // CAS on the lifecycle column).
        if (run.lifecycle !== "active") {
          throw abortError(
            "RUN_TERMINAL",
            `ExecutionRun '${input.executionRunId}' is ${run.lifecycle}; only an active run aborts (E13 §12)`,
            { executionRunId: input.executionRunId, lifecycle: run.lifecycle },
          );
        }

        const now = clock.nowIso();
        // The supervisor binding's CURRENT generation is provenance only: it
        // fences nothing here (the human dialog is the authority, E13 §6) and
        // the detach PRESERVES the generation (E13 §34). Unbound runs use the
        // established generation-1 baseline for the hash pin.
        const binding = getSupervisorBindingInTx(tx, input.executionRunId);
        const generationForHash = binding?.generation ?? 1;
        const controlId = `ctrl_${clock.newId()}`;
        const control = insertControlAuthorizationInTx(
          tx,
          {
            controlId,
            operation: "abort",
            targetKind: "execution_run",
            executionRunId: input.executionRunId,
            legacySourcePlanningRunId: run.runId,
            authorizationRequestId: input.authorization.authorizationRequestId,
            operationId: input.authorization.operationId,
            requestHash: input.authorization.requestHash,
            workspaceId: input.workspaceId,
            expectedBindingGeneration: generationForHash,
            // E13 §34 — the detach preserves the generation: no resulting
            // generation exists for an abort (provenance-only column stays
            // NULL, exactly like the unbound-takeover baseline convention).
            resultingBindingGeneration: null,
            resultingRunRevision: run.revision + 1,
            reason: input.reason,
          },
          now,
        );

        // §38 — the durable abort snapshot: acceptedHead, active Stage, open
        // Window, active Attempt. Nothing in this transaction mutates them.
        const structure = getExecutionStructureInTx(tx, input.executionRunId);
        const acceptedHeadCommitId = getAcceptedHeadCommitIdInTx(tx, input.executionRunId);
        const activeAttempt = listRunAttemptsInTx(tx, input.executionRunId).find((attempt) => attempt.state === "running");

        // §19/§21/§22 — the open Window terminates as aborted (stage or
        // final_closure scope); no open window means nothing is closed and
        // none is fabricated. candidateRevision is preserved by the writer.
        if (structure.openWindow !== null) {
          closeWindowForAbortInTx(tx, { windowId: structure.openWindow.id }, now);
        }

        // §26 — prepared/unclaimed launch credentials die with the run's
        // authority (same rotation/revocation machinery as the E12 takeover
        // fence); claimed invocations are intentionally untouched (§27).
        const revokedLaunchCredentials = revokePreparedLaunchCredentialsForRunInTx(tx, input.executionRunId, now);

        // §40 — the ONE lifecycle writer (CAS on lifecycle='active'). Any
        // racing terminal transition makes this changes=0 and the WHOLE
        // transaction — including the authorization row above — rolls back.
        const aborted = abortExecutionRunInTx(tx, { executionRunId: input.executionRunId, controlId }, now);

        // §34 — the SupervisorBinding detaches with its generation, session
        // history, and audit events preserved. No takeover can follow (§13).
        if (binding !== null && binding.state === "attached") {
          detachSupervisorBindingInTx(tx, { executionRunId: input.executionRunId, sessionId: binding.sessionId }, now);
        }

        // §14/§15 — the one-to-one durable abort fact, binding the consumed
        // authorization (UNIQUE control_id) to this exact run (PK execution_run_id).
        insertExecutionAbortRecordInTx(
          tx,
          {
            executionRunId: input.executionRunId,
            runId: run.runId,
            controlId,
            requestedBySessionId: input.requesterSessionId,
            reason: input.reason,
            acceptedHeadCommitId,
            activeStageId: structure.activeStage?.id ?? null,
            openWindowId: structure.openWindow?.id ?? null,
            activeAttemptId: activeAttempt?.attemptId ?? null,
          },
          now,
        );

        return {
          executionRun: aborted,
          controlId: control.controlId,
          idempotent: false,
          closedWindowId: structure.openWindow?.id ?? null,
          revokedLaunchCredentials,
        };
      });
    },
  };
}
