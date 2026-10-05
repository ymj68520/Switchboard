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
  type BindingIdentity,
  type RunControlAuthorizationRecord,
} from "../store/run-control.js";
import {
  getExecutionRunInTx,
  listExecutionRunsBySourcePlanningRunInTx,
  getExecutionRunBySourcePlanningRunInTx,
} from "../store/execution-runs.js";
import {
  getSupervisorBindingInTx,
  takeoverSupervisorBindingInTx,
} from "../store/supervisor-bindings.js";
import { revokePreparedLaunchCredentialsForRunInTx } from "../store/worker-invocations.js";
import type { StoreClock } from "../store/migration-runner.js";
import type { PlanStore } from "../store/sqlite-store.js";
import type { StoreTx } from "../store/transaction.js";

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
  | "STALE_RUN_REVISION"
  | "EXECUTION_RUN_NOT_FOUND"
  | "EXECUTION_RUN_AMBIGUOUS";

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
  /** PlanningRun identity for planning control (legacy compatibility). */
  runId: string;
  /**
   * A1 §49 — canonical exact ExecutionRunID for the execution-supervision
   * branch. When present it takes precedence over the legacy run_id.
   */
  executionRunId?: string;
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
  /** E2 — present when this control operation moved execution supervision. */
  supervisor?: {
    executionRunId: string;
    generation: number;
    state: "attached" | "detached";
    unboundAttach: boolean;
    /**
     * E12 §37/§38 — the Attempts whose prepared-unclaimed launch credentials
     * were invalidated by THIS takeover transaction (the credential fence).
     * Empty on an idempotent replay (the original takeover already revoked).
     */
    revokedLaunchCredentials: string[];
  } | null;
}

/**
 * A1-I closure §6/§8 — the outcome of an exact retry of a migrated
 * `legacy_pre_a1` control row. The retry is recognized as the SAME historical
 * operation and converges READ-ONLY on the already-durable outcome: no
 * mutation is re-executed, no generation is incremented, no authorization or
 * lifecycle/event object is created, and the row is never re-interpreted as
 * planning/execution authority (A1 §42/§43). When the historical planning
 * snapshot is no longer reconstructable, the durable control record alone
 * converges the retry (§8).
 */
export interface LegacyHistoricalReplayResult {
  control: RunControlAuthorizationRecord;
  idempotent: true;
  supervisor: null;
  legacyHistorical: {
    targetKind: "legacy_pre_a1";
    resultingBindingGeneration: number | null;
    resultingRunRevision: number | null;
    /** Internal audit only — never returned to the model (§4/§13). */
    newBindingIdentity: BindingIdentity | null;
    planningSnapshot: { run: PlanningRun; binding: BindingSnapshot } | null;
  };
}

export type RunControlOutcome = RunControlResult | LegacyHistoricalReplayResult;

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
    // A1 §23/§31 — the live-execution exclusion is CANONICAL nonterminal
    // ExecutionRun state, never legacy ExecutionBinding presence: a detached
    // legacy row must never make a prepared/active run invisible to planning
    // controls.
    const nonterminalRun = tx
      .prepare(
        "SELECT execution_run_id AS id FROM execution_runs "
        + "WHERE run_id = ? AND lifecycle IN ('prepared', 'active') LIMIT 1",
      )
      .get(runId) as { id: string } | undefined;
    if (nonterminalRun !== undefined) {
      throw controlError(
        operation === "takeover" ? "TAKEOVER_NOT_AVAILABLE_DURING_HANDOFF" : "ABORT_NOT_AVAILABLE_DURING_HANDOFF",
        `run '${runId}' owns a nonterminal ExecutionRun '${nonterminalRun.id}'; planning ${operation} is unavailable`,
        { runId, executionRunId: nonterminalRun.id },
      );
    }
    // v0.2.0 E1 — a durable ExecutionRun owns the execution transition too:
    // planning takeover/abort never crosses it (fail closed, same boundary).
    const executionRun = tx
      .prepare("SELECT run_id AS runId FROM execution_runs WHERE run_id = ?")
      .get(runId) as { runId: string } | undefined;
    if (executionRun !== undefined) {
      throw controlError(
        operation === "takeover" ? "TAKEOVER_NOT_AVAILABLE_DURING_HANDOFF" : "ABORT_NOT_AVAILABLE_DURING_HANDOFF",
        `run '${runId}' has a durable ExecutionRun; planning ${operation} is unavailable`,
        { runId },
      );
    }
  }

  /**
   * A1-I closure §6/§7/§8 — arbitration for a migrated `legacy_pre_a1` row.
   * The exact retry — same operation_id + authorization_request_id + operation
   * + request_hash + workspace identity, the row itself naming the legacy
   * PlanningRun — converges READ-ONLY on the already-durable historical
   * outcome: no mutation is re-executed, no generation is incremented, no new
   * authorization or lifecycle/event object is created, and the row is never
   * re-interpreted as planning/execution authority. ANY identity mismatch is
   * IDEMPOTENCY_CONFLICT (§7 — the conflict case), never a silent
   * reinterpretation. Returns null when no legacy row holds this operation_id.
   */
  function arbitrateLegacyReplayInTx(
    tx: ControlTx,
    input: { workspaceId: string; authorization: RunControlAuthorizationInput; operation: RunControlAuthorizationRecord["operation"] },
  ): LegacyHistoricalReplayResult | null {
    const existing = findControlAuthorizationByOperationInTx(tx, input.authorization.operationId);
    if (existing === null || existing.targetKind !== "legacy_pre_a1") return null;
    if (
      existing.operation !== input.operation
      || existing.workspaceId !== input.workspaceId
      || existing.requestHash !== input.authorization.requestHash
      || existing.authorizationRequestId !== input.authorization.authorizationRequestId
    ) {
      throw controlError(
        "IDEMPOTENCY_CONFLICT",
        `control operation '${input.authorization.operationId}' was authorized for a different request`,
        { operationId: input.authorization.operationId },
      );
    }
    let planningSnapshot: { run: PlanningRun; binding: BindingSnapshot } | null = null;
    try {
      // Read-only reconstruction of the CURRENT durable planning state — the
      // historical operation's effect is already committed and is never
      // re-derived, re-executed, or re-applied here.
      planningSnapshot = {
        run: parsePlanningRunRow(loadRunInTx(tx, existing.legacyRunId ?? "") as unknown as Record<string, unknown>),
        binding: requireBindingInTx(tx, existing.legacyRunId ?? ""),
      };
    } catch {
      // §8 — the row proves request identity but the historical planning
      // snapshot is no longer reconstructable: converge on the durable
      // control record alone. Never re-execute the mutation.
      planningSnapshot = null;
    }
    return {
      control: existing,
      idempotent: true,
      supervisor: null,
      legacyHistorical: {
        targetKind: "legacy_pre_a1",
        resultingBindingGeneration: existing.resultingBindingGeneration,
        resultingRunRevision: existing.resultingRunRevision,
        newBindingIdentity: existing.newBindingIdentity,
        planningSnapshot,
      },
    };
  }

  /** §25/§53 — same-invocation retry replays; a changed request conflicts.
   * The row itself names the run, so arbitration needs no live binding and
   * MUST precede ownership resolution (the first success may already have
   * detached the binding / moved the session). */
  function arbitrateRetryInTx(
    tx: ControlTx,
    input: { workspaceId: string; authorization: RunControlAuthorizationInput; operation: RunControlAuthorizationRecord["operation"] },
  ): RunControlOutcome | null {
    // A1-I closure §6 — a migrated legacy_pre_a1 row replays as a read-only
    // historical convergence (or a §7 conflict) before any planning
    // reinterpretation can fire.
    const legacyReplay = arbitrateLegacyReplayInTx(tx, input);
    if (legacyReplay !== null) return legacyReplay;
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
    // A1 §49 — this arbitration replays PLANNING-target rows only; an
    // execution_run / final_plan_execution row replays through its own
    // supervision branch. The legacy provenance column names the planning run.
    if (existing.targetKind !== "planning_run" || existing.legacyRunId === null) {
      throw controlError(
        "IDEMPOTENCY_CONFLICT",
        `control operation '${input.authorization.operationId}' was authorized for a different target kind`,
        { operationId: input.authorization.operationId },
      );
    }
    const run = parsePlanningRunRow(loadRunInTx(tx, existing.legacyRunId) as unknown as Record<string, unknown>);
    const binding = requireBindingInTx(tx, existing.legacyRunId);
    return { control: existing, run, binding, idempotent: true };
  }

  /**
   * E2 §12 — the execution-supervision takeover branch: explicit,
   * user-authorized ownership transfer for the ACTIVE ExecutionRun of a
   * completed PlanningRun. Planning lifecycle semantics are untouched — no
   * stage/HEAD/PlanCommit mutation, no abort path, and the run-control
   * authorization record is reused so the mandatory-interaction UX and the
   * crash-replay identity stay exactly the planning-grade machinery.
   */
  function supervisorTakeoverInTx(
    tx: StoreTx,
    input: TakeoverRunInput,
    run: PlanningRun,
    executionRun: { executionRunId: string; runId: string },
  ): RunControlResult {
    // §25/§53 — the SAME authorized supervision takeover retrying after a
    // transport failure replays idempotently: the first success already moved
    // supervision to this session, so the replay must return the durable
    // outcome BEFORE the same-session/conflict checks can fire.
    const priorControl = findControlAuthorizationByOperationInTx(tx, input.authorization.operationId);
    if (priorControl !== null) {
      if (
        priorControl.operation !== "takeover"
        || priorControl.targetKind !== "execution_run"
        || priorControl.executionRunId !== executionRun.executionRunId
        || priorControl.workspaceId !== input.workspaceId
        || priorControl.requestHash !== input.authorization.requestHash
      ) {
        throw controlError(
          "IDEMPOTENCY_CONFLICT",
          `control operation '${input.authorization.operationId}' was authorized for a different request`,
          { operationId: input.authorization.operationId },
        );
      }
      const supervisorBinding = getSupervisorBindingInTx(tx, executionRun.executionRunId);
      const planningBinding = requireBindingInTx(tx, executionRun.runId);
      return {
        control: priorControl,
        run,
        binding: planningBinding,
        supervisor:
          supervisorBinding === null
            ? null
            : {
                executionRunId: executionRun.executionRunId,
                generation: supervisorBinding.generation,
                state: supervisorBinding.state,
                unboundAttach: false,
                revokedLaunchCredentials: [],
              },
        idempotent: true,
      };
    }

    // The caller must not already hold this run's supervision (resume instead)
    // nor conflicting authority elsewhere (mirror §15/E11/E12).
    const callerSupervisor = tx
      .prepare("SELECT execution_run_id AS executionRunId FROM supervisor_bindings WHERE session_id = ? AND state = 'attached'")
      .get(input.callerSessionId) as { executionRunId: string } | undefined;
    if (callerSupervisor !== undefined) {
      if (callerSupervisor.executionRunId === executionRun.executionRunId) {
        throw controlError(
          "TAKEOVER_NOT_REQUIRED",
          `session '${input.callerSessionId}' already supervises ExecutionRun '${executionRun.executionRunId}'; reattach with the current generation instead of taking over`,
          { executionRunId: executionRun.executionRunId },
        );
      }
      throw controlError(
        "SESSION_ALREADY_BOUND",
        `caller session already supervises ExecutionRun '${callerSupervisor.executionRunId}'`,
        { executionRunId: callerSupervisor.executionRunId },
      );
    }
    const callerPlanning = tx
      .prepare("SELECT run_id AS runId FROM session_bindings WHERE session_id = ? AND state = 'attached'")
      .get(input.callerSessionId) as { runId: string } | undefined;
    if (callerPlanning !== undefined) {
      throw controlError(
        "SESSION_ALREADY_BOUND",
        `caller session already owns the planning binding of run '${callerPlanning.runId}'`,
        { runId: callerPlanning.runId },
      );
    }
    // A1 §23 — conflicting execution authority is judged on the CANONICAL
    // supervision ownership; the legacy ExecutionBinding is never consulted.
    const callerExec = tx
      .prepare("SELECT execution_run_id AS executionRunId FROM supervisor_bindings WHERE session_id = ? AND state = 'attached'")
      .get(input.callerSessionId) as { executionRunId: string } | undefined;
    if (callerExec !== undefined) {
      throw controlError(
        "SESSION_ALREADY_BOUND",
        `caller session supervises ExecutionRun '${callerExec.executionRunId}'`,
        { executionRunId: callerExec.executionRunId },
      );
    }
    const now = clock.nowIso();
    const priorBinding = getSupervisorBindingInTx(tx, executionRun.executionRunId);
    const resultingGeneration = priorBinding === null ? 1 : priorBinding.generation + 1;
    const control = insertControlAuthorizationInTx(
      tx,
      {
        controlId: `ctrl_${clock.newId()}`,
        operation: "takeover",
        targetKind: "execution_run",
        executionRunId: executionRun.executionRunId,
        legacySourcePlanningRunId: executionRun.runId,
        authorizationRequestId: input.authorization.authorizationRequestId,
        operationId: input.authorization.operationId,
        requestHash: input.authorization.requestHash,
        workspaceId: input.workspaceId,
        expectedBindingGeneration: input.expectedBindingGeneration,
        resultingBindingGeneration: resultingGeneration,
        previousBindingIdentity:
          priorBinding === null
            ? undefined
            : { sessionId: priorBinding.sessionId, generation: priorBinding.generation },
        newBindingIdentity: { sessionId: input.callerSessionId, generation: resultingGeneration },
      },
      now,
    );
    const supervisorBinding = takeoverSupervisorBindingInTx(
      tx,
      {
        executionRunId: executionRun.executionRunId,
        workspaceId: input.workspaceId,
        newSessionId: input.callerSessionId,
        expectedGeneration: input.expectedBindingGeneration,
      },
      now,
    );
    // E12 §37/§38 — the credential fence rides the SAME transaction as the
    // ownership change: every prepared-unclaimed launch credential of the run
    // is invalidated so the fenced Supervisor's launch package can never
    // create a Worker claim after the fence. Claimed invocations are never
    // touched (§36); the new Supervisor re-credentials the SAME Attempt via
    // retry_unclaimed_worker_launch (§37). Ordinary detach never does this
    // (§40 — the fence belongs to the generation change, not to detachment).
    const revokedLaunchCredentials = revokePreparedLaunchCredentialsForRunInTx(tx, executionRun.executionRunId, now);
    // E2 §12 — ownership is not a design fact: the completed PlanningRun row
    // and all planning history carry over exactly; only supervision ownership
    // moved, with the previous generation permanently fenced (SB-04).
    return {
      control,
      run,
      // A1 §16 — the planning SessionBinding is keyed by the source
      // PlanningRunID (the input's runId may be the canonical placeholder
      // when the caller supplied only the exact ExecutionRunID).
      binding: requireBindingInTx(tx, run.runId),
      supervisor: {
        executionRunId: executionRun.executionRunId,
        generation: supervisorBinding.generation,
        state: supervisorBinding.state,
        unboundAttach: priorBinding === null,
        revokedLaunchCredentials,
      },
      idempotent: false,
    };
  }

  return {
    takeoverRun(input: TakeoverRunInput): RunControlOutcome {
      return store.withWrite((tx) => {
        // A1 §35/§49 — the execution-supervision branch targets the EXACT
        // ExecutionRunID; the source PlanningRunID alone can never select an
        // execution world once several are representable.
        if (input.executionRunId !== undefined) {
          const executionRun = getExecutionRunInTx(tx, input.executionRunId);
          if (executionRun === null) {
            throw controlError("EXECUTION_RUN_NOT_FOUND", `no ExecutionRun exists for '${input.executionRunId}'`, {
              executionRunId: input.executionRunId,
            });
          }
          if (executionRun.workspaceId !== input.workspaceId) {
            throw controlError(
              "WORKSPACE_MISMATCH",
              `ExecutionRun '${executionRun.executionRunId}' belongs to a different workspace; takeover is same-WorkspaceIdentity only`,
              { executionRunId: executionRun.executionRunId, expected: executionRun.workspaceId, detected: input.workspaceId },
            );
          }
          const targetRun = parsePlanningRunRow(loadRunInTx(tx, executionRun.runId) as unknown as Record<string, unknown>);
          if (targetRun.lifecycle !== "completed" || executionRun.lifecycle !== "active") {
            throw controlError(
              "RUN_TERMINAL",
              `ExecutionRun '${executionRun.executionRunId}' is ${executionRun.lifecycle}; only an active execution world of a completed PlanningRun is takeover-eligible`,
              { executionRunId: executionRun.executionRunId, lifecycle: executionRun.lifecycle },
            );
          }
          return supervisorTakeoverInTx(tx, input, targetRun, executionRun);
        }
        // A1-I closure §6/§7 — a migrated legacy_pre_a1 row arbitrates BEFORE
        // any run resolution or planning reinterpretation (the row itself
        // names the run): an exact retry converges read-only on the durable
        // historical outcome; any identity mismatch (different workspace,
        // request identity, or legacy run identity) is IDEMPOTENCY_CONFLICT.
        const legacyReplay = arbitrateLegacyReplayInTx(tx, { workspaceId: input.workspaceId, authorization: input.authorization, operation: "takeover" });
        if (legacyReplay !== null) {
          return legacyReplay;
        }
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
        // E2 — a replay of an EXECUTION supervision takeover must converge on
        // the supervisor domain (the run is completed by then), so the prior
        // control record is peeked first and routed by run lifecycle.
        const priorControl = findControlAuthorizationByOperationInTx(tx, input.authorization.operationId);
        if (priorControl !== null && run.lifecycle === "completed") {
          if (
            priorControl.operation !== "takeover"
            || priorControl.workspaceId !== input.workspaceId
            || priorControl.requestHash !== input.authorization.requestHash
          ) {
            throw controlError(
              "IDEMPOTENCY_CONFLICT",
              `control operation '${input.authorization.operationId}' was authorized for a different request`,
              { operationId: input.authorization.operationId },
            );
          }
          const priorExecutionRun = getExecutionRunBySourcePlanningRunInTx(tx, input.runId);
          const supervisorBinding =
            priorExecutionRun === null ? null : getSupervisorBindingInTx(tx, priorExecutionRun.executionRunId);
          const planningBinding = requireBindingInTx(tx, input.runId);
          return {
            control: priorControl,
            run,
            binding: planningBinding,
            supervisor:
              supervisorBinding === null || priorExecutionRun === null
                ? null
                : {
                    executionRunId: priorExecutionRun.executionRunId,
                    generation: supervisorBinding.generation,
                    state: supervisorBinding.state,
                    unboundAttach: false,
                    // E12 — a replay never re-revokes: the original takeover
                    // transaction already fenced the credentials.
                    revokedLaunchCredentials: [],
                  },
            idempotent: true,
          };
        }
        const replay = arbitrateRetryInTx(tx, { workspaceId: input.workspaceId, authorization: input.authorization, operation: "takeover" });
        if (replay !== null) {
          return replay;
        }
        // §8/§9 — takeover targets ACTIVE runs only; completed/aborted (with
        // or without an ExecutionBinding) are terminal forever...
        // E2 §12 — ...except the execution-supervision branch: a completed
        // PlanningRun whose ExecutionRun is ACTIVE is takeover-eligible for
        // supervision ownership (planning lifecycle semantics stay separate).
        if (run.lifecycle !== "active") {
          const candidates = listExecutionRunsBySourcePlanningRunInTx(tx, input.runId);
          if (run.lifecycle === "completed" && candidates.length === 1 && candidates[0]?.lifecycle === "active") {
            return supervisorTakeoverInTx(tx, input, run, candidates[0]!);
          }
          if (run.lifecycle === "completed" && candidates.length > 1) {
            throw controlError(
              "EXECUTION_RUN_AMBIGUOUS",
              `PlanningRun '${input.runId}' binds several execution worlds; pass the exact execution_run_id (A1 §37)`,
              { runId: input.runId, candidates: candidates.map((candidate) => candidate.executionRunId) },
            );
          }
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
        // §15/A1 §23 — nor conflicting execution authority: the CANONICAL
        // current supervision ownership, never the legacy ExecutionBinding.
        const callerSupervision = tx
          .prepare("SELECT execution_run_id AS executionRunId FROM supervisor_bindings WHERE session_id = ? AND state = 'attached'")
          .get(input.callerSessionId) as { executionRunId: string } | undefined;
        if (callerSupervision !== undefined) {
          throw controlError(
            "SESSION_ALREADY_BOUND",
            `caller session supervises ExecutionRun '${callerSupervision.executionRunId}'`,
            { executionRunId: callerSupervision.executionRunId },
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
            operation: "takeover",
            targetKind: "planning_run",
            planningRunId: input.runId,
            legacySourcePlanningRunId: input.runId,
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

    abortRun(input: AbortRunInput): RunControlOutcome {
      return store.withWrite((tx) => {
        // §25/§53 — the SAME authorized invocation retrying after a crash
        // replays idempotently. The row names the run itself, so arbitration
        // MUST precede ownership resolution: the first success detached the
        // binding and terminated the run, and the replay reports that exact
        // terminal state with idempotent=true.
        const replay = arbitrateRetryInTx(tx, { workspaceId: input.workspaceId, authorization: input.authorization, operation: "abort" });
        if (replay !== null) {
          return replay;
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
            operation: "abort",
            targetKind: "planning_run",
            planningRunId: currentRun.runId,
            legacySourcePlanningRunId: currentRun.runId,
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
