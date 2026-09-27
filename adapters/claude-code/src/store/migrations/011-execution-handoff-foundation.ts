/**
 * Migration 011 — execution-handoff-foundation (Phase 14 directive §11–§20).
 *
 * Adds the execution domain over the approved FinalPlan:
 *
 *   execution_handoffs         the immutable deterministic execution contract
 *                              derived from one approved FinalPlan (§12/§13);
 *                              at most one canonical handoff per run and per
 *                              FinalPlan (UNIQUE constraints, §12)
 *   execution_handoff_events   append-only handoff audit (§16) — PREPARED,
 *                              DELIVERY_ATTEMPT, DELIVERED only; no
 *                              SET_STATUS/FORCE_DELIVERED vocabulary exists
 *   execution_handoff_states   the materialized operational delivery state
 *                              (§14/§17) — the ONLY mutable table of this
 *                              domain; mutated exclusively by appending an
 *                              event and updating the state in one transaction
 *   execution_bindings         the ExecutionBinding (§18/§19): current-session
 *                              Build read authority with its own generation
 *                              epoch (§20); at most one binding per FinalPlan
 *                              (PK) and at most one ATTACHED binding per
 *                              session (partial unique index)
 *
 * Deliberately NOT created (§11): execution_issues, execution_progress,
 * execution_steps, build_tasks, build_events — Phase Plan never orchestrates
 * execution (§109). PlanningRun lifecycle is NOT touched by the migration
 * (§99): a migrated approved FinalPlan stays active/final with handoffPending
 * derived true and no fabricated handoff (§73/§74 — legacy completed runs are
 * never given handoffs or bindings).
 */

import type { StoreTx } from "../transaction.js";
import type { StoreMigration } from "./index.js";

export function createExecutionHandoffMigration(): StoreMigration {
  return {
    from: 10,
    to: 11,
    name: "execution-handoff-foundation",
    apply(tx: StoreTx): void {
      tx.exec(`
        CREATE TABLE execution_handoffs (
          run_id TEXT NOT NULL,
          handoff_id TEXT NOT NULL,
          final_plan_id TEXT NOT NULL,
          final_plan_hash TEXT NOT NULL,
          canonical_json TEXT NOT NULL,
          handoff_hash TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (run_id, handoff_id),
          UNIQUE (run_id),
          UNIQUE (final_plan_id),
          FOREIGN KEY (run_id) REFERENCES planning_runs(run_id),
          FOREIGN KEY (run_id, final_plan_id) REFERENCES final_plans(run_id, final_plan_id)
        )
      `);
      tx.exec(`
        CREATE TABLE execution_handoff_events (
          run_id TEXT NOT NULL,
          handoff_id TEXT NOT NULL,
          event_seq INTEGER NOT NULL CHECK (event_seq >= 1),
          event_type TEXT NOT NULL CHECK (event_type IN ('PREPARED', 'DELIVERY_ATTEMPT', 'DELIVERED')),
          session_id TEXT,
          tool_use_id TEXT,
          detail_json TEXT,
          created_at TEXT NOT NULL,
          PRIMARY KEY (run_id, handoff_id, event_seq),
          FOREIGN KEY (run_id, handoff_id) REFERENCES execution_handoffs(run_id, handoff_id)
        )
      `);
      tx.exec(`
        CREATE TABLE execution_handoff_states (
          run_id TEXT NOT NULL,
          handoff_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('prepared', 'delivered')),
          last_event_seq INTEGER NOT NULL CHECK (last_event_seq >= 1),
          current_attempt_tool_use_id TEXT,
          delivered_at TEXT,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (run_id, handoff_id),
          FOREIGN KEY (run_id, handoff_id) REFERENCES execution_handoffs(run_id, handoff_id)
        )
      `);
      tx.exec(`
        CREATE TABLE execution_bindings (
          run_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          final_plan_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('attached', 'detached')),
          generation INTEGER NOT NULL CHECK (generation >= 1),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (final_plan_id),
          UNIQUE (run_id),
          FOREIGN KEY (run_id) REFERENCES planning_runs(run_id),
          FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id),
          FOREIGN KEY (run_id, final_plan_id) REFERENCES final_plans(run_id, final_plan_id)
        )
      `);

      // §13 — the handoff contract is a permanent result: append-only events,
      // immutable handoff rows. The operational state table and the binding
      // table are deliberately NOT trigger-guarded (§14/§20 — they mutate via
      // the audited append-event + update pattern / generation epochs).
      for (const table of ["execution_handoffs", "execution_handoff_events"]) {
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
        "CREATE INDEX idx_execution_handoff_events_handoff "
        + "ON execution_handoff_events (run_id, handoff_id, event_seq)",
      );
      tx.exec(
        "CREATE UNIQUE INDEX idx_execution_bindings_active_session "
        + "ON execution_bindings (session_id) WHERE state = 'attached'",
      );
      tx.exec("CREATE INDEX idx_execution_bindings_session ON execution_bindings (session_id)");
    },
  };
}
