/**
 * Migration 014 — execution-run-foundation (v0.2.0 architecture spec §8–§11,
 * E1 phase §4–§10).
 *
 * Adds the durable execution lifecycle over the approved FinalPlan:
 *
 *   execution_runs        the canonical ExecutionRun (spec §11): ONE durable
 *                         execution instance per E1 handoff, permanently bound
 *                         to one exact FinalPlan revision (id@revision + hash)
 *                         in one stable WorkspaceIdentity. PRIMARY KEY(run_id)
 *                         makes the initial handoff creation idempotent at the
 *                         DDL level — a retried handoff resolves to the same
 *                         row, never a duplicate (E1 phase §9).
 *   execution_run_events  append-only lifecycle audit — PREPARED, ACTIVATED
 *                         only in E1; the reserved terminal events belong to
 *                         their owning phases.
 *
 * The FinalPlan binding (final_plan_id/revision/hash), the workspace binding,
 * and both baselines are IMMUTABLE after creation: a partial-update trigger
 * aborts any statement that would change them, so "rebind an existing
 * ExecutionRun to another FinalPlan" has no write path at all (architecture
 * §52 invariant 5). lifecycle/revision/updated_at are the ONLY mutable
 * surface and mutate exclusively through Core-validated transitions.
 *
 * Deliberately NOT created (E1 phase §8/§20): ExecutionStage,
 * VerificationWindow, ExecutionDirective, ExecutionAttempt, ExecutionReport,
 * SupervisorAssessment, ExecutionCommit tables, and no acceptedHead /
 * activeStage / openWindow columns — later migrations add them when their
 * owning phases arrive. PlanningRun lifecycle is NOT touched: a migrated
 * run keeps its lifecycle and no ExecutionRun is fabricated for history.
 */

import type { StoreTx } from "../transaction.js";
import type { StoreMigration } from "./index.js";

export function createExecutionRunMigration(): StoreMigration {
  return {
    from: 13,
    to: 14,
    name: "execution-run-foundation",
    apply(tx: StoreTx): void {
      tx.exec(`
        CREATE TABLE execution_runs (
          execution_run_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          final_plan_id TEXT NOT NULL,
          final_plan_revision INTEGER NOT NULL CHECK (final_plan_revision >= 1),
          final_plan_hash TEXT NOT NULL,
          lifecycle TEXT NOT NULL CHECK (lifecycle IN ('prepared', 'active', 'completed', 'replan_required', 'aborted')),
          planning_baseline_json TEXT NOT NULL,
          execution_start_baseline_json TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK (revision >= 1),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (run_id),
          UNIQUE (execution_run_id),
          FOREIGN KEY (run_id) REFERENCES planning_runs(run_id),
          FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id),
          FOREIGN KEY (run_id, final_plan_id) REFERENCES final_plans(run_id, final_plan_id)
        )
      `);
      tx.exec(`
        CREATE TABLE execution_run_events (
          run_id TEXT NOT NULL,
          event_seq INTEGER NOT NULL CHECK (event_seq >= 1),
          event_type TEXT NOT NULL CHECK (event_type IN ('PREPARED', 'ACTIVATED')),
          session_id TEXT,
          tool_use_id TEXT,
          detail_json TEXT,
          created_at TEXT NOT NULL,
          PRIMARY KEY (run_id, event_seq),
          FOREIGN KEY (run_id) REFERENCES execution_runs(run_id)
        )
      `);

      // The execution identity binding is permanent: any UPDATE that would
      // move the row to another run/workspace/FinalPlan/baseline is aborted
      // at the DDL level. Only lifecycle/revision/updated_at may change.
      tx.exec(`
        CREATE TRIGGER execution_runs_binding_immutable BEFORE UPDATE ON execution_runs
        BEGIN
          SELECT RAISE(ABORT, 'execution run binding is immutable')
          WHERE OLD.run_id IS NOT NEW.run_id
             OR OLD.workspace_id IS NOT NEW.workspace_id
             OR OLD.final_plan_id IS NOT NEW.final_plan_id
             OR OLD.final_plan_revision IS NOT NEW.final_plan_revision
             OR OLD.final_plan_hash IS NOT NEW.final_plan_hash
             OR OLD.planning_baseline_json IS NOT NEW.planning_baseline_json
             OR OLD.execution_start_baseline_json IS NOT NEW.execution_start_baseline_json
             OR OLD.created_at IS NOT NEW.created_at;
        END
      `);
      tx.exec(`
        CREATE TRIGGER execution_runs_no_delete BEFORE DELETE ON execution_runs
        BEGIN SELECT RAISE(ABORT, 'execution_runs is immutable'); END
      `);
      for (const table of ["execution_run_events"]) {
        tx.exec(
          `CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} `
          + `BEGIN SELECT RAISE(ABORT, '${table} is immutable'); END`,
        );
        tx.exec(
          `CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} `
          + `BEGIN SELECT RAISE(ABORT, '${table} is immutable'); END`,
        );
      }

      tx.exec(
        "CREATE INDEX idx_execution_run_events_run ON execution_run_events (run_id, event_seq)",
      );
    },
  };
}
