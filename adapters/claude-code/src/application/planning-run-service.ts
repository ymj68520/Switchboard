/**
 * PlanningRun application service (frozen plan §17/§20–§35/§55).
 *
 * Layering: MCP/Claude → Application (here) → Core state machine + Store.
 * This module owns transaction orchestration and SessionBinding interaction;
 * it never writes SQL and never sets run state directly — callers declare
 * events, the core decides stages.
 *
 * Two independent fencing domains apply to every run mutation and cannot
 * substitute for each other:
 *   - SessionBinding generation  → protects the ownership epoch (Phase 3)
 *   - PlanningRun revision       → protects the run-state epoch (this phase)
 * PlanningRun.revision is NOT the future Plan Memory HEAD.
 *
 * Mutation validation precedence (frozen plan §55, deterministic):
 *   1 run exists → 2 workspace exact → 3 writable binding/generation →
 *   4 lifecycle active → 5 expected revision → 6 transition legal → apply.
 */

import {
  isPlanningRunEvent,
  isTerminalLifecycle,
  nextStage,
  type PlanningRunEvent,
} from "../core/state-machine.js";
import { parsePlanningRunRow, type PlanningRun } from "../core/planning-run.js";
import { RuntimeError } from "../runtime/errors.js";
import type { StoreClock } from "../store/migration-runner.js";
import {
  assertWritableBindingInTx,
  insertAttachedBindingInTx,
  reattachBindingInTx,
  takeoverBindingInTx,
  type BindingSnapshot,
  type TakeoverInput,
} from "../store/session-bindings.js";
import {
  getPlanningRunForSessionRecord,
  getPlanningRunRecord,
  insertPlanningRunRecord,
  listPlanningRunsForWorkspaceRecord,
  runStateError,
} from "../store/planning-runs.js";
import type { PlanStore } from "../store/sqlite-store.js";

export interface CreatePlanningRunInput {
  workspaceId: string;
  sessionId: string;
  goal: string;
}

export interface RunMutationInput {
  runId: string;
  workspaceId: string;
  sessionId: string;
  bindingGeneration: number;
  expectedRevision: number;
}

export interface TransitionRunInput extends RunMutationInput {
  event: PlanningRunEvent;
}

export interface ReviseGoalInput extends RunMutationInput {
  goal: string;
}

export interface SessionRunInput {
  runId: string;
  workspaceId: string;
  sessionId: string;
}

export interface PlanningRunService {
  createPlanningRun(input: CreatePlanningRunInput): { run: PlanningRun; binding: BindingSnapshot };
  transitionRun(input: TransitionRunInput): PlanningRun;
  reviseDiscoveryGoal(input: ReviseGoalInput): PlanningRun;
  abortPlanningRun(input: RunMutationInput): PlanningRun;
  /** Exact-session reattach, permitted only for ACTIVE runs (§30). */
  reattachActiveRun(input: SessionRunInput): BindingSnapshot;
  /** Ownership takeover, permitted only for ACTIVE runs (§31). Internal only. */
  takeoverActiveRun(input: Omit<TakeoverInput, "workspaceId"> & { workspaceId: string }): BindingSnapshot;
  getPlanningRun(runId: string): PlanningRun | null;
  getPlanningRunForSession(sessionId: string): PlanningRun | null;
  listPlanningRunsForWorkspace(
    workspaceId: string,
    options?: { lifecycle?: PlanningRun["lifecycle"] },
  ): PlanningRun[];
}

const SELECT_RUN =
  "SELECT run_id AS runId, workspace_id AS workspaceId, lifecycle, stage, revision, goal, created_at AS createdAt, updated_at AS updatedAt FROM planning_runs";

export function createPlanningRunService(store: PlanStore, clock: StoreClock): PlanningRunService {
  function loadRunInTx(tx: { prepare(sql: string): { get(...params: unknown[]): unknown } }, runId: string): PlanningRun {
    const row = tx.prepare(`${SELECT_RUN} WHERE run_id = ?`).get(runId) as
      | Record<string, unknown>
      | undefined;
    if (row === undefined) {
      throw runStateError("RUN_NOT_FOUND", `no PlanningRun exists for '${runId}'`, { runId });
    }
    return parsePlanningRunRow(row);
  }

  function requireActive(run: PlanningRun): void {
    if (isTerminalLifecycle(run.lifecycle)) {
      throw runStateError(
        "RUN_TERMINAL",
        `PlanningRun '${run.runId}' is ${run.lifecycle} and can no longer mutate`,
        { runId: run.runId, lifecycle: run.lifecycle },
      );
    }
  }

  function bumpRunInTx(
    tx: { prepare(sql: string): { run(...params: unknown[]): unknown } },
    runId: string,
    expectedRevision: number,
    next: { stage?: PlanningRun["stage"]; lifecycle?: PlanningRun["lifecycle"]; goal?: string },
    now: string,
  ): number {
    const sets: string[] = ["revision = revision + 1", "updated_at = ?"];
    const params: unknown[] = [now];
    if (next.stage !== undefined) {
      sets.push("stage = ?");
      params.push(next.stage);
    }
    if (next.lifecycle !== undefined) {
      sets.push("lifecycle = ?");
      params.push(next.lifecycle);
    }
    if (next.goal !== undefined) {
      sets.push("goal = ?");
      params.push(next.goal);
    }
    params.push(runId, expectedRevision);
    tx.prepare(`UPDATE planning_runs SET ${sets.join(", ")} WHERE run_id = ? AND revision = ?`).run(...params);
    return expectedRevision + 1;
  }

  return {
    createPlanningRun(input: CreatePlanningRunInput) {
      if (input.goal.trim() === "") {
        throw runStateError("INVALID_RUN_GOAL", "PlanningRun goal must be a non-empty objective");
      }
      return store.withWrite((tx) => {
        const workspace = tx
          .prepare("SELECT workspace_id FROM workspaces WHERE workspace_id = ?")
          .get(input.workspaceId);
        if (workspace === undefined) {
          throw new RuntimeError("WORKSPACE_NOT_FOUND", `workspace '${input.workspaceId}' is not registered`, {
            detail: { workspaceId: input.workspaceId },
          });
        }
        // Legacy opaque bindings count: a session holding ANY attached
        // binding (even a schema-2 era target without a run) blocks creation
        // — fail-closed, never silently cleaned (§41).
        const now = clock.nowIso();
        const runId = `plan_${clock.newId()}`;
        const run = insertPlanningRunRecord(tx, { runId, workspaceId: input.workspaceId, goal: input.goal }, clock);
        const binding = insertAttachedBindingInTx(
          tx,
          { runId, workspaceId: input.workspaceId, sessionId: input.sessionId },
          now,
        );
        return { run, binding };
      });
    },

    transitionRun(input: TransitionRunInput) {
      if (!isPlanningRunEvent(input.event)) {
        throw runStateError("INVALID_RUN_TRANSITION", `unknown run event '${input.event}'`, {
          event: input.event,
        });
      }
      return store.withWrite((tx) => {
        const run = loadRunInTx(tx, input.runId);
        if (run.workspaceId !== input.workspaceId) {
          throw new RuntimeError("WORKSPACE_MISMATCH", `PlanningRun '${run.runId}' belongs to a different workspace`, {
            detail: { expected: run.workspaceId, detected: input.workspaceId },
          });
        }
        assertWritableBindingInTx(tx, {
          runId: input.runId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          generation: input.bindingGeneration,
        });
        requireActive(run);
        if (run.revision !== input.expectedRevision) {
          throw runStateError(
            "STALE_RUN_REVISION",
            `stale run revision ${input.expectedRevision} for '${run.runId}'; current is ${run.revision}`,
            { runId: run.runId, expected: input.expectedRevision, detected: run.revision },
          );
        }
        let targetStage;
        try {
          targetStage = nextStage(run.stage, input.event);
        } catch (err) {
          throw runStateError(
            "INVALID_RUN_TRANSITION",
            err instanceof Error ? err.message.replace("INVALID_RUN_TRANSITION:", "") : "invalid run transition",
            { runId: run.runId, stage: run.stage, event: input.event },
          );
        }
        const now = clock.nowIso();
        const revision = bumpRunInTx(tx, run.runId, run.revision, { stage: targetStage }, now);
        return { ...run, stage: targetStage, revision, updatedAt: now };
      });
    },

    reviseDiscoveryGoal(input: ReviseGoalInput) {
      if (input.goal.trim() === "") {
        throw runStateError("INVALID_RUN_GOAL", "PlanningRun goal must be a non-empty objective");
      }
      return store.withWrite((tx) => {
        const run = loadRunInTx(tx, input.runId);
        if (run.workspaceId !== input.workspaceId) {
          throw new RuntimeError("WORKSPACE_MISMATCH", `PlanningRun '${run.runId}' belongs to a different workspace`, {
            detail: { expected: run.workspaceId, detected: input.workspaceId },
          });
        }
        assertWritableBindingInTx(tx, {
          runId: input.runId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          generation: input.bindingGeneration,
        });
        requireActive(run);
        if (run.revision !== input.expectedRevision) {
          throw runStateError(
            "STALE_RUN_REVISION",
            `stale run revision ${input.expectedRevision} for '${run.runId}'; current is ${run.revision}`,
            { runId: run.runId, expected: input.expectedRevision, detected: run.revision },
          );
        }
        if (run.stage !== "discovery") {
          throw runStateError(
            "INVALID_RUN_TRANSITION",
            `goal revision is only available at stage discovery (run '${run.runId}' is at ${run.stage})`,
            { runId: run.runId, stage: run.stage },
          );
        }
        const now = clock.nowIso();
        const revision = bumpRunInTx(tx, run.runId, run.revision, { goal: input.goal }, now);
        return { ...run, goal: input.goal, revision, updatedAt: now };
      });
    },

    abortPlanningRun(input: RunMutationInput) {
      return store.withWrite((tx) => {
        const run = loadRunInTx(tx, input.runId);
        if (run.workspaceId !== input.workspaceId) {
          throw new RuntimeError("WORKSPACE_MISMATCH", `PlanningRun '${run.runId}' belongs to a different workspace`, {
            detail: { expected: run.workspaceId, detected: input.workspaceId },
          });
        }
        // Terminal check precedes the binding assert deliberately: an
        // idempotent abort retry (same fencing input after the first success)
        // must land on RUN_TERMINAL and never double-apply (§35) — the
        // binding is detached by then, which would otherwise mask the
        // terminal answer with BINDING_DETACHED.
        if (isTerminalLifecycle(run.lifecycle)) {
          throw runStateError(
            "RUN_TERMINAL",
            `PlanningRun '${run.runId}' is already ${run.lifecycle}`,
            { runId: run.runId, lifecycle: run.lifecycle },
          );
        }
        assertWritableBindingInTx(tx, {
          runId: input.runId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          generation: input.bindingGeneration,
        });
        if (run.revision !== input.expectedRevision) {
          throw runStateError(
            "STALE_RUN_REVISION",
            `stale run revision ${input.expectedRevision} for '${run.runId}'; current is ${run.revision}`,
            { runId: run.runId, expected: input.expectedRevision, detected: run.revision },
          );
        }
        const now = clock.nowIso();
        // ONE transaction: lifecycle flip + revision bump + binding detach
        // epoch — no stale-writer window between them (§33).
        const revision = bumpRunInTx(tx, run.runId, run.revision, { lifecycle: "aborted" }, now);
        const binding = tx
          .prepare(
            "SELECT run_id AS runId, workspace_id AS workspaceId, session_id AS sessionId, state, generation, created_at AS createdAt, updated_at AS updatedAt FROM session_bindings WHERE run_id = ?",
          )
          .get(input.runId) as
          | { runId: string; workspaceId: string; sessionId: string; state: "attached" | "detached"; generation: number; createdAt: string; updatedAt: string }
          | undefined;
        if (binding === undefined) {
          throw new RuntimeError("RUN_STATE_INVALID", `PlanningRun '${input.runId}' has no SessionBinding`, {
            detail: { runId: input.runId },
          });
        }
        tx.prepare(
          "UPDATE session_bindings SET state = 'detached', generation = generation + 1, updated_at = ? WHERE run_id = ? AND generation = ?",
        ).run(now, input.runId, binding.generation);
        return { ...run, lifecycle: "aborted" as const, revision, updatedAt: now };
      });
    },

    reattachActiveRun(input: SessionRunInput) {
      return store.withWrite((tx) => {
        const run = loadRunInTx(tx, input.runId);
        if (run.workspaceId !== input.workspaceId) {
          throw new RuntimeError("WORKSPACE_MISMATCH", `PlanningRun '${run.runId}' belongs to a different workspace`, {
            detail: { expected: run.workspaceId, detected: input.workspaceId },
          });
        }
        if (isTerminalLifecycle(run.lifecycle)) {
          throw runStateError(
            "RUN_TERMINAL",
            `PlanningRun '${run.runId}' is ${run.lifecycle}; detached terminal runs can never reattach`,
            { runId: run.runId, lifecycle: run.lifecycle },
          );
        }
        return reattachBindingInTx(tx, { runId: input.runId, sessionId: input.sessionId, workspaceId: input.workspaceId }, clock.nowIso());
      });
    },

    takeoverActiveRun(input) {
      return store.withWrite((tx) => {
        const run = loadRunInTx(tx, input.runId);
        if (run.workspaceId !== input.workspaceId) {
          throw new RuntimeError("WORKSPACE_MISMATCH", `PlanningRun '${run.runId}' belongs to a different workspace`, {
            detail: { expected: run.workspaceId, detected: input.workspaceId },
          });
        }
        if (isTerminalLifecycle(run.lifecycle)) {
          throw runStateError(
            "RUN_TERMINAL",
            `PlanningRun '${run.runId}' is ${run.lifecycle}; ownership takeover is unavailable`,
            { runId: run.runId, lifecycle: run.lifecycle },
          );
        }
        return takeoverBindingInTx(tx, input, clock.nowIso());
      });
    },

    getPlanningRun: (runId) => getPlanningRunRecord(store, runId),
    getPlanningRunForSession: (sessionId) => getPlanningRunForSessionRecord(store, sessionId),
    listPlanningRunsForWorkspace: (workspaceId, options) =>
      listPlanningRunsForWorkspaceRecord(store, workspaceId, options),
  };
}
