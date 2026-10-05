/**
 * A1-II — explicit same-FinalPlan reexecution application service
 * (amendment A1 §29–§33; A1-II directive §1–§17/§27–§31).
 *
 * The ONE production writer for `target_kind = 'final_plan_execution'`
 * control rows and for every post-initial ExecutionRun creation. ONE atomic
 * BEGIN IMMEDIATE transaction carries the directive §13 law:
 *
 *   no committed reexecution authorization exists without its exact
 *   resulting ExecutionRun, and no resulting ExecutionRun exists without
 *   its committed authorization
 *
 * — the authorization row is inserted already holding
 * `resulting_execution_run_id = E2` (append-only, A1 §14; the table never
 * takes an UPDATE). The run row precedes the authorization row only to
 * satisfy the FK; the crash boundary is the shared COMMIT.
 *
 * Reexecution is NOT replanning (§2) and NOT the initial handoff (§4): it
 * creates 0 PlanningRuns / FinalPlans / PlanCommits / Approvals /
 * ExecutionIssues (§45), never writes the handoff/ExecutionBinding metadata
 * families (§21/§30/§46), and never mutates the completed source PlanningRun
 * (§19) or any prior ExecutionRun of the FinalPlan (§39).
 *
 * Eligibility is evaluated inside the same transaction, in deterministic
 * order:
 *
 *   1. idempotency arbitration (§16/§17) — FIRST, before any eligibility
 *      check, so an exact retry converges on the same E2 in every E2
 *      lifecycle; in particular a retry while E2 is prepared/active must
 *      NOT trip the workspace-slot check (E2 itself occupies the slot).
 *      Any identity change under the same operation id is
 *      IDEMPOTENCY_CONFLICT, never a second authorization.
 *   2. exact FinalPlan (§5) — the exact committed final_plans row
 *      (id@revision + hash); no latest/current-plan resolution exists.
 *   3. initial delivery already occurred (§6) — PlanningRun completed +
 *      delivered execution handoff + at least one existing ExecutionRun.
 *      First execution rides the handoff path; later executions ride this
 *      path — never the reverse.
 *   4. target WorkspaceIdentity resolvable (§36) — fail closed before E2.
 *   5. workspace prepared|active slot free (§8) — the A1 §27 singleton is
 *      the serialized backstop; the pre-check gives the stable typed error
 *      (§48 — SQLite uniqueness never becomes public semantics). Terminal
 *      prior runs of F never block (§7); there is no global
 *      one-run-per-FinalPlan fence (§35, A1-I34).
 *
 * Baselines (§22/§23): planningBaseline re-references the EXACT approved
 * FinalPlan provenance (the same Final PlanCommit + committed HEAD snapshot
 * the initial run carries — never a planning rerun, never a copy);
 * executionStartBaseline is freshly derived from the target workspace at
 * creation. E2 begins acceptedHead=null / completionCommit=null with
 * genesis execution structure materializing at activation (§24/§27/§41 —
 * the canonical E3 primitive requires an active run, so durable `prepared`
 * is the recoverable creation boundary and activation composes the frozen
 * prepared→active primitive with the initial-attachment trio of
 * finalizeDelivery MINUS every initial-handoff side effect: no PlanningRun
 * completion (§28), no handoff/binding writes (§30), no session detach).
 *
 * A1-II CLOSURE AMENDMENT (2026-10-05) — the prepared boundary is canonical:
 * a successful CREATION transaction persists exactly the authorization,
 * prepared E2 (identity + exact FinalPlan binding + both baselines + audit
 * events), and nothing more — no SupervisorBinding, no Stages, no Windows.
 * A prepared reexecution Run is SELF-SUFFICIENT: recovery re-derives
 * activation from the durable row + authorization linkage alone (no
 * replanning, no latest-FinalPlan resolution, no new authorization, no new
 * run, no recomputed baseline). ACTIVATION is the second durable phase and
 * must own the structure/binding materialization: on its failure E2 remains
 * exactly prepared, the authorization remains exactly once, and zero partial
 * SupervisorBinding/Stage/Window state survives — never an E2 deletion,
 * never an E3.
 */

import type { RepositoryBaseline } from "../core/execution-handoff.js";
import { parsePlanningRunRow, type PlanningRun } from "../core/planning-run.js";
import { RuntimeError } from "../runtime/errors.js";
import {
  activateExecutionRunInTx,
  getExecutionRunInTx,
  insertExecutionRunInTx,
  listExecutionRunsBySourcePlanningRunInTx,
} from "../store/execution-runs.js";
import { getFinalPlanInTx } from "../store/finalization.js";
import {
  findControlAuthorizationByOperationInTx,
  insertControlAuthorizationInTx,
  type RunControlAuthorizationRecord,
} from "../store/run-control.js";
import { getSupervisorBindingInTx, insertAttachedSupervisorBindingInTx } from "../store/supervisor-bindings.js";
import type { StoreClock } from "../store/migration-runner.js";
import type { PlanStore } from "../store/sqlite-store.js";
import type { StoreTx } from "../store/transaction.js";
import { ensureExecutionStructureInTx } from "./execution-structure-service.js";
import { deriveRepositoryBaseline } from "./repository-baseline.js";

export type ReexecutionErrorCode =
  | "FINAL_PLAN_NOT_FOUND"
  | "FINAL_PLAN_MISMATCH"
  | "INITIAL_DELIVERY_NOT_COMPLETE"
  | "WORKSPACE_UNAVAILABLE"
  | "WORKSPACE_EXECUTION_ACTIVE"
  | "WORKSPACE_MISMATCH"
  | "IDEMPOTENCY_CONFLICT"
  | "RUN_NOT_FOUND"
  | "EXECUTION_RUN_NOT_FOUND"
  | "RUN_TERMINAL"
  | "STALE_SUPERVISOR_BINDING"
  | "EXECUTION_HANDOFF_INVARIANT";

function reexecutionError(code: ReexecutionErrorCode, message: string, detail?: Record<string, unknown>): RuntimeError {
  return new RuntimeError(code, message, { detail, recoverable: false });
}

/** The exact FinalPlan identity a reexecution authorization binds (A1 §5). */
export type ReexecutionFinalPlanTarget = {
  sourcePlanningRunId: string;
  finalPlanId: string;
  finalPlanRevision: number;
  finalPlanHash: string;
};

export interface ReexecutionAuthorizationInput {
  /** `mcp-control:<signed toolUseId>` — the host-authorization proof. */
  authorizationRequestId: string;
  /** `reexecute_final_plan:<toolUseId>` — the idempotency identity. */
  operationId: string;
  /** Pins the exact authorized request (directive §15). */
  requestHash: string;
}

export interface ReexecuteFinalPlanInput extends ReexecutionFinalPlanTarget {
  /** The target WorkspaceIdentity of E2 (§8/§35/§36) — signed-context bound. */
  workspaceId: string;
  /** Audit attribution only; never an ownership fact (§31). */
  requesterSessionId: string;
  toolUseId?: string | null;
  /** Optional durable audit note; never affects legality. */
  reason?: string;
  authorization: ReexecutionAuthorizationInput;
}

export interface ReexecutionResult {
  /** `created` = fresh E2; `converged` = exact retry of the same operation. */
  status: "created" | "converged";
  idempotent: boolean;
  control: RunControlAuthorizationRecord;
  executionRunId: string;
  /** E2's lifecycle at response time (prepared at creation; §27). */
  lifecycle: string;
  finalPlan: { id: string; revision: number; hash: string };
  workspaceId: string;
  /** The completed source PlanningRun — byte-identical through reexecution (§19). */
  sourcePlanningRun: PlanningRun;
  planningBaseline: { finalPlanCommitId: string; headSnapshotId: string };
  executionStartBaseline: RepositoryBaseline;
}

export interface ActivateReexecutionInput {
  executionRunId: string;
  workspaceId: string;
  /** The authorized requesting session acquiring E2 supervision (§31). */
  sessionId: string;
}

export interface ReexecutionActivationResult {
  status: "activated" | "already_active";
  executionRunId: string;
  lifecycle: "active";
  supervisor: { executionRunId: string; generation: number; state: "attached" };
}

const SELECT_RUN =
  "SELECT run_id AS runId, workspace_id AS workspaceId, lifecycle, stage, revision, goal, "
  + "created_at AS createdAt, updated_at AS updatedAt FROM planning_runs";

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

/**
 * The authoritative §13 creation transaction. The caller supplies the open
 * BEGIN IMMEDIATE transaction; every check and both inserts commit or roll
 * back together (§33 — a fault before commit leaves no authorization row, no
 * E2, and no partial state; retry may create the one valid E2).
 */
export function reexecuteFinalPlanInTx(
  tx: StoreTx,
  input: ReexecuteFinalPlanInput,
  clock: StoreClock,
  now: string,
): ReexecutionResult {
  // ---- 1. idempotency arbitration (§16/§17) — before ANY eligibility ----
  const existing = findControlAuthorizationByOperationInTx(tx, input.authorization.operationId);
  if (existing !== null) {
    const target = existing.finalPlanExecution;
    const resultingRunId = target?.resultingExecutionRunId ?? null;
    if (
      existing.operation !== "reexecute_final_plan"
      || existing.targetKind !== "final_plan_execution"
      || existing.workspaceId !== input.workspaceId
      || existing.requestHash !== input.authorization.requestHash
      || existing.authorizationRequestId !== input.authorization.authorizationRequestId
      || target === null
      || target.sourcePlanningRunId !== input.sourcePlanningRunId
      || target.finalPlanId !== input.finalPlanId
      || target.finalPlanRevision !== input.finalPlanRevision
      || target.finalPlanHash !== input.finalPlanHash
      || resultingRunId === null
    ) {
      throw reexecutionError(
        "IDEMPOTENCY_CONFLICT",
        `reexecution operation '${input.authorization.operationId}' was authorized for a different request`,
        { operationId: input.authorization.operationId },
      );
    }
    // The committed authorization names its exact resulting run; a missing
    // row would violate the §13 atomic law and is invariant corruption.
    const converged = getExecutionRunInTx(tx, resultingRunId);
    if (converged === null) {
      throw reexecutionError(
        "EXECUTION_HANDOFF_INVARIANT",
        `reexecution authorization '${existing.controlId}' names missing ExecutionRun '${resultingRunId}'`,
        { controlId: existing.controlId, executionRunId: resultingRunId },
      );
    }
    return {
      status: "converged",
      idempotent: true,
      control: existing,
      executionRunId: converged.executionRunId,
      lifecycle: converged.lifecycle,
      finalPlan: converged.finalPlan,
      workspaceId: converged.workspaceId,
      sourcePlanningRun: loadSourcePlanningRunInTx(tx, input.sourcePlanningRunId),
      planningBaseline: converged.planningBaseline,
      executionStartBaseline: converged.executionStartBaseline,
    };
  }

  // ---- 2. exact FinalPlan (§5) ----
  const finalPlanRow = getFinalPlanInTx(tx, input.sourcePlanningRunId);
  if (finalPlanRow === null || finalPlanRow.finalPlanId !== input.finalPlanId) {
    throw reexecutionError(
      "FINAL_PLAN_NOT_FOUND",
      finalPlanRow === null
        ? `no committed FinalPlan exists under PlanningRun '${input.sourcePlanningRunId}'`
        : `PlanningRun '${input.sourcePlanningRunId}' committed FinalPlan '${finalPlanRow.finalPlanId}', not '${input.finalPlanId}'`,
      {
        sourcePlanningRunId: input.sourcePlanningRunId,
        finalPlanId: input.finalPlanId,
        ...(finalPlanRow === null ? {} : { committedFinalPlanId: finalPlanRow.finalPlanId }),
      },
    );
  }
  if (finalPlanRow.revision !== input.finalPlanRevision || finalPlanRow.finalPlanHash !== input.finalPlanHash) {
    throw reexecutionError(
      "FINAL_PLAN_MISMATCH",
      `FinalPlan '${finalPlanRow.finalPlanId}' is committed as @${finalPlanRow.revision} `
        + `(hash ${finalPlanRow.finalPlanHash}); the reexecution request names `
        + `@${input.finalPlanRevision} (hash ${input.finalPlanHash})`,
      {
        finalPlanId: finalPlanRow.finalPlanId,
        committed: { revision: finalPlanRow.revision, hash: finalPlanRow.finalPlanHash },
        requested: { revision: input.finalPlanRevision, hash: input.finalPlanHash },
      },
    );
  }

  // ---- 3. initial delivery already occurred (§6) ----
  const sourceRun = loadSourcePlanningRunInTx(tx, input.sourcePlanningRunId);
  if (sourceRun.lifecycle !== "completed") {
    throw reexecutionError(
      "INITIAL_DELIVERY_NOT_COMPLETE",
      `PlanningRun '${sourceRun.runId}' is ${sourceRun.lifecycle}; reexecution requires the initial delivery to be complete (completed run + delivered handoff)`,
      { sourcePlanningRunId: sourceRun.runId, lifecycle: sourceRun.lifecycle },
    );
  }
  const handoff = tx
    .prepare("SELECT handoff_id AS handoffId FROM execution_handoffs WHERE run_id = ?")
    .get(input.sourcePlanningRunId) as { handoffId: string } | undefined;
  const handoffState = tx
    .prepare("SELECT status FROM execution_handoff_states WHERE run_id = ?")
    .get(input.sourcePlanningRunId) as { status: string } | undefined;
  if (handoff === undefined || handoffState?.status !== "delivered") {
    throw reexecutionError(
      "INITIAL_DELIVERY_NOT_COMPLETE",
      `PlanningRun '${input.sourcePlanningRunId}' has no delivered execution handoff; the initial handoff path owns the first execution`,
      { sourcePlanningRunId: input.sourcePlanningRunId, ...(handoff === undefined ? {} : { handoffId: handoff.handoffId }) },
    );
  }
  const priorRuns = listExecutionRunsBySourcePlanningRunInTx(tx, input.sourcePlanningRunId);
  if (priorRuns.length === 0) {
    throw reexecutionError(
      "INITIAL_DELIVERY_NOT_COMPLETE",
      `PlanningRun '${input.sourcePlanningRunId}' has no initial ExecutionRun; reexecution never bypasses the initial handoff`,
      { sourcePlanningRunId: input.sourcePlanningRunId },
    );
  }

  // ---- 4. target WorkspaceIdentity resolvable (§36) ----
  const workspaceRow = tx
    .prepare("SELECT kind, canonical_root AS canonicalRoot FROM workspaces WHERE workspace_id = ?")
    .get(input.workspaceId) as { kind: string; canonicalRoot: string } | undefined;
  if (workspaceRow === undefined) {
    throw reexecutionError(
      "WORKSPACE_UNAVAILABLE",
      `target workspace '${input.workspaceId}' cannot be resolved; reexecution fails closed instead of auto-registering or falling back`,
      { workspaceId: input.workspaceId },
    );
  }

  // ---- 5. workspace prepared|active slot free (§8) ----
  const occupied = tx
    .prepare(
      "SELECT execution_run_id AS id FROM execution_runs "
      + "WHERE workspace_id = ? AND lifecycle IN ('prepared', 'active') LIMIT 1",
    )
    .get(input.workspaceId) as { id: string } | undefined;
  if (occupied !== undefined) {
    throw reexecutionError(
      "WORKSPACE_EXECUTION_ACTIVE",
      `workspace '${input.workspaceId}' already holds nonterminal ExecutionRun '${occupied.id}' `
        + `(at most one prepared|active run per WorkspaceIdentity); terminate it explicitly before reexecuting`,
      { workspaceId: input.workspaceId, executionRunId: occupied.id },
    );
  }

  // ---- the §13 atomic creation ----
  const executionRunId = `exec_${clock.newId()}`;
  const planningBaseline = {
    finalPlanCommitId: finalPlanRow.commitId,
    headSnapshotId: finalPlanRow.snapshotId,
  };
  const executionStartBaseline = deriveRepositoryBaseline(workspaceRow.kind, workspaceRow.canonicalRoot);
  // The run row precedes the authorization row only to satisfy the
  // resulting_execution_run_id FK; both commit or roll back together.
  insertExecutionRunInTx(
    tx,
    {
      executionRunId,
      runId: input.sourcePlanningRunId,
      workspaceId: input.workspaceId,
      finalPlan: { id: finalPlanRow.finalPlanId, revision: finalPlanRow.revision, hash: finalPlanRow.finalPlanHash },
      lifecycle: "prepared",
      planningBaseline,
      executionStartBaseline,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    },
    input.requesterSessionId,
    input.toolUseId ?? null,
    now,
  );
  const control = insertControlAuthorizationInTx(
    tx,
    {
      controlId: `ctrl_${clock.newId()}`,
      operation: "reexecute_final_plan",
      targetKind: "final_plan_execution",
      finalPlanExecution: {
        sourcePlanningRunId: input.sourcePlanningRunId,
        finalPlanId: finalPlanRow.finalPlanId,
        finalPlanRevision: finalPlanRow.revision,
        finalPlanHash: finalPlanRow.finalPlanHash,
      },
      resultingExecutionRunId: executionRunId,
      legacySourcePlanningRunId: input.sourcePlanningRunId,
      authorizationRequestId: input.authorization.authorizationRequestId,
      operationId: input.authorization.operationId,
      requestHash: input.authorization.requestHash,
      workspaceId: input.workspaceId,
      expectedBindingGeneration: 1,
      resultingRunRevision: 1,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    },
    now,
  );
  return {
    status: "created",
    idempotent: false,
    control,
    executionRunId,
    lifecycle: "prepared",
    finalPlan: { id: finalPlanRow.finalPlanId, revision: finalPlanRow.revision, hash: finalPlanRow.finalPlanHash },
    workspaceId: input.workspaceId,
    sourcePlanningRun: sourceRun,
    planningBaseline,
    executionStartBaseline,
  };
}

function loadSourcePlanningRunInTx(tx: StoreTx, runId: string): PlanningRun {
  const row = tx.prepare(`${SELECT_RUN} WHERE run_id = ?`).get(runId) as RunRow | undefined;
  if (row === undefined) {
    throw reexecutionError("RUN_NOT_FOUND", `no PlanningRun exists for '${runId}'`, { runId });
  }
  return parsePlanningRunRow(row as unknown as Record<string, unknown>);
}

export function createReexecutionService(store: PlanStore, clock: StoreClock) {
  return {
    /**
     * The MCP handler core: one atomic creation transaction (§13). The
     * human-confirmed, signed host context is the authorization; this layer
     * validates eligibility and persists authorization + E2 atomically.
     */
    reexecuteFinalPlan(input: ReexecuteFinalPlanInput): ReexecutionResult {
      return store.withWrite((tx) => reexecuteFinalPlanInTx(tx, input, clock, clock.nowIso()));
    },

    /**
     * §28/§31 — the generic prepared→active activation, separated from the
     * initial-handoff PlanningRun completion: activate (the ONE frozen
     * primitive) + initial SupervisorBinding attach (generation 1, E2's own
     * lineage, §29) + canonical execution-structure materialization, in ONE
     * transaction — and NOTHING else. No handoff write, no ExecutionBinding
     * (§30), no PlanningRun mutation (§28/§53), no session detach. The
     * requesting session acquires E2 supervision here; every later session
     * uses the canonical post-A1-I takeover semantics (§31).
     */
    activateReexecutionRun(input: ActivateReexecutionInput): ReexecutionActivationResult {
      return store.withWrite((tx) => {
        const run = getExecutionRunInTx(tx, input.executionRunId);
        if (run === null) {
          throw reexecutionError("EXECUTION_RUN_NOT_FOUND", `no ExecutionRun exists for '${input.executionRunId}'`, {
            executionRunId: input.executionRunId,
          });
        }
        if (run.workspaceId !== input.workspaceId) {
          throw reexecutionError(
            "WORKSPACE_MISMATCH",
            `ExecutionRun '${run.executionRunId}' belongs to a different workspace`,
            { expected: run.workspaceId, detected: input.workspaceId },
          );
        }
        if (run.lifecycle === "active") {
          // Convergence: the activation transaction committed but the caller
          // crashed before observing it (§32 retry). Only the exact owning
          // session converges; any other session takes over canonically.
          const supervisor = getSupervisorBindingInTx(tx, run.executionRunId);
          if (supervisor === null || supervisor.sessionId !== input.sessionId || supervisor.state !== "attached") {
            throw reexecutionError(
              "STALE_SUPERVISOR_BINDING",
              `ExecutionRun '${run.executionRunId}' is already active under another session's supervision; acquire it through takeover_run`,
              { executionRunId: run.executionRunId },
            );
          }
          return {
            status: "already_active" as const,
            executionRunId: run.executionRunId,
            lifecycle: "active" as const,
            supervisor: { executionRunId: run.executionRunId, generation: supervisor.generation, state: "attached" as const },
          };
        }
        if (run.lifecycle !== "prepared") {
          throw reexecutionError(
            "RUN_TERMINAL",
            `ExecutionRun '${run.executionRunId}' is ${run.lifecycle}; only a prepared run activates`,
            { executionRunId: run.executionRunId, lifecycle: run.lifecycle },
          );
        }
        const now = clock.nowIso();
        const activated = activateExecutionRunInTx(tx, run.executionRunId, now);
        const supervisor = insertAttachedSupervisorBindingInTx(
          tx,
          { executionRunId: run.executionRunId, workspaceId: run.workspaceId, sessionId: input.sessionId },
          now,
        );
        ensureExecutionStructureInTx(tx, run.executionRunId, clock, now);
        return {
          status: "activated" as const,
          executionRunId: activated.executionRunId,
          lifecycle: "active" as const,
          supervisor: { executionRunId: run.executionRunId, generation: supervisor.generation, state: "attached" as const },
        };
      });
    },
  };
}

export type ReexecutionService = ReturnType<typeof createReexecutionService>;
