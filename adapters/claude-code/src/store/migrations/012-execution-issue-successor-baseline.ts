/**
 * Migration 012 — execution-issue-successor-baseline (Phase 15 directive §5).
 *
 * Adds the defect-report and successor-baseline domain over the delivered
 * execution contract. EVERY table of this domain is immutable append-only
 * history under no_update/no_delete triggers; there is deliberately NO
 * mutable operational table (unlike the v11 delivery state) because "open"
 * is a derived condition (§18): an issue is open exactly while no adoption
 * row exists for it.
 *
 *   execution_issues                        the immutable Build-discovered
 *                                           semantic defect report (§1/§7/§8);
 *                                           at most one per (run, operation)
 *                                           — the signed toolUseId is the
 *                                           idempotency identity (§15)
 *   execution_issue_refs                    exact approved FinalPlan closure
 *                                           refs (§9/§10 — exact revisions
 *                                           only, CHECK-constrained types)
 *   execution_issue_adoptions               append-only issue → successor-run
 *                                           binding (§17); UNIQUE(issue_id)
 *                                           is the DB correctness fence for
 *                                           the one-successor rule (§74)
 *   planning_run_baselines                  the immutable successor design
 *                                           anchor (§26) — exactly one per
 *                                           successor run (UNIQUE)
 *   planning_run_baseline_issues            the exact adopted issue set
 *                                           (§31), hashed into the baseline
 *   planning_run_baseline_scopes            the Core-derived affected scope
 *                                           (§32–§34/§55): per-Section
 *                                           inherited_completed | needs_review
 *                                           with the exact origin MemoryRef
 *   planning_run_baseline_materializations  the unique first-commit
 *                                           materialization record (§53):
 *                                           baseline → commit + snapshot
 *
 * Deliberately NOT created (§6): execution_steps, execution_progress,
 * execution_task_states, implementation_events, build_progress,
 * step_completions — Phase Plan is still not an execution orchestrator.
 * NO backfill (§83): legacy schema-11 completed runs receive no fabricated
 * issues or successor baselines; all v12 tables start empty.
 */

import type { StoreTx } from "../transaction.js";
import type { StoreMigration } from "./index.js";

export function createExecutionIssueSuccessorBaselineMigration(): StoreMigration {
  return {
    from: 11,
    to: 12,
    name: "execution-issue-successor-baseline",
    apply(tx: StoreTx): void {
      tx.exec(`
        CREATE TABLE execution_issues (
          run_id TEXT NOT NULL,
          issue_id TEXT NOT NULL,
          final_plan_id TEXT NOT NULL,
          final_plan_hash TEXT NOT NULL,
          handoff_id TEXT NOT NULL,
          handoff_hash TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN (
            'hard_constraint', 'invariant', 'approved_interface', 'section_contract',
            'approved_decision', 'explicit_dependency', 'architecture_choice',
            'critical_repository_assumption', 'missing_design_obligation')),
          summary TEXT NOT NULL,
          detail TEXT NOT NULL,
          canonical_json TEXT NOT NULL,
          issue_hash TEXT NOT NULL,
          repository_kind TEXT NOT NULL CHECK (repository_kind IN ('git', 'directory')),
          repository_revision TEXT,
          operation_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (run_id, issue_id),
          UNIQUE (run_id, operation_id),
          FOREIGN KEY (run_id) REFERENCES planning_runs(run_id),
          FOREIGN KEY (run_id, final_plan_id) REFERENCES final_plans(run_id, final_plan_id),
          FOREIGN KEY (run_id, handoff_id) REFERENCES execution_handoffs(run_id, handoff_id)
        )
      `);
      tx.exec(`
        CREATE TABLE execution_issue_refs (
          run_id TEXT NOT NULL,
          issue_id TEXT NOT NULL,
          position INTEGER NOT NULL CHECK (position >= 1),
          ref_type TEXT NOT NULL CHECK (ref_type IN ('architecture', 'section', 'section_contract', 'decision', 'constraint')),
          artifact_id TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK (revision >= 1),
          PRIMARY KEY (run_id, issue_id, position),
          FOREIGN KEY (run_id, issue_id) REFERENCES execution_issues(run_id, issue_id)
        )
      `);
      tx.exec(`
        CREATE TABLE execution_issue_adoptions (
          issue_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          successor_run_id TEXT NOT NULL,
          baseline_id TEXT NOT NULL,
          position INTEGER NOT NULL CHECK (position >= 1),
          created_at TEXT NOT NULL,
          PRIMARY KEY (issue_id),
          UNIQUE (issue_id),
          FOREIGN KEY (run_id, issue_id) REFERENCES execution_issues(run_id, issue_id),
          FOREIGN KEY (successor_run_id) REFERENCES planning_runs(run_id)
        )
      `);
      tx.exec(`
        CREATE TABLE planning_run_baselines (
          baseline_id TEXT PRIMARY KEY,
          successor_run_id TEXT NOT NULL UNIQUE,
          predecessor_run_id TEXT NOT NULL,
          final_plan_id TEXT NOT NULL,
          final_plan_hash TEXT NOT NULL,
          final_snapshot_id TEXT NOT NULL,
          final_commit_id TEXT NOT NULL,
          execution_handoff_id TEXT NOT NULL,
          execution_handoff_hash TEXT NOT NULL,
          issue_set_hash TEXT NOT NULL,
          repository_kind TEXT NOT NULL CHECK (repository_kind IN ('git', 'directory')),
          repository_revision TEXT,
          canonical_json TEXT NOT NULL,
          baseline_hash TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY (successor_run_id) REFERENCES planning_runs(run_id),
          FOREIGN KEY (predecessor_run_id) REFERENCES planning_runs(run_id)
        )
      `);
      tx.exec(`
        CREATE TABLE planning_run_baseline_issues (
          baseline_id TEXT NOT NULL,
          issue_id TEXT NOT NULL,
          position INTEGER NOT NULL CHECK (position >= 1),
          PRIMARY KEY (baseline_id, issue_id),
          FOREIGN KEY (baseline_id) REFERENCES planning_run_baselines(baseline_id),
          FOREIGN KEY (issue_id) REFERENCES execution_issue_adoptions(issue_id)
        )
      `);
      tx.exec(`
        CREATE TABLE planning_run_baseline_scopes (
          baseline_id TEXT NOT NULL,
          section_id TEXT NOT NULL,
          scope_state TEXT NOT NULL CHECK (scope_state IN ('inherited_completed', 'needs_review')),
          origin_run_id TEXT NOT NULL,
          origin_section_id TEXT NOT NULL,
          origin_revision INTEGER NOT NULL CHECK (origin_revision >= 1),
          PRIMARY KEY (baseline_id, section_id),
          FOREIGN KEY (baseline_id) REFERENCES planning_run_baselines(baseline_id)
        )
      `);
      tx.exec(`
        CREATE TABLE planning_run_baseline_materializations (
          baseline_id TEXT NOT NULL,
          materialized_commit_id TEXT NOT NULL,
          materialized_snapshot_id TEXT NOT NULL,
          origin_manifest_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (baseline_id),
          FOREIGN KEY (baseline_id) REFERENCES planning_run_baselines(baseline_id),
          FOREIGN KEY (materialized_commit_id) REFERENCES plan_commits(commit_id),
          FOREIGN KEY (materialized_snapshot_id) REFERENCES plan_snapshots(snapshot_id)
        )
      `);

      // §4/§7/§17/§26/§31/§53 — the entire v12 domain is append-only history.
      const immutable = [
        "execution_issues",
        "execution_issue_refs",
        "execution_issue_adoptions",
        "planning_run_baselines",
        "planning_run_baseline_issues",
        "planning_run_baseline_scopes",
        "planning_run_baseline_materializations",
      ];
      for (const table of immutable) {
        tx.exec(
          `CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} `
          + `BEGIN SELECT RAISE(ABORT, '${table} is immutable'); END`,
        );
        tx.exec(
          `CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} `
          + `BEGIN SELECT RAISE(ABORT, '${table} is immutable'); END`,
        );
      }

      tx.exec("CREATE INDEX idx_execution_issue_refs_issue ON execution_issue_refs (run_id, issue_id, position)");
      tx.exec("CREATE INDEX idx_execution_issue_adoptions_successor ON execution_issue_adoptions (successor_run_id)");
      tx.exec("CREATE INDEX idx_planning_run_baseline_issues_baseline ON planning_run_baseline_issues (baseline_id, position)");
      tx.exec("CREATE INDEX idx_planning_run_baseline_scopes_state ON planning_run_baseline_scopes (baseline_id, scope_state)");
    },
  };
}
