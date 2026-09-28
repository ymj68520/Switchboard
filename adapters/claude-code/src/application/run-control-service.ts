/**
 * Run-control application service (Phase 16 directive §17/§35).
 *
 * `takeoverRun` / `abortRun` are CONTROL-PLANE operations (§1): they never
 * ride Proposal → Approval → PlanCommit and never touch Plan Memory, HEAD,
 * Proposals, Evidence, or workflow state. Each composes the FROZEN Phase 3
 * ownership primitives — `takeoverBindingInTx` (the only G → G+1 ownership
 * path, §16), `detachBindingInTx`, `assertWritableBindingInTx` — with the
 * durable `run_control_authorizations` record inside ONE BEGIN IMMEDIATE
 * transaction, so no stale-writer window exists between authorization,
 * mutation, and fencing.
 *
 * There is deliberately NO liveness/heartbeat oracle (§24/E22): fencing
 * provides correctness, and an attached live owner may be taken over.
 *
 * Validation precedence (deterministic):
 *   takeover: run exists → workspace exact → lifecycle active →
 *             same-session distinction (§22) → caller conflict (§15) →
 *             handoff boundary (§10) → idempotency (§25) →
 *             authorize + G → G+1.
 *   abort:    resolve target from the caller's ATTACHED binding (§27 — the
 *             model never names the run) → workspace exact → idempotency →
 *             lifecycle active → handoff boundary (§34) → exact writable
 *             owner (§28) → authorize → active→aborted +1 revision (§30) →
 *             detach +1 generation.
 */

import { RuntimeError } from "../runtime/errors.js";
import { isTerminalLifecycle } from "../core/state-machine.js";
import { parsePlanningRunRow, type PlanningRun } from "../core/planning-run.js";
import {
  assertWritableBindingInTx,
  detachBindingInTx,
  requireBindingInTx,
  takeoverBindingInTx,
  type BindingSnapshot,
  type BindingTx,
} from "../store/session-bindings.js";
import {
  findControlAuthorizationByOperationInTx,
  insertControlAuthorizationInTx,
  type RunControlAuthorizationRecord,
} from "../store/run-control.js";
import type { StoreClock } from "../store/migration-runner.js";
import type { PlanStore } from "../store/sqlite-store.js";

export type RunControlErrorCode =
  | "TAKEOVER_NOT_REQUIRED"
  | "TAKEOVER_NOT_AVAILABLE"
  | "TAKEOVER_NOT_AVAILABLE_DURING_HANDOFF"
  | "SESSION_ALREADY_BOUND"
  | "ABORT_NOT_AVAILABLE"
  | "ABORT_NOT_AVAILABLE_DURING_HANDOFF"
  | "IDEMPOTENCY_CONFLICT"
  | "RUN_NOT_FOUND"
  | "RUN_TERMINAL"
  | "WORKSPACE_MISMATCH"
  | "STALE_SESSION_BINDING"
  | "STALE_RUN_REVISION";

function controlError(
  code: RunControlErrorCode,
  message: string,
  detail?: Record<string, unknown>,
): RuntimeError {
  return new RuntimeError(code, message, { detail, recoverable: false });
}

export interface RunControlAuthorizationInput {
  /** `mcp-control:<signed toolUseId>` — the host-authorization proof. */
  authorizationRequestId: string;
  /** `takeover:<toolUseId>` / `abort:<toolUseId>` — the idempotency identity. */
  operationId: string;
  /** Pins the exact authorized request (§6). */
  requestHash: string;
}

export interface TakeoverRunInput {
  runId: string;
  workspaceId: string;
  callerSessionId: string;
  expectedBindingGeneration: number;
  authorization: RunControlAuthorizationInput;
}

export interface AbortRunInput {
  workspaceId: string;
  callerSessionId: string;
  /** The caller's signed binding generation — the exact-ownership fence. */
  bindingGeneration: number;
  authorization: RunControlAuthorizationInput;
  /** Audit note only; never affects legality (§27). */
  reason?: string;
}

export interface RunControlResult {
  control: RunControlAuthorizationRecord;
  run: PlanningRun;
  binding: BindingSnapshot;
  idempotent: boolean;
}

const SELECT_RUN =
  "SELECT run_id AS runId, workspace_id AS workspaceId, lifecycle, stage, revision, goal, "
  + "created_at AS createdAt, updated_at AS updatedAt FROM planning_runs";

const SELECT_BINDING =
  "SELECT run_id AS runId, workspace_id AS workspaceId, session_id AS sessionId, state, generation, "
  + "created_at AS createdAt, updated_at AS updatedAt FROM session_bindings";

interface RunRow {
  runId: string;
  workspaceId: string;
  lifecycle: string;
  stage: string;
  revision: number;
  goal: string;
  createdAt: string;
  updatedAt: string;
}

interface BindingRow {
  runId: string;
  workspaceId: string;
  sessionId: string;
  state: "attached" | "detached";
  generation: number;
  createdAt: string;
  updatedAt: string;
}

interface ControlTx extends BindingTx {
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

export function createRunControlService(store: PlanStore, clock: StoreClock) {
  function loadRunInTx(tx: ControlTx, runId: string): RunRow {
    const row = tx.prepare(`${SELECT_RUN} WHERE run_id = ?`).get(runId) as RunRow | undefined;
    if (row === undefined) {
      throw controlError("RUN_NOT_FOUND", `no PlanningRun exists for '${runId}'`, { runId });
    }
    return row;
  }

  /** §10/§34 — any execution-handoff operational state owns the transition. */
  function assertNoHandoffOwnershipInTx(
    tx: ControlTx,
    runId: string,
    operation: "takeover" | "abort",
  ): void {
    const handoff = tx
      .prepare("SELECT handoff_id AS handoffId FROM execution_handoffs WHERE run_id = ?")
      .get(runId) as { handoffId: string } | undefined;
    if (handoff !== undefined) {
      throw controlError(
        operation === "takeover" ? "TAKEOVER_NOT_AVAILABLE_DURING_HANDOFF" : "ABORT_NOT_AVAILABLE_DURING_HANDOFF",
        `run '${runId}' has entered the execution-handoff transition (${handoff.handoffId}); planning ${operation} is unavailable`,
        { runId, handoffId: handoff.handoffId },
      );
    }
    const binding = tx
      .prepare("SELECT run_id AS runId FROM execution_bindings WHERE run_id = ?")
      .get(runId) as { runId: string } | undefined;
    if (binding !== undefined) {
      throw controlError(
        operation === "takeover" ? "TAKEOVER_NOT_AVAILABLE_DURING_HANDOFF" : "ABORT_NOT_AVAILABLE_DURING_HANDOFF",
        `run '${runId}' carries an ExecutionBinding; planning ${operation} is unavailable`,
        { runId },
      );
    }
  }

  /** §25/§53 — same-invocation retry replays; a changed request conflicts.
   * The row itself names the run, so arbitration needs no live binding and
   * MUST precede ownership resolution (the first success may already have
   * detached the binding / moved the session). */
  function arbitrateRetryInTx(
    tx: ControlTx,
    input: { workspaceId: string; authorization: RunControlAuthorizationInput; operation: RunControlAuthorizationRecord["operation"] },
  ): { control: RunControlAuthorizationRecord; run: PlanningRun; binding: BindingSnapshot } | null {
    const existing = findControlAuthorizationByOperationInTx(tx, input.authorization.operationId);
    if (existing === null) return null;
    if (
      existing.operation !== input.operation
      || existing.workspaceId !== input.workspaceId
      || existing.requestHash !== input.authorization.requestHash
    ) {
      throw controlError(
        "IDEMPOTENCY_CONFLICT",
        `control operation '${input.authorization.operationId}' was authorized for a different request`,
        { operationId: input.authorization.operationId },
      );
    }
    const run = parsePlanningRunRow(loadRunInTx(tx, existing.runId) as unknown as Record<string, unknown>);
    const binding = requireBindingInTx(tx, existing.runId);
    return { control: existing, run, binding };
  }

  return {
    takeoverRun(input: TakeoverRunInput): RunControlResult {
      return store.withWrite((tx) => {
        const run = parsePlanningRunRow(loadRunInTx(tx, input.runId) as unknown as Record<string, unknown>);
        if (run.workspaceId !== input.workspaceId) {
          throw controlError(
            "WORKSPACE_MISMATCH",
            `PlanningRun '${input.runId}' belongs to a different workspace; takeover is same-WorkspaceIdentity only`,
            { runId: input.runId, expected: run.workspaceId, detected: input.workspaceId },
          );
        }
        // §25/§53 — the SAME authorized invocation retrying after a crash
        // replays idempotently (the first success already moved the binding to
        // this session, so this MUST precede the same-session/conflict checks).
        const replay = arbitrateRetryInTx(tx, { workspaceId: input.workspaceId, authorization: input.authorization, operation: "takeover" });
        if (replay !== null) {
          return { ...replay, idempotent: true };
        }
        // §8/§9 — takeover targets ACTIVE runs only; completed/aborted (with
        // or without an ExecutionBinding) are terminal forever.
        if (run.lifecycle !== "active") {
          throw controlError(
            "RUN_TERMINAL",
            `PlanningRun '${input.runId}' is ${run.lifecycle}; ownership takeover is unavailable`,
            { runId: input.runId, lifecycle: run.lifecycle },
          );
        }
        const binding = requireBindingInTx(tx, input.runId);
        // §22 — the original session uses the exact-session reattach path.
        if (binding.sessionId === input.callerSessionId) {
          throw controlError(
            "TAKEOVER_NOT_REQUIRED",
            `session '${input.callerSessionId}' already owns the binding for run '${input.runId}'; resume it via start_or_resume instead of taking over`,
            { runId: input.runId, state: binding.state },
          );
        }
        // §15/E11 — the caller may not hold conflicting planning authority.
        const callerAttached = tx
          .prepare("SELECT run_id AS runId FROM session_bindings WHERE session_id = ? AND state = 'attached'")
          .get(input.callerSessionId) as { runId: string } | undefined;
        if (callerAttached !== undefined) {
          throw controlError(
            "SESSION_ALREADY_BOUND",
            `caller session already owns the planning binding of run '${callerAttached.runId}'`,
            { runId: callerAttached.runId },
          );
        }
        // §15/E12 — nor conflicting execution authority.
        const callerExec = tx
          .prepare("SELECT run_id AS runId FROM execution_bindings WHERE session_id = ? AND state = 'attached'")
          .get(input.callerSessionId) as { runId: string } | undefined;
        if (callerExec !== undefined) {
          throw controlError(
            "SESSION_ALREADY_BOUND",
            `caller session is bound to the delivered execution contract of run '${callerExec.runId}'`,
            { runId: callerExec.runId },
          );
        }
        assertNoHandoffOwnershipInTx(tx, input.runId, "takeover");
        const now = clock.nowIso();
        // §16 — the ONLY ownership lineage: old owner G, new owner G + 1.
        const resultingGeneration = input.expectedBindingGeneration + 1;
        const control = insertControlAuthorizationInTx(
          tx,
          {
            controlId: `ctrl_${clock.newId()}`,
            runId: input.runId,
            operation: "takeover",
            authorizationRequestId: input.authorization.authorizationRequestId,
            operationId: input.authorization.operationId,
            requestHash: input.authorization.requestHash,
            workspaceId: input.workspaceId,
            expectedBindingGeneration: input.expectedBindingGeneration,
            resultingBindingGeneration: resultingGeneration,
            previousBindingIdentity: { sessionId: binding.sessionId, generation: binding.generation },
            newBindingIdentity: { sessionId: input.callerSessionId, generation: resultingGeneration },
          },
          now,
        );
        // Detach-old + attach-caller is ONE frozen epoch change (SB-04): the
        // expected-generation mismatch lands as STALE_SESSION_BINDING (§26 —
        // concurrent takeovers serialize here, exactly one winner).
        const snapshot = takeoverBindingInTx(
          tx,
          {
            runId: input.runId,
            newSessionId: input.callerSessionId,
            workspaceId: input.workspaceId,
            expectedGeneration: input.expectedBindingGeneration,
          },
          now,
        );
        // §18/§21 — ownership is not a design fact: the run row is untouched
        // and no new PlanningRun exists; run/stage/HEAD/Proposals/Evidence
        // carry over exactly.
        return { control, run, binding: snapshot, idempotent: false };
      });
    },

    abortRun(input: AbortRunInput): RunControlResult {
      return store.withWrite((tx) => {
        // §25/§53 — the SAME authorized invocation retrying after a crash
        // replays idempotently. The row names the run itself, so arbitration
        // MUST precede ownership resolution: the first success detached the
        // binding and terminated the run, and the replay reports that exact
        // terminal state with idempotent=true.
        const replay = arbitrateRetryInTx(tx, { workspaceId: input.workspaceId, authorization: input.authorization, operation: "abort" });
        if (replay !== null) {
          return { ...replay, idempotent: true };
        }
        // §27/§28 — the target is the caller's own attached active run, never
        // a model-supplied run id.
        const binding = tx
          .prepare(`${SELECT_BINDING} WHERE session_id = ? AND state = 'attached'`)
          .get(input.callerSessionId) as BindingRow | undefined;
        if (binding === undefined) {
          throw controlError(
            "STALE_SESSION_BINDING",
            `no active Phase Plan run is attached to session '${input.callerSessionId}'`,
            { sessionId: input.callerSessionId },
          );
        }
        const currentRun = parsePlanningRunRow(loadRunInTx(tx, binding.runId) as unknown as Record<string, unknown>);
        if (currentRun.workspaceId !== input.workspaceId) {
          throw controlError(
            "WORKSPACE_MISMATCH",
            `PlanningRun '${binding.runId}' belongs to a different workspace`,
            { runId: binding.runId, expected: currentRun.workspaceId, detected: input.workspaceId },
          );
        }
        // §29 — aborted is terminal and is never left via abort either.
        if (isTerminalLifecycle(currentRun.lifecycle)) {
          throw controlError(
            "RUN_TERMINAL",
            `PlanningRun '${currentRun.runId}' is already ${currentRun.lifecycle}`,
            { runId: currentRun.runId, lifecycle: currentRun.lifecycle },
          );
        }
        // §34 — handoff operational state exists: fail closed, never solve
        // execution-transition ownership here (a delivered handoff already
        // completed the run, so only prepared/pending reaches this check).
        assertNoHandoffOwnershipInTx(tx, currentRun.runId, "abort");
        // §28 — exact current writable ownership (attached + same session +
        // exact generation); a stale generation fences the abort.
        assertWritableBindingInTx(tx, {
          runId: currentRun.runId,
          workspaceId: input.workspaceId,
          sessionId: input.callerSessionId,
          generation: input.bindingGeneration,
        });
        const now = clock.nowIso();
        const control = insertControlAuthorizationInTx(
          tx,
          {
            controlId: `ctrl_${clock.newId()}`,
            runId: currentRun.runId,
            operation: "abort",
            authorizationRequestId: input.authorization.authorizationRequestId,
            operationId: input.authorization.operationId,
            requestHash: input.authorization.requestHash,
            workspaceId: input.workspaceId,
            expectedBindingGeneration: input.bindingGeneration,
            resultingBindingGeneration: input.bindingGeneration + 1,
            resultingRunRevision: currentRun.revision + 1,
            reason: input.reason,
          },
          now,
        );
        // §30 — a lifecycle mutation: revision +1 exactly once, stage/HEAD
        // untouched, no PlanCommit/Snapshot (§30/§32).
        const updated = tx
          .prepare(
            "UPDATE planning_runs SET lifecycle = 'aborted', revision = revision + 1, updated_at = ? "
            + "WHERE run_id = ? AND revision = ? AND lifecycle = 'active'",
          )
          .run(now, currentRun.runId, currentRun.revision) as { changes?: number | bigint };
        if (Number(updated.changes ?? 0) !== 1) {
          throw controlError(
            "STALE_RUN_REVISION",
            `stale run revision ${currentRun.revision} for '${currentRun.runId}'`,
            { runId: currentRun.runId, expected: currentRun.revision },
          );
        }
        // §35 — detach writable ownership with exactly one generation bump;
        // the later SessionEnd finds only a detached row and is idempotent
        // (§69).
        const snapshot = detachBindingInTx(
          tx,
          { runId: currentRun.runId, sessionId: input.callerSessionId },
          now,
        );
        return {
          control,
          run: { ...currentRun, lifecycle: "aborted" as const, revision: currentRun.revision + 1, updatedAt: now },
          binding: snapshot,
          idempotent: false,
        };
      });
    },
  };
}
