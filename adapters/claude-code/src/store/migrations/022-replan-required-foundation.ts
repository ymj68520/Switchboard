/**
 * Migration 022 — replan-required-foundation (v0.2.0 E9 §21/§22/§45/§46).
 *
 * Three persistence families, all ADDITIVE in meaning:
 *
 *   verification_windows.closure_kind   null (open) | 'accepted' | 'replan_required'
 *                                       (E9 §21). Every pre-E9 CLOSED window was
 *                                       closed by an ExecutionCommit, so the
 *                                       backfill is deterministic: closed →
 *                                       'accepted', open → NULL. No historical
 *                                       meaning is guessed (E9 §22).
 *
 *   execution_issues (REBUILD)          the canonical v0.1 issue table gains the
 *                                       explicit 'replan_required' kind (E9 §45 —
 *                                       legacy rows are never rewritten into fake
 *                                       replan issues; the kind vocabulary gains
 *                                       the distinction), plus the v0.2 provenance
 *                                       columns (all NULL for legacy rows):
 *                                       issue_version (legacy rows = 1),
 *                                       execution_run_id, trigger_assessment_id,
 *                                       relevant_reports_json,
 *                                       accepted_history_json,
 *                                       execution_context_json.
 *                                       Rebuild via rename-and-copy so the child
 *                                       FKs (execution_issue_refs /
 *                                       execution_issue_adoptions) keep resolving
 *                                       to the canonical name; legacy rows copy
 *                                       byte-identically.
 *
 *   one replan issue per run            partial UNIQUE index — exactly one
 *                                       kind='replan_required' issue per
 *                                       ExecutionRun (E9 §25, DDL-enforced).
 *
 * Deliberately NOT added (E9 §2/§46): ExecutionRun-completion artifacts, final
 * verification artifacts, abort implementation, ExecutionObservation. The
 * successor PlanningRun linkage is NOT duplicated — the existing
 * execution_issue_adoptions / planning_run_baselines machinery is the durable
 * one-successor linkage and is reused wholesale (E9 §32).
 */

import type { StoreTx } from "../transaction.js";
import type { StoreMigration } from "./index.js";

export function createReplanRequiredFoundationMigration(): StoreMigration {
  return {
    from: 21,
    to: 22,
    name: "replan-required-foundation",
    apply(tx: StoreTx): void {
      // E9 §21/§22 — closure semantics with the deterministic backfill.
      tx.exec(
        "ALTER TABLE verification_windows ADD COLUMN closure_kind TEXT "
        + "CHECK (closure_kind IS NULL OR closure_kind IN ('accepted', 'replan_required'))",
      );
      tx.exec(
        "UPDATE verification_windows SET closure_kind = 'accepted' WHERE closed_at IS NOT NULL AND closure_kind IS NULL",
      );
      // Shape: open ↔ null kind; closed requires a kind (trigger-enforced both
      // directions; INSERTs of closed windows without a kind are refused).
      tx.exec(`
        CREATE TRIGGER verification_windows_closure_shape BEFORE UPDATE ON verification_windows
        BEGIN
          SELECT RAISE(ABORT, 'window closure shape is invalid')
          WHERE (NEW.closed_at IS NULL AND NEW.closure_kind IS NOT NULL)
             OR (NEW.closed_at IS NOT NULL AND NEW.closure_kind IS NULL);
        END
      `);
      tx.exec(`
        CREATE TRIGGER verification_windows_closure_insert_shape BEFORE INSERT ON verification_windows
        BEGIN
          SELECT RAISE(ABORT, 'window closure shape is invalid')
          WHERE (NEW.closed_at IS NULL AND NEW.closure_kind IS NOT NULL)
             OR (NEW.closed_at IS NOT NULL AND NEW.closure_kind IS NULL);
        END
      `);

      // Rewind self-sufficiency: the deep-rewind helpers strip these tables
      // without recreating them (they only drop), so create any MISSING
      // pre-022 shape here. On a normal v21 store all four exist and this is
      // a no-op. (The chain always runs 012–021 before 022, so a missing
      // table means a rewind artifact, never real absent state.)
      const tableExists = (name: string): boolean =>
        tx.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
      if (!tableExists("execution_issues")) {
        tx.exec(`
          CREATE TABLE execution_issues (
            run_id TEXT NOT NULL, issue_id TEXT NOT NULL, final_plan_id TEXT NOT NULL, final_plan_hash TEXT NOT NULL,
            handoff_id TEXT NOT NULL, handoff_hash TEXT NOT NULL,
            kind TEXT NOT NULL CHECK (kind IN ('hard_constraint','invariant','approved_interface','section_contract','approved_decision','explicit_dependency','architecture_choice','critical_repository_assumption','missing_design_obligation')),
            summary TEXT NOT NULL, detail TEXT NOT NULL, canonical_json TEXT NOT NULL, issue_hash TEXT NOT NULL,
            repository_kind TEXT NOT NULL CHECK (repository_kind IN ('git','directory')), repository_revision TEXT,
            operation_id TEXT NOT NULL, session_id TEXT NOT NULL, created_at TEXT NOT NULL,
            PRIMARY KEY (run_id, issue_id), UNIQUE (run_id, operation_id),
            FOREIGN KEY (run_id) REFERENCES planning_runs(run_id),
            FOREIGN KEY (run_id, final_plan_id) REFERENCES final_plans(run_id, final_plan_id),
            FOREIGN KEY (run_id, handoff_id) REFERENCES execution_handoffs(run_id, handoff_id)
          )
        `);
      }
      if (!tableExists("execution_issue_refs")) {
        tx.exec(`
          CREATE TABLE execution_issue_refs (
            run_id TEXT NOT NULL, issue_id TEXT NOT NULL, position INTEGER NOT NULL CHECK (position >= 1),
            ref_type TEXT NOT NULL CHECK (ref_type IN ('architecture','section','section_contract','decision','constraint')),
            artifact_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK (revision >= 1),
            PRIMARY KEY (run_id, issue_id, position),
            FOREIGN KEY (run_id, issue_id) REFERENCES execution_issues(run_id, issue_id)
          )
        `);
      }
      if (!tableExists("execution_issue_adoptions")) {
        tx.exec(`
          CREATE TABLE execution_issue_adoptions (
            issue_id TEXT NOT NULL, run_id TEXT NOT NULL, successor_run_id TEXT NOT NULL, baseline_id TEXT NOT NULL,
            position INTEGER NOT NULL CHECK (position >= 1), created_at TEXT NOT NULL,
            PRIMARY KEY (issue_id), UNIQUE (issue_id),
            FOREIGN KEY (run_id, issue_id) REFERENCES execution_issues(run_id, issue_id),
            FOREIGN KEY (successor_run_id) REFERENCES planning_runs(run_id)
          )
        `);
      }
      if (!tableExists("execution_run_events")) {
        tx.exec(`
          CREATE TABLE execution_run_events (
            run_id TEXT NOT NULL, event_seq INTEGER NOT NULL CHECK (event_seq >= 1),
            event_type TEXT NOT NULL CHECK (event_type IN ('PREPARED','ACTIVATED')),
            session_id TEXT, tool_use_id TEXT, detail_json TEXT, created_at TEXT NOT NULL,
            PRIMARY KEY (run_id, event_seq), FOREIGN KEY (run_id) REFERENCES execution_runs(run_id)
          )
        `);
      }

      // E9 §45/§46 — the canonical issue table gains the replan kind and the
      // v0.2 provenance columns. The rename-based rebuild rewrites child FKs
      // in modern SQLite, so all THREE tables (issues + refs + adoptions) are
      // rebuilt together: new tables with the extended shape, copy, drop the
      // originals (children before parent), then rename the new tables into
      // place — the parent rename rewrites the new children's FKs to the
      // canonical name. Legacy rows copy byte-identically (issue_version 1,
      // v2 columns NULL); nothing is fabricated.
      tx.exec(`
        CREATE TABLE execution_issues_new (
          run_id TEXT NOT NULL,
          issue_id TEXT NOT NULL,
          final_plan_id TEXT NOT NULL,
          final_plan_hash TEXT NOT NULL,
          handoff_id TEXT NOT NULL,
          handoff_hash TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN (
            'hard_constraint', 'invariant', 'approved_interface', 'section_contract',
            'approved_decision', 'explicit_dependency', 'architecture_choice',
            'critical_repository_assumption', 'missing_design_obligation',
            'replan_required')),
          summary TEXT NOT NULL,
          detail TEXT NOT NULL,
          canonical_json TEXT NOT NULL,
          issue_hash TEXT NOT NULL,
          repository_kind TEXT NOT NULL CHECK (repository_kind IN ('git', 'directory')),
          repository_revision TEXT,
          operation_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          issue_version INTEGER NOT NULL DEFAULT 1 CHECK (issue_version IN (1, 2)),
          execution_run_id TEXT,
          trigger_assessment_id TEXT,
          relevant_reports_json TEXT,
          accepted_history_json TEXT,
          execution_context_json TEXT,
          created_at TEXT NOT NULL,
          PRIMARY KEY (run_id, issue_id),
          UNIQUE (run_id, operation_id),
          FOREIGN KEY (run_id) REFERENCES planning_runs(run_id),
          FOREIGN KEY (run_id, final_plan_id) REFERENCES final_plans(run_id, final_plan_id),
          FOREIGN KEY (run_id, handoff_id) REFERENCES execution_handoffs(run_id, handoff_id)
        )
      `);
      tx.exec(`
        CREATE TABLE execution_issue_refs_new (
          run_id TEXT NOT NULL,
          issue_id TEXT NOT NULL,
          position INTEGER NOT NULL CHECK (position >= 1),
          ref_type TEXT NOT NULL CHECK (ref_type IN ('architecture', 'section', 'section_contract', 'decision', 'constraint')),
          artifact_id TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK (revision >= 1),
          PRIMARY KEY (run_id, issue_id, position),
          FOREIGN KEY (run_id, issue_id) REFERENCES execution_issues_new(run_id, issue_id)
        )
      `);
      tx.exec(`
        CREATE TABLE execution_issue_adoptions_new (
          issue_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          successor_run_id TEXT NOT NULL,
          baseline_id TEXT NOT NULL,
          position INTEGER NOT NULL CHECK (position >= 1),
          created_at TEXT NOT NULL,
          PRIMARY KEY (issue_id),
          UNIQUE (issue_id),
          FOREIGN KEY (run_id, issue_id) REFERENCES execution_issues_new(run_id, issue_id),
          FOREIGN KEY (successor_run_id) REFERENCES planning_runs(run_id)
        )
      `);
      tx.exec(
        "INSERT INTO execution_issues_new (run_id, issue_id, final_plan_id, final_plan_hash, handoff_id, handoff_hash, kind, "
        + "summary, detail, canonical_json, issue_hash, repository_kind, repository_revision, operation_id, session_id, "
        + "issue_version, execution_run_id, trigger_assessment_id, relevant_reports_json, accepted_history_json, "
        + "execution_context_json, created_at) "
        + "SELECT run_id, issue_id, final_plan_id, final_plan_hash, handoff_id, handoff_hash, kind, "
        + "summary, detail, canonical_json, issue_hash, repository_kind, repository_revision, operation_id, session_id, "
        + "1, NULL, NULL, NULL, NULL, NULL, created_at FROM execution_issues",
      );
      tx.exec("INSERT INTO execution_issue_refs_new SELECT run_id, issue_id, position, ref_type, artifact_id, revision FROM execution_issue_refs");
      tx.exec("INSERT INTO execution_issue_adoptions_new SELECT issue_id, run_id, successor_run_id, baseline_id, position, created_at FROM execution_issue_adoptions");
      tx.exec("DROP TABLE execution_issue_adoptions");
      tx.exec("DROP TABLE execution_issue_refs");
      tx.exec("DROP TABLE execution_issues");
      tx.exec("ALTER TABLE execution_issues_new RENAME TO execution_issues");
      tx.exec("ALTER TABLE execution_issue_refs_new RENAME TO execution_issue_refs");
      tx.exec("ALTER TABLE execution_issue_adoptions_new RENAME TO execution_issue_adoptions");
      // Recreate the immutability triggers and indexes the drops removed
      // (migration 012's conventions, verbatim).
      tx.exec(`
        CREATE TRIGGER execution_issues_no_update BEFORE UPDATE ON execution_issues
        BEGIN SELECT RAISE(ABORT, 'execution_issues is immutable'); END
      `);
      tx.exec(`
        CREATE TRIGGER execution_issues_no_delete BEFORE DELETE ON execution_issues
        BEGIN SELECT RAISE(ABORT, 'execution_issues is immutable'); END
      `);
      tx.exec(`
        CREATE TRIGGER execution_issue_refs_no_update BEFORE UPDATE ON execution_issue_refs
        BEGIN SELECT RAISE(ABORT, 'execution_issue_refs is immutable'); END
      `);
      tx.exec(`
        CREATE TRIGGER execution_issue_refs_no_delete BEFORE DELETE ON execution_issue_refs
        BEGIN SELECT RAISE(ABORT, 'execution_issue_refs is immutable'); END
      `);
      tx.exec(`
        CREATE TRIGGER execution_issue_adoptions_no_update BEFORE UPDATE ON execution_issue_adoptions
        BEGIN SELECT RAISE(ABORT, 'execution_issue_adoptions is immutable'); END
      `);
      tx.exec(`
        CREATE TRIGGER execution_issue_adoptions_no_delete BEFORE DELETE ON execution_issue_adoptions
        BEGIN SELECT RAISE(ABORT, 'execution_issue_adoptions is immutable'); END
      `);
      tx.exec("CREATE INDEX idx_execution_issue_refs_issue ON execution_issue_refs (run_id, issue_id, position)");
      tx.exec("CREATE INDEX idx_execution_issue_adoptions_successor ON execution_issue_adoptions (successor_run_id)");
      // E9 §26 — the REPLAN_REQUIRED audit event joins the run-event ledger:
      // the frozen two-value CHECK rebuilds with the third event type (no
      // children reference this table; legacy rows copy byte-identically).
      tx.exec(`
        CREATE TABLE execution_run_events_new (
          run_id TEXT NOT NULL,
          event_seq INTEGER NOT NULL CHECK (event_seq >= 1),
          event_type TEXT NOT NULL CHECK (event_type IN ('PREPARED', 'ACTIVATED', 'REPLAN_REQUIRED')),
          session_id TEXT,
          tool_use_id TEXT,
          detail_json TEXT,
          created_at TEXT NOT NULL,
          PRIMARY KEY (run_id, event_seq),
          FOREIGN KEY (run_id) REFERENCES execution_runs(run_id)
        )
      `);
      tx.exec("INSERT INTO execution_run_events_new SELECT run_id, event_seq, event_type, session_id, tool_use_id, detail_json, created_at FROM execution_run_events");
      tx.exec("DROP TABLE execution_run_events");
      tx.exec("ALTER TABLE execution_run_events_new RENAME TO execution_run_events");
      // Recreate the v14 immutability triggers + lookup index the drop removed.
      tx.exec(`
        CREATE TRIGGER execution_run_events_no_update BEFORE UPDATE ON execution_run_events
        BEGIN SELECT RAISE(ABORT, 'execution_run_events is immutable'); END
      `);
      tx.exec(`
        CREATE TRIGGER execution_run_events_no_delete BEFORE DELETE ON execution_run_events
        BEGIN SELECT RAISE(ABORT, 'execution_run_events is immutable'); END
      `);
      tx.exec("CREATE INDEX idx_execution_run_events_run ON execution_run_events (run_id, event_seq)");

      // (the execution_issue_refs index lives on the CHILD table and survived
      // the parent rebuild — it must not be recreated.)
      // E9 §25 — exactly ONE authoritative replan issue per ExecutionRun.
      tx.exec(
        "CREATE UNIQUE INDEX idx_execution_issues_replan_per_run "
        + "ON execution_issues (run_id) WHERE kind = 'replan_required'",
      );
    },
  };
}
