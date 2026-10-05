/**
 * Migration 017 — execution-protocol-foundation (v0.2.0 architecture spec,
 * E4 §43/§44).
 *
 * Adds the durable work protocol under the active ExecutionRun:
 *
 *   execution_directives      immutable EXACT instruction revisions. PRIMARY
 *                             KEY (directive_id, revision) — one row per exact
 *                             revision, never updated in place (E4 §8/§11);
 *                             a revision is a new INSERT. Every revision binds
 *                             the exact run / FinalPlan / Stage / Window /
 *                             baseCandidateRevision authority context (E4 §6)
 *                             and its accepted base kind (E4 §5 — in E4 only
 *                             'execution_start'; 'execution_commit' is
 *                             future-compatible vocabulary so E5/E6 can bind
 *                             real commits WITHOUT rewriting historical E4
 *                             Directive meaning).
 *   execution_attempts        ONE logical Attempt per EXACT Directive revision
 *                             (UNIQUE(directive_id, directive_revision), E4
 *                             §17) with the composite FK pinning the attempt
 *                             to that exact revision row. The partial unique
 *                             index enforces AT MOST ONE state=running Attempt
 *                             per ExecutionRun (E4 §18) — no concurrent
 *                             logical Workers in v0.2.0.
 *   execution_reports         the ONE immutable unified Executor/Verifier
 *                             report per Attempt (UNIQUE(attempt_id), E4
 *                             §23/§24) with the structured result vocabulary,
 *                             the factual candidate_mutated flag, and
 *                             structured findings/deviations/blockers/etc.
 *   execution_protocol_events append-only protocol audit — DIRECTIVE_ISSUED,
 *                             ATTEMPT_STARTED, ATTEMPT_REPORTED,
 *                             ATTEMPT_INDETERMINATE.
 *
 * Deliberately NOT created (E4 §2/§43): execution_commits,
 * supervisor_assessments, accepted_head, verification_results,
 * execution_observations. No report can create accepted execution progress —
 * there is no acceptedHead anywhere.
 *
 * NO backfill (E4 §44): all protocol tables start EMPTY for pre-existing runs;
 * nothing is fabricated from conversation/history. Planning lifecycle is NOT
 * touched. No window close/accept and no Stage completion path is added.
 */

import type { StoreTx } from "../transaction.js";
import type { StoreMigration } from "./index.js";

export function createExecutionProtocolMigration(): StoreMigration {
  return {
    from: 16,
    to: 17,
    name: "execution-protocol-foundation",
    apply(tx: StoreTx): void {
      tx.exec(`
        CREATE TABLE execution_directives (
          directive_id TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK (revision >= 1),
          directive_hash TEXT NOT NULL,
          run_id TEXT NOT NULL,
          final_plan_id TEXT NOT NULL,
          final_plan_revision INTEGER NOT NULL CHECK (final_plan_revision >= 1),
          final_plan_hash TEXT NOT NULL,
          stage_id TEXT NOT NULL,
          window_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('implementation', 'inspection', 'verification')),
          base_candidate_revision INTEGER NOT NULL CHECK (base_candidate_revision >= 0),
          accepted_base_kind TEXT NOT NULL CHECK (accepted_base_kind IN ('execution_start', 'execution_commit')),
          accepted_base_json TEXT NOT NULL,
          objective TEXT NOT NULL,
          plan_refs_json TEXT NOT NULL,
          expected_scope_json TEXT NOT NULL,
          capability_envelope_json TEXT NOT NULL,
          invariants_json TEXT NOT NULL,
          required_actions_json TEXT NOT NULL,
          forbidden_actions_json TEXT NOT NULL,
          validation_requirements_json TEXT NOT NULL,
          deliverables_json TEXT NOT NULL,
          stop_conditions_json TEXT NOT NULL,
          report_contract_json TEXT NOT NULL,
          body TEXT NOT NULL,
          issued_at TEXT NOT NULL,
          PRIMARY KEY (directive_id, revision),
          FOREIGN KEY (run_id) REFERENCES execution_runs(run_id),
          FOREIGN KEY (run_id, final_plan_id) REFERENCES final_plans(run_id, final_plan_id),
          FOREIGN KEY (stage_id) REFERENCES execution_stages(id),
          FOREIGN KEY (window_id) REFERENCES verification_windows(id)
        )
      `);
      tx.exec(`
        CREATE TABLE execution_attempts (
          attempt_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          directive_id TEXT NOT NULL,
          directive_revision INTEGER NOT NULL CHECK (directive_revision >= 1),
          directive_hash TEXT NOT NULL,
          worker_role TEXT NOT NULL CHECK (worker_role IN ('executor', 'verifier')),
          state TEXT NOT NULL CHECK (state IN ('running', 'reported', 'indeterminate')),
          started_at TEXT NOT NULL,
          ended_at TEXT,
          PRIMARY KEY (attempt_id),
          UNIQUE (directive_id, directive_revision),
          FOREIGN KEY (run_id) REFERENCES execution_runs(run_id),
          FOREIGN KEY (directive_id, directive_revision) REFERENCES execution_directives(directive_id, revision)
        )
      `);
      tx.exec(`
        CREATE TABLE execution_reports (
          report_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          attempt_id TEXT NOT NULL,
          directive_id TEXT NOT NULL,
          directive_revision INTEGER NOT NULL CHECK (directive_revision >= 1),
          directive_hash TEXT NOT NULL,
          worker_role TEXT NOT NULL CHECK (worker_role IN ('executor', 'verifier')),
          result TEXT NOT NULL CHECK (result IN ('completed', 'partial', 'blocked', 'failed')),
          candidate_mutated INTEGER NOT NULL CHECK (candidate_mutated IN (0, 1)),
          actions_json TEXT NOT NULL,
          files_examined_json TEXT NOT NULL,
          files_changed_json TEXT NOT NULL,
          commands_json TEXT NOT NULL,
          tests_json TEXT NOT NULL,
          findings_json TEXT NOT NULL,
          deviations_json TEXT NOT NULL,
          blockers_json TEXT NOT NULL,
          deliverables_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (report_id),
          UNIQUE (attempt_id),
          FOREIGN KEY (run_id) REFERENCES execution_runs(run_id),
          FOREIGN KEY (attempt_id) REFERENCES execution_attempts(attempt_id)
        )
      `);
      tx.exec(`
        CREATE TABLE execution_protocol_events (
          run_id TEXT NOT NULL,
          event_seq INTEGER NOT NULL CHECK (event_seq >= 1),
          event_type TEXT NOT NULL CHECK (event_type IN ('DIRECTIVE_ISSUED', 'ATTEMPT_STARTED', 'ATTEMPT_REPORTED', 'ATTEMPT_INDETERMINATE')),
          directive_id TEXT,
          directive_revision INTEGER,
          attempt_id TEXT,
          created_at TEXT NOT NULL,
          PRIMARY KEY (run_id, event_seq),
          FOREIGN KEY (run_id) REFERENCES execution_runs(run_id)
        )
      `);

      // A Directive revision is a historical immutable artifact: NOTHING may
      // change after issuance. To revise, INSERT a new revision row.
      tx.exec(`
        CREATE TRIGGER execution_directives_no_update BEFORE UPDATE ON execution_directives
        BEGIN SELECT RAISE(ABORT, 'execution_directives is immutable'); END
      `);
      tx.exec(`
        CREATE TRIGGER execution_directives_no_delete BEFORE DELETE ON execution_directives
        BEGIN SELECT RAISE(ABORT, 'execution_directives is immutable'); END
      `);
      // Attempt identity (which exact Directive revision/role it runs) is
      // permanent; only state/ended_at may change, through Core transitions.
      tx.exec(`
        CREATE TRIGGER execution_attempts_identity_immutable BEFORE UPDATE ON execution_attempts
        BEGIN
          SELECT RAISE(ABORT, 'execution attempt identity is immutable')
          WHERE OLD.attempt_id IS NOT NEW.attempt_id
             OR OLD.run_id IS NOT NEW.run_id
             OR OLD.directive_id IS NOT NEW.directive_id
             OR OLD.directive_revision IS NOT NEW.directive_revision
             OR OLD.directive_hash IS NOT NEW.directive_hash
             OR OLD.worker_role IS NOT NEW.worker_role
             OR OLD.started_at IS NOT NEW.started_at;
        END
      `);
      tx.exec(`
        CREATE TRIGGER execution_attempts_no_delete BEFORE DELETE ON execution_attempts
        BEGIN SELECT RAISE(ABORT, 'execution_attempts is immutable'); END
      `);
      // A Report is immutable after persistence (E4 §24): no edit/append/
      // replace path exists at ANY layer.
      tx.exec(`
        CREATE TRIGGER execution_reports_no_update BEFORE UPDATE ON execution_reports
        BEGIN SELECT RAISE(ABORT, 'execution_reports is immutable'); END
      `);
      tx.exec(`
        CREATE TRIGGER execution_reports_no_delete BEFORE DELETE ON execution_reports
        BEGIN SELECT RAISE(ABORT, 'execution_reports is immutable'); END
      `);
      for (const table of ["execution_protocol_events"]) {
        tx.exec(
          `CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} `
          + `BEGIN SELECT RAISE(ABORT, '${table} is immutable'); END`,
        );
        tx.exec(
          `CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} `
          + `BEGIN SELECT RAISE(ABORT, '${table} is immutable'); END`,
        );
      }

      // E4 §18 — at most ONE running Attempt per ExecutionRun (DDL-enforced).
      tx.exec(
        "CREATE UNIQUE INDEX idx_execution_attempts_running_run "
        + "ON execution_attempts (run_id) WHERE state = 'running'",
      );
      tx.exec("CREATE INDEX idx_execution_directives_run ON execution_directives (run_id, issued_at, directive_id, revision)");
      tx.exec("CREATE INDEX idx_execution_attempts_run ON execution_attempts (run_id, state)");
      tx.exec("CREATE INDEX idx_execution_protocol_events_run ON execution_protocol_events (run_id, event_seq)");
    },
  };
}
