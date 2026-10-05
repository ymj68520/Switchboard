/**
 * ExecutionRun application service (v0.2.0 E1 §4–§13).
 *
 * Authority model (E1 §12): model / adapter code requests intent; this layer
 * validates against the authoritative Store; the Store persists the
 * authoritative transition. There is deliberately NO generic lifecycle setter
 * — the only E1 operations are:
 *
 *   prepareExecutionRunForFinalPlan   ABSENT → prepared, idempotent
 *                                     (create-or-reuse, DDL-backed by
 *                                     PRIMARY KEY(run_id))
 *   prepared → active                 Core-only, reachable exclusively through
 *                                     the host-handoff delivery finalizer
 *                                     (handoff-service finalizeDelivery) —
 *                                     the narrow E1 bridge (E1 §11)
 *
 * Exact FinalPlan binding (E1 §5): the run binds the exact approved
 * final_plans row (id@revision + hash) at creation. A reuse attempt naming a
 * different exact ref fails closed as EXECUTION_RUN_FINALPLAN_MISMATCH; the
 * binding columns are additionally trigger-protected in the DDL.
 *
 * Baselines (E1 §7): planningBaseline is server-derived from the approved
 * FinalPlan's committed provenance (Final PlanCommit + resulting HEAD
 * snapshot); executionStartBaseline reuses the frozen v0.1
 * ExecutionHandoff.repositoryBaseline — no second repository identity system
 * is introduced.
 */

import type { RepositoryBaseline } from "../core/execution-handoff.js";
import { isTerminalExecutionRunLifecycle, type ExecutionRun } from "../core/execution-run.js";
import { parsePlanningRunRow, type PlanningRun } from "../core/planning-run.js";
import { RuntimeError } from "../runtime/errors.js";
import { getExecutionRunBySourcePlanningRunInTx, insertExecutionRunInTx } from "../store/execution-runs.js";
import { getFinalPlanInTx, type FinalPlanRow } from "../store/finalization.js";
import type { StoreClock } from "../store/migration-runner.js";
import type { PlanStore } from "../store/sqlite-store.js";
import type { StoreTx } from "../store/transaction.js";
import { deriveRepositoryBaseline } from "./repository-baseline.js";

function executionRunError(
  code:
    | "HANDOFF_NOT_AUTHORIZED"
    | "HANDOFF_ALREADY_DELIVERED"
    | "WORKSPACE_MISMATCH"
    | "EXECUTION_RUN_FINALPLAN_MISMATCH"
    | "EXECUTION_HANDOFF_INVARIANT",
  message: string,
  detail?: Record<string, unknown>,
): RuntimeError {
  return new RuntimeError(code, message, { detail, recoverable: false });
}

function loadRunInTx(tx: StoreTx, runId: string): PlanningRun {
  const row = tx
    .prepare(
      "SELECT run_id AS runId, workspace_id AS workspaceId, lifecycle, stage, revision, goal, "
      + "created_at AS createdAt, updated_at AS updatedAt FROM planning_runs WHERE run_id = ?",
    )
    .get(runId) as Record<string, unknown> | undefined;
  if (row === undefined) {
    throw executionRunError("HANDOFF_NOT_AUTHORIZED", `no PlanningRun exists for '${runId}'`, { runId });
  }
  return parsePlanningRunRow(row);
}

/** The exact FinalPlan ref of the approved final_plans row (E1 §5). */
export function finalPlanRefOf(finalPlanRow: FinalPlanRow): {
  id: string;
  revision: number;
  hash: string;
} {
  return { id: finalPlanRow.finalPlanId, revision: finalPlanRow.revision, hash: finalPlanRow.finalPlanHash };
}

export interface PrepareExecutionRunInTxInput {
  run: PlanningRun;
  /** The approved FinalPlan row of this run — exact binding authority (§5). */
  finalPlanRow: FinalPlanRow;
  workspaceId: string;
  /** The frozen execution-start workspace reference (E1 §7). */
  executionStartBaseline: RepositoryBaseline;
  /** Audit attribution for the PREPARED event; optional on recovery paths. */
  sessionId?: string | null;
  toolUseId?: string | null;
}

export interface PrepareExecutionRunResult {
  executionRun: ExecutionRun;
  reused: boolean;
}

/**
 * The authoritative in-tx create-or-reuse core (E1 §9). Requires the caller's
 * open write transaction; idempotency is backed by PRIMARY KEY(run_id), not
 * by check-then-insert alone. A same-handoff retry resolves to the SAME
 * ExecutionRun — a UI/MCP/hook retry can never mint a second run.
 */
export function prepareExecutionRunForFinalPlanInTx(
  tx: StoreTx,
  input: PrepareExecutionRunInTxInput,
  clock: StoreClock,
  now: string,
): PrepareExecutionRunResult {
  const run = input.run;
  if (run.workspaceId !== input.workspaceId) {
    throw executionRunError(
      "WORKSPACE_MISMATCH",
      `PlanningRun '${run.runId}' belongs to a different workspace; ExecutionRun binding is same-WorkspaceIdentity only`,
      { runId: run.runId, expected: run.workspaceId, detected: input.workspaceId },
    );
  }
  if (run.lifecycle === "completed") {
    // A completed PlanningRun with an unresolved handoff retry means the run
    // already moved past the handoff; reuse (below) handles the converged
    // case, and a missing run here would be history invention.
    throw executionRunError(
      "HANDOFF_ALREADY_DELIVERED",
      `PlanningRun '${run.runId}' is already completed; no new ExecutionRun is created`,
      { runId: run.runId },
    );
  }
  if (run.lifecycle !== "active" || run.stage !== "final") {
    throw executionRunError(
      "HANDOFF_NOT_AUTHORIZED",
      `ExecutionRun preparation requires a PlanningRun in the approved FinalPlan handoff state (run is ${run.lifecycle}/${run.stage})`,
      { runId: run.runId, lifecycle: run.lifecycle, stage: run.stage },
    );
  }
  if (input.finalPlanRow.runId !== run.runId) {
    throw executionRunError(
      "EXECUTION_RUN_FINALPLAN_MISMATCH",
      `the FinalPlan '${input.finalPlanRow.finalPlanId}' does not belong to run '${run.runId}'`,
      { runId: run.runId, finalPlanId: input.finalPlanRow.finalPlanId },
    );
  }

  // A1 §37 — the source-planning provenance resolves the run's existing
  // execution world for same-handoff retries (initial-handoff idempotency is
  // this resolver's only production writer-side user).
  const existing = getExecutionRunBySourcePlanningRunInTx(tx, run.runId);
  if (existing !== null) {
    // Same-handoff retry: resolve to the SAME logical ExecutionRun (E1 §9).
    if (existing.workspaceId !== input.workspaceId) {
      throw executionRunError(
        "WORKSPACE_MISMATCH",
        `ExecutionRun '${existing.executionRunId}' is bound to a different workspace`,
        { expected: existing.workspaceId, detected: input.workspaceId },
      );
    }
    const expectedRef = finalPlanRefOf(input.finalPlanRow);
    if (
      existing.finalPlan.id !== expectedRef.id
      || existing.finalPlan.revision !== expectedRef.revision
      || existing.finalPlan.hash !== expectedRef.hash
    ) {
      throw executionRunError(
        "EXECUTION_RUN_FINALPLAN_MISMATCH",
        `ExecutionRun '${existing.executionRunId}' is permanently bound to FinalPlan `
          + `${existing.finalPlan.id}@${existing.finalPlan.revision}; the handoff names `
          + `${expectedRef.id}@${expectedRef.revision}`,
        { bound: existing.finalPlan, requested: expectedRef },
      );
    }
    if (isTerminalExecutionRunLifecycle(existing.lifecycle)) {
      throw executionRunError(
        "EXECUTION_HANDOFF_INVARIANT",
        `ExecutionRun '${existing.executionRunId}' is ${existing.lifecycle}; a handoff retry cannot resolve to a terminal run`,
        { runId: run.runId, lifecycle: existing.lifecycle },
      );
    }
    return { executionRun: existing, reused: true };
  }

  const executionRun: ExecutionRun = {
    executionRunId: `exec_${clock.newId()}`,
    runId: run.runId,
    workspaceId: run.workspaceId,
    finalPlan: finalPlanRefOf(input.finalPlanRow),
    lifecycle: "prepared",
    planningBaseline: {
      finalPlanCommitId: input.finalPlanRow.commitId,
      headSnapshotId: input.finalPlanRow.snapshotId,
    },
    executionStartBaseline: input.executionStartBaseline,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
  insertExecutionRunInTx(tx, executionRun, input.sessionId ?? null, input.toolUseId ?? null, now);
  return { executionRun, reused: false };
}

export interface PrepareExecutionRunInput {
  runId: string;
  workspaceId: string;
  sessionId?: string | null;
  toolUseId?: string | null;
}

/**
 * The standalone authoritative operation (E1 §9) — the recovery entry point.
 * The execution-start baseline is taken from the run's frozen ExecutionHandoff
 * when one exists (mid-handoff upgrade), or derived fresh from the workspace
 * exactly like the handoff derivation, so no second baseline system exists.
 */
export function createExecutionRunService(store: PlanStore, clock: StoreClock) {
  function loadExecutionStartBaselineInTx(
    tx: StoreTx,
    input: { runId: string; workspaceId: string },
  ): RepositoryBaseline {
    const handoff = tx
      .prepare("SELECT canonical_json AS canonicalJson FROM execution_handoffs WHERE run_id = ?")
      .get(input.runId) as { canonicalJson: string } | undefined;
    if (handoff !== undefined) {
      const parsed: unknown = JSON.parse(handoff.canonicalJson);
      if (typeof parsed === "object" && parsed !== null && "repositoryBaseline" in parsed) {
        return (parsed as { repositoryBaseline: RepositoryBaseline }).repositoryBaseline;
      }
      throw executionRunError(
        "EXECUTION_HANDOFF_INVARIANT",
        `the stored execution handoff for run '${input.runId}' is corrupt`,
        { runId: input.runId },
      );
    }
    const workspaceRow = tx
      .prepare("SELECT kind, canonical_root AS canonicalRoot FROM workspaces WHERE workspace_id = ?")
      .get(input.workspaceId) as { kind: string; canonicalRoot: string } | undefined;
    if (workspaceRow === undefined) {
      throw executionRunError("HANDOFF_NOT_AUTHORIZED", `workspace '${input.workspaceId}' is not registered`);
    }
    // Same derivation the handoff service uses (E1 §7 — reuse, don't rebuild).
    return deriveRepositoryBaseline(workspaceRow.kind, workspaceRow.canonicalRoot);
  }

  return {
    prepareExecutionRunForFinalPlan(input: PrepareExecutionRunInput): PrepareExecutionRunResult {
      return store.withWrite((tx) => {
        const run = loadRunInTx(tx, input.runId);
        // Deterministic validation precedence (mirrors run-control §17): the
        // WorkspaceIdentity fence fires before any baseline derivation.
        if (run.workspaceId !== input.workspaceId) {
          throw executionRunError(
            "WORKSPACE_MISMATCH",
            `PlanningRun '${run.runId}' belongs to a different workspace; ExecutionRun binding is same-WorkspaceIdentity only`,
            { runId: run.runId, expected: run.workspaceId, detected: input.workspaceId },
          );
        }
        const finalPlanRow = getFinalPlanInTx(tx, input.runId);
        if (finalPlanRow === null) {
          throw executionRunError(
            "HANDOFF_NOT_AUTHORIZED",
            `no approved FinalPlan exists for run '${input.runId}'; execution authority requires Final Approval`,
            { runId: input.runId },
          );
        }
        const baseline = loadExecutionStartBaselineInTx(tx, {
          runId: input.runId,
          workspaceId: input.workspaceId,
        });
        return prepareExecutionRunForFinalPlanInTx(
          tx,
          {
            run,
            finalPlanRow,
            workspaceId: input.workspaceId,
            executionStartBaseline: baseline,
            ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
            ...(input.toolUseId === undefined ? {} : { toolUseId: input.toolUseId }),
          },
          clock,
          clock.nowIso(),
        );
      });
    },
  };
}
