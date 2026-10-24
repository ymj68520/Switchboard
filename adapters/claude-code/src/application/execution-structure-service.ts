/**
 * Execution structure application service (v0.2.0 E3 §6/§10/§20/§23/§26/§27).
 *
 * Authority model: execution structure is DETERMINISTIC SYSTEM
 * MATERIALIZATION from the exact approved FinalPlan — never model design and
 * never a planning amendment (E3 §5/§20). The authoritative operation is:
 *
 *   ensureExecutionStructure(run)
 *     → materialized Stage set
 *     → exactly one active Stage (earliest eligible ordinal, mandatory
 *       dependencies respected)
 *     → exactly one open VerificationWindow (candidateRevision 0)
 *
 * Idempotency: repeated calls converge on the same logical Stage set, the
 * same active Stage, and the same open Window (E3 §2/§15). Uniqueness is
 * DDL-backed (UNIQUE(execution_run_id, ordinal), UNIQUE(execution_run_id, source_step_id), the
 * partial single-active/single-open indexes) inside the store's
 * BEGIN IMMEDIATE writer reservation.
 *
 * This operation never rebinds the FinalPlan, never touches the
 * SupervisorBinding, never changes the ExecutionRun lifecycle, never mutates
 * Plan Memory, and never creates ExecutionCommit/acceptedHead machinery.
 *
 * Fresh-handoff integration (E3 §21): the E1 delivery finalizer calls the
 * InTx core inside its activation transaction, so a successful fresh v16
 * handoff reports an active ExecutionRun whose initial structure is already
 * durable — the crash boundary is the handoff transaction itself.
 */

import { parseFinalPlanCanonical } from "./final-plan-canonical.js";
import { tryApplyContinuationStructureInTx } from "./execution-continuation-service.js";
import type { ExecutionStage } from "../core/execution-stage.js";
import type { VerificationWindow } from "../core/verification-window.js";
import { RuntimeError } from "../runtime/errors.js";
import { parsePlanningRunRow } from "../core/planning-run.js";
import { getFinalPlanInTx } from "../store/finalization.js";
import {
  activateExecutionStageInTx,
  getActiveExecutionStageInTx,
  getOpenWindowInTx,
  insertExecutionStageInTx,
  insertOpenWindowInTx,
  listExecutionStagesInTx,
  getExecutionStageInTx,
} from "../store/execution-structure.js";
import { getAcceptedHeadCommitIdInTx } from "../store/execution-commits.js";
import type { StoreClock } from "../store/migration-runner.js";
import type { PlanStore } from "../store/sqlite-store.js";
import type { StoreTx } from "../store/transaction.js";

export interface ExecutionStructure {
  stages: ExecutionStage[];
  activeStage: ExecutionStage | null;
  openWindow: VerificationWindow | null;
}

export function getExecutionStructureInTx(tx: StoreTx, executionRunId: string): ExecutionStructure {
  const stages = listExecutionStagesInTx(tx, executionRunId);
  const activeStage = stages.find((stage) => stage.status === "active") ?? null;
  const openWindow = getOpenWindowInTx(tx, executionRunId);
  return { stages, activeStage, openWindow };
}

/**
 * The authoritative idempotent bootstrap core (E3 §20). Runs inside the
 * caller's write transaction. Eligibility for initial activation follows
 * E3 §10/§27: mandatory dependencies respected (a predecessor must hold a
 * satisfying status — none can in E3, so only dependency-free stages
 * qualify), earliest FinalPlan/default ordinal wins.
 */
export function ensureExecutionStructureInTx(tx: StoreTx, executionRunId: string, clock: StoreClock, now: string): ExecutionStructure {
  const executionRun = tx
    .prepare("SELECT run_id AS runId, lifecycle FROM execution_runs WHERE execution_run_id = ?")
    .get(executionRunId) as { runId: string; lifecycle: string } | undefined;
  if (executionRun === undefined || executionRun.lifecycle !== "active") {
    throw new RuntimeError(
      "EXECUTION_STAGE_REQUIRED",
      `ExecutionRun '${executionRunId}' is ${executionRun?.lifecycle ?? "missing"}; structure requires an active run`,
      { detail: { executionRunId, lifecycle: executionRun?.lifecycle ?? null } },
    );
  }
  // A1 §16 — the source-PlanningRun provenance scopes the planning-side reads
  // (planning lifecycle, goal, approved FinalPlan); the canonical scope of
  // every structure row is the ExecutionRunID.
  const runRow = tx
    .prepare(
      "SELECT run_id AS runId, workspace_id AS workspaceId, lifecycle, stage, revision, goal, "
      + "created_at AS createdAt, updated_at AS updatedAt FROM planning_runs WHERE run_id = ?",
    )
    .get(executionRun.runId) as Record<string, unknown> | undefined;
  if (runRow === undefined) {
    throw new RuntimeError("EXECUTION_STAGE_REQUIRED", `no PlanningRun exists for '${executionRunId}'`, {
      detail: { executionRunId },
    });
  }
  const run = parsePlanningRunRow(runRow);

  let structure = getExecutionStructureInTx(tx, executionRunId);

  // 1. Materialization (E3 §6): one initial ImplementationStep → one stage.
  // P1: Check for predecessor continuation reuse before fresh decomposition.
  if (structure.stages.length === 0) {
    const continuation = tryApplyContinuationStructureInTx(tx, executionRunId, clock, now);
    if (continuation !== null) {
      return continuation;
    }
    const finalPlanRow = getFinalPlanInTx(tx, run.runId);
    if (finalPlanRow === null) {
      throw new RuntimeError("EXECUTION_STAGE_REQUIRED", `no approved FinalPlan exists for run '${executionRunId}'`, {
        detail: { executionRunId },
      });
    }
    const plan = parseFinalPlanCanonical(finalPlanRow.canonicalJson, executionRunId);
    const steps = plan.implementationOrder;
    if (steps.length > 0) {
      steps.forEach((step, index) => {
        insertExecutionStageInTx(
          tx,
          {
            id: `stage_${clock.newId()}`,
            executionRunId,
            ordinal: index + 1,
            status: "pending",
            objective: `${step.title} — ${step.description}`,
            sourceStepId: step.stepId,
            dependsOn: [...step.dependsOn],
            sourceRefs: step.supportingRefs.map((ref) => ({ kind: ref.kind, id: ref.id, revision: ref.revision })),
          },
          now,
        );
      });
    } else {
      // E3 §7 — the approved FinalPlan legitimately permits an empty
      // implementation order: the smallest deterministic decomposition is a
      // single stage whose objective derives directly from the approved
      // run goal, with no invented dependencies or plan refs.
      insertExecutionStageInTx(
        tx,
        {
          id: `stage_${clock.newId()}`,
          executionRunId,
          ordinal: 1,
          status: "pending",
          objective: run.goal,
          sourceStepId: null,
          dependsOn: [],
          sourceRefs: [],
        },
        now,
      );
    }
    structure = getExecutionStructureInTx(tx, executionRunId);
  }

  // 2. Initial activation (E3 §10) — only if no stage is active yet. E7 §23/
  // §26 — the bootstrap owns activation ONLY before accepted execution begins:
  // once an acceptedHead exists, a stage-less run is the legitimate
  // between-stages boundary and the next activation is an explicit Supervisor
  // decision (activate_execution_stage) — recovery never silently continues or
  // activates a Stage.
  if (structure.activeStage === null) {
    const acceptedHead = getAcceptedHeadCommitIdInTx(tx, executionRunId);
    if (acceptedHead !== null) {
      return structure;
    }
    const stageByStep = new Map(
      structure.stages.filter((stage) => stage.sourceStepId !== null).map((stage) => [stage.sourceStepId as string, stage]),
    );
    const eligible = structure.stages
      .filter((stage) => stage.status === "pending")
      .filter((stage) =>
        stage.dependsOn.every((dependency) => {
          const predecessor = stageByStep.get(dependency);
          return predecessor !== undefined && predecessor.status === "completed";
        }),
      )
      .sort((a, b) => a.ordinal - b.ordinal);
    if (eligible.length === 0) {
      throw new RuntimeError(
        "EXECUTION_STAGE_NOT_ELIGIBLE",
        `run '${executionRunId}' has no eligible stage to activate (mandatory dependencies unsatisfied)`,
        { detail: { executionRunId } },
      );
    }
    activateExecutionStageInTx(tx, eligible[0]!.id, now);
    structure = getExecutionStructureInTx(tx, executionRunId);
  }

  // 3. Genesis window (E3 §15) — exactly one open window under the active
  // stage, candidateRevision 0, rooted conceptually in the execution-start
  // baseline (no fabricated commit). E6 §34 refines the rule: ONLY a run with
  // NO accepted head may bootstrap a genesis window. acceptedHead != null with
  // no open window is the valid post-commit acceptance boundary (E6 §33) —
  // recovery must not silently decide whether the Stage continues, so no
  // successor window is auto-opened here.
  if (structure.openWindow === null) {
    const acceptedHead = getAcceptedHeadCommitIdInTx(tx, executionRunId);
    if (acceptedHead === null) {
      insertOpenWindowInTx(
        tx,
        { executionRunId, stageId: structure.activeStage!.id, windowId: `win_${clock.newId()}` },
        now,
      );
      structure = getExecutionStructureInTx(tx, executionRunId);
    }
  }
  return structure;
}

export function createExecutionStructureService(store: PlanStore, clock: StoreClock) {
  return {
    /**
     * Standalone authoritative bootstrap (E3 §20/§23) — the recovery entry
     * point for migrated v15 runs and any structure-absent active run.
     */
    ensureExecutionStructure(input: { executionRunId: string }): ExecutionStructure {
      return store.withWrite((tx) => ensureExecutionStructureInTx(tx, input.executionRunId, clock, clock.nowIso()));
    },

    // E11 §28 — the generic candidate-revision service setter was REMOVED:
    // production advancement has exactly two semantic authorities (the E4
    // Report transaction and the E11 AttemptReconciliation transaction), both
    // sharing the store CAS primitive. No third setter exists.

    /** Structural queries for later phases (E3 §26). */
    getExecutionStructure(input: { executionRunId: string }): ExecutionStructure {
      return store.withRead((tx) => getExecutionStructureInTx(tx, input.executionRunId));
    },

    getActiveStage(input: { executionRunId: string }): ExecutionStage | null {
      return store.withRead((tx) => getActiveExecutionStageInTx(tx, input.executionRunId));
    },

    getOpenWindow(input: { executionRunId: string }): VerificationWindow | null {
      return store.withRead((tx) => getOpenWindowInTx(tx, input.executionRunId));
    },

    getStage(input: { stageId: string }): ExecutionStage | null {
      return store.withRead((tx) => getExecutionStageInTx(tx, input.stageId));
    },
  };
}
