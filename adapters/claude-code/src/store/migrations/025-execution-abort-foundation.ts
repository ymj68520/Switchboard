/**
 * Migration 025 — execution-abort-foundation (v0.2.0 E13 §19/§41/§55–§57).
 *
 * The human-authorized ExecutionRun abort becomes representable durably:
 *
 *   verification_windows   closure_kind CHECK gains 'aborted'   (E13 §19)
 *   execution_run_events   CHECK gains 'ABORTED'                (E13 §41)
 *   execution_abort_records  NEW — the one-per-run durable abort
 *                            provenance binding the consumed
 *                            run-control authorization           (E13 §14/§15)
 *
 * SQLite cannot relax a column CHECK, so the same deferred-FK cluster dance
 * as migration 023 rebuilds the window/protocol tables: every body is the
 * v23 shape VERBATIM except the two CHECK extensions and the abort-records
 * creation; every row copies byte-identically (`SELECT *` — scope_kind and
 * closure_kind values are preserved, never inferred). No existing Run
 * becomes aborted, no open Window is closed, no historical accepted/
 * replan_required closure changes (E13 §56/§57). The external commit
 * references (execution_runs.accepted_head_commit_id / completion_commit_id,
 * execution_stages.completed_by_commit_id) detach for the duration of the
 * dance exactly as 023 did, and their triggers re-create verbatim.
 *
 * execution_abort_records enforces E13 §15 structurally: PRIMARY KEY (run_id)
 * allows at most one abort fact per run; UNIQUE (control_id) binds it to
 * EXACTLY ONE consumed run-control authorization (operation='abort', E13 §59).
 */

import type { StoreTx } from "../transaction.js";
import type { StoreMigration } from "./index.js";
import {
  ASSESSMENT_JUDGMENTS_V23,
  DROP_ORDER,
  EXECUTION_COMMITS_V23,
  EXECUTION_DIRECTIVES_V23,
  EXECUTION_REPORTS_V23,
  EXECUTION_RUN_EVENTS_V23,
  EXECUTION_ATTEMPTS_V23,
  NO_DELETE_TRIGGER,
  NO_UPDATE_TRIGGER,
  RENAME_ORDER,
  SCOPE_SHAPE_TRIGGER,
  SCOPE_UPDATE_SHAPE_TRIGGER,
  SUPERVISOR_ASSESSMENTS_V23,
  VERIFICATION_CONFLICTS_V23,
  VERIFICATION_WINDOWS_V23,
  WORKER_INVOCATIONS_V23,
  WORKER_INVOCATION_EVENTS_V23,
} from "./023-execution-scope-foundation.js";

/** The v25 window shape: ONLY the closure_kind CHECK extends (E13 §19). */
const VERIFICATION_WINDOWS_V25 = VERIFICATION_WINDOWS_V23.replace(
  "closure_kind IN ('accepted', 'replan_required')",
  "closure_kind IN ('accepted', 'replan_required', 'aborted')",
);

/** The v25 run-event shape: the ABORTED audit event joins the ledger (E13 §41). */
/** The v24-final invocation-events shape carries the E11 ROTATED vocabulary
 * (migration 024 rebuilt the table); the verbatim-023 body must extend. */
const WORKER_INVOCATION_EVENTS_V25 = WORKER_INVOCATION_EVENTS_V23.replace(
  "event_type IN ('PREPARED', 'CLAIMED', 'FINISHED')",
  "event_type IN ('PREPARED', 'CLAIMED', 'FINISHED', 'ROTATED')",
);

const EXECUTION_RUN_EVENTS_V25 = EXECUTION_RUN_EVENTS_V23.replace(
  "event_type IN ('PREPARED', 'ACTIVATED', 'REPLAN_REQUIRED', 'COMPLETED')",
  "event_type IN ('PREPARED', 'ACTIVATED', 'REPLAN_REQUIRED', 'COMPLETED', 'ABORTED')",
);

/** E13 §14/§15 — the one-to-one durable abort fact (audit provenance ONLY). */
const EXECUTION_ABORT_RECORDS_V25 = `
  run_id TEXT NOT NULL,
  control_id TEXT NOT NULL,
  requested_by_session_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  accepted_head_commit_id TEXT,
  active_stage_id TEXT,
  open_window_id TEXT,
  active_attempt_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id),
  UNIQUE (control_id),
  FOREIGN KEY (run_id) REFERENCES execution_runs(run_id),
  FOREIGN KEY (control_id) REFERENCES run_control_authorizations(control_id)
`;

interface RebuildSpec {
  canonical: string;
  body: string;
}

/** Same cluster as 023; windows + run_events carry the v25 bodies. */
const REBUILD_SPECS_V25: RebuildSpec[] = [
  { canonical: "verification_windows", body: VERIFICATION_WINDOWS_V25 },
  { canonical: "execution_directives", body: EXECUTION_DIRECTIVES_V23 },
  { canonical: "supervisor_assessments", body: SUPERVISOR_ASSESSMENTS_V23 },
  { canonical: "execution_commits", body: EXECUTION_COMMITS_V23 },
  { canonical: "execution_run_events", body: EXECUTION_RUN_EVENTS_V25 },
  { canonical: "execution_attempts", body: EXECUTION_ATTEMPTS_V23 },
  { canonical: "execution_reports", body: EXECUTION_REPORTS_V23 },
  { canonical: "verification_conflicts", body: VERIFICATION_CONFLICTS_V23 },
  { canonical: "execution_worker_invocations", body: WORKER_INVOCATIONS_V23 },
  { canonical: "execution_worker_invocation_events", body: WORKER_INVOCATION_EVENTS_V25 },
  { canonical: "supervisor_assessment_report_judgments", body: ASSESSMENT_JUDGMENTS_V23 },
];

export function createExecutionAbortFoundationMigration(): StoreMigration {
  return {
    from: 24,
    to: 25,
    name: "execution-abort-foundation",
    apply(tx: StoreTx): void {
      const tableExists = (name: string): boolean =>
        tx.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
      const columnExists = (table: string, column: string): boolean =>
        tableExists(table)
        && (tx.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>).some(
          (candidate) => candidate.name === column,
        );

      // The external commit-reference columns detach for the dance exactly as
      // migration 023 required (values captured, triggers dropped, columns
      // dropped, re-added + restored after the rename).
      const stageProvenance = columnExists("execution_stages", "completed_by_commit_id")
        ? (tx
            .prepare("SELECT id, completed_by_commit_id AS commitId FROM execution_stages WHERE completed_by_commit_id IS NOT NULL")
            .all() as Array<{ id: string; commitId: string }>)
        : [];
      const runHeads = columnExists("execution_runs", "accepted_head_commit_id")
        ? (tx
            .prepare("SELECT run_id AS runId, accepted_head_commit_id AS head FROM execution_runs WHERE accepted_head_commit_id IS NOT NULL")
            .all() as Array<{ runId: string; head: string }>)
        : [];
      const runCompletions = columnExists("execution_runs", "completion_commit_id")
        ? (tx
            .prepare("SELECT run_id AS runId, completion_commit_id AS commitId FROM execution_runs WHERE completion_commit_id IS NOT NULL")
            .all() as Array<{ runId: string; commitId: string }>)
        : [];
      tx.exec("DROP TRIGGER IF EXISTS execution_stages_completion_insert_shape");
      tx.exec("DROP TRIGGER IF EXISTS execution_stages_completion_consistent");
      tx.exec("DROP TRIGGER IF EXISTS execution_runs_completion_insert_shape");
      tx.exec("DROP TRIGGER IF EXISTS execution_runs_completion_shape");
      tx.exec("DROP TRIGGER IF EXISTS execution_runs_terminal_lifecycle");
      if (columnExists("execution_stages", "completed_by_commit_id")) {
        tx.exec("ALTER TABLE execution_stages DROP COLUMN completed_by_commit_id");
      }
      if (columnExists("execution_runs", "accepted_head_commit_id")) {
        tx.exec("ALTER TABLE execution_runs DROP COLUMN accepted_head_commit_id");
      }
      if (columnExists("execution_runs", "completion_commit_id")) {
        tx.exec("ALTER TABLE execution_runs DROP COLUMN completion_commit_id");
      }

      tx.exec("PRAGMA defer_foreign_keys = ON");

      for (const spec of REBUILD_SPECS_V25) {
        tx.exec(`CREATE TABLE ${spec.canonical}_new (${spec.body})`);
      }
      // Byte-identical copies: v24 stores already carry scope_kind/closure_kind
      // values; nothing is backfilled or inferred (E13 §56/§57).
      for (const spec of REBUILD_SPECS_V25) {
        if (tableExists(spec.canonical)) {
          tx.exec(`INSERT INTO ${spec.canonical}_new SELECT * FROM ${spec.canonical}`);
        }
      }
      for (const name of DROP_ORDER) {
        if (tableExists(name)) tx.exec(`DROP TABLE ${name}`);
      }
      for (const name of RENAME_ORDER) {
        tx.exec(`ALTER TABLE ${name}_new RENAME TO ${name}`);
      }

      // --- triggers + indexes: verbatim from 023's recreation block ---

      tx.exec(`
        CREATE TRIGGER verification_windows_identity_immutable BEFORE UPDATE ON verification_windows
        BEGIN
          SELECT RAISE(ABORT, 'verification window identity is immutable')
          WHERE OLD.run_id IS NOT NEW.run_id
             OR OLD.stage_id IS NOT NEW.stage_id
             OR OLD.scope_kind IS NOT NEW.scope_kind
             OR OLD.opened_at IS NOT NEW.opened_at;
        END
      `);
      tx.exec(`
        CREATE TRIGGER verification_windows_no_delete BEFORE DELETE ON verification_windows
        BEGIN SELECT RAISE(ABORT, 'verification_windows is immutable'); END
      `);
      tx.exec(`
        CREATE TRIGGER verification_windows_base_shape BEFORE INSERT ON verification_windows
        BEGIN
          SELECT RAISE(ABORT, 'window accepted-base shape is invalid')
          WHERE (NEW.base_kind = 'execution_start' AND NEW.base_commit_id IS NOT NULL)
             OR (NEW.base_kind = 'execution_commit' AND NEW.base_commit_id IS NULL);
        END
      `);
      tx.exec(`
        CREATE TRIGGER verification_windows_base_immutable BEFORE UPDATE ON verification_windows
        BEGIN
          SELECT RAISE(ABORT, 'window accepted base is immutable')
          WHERE OLD.base_kind IS NOT NEW.base_kind OR OLD.base_commit_id IS NOT NEW.base_commit_id;
        END
      `);
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
      tx.exec(SCOPE_SHAPE_TRIGGER("verification_windows"));
      tx.exec(SCOPE_UPDATE_SHAPE_TRIGGER("verification_windows"));
      tx.exec(
        "CREATE UNIQUE INDEX idx_verification_windows_open_run "
        + "ON verification_windows (run_id) WHERE closed_at IS NULL",
      );
      tx.exec("CREATE INDEX idx_verification_windows_run ON verification_windows (run_id, stage_id)");

      tx.exec(NO_UPDATE_TRIGGER("execution_directives"));
      tx.exec(NO_DELETE_TRIGGER("execution_directives"));
      tx.exec(SCOPE_SHAPE_TRIGGER("execution_directives"));
      tx.exec(SCOPE_UPDATE_SHAPE_TRIGGER("execution_directives"));
      tx.exec("CREATE INDEX idx_execution_directives_run ON execution_directives (run_id, issued_at, directive_id, revision)");

      tx.exec(NO_UPDATE_TRIGGER("supervisor_assessments"));
      tx.exec(NO_DELETE_TRIGGER("supervisor_assessments"));
      tx.exec(SCOPE_SHAPE_TRIGGER("supervisor_assessments"));
      tx.exec(SCOPE_UPDATE_SHAPE_TRIGGER("supervisor_assessments"));
      tx.exec(NO_UPDATE_TRIGGER("supervisor_assessment_report_judgments"));
      tx.exec(NO_DELETE_TRIGGER("supervisor_assessment_report_judgments"));
      tx.exec("CREATE INDEX idx_supervisor_assessments_window ON supervisor_assessments (window_id, candidate_revision, created_at)");
      tx.exec("CREATE INDEX idx_supervisor_assessment_report_judgments_report ON supervisor_assessment_report_judgments (report_id)");

      tx.exec(NO_UPDATE_TRIGGER("execution_commits"));
      tx.exec(NO_DELETE_TRIGGER("execution_commits"));
      tx.exec(SCOPE_SHAPE_TRIGGER("execution_commits"));
      tx.exec(SCOPE_UPDATE_SHAPE_TRIGGER("execution_commits"));
      tx.exec("CREATE INDEX idx_execution_commits_run ON execution_commits (run_id, sequence)");

      tx.exec(NO_UPDATE_TRIGGER("execution_run_events"));
      tx.exec(NO_DELETE_TRIGGER("execution_run_events"));
      tx.exec("CREATE INDEX idx_execution_run_events_run ON execution_run_events (run_id, event_seq)");

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
      tx.exec(NO_UPDATE_TRIGGER("execution_reports"));
      tx.exec(NO_DELETE_TRIGGER("execution_reports"));
      tx.exec(
        "CREATE UNIQUE INDEX idx_execution_attempts_running_run "
        + "ON execution_attempts (run_id) WHERE state = 'running'",
      );
      tx.exec("CREATE INDEX idx_execution_attempts_run ON execution_attempts (run_id, state)");

      tx.exec(`
        CREATE TRIGGER verification_conflicts_identity_immutable BEFORE UPDATE ON verification_conflicts
        BEGIN
          SELECT RAISE(ABORT, 'verification conflict binding is immutable')
          WHERE OLD.run_id IS NOT NEW.run_id
             OR OLD.window_id IS NOT NEW.window_id
             OR OLD.candidate_revision IS NOT NEW.candidate_revision
             OR OLD.fact IS NOT NEW.fact
             OR OLD.claims_json IS NOT NEW.claims_json
             OR OLD.fingerprint IS NOT NEW.fingerprint
             OR OLD.created_at IS NOT NEW.created_at;
          SELECT RAISE(ABORT, 'verification conflict resolution is immutable once settled')
          WHERE OLD.status IN ('resolved', 'verification_blocked')
            AND NEW.status IS NOT OLD.status;
          SELECT RAISE(ABORT, 'verification conflict resolution directive is immutable once bound')
          WHERE OLD.resolution_directive_id IS NOT NULL
            AND (NEW.resolution_directive_id IS NOT OLD.resolution_directive_id
              OR NEW.resolution_directive_revision IS NOT OLD.resolution_directive_revision);
          SELECT RAISE(ABORT, 'illegal verification conflict status transition')
          WHERE NOT (
            (OLD.status = 'open' AND NEW.status IN ('open', 'resolving'))
            OR (OLD.status = 'resolving' AND NEW.status IN ('resolving', 'resolved', 'verification_blocked'))
            OR (OLD.status = NEW.status)
          );
        END
      `);
      tx.exec(`
        CREATE TRIGGER verification_conflicts_no_delete BEFORE DELETE ON verification_conflicts
        BEGIN SELECT RAISE(ABORT, 'verification_conflicts is immutable'); END
      `);
      tx.exec("CREATE INDEX idx_verification_conflicts_window ON verification_conflicts (window_id, candidate_revision, status)");

      tx.exec(`
        CREATE TRIGGER execution_worker_invocations_identity_immutable BEFORE UPDATE ON execution_worker_invocations
        BEGIN
          SELECT RAISE(ABORT, 'worker invocation identity is immutable')
          WHERE OLD.attempt_id IS NOT NEW.attempt_id
             OR OLD.run_id IS NOT NEW.run_id
             OR OLD.worker_role IS NOT NEW.worker_role
             OR OLD.created_at IS NOT NEW.created_at
             OR (OLD.launch_token_hash IS NOT NEW.launch_token_hash
               AND NOT (OLD.state = 'prepared' AND NEW.state = 'prepared'
                 AND OLD.worker_session_id IS NULL AND NEW.worker_session_id IS NULL));
        END
      `);
      tx.exec(`
        CREATE TRIGGER execution_worker_invocations_session_immutable BEFORE UPDATE ON execution_worker_invocations
        BEGIN
          SELECT RAISE(ABORT, 'claimed worker session is set at most once')
          WHERE OLD.worker_session_id IS NOT NULL AND OLD.worker_session_id IS NOT NEW.worker_session_id;
        END
      `);
      tx.exec(`
        CREATE TRIGGER execution_worker_invocations_finished_terminal BEFORE UPDATE ON execution_worker_invocations
        BEGIN
          SELECT RAISE(ABORT, 'a finished invocation is terminal')
          WHERE OLD.state = 'finished' AND NEW.state != 'finished';
        END
      `);
      tx.exec(`
        CREATE TRIGGER execution_worker_invocations_no_delete BEFORE DELETE ON execution_worker_invocations
        BEGIN SELECT RAISE(ABORT, 'execution_worker_invocations is immutable'); END
      `);
      tx.exec(NO_UPDATE_TRIGGER("execution_worker_invocation_events"));
      tx.exec(NO_DELETE_TRIGGER("execution_worker_invocation_events"));
      tx.exec(
        "CREATE UNIQUE INDEX idx_worker_invocations_claimed_session "
        + "ON execution_worker_invocations (worker_session_id) WHERE state = 'claimed'",
      );
      tx.exec("CREATE INDEX idx_worker_invocations_run ON execution_worker_invocations (run_id, state)");
      tx.exec("CREATE INDEX idx_worker_invocation_events_attempt ON execution_worker_invocation_events (attempt_id, event_seq)");

      // External commit references re-attach + restore (023 verbatim).
      const commitRef = " TEXT REFERENCES execution_commits(commit_id)";
      if (!columnExists("execution_runs", "accepted_head_commit_id")) {
        tx.exec("ALTER TABLE execution_runs ADD COLUMN accepted_head_commit_id" + commitRef);
      }
      if (!columnExists("execution_runs", "completion_commit_id")) {
        tx.exec("ALTER TABLE execution_runs ADD COLUMN completion_commit_id" + commitRef);
      }
      for (const head of runHeads) {
        tx.prepare("UPDATE execution_runs SET accepted_head_commit_id = ? WHERE run_id = ?").run(head.head, head.runId);
      }
      for (const completion of runCompletions) {
        tx.prepare("UPDATE execution_runs SET completion_commit_id = ? WHERE run_id = ?").run(completion.commitId, completion.runId);
      }
      if (!columnExists("execution_stages", "completed_by_commit_id")) {
        tx.exec("ALTER TABLE execution_stages ADD COLUMN completed_by_commit_id" + commitRef);
      }
      for (const stage of stageProvenance) {
        tx.prepare("UPDATE execution_stages SET completed_by_commit_id = ? WHERE id = ?").run(stage.commitId, stage.id);
      }
      tx.exec(`
        CREATE TRIGGER execution_stages_completion_insert_shape BEFORE INSERT ON execution_stages
        BEGIN
          SELECT RAISE(ABORT, 'a stage cannot be created completed or with completion provenance')
          WHERE NEW.status = 'completed' OR NEW.completed_by_commit_id IS NOT NULL;
        END
      `);
      tx.exec(`
        CREATE TRIGGER execution_stages_completion_consistent BEFORE UPDATE ON execution_stages
        BEGIN
          SELECT RAISE(ABORT, 'stage completion provenance is immutable once set')
          WHERE OLD.completed_by_commit_id IS NOT NULL
            AND NEW.completed_by_commit_id IS NOT OLD.completed_by_commit_id;
          SELECT RAISE(ABORT, 'a completed stage is terminal')
          WHERE OLD.status = 'completed' AND NEW.status != 'completed';
          SELECT RAISE(ABORT, 'a completed stage requires its completion commit provenance')
          WHERE NEW.status = 'completed' AND NEW.completed_by_commit_id IS NULL;
          SELECT RAISE(ABORT, 'completion provenance requires the completed status')
          WHERE NEW.status != 'completed' AND NEW.completed_by_commit_id IS NOT NULL;
        END
      `);
      for (const trigger of [
        "execution_runs_completion_insert_shape",
        "execution_runs_completion_shape",
        "execution_runs_terminal_lifecycle",
      ]) {
        tx.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
      }
      tx.exec(`
        CREATE TRIGGER execution_runs_completion_insert_shape BEFORE INSERT ON execution_runs
        BEGIN
          SELECT RAISE(ABORT, 'execution run completion provenance shape is invalid')
          WHERE NEW.lifecycle = 'completed' OR NEW.completion_commit_id IS NOT NULL;
        END
      `);
      tx.exec(`
        CREATE TRIGGER execution_runs_completion_shape BEFORE UPDATE ON execution_runs
        BEGIN
          SELECT RAISE(ABORT, 'execution run completion provenance shape is invalid')
          WHERE (NEW.lifecycle = 'completed') != (NEW.completion_commit_id IS NOT NULL)
             OR (NEW.completion_commit_id IS NOT NULL
               AND NEW.completion_commit_id IS NOT NEW.accepted_head_commit_id);
        END
      `);
      tx.exec(`
        CREATE TRIGGER execution_runs_terminal_lifecycle BEFORE UPDATE ON execution_runs
        BEGIN
          SELECT RAISE(ABORT, 'a terminal ExecutionRun lifecycle is permanent')
          WHERE OLD.lifecycle IN ('completed', 'replan_required', 'aborted')
            AND NEW.lifecycle IS NOT OLD.lifecycle;
        END
      `);

      // E13 §14/§15 — the durable abort provenance (audit ONLY, never accepted
      // progress). Append-only like every audit ledger.
      if (!tableExists("execution_abort_records")) {
        tx.exec(`CREATE TABLE execution_abort_records (${EXECUTION_ABORT_RECORDS_V25})`);
        tx.exec(`
          CREATE TRIGGER execution_abort_records_no_update BEFORE UPDATE ON execution_abort_records
          BEGIN SELECT RAISE(ABORT, 'execution_abort_records is immutable'); END
        `);
        tx.exec(`
          CREATE TRIGGER execution_abort_records_no_delete BEFORE DELETE ON execution_abort_records
          BEGIN SELECT RAISE(ABORT, 'execution_abort_records is immutable'); END
        `);
      }
    },
  };
}
