/**
 * Migration 023 — execution-scope-foundation (v0.2.0 E10 §5–§8/§15–§18/§31/
 * §34/§43/§61/§62).
 *
 * The execution protocol gains an explicit execution scope: every Window,
 * Directive, SupervisorAssessment, and ExecutionCommit is either
 * `stage`-scoped (historical and ordinary execution — stage_id NOT NULL) or
 * `final_closure`-scoped (the run-level final closure — stage_id IS NULL,
 * E10 §5/§6). The shape biconditional is DDL-enforced by INSERT/UPDATE
 * triggers on each table; a synthetic Stage row is never created (E10 §4).
 *
 *   verification_windows   stage_id → NULLable + scope_kind   (E10 §7)
 *   execution_directives   stage_id → NULLable + scope_kind +
 *                          protocol_version CHECK (1, 2, 3)   (E10 §15/§17)
 *   supervisor_assessments stage_id → NULLable + scope_kind   (E10 §31)
 *   execution_commits      stage_id → NULLable + scope_kind   (E10 §34)
 *   execution_run_events   CHECK gains 'COMPLETED'            (E10 §42)
 *   execution_runs         + completion_commit_id (NULLable, E10 §43)
 *
 * Historical rows migrate deterministically (E10 §62): scope_kind = 'stage',
 * stage_id unchanged, v1/v2 Directive hashes untouched (the scope columns are
 * compatibility metadata — canonical hashing dispatches on the stored
 * protocol_version and the v1/v2 canonicalizers are frozen). Existing
 * replan_required runs keep completion_commit_id = NULL; NO Final Closure
 * Window is fabricated during migration.
 *
 * SQLite cannot relax a NOT NULL column, so all four scope tables rebuild.
 * They are mutually referencing (windows.base_commit_id → commits;
 * commits.window_id → windows; assessments/commits/conflicts → windows and
 * directives; attempts/reports/invocations/judgments → the same cluster), so
 * the whole cluster rebuilds in ONE deferred-FK dance: create `_new` tables
 * referencing `_new` names, copy every row byte-identically, drop the
 * originals (children first), rename the `_new` tables into place — the
 * renames rewrite the children's FK targets to the canonical names — then
 * recreate every trigger and index. `PRAGMA defer_foreign_keys` makes the
 * circular references (window base ↔ commit window) legal until COMMIT.
 */

import type { StoreTx } from "../transaction.js";
import type { StoreMigration } from "./index.js";

/** The scope-kind column every scope table carries (E10 §5/§6). */
export const SCOPE_KIND_DDL = "scope_kind TEXT NOT NULL DEFAULT 'stage' CHECK (scope_kind IN ('stage', 'final_closure'))";

export const SCOPE_SHAPE_TRIGGER = (table: string): string => `
  CREATE TRIGGER ${table}_scope_insert_shape BEFORE INSERT ON ${table}
  BEGIN
    SELECT RAISE(ABORT, '${table} execution scope shape is invalid')
    WHERE (NEW.scope_kind = 'stage' AND NEW.stage_id IS NULL)
       OR (NEW.scope_kind = 'final_closure' AND NEW.stage_id IS NOT NULL);
  END
`;

export const SCOPE_UPDATE_SHAPE_TRIGGER = (table: string): string => `
  CREATE TRIGGER ${table}_scope_update_shape BEFORE UPDATE ON ${table}
  BEGIN
    SELECT RAISE(ABORT, '${table} execution scope shape is invalid')
    WHERE (NEW.scope_kind = 'stage' AND NEW.stage_id IS NULL)
       OR (NEW.scope_kind = 'final_closure' AND NEW.stage_id IS NOT NULL);
  END
`;

export const NO_UPDATE_TRIGGER = (table: string): string => `
  CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table}
  BEGIN SELECT RAISE(ABORT, '${table} is immutable'); END
`;

export const NO_DELETE_TRIGGER = (table: string): string => `
  CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table}
  BEGIN SELECT RAISE(ABORT, '${table} is immutable'); END
`;

// ---------------------------------------------------------------------------
// v23 table bodies. The `_new` variants reference the `_new` names; the
// renames rewrite them to canonical. Unchanged tables keep their original
// migration DDL verbatim (only the FK target names move).
// ---------------------------------------------------------------------------

export const VERIFICATION_WINDOWS_V23 = `
  id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  stage_id TEXT,
  ${SCOPE_KIND_DDL},
  candidate_revision INTEGER NOT NULL CHECK (candidate_revision >= 0),
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  base_kind TEXT NOT NULL DEFAULT 'execution_start'
    CHECK (base_kind IN ('execution_start', 'execution_commit')),
  base_commit_id TEXT REFERENCES execution_commits_new(commit_id),
  closure_kind TEXT CHECK (closure_kind IS NULL OR closure_kind IN ('accepted', 'replan_required')),
  PRIMARY KEY (id),
  FOREIGN KEY (run_id) REFERENCES execution_runs(run_id),
  FOREIGN KEY (stage_id) REFERENCES execution_stages(id)
`;

export const EXECUTION_DIRECTIVES_V23 = `
  directive_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  directive_hash TEXT NOT NULL,
  run_id TEXT NOT NULL,
  final_plan_id TEXT NOT NULL,
  final_plan_revision INTEGER NOT NULL CHECK (final_plan_revision >= 1),
  final_plan_hash TEXT NOT NULL,
  stage_id TEXT,
  ${SCOPE_KIND_DDL},
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
  protocol_version INTEGER NOT NULL DEFAULT 1 CHECK (protocol_version IN (1, 2, 3)),
  verification_requirement TEXT,
  verification_purpose TEXT,
  verification_conflict_id TEXT,
  PRIMARY KEY (directive_id, revision),
  FOREIGN KEY (run_id) REFERENCES execution_runs(run_id),
  FOREIGN KEY (run_id, final_plan_id) REFERENCES final_plans(run_id, final_plan_id),
  FOREIGN KEY (stage_id) REFERENCES execution_stages(id),
  FOREIGN KEY (window_id) REFERENCES verification_windows_new(id)
`;

export const SUPERVISOR_ASSESSMENTS_V23 = `
  assessment_id TEXT NOT NULL PRIMARY KEY,
  run_id TEXT NOT NULL,
  stage_id TEXT,
  ${SCOPE_KIND_DDL},
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
  FOREIGN KEY (window_id) REFERENCES verification_windows_new(id)
`;

export const EXECUTION_COMMITS_V23 = `
  commit_id TEXT NOT NULL PRIMARY KEY,
  run_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  parent_commit_id TEXT,
  stage_id TEXT,
  ${SCOPE_KIND_DDL},
  window_id TEXT NOT NULL,
  candidate_revision INTEGER NOT NULL CHECK (candidate_revision >= 0),
  supervisor_assessment_id TEXT NOT NULL,
  directive_refs_json TEXT NOT NULL,
  report_refs_json TEXT NOT NULL,
  satisfied_obligations_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES execution_runs(run_id),
  FOREIGN KEY (parent_commit_id) REFERENCES execution_commits_new(commit_id),
  FOREIGN KEY (stage_id) REFERENCES execution_stages(id),
  FOREIGN KEY (window_id) REFERENCES verification_windows_new(id),
  FOREIGN KEY (supervisor_assessment_id) REFERENCES supervisor_assessments_new(assessment_id),
  UNIQUE (run_id, sequence),
  UNIQUE (window_id),
  UNIQUE (supervisor_assessment_id)
`;

export const EXECUTION_RUN_EVENTS_V23 = `
  run_id TEXT NOT NULL,
  event_seq INTEGER NOT NULL CHECK (event_seq >= 1),
  event_type TEXT NOT NULL CHECK (event_type IN ('PREPARED', 'ACTIVATED', 'REPLAN_REQUIRED', 'COMPLETED')),
  session_id TEXT,
  tool_use_id TEXT,
  detail_json TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, event_seq),
  FOREIGN KEY (run_id) REFERENCES execution_runs(run_id)
`;

export const EXECUTION_ATTEMPTS_V23 = `
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
  FOREIGN KEY (directive_id, directive_revision) REFERENCES execution_directives_new(directive_id, revision)
`;

export const EXECUTION_REPORTS_V23 = `
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
  FOREIGN KEY (attempt_id) REFERENCES execution_attempts_new(attempt_id)
`;

export const VERIFICATION_CONFLICTS_V23 = `
  conflict_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  window_id TEXT NOT NULL,
  candidate_revision INTEGER NOT NULL CHECK (candidate_revision >= 0),
  fact TEXT NOT NULL CHECK (fact != ''),
  claims_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'resolving', 'resolved', 'verification_blocked')),
  resolution_directive_id TEXT,
  resolution_directive_revision INTEGER,
  resolution_report_id TEXT,
  fingerprint TEXT NOT NULL UNIQUE,
  rationale TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  PRIMARY KEY (conflict_id),
  FOREIGN KEY (run_id) REFERENCES execution_runs(run_id),
  FOREIGN KEY (window_id) REFERENCES verification_windows_new(id),
  FOREIGN KEY (resolution_directive_id, resolution_directive_revision)
    REFERENCES execution_directives_new(directive_id, revision),
  FOREIGN KEY (resolution_report_id) REFERENCES execution_reports_new(report_id),
  CHECK (
    (status = 'open'
      AND resolution_directive_id IS NULL AND resolution_report_id IS NULL AND resolved_at IS NULL)
    OR (status = 'resolving'
      AND resolution_directive_id IS NOT NULL AND resolution_report_id IS NULL AND resolved_at IS NULL)
    OR (status = 'resolved'
      AND resolution_directive_id IS NOT NULL AND resolution_report_id IS NOT NULL
      AND resolved_at IS NOT NULL AND rationale IS NOT NULL AND rationale != '')
    OR (status = 'verification_blocked'
      AND resolution_directive_id IS NOT NULL AND resolution_report_id IS NOT NULL
      AND resolved_at IS NOT NULL AND rationale IS NOT NULL AND rationale != '')
  )
`;

export const WORKER_INVOCATIONS_V23 = `
  attempt_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  worker_role TEXT NOT NULL CHECK (worker_role IN ('executor', 'verifier')),
  state TEXT NOT NULL CHECK (state IN ('prepared', 'claimed', 'finished')),
  worker_session_id TEXT,
  worker_agent_id TEXT,
  launch_token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  claimed_at TEXT,
  finished_at TEXT,
  PRIMARY KEY (attempt_id),
  FOREIGN KEY (attempt_id) REFERENCES execution_attempts_new(attempt_id),
  FOREIGN KEY (run_id) REFERENCES execution_runs(run_id)
`;

export const WORKER_INVOCATION_EVENTS_V23 = `
  attempt_id TEXT NOT NULL,
  event_seq INTEGER NOT NULL CHECK (event_seq >= 1),
  event_type TEXT NOT NULL CHECK (event_type IN ('PREPARED', 'CLAIMED', 'FINISHED')),
  worker_session_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (attempt_id, event_seq),
  FOREIGN KEY (attempt_id) REFERENCES execution_worker_invocations_new(attempt_id)
`;

export const ASSESSMENT_JUDGMENTS_V23 = `
  assessment_id TEXT NOT NULL,
  report_id TEXT NOT NULL,
  disposition TEXT NOT NULL CHECK (
    disposition IN ('supporting', 'informational', 'superseded', 'blocking')
  ),
  superseded_by_report_id TEXT,
  rationale TEXT,
  PRIMARY KEY (assessment_id, report_id),
  FOREIGN KEY (assessment_id) REFERENCES supervisor_assessments_new(assessment_id),
  FOREIGN KEY (report_id) REFERENCES execution_reports_new(report_id),
  CHECK (
    disposition != 'superseded'
    OR (superseded_by_report_id IS NOT NULL AND rationale IS NOT NULL AND rationale != '')
  )
`;

/**
 * The rebuild spec: canonical name, v23 body, and — for the four scope
 * tables — the explicit copy SQL that backfills scope_kind = 'stage'
 * (E10 §62). Children copy by identical column order.
 */
export const REBUILD_SPECS: Array<{
  canonical: string;
  body: string;
  copy?: string;
}> = [
  {
    canonical: "verification_windows",
    body: VERIFICATION_WINDOWS_V23,
    copy:
      "INSERT INTO verification_windows_new (id, run_id, stage_id, scope_kind, candidate_revision, opened_at, "
      + "closed_at, base_kind, base_commit_id, closure_kind) "
      + "SELECT id, run_id, stage_id, 'stage', candidate_revision, opened_at, closed_at, base_kind, "
      + "base_commit_id, closure_kind FROM verification_windows",
  },
  {
    canonical: "execution_directives",
    body: EXECUTION_DIRECTIVES_V23,
    copy:
      "INSERT INTO execution_directives_new (directive_id, revision, directive_hash, run_id, final_plan_id, "
      + "final_plan_revision, final_plan_hash, stage_id, scope_kind, window_id, kind, base_candidate_revision, "
      + "accepted_base_kind, accepted_base_json, objective, plan_refs_json, expected_scope_json, "
      + "capability_envelope_json, invariants_json, required_actions_json, forbidden_actions_json, "
      + "validation_requirements_json, deliverables_json, stop_conditions_json, report_contract_json, body, "
      + "issued_at, protocol_version, verification_requirement, verification_purpose, verification_conflict_id) "
      + "SELECT directive_id, revision, directive_hash, run_id, final_plan_id, final_plan_revision, "
      + "final_plan_hash, stage_id, 'stage', window_id, kind, base_candidate_revision, accepted_base_kind, "
      + "accepted_base_json, objective, plan_refs_json, expected_scope_json, capability_envelope_json, "
      + "invariants_json, required_actions_json, forbidden_actions_json, validation_requirements_json, "
      + "deliverables_json, stop_conditions_json, report_contract_json, body, issued_at, protocol_version, "
      + "verification_requirement, verification_purpose, verification_conflict_id FROM execution_directives",
  },
  {
    canonical: "supervisor_assessments",
    body: SUPERVISOR_ASSESSMENTS_V23,
    copy:
      "INSERT INTO supervisor_assessments_new (assessment_id, run_id, stage_id, scope_kind, window_id, "
      + "candidate_revision, disposition, supervisor_session_id, supervisor_generation, plan_refs_json, "
      + "covered_obligations_json, rationale, created_at) "
      + "SELECT assessment_id, run_id, stage_id, 'stage', window_id, candidate_revision, disposition, "
      + "supervisor_session_id, supervisor_generation, plan_refs_json, covered_obligations_json, rationale, "
      + "created_at FROM supervisor_assessments",
  },
  {
    canonical: "execution_commits",
    body: EXECUTION_COMMITS_V23,
    copy:
      "INSERT INTO execution_commits_new (commit_id, run_id, sequence, parent_commit_id, stage_id, scope_kind, "
      + "window_id, candidate_revision, supervisor_assessment_id, directive_refs_json, report_refs_json, "
      + "satisfied_obligations_json, created_at) "
      + "SELECT commit_id, run_id, sequence, parent_commit_id, stage_id, 'stage', window_id, "
      + "candidate_revision, supervisor_assessment_id, directive_refs_json, report_refs_json, "
      + "satisfied_obligations_json, created_at FROM execution_commits",
  },
  { canonical: "execution_run_events", body: EXECUTION_RUN_EVENTS_V23, copy: "INSERT INTO execution_run_events_new SELECT * FROM execution_run_events" },
  { canonical: "execution_attempts", body: EXECUTION_ATTEMPTS_V23, copy: "INSERT INTO execution_attempts_new SELECT * FROM execution_attempts" },
  { canonical: "execution_reports", body: EXECUTION_REPORTS_V23, copy: "INSERT INTO execution_reports_new SELECT * FROM execution_reports" },
  { canonical: "verification_conflicts", body: VERIFICATION_CONFLICTS_V23, copy: "INSERT INTO verification_conflicts_new SELECT * FROM verification_conflicts" },
  { canonical: "execution_worker_invocations", body: WORKER_INVOCATIONS_V23, copy: "INSERT INTO execution_worker_invocations_new SELECT * FROM execution_worker_invocations" },
  { canonical: "execution_worker_invocation_events", body: WORKER_INVOCATION_EVENTS_V23, copy: "INSERT INTO execution_worker_invocation_events_new SELECT * FROM execution_worker_invocation_events" },
  { canonical: "supervisor_assessment_report_judgments", body: ASSESSMENT_JUDGMENTS_V23, copy: "INSERT INTO supervisor_assessment_report_judgments_new SELECT * FROM supervisor_assessment_report_judgments" },
];

/** Children drop before parents; parents rename before children. */
export const DROP_ORDER = [
  "execution_worker_invocation_events",
  "execution_worker_invocations",
  "supervisor_assessment_report_judgments",
  "execution_reports",
  "verification_conflicts",
  "execution_attempts",
  "execution_run_events",
  "execution_commits",
  "supervisor_assessments",
  "execution_directives",
  "verification_windows",
];

export const RENAME_ORDER = [
  "verification_windows",
  "execution_directives",
  "supervisor_assessments",
  "execution_commits",
  "execution_run_events",
  "execution_attempts",
  "execution_reports",
  "verification_conflicts",
  "execution_worker_invocations",
  "execution_worker_invocation_events",
  "supervisor_assessment_report_judgments",
];

export function createExecutionScopeFoundationMigration(): StoreMigration {
  return {
    from: 22,
    to: 23,
    name: "execution-scope-foundation",
    apply(tx: StoreTx): void {
      const tableExists = (name: string): boolean =>
        tx.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
      const columnExists = (table: string, column: string): boolean =>
        tableExists(table)
        && (tx.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>).some(
          (candidate) => candidate.name === column,
        );

      // The commits table has two EXTERNAL children the dance cannot rebuild:
      // execution_runs.accepted_head_commit_id and
      // execution_stages.completed_by_commit_id. Deferred FKs count a parent
      // drop as an unresolved violation (renaming the replacement into place
      // never clears the counter), so the two reference columns detach for the
      // duration of the dance: values are captured in memory, the columns drop
      // (with their referencing triggers), and they re-ADD against the
      // canonical commits table after the rename, values restored. Nothing is
      // lost or fabricated — every captured row is written back or the
      // migration fails.
      const stageProvenance =
        columnExists("execution_stages", "completed_by_commit_id")
          ? (tx
              .prepare("SELECT id, completed_by_commit_id AS commitId FROM execution_stages WHERE completed_by_commit_id IS NOT NULL")
              .all() as Array<{ id: string; commitId: string }>)
          : [];
      const runHeads =
        columnExists("execution_runs", "accepted_head_commit_id")
          ? (tx
              .prepare("SELECT run_id AS runId, accepted_head_commit_id AS head FROM execution_runs WHERE accepted_head_commit_id IS NOT NULL")
              .all() as Array<{ runId: string; head: string }>)
          : [];
      const runCompletions =
        columnExists("execution_runs", "completion_commit_id")
          ? (tx
              .prepare("SELECT run_id AS runId, completion_commit_id AS commitId FROM execution_runs WHERE completion_commit_id IS NOT NULL")
              .all() as Array<{ runId: string; commitId: string }>)
          : [];
      // The stage-completion triggers reference the column; the run terminal/
      // completion triggers reference both columns (v23-world rewind
      // artifacts). They all re-create after the dance.
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

      // The windows.base ↔ commit.window reference cycle (plus the wide
      // directive/assessment/attempt/report cluster) makes strict insert-drop
      // ordering impossible; every FK resolves by COMMIT, when the renamed
      // cluster is fully populated and consistent.
      tx.exec("PRAGMA defer_foreign_keys = ON");

      // One dance over the whole cluster: create EVERY `_new` shape first
      // (their FKs reference each other's `_new` names — a missing parent
      // table is a hard error at copy time even with deferred FKs), then copy
      // (with the deterministic 'stage' scope backfill), drop the original,
      // rename. A table that is missing entirely (deep-rewind artifact — the
      // chain always runs 016–022 before 023 on real stores) is created at
      // v23 shape directly through the same `_new` + rename path with no copy.
      for (const spec of REBUILD_SPECS) {
        tx.exec(`CREATE TABLE ${spec.canonical}_new (${spec.body})`);
      }
      for (const spec of REBUILD_SPECS) {
        if (tableExists(spec.canonical)) {
          tx.exec(spec.copy ?? `INSERT INTO ${spec.canonical}_new SELECT * FROM ${spec.canonical}`);
        }
      }
      for (const name of DROP_ORDER) {
        if (tableExists(name)) tx.exec(`DROP TABLE ${name}`);
      }
      for (const name of RENAME_ORDER) {
        tx.exec(`ALTER TABLE ${name}_new RENAME TO ${name}`);
      }

      // --- triggers + indexes (verbatim from their origin migrations, with
      // the E10 scope-shape additions; windows identity now covers scope) ---

      // verification_windows (016 identity/no-delete + 019 base + 022 closure).
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

      // execution_directives (017 + 021 policy columns + E10 scope + v3).
      tx.exec(NO_UPDATE_TRIGGER("execution_directives"));
      tx.exec(NO_DELETE_TRIGGER("execution_directives"));
      tx.exec(SCOPE_SHAPE_TRIGGER("execution_directives"));
      tx.exec(SCOPE_UPDATE_SHAPE_TRIGGER("execution_directives"));
      tx.exec("CREATE INDEX idx_execution_directives_run ON execution_directives (run_id, issued_at, directive_id, revision)");

      // supervisor_assessments + judgments (019).
      tx.exec(NO_UPDATE_TRIGGER("supervisor_assessments"));
      tx.exec(NO_DELETE_TRIGGER("supervisor_assessments"));
      tx.exec(SCOPE_SHAPE_TRIGGER("supervisor_assessments"));
      tx.exec(SCOPE_UPDATE_SHAPE_TRIGGER("supervisor_assessments"));
      tx.exec(NO_UPDATE_TRIGGER("supervisor_assessment_report_judgments"));
      tx.exec(NO_DELETE_TRIGGER("supervisor_assessment_report_judgments"));
      tx.exec("CREATE INDEX idx_supervisor_assessments_window ON supervisor_assessments (window_id, candidate_revision, created_at)");
      tx.exec("CREATE INDEX idx_supervisor_assessment_report_judgments_report ON supervisor_assessment_report_judgments (report_id)");

      // execution_commits (019).
      tx.exec(NO_UPDATE_TRIGGER("execution_commits"));
      tx.exec(NO_DELETE_TRIGGER("execution_commits"));
      tx.exec(SCOPE_SHAPE_TRIGGER("execution_commits"));
      tx.exec(SCOPE_UPDATE_SHAPE_TRIGGER("execution_commits"));
      tx.exec("CREATE INDEX idx_execution_commits_run ON execution_commits (run_id, sequence)");

      // execution_run_events (014/022 — now with COMPLETED).
      tx.exec(NO_UPDATE_TRIGGER("execution_run_events"));
      tx.exec(NO_DELETE_TRIGGER("execution_run_events"));
      tx.exec("CREATE INDEX idx_execution_run_events_run ON execution_run_events (run_id, event_seq)");

      // execution_attempts + reports + protocol events indexes (017).
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

      // verification_conflicts (021).
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

      // worker invocations + events (018).
      tx.exec(`
        CREATE TRIGGER execution_worker_invocations_identity_immutable BEFORE UPDATE ON execution_worker_invocations
        BEGIN
          SELECT RAISE(ABORT, 'worker invocation identity is immutable')
          WHERE OLD.attempt_id IS NOT NEW.attempt_id
             OR OLD.run_id IS NOT NEW.run_id
             OR OLD.worker_role IS NOT NEW.worker_role
             OR OLD.launch_token_hash IS NOT NEW.launch_token_hash
             OR OLD.created_at IS NOT NEW.created_at;
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

      // E10 §43 — terminal completion provenance on the run itself, and the
      // re-attach of the two detached external commit references (captured
      // above, restored row by row). The biconditional (completed ↔
      // provenance) and the head-equality are DDL-enforced; every
      // non-completed lifecycle keeps completion NULL. Rewind-artifact
      // hardening: a v23-era trigger can survive a deep rewind, so trigger
      // creation is re-runnable.
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
      // E7 §7/§14 + §12/§13 — the stage-completion triggers re-create exactly
      // as migration 020 defined them (the column drop removed them).
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
      // E10 §45 — a terminal lifecycle is permanent. replan_required was
      // already terminal through its conditional writer (E9); completed joins
      // it at the DDL level, and aborted is covered for the future phase.
      tx.exec(`
        CREATE TRIGGER execution_runs_terminal_lifecycle BEFORE UPDATE ON execution_runs
        BEGIN
          SELECT RAISE(ABORT, 'a terminal ExecutionRun lifecycle is permanent')
          WHERE OLD.lifecycle IN ('completed', 'replan_required', 'aborted')
            AND NEW.lifecycle IS NOT OLD.lifecycle;
        END
      `);
    },
  };
}
