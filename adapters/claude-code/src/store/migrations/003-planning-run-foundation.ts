/**
 * Migration 003 — planning-run-foundation (frozen plan §4/§5).
 *
 * Adds exactly ONE planning-domain table: planning_runs. No
 * Architecture/Section/Decision/Proposal/Plan-Memory tables and no future
 * ref columns (architecture_id/head_commit/head_snapshot/active_stage
 * bookkeeping/handoff fields) — those arrive with their own phases via
 * further migrations.
 *
 * DDL-level invariants: lifecycle/stage vocabularies, revision >= 1,
 * non-empty goal, and `completed → stage = 'final'` (a normal completion can
 * only follow the final planning flow; aborted runs may rest at any last
 * valid stage).
 */

import type { StoreTx } from "../transaction.js";
import type { StoreMigration } from "./index.js";

export function createPlanningRunMigration(): StoreMigration {
  return {
    from: 2,
    to: 3,
    name: "planning-run-foundation",
    apply(tx: StoreTx): void {
      tx.exec(`
        CREATE TABLE planning_runs (
          run_id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
          lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active', 'completed', 'aborted')),
          stage TEXT NOT NULL CHECK (stage IN ('discovery', 'architecture', 'detail', 'synthesis', 'validation', 'final')),
          revision INTEGER NOT NULL CHECK (revision >= 1),
          goal TEXT NOT NULL CHECK (length(trim(goal)) > 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          CHECK (lifecycle != 'completed' OR stage = 'final')
        )
      `);
      tx.exec(`
        CREATE INDEX idx_planning_runs_workspace ON planning_runs (workspace_id)
      `);
    },
  };
}
