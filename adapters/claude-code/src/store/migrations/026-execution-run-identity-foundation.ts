/**
 * Migration 026 — execution-run-identity-foundation (A1-I; frozen amendment
 * "ExecutionRun Identity Independence + Same-FinalPlan Reexecution" and its
 * Closure / Final Closure revisions).
 *
 * ExecutionRunID becomes the canonical execution-domain identity:
 *
 *   execution_runs          PRIMARY KEY(execution_run_id); legacy run_id
 *                          remains REQUIRED source-PlanningRun provenance
 *   execution children     run_id → execution_run_id (exact-Run scope)
 *   execution_directives   dual-column: execution_run_id (authority) +
 *                          byte-stable legacy run_id (hashed provenance);
 *                          protocol_version CHECK extends to v4
 *   execution_issues       PK(execution_run_id, issue_id); execution_run_id
 *                          NOT NULL (backfilled); legacy run_id byte-stable
 *   run_control_authorizations  typed target_kind (planning_run /
 *                          execution_run / final_plan_execution /
 *                          legacy_pre_a1 migration-only) + typed identifier
 *                          columns; legacy run_id → nullable provenance;
 *                          operation vocabulary gains reexecute_final_plan
 *                          (vocabulary only — A1-I has NO production writer)
 *   workspace singleton    UNIQUE(workspace_id) WHERE lifecycle IN
 *                          ('prepared','active') on execution_runs
 *
 * Every rebuilt table keeps its historical object IDs, canonical content, and
 * immutable-ledger rows byte-stable (A1 §11/§16/§44): the ONLY value rewritten
 * is the scope linkage column, backfilled through the v25 bijection
 * execution_runs.run_id → execution_runs.execution_run_id. No FK may target
 * execution_runs(run_id) after this migration (A1-I47); legacy run_id FK
 * domains are planning_runs(run_id) / the composite planning-owned FinalPlan
 * FK only. Historical control rows classify structurally per A1 §42: exact
 * abort-record pointer → execution_run; no execution world ever existed →
 * planning_run; otherwise legacy_pre_a1 (migration-only; NEVER timestamp
 * ordering). Migration fails closed on structural corruption only; legacy
 * control-target ambiguity maps to legacy_pre_a1 and never fails.
 *
 * DANCE DESIGN (the established 023/025 deferred-FK rebuild pattern, applied
 * PER TABLE in topological FK order): each table runs create(_new)→copy→
 * drop→rename under its CANONICAL name, with FKs targeting the canonical
 * (or not-yet-renamed root) names — so every parent holds its rows at every
 * child's copy time under `PRAGMA defer_foreign_keys = ON`, and the root
 * swaps LAST: at the old root's drop, the already-rebuilt children dangle
 * only until the rename lands, and no child DML runs inside that window.
 * The root therefore needs no detach/re-attach dance at all — the accepted/
 * completion provenance columns stay IN-BODY, referencing execution_commits
 * (rebuilt earlier, canonical name intact at root-copy time).
 */

import type { StoreTx } from "../transaction.js";
import type { StoreMigration } from "./index.js";
import {
  ASSESSMENT_JUDGMENTS_V23,
  EXECUTION_COMMITS_V23,
  EXECUTION_DIRECTIVES_V23,
  EXECUTION_REPORTS_V23,
  EXECUTION_RUN_EVENTS_V23,
  EXECUTION_ATTEMPTS_V23,
  NO_DELETE_TRIGGER,
  NO_UPDATE_TRIGGER,
  SCOPE_SHAPE_TRIGGER,
  SCOPE_UPDATE_SHAPE_TRIGGER,
  SUPERVISOR_ASSESSMENTS_V23,
  VERIFICATION_CONFLICTS_V23,
  VERIFICATION_WINDOWS_V23,
  WORKER_INVOCATIONS_V23,
  WORKER_INVOCATION_EVENTS_V23,
} from "./023-execution-scope-foundation.js";

/** The v25 event vocabularies (extended by the 025 rebuilds). */
const EXECUTION_RUN_EVENTS_V25 = EXECUTION_RUN_EVENTS_V23.replace(
  "event_type IN ('PREPARED', 'ACTIVATED', 'REPLAN_REQUIRED', 'COMPLETED')",
  "event_type IN ('PREPARED', 'ACTIVATED', 'REPLAN_REQUIRED', 'COMPLETED', 'ABORTED')",
);
const WORKER_INVOCATION_EVENTS_V25 = WORKER_INVOCATION_EVENTS_V23.replace(
  "event_type IN ('PREPARED', 'CLAIMED', 'FINISHED')",
  "event_type IN ('PREPARED', 'CLAIMED', 'FINISHED', 'ROTATED')",
);
const VERIFICATION_WINDOWS_V25 = VERIFICATION_WINDOWS_V23.replace(
  "closure_kind IN ('accepted', 'replan_required')",
  "closure_kind IN ('accepted', 'replan_required', 'aborted')",
);

/**
 * Pure re-key transform: every run_id occurrence in the 023-cluster bodies is
 * the execution scope column or its FK; the FK target re-points to the root's
 * NOT-YET-RENAMED name (the root swaps last; SQLite rewrites the references
 * at the rename).
 */
const rekey = (body: string): string =>
  body.replaceAll("run_id", "execution_run_id").replace(
    "FOREIGN KEY (execution_run_id) REFERENCES execution_runs(execution_run_id)",
    "FOREIGN KEY (execution_run_id) REFERENCES execution_runs_new(execution_run_id)",
  );

const VERIFICATION_WINDOWS_V26 = rekey(VERIFICATION_WINDOWS_V25);
const SUPERVISOR_ASSESSMENTS_V26 = rekey(SUPERVISOR_ASSESSMENTS_V23);
const EXECUTION_COMMITS_V26 = rekey(EXECUTION_COMMITS_V23);
const EXECUTION_RUN_EVENTS_V26 = rekey(EXECUTION_RUN_EVENTS_V25);
const EXECUTION_ATTEMPTS_V26 = rekey(EXECUTION_ATTEMPTS_V23);
const EXECUTION_REPORTS_V26 = rekey(EXECUTION_REPORTS_V23);
const VERIFICATION_CONFLICTS_V26 = rekey(VERIFICATION_CONFLICTS_V23);
const WORKER_INVOCATIONS_V26 = rekey(WORKER_INVOCATIONS_V23);

/**
 * A1 §16 — dual identity columns. The legacy `run_id` keeps its historical
 * PlanningRunID value (it participates in frozen v1/v2/v3 canonical hashes);
 * `execution_run_id` is the canonical execution authority scope. The legacy
 * FK moves to its provenance domain (planning_runs) — no post-A1 FK may
 * target execution_runs(run_id).
 */
const EXECUTION_DIRECTIVES_V26 = EXECUTION_DIRECTIVES_V23
  .replace(
    "directive_hash TEXT NOT NULL,\n  run_id TEXT NOT NULL,",
    "directive_hash TEXT NOT NULL,\n  run_id TEXT NOT NULL,\n  execution_run_id TEXT NOT NULL,",
  )
  .replace(
    "FOREIGN KEY (run_id) REFERENCES execution_runs(run_id),",
    "FOREIGN KEY (execution_run_id) REFERENCES execution_runs_new(execution_run_id),\n"
    + "  FOREIGN KEY (run_id) REFERENCES planning_runs(run_id),",
  )
  .replace(
    "protocol_version INTEGER NOT NULL DEFAULT 1 CHECK (protocol_version IN (1, 2, 3)),",
    "protocol_version INTEGER NOT NULL DEFAULT 1 CHECK (protocol_version IN (1, 2, 3, 4)),",
  );

/** A1 §6 — the canonical ExecutionRun root: PK(execution_run_id); the legacy
 * run_id column remains REQUIRED source-PlanningRun provenance. Commit
 * provenance stays IN-BODY targeting the CANONICAL execution_commits name —
 * the commits dance completes before the root dance, so the canonical table
 * exists and holds its rows at root-copy time. */
const EXECUTION_RUNS_V26 = `
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
  accepted_head_commit_id TEXT REFERENCES execution_commits(commit_id),
  completion_commit_id TEXT REFERENCES execution_commits(commit_id),
  PRIMARY KEY (execution_run_id),
  UNIQUE (run_id, execution_run_id),
  FOREIGN KEY (run_id) REFERENCES planning_runs(run_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id),
  FOREIGN KEY (run_id, final_plan_id) REFERENCES final_plans(run_id, final_plan_id)
`;

/** E3 stage structure: exact-Run scope; completion provenance IN-BODY. */
const EXECUTION_STAGES_V26 = `
  id TEXT NOT NULL,
  execution_run_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'completed', 'superseded')),
  objective TEXT NOT NULL,
  source_step_id TEXT,
  depends_on_json TEXT NOT NULL,
  source_refs_json TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_by_commit_id TEXT REFERENCES execution_commits_new(commit_id),
  PRIMARY KEY (id),
  UNIQUE (execution_run_id, ordinal),
  UNIQUE (execution_run_id, source_step_id),
  FOREIGN KEY (execution_run_id) REFERENCES execution_runs_new(execution_run_id)
`;

const EXECUTION_PROTOCOL_EVENTS_V26 = `
  execution_run_id TEXT NOT NULL,
  event_seq INTEGER NOT NULL CHECK (event_seq >= 1),
  event_type TEXT NOT NULL CHECK (event_type IN ('DIRECTIVE_ISSUED', 'ATTEMPT_STARTED', 'ATTEMPT_REPORTED', 'ATTEMPT_INDETERMINATE')),
  directive_id TEXT,
  directive_revision INTEGER,
  attempt_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (execution_run_id, event_seq),
  FOREIGN KEY (execution_run_id) REFERENCES execution_runs_new(execution_run_id)
`;

const EXECUTION_ACCEPTANCE_EVENTS_V26 = `
  execution_run_id TEXT NOT NULL,
  event_seq INTEGER NOT NULL CHECK (event_seq >= 1),
  event_type TEXT NOT NULL CHECK (event_type IN ('ASSESSMENT_RECORDED', 'EXECUTION_COMMIT_CREATED')),
  assessment_id TEXT,
  commit_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (execution_run_id, event_seq),
  FOREIGN KEY (execution_run_id) REFERENCES execution_runs_new(execution_run_id)
`;

/** E13 abort provenance: one-to-one with the exact ExecutionRunID; the legacy
 * run_id remains byte-stable provenance in its planning domain. */
const EXECUTION_ABORT_RECORDS_V26 = `
  execution_run_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  control_id TEXT NOT NULL,
  requested_by_session_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  accepted_head_commit_id TEXT,
  active_stage_id TEXT,
  open_window_id TEXT,
  active_attempt_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (execution_run_id),
  UNIQUE (control_id),
  FOREIGN KEY (execution_run_id) REFERENCES execution_runs_new(execution_run_id),
  FOREIGN KEY (run_id) REFERENCES planning_runs(run_id),
  FOREIGN KEY (control_id) REFERENCES run_control_authorizations_new(control_id)
`;

const SUPERVISOR_BINDINGS_V26 = `
  execution_run_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('attached', 'detached')),
  generation INTEGER NOT NULL CHECK (generation >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (execution_run_id),
  FOREIGN KEY (execution_run_id) REFERENCES execution_runs_new(execution_run_id),
  FOREIGN KEY (run_id) REFERENCES planning_runs(run_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id)
`;

const SUPERVISOR_BINDING_EVENTS_V26 = `
  execution_run_id TEXT NOT NULL,
  event_seq INTEGER NOT NULL CHECK (event_seq >= 1),
  event_type TEXT NOT NULL CHECK (event_type IN ('ATTACHED', 'DETACHED', 'TAKEOVER')),
  session_id TEXT,
  detail_json TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (execution_run_id, event_seq),
  FOREIGN KEY (execution_run_id) REFERENCES supervisor_bindings_new(execution_run_id)
`;

/**
 * E9 issues (A1 §15/§24): exact predecessor execution scope becomes the
 * identity — PK(execution_run_id, issue_id); the legacy run_id stays
 * byte-stable provenance in its planning domains.
 */
const EXECUTION_ISSUES_V26 = `
  run_id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  execution_run_id TEXT NOT NULL,
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
  trigger_assessment_id TEXT,
  relevant_reports_json TEXT,
  accepted_history_json TEXT,
  execution_context_json TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (execution_run_id, issue_id),
  UNIQUE (execution_run_id, operation_id),
  FOREIGN KEY (execution_run_id) REFERENCES execution_runs_new(execution_run_id),
  FOREIGN KEY (run_id) REFERENCES planning_runs(run_id),
  FOREIGN KEY (run_id, final_plan_id) REFERENCES final_plans(run_id, final_plan_id),
  FOREIGN KEY (run_id, handoff_id) REFERENCES execution_handoffs(run_id, handoff_id)
`;

const EXECUTION_ISSUE_REFS_V26 = `
  execution_run_id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 1),
  ref_type TEXT NOT NULL CHECK (ref_type IN ('architecture', 'section', 'section_contract', 'decision', 'constraint')),
  artifact_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  PRIMARY KEY (execution_run_id, issue_id, position),
  FOREIGN KEY (execution_run_id, issue_id) REFERENCES execution_issues_new(execution_run_id, issue_id)
`;

const EXECUTION_ISSUE_ADOPTIONS_V26 = `
  issue_id TEXT NOT NULL,
  execution_run_id TEXT NOT NULL,
  successor_run_id TEXT NOT NULL,
  baseline_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 1),
  created_at TEXT NOT NULL,
  PRIMARY KEY (issue_id),
  UNIQUE (issue_id),
  FOREIGN KEY (execution_run_id, issue_id) REFERENCES execution_issues_new(execution_run_id, issue_id),
  FOREIGN KEY (successor_run_id) REFERENCES planning_runs(run_id)
`;

/**
 * A1 §49 typed control targets. `legacy_pre_a1` is migration-only (no
 * application insert path); `final_plan_execution` is vocabulary + shape
 * support for A1-II with NO production writer in A1-I (A1 §33/§43). The
 * legacy run_id becomes nullable source-PlanningRun provenance. Append-only
 * (A1 §34): no UPDATE path exists — the future reexecution row is persisted
 * atomically with its resulting run.
 */
const RUN_CONTROL_AUTHORIZATIONS_V26 = `
  control_id TEXT PRIMARY KEY,
  run_id TEXT,
  operation TEXT NOT NULL CHECK (operation IN ('takeover', 'abort', 'reexecute_final_plan')),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('planning_run', 'execution_run', 'final_plan_execution', 'legacy_pre_a1')),
  planning_run_id TEXT,
  execution_run_id TEXT,
  source_planning_run_id TEXT,
  final_plan_id TEXT,
  final_plan_revision INTEGER,
  final_plan_hash TEXT,
  resulting_execution_run_id TEXT,
  authorization_request_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  expected_binding_generation INTEGER NOT NULL CHECK (expected_binding_generation >= 1),
  resulting_binding_generation INTEGER CHECK (resulting_binding_generation >= 1),
  previous_binding_identity TEXT,
  new_binding_identity TEXT,
  resulting_run_revision INTEGER CHECK (resulting_run_revision >= 1),
  reason TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (operation_id),
  UNIQUE (authorization_request_id),
  FOREIGN KEY (run_id) REFERENCES planning_runs(run_id),
  FOREIGN KEY (execution_run_id) REFERENCES execution_runs_new(execution_run_id),
  FOREIGN KEY (resulting_execution_run_id) REFERENCES execution_runs_new(execution_run_id),
  CHECK (
    (target_kind = 'planning_run'
      AND planning_run_id IS NOT NULL
      AND execution_run_id IS NULL
      AND source_planning_run_id IS NULL
      AND final_plan_id IS NULL
      AND final_plan_revision IS NULL
      AND final_plan_hash IS NULL
      AND resulting_execution_run_id IS NULL)
    OR (target_kind = 'execution_run'
      AND execution_run_id IS NOT NULL
      AND planning_run_id IS NULL
      AND source_planning_run_id IS NULL
      AND final_plan_id IS NULL
      AND final_plan_revision IS NULL
      AND final_plan_hash IS NULL
      AND resulting_execution_run_id IS NULL)
    OR (target_kind = 'final_plan_execution'
      AND source_planning_run_id IS NOT NULL
      AND final_plan_id IS NOT NULL
      AND final_plan_revision IS NOT NULL
      AND final_plan_hash IS NOT NULL
      AND planning_run_id IS NULL
      AND execution_run_id IS NULL
      AND resulting_execution_run_id IS NOT NULL)
    OR (target_kind = 'legacy_pre_a1'
      AND run_id IS NOT NULL
      AND planning_run_id IS NULL
      AND execution_run_id IS NULL
      AND source_planning_run_id IS NULL
      AND final_plan_id IS NULL
      AND final_plan_revision IS NULL
      AND final_plan_hash IS NULL
      AND resulting_execution_run_id IS NULL)
  )
`;

/** The A1-I rebuild graph in topological FK order: every entry's FK parents
 * appear (and hold their rows) before it. The root swaps LAST. */

/** E11 reconciliation: exact-Run scope on binding and result. */
const EXECUTION_ATTEMPT_RECONCILIATION_BINDINGS_V26 = `
  attempt_id TEXT NOT NULL,
  execution_run_id TEXT NOT NULL,
  directive_id TEXT NOT NULL,
  first_directive_revision INTEGER NOT NULL CHECK (first_directive_revision >= 1),
  created_at TEXT NOT NULL,
  PRIMARY KEY (attempt_id),
  FOREIGN KEY (attempt_id) REFERENCES execution_attempts_new(attempt_id),
  FOREIGN KEY (execution_run_id) REFERENCES execution_runs_new(execution_run_id),
  FOREIGN KEY (directive_id, first_directive_revision)
    REFERENCES execution_directives_new(directive_id, revision),
  UNIQUE (attempt_id)
`;

const EXECUTION_ATTEMPT_RECONCILIATIONS_V26 = `
  reconciliation_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  execution_run_id TEXT NOT NULL,
  directive_id TEXT NOT NULL,
  directive_revision INTEGER NOT NULL CHECK (directive_revision >= 1),
  source_window_id TEXT NOT NULL,
  resolution TEXT NOT NULL CHECK (
    resolution IN ('no_effect', 'no_effect_by_capability', 'candidate_changed')
  ),
  inspection_report_id TEXT,
  candidate_revision_before INTEGER NOT NULL CHECK (candidate_revision_before >= 0),
  candidate_revision_after INTEGER NOT NULL CHECK (candidate_revision_after >= 0),
  rationale TEXT NOT NULL CHECK (rationale != ''),
  created_at TEXT NOT NULL,
  PRIMARY KEY (reconciliation_id),
  FOREIGN KEY (attempt_id) REFERENCES execution_attempts_new(attempt_id),
  FOREIGN KEY (execution_run_id) REFERENCES execution_runs_new(execution_run_id),
  FOREIGN KEY (directive_id, directive_revision)
    REFERENCES execution_directives_new(directive_id, revision),
  FOREIGN KEY (inspection_report_id) REFERENCES execution_reports_new(report_id),
  UNIQUE (attempt_id),
  CHECK (
    (resolution = 'candidate_changed'
      AND candidate_revision_after = candidate_revision_before + 1
      AND inspection_report_id IS NOT NULL)
    OR (resolution != 'candidate_changed'
      AND candidate_revision_after = candidate_revision_before)
  ),
  CHECK (
    resolution != 'no_effect_by_capability' OR inspection_report_id IS NULL
  )
`;

const REBUILD_SPECS_V26: Array<{ canonical: string; body: string; copy: string }> = [];

function defineRebuild(canonical: string, body: string, copy: string): void {
  REBUILD_SPECS_V26.push({ canonical, body, copy });
}

defineRebuild(
  "execution_runs",
  EXECUTION_RUNS_V26,
  "INSERT INTO execution_runs_new (execution_run_id, run_id, workspace_id, final_plan_id, final_plan_revision, "
  + "final_plan_hash, lifecycle, planning_baseline_json, execution_start_baseline_json, revision, created_at, "
  + "updated_at, accepted_head_commit_id, completion_commit_id) "
  + "SELECT execution_run_id, run_id, workspace_id, final_plan_id, final_plan_revision, final_plan_hash, "
  + "lifecycle, planning_baseline_json, execution_start_baseline_json, revision, created_at, updated_at, "
  + "accepted_head_commit_id, completion_commit_id FROM execution_runs",
);

/** Structural child-resolution preflight: every row maps through the v25
 * bijection; any orphan is corruption and FAILS the migration (A1 §42/§5). */
const CHILD_TABLES = [
  "execution_run_events",
  "execution_protocol_events",
  "execution_acceptance_events",
  "supervisor_bindings",
  "supervisor_binding_events",
  "execution_stages",
  "verification_windows",
  "execution_directives",
  "execution_attempts",
  "execution_reports",
  "execution_worker_invocations",
  "supervisor_assessments",
  "execution_commits",
  "verification_conflicts",
  "execution_attempt_reconciliation_bindings",
  "execution_attempt_reconciliations",
  "execution_abort_records",
];

/** A1-I §3 — the machine-derived rebuild inventory (the 24 objects migration
 * 026 rebuilds: 22 run_id-bearing re-key/dual-column tables + 2 indirect FK
 * children). Exported for the formal schema-matrix test. */
export function v26RebuiltTableNames(): string[] {
  return REBUILD_SPECS_V26.map((spec) => spec.canonical);
}

export function createExecutionRunIdentityMigration(): StoreMigration {
  return {
    from: 25,
    to: 26,
    name: "execution-run-identity-foundation",
    apply(tx: StoreTx): void {
      const tableExists = (name: string): boolean =>
        tx.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;

      // ---- §4 hard preflight (fail closed on structural corruption) ----

      const fkViolations = tx.prepare("PRAGMA foreign_key_check").all() as unknown[];
      if (fkViolations.length > 0) {
        throw new Error(`migration 026 preflight: ${fkViolations.length} foreign-key violation(s) in the v25 store`);
      }
      // FinalPlan provenance must still bind exactly (A1 §42 — the ExecutionRun
      // carries its exact FinalPlan id@revision/hash; drift is corruption).
      const finalPlanDrift = tx
        .prepare(
          "SELECT r.run_id AS id FROM execution_runs r "
          + "LEFT JOIN final_plans f ON f.run_id = r.run_id AND f.final_plan_id = r.final_plan_id "
          + "WHERE f.final_plan_id IS NULL "
          + "OR f.revision != r.final_plan_revision OR f.final_plan_hash != r.final_plan_hash LIMIT 1",
        )
        .get() as { id?: string } | undefined;
      if (finalPlanDrift !== undefined) {
        throw new Error(`migration 026 preflight: execution run '${finalPlanDrift.id}' has broken FinalPlan provenance`);
      }
      for (const child of CHILD_TABLES) {
        if (!tableExists(child)) continue;
        const orphan = tx
          .prepare(
            `SELECT c.rowid AS rid FROM ${child} c `
            + "LEFT JOIN execution_runs m ON m.run_id = c.run_id "
            + "WHERE m.execution_run_id IS NULL LIMIT 1",
          )
          .get() as { rid?: number } | undefined;
        if (orphan !== undefined) {
          throw new Error(`migration 026 preflight: orphan execution child row in '${child}' (no resolvable ExecutionRun)`);
        }
      }
      // acceptedHead / completion provenance must live in the same execution world.
      const headDrift = tx
        .prepare(
          "SELECT r.run_id AS id FROM execution_runs r "
          + "LEFT JOIN execution_commits c ON c.commit_id = r.accepted_head_commit_id "
          + "WHERE r.accepted_head_commit_id IS NOT NULL AND (c.commit_id IS NULL OR c.run_id != r.run_id) LIMIT 1",
        )
        .get() as { id?: string } | undefined;
      if (headDrift !== undefined) {
        throw new Error(`migration 026 preflight: execution run '${headDrift.id}' holds a cross-world accepted head`);
      }
      const completionDrift = tx
        .prepare(
          "SELECT r.run_id AS id FROM execution_runs r "
          + "LEFT JOIN execution_commits c ON c.commit_id = r.completion_commit_id "
          + "WHERE r.completion_commit_id IS NOT NULL AND (c.commit_id IS NULL OR c.run_id != r.run_id) LIMIT 1",
        )
        .get() as { id?: string } | undefined;
      if (completionDrift !== undefined) {
        throw new Error(`migration 026 preflight: execution run '${completionDrift.id}' holds a cross-world completion commit`);
      }
      // E9 v2 rows already carry execution_run_id — it must agree with the map.
      const issueAgreement = tx
        .prepare(
          "SELECT i.issue_id AS id FROM execution_issues i "
          + "JOIN execution_runs m ON m.run_id = i.run_id "
          + "WHERE i.execution_run_id IS NOT NULL AND i.execution_run_id != m.execution_run_id LIMIT 1",
        )
        .get() as { id?: string } | undefined;
      if (issueAgreement !== undefined) {
        throw new Error(`migration 026 preflight: execution issue '${issueAgreement.id}' carries a foreign execution_run_id`);
      }
      // Abort records must bind a control row of the SAME run (exact pointer).
      const abortDrift = tx
        .prepare(
          "SELECT a.run_id AS id FROM execution_abort_records a "
          + "LEFT JOIN run_control_authorizations c ON c.control_id = a.control_id "
          + "WHERE c.control_id IS NULL OR c.operation != 'abort' OR c.run_id != a.run_id LIMIT 1",
        )
        .get() as { id?: string } | undefined;
      if (abortDrift !== undefined) {
        throw new Error(`migration 026 preflight: abort record '${abortDrift.id}' has a conflicting/foreign control pointer`);
      }
      // Workspace singleton (A1 §27): preflight proves the real data fits;
      // rows are never terminated or reclassified to make the index fit.
      const singleton = tx
        .prepare(
          "SELECT workspace_id AS id FROM execution_runs WHERE lifecycle IN ('prepared', 'active') "
          + "GROUP BY workspace_id HAVING count(*) > 1 LIMIT 1",
        )
        .get() as { id?: string } | undefined;
      if (singleton !== undefined) {
        throw new Error(`migration 026 preflight: workspace '${singleton.id}' holds multiple nonterminal execution runs`);
      }

      // ---- the per-table deferred-FK dance (023/025 pattern) ----

      tx.exec("PRAGMA defer_foreign_keys = ON");

      // Phase 1 — all canonical-shape copies created at once (their bodies
      // cross-reference each other's _new names).
      for (const spec of REBUILD_SPECS_V26) {
        tx.exec(`CREATE TABLE ${spec.canonical}_new (${spec.body})`);
      }
      // Phase 2 — copies in topological FK order: every referenced parent's
      // _new rows already landed (the deferred-FK graph converges at COMMIT,
      // when every _new has been renamed to its canonical name and all
      // references rewritten).
      for (const spec of REBUILD_SPECS_V26) {
        tx.exec(spec.copy);
      }
      // Phase 2b — deferred-counter reconciliation. Copy-time FK lookups that
      // targeted a not-yet-filled _new parent (the root, whose rows land last)
      // counted deferred violations on the child FKey structs; the counters
      // only re-evaluate when the FK's own columns are rewritten. A self-
      // update of every FK column re-runs each lookup per row now that all
      // parents hold their rows, decrementing every counter to zero before
      // the drops and the final commit rescan.
      for (const spec of REBUILD_SPECS_V26) {
        const columns = (tx.prepare(`PRAGMA table_info('${spec.canonical}_new')`).all() as Array<{ name: string; pk: number }>)
          .filter((column) => column.pk === 0)
          .map((column) => column.name);
        const touched = columns.filter((name) =>
          name === "execution_run_id"
          || name === "attempt_id"
          || name === "directive_id"
          || name === "report_id"
          || name === "assessment_id"
          || name === "window_id"
          || name === "base_commit_id"
          || name === "completed_by_commit_id"
          || name === "parent_commit_id"
          || name === "resolution_directive_id"
          || name === "resolution_report_id"
          || name === "control_id"
          || name === "stage_id"
          || name === "successor_run_id",
        );
        if (touched.length === 0) continue;
        const sets = touched.map((name) => `"${name}" = "${name}"`).join(", ");
        tx.exec(`UPDATE ${spec.canonical}_new SET ${sets}`);
      }
      // A1 §42 fail-closed: every issue row must have mapped to its exact
      // ExecutionRun — an inner-join drop would silently fabricate an
      // under-scoped store.
      {
        const before = (tx.prepare("SELECT COUNT(*) AS n FROM execution_issues").get() as { n: number }).n;
        const after = (tx.prepare("SELECT COUNT(*) AS n FROM execution_issues_new").get() as { n: number }).n;
        if (before !== after) {
          throw new Error(`migration 026: ${before - after} execution issue row(s) had no resolvable ExecutionRun (A1 §24/§42)`);
        }
      }

      // Phase 3 — drop the old-shape tables (children first).
      for (const spec of [...REBUILD_SPECS_V26].reverse()) {
        if (tableExists(spec.canonical)) tx.exec(`DROP TABLE ${spec.canonical}`);
      }
      // Phase 4 — rename; SQLite rewrites every cross-table FK reference.
      for (const spec of REBUILD_SPECS_V26) {
        tx.exec(`ALTER TABLE ${spec.canonical}_new RENAME TO ${spec.canonical}`);
      }

      applyTriggersAndIndexes(tx);

      // The dance is complete and the end state is FK-clean (verified by the
      // schema validator on every open). Returning the surrounding
      // transaction to immediate enforcement makes its COMMIT re-run every
      // lookup against the FINAL schema instead of replaying per-statement
      // deferred counters accumulated while _new parents were still empty.
      tx.exec("PRAGMA defer_foreign_keys = OFF");
    },
  };
}

function applyTriggersAndIndexes(tx: StoreTx): void {
  tx.exec(`
    CREATE TRIGGER execution_runs_binding_immutable BEFORE UPDATE ON execution_runs
    BEGIN
      SELECT RAISE(ABORT, 'execution run binding is immutable')
      WHERE OLD.execution_run_id IS NOT NEW.execution_run_id
         OR OLD.run_id IS NOT NEW.run_id
         OR OLD.workspace_id IS NOT NEW.workspace_id
         OR OLD.final_plan_id IS NOT NEW.final_plan_id
         OR OLD.final_plan_revision IS NOT NEW.final_plan_revision
         OR OLD.final_plan_hash IS NOT NEW.final_plan_hash
         OR OLD.planning_baseline_json IS NOT NEW.planning_baseline_json
         OR OLD.execution_start_baseline_json IS NOT NEW.execution_start_baseline_json
         OR OLD.created_at IS NOT NEW.created_at;
    END
  `);
  tx.exec("CREATE TRIGGER execution_runs_no_delete BEFORE DELETE ON execution_runs BEGIN SELECT RAISE(ABORT, 'execution_runs is immutable'); END");
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
  // A1 §27 — the workspace execution serialization singleton.
  tx.exec(
    "CREATE UNIQUE INDEX idx_execution_runs_workspace_singleton "
    + "ON execution_runs (workspace_id) WHERE lifecycle IN ('prepared', 'active')",
  );

  tx.exec(SCOPE_SHAPE_TRIGGER("verification_windows"));
  tx.exec(SCOPE_UPDATE_SHAPE_TRIGGER("verification_windows"));
  tx.exec(`
    CREATE TRIGGER verification_windows_identity_immutable BEFORE UPDATE ON verification_windows
    BEGIN
      SELECT RAISE(ABORT, 'verification window identity is immutable')
      WHERE OLD.execution_run_id IS NOT NEW.execution_run_id
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
  tx.exec(
    "CREATE UNIQUE INDEX idx_verification_windows_open_run "
    + "ON verification_windows (execution_run_id) WHERE closed_at IS NULL",
  );
  tx.exec("CREATE INDEX idx_verification_windows_run ON verification_windows (execution_run_id, stage_id)");

  tx.exec(NO_UPDATE_TRIGGER("execution_directives"));
  tx.exec(NO_DELETE_TRIGGER("execution_directives"));
  tx.exec(SCOPE_SHAPE_TRIGGER("execution_directives"));
  tx.exec(SCOPE_UPDATE_SHAPE_TRIGGER("execution_directives"));
  tx.exec("CREATE INDEX idx_execution_directives_run ON execution_directives (execution_run_id, issued_at, directive_id, revision)");

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
  tx.exec("CREATE INDEX idx_execution_commits_run ON execution_commits (execution_run_id, sequence)");

  tx.exec(NO_UPDATE_TRIGGER("execution_run_events"));
  tx.exec(NO_DELETE_TRIGGER("execution_run_events"));
  tx.exec("CREATE INDEX idx_execution_run_events_run ON execution_run_events (execution_run_id, event_seq)");

  tx.exec(NO_UPDATE_TRIGGER("execution_protocol_events"));
  tx.exec(NO_DELETE_TRIGGER("execution_protocol_events"));
  tx.exec("CREATE INDEX idx_execution_protocol_events_run ON execution_protocol_events (execution_run_id, event_seq)");

  tx.exec(NO_UPDATE_TRIGGER("execution_acceptance_events"));
  tx.exec(NO_DELETE_TRIGGER("execution_acceptance_events"));
  tx.exec("CREATE INDEX idx_execution_acceptance_events_run ON execution_acceptance_events (execution_run_id, event_seq)");

  tx.exec(NO_UPDATE_TRIGGER("execution_attempt_reconciliation_bindings"));
  tx.exec(NO_DELETE_TRIGGER("execution_attempt_reconciliation_bindings"));
  tx.exec(NO_UPDATE_TRIGGER("execution_attempt_reconciliations"));
  tx.exec(NO_DELETE_TRIGGER("execution_attempt_reconciliations"));

  tx.exec(`
    CREATE TRIGGER execution_attempts_identity_immutable BEFORE UPDATE ON execution_attempts
    BEGIN
      SELECT RAISE(ABORT, 'execution attempt identity is immutable')
      WHERE OLD.attempt_id IS NOT NEW.attempt_id
         OR OLD.execution_run_id IS NOT NEW.execution_run_id
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
    + "ON execution_attempts (execution_run_id) WHERE state = 'running'",
  );
  tx.exec("CREATE INDEX idx_execution_attempts_run ON execution_attempts (execution_run_id, state)");

  tx.exec(`
    CREATE TRIGGER verification_conflicts_identity_immutable BEFORE UPDATE ON verification_conflicts
    BEGIN
      SELECT RAISE(ABORT, 'verification conflict binding is immutable')
      WHERE OLD.execution_run_id IS NOT NEW.execution_run_id
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
         OR OLD.execution_run_id IS NOT NEW.execution_run_id
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
  tx.exec("CREATE INDEX idx_worker_invocations_run ON execution_worker_invocations (execution_run_id, state)");
  tx.exec("CREATE INDEX idx_worker_invocation_events_attempt ON execution_worker_invocation_events (attempt_id, event_seq)");

  tx.exec(`
    CREATE TRIGGER execution_stages_provenance_immutable BEFORE UPDATE ON execution_stages
    BEGIN
      SELECT RAISE(ABORT, 'execution stage provenance is immutable')
      WHERE OLD.execution_run_id IS NOT NEW.execution_run_id
         OR OLD.ordinal IS NOT NEW.ordinal
         OR OLD.objective IS NOT NEW.objective
         OR OLD.source_step_id IS NOT NEW.source_step_id
         OR OLD.depends_on_json IS NOT NEW.depends_on_json
         OR OLD.source_refs_json IS NOT NEW.source_refs_json
         OR OLD.created_at IS NOT NEW.created_at;
    END
  `);
  tx.exec(`
    CREATE TRIGGER execution_stages_no_delete BEFORE DELETE ON execution_stages
    BEGIN SELECT RAISE(ABORT, 'execution_stages is immutable'); END
  `);
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
  tx.exec("CREATE UNIQUE INDEX idx_execution_stages_active_run ON execution_stages (execution_run_id) WHERE status = 'active'");
  tx.exec("CREATE INDEX idx_execution_stages_run ON execution_stages (execution_run_id, ordinal)");

  tx.exec(`
    CREATE TRIGGER supervisor_bindings_identity_immutable BEFORE UPDATE ON supervisor_bindings
    BEGIN
      SELECT RAISE(ABORT, 'supervisor binding identity is immutable')
      WHERE OLD.execution_run_id IS NOT NEW.execution_run_id
         OR OLD.run_id IS NOT NEW.run_id
         OR OLD.workspace_id IS NOT NEW.workspace_id
         OR OLD.created_at IS NOT NEW.created_at;
    END
  `);
  tx.exec(`
    CREATE TRIGGER supervisor_bindings_no_delete BEFORE DELETE ON supervisor_bindings
    BEGIN SELECT RAISE(ABORT, 'supervisor_bindings is immutable'); END
  `);
  tx.exec("CREATE UNIQUE INDEX idx_supervisor_bindings_active_session ON supervisor_bindings (session_id) WHERE state = 'attached'");
  tx.exec("CREATE INDEX idx_supervisor_bindings_session ON supervisor_bindings (session_id)");

  tx.exec(NO_UPDATE_TRIGGER("supervisor_binding_events"));
  tx.exec(NO_DELETE_TRIGGER("supervisor_binding_events"));
  tx.exec("CREATE INDEX idx_supervisor_binding_events_run ON supervisor_binding_events (execution_run_id, event_seq)");

  tx.exec(NO_UPDATE_TRIGGER("execution_issues"));
  tx.exec(NO_DELETE_TRIGGER("execution_issues"));
  tx.exec(NO_UPDATE_TRIGGER("execution_issue_refs"));
  tx.exec(NO_DELETE_TRIGGER("execution_issue_refs"));
  tx.exec(NO_UPDATE_TRIGGER("execution_issue_adoptions"));
  tx.exec(NO_DELETE_TRIGGER("execution_issue_adoptions"));
  tx.exec(
    "CREATE UNIQUE INDEX idx_execution_issues_replan_per_run "
    + "ON execution_issues (execution_run_id) WHERE kind = 'replan_required'",
  );
  tx.exec("CREATE INDEX idx_execution_issue_refs_issue ON execution_issue_refs (execution_run_id, issue_id, position)");
  tx.exec("CREATE INDEX idx_execution_issue_adoptions_successor ON execution_issue_adoptions (successor_run_id)");

  tx.exec(NO_UPDATE_TRIGGER("execution_abort_records"));
  tx.exec(NO_DELETE_TRIGGER("execution_abort_records"));

  tx.exec(NO_UPDATE_TRIGGER("run_control_authorizations"));
  tx.exec(NO_DELETE_TRIGGER("run_control_authorizations"));
  tx.exec("CREATE INDEX idx_run_control_authorizations_run ON run_control_authorizations (run_id, operation)");
  tx.exec("CREATE INDEX idx_run_control_authorizations_execution ON run_control_authorizations (execution_run_id, operation)");
}
defineRebuild(
  "execution_stages",
  EXECUTION_STAGES_V26,
  "INSERT INTO execution_stages_new (execution_run_id, id, ordinal, status, objective, source_step_id, "
  + "depends_on_json, source_refs_json, revision, created_at, updated_at, completed_by_commit_id) "
  + "SELECT m.execution_run_id, c.id, c.ordinal, c.status, c.objective, c.source_step_id, c.depends_on_json, "
  + "c.source_refs_json, c.revision, c.created_at, c.updated_at, c.completed_by_commit_id "
  + "FROM execution_stages c JOIN execution_runs m ON m.run_id = c.run_id",
);

defineRebuild(
  "verification_windows",
  VERIFICATION_WINDOWS_V26,
  "INSERT INTO verification_windows_new (id, execution_run_id, stage_id, scope_kind, candidate_revision, "
  + "opened_at, closed_at, base_kind, base_commit_id, closure_kind) "
  + "SELECT w.id, m.execution_run_id, w.stage_id, w.scope_kind, w.candidate_revision, w.opened_at, "
  + "w.closed_at, w.base_kind, w.base_commit_id, w.closure_kind "
  + "FROM verification_windows w JOIN execution_runs m ON m.run_id = w.run_id",
);

defineRebuild(
  "execution_directives",
  EXECUTION_DIRECTIVES_V26,
  "INSERT INTO execution_directives_new (execution_run_id, run_id, directive_id, revision, directive_hash, "
  + "final_plan_id, final_plan_revision, final_plan_hash, stage_id, scope_kind, window_id, kind, "
  + "base_candidate_revision, accepted_base_kind, accepted_base_json, objective, plan_refs_json, "
  + "expected_scope_json, capability_envelope_json, invariants_json, required_actions_json, "
  + "forbidden_actions_json, validation_requirements_json, deliverables_json, stop_conditions_json, "
  + "report_contract_json, body, issued_at, protocol_version, verification_requirement, verification_purpose, "
  + "verification_conflict_id) "
  + "SELECT m.execution_run_id, d.run_id, d.directive_id, d.revision, d.directive_hash, d.final_plan_id, "
  + "d.final_plan_revision, d.final_plan_hash, d.stage_id, d.scope_kind, d.window_id, d.kind, "
  + "d.base_candidate_revision, d.accepted_base_kind, d.accepted_base_json, d.objective, d.plan_refs_json, "
  + "d.expected_scope_json, d.capability_envelope_json, d.invariants_json, d.required_actions_json, "
  + "d.forbidden_actions_json, d.validation_requirements_json, d.deliverables_json, d.stop_conditions_json, "
  + "d.report_contract_json, d.body, d.issued_at, d.protocol_version, d.verification_requirement, "
  + "d.verification_purpose, d.verification_conflict_id "
  + "FROM execution_directives d JOIN execution_runs m ON m.run_id = d.run_id",
);

defineRebuild(
  "execution_attempts",
  EXECUTION_ATTEMPTS_V26,
  "INSERT INTO execution_attempts_new (attempt_id, execution_run_id, directive_id, directive_revision, "
  + "directive_hash, worker_role, state, started_at, ended_at) "
  + "SELECT a.attempt_id, m.execution_run_id, a.directive_id, a.directive_revision, a.directive_hash, "
  + "a.worker_role, a.state, a.started_at, a.ended_at "
  + "FROM execution_attempts a JOIN execution_runs m ON m.run_id = a.run_id",
);
defineRebuild(
  "execution_reports",
  EXECUTION_REPORTS_V26,
  "INSERT INTO execution_reports_new (report_id, execution_run_id, attempt_id, directive_id, directive_revision, "
  + "directive_hash, worker_role, result, candidate_mutated, actions_json, files_examined_json, "
  + "files_changed_json, commands_json, tests_json, findings_json, deviations_json, blockers_json, "
  + "deliverables_json, created_at) "
  + "SELECT r.report_id, m.execution_run_id, r.attempt_id, r.directive_id, r.directive_revision, r.directive_hash, "
  + "r.worker_role, r.result, r.candidate_mutated, r.actions_json, r.files_examined_json, r.files_changed_json, "
  + "r.commands_json, r.tests_json, r.findings_json, r.deviations_json, r.blockers_json, r.deliverables_json, "
  + "r.created_at FROM execution_reports r JOIN execution_runs m ON m.run_id = r.run_id",
);
defineRebuild(
  "execution_worker_invocations",
  WORKER_INVOCATIONS_V26,
  "INSERT INTO execution_worker_invocations_new (attempt_id, execution_run_id, worker_role, state, "
  + "worker_session_id, worker_agent_id, launch_token_hash, created_at, claimed_at, finished_at) "
  + "SELECT w.attempt_id, m.execution_run_id, w.worker_role, w.state, w.worker_session_id, w.worker_agent_id, "
  + "w.launch_token_hash, w.created_at, w.claimed_at, w.finished_at "
  + "FROM execution_worker_invocations w JOIN execution_runs m ON m.run_id = w.run_id",
);
defineRebuild(
  "execution_worker_invocation_events",
  WORKER_INVOCATION_EVENTS_V25,
  "INSERT INTO execution_worker_invocation_events_new SELECT * FROM execution_worker_invocation_events",
);

defineRebuild(
  "supervisor_bindings",
  SUPERVISOR_BINDINGS_V26,
  "INSERT INTO supervisor_bindings_new (execution_run_id, run_id, workspace_id, session_id, state, generation, "
  + "created_at, updated_at) "
  + "SELECT m.execution_run_id, b.run_id, b.workspace_id, b.session_id, b.state, b.generation, "
  + "b.created_at, b.updated_at FROM supervisor_bindings b JOIN execution_runs m ON m.run_id = b.run_id",
);
defineRebuild(
  "supervisor_binding_events",
  SUPERVISOR_BINDING_EVENTS_V26,
  "INSERT INTO supervisor_binding_events_new (execution_run_id, event_seq, event_type, session_id, detail_json, created_at) "
  + "SELECT m.execution_run_id, e.event_seq, e.event_type, e.session_id, e.detail_json, e.created_at "
  + "FROM supervisor_binding_events e JOIN execution_runs m ON m.run_id = e.run_id",
);

defineRebuild(
  "execution_run_events",
  EXECUTION_RUN_EVENTS_V26,
  "INSERT INTO execution_run_events_new (execution_run_id, event_seq, event_type, session_id, tool_use_id, "
  + "detail_json, created_at) "
  + "SELECT m.execution_run_id, e.event_seq, e.event_type, e.session_id, e.tool_use_id, e.detail_json, e.created_at "
  + "FROM execution_run_events e JOIN execution_runs m ON m.run_id = e.run_id",
);
defineRebuild(
  "execution_protocol_events",
  EXECUTION_PROTOCOL_EVENTS_V26,
  "INSERT INTO execution_protocol_events_new (execution_run_id, event_seq, event_type, directive_id, "
  + "directive_revision, attempt_id, created_at) "
  + "SELECT m.execution_run_id, e.event_seq, e.event_type, e.directive_id, e.directive_revision, e.attempt_id, "
  + "e.created_at FROM execution_protocol_events e JOIN execution_runs m ON m.run_id = e.run_id",
);
defineRebuild(
  "execution_acceptance_events",
  EXECUTION_ACCEPTANCE_EVENTS_V26,
  "INSERT INTO execution_acceptance_events_new (execution_run_id, event_seq, event_type, assessment_id, "
  + "commit_id, created_at) "
  + "SELECT m.execution_run_id, e.event_seq, e.event_type, e.assessment_id, e.commit_id, e.created_at "
  + "FROM execution_acceptance_events e JOIN execution_runs m ON m.run_id = e.run_id",
);

defineRebuild(
  "supervisor_assessments",
  SUPERVISOR_ASSESSMENTS_V26,
  "INSERT INTO supervisor_assessments_new (assessment_id, execution_run_id, stage_id, scope_kind, window_id, "
  + "candidate_revision, disposition, supervisor_session_id, supervisor_generation, plan_refs_json, "
  + "covered_obligations_json, rationale, created_at) "
  + "SELECT a.assessment_id, m.execution_run_id, a.stage_id, a.scope_kind, a.window_id, a.candidate_revision, "
  + "a.disposition, a.supervisor_session_id, a.supervisor_generation, a.plan_refs_json, "
  + "a.covered_obligations_json, a.rationale, a.created_at "
  + "FROM supervisor_assessments a JOIN execution_runs m ON m.run_id = a.run_id",
);
defineRebuild(
  "supervisor_assessment_report_judgments",
  ASSESSMENT_JUDGMENTS_V23,
  "INSERT INTO supervisor_assessment_report_judgments_new SELECT * FROM supervisor_assessment_report_judgments",
);

defineRebuild(
  "execution_commits",
  EXECUTION_COMMITS_V26,
  "INSERT INTO execution_commits_new (execution_run_id, commit_id, sequence, parent_commit_id, stage_id, "
  + "scope_kind, window_id, candidate_revision, supervisor_assessment_id, directive_refs_json, "
  + "report_refs_json, satisfied_obligations_json, created_at) "
  + "SELECT m.execution_run_id, c.commit_id, c.sequence, c.parent_commit_id, c.stage_id, c.scope_kind, "
  + "c.window_id, c.candidate_revision, c.supervisor_assessment_id, c.directive_refs_json, "
  + "c.report_refs_json, c.satisfied_obligations_json, c.created_at "
  + "FROM execution_commits c JOIN execution_runs m ON m.run_id = c.run_id",
);

defineRebuild(
  "verification_conflicts",
  VERIFICATION_CONFLICTS_V26,
  "INSERT INTO verification_conflicts_new (execution_run_id, conflict_id, window_id, candidate_revision, fact, "
  + "claims_json, status, resolution_directive_id, resolution_directive_revision, resolution_report_id, "
  + "fingerprint, rationale, created_at, resolved_at) "
  + "SELECT m.execution_run_id, c.conflict_id, c.window_id, c.candidate_revision, c.fact, c.claims_json, "
  + "c.status, c.resolution_directive_id, c.resolution_directive_revision, c.resolution_report_id, "
  + "c.fingerprint, c.rationale, c.created_at, c.resolved_at "
  + "FROM verification_conflicts c JOIN execution_runs m ON m.run_id = c.run_id",
);

defineRebuild(
  "execution_attempt_reconciliation_bindings",
  EXECUTION_ATTEMPT_RECONCILIATION_BINDINGS_V26,
  "INSERT INTO execution_attempt_reconciliation_bindings_new (attempt_id, execution_run_id, directive_id, "
  + "first_directive_revision, created_at) "
  + "SELECT b.attempt_id, m.execution_run_id, b.directive_id, b.first_directive_revision, b.created_at "
  + "FROM execution_attempt_reconciliation_bindings b JOIN execution_runs m ON m.run_id = b.run_id",
);
defineRebuild(
  "execution_attempt_reconciliations",
  EXECUTION_ATTEMPT_RECONCILIATIONS_V26,
  "INSERT INTO execution_attempt_reconciliations_new (reconciliation_id, attempt_id, execution_run_id, "
  + "directive_id, directive_revision, source_window_id, resolution, inspection_report_id, "
  + "candidate_revision_before, candidate_revision_after, rationale, created_at) "
  + "SELECT r.reconciliation_id, r.attempt_id, m.execution_run_id, r.directive_id, r.directive_revision, "
  + "r.source_window_id, r.resolution, r.inspection_report_id, r.candidate_revision_before, "
  + "r.candidate_revision_after, r.rationale, r.created_at "
  + "FROM execution_attempt_reconciliations r JOIN execution_runs m ON m.run_id = r.run_id",
);

defineRebuild(
  "execution_issues",
  EXECUTION_ISSUES_V26,
  "INSERT INTO execution_issues_new (run_id, issue_id, execution_run_id, final_plan_id, final_plan_hash, "
  + "handoff_id, handoff_hash, kind, summary, detail, canonical_json, issue_hash, repository_kind, "
  + "repository_revision, operation_id, session_id, issue_version, trigger_assessment_id, "
  + "relevant_reports_json, accepted_history_json, execution_context_json, created_at) "
  + "SELECT i.run_id, i.issue_id, m.execution_run_id, i.final_plan_id, i.final_plan_hash, i.handoff_id, "
  + "i.handoff_hash, i.kind, i.summary, i.detail, i.canonical_json, i.issue_hash, i.repository_kind, "
  + "i.repository_revision, i.operation_id, i.session_id, i.issue_version, i.trigger_assessment_id, "
  + "i.relevant_reports_json, i.accepted_history_json, i.execution_context_json, i.created_at "
  + "FROM execution_issues i JOIN execution_runs m ON m.run_id = i.run_id",
);
defineRebuild(
  "execution_issue_refs",
  EXECUTION_ISSUE_REFS_V26,
  "INSERT INTO execution_issue_refs_new (execution_run_id, issue_id, position, ref_type, artifact_id, revision) "
  + "SELECT m.execution_run_id, r.issue_id, r.position, r.ref_type, r.artifact_id, r.revision "
  + "FROM execution_issue_refs r JOIN execution_runs m ON m.run_id = r.run_id",
);
defineRebuild(
  "execution_issue_adoptions",
  EXECUTION_ISSUE_ADOPTIONS_V26,
  "INSERT INTO execution_issue_adoptions_new (issue_id, execution_run_id, successor_run_id, baseline_id, "
  + "position, created_at) SELECT a.issue_id, m.execution_run_id, a.successor_run_id, a.baseline_id, "
  + "a.position, a.created_at FROM execution_issue_adoptions a JOIN execution_runs m ON m.run_id = a.run_id",
);

defineRebuild(
  "run_control_authorizations",
  RUN_CONTROL_AUTHORIZATIONS_V26,
  "INSERT INTO run_control_authorizations_new (control_id, run_id, operation, target_kind, planning_run_id, "
  + "execution_run_id, source_planning_run_id, final_plan_id, final_plan_revision, final_plan_hash, "
  + "resulting_execution_run_id, authorization_request_id, operation_id, request_hash, workspace_id, "
  + "expected_binding_generation, resulting_binding_generation, previous_binding_identity, "
  + "new_binding_identity, resulting_run_revision, reason, created_at) "
  + "SELECT c.control_id, c.run_id, c.operation, "
  + "CASE WHEN a.control_id IS NOT NULL THEN 'execution_run' "
  + "     WHEN m.execution_run_id IS NULL THEN 'planning_run' "
  + "     ELSE 'legacy_pre_a1' END, "
  + "CASE WHEN a.control_id IS NULL AND m.execution_run_id IS NULL THEN c.run_id ELSE NULL END, "
  + "CASE WHEN a.control_id IS NOT NULL THEN m.execution_run_id ELSE NULL END, "
  + "NULL, NULL, NULL, NULL, NULL, "
  + "c.authorization_request_id, c.operation_id, c.request_hash, c.workspace_id, "
  + "c.expected_binding_generation, c.resulting_binding_generation, c.previous_binding_identity, "
  + "c.new_binding_identity, c.resulting_run_revision, c.reason, c.created_at "
  + "FROM run_control_authorizations c "
  + "LEFT JOIN execution_abort_records a ON a.control_id = c.control_id "
  + "LEFT JOIN execution_runs m ON m.run_id = c.run_id",
);

defineRebuild(
  "execution_abort_records",
  EXECUTION_ABORT_RECORDS_V26,
  "INSERT INTO execution_abort_records_new (execution_run_id, run_id, control_id, requested_by_session_id, "
  + "reason, accepted_head_commit_id, active_stage_id, open_window_id, active_attempt_id, created_at) "
  + "SELECT m.execution_run_id, a.run_id, a.control_id, a.requested_by_session_id, a.reason, "
  + "a.accepted_head_commit_id, a.active_stage_id, a.open_window_id, a.active_attempt_id, a.created_at "
  + "FROM execution_abort_records a JOIN execution_runs m ON m.run_id = a.run_id",
);

// The root swaps LAST (A1 §9 — same existing identity, new primary key).
