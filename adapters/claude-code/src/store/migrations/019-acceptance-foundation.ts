/**
 * Migration 019 — acceptance-foundation (v0.2.0 E6 §55/§56).
 *
 * Adds the first authoritative accepted-progress layer:
 *
 *   supervisor_assessments                 the Supervisor's immutable semantic
 *                                          judgment over one exact Window +
 *                                          candidateRevision (E6 §4/§5).
 *                                          Append-only: a changed judgment is a
 *                                          NEW row; update/delete is impossible.
 *   supervisor_assessment_report_judgments per-Report classification of an
 *                                          assessment (E6 §10) — the
 *                                          anti-omission ledger. `superseded`
 *                                          requires a superseder + rationale
 *                                          (CHECK).
 *   execution_commits                      the ONLY object that advances
 *                                          accepted execution progress (E6
 *                                          §22). Linear chain per run:
 *                                          UNIQUE(run_id, sequence); at most
 *                                          one commit per Window
 *                                          (UNIQUE(window_id)); at most one
 *                                          commit per accept assessment
 *                                          (UNIQUE(supervisor_assessment_id)).
 *                                          No fake genesis row exists (E6 §23
 *                                          — the ExecutionRun's persisted
 *                                          executionStartBaseline is the
 *                                          pre-commit accepted base).
 *   execution_runs.accepted_head_commit_id nullable authoritative accepted
 *                                          head (E6 §25). NULL = the
 *                                          execution-start baseline is the
 *                                          accepted base. Only the ExecutionCommit
 *                                          transaction advances it — there is
 *                                          no setAcceptedHead path. The E1
 *                                          binding-immutable trigger does not
 *                                          cover this column, so the CAS
 *                                          advance is legal.
 *   verification_windows.base_kind /       the window's durable accepted base
 *   verification_windows.base_commit_id    (E6 §29). Every pre-E6 window
 *                                          backfills as execution_start
 *                                          (column DEFAULT) because no commit
 *                                          could exist before schema 19 (E6
 *                                          §30). Base columns are frozen at
 *                                          creation (trigger).
 *   execution_acceptance_events            append-only acceptance audit
 *                                          (ASSESSMENT_RECORDED /
 *                                          EXECUTION_COMMIT_CREATED), the
 *                                          repository's standard event-log
 *                                          convention (E6 §55).
 *
 * Deliberately NOT created (E6 §2/§55): stage-completion tables,
 * next-Stage activation, verification schedulers, conflict-resolution
 * orchestration, REPLAN_REQUIRED transitions, run-completion artifacts,
 * execution_observations. No SupervisorAssessment or ExecutionCommit is
 * fabricated for historical data (E6 §56): acceptedHead starts absent for
 * every migrated run.
 */

import type { StoreTx } from "../transaction.js";
import type { StoreMigration } from "./index.js";

export function createAcceptanceFoundationMigration(): StoreMigration {
  return {
    from: 18,
    to: 19,
    name: "acceptance-foundation",
    apply(tx: StoreTx): void {
      tx.exec(`
        CREATE TABLE supervisor_assessments (
          assessment_id TEXT NOT NULL PRIMARY KEY,
          run_id TEXT NOT NULL,
          stage_id TEXT NOT NULL,
          window_id TEXT NOT NULL,
          candidate_revision INTEGER NOT NULL CHECK (candidate_revision >= 0),
          disposition TEXT NOT NULL CHECK (
            disposition IN ('accept', 'rework', 'need_more_verification', 'blocked', 'request_replan')
          ),
          supervisor_session_id TEXT NOT NULL,
          supervisor_generation INTEGER NOT NULL CHECK (supervisor_generation >= 1),
          plan_refs_json TEXT NOT NULL,
          covered_obligations_json TEXT NOT NULL,
          rationale TEXT NOT NULL CHECK (rationale != ''),
          created_at TEXT NOT NULL,
          FOREIGN KEY (run_id) REFERENCES execution_runs(run_id),
          FOREIGN KEY (stage_id) REFERENCES execution_stages(id),
          FOREIGN KEY (window_id) REFERENCES verification_windows(id)
        )
      `);
      tx.exec(`
        CREATE TABLE supervisor_assessment_report_judgments (
          assessment_id TEXT NOT NULL,
          report_id TEXT NOT NULL,
          disposition TEXT NOT NULL CHECK (
            disposition IN ('supporting', 'informational', 'superseded', 'blocking')
          ),
          superseded_by_report_id TEXT,
          rationale TEXT,
          PRIMARY KEY (assessment_id, report_id),
          FOREIGN KEY (assessment_id) REFERENCES supervisor_assessments(assessment_id),
          FOREIGN KEY (report_id) REFERENCES execution_reports(report_id),
          CHECK (
            disposition != 'superseded'
            OR (superseded_by_report_id IS NOT NULL AND rationale IS NOT NULL AND rationale != '')
          )
        )
      `);
      tx.exec(`
        CREATE TABLE execution_commits (
          commit_id TEXT NOT NULL PRIMARY KEY,
          run_id TEXT NOT NULL,
          sequence INTEGER NOT NULL CHECK (sequence >= 1),
          parent_commit_id TEXT,
          stage_id TEXT NOT NULL,
          window_id TEXT NOT NULL,
          candidate_revision INTEGER NOT NULL CHECK (candidate_revision >= 0),
          supervisor_assessment_id TEXT NOT NULL,
          directive_refs_json TEXT NOT NULL,
          report_refs_json TEXT NOT NULL,
          satisfied_obligations_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY (run_id) REFERENCES execution_runs(run_id),
          FOREIGN KEY (parent_commit_id) REFERENCES execution_commits(commit_id),
          FOREIGN KEY (stage_id) REFERENCES execution_stages(id),
          FOREIGN KEY (window_id) REFERENCES verification_windows(id),
          FOREIGN KEY (supervisor_assessment_id) REFERENCES supervisor_assessments(assessment_id),
          UNIQUE (run_id, sequence),
          UNIQUE (window_id),
          UNIQUE (supervisor_assessment_id)
        )
      `);

      // E6 §5/§46 — an assessment and its judgments are append-only execution
      // memory: a changed judgment is a NEW assessment; no edit path exists.
      for (const table of ["supervisor_assessments", "supervisor_assessment_report_judgments"]) {
        tx.exec(
          `CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} `
          + `BEGIN SELECT RAISE(ABORT, '${table} is immutable'); END`,
        );
        tx.exec(
          `CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} `
          + `BEGIN SELECT RAISE(ABORT, '${table} is immutable'); END`,
        );
      }
      // E6 §46 — a commit is permanent accepted history: no amend, no re-parent.
      tx.exec(`
        CREATE TRIGGER execution_commits_no_update BEFORE UPDATE ON execution_commits
        BEGIN SELECT RAISE(ABORT, 'execution_commits is immutable'); END
      `);
      tx.exec(`
        CREATE TRIGGER execution_commits_no_delete BEFORE DELETE ON execution_commits
        BEGIN SELECT RAISE(ABORT, 'execution_commits is immutable'); END
      `);

      // E6 §55 — append-only acceptance audit.
      tx.exec(`
        CREATE TABLE execution_acceptance_events (
          run_id TEXT NOT NULL,
          event_seq INTEGER NOT NULL CHECK (event_seq >= 1),
          event_type TEXT NOT NULL CHECK (event_type IN ('ASSESSMENT_RECORDED', 'EXECUTION_COMMIT_CREATED')),
          assessment_id TEXT,
          commit_id TEXT,
          created_at TEXT NOT NULL,
          PRIMARY KEY (run_id, event_seq),
          FOREIGN KEY (run_id) REFERENCES execution_runs(run_id)
        )
      `);
      tx.exec(
        `CREATE TRIGGER execution_acceptance_events_no_update BEFORE UPDATE ON execution_acceptance_events `
        + `BEGIN SELECT RAISE(ABORT, 'execution_acceptance_events is immutable'); END`,
      );
      tx.exec(
        `CREATE TRIGGER execution_acceptance_events_no_delete BEFORE DELETE ON execution_acceptance_events `
        + `BEGIN SELECT RAISE(ABORT, 'execution_acceptance_events is immutable'); END`,
      );

      // E6 §25 — the authoritative accepted head. NULL = execution-start
      // baseline is the accepted base (pre-first-commit, and forever for runs
      // that never commit). Advanced ONLY by the ExecutionCommit CAS.
      tx.exec(
        "ALTER TABLE execution_runs ADD COLUMN accepted_head_commit_id TEXT "
        + "REFERENCES execution_commits(commit_id)",
      );

      // E6 §29/§30 — the durable per-Window accepted base. Every pre-E6 window
      // (genesis and any other) backfills to execution_start via the DEFAULT:
      // no commit could exist before schema 19. base_commit_id is NULL exactly
      // when base_kind is execution_start (trigger-enforced both directions).
      tx.exec(
        "ALTER TABLE verification_windows ADD COLUMN base_kind TEXT NOT NULL DEFAULT 'execution_start' "
        + "CHECK (base_kind IN ('execution_start', 'execution_commit'))",
      );
      tx.exec(
        "ALTER TABLE verification_windows ADD COLUMN base_commit_id TEXT "
        + "REFERENCES execution_commits(commit_id)",
      );
      tx.exec(`
        CREATE TRIGGER verification_windows_base_shape BEFORE INSERT ON verification_windows
        BEGIN
          SELECT RAISE(ABORT, 'window accepted-base shape is invalid')
          WHERE (NEW.base_kind = 'execution_start' AND NEW.base_commit_id IS NOT NULL)
             OR (NEW.base_kind = 'execution_commit' AND NEW.base_commit_id IS NULL);
        END
      `);
      // E6 §29 — a Window's base is frozen at creation: it never re-binds.
      tx.exec(`
        CREATE TRIGGER verification_windows_base_immutable BEFORE UPDATE ON verification_windows
        BEGIN
          SELECT RAISE(ABORT, 'window accepted base is immutable')
          WHERE OLD.base_kind IS NOT NEW.base_kind OR OLD.base_commit_id IS NOT NEW.base_commit_id;
        END
      `);

      tx.exec("CREATE INDEX idx_supervisor_assessments_window ON supervisor_assessments (window_id, candidate_revision, created_at)");
      tx.exec("CREATE INDEX idx_supervisor_assessment_report_judgments_report ON supervisor_assessment_report_judgments (report_id)");
      tx.exec("CREATE INDEX idx_execution_commits_run ON execution_commits (run_id, sequence)");
      tx.exec("CREATE INDEX idx_execution_acceptance_events_run ON execution_acceptance_events (run_id, event_seq)");
    },
  };
}
