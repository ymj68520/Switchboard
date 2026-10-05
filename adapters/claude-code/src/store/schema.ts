/**
 * Schema version authority and consistency validation (frozen plan §10/§26).
 *
 * `PRAGMA user_version` is the ONE authoritative schema version. The
 * `schema_migrations` table is an audit history, never a second authority —
 * the two must agree exactly (rows 1..N for user_version N) or the store is
 * STORE_SCHEMA_INVALID, which is never auto-repaired.
 */

import type { StoreConnection } from "./connection.js";
import { SUPPORTED_SCHEMA_VERSION } from "./constants.js";
import { storeError } from "./errors.js";
import type { StoreTx } from "./transaction.js";
import { executionHandoffHash, type ExecutionHandoffV1 } from "../core/execution-handoff.js";
import { executionIssueHash, type ExecutionIssueV1 } from "../core/execution-issue.js";
import { executionIssueV2Hash, type ExecutionIssueV2 } from "../core/execution-replan.js";
import { planningRunBaselineHash, type PlanningRunBaselineV1 } from "../core/successor-baseline.js";

/** Read the authoritative schema version (live read, never cached). */
export function readSchemaVersion(db: StoreConnection | StoreTx): number {
  const row = db.prepare("PRAGMA user_version").get() as Record<string, unknown> | undefined;
  const value = row ? Object.values(row)[0] : undefined;
  if (typeof value !== "number") {
    throw storeError("STORE_SCHEMA_INVALID", "PRAGMA user_version is unreadable");
  }
  return value;
}

export function setSchemaVersion(db: StoreConnection | StoreTx, version: number): void {
  if (!Number.isInteger(version) || version < 0) {
    throw storeError("STORE_SCHEMA_INVALID", `invalid schema version: ${version}`);
  }
  db.exec(`PRAGMA user_version = ${version}`);
}

export interface MigrationHistoryRow {
  version: number;
  name: string;
  appliedAt: string;
  runtimeVersion: string;
}

export interface SchemaState {
  version: number;
  history: MigrationHistoryRow[];
  /** True when user_version and the migration history agree exactly. */
  consistent: boolean;
  problems: string[];
}

interface TableRow {
  name: string;
}

/** Infrastructure tables required once the store has reached schema v2. */
const SCHEMA_V2_TABLES = ["repositories", "workspaces", "session_bindings"] as const;

/** Planning-domain tables required once the store has reached schema v3. */
const SCHEMA_V3_TABLES = ["planning_runs"] as const;

/** Plan Memory tables required once the store has reached schema v4. */
const SCHEMA_V4_TABLES = [
  "memory_artifacts",
  "memory_revisions",
  "plan_snapshots",
  "snapshot_members",
  "plan_heads",
] as const;

/** Immutability triggers required once the store has reached schema v4. */
const SCHEMA_V4_IMMUTABILITY_TRIGGERS = [
  "memory_artifacts_no_update",
  "memory_artifacts_no_delete",
  "memory_revisions_no_update",
  "memory_revisions_no_delete",
  "plan_snapshots_no_update",
  "plan_snapshots_no_delete",
  "snapshot_members_no_update",
  "snapshot_members_no_delete",
] as const;

/** Proposal/Approval/Commit tables required once the store has reached v5. */
const SCHEMA_V5_TABLES = [
  "proposals",
  "proposal_revisions",
  "proposal_states",
  "approvals",
  "plan_commits",
  "audit_events",
] as const;

/** Immutability + constraint triggers required once the store has reached v5. */
const SCHEMA_V5_TRIGGERS = [
  "proposal_revisions_no_update",
  "proposal_revisions_no_delete",
  "approvals_no_update",
  "approvals_no_delete",
  "plan_commits_no_update",
  "plan_commits_no_delete",
  "audit_events_no_update",
  "audit_events_no_delete",
  "proposal_states_insert_awaiting",
  "proposal_states_transition_guard",
  "approvals_hash_match",
  "plan_heads_commit_pair_insert",
  "plan_heads_commit_pair_update",
] as const;

/** Constraint indexes backing the v5 uniqueness invariants. */
const SCHEMA_V5_INDEXES = [
  "idx_proposals_request",
  "idx_proposal_states_one_awaiting",
  "idx_approvals_request",
  "idx_approvals_proposal_revision",
  "idx_plan_commits_run_sequence",
  "idx_plan_commits_one_root",
  "idx_plan_commits_one_child",
  "idx_plan_commits_run_commit",
  "idx_plan_commits_approval",
] as const;

/** Observation/Evidence tables required once the store has reached v6 (Phase 9 §4). */
const SCHEMA_V6_TABLES = [
  "observations",
  "evidence_artifacts",
  "evidence_revisions",
  "evidence_observation_refs",
  "evidence_derived_refs",
] as const;

/** Immutability triggers required once the store has reached v6 (§6/§52). */
const SCHEMA_V6_TRIGGERS = [
  "observations_no_update",
  "observations_no_delete",
  "evidence_artifacts_no_update",
  "evidence_artifacts_no_delete",
  "evidence_revisions_no_update",
  "evidence_revisions_no_delete",
  "evidence_observation_refs_no_update",
  "evidence_observation_refs_no_delete",
  "evidence_derived_refs_no_update",
  "evidence_derived_refs_no_delete",
] as const;

/** Constraint index backing the deterministic ledger order (§20). */
const SCHEMA_V6_INDEXES = [
  "idx_observations_run_seq",
] as const;

/** Freshness/Proposal-V2 tables required once the store has reached v7 (Phase 10 §4). */
const SCHEMA_V7_TABLES = [
  "evidence_validation_events",
  "evidence_current_states",
  "proposal_evidence_refs",
] as const;

/** Immutability + terminal-state triggers required once the store has reached v7.
 * evidence_current_states is the materialized projection — UPDATE is its normal
 * operation (§7), so only its deletion is fenced. */
const SCHEMA_V7_TRIGGERS = [
  "evidence_validation_events_no_update",
  "evidence_validation_events_no_delete",
  "evidence_current_states_no_delete",
  "proposal_evidence_refs_no_update",
  "proposal_evidence_refs_no_delete",
  "evidence_validation_events_no_revival",
] as const;

/** Constraint indexes backing v7 freshness/derived lookups. */
const SCHEMA_V7_INDEXES = [
  "idx_evidence_validation_events_revision",
  "idx_evidence_derived_refs_upstream",
] as const;

/** Section workflow tables required once the store has reached v8 (Phase 11 §3). */
const SCHEMA_V8_TABLES = [
  "section_workflow_events",
  "section_workflow_states",
  "planning_active_work",
] as const;

/** Immutability triggers required once the store has reached v8. The
 * materialized state is a projection (UPDATE is its normal operation), so
 * only its deletion is fenced. planning_active_work is ordinary mutable
 * workflow state and carries no immutability triggers. */
const SCHEMA_V8_TRIGGERS = [
  "section_workflow_events_no_update",
  "section_workflow_events_no_delete",
  "section_workflow_states_no_delete",
] as const;

/** Constraint index backing the deterministic per-Section workflow history. */
const SCHEMA_V8_INDEXES = [
  "idx_section_workflow_events_section",
] as const;

/** Synthesis/validation tables required once the store has reached v9 (Phase 12 §11). */
const SCHEMA_V9_TABLES = [
  "synthesis_inputs",
  "synthesis_input_refs",
  "synthesis_input_evidence",
  "synthesis_manifests",
  "synthesis_manifest_refs",
  "semantic_validation_reports",
  "semantic_validation_findings",
] as const;

/** Immutability triggers required once the store has reached v9: every
 * synthesis/validation record is append-only history (§14/§36/§46). */
const SCHEMA_V9_TRIGGERS = [
  "synthesis_inputs_no_update",
  "synthesis_inputs_no_delete",
  "synthesis_input_refs_no_update",
  "synthesis_input_refs_no_delete",
  "synthesis_input_evidence_no_update",
  "synthesis_input_evidence_no_delete",
  "synthesis_manifests_no_update",
  "synthesis_manifests_no_delete",
  "synthesis_manifest_refs_no_update",
  "synthesis_manifest_refs_no_delete",
  "semantic_validation_reports_no_update",
  "semantic_validation_reports_no_delete",
  "semantic_validation_findings_no_update",
  "semantic_validation_findings_no_delete",
] as const;

/** Constraint indexes backing the v9 synthesis/validation lookups. */
const SCHEMA_V9_INDEXES = [
  "idx_synthesis_inputs_run",
  "idx_synthesis_manifests_input",
  "idx_validation_reports_manifest",
] as const;

/** Finalization/final-plan tables required once the store has reached v10 (Phase 13 §4). */
const SCHEMA_V10_TABLES = [
  "evidence_audit_snapshots",
  "evidence_audit_entries",
  "final_plan_candidates",
  "final_plan_candidate_refs",
  "proposal_final_plan_refs",
  "final_plans",
] as const;

/** Immutability triggers required once the store has reached v10: every
 * finalization record is append-only history (§6/§21/§22/§48/§55). */
const SCHEMA_V10_TRIGGERS = [
  "evidence_audit_snapshots_no_update",
  "evidence_audit_snapshots_no_delete",
  "evidence_audit_entries_no_update",
  "evidence_audit_entries_no_delete",
  "final_plan_candidates_no_update",
  "final_plan_candidates_no_delete",
  "final_plan_candidate_refs_no_update",
  "final_plan_candidate_refs_no_delete",
  "proposal_final_plan_refs_no_update",
  "proposal_final_plan_refs_no_delete",
  "final_plans_no_update",
  "final_plans_no_delete",
] as const;

/** Constraint indexes backing the v10 finalization lookups. */
const SCHEMA_V10_INDEXES = [
  "idx_evidence_audit_entries_audit",
  "idx_final_plan_candidates_run",
  "idx_proposal_final_plan_refs_candidate",
] as const;

/** Execution handoff/binding tables required once the store has reached v11 (Phase 14 §11). */
const SCHEMA_V11_TABLES = [
  "execution_handoffs",
  "execution_handoff_events",
  "execution_handoff_states",
  "execution_bindings",
] as const;

/** Immutability triggers required once the store has reached v11: the handoff
 * contract and its event log are append-only history (§13/§16). The operational
 * state and binding tables are deliberately mutable (§14/§20). */
const SCHEMA_V11_TRIGGERS = [
  "execution_handoffs_no_update",
  "execution_handoffs_no_delete",
  "execution_handoff_events_no_update",
  "execution_handoff_events_no_delete",
] as const;

/** Constraint indexes backing the v11 execution lookups. */
const SCHEMA_V11_INDEXES = [
  "idx_execution_handoff_events_handoff",
  "idx_execution_bindings_active_session",
  "idx_execution_bindings_session",
] as const;

/** ExecutionIssue + successor baseline tables required at schema v12 (Phase 15 §5). */
const SCHEMA_V12_TABLES = [
  "execution_issues",
  "execution_issue_refs",
  "execution_issue_adoptions",
  "planning_run_baselines",
  "planning_run_baseline_issues",
  "planning_run_baseline_scopes",
  "planning_run_baseline_materializations",
] as const;

/** Immutability triggers required at schema v12: the ENTIRE v12 domain is
 * append-only history (§4/§7/§17/§26/§31/§53) — no mutable table exists. */
const SCHEMA_V12_TRIGGERS = [
  "execution_issues_no_update",
  "execution_issues_no_delete",
  "execution_issue_refs_no_update",
  "execution_issue_refs_no_delete",
  "execution_issue_adoptions_no_update",
  "execution_issue_adoptions_no_delete",
  "planning_run_baselines_no_update",
  "planning_run_baselines_no_delete",
  "planning_run_baseline_issues_no_update",
  "planning_run_baseline_issues_no_delete",
  "planning_run_baseline_scopes_no_update",
  "planning_run_baseline_scopes_no_delete",
  "planning_run_baseline_materializations_no_update",
  "planning_run_baseline_materializations_no_delete",
] as const;

/** Constraint indexes backing the v12 issue/baseline lookups. */
const SCHEMA_V12_INDEXES = [
  "idx_execution_issue_refs_issue",
  "idx_execution_issue_adoptions_successor",
  "idx_planning_run_baseline_issues_baseline",
  "idx_planning_run_baseline_scopes_state",
] as const;

/** Run-control authorization table required at schema v13 (Phase 16 §4). */
const SCHEMA_V13_TABLES = [
  "run_control_authorizations",
] as const;

/** Immutability triggers required at schema v13: the durable control
 * authorization is append-only history (§5 — NO UPDATE, NO DELETE). */
const SCHEMA_V13_TRIGGERS = [
  "run_control_authorizations_no_update",
  "run_control_authorizations_no_delete",
] as const;

/** Constraint index backing the v13 per-run control lookups. */
const SCHEMA_V13_INDEXES = [
  "idx_run_control_authorizations_run",
] as const;

/** ExecutionRun tables required at schema v14 (v0.2.0 E1 §8). */
const SCHEMA_V14_TABLES = [
  "execution_runs",
  "execution_run_events",
] as const;

/** Immutability + binding triggers required at schema v14: the ExecutionRun
 * binding (workspace + exact FinalPlan ref + baselines) is permanent — the
 * partial-update trigger aborts any rebinding statement — and the lifecycle
 * event log is append-only history. */
const SCHEMA_V14_TRIGGERS = [
  "execution_runs_binding_immutable",
  "execution_runs_no_delete",
  "execution_run_events_no_update",
  "execution_run_events_no_delete",
] as const;

/** Constraint index backing the v14 per-run lifecycle history. */
const SCHEMA_V14_INDEXES = [
  "idx_execution_run_events_run",
] as const;

/** SupervisorBinding tables required at schema v15 (v0.2.0 E2 §5/§16). */
const SCHEMA_V15_TABLES = [
  "supervisor_bindings",
  "supervisor_binding_events",
] as const;

/** Identity/immutability triggers required at schema v15: the binding identity
 * (run + workspace) is permanent — the partial-update trigger aborts any move —
 * and the ownership event log is append-only history. */
const SCHEMA_V15_TRIGGERS = [
  "supervisor_bindings_identity_immutable",
  "supervisor_bindings_no_delete",
  "supervisor_binding_events_no_update",
  "supervisor_binding_events_no_delete",
] as const;

/** Constraint indexes backing the v15 supervision lookups. */
const SCHEMA_V15_INDEXES = [
  "idx_supervisor_bindings_active_session",
  "idx_supervisor_bindings_session",
  "idx_supervisor_binding_events_run",
] as const;

/** Execution structure tables required at schema v16 (v0.2.0 E3 §22). */
const SCHEMA_V16_TABLES = [
  "execution_stages",
  "verification_windows",
] as const;

/** Identity/immutability triggers required at schema v16: stage provenance and
 * window identity are permanent; no deletes. */
const SCHEMA_V16_TRIGGERS = [
  "execution_stages_provenance_immutable",
  "execution_stages_no_delete",
  "verification_windows_identity_immutable",
  "verification_windows_no_delete",
] as const;

/** Constraint indexes backing the v16 invariants (single active stage, single
 * open window) and lookups. */
const SCHEMA_V16_INDEXES = [
  "idx_execution_stages_active_run",
  "idx_verification_windows_open_run",
  "idx_execution_stages_run",
  "idx_verification_windows_run",
] as const;

/** Execution protocol tables required at schema v17 (v0.2.0 E4 §43). */
const SCHEMA_V17_TABLES = [
  "execution_directives",
  "execution_attempts",
  "execution_reports",
  "execution_protocol_events",
] as const;

/** Immutability triggers required at schema v17: a Directive revision and a
 * Report are historical artifacts (nothing may change after persistence);
 * Attempt identity (exact Directive revision/role/start) is permanent; the
 * protocol event log is append-only. */
const SCHEMA_V17_TRIGGERS = [
  "execution_directives_no_update",
  "execution_directives_no_delete",
  "execution_attempts_identity_immutable",
  "execution_attempts_no_delete",
  "execution_reports_no_update",
  "execution_reports_no_delete",
  "execution_protocol_events_no_update",
  "execution_protocol_events_no_delete",
] as const;

/** Constraint indexes backing the v17 invariants (one Attempt per exact
 * Directive revision via the table UNIQUE, one running Attempt per run via the
 * partial index, one Report per Attempt via the table UNIQUE) and lookups. */
const SCHEMA_V17_INDEXES = [
  "idx_execution_attempts_running_run",
  "idx_execution_directives_run",
  "idx_execution_attempts_run",
  "idx_execution_protocol_events_run",
] as const;

/** Worker invocation tables required at schema v18 (v0.2.0 E5 §45). */
const SCHEMA_V18_TABLES = [
  "execution_worker_invocations",
  "execution_worker_invocation_events",
] as const;

/** Identity/immutability triggers required at schema v18: invocation identity
 * (attempt/run/role/token hash) is permanent, the claimed worker session is
 * set at most once, a finished invocation is terminal, and the runtime event
 * log is append-only. */
const SCHEMA_V18_TRIGGERS = [
  "execution_worker_invocations_identity_immutable",
  "execution_worker_invocations_session_immutable",
  "execution_worker_invocations_finished_terminal",
  "execution_worker_invocations_no_delete",
  "execution_worker_invocation_events_no_update",
  "execution_worker_invocation_events_no_delete",
] as const;

/** Constraint indexes backing the v18 invariants (at most one claimed
 * invocation per worker session) and lookups. */
const SCHEMA_V18_INDEXES = [
  "idx_worker_invocations_claimed_session",
  "idx_worker_invocations_run",
  "idx_worker_invocation_events_attempt",
] as const;

/** Acceptance-layer tables required at schema v19 (v0.2.0 E6 §55). */
const SCHEMA_V19_TABLES = [
  "supervisor_assessments",
  "supervisor_assessment_report_judgments",
  "execution_commits",
  "execution_acceptance_events",
] as const;

/** Immutability triggers required at schema v19: assessments, judgments, and
 * commits are append-only execution memory (no amend, no re-parent, no
 * delete), and the acceptance event log is append-only history. The window
 * accepted-base columns are shape-checked at INSERT and frozen at UPDATE. */
const SCHEMA_V19_TRIGGERS = [
  "supervisor_assessments_no_update",
  "supervisor_assessments_no_delete",
  "supervisor_assessment_report_judgments_no_update",
  "supervisor_assessment_report_judgments_no_delete",
  "execution_commits_no_update",
  "execution_commits_no_delete",
  "execution_acceptance_events_no_update",
  "execution_acceptance_events_no_delete",
  "verification_windows_base_shape",
  "verification_windows_base_immutable",
] as const;

/** Constraint indexes backing the v19 invariants (one commit per run/sequence,
 * one per window, one per accept assessment) and lookups. */
const SCHEMA_V19_INDEXES = [
  "idx_supervisor_assessments_window",
  "idx_supervisor_assessment_report_judgments_report",
  "idx_execution_commits_run",
  "idx_execution_acceptance_events_run",
] as const;

/** Stage-completion constraint triggers required at schema v20 (v0.2.0 E7 §42):
 * a Stage is never created completed, and status = completed ↔ provenance
 * non-null with immutable, terminal semantics. */
const SCHEMA_V20_TRIGGERS = [
  "execution_stages_completion_insert_shape",
  "execution_stages_completion_consistent",
] as const;

/** Verification-policy/conflict objects required at schema v21 (v0.2.0 E8 §45). */
const SCHEMA_V21_TABLES = ["verification_conflicts"] as const;

const SCHEMA_V21_TRIGGERS = [
  "verification_conflicts_identity_immutable",
  "verification_conflicts_no_delete",
] as const;

const SCHEMA_V21_INDEXES = ["idx_verification_conflicts_window"] as const;

/**
 * v0.2.0 E8 §45 anti-fiction pin — before schema 21 the conflict object is
 * fabricated: no phase owns it yet. From schema 21 the E8 layer legitimately
 * owns it and this probe stops.
 */
const FORBIDDEN_BEFORE_V21_OBJECTS = ["verification_conflicts"] as const;

/**
 * v0.2.0 E4 §2/§43 + E5 §45 anti-fiction pin — before schema 19 these
 * execution-progress objects are fabricated: no phase owns them yet. From
 * schema 19 the acceptance layer legitimately owns them and this probe stops.
 */
const FORBIDDEN_BEFORE_V19_OBJECTS = [
  "execution_commits",
  "supervisor_assessments",
  "accepted_head",
] as const;

/**
 * v0.2.0 E7 §42/§43 anti-fiction pin — before schema 20 the Stage-completion
 * provenance column is fabricated: no phase owns it yet (no pre-E7 path could
 * complete a Stage, E7 §43). From schema 20 the progression layer legitimately
 * owns it and this probe stops.
 */
const FORBIDDEN_BEFORE_V20_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["execution_stages", "completed_by_commit_id"],
];

// E10 §61 anti-fiction pin — the execution-scope columns are fabricated until
// schema 23 owns them (no pre-E10 artifact may carry a scope).
const FORBIDDEN_BEFORE_V23_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["verification_windows", "scope_kind"],
  ["execution_directives", "scope_kind"],
  ["supervisor_assessments", "scope_kind"],
  ["execution_commits", "scope_kind"],
  ["execution_runs", "completion_commit_id"],
];

// E11 §51 anti-fiction pin — the reconciliation objects are fabricated until
// schema 24 owns them (no pre-E11 artifact may carry a reconciliation).
const FORBIDDEN_BEFORE_V24_TABLES = [
  "execution_attempt_reconciliation_bindings",
  "execution_attempt_reconciliations",
] as const;

function tableNames(db: StoreConnection | StoreTx): Set<string> {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as TableRow[];
  return new Set(rows.map((row) => row.name));
}

/** Live column probe (validators re-derive shapes; never trust comments). */


function tableHasColumn(db: StoreConnection | StoreTx, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>).some(
    (candidate) => candidate.name === column,
  );
}

function readHistory(db: StoreConnection | StoreTx): MigrationHistoryRow[] {
  const rows = db
    .prepare(
      "SELECT version, name, applied_at AS appliedAt, runtime_version AS runtimeVersion FROM schema_migrations ORDER BY version",
    )
    .all() as unknown as MigrationHistoryRow[];
  return rows;
}

/**
 * Structural checks for the v2 infrastructure tables (frozen plan §42).
 * Uniqueness/CHECK constraints are DDL-enforced; the validator re-derives
 * the invariant facts from DATA so a hand-mangled or partially-written store
 * cannot pass on `user_version = 2` alone.
 */
function validateSchemaV2(db: StoreConnection | StoreTx, tables: Set<string>, problems: string[]): void {
  for (const table of SCHEMA_V2_TABLES) {
    if (!tables.has(table)) {
      problems.push(`${table} table missing for schema version >= 2`);
    }
  }
  if (SCHEMA_V2_TABLES.some((table) => !tables.has(table))) {
    return; // further queries would just cascade errors
  }
  const badGenerations = db
    .prepare("SELECT count(*) AS n FROM session_bindings WHERE generation < 1")
    .get() as { n: number } | undefined;
  if ((badGenerations?.n ?? 0) > 0) {
    problems.push("session_bindings contains generation < 1 rows");
  }
  const badStates = db
    .prepare(
      "SELECT count(*) AS n FROM session_bindings WHERE state NOT IN ('attached', 'detached')",
    )
    .get() as { n: number } | undefined;
  if ((badStates?.n ?? 0) > 0) {
    problems.push("session_bindings contains unknown state values");
  }
  const duplicateActiveSessions = db
    .prepare(
      "SELECT session_id, count(*) AS n FROM session_bindings WHERE state = 'attached' GROUP BY session_id HAVING n > 1 LIMIT 1",
    )
    .get() as { session_id?: string; n: number } | undefined;
  if (duplicateActiveSessions !== undefined) {
    problems.push(
      `session '${duplicateActiveSessions.session_id}' holds multiple attached bindings`,
    );
  }
  const orphanWorkspaces = db
    .prepare(
      "SELECT count(*) AS n FROM workspaces w WHERE NOT EXISTS (SELECT 1 FROM repositories r WHERE r.repository_id = w.repository_id)",
    )
    .get() as { n: number } | undefined;
  if ((orphanWorkspaces?.n ?? 0) > 0) {
    problems.push("workspaces reference missing repositories");
  }
  const orphanBindings = db
    .prepare(
      "SELECT count(*) AS n FROM session_bindings b WHERE NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.workspace_id = b.workspace_id)",
    )
    .get() as { n: number } | undefined;
  if ((orphanBindings?.n ?? 0) > 0) {
    problems.push("session bindings reference missing workspaces");
  }
}

/**
 * PlanningRun data-integrity checks for schema v3 (frozen plan §40). Legacy
 * opaque bindings (run_id with no planning_runs row) are legal and skipped —
 * schema-2 history is preserved, never fabricated into runs.
 */
function validateSchemaV3(db: StoreConnection | StoreTx, tables: Set<string>, problems: string[]): void {
  for (const table of SCHEMA_V3_TABLES) {
    if (!tables.has(table)) {
      problems.push(`${table} table missing for schema version >= 3`);
    }
  }
  if (SCHEMA_V3_TABLES.some((table) => !tables.has(table))) {
    return;
  }
  const badVocabulary = db
    .prepare(
      "SELECT count(*) AS n FROM planning_runs WHERE lifecycle NOT IN ('active','completed','aborted') OR stage NOT IN ('discovery','architecture','detail','synthesis','validation','final')",
    )
    .get() as { n: number } | undefined;
  if ((badVocabulary?.n ?? 0) > 0) {
    problems.push("planning_runs contains illegal lifecycle/stage values");
  }
  const badRevisions = db
    .prepare("SELECT count(*) AS n FROM planning_runs WHERE revision < 1")
    .get() as { n: number } | undefined;
  if ((badRevisions?.n ?? 0) > 0) {
    problems.push("planning_runs contains revision < 1 rows");
  }
  const badGoals = db
    .prepare("SELECT count(*) AS n FROM planning_runs WHERE length(trim(goal)) = 0")
    .get() as { n: number } | undefined;
  if ((badGoals?.n ?? 0) > 0) {
    problems.push("planning_runs contains empty goals");
  }
  const badCompleted = db
    .prepare(
      "SELECT count(*) AS n FROM planning_runs WHERE lifecycle = 'completed' AND stage != 'final'",
    )
    .get() as { n: number } | undefined;
  if ((badCompleted?.n ?? 0) > 0) {
    problems.push("completed planning runs must be at stage final");
  }
  const terminalAttached = db
    .prepare(
      "SELECT count(*) AS n FROM planning_runs r JOIN session_bindings b ON b.run_id = r.run_id WHERE r.lifecycle != 'active' AND b.state = 'attached'",
    )
    .get() as { n: number } | undefined;
  if ((terminalAttached?.n ?? 0) > 0) {
    problems.push("terminal runs still hold attached bindings");
  }
  const workspaceDrift = db
    .prepare(
      "SELECT count(*) AS n FROM session_bindings b JOIN planning_runs r ON r.run_id = b.run_id WHERE b.workspace_id != r.workspace_id",
    )
    .get() as { n: number } | undefined;
  if ((workspaceDrift?.n ?? 0) > 0) {
    problems.push("bindings disagree with their planning run's workspace");
  }
  const orphanRuns = db
    .prepare(
      "SELECT count(*) AS n FROM planning_runs r WHERE NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.workspace_id = r.workspace_id)",
    )
    .get() as { n: number } | undefined;
  if ((orphanRuns?.n ?? 0) > 0) {
    problems.push("planning runs reference missing workspaces");
  }
}

/**
 * Structural Plan Memory checks for schema v4 (frozen plan §50/§E37): table
 * presence, immutability triggers, and supporting indexes. Cheap sqlite_
 * master lookups only — semantic snapshot validation (DAG, contract rules,
 * JSON shape) runs at snapshot creation/read time in the memory primitives,
 * so store open never scans history.
 */
function validateSchemaV4(db: StoreConnection | StoreTx, problems: string[]): void {
  const objectNames = new Set(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','trigger','index')").all() as {
        name: string;
      }[]
    ).map((row) => row.name),
  );
  for (const table of SCHEMA_V4_TABLES) {
    if (!objectNames.has(table)) {
      problems.push(`${table} table missing for schema version >= 4`);
    }
  }
  for (const trigger of SCHEMA_V4_IMMUTABILITY_TRIGGERS) {
    if (!objectNames.has(trigger)) {
      problems.push(`immutability trigger ${trigger} missing for schema version >= 4`);
    }
  }
}

/**
 * Structural Proposal/Approval/PlanCommit checks for schema v5 (frozen plan
 * Phase 6 §98): table presence, immutability + constraint triggers, and the
 * unique indexes that pin one-awaiting-per-run, approval exactness, and the
 * linear commit chain. Cheap sqlite_master lookups plus a PRAGMA column
 * check on the upgraded plan_heads — NO O(history) commit-chain scan (the
 * chain validator runs at commit time and via the explicit read API).
 */
function validateSchemaV5(db: StoreConnection | StoreTx, problems: string[]): void {
  const objectNames = new Set(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','trigger','index')").all() as {
        name: string;
      }[]
    ).map((row) => row.name),
  );
  for (const table of SCHEMA_V5_TABLES) {
    if (!objectNames.has(table)) {
      problems.push(`${table} table missing for schema version >= 5`);
    }
  }
  for (const trigger of SCHEMA_V5_TRIGGERS) {
    if (!objectNames.has(trigger)) {
      problems.push(`constraint trigger ${trigger} missing for schema version >= 5`);
    }
  }
  for (const index of SCHEMA_V5_INDEXES) {
    if (!objectNames.has(index)) {
      problems.push(`constraint index ${index} missing for schema version >= 5`);
    }
  }
  // The upgraded plan_heads must carry the commit side of the HEAD pair.
  const headColumns = db.prepare("PRAGMA table_info(plan_heads)").all() as { name?: unknown }[];
  const columnNames = new Set(headColumns.map((column) => (typeof column.name === "string" ? column.name : "")));
  if (!columnNames.has("head_commit_id")) {
    problems.push("plan_heads is missing head_commit_id for schema version >= 5");
  }
}

/**
 * Structural Observation/Evidence checks for schema v6 (Phase 9 §4/§6/§52):
 * table presence, immutability triggers, and the ledger order + capture
 * idempotency indexes. Cheap sqlite_master lookups only.
 */
function validateSchemaV6(db: StoreConnection | StoreTx, problems: string[]): void {
  const objectNames = new Set(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','trigger','index')").all() as {
        name: string;
      }[]
    ).map((row) => row.name),
  );
  for (const table of SCHEMA_V6_TABLES) {
    if (!objectNames.has(table)) {
      problems.push(`${table} table missing for schema version >= 6`);
    }
  }
  for (const trigger of SCHEMA_V6_TRIGGERS) {
    if (!objectNames.has(trigger)) {
      problems.push(`constraint trigger ${trigger} missing for schema version >= 6`);
    }
  }
  for (const index of SCHEMA_V6_INDEXES) {
    if (!objectNames.has(index)) {
      problems.push(`constraint index ${index} missing for schema version >= 6`);
    }
  }
}

/**
 * Structural freshness/Proposal-V2 checks for schema v7 (Phase 10 §4/§5/§7):
 * table presence, immutability + terminal-state triggers, and the validation
 * history / derived-upstream lookup indexes. Cheap sqlite_master lookups only.
 */
function validateSchemaV7(db: StoreConnection | StoreTx, problems: string[]): void {
  const objectNames = new Set(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','trigger','index')").all() as {
        name: string;
      }[]
    ).map((row) => row.name),
  );
  for (const table of SCHEMA_V7_TABLES) {
    if (!objectNames.has(table)) {
      problems.push(`${table} table missing for schema version >= 7`);
    }
  }
  for (const trigger of SCHEMA_V7_TRIGGERS) {
    if (!objectNames.has(trigger)) {
      problems.push(`constraint trigger ${trigger} missing for schema version >= 7`);
    }
  }
  for (const index of SCHEMA_V7_INDEXES) {
    if (!objectNames.has(index)) {
      problems.push(`constraint index ${index} missing for schema version >= 7`);
    }
  }
}

/**
 * Structural + data checks for schema v8 (Phase 11 §69): table/trigger/index
 * presence plus the workflow-invariant facts — materialized state matches its
 * last event, every Section identity has a workflow state, completion
 * provenance references real Section revisions, and active work points at a
 * Section in the run's current HEAD snapshot. Targeted LIMIT-1 queries only —
 * never a full-history replay at store open.
 */
function validateSchemaV8(db: StoreConnection | StoreTx, version: number, problems: string[]): void {
  const objectNames = new Set(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','trigger','index')").all() as {
        name: string;
      }[]
    ).map((row) => row.name),
  );
  for (const table of SCHEMA_V8_TABLES) {
    if (!objectNames.has(table)) {
      problems.push(`${table} table missing for schema version >= 8`);
    }
  }
  for (const trigger of SCHEMA_V8_TRIGGERS) {
    if (!objectNames.has(trigger)) {
      problems.push(`constraint trigger ${trigger} missing for schema version >= 8`);
    }
  }
  for (const index of SCHEMA_V8_INDEXES) {
    if (!objectNames.has(index)) {
      problems.push(`constraint index ${index} missing for schema version >= 8`);
    }
  }
  if (SCHEMA_V8_TABLES.some((table) => !objectNames.has(table))) {
    return; // further queries would just cascade errors
  }
  // The data-level checks below also read Plan Memory base tables; when an
  // earlier-version validator has already flagged those as missing, skip
  // instead of cascading SQL errors.
  const baseWorldPresent =
    objectNames.has("memory_artifacts") && objectNames.has("memory_revisions") && objectNames.has("plan_heads") && objectNames.has("snapshot_members");
  if (!baseWorldPresent) {
    return;
  }
  // Materialized state must equal its last workflow event's target state (§7/§69).
  const stateEventDrift = db
    .prepare(
      "SELECT s.run_id AS runId, s.section_id AS sectionId FROM section_workflow_states s "
      + "JOIN section_workflow_events e ON e.run_id = s.run_id AND e.event_seq = s.last_event_seq "
      + "WHERE e.to_state != s.status LIMIT 1",
    )
    .get() as { runId?: string; sectionId?: string } | undefined;
  if (stateEventDrift !== undefined) {
    problems.push(
      `section workflow state '${stateEventDrift.sectionId}' in run '${stateEventDrift.runId}' does not match its last workflow event`,
    );
  }
  // Every Section identity has a workflow state row (backfill completeness).
  // Phase 15: an inherited_completed Section of a successor baseline stays
  // row-less BY DESIGN (§28 — completion comes from the baseline merge, never
  // a fabricated local row), so those identities are exempt from v12 on.
  const missingState = db
    .prepare(
      version >= 12
        ? "SELECT a.run_id AS runId, a.artifact_id AS sectionId FROM memory_artifacts a "
          + "WHERE a.kind = 'section' AND NOT EXISTS ("
          + "SELECT 1 FROM section_workflow_states s WHERE s.run_id = a.run_id AND s.section_id = a.artifact_id) "
          + "AND NOT EXISTS ("
          + "SELECT 1 FROM planning_run_baselines b "
          + "JOIN planning_run_baseline_scopes bs ON bs.baseline_id = b.baseline_id "
          + "WHERE b.successor_run_id = a.run_id AND bs.section_id = a.artifact_id "
          + "AND bs.scope_state = 'inherited_completed') LIMIT 1"
        : "SELECT a.run_id AS runId, a.artifact_id AS sectionId FROM memory_artifacts a "
          + "WHERE a.kind = 'section' AND NOT EXISTS ("
          + "SELECT 1 FROM section_workflow_states s WHERE s.run_id = a.run_id AND s.section_id = a.artifact_id) LIMIT 1",
    )
    .get() as { runId?: string; sectionId?: string } | undefined;
  if (missingState !== undefined) {
    problems.push(`section '${missingState.sectionId}' in run '${missingState.runId}' has no workflow state`);
  }
  // A workflow state without a real Section identity is corruption.
  const orphanState = db
    .prepare(
      "SELECT s.run_id AS runId, s.section_id AS sectionId FROM section_workflow_states s "
      + "WHERE NOT EXISTS ("
      + "SELECT 1 FROM memory_artifacts a WHERE a.run_id = s.run_id AND a.kind = 'section' AND a.artifact_id = s.section_id) LIMIT 1",
    )
    .get() as { runId?: string; sectionId?: string } | undefined;
  if (orphanState !== undefined) {
    problems.push(
      `section workflow state '${orphanState.sectionId}' in run '${orphanState.runId}' references a missing section identity`,
    );
  }
  // completed_revision must reference a real Section revision (§69).
  const badCompletedRevision = db
    .prepare(
      "SELECT s.run_id AS runId, s.section_id AS sectionId, s.completed_revision AS revision FROM section_workflow_states s "
      + "WHERE s.completed_revision IS NOT NULL AND NOT EXISTS ("
      + "SELECT 1 FROM memory_revisions m WHERE m.run_id = s.run_id AND m.kind = 'section' "
      + "AND m.artifact_id = s.section_id AND m.revision = s.completed_revision) LIMIT 1",
    )
    .get() as { runId?: string; sectionId?: string; revision?: number } | undefined;
  if (badCompletedRevision !== undefined) {
    problems.push(
      `completed revision ${badCompletedRevision.revision} for section '${badCompletedRevision.sectionId}' in run '${badCompletedRevision.runId}' references a missing section revision`,
    );
  }
  // Active work must point at a Section in the run's current HEAD snapshot
  // (§69) — OR, for a Phase 15 successor whose baseline is not yet
  // materialized (HEAD intentionally absent until the first authorized
  // commit), at a needs_review Section of that baseline. The exemption needs
  // the v12 baseline tables, so it applies only from schema version 12 on.
  const badActiveWork = db
    .prepare(
      version >= 12
        ? "SELECT w.run_id AS runId, w.section_id AS sectionId FROM planning_active_work w "
          + "WHERE NOT EXISTS ("
          + "SELECT 1 FROM plan_heads h JOIN snapshot_members sm ON sm.snapshot_id = h.head_snapshot_id "
          + "WHERE h.run_id = w.run_id AND sm.run_id = w.run_id AND sm.kind = 'section' AND sm.artifact_id = w.section_id) "
          + "AND NOT EXISTS ("
          + "SELECT 1 FROM planning_run_baselines b "
          + "JOIN planning_run_baseline_scopes bs ON bs.baseline_id = b.baseline_id "
          + "WHERE b.successor_run_id = w.run_id AND bs.section_id = w.section_id "
          + "AND bs.scope_state = 'needs_review' AND NOT EXISTS ("
          + "SELECT 1 FROM planning_run_baseline_materializations m WHERE m.baseline_id = b.baseline_id)) LIMIT 1"
        : "SELECT w.run_id AS runId, w.section_id AS sectionId FROM planning_active_work w "
          + "WHERE NOT EXISTS ("
          + "SELECT 1 FROM plan_heads h JOIN snapshot_members sm ON sm.snapshot_id = h.head_snapshot_id "
          + "WHERE h.run_id = w.run_id AND sm.run_id = w.run_id AND sm.kind = 'section' AND sm.artifact_id = w.section_id) LIMIT 1",
    )
    .get() as { runId?: string; sectionId?: string } | undefined;
  if (badActiveWork !== undefined) {
    problems.push(
      `active section '${badActiveWork.sectionId}' in run '${badActiveWork.runId}' is not present in the current HEAD snapshot`,
    );
  }
}

/**
 * Structural + data checks for schema v9 (Phase 12 §90): table/trigger/index
 * presence plus the synthesis-domain identity facts — an input's base
 * snapshot belongs to its run and its base commit produced exactly that
 * snapshot, input refs are exact members of the base snapshot, manifests bind
 * the exact input (hash included) and only cite input refs, reports bind the
 * exact manifest/input, finding refs stay inside the frozen bundle, clean is
 * exclusive, and the immutability triggers exist. Targeted LIMIT-1 queries —
 * never a full-history replay at store open.
 */
function validateSchemaV9(db: StoreConnection | StoreTx, problems: string[]): void {
  const objectNames = new Set(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','trigger','index')").all() as {
        name: string;
      }[]
    ).map((row) => row.name),
  );
  for (const table of SCHEMA_V9_TABLES) {
    if (!objectNames.has(table)) {
      problems.push(`${table} table missing for schema version >= 9`);
    }
  }
  for (const trigger of SCHEMA_V9_TRIGGERS) {
    if (!objectNames.has(trigger)) {
      problems.push(`constraint trigger ${trigger} missing for schema version >= 9`);
    }
  }
  for (const index of SCHEMA_V9_INDEXES) {
    if (!objectNames.has(index)) {
      problems.push(`constraint index ${index} missing for schema version >= 9`);
    }
  }
  if (SCHEMA_V9_TABLES.some((table) => !objectNames.has(table))) {
    return; // further queries would just cascade errors
  }
  // The data-level checks below also read earlier base tables; when an
  // earlier-version validator has already flagged those as missing, skip
  // instead of cascading SQL errors.
  const baseWorldPresent =
    objectNames.has("plan_commits") && objectNames.has("snapshot_members") && objectNames.has("memory_revisions") && objectNames.has("evidence_revisions");
  if (!baseWorldPresent) {
    return;
  }
  // Input base commit must produce the input's base snapshot (§90).
  const basePairDrift = db
    .prepare(
      "SELECT i.run_id AS runId, i.input_id AS inputId FROM synthesis_inputs i "
      + "JOIN plan_commits c ON c.run_id = i.run_id AND c.commit_id = i.base_head_commit_id "
      + "WHERE c.resulting_snapshot_id != i.base_head_snapshot_id LIMIT 1",
    )
    .get() as { runId?: string; inputId?: string } | undefined;
  if (basePairDrift !== undefined) {
    problems.push(
      `synthesis input '${basePairDrift.inputId}' in run '${basePairDrift.runId}' has a base commit whose resulting snapshot is not the base snapshot`,
    );
  }
  // Input refs must be exact members of the base snapshot (§16/§90).
  const refOutsideSnapshot = db
    .prepare(
      "SELECT r.run_id AS runId, r.input_id AS inputId, r.artifact_id AS artifactId FROM synthesis_input_refs r "
      + "JOIN synthesis_inputs i ON i.run_id = r.run_id AND i.input_id = r.input_id "
      + "WHERE NOT EXISTS (SELECT 1 FROM snapshot_members sm WHERE sm.snapshot_id = i.base_head_snapshot_id "
      + "AND sm.run_id = r.run_id AND sm.kind = r.kind AND sm.artifact_id = r.artifact_id AND sm.revision = r.revision) LIMIT 1",
    )
    .get() as { runId?: string; inputId?: string; artifactId?: string } | undefined;
  if (refOutsideSnapshot !== undefined) {
    problems.push(
      `synthesis input '${refOutsideSnapshot.inputId}' in run '${refOutsideSnapshot.runId}' references '${refOutsideSnapshot.artifactId}' outside its base snapshot`,
    );
  }
  // A manifest must carry the exact input hash of its input (§35/§90).
  const manifestHashDrift = db
    .prepare(
      "SELECT m.run_id AS runId, m.manifest_id AS manifestId FROM synthesis_manifests m "
      + "JOIN synthesis_inputs i ON i.run_id = m.run_id AND i.input_id = m.input_id "
      + "WHERE m.input_hash != i.input_hash LIMIT 1",
    )
    .get() as { runId?: string; manifestId?: string } | undefined;
  if (manifestHashDrift !== undefined) {
    problems.push(
      `synthesis manifest '${manifestHashDrift.manifestId}' in run '${manifestHashDrift.runId}' does not bind its input's exact hash`,
    );
  }
  // Manifest supporting refs must be a subset of the input refs (§38/§90).
  const manifestRefOutsideInput = db
    .prepare(
      "SELECT r.run_id AS runId, r.manifest_id AS manifestId, r.kind AS kind, r.artifact_id AS artifactId "
      + "FROM synthesis_manifest_refs r JOIN synthesis_manifests m ON m.run_id = r.run_id AND m.manifest_id = r.manifest_id "
      + "WHERE NOT EXISTS (SELECT 1 FROM synthesis_input_refs ir WHERE ir.run_id = r.run_id AND ir.input_id = m.input_id "
      + "AND ir.kind = (CASE r.kind WHEN 'section_contract' THEN 'section' ELSE r.kind END) "
      + "AND ir.artifact_id = r.artifact_id AND ir.revision = r.revision) "
      + "AND NOT EXISTS (SELECT 1 FROM synthesis_input_evidence ie WHERE ie.run_id = r.run_id AND ie.input_id = m.input_id "
      + "AND r.kind = 'evidence' AND ie.evidence_id = r.artifact_id AND ie.evidence_revision = r.revision) LIMIT 1",
    )
    .get() as { runId?: string; manifestId?: string; kind?: string; artifactId?: string } | undefined;
  if (manifestRefOutsideInput !== undefined) {
    problems.push(
      `synthesis manifest '${manifestRefOutsideInput.manifestId}' in run '${manifestRefOutsideInput.runId}' cites '${manifestRefOutsideInput.artifactId}' (${manifestRefOutsideInput.kind}) outside its frozen input`,
    );
  }
  // A report must reference the exact manifest AND the manifest's exact input
  // with matching hashes (§46/§90).
  const reportBindingDrift = db
    .prepare(
      "SELECT r.run_id AS runId, r.report_id AS reportId FROM semantic_validation_reports r "
      + "JOIN synthesis_manifests m ON m.run_id = r.run_id AND m.manifest_id = r.manifest_id "
      + "WHERE r.input_id != m.input_id OR r.manifest_hash != m.manifest_hash "
      + "OR r.input_hash != (SELECT i.input_hash FROM synthesis_inputs i WHERE i.run_id = r.run_id AND i.input_id = m.input_id) LIMIT 1",
    )
    .get() as { runId?: string; reportId?: string } | undefined;
  if (reportBindingDrift !== undefined) {
    problems.push(
      `validation report '${reportBindingDrift.reportId}' in run '${reportBindingDrift.runId}' does not bind its manifest/input exactly`,
    );
  }
  // Finding refs must belong to the frozen validation bundle (§37/§90) —
  // subject and supporting refs alike. Refs are JSON projections
  // ({kind,id,revision}); json_extract keeps the check inside SQL.
  const findingRefQueries = [
    "f.subject_refs_json",
    "f.supporting_refs_json",
  ];
  for (const column of findingRefQueries) {
    const findingRefOutsideBundle = db
      .prepare(
        `SELECT f.run_id AS runId, f.finding_id AS findingId, je.value AS ref FROM semantic_validation_findings f `
        + `JOIN json_each(${column}) je WHERE json_valid(je.value) AND NOT EXISTS (`
        + "SELECT 1 FROM semantic_validation_reports r JOIN synthesis_input_refs ir ON ir.run_id = r.run_id AND ir.input_id = r.input_id "
        + "WHERE r.run_id = f.run_id AND r.report_id = f.report_id "
        + "AND ir.kind = (CASE json_extract(je.value,'$.kind') WHEN 'section_contract' THEN 'section' ELSE json_extract(je.value,'$.kind') END) "
        + "AND ir.artifact_id = json_extract(je.value,'$.id') AND ir.revision = json_extract(je.value,'$.revision') "
        + ") AND NOT EXISTS ("
        + "SELECT 1 FROM semantic_validation_reports r2 JOIN synthesis_input_evidence ie ON ie.run_id = r2.run_id AND ie.input_id = r2.input_id "
        + "WHERE r2.run_id = f.run_id AND r2.report_id = f.report_id AND json_extract(je.value,'$.kind') = 'evidence' "
        + "AND ie.evidence_id = json_extract(je.value,'$.id') AND ie.evidence_revision = json_extract(je.value,'$.revision') "
        + ") LIMIT 1",
      )
      .get() as { runId?: string; findingId?: string; ref?: string } | undefined;
    if (findingRefOutsideBundle !== undefined) {
      problems.push(
        `validation finding '${findingRefOutsideBundle.findingId}' in run '${findingRefOutsideBundle.runId}' cites a ref outside the frozen bundle (${column})`,
      );
    }
  }
  // clean exclusivity (§48): is_clean=1 ⇔ findings are exactly [clean].
  const badCleanReport = db
    .prepare(
      "SELECT r.run_id AS runId, r.report_id AS reportId FROM semantic_validation_reports r "
      + "WHERE (r.is_clean = 1 AND ((SELECT COUNT(*) FROM semantic_validation_findings f "
      + "WHERE f.run_id = r.run_id AND f.report_id = r.report_id AND f.kind = 'clean') != 1 "
      + "OR (SELECT COUNT(*) FROM semantic_validation_findings f "
      + "WHERE f.run_id = r.run_id AND f.report_id = r.report_id AND f.kind != 'clean') != 0)) "
      + "OR (r.is_clean = 0 AND ((SELECT COUNT(*) FROM semantic_validation_findings f "
      + "WHERE f.run_id = r.run_id AND f.report_id = r.report_id AND f.kind = 'clean') != 0 "
      + "OR (SELECT COUNT(*) FROM semantic_validation_findings f "
      + "WHERE f.run_id = r.run_id AND f.report_id = r.report_id) = 0)) LIMIT 1",
    )
    .get() as { runId?: string; reportId?: string } | undefined;
  if (badCleanReport !== undefined) {
    problems.push(
      `validation report '${badCleanReport.reportId}' in run '${badCleanReport.runId}' violates clean exclusivity`,
    );
  }
}

/**
 * Structural + data checks for schema v10 (Phase 13 §91): finalization tables
 * and immutability triggers exist; audit entries point to exact same-run
 * Evidence revisions; candidate base HEAD/commit pairs are valid and the
 * synthesis chain is exact; candidate refs belong to the frozen synthesis
 * world; the proposal↔candidate binding carries the exact candidate hash; a
 * FinalPlan references its exact candidate and its approval/proposal/commit
 * all correspond, with the Final PlanCommit's resulting snapshot in the same
 * run; FinalPlan stays unique per run. Store-open NEVER re-runs the
 * FinalizationGate (§91) — only these identity facts.
 */
function validateSchemaV10(db: StoreConnection | StoreTx, problems: string[]): void {
  const objectNames = new Set(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','trigger','index')").all() as {
        name: string;
      }[]
    ).map((row) => row.name),
  );
  for (const table of SCHEMA_V10_TABLES) {
    if (!objectNames.has(table)) {
      problems.push(`${table} table missing for schema version >= 10`);
    }
  }
  for (const trigger of SCHEMA_V10_TRIGGERS) {
    if (!objectNames.has(trigger)) {
      problems.push(`constraint trigger ${trigger} missing for schema version >= 10`);
    }
  }
  for (const index of SCHEMA_V10_INDEXES) {
    if (!objectNames.has(index)) {
      problems.push(`constraint index ${index} missing for schema version >= 10`);
    }
  }
  if (SCHEMA_V10_TABLES.some((table) => !objectNames.has(table))) {
    return;
  }
  const baseWorldPresent =
    objectNames.has("plan_commits") && objectNames.has("snapshot_members") && objectNames.has("proposals") && objectNames.has("synthesis_inputs");
  if (!baseWorldPresent) {
    return;
  }
  // Audit entries must point to exact same-run Evidence revisions (§91).
  const auditEntryDrift = db
    .prepare(
      "SELECT e.run_id AS runId, e.audit_id AS auditId, e.evidence_id AS evidenceId FROM evidence_audit_entries e "
      + "WHERE NOT EXISTS (SELECT 1 FROM evidence_revisions r WHERE r.run_id = e.run_id "
      + "AND r.evidence_id = e.evidence_id AND r.revision = e.evidence_revision) LIMIT 1",
    )
    .get() as { runId?: string; auditId?: string; evidenceId?: string } | undefined;
  if (auditEntryDrift !== undefined) {
    problems.push(
      `evidence audit '${auditEntryDrift.auditId}' in run '${auditEntryDrift.runId}' references missing evidence revision '${auditEntryDrift.evidenceId}'`,
    );
  }
  // Candidate base HEAD/commit pair must be a real commit-chain pair (§91).
  const candidateBaseDrift = db
    .prepare(
      "SELECT c.run_id AS runId, c.candidate_id AS candidateId FROM final_plan_candidates c "
      + "JOIN plan_commits p ON p.run_id = c.run_id AND p.commit_id = c.base_head_commit_id "
      + "WHERE p.resulting_snapshot_id != c.base_head_snapshot_id LIMIT 1",
    )
    .get() as { runId?: string; candidateId?: string } | undefined;
  if (candidateBaseDrift !== undefined) {
    problems.push(
      `final plan candidate '${candidateBaseDrift.candidateId}' in run '${candidateBaseDrift.runId}' has a base commit whose resulting snapshot is not the base snapshot`,
    );
  }
  // The candidate's synthesis chain must be exact (§17/§91).
  const candidateChainDrift = db
    .prepare(
      "SELECT c.run_id AS runId, c.candidate_id AS candidateId FROM final_plan_candidates c "
      + "JOIN synthesis_inputs i ON i.run_id = c.run_id AND i.input_id = c.input_id "
      + "JOIN synthesis_manifests m ON m.run_id = c.run_id AND m.manifest_id = c.manifest_id "
      + "JOIN semantic_validation_reports r ON r.run_id = c.run_id AND r.report_id = c.report_id "
      + "WHERE c.input_hash != i.input_hash OR m.input_id != c.input_id OR m.input_hash != c.input_hash "
      + "OR m.manifest_hash != c.manifest_hash OR r.manifest_id != c.manifest_id OR r.manifest_hash != c.manifest_hash "
      + "OR r.input_id != c.input_id OR r.input_hash != c.input_hash OR r.is_clean != 1 LIMIT 1",
    )
    .get() as { runId?: string; candidateId?: string } | undefined;
  if (candidateChainDrift !== undefined) {
    problems.push(
      `final plan candidate '${candidateChainDrift.candidateId}' in run '${candidateChainDrift.runId}' does not bind an exact clean synthesis chain`,
    );
  }
  // Candidate refs must belong to the frozen synthesis world (§91).
  const candidateRefOutsideInput = db
    .prepare(
      "SELECT r.run_id AS runId, r.candidate_id AS candidateId, r.family AS family, r.artifact_id AS artifactId "
      + "FROM final_plan_candidate_refs r JOIN final_plan_candidates c ON c.run_id = r.run_id AND c.candidate_id = r.candidate_id "
      + "WHERE r.family != 'evidence' AND NOT EXISTS (SELECT 1 FROM synthesis_input_refs ir WHERE ir.run_id = r.run_id "
      + "AND ir.input_id = c.input_id AND ir.kind = r.family AND ir.artifact_id = r.artifact_id AND ir.revision = r.revision) LIMIT 1",
    )
    .get() as { runId?: string; candidateId?: string; family?: string; artifactId?: string } | undefined;
  if (candidateRefOutsideInput !== undefined) {
    problems.push(
      `final plan candidate '${candidateRefOutsideInput.candidateId}' in run '${candidateRefOutsideInput.runId}' references '${candidateRefOutsideInput.artifactId}' (${candidateRefOutsideInput.family}) outside its frozen input`,
    );
  }
  const candidateEvidenceOutsideInput = db
    .prepare(
      "SELECT r.run_id AS runId, r.candidate_id AS candidateId, r.artifact_id AS artifactId "
      + "FROM final_plan_candidate_refs r JOIN final_plan_candidates c ON c.run_id = r.run_id AND c.candidate_id = r.candidate_id "
      + "WHERE r.family = 'evidence' AND NOT EXISTS (SELECT 1 FROM synthesis_input_evidence ie WHERE ie.run_id = r.run_id "
      + "AND ie.input_id = c.input_id AND ie.evidence_id = r.artifact_id AND ie.evidence_revision = r.revision) LIMIT 1",
    )
    .get() as { runId?: string; candidateId?: string; artifactId?: string } | undefined;
  if (candidateEvidenceOutsideInput !== undefined) {
    problems.push(
      `final plan candidate '${candidateEvidenceOutsideInput.candidateId}' in run '${candidateEvidenceOutsideInput.runId}' references evidence '${candidateEvidenceOutsideInput.artifactId}' outside its frozen input`,
    );
  }
  // The proposal↔candidate binding must carry the candidate's exact hash (§91).
  const proposalRefHashDrift = db
    .prepare(
      "SELECT p.run_id AS runId, p.proposal_id AS proposalId FROM proposal_final_plan_refs p "
      + "JOIN final_plan_candidates c ON c.run_id = p.run_id AND c.candidate_id = p.candidate_id "
      + "WHERE p.candidate_hash != c.candidate_hash LIMIT 1",
    )
    .get() as { runId?: string; proposalId?: string } | undefined;
  if (proposalRefHashDrift !== undefined) {
    problems.push(
      `final plan proposal '${proposalRefHashDrift.proposalId}' in run '${proposalRefHashDrift.runId}' binds a stale candidate hash`,
    );
  }
  // A FinalPlan must reference its exact candidate and correspond to its
  // approval/proposal/commit chain, with the commit's snapshot in-run (§91).
  const finalPlanDrift = db
    .prepare(
      "SELECT f.run_id AS runId, f.final_plan_id AS finalPlanId FROM final_plans f "
      + "LEFT JOIN final_plan_candidates c ON c.run_id = f.run_id AND c.candidate_id = f.candidate_id AND c.candidate_hash = f.candidate_hash "
      + "LEFT JOIN proposals pr ON pr.run_id = f.run_id AND pr.proposal_id = f.proposal_id "
      + "LEFT JOIN proposal_states ps ON ps.run_id = f.run_id AND ps.proposal_id = f.proposal_id AND ps.revision = f.proposal_revision AND ps.status = 'approved' "
      + "LEFT JOIN approvals a ON a.approval_id = f.approval_id AND a.run_id = f.run_id AND a.proposal_id = f.proposal_id "
      + "LEFT JOIN plan_commits pc ON pc.commit_id = f.commit_id AND pc.run_id = f.run_id AND pc.approval_id = f.approval_id "
      + "LEFT JOIN plan_snapshots s ON s.run_id = f.run_id AND s.snapshot_id = f.snapshot_id "
      + "WHERE c.candidate_id IS NULL OR pr.proposal_id IS NULL OR ps.proposal_id IS NULL "
      + "OR a.approval_id IS NULL OR pc.commit_id IS NULL OR s.snapshot_id IS NULL "
      + "OR pc.resulting_snapshot_id != f.snapshot_id LIMIT 1",
    )
    .get() as { runId?: string; finalPlanId?: string } | undefined;
  if (finalPlanDrift !== undefined) {
    problems.push(
      `final plan '${finalPlanDrift.finalPlanId}' in run '${finalPlanDrift.runId}' has broken candidate/proposal/approval/commit/snapshot provenance`,
    );
  }
  // Final PlanCommit must reference the final proposal revision exactly.
  const finalCommitDrift = db
    .prepare(
      "SELECT f.run_id AS runId, f.final_plan_id AS finalPlanId FROM final_plans f "
      + "JOIN plan_commits pc ON pc.run_id = f.run_id AND pc.commit_id = f.commit_id "
      + "WHERE pc.proposal_id != f.proposal_id OR pc.proposal_revision != f.proposal_revision LIMIT 1",
    )
    .get() as { runId?: string; finalPlanId?: string } | undefined;
  if (finalCommitDrift !== undefined) {
    problems.push(
      `final plan '${finalCommitDrift.finalPlanId}' in run '${finalCommitDrift.runId}' has a Final PlanCommit that does not reference its final proposal`,
    );
  }
}

/**
 * Structural + data checks for schema v11 (Phase 14 §97/§136): execution
 * tables and immutability triggers exist; a handoff binds the same-run
 * approved FinalPlan and its stored hash matches its canonical payload; one
 * canonical handoff per run/FinalPlan; the materialized delivery state points
 * at the newest event with a coherent status; DELIVERED has PREPARED lineage;
 * an ExecutionBinding belongs to the run's own workspace; a completed run
 * carrying a Phase-14 handoff has that handoff delivered, and a delivered
 * handoff has its approved FinalPlan in place. Store-open NEVER replays the
 * handoff history (§136) — only these bounded facts.
 */
function validateSchemaV11(db: StoreConnection | StoreTx, problems: string[]): void {
  const objectNames = new Set(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','trigger','index')").all() as {
        name: string;
      }[]
    ).map((row) => row.name),
  );
  for (const table of SCHEMA_V11_TABLES) {
    if (!objectNames.has(table)) {
      problems.push(`${table} table missing for schema version >= 11`);
    }
  }
  for (const trigger of SCHEMA_V11_TRIGGERS) {
    if (!objectNames.has(trigger)) {
      problems.push(`constraint trigger ${trigger} missing for schema version >= 11`);
    }
  }
  for (const index of SCHEMA_V11_INDEXES) {
    if (!objectNames.has(index)) {
      problems.push(`constraint index ${index} missing for schema version >= 11`);
    }
  }
  if (SCHEMA_V11_TABLES.some((table) => !objectNames.has(table))) {
    return;
  }
  const baseWorldPresent = objectNames.has("final_plans") && objectNames.has("planning_runs");
  if (!baseWorldPresent) {
    return;
  }
  // A handoff must bind the same-run approved FinalPlan (§97).
  const handoffFinalPlanDrift = db
    .prepare(
      "SELECT h.run_id AS runId, h.handoff_id AS handoffId FROM execution_handoffs h "
      + "LEFT JOIN final_plans f ON f.run_id = h.run_id AND f.final_plan_id = h.final_plan_id "
      + "WHERE f.final_plan_id IS NULL OR f.final_plan_hash != h.final_plan_hash LIMIT 1",
    )
    .get() as { runId?: string; handoffId?: string } | undefined;
  if (handoffFinalPlanDrift !== undefined) {
    problems.push(
      `execution handoff '${handoffFinalPlanDrift.handoffId}' in run '${handoffFinalPlanDrift.runId}' does not bind its run's approved FinalPlan`,
    );
  }
  // The stored handoff hash must match the canonical payload (§97).
  const handoffRows = db
    .prepare("SELECT run_id AS runId, handoff_id AS handoffId, canonical_json AS canonicalJson, handoff_hash AS handoffHash FROM execution_handoffs")
    .all() as Array<{ runId: string; handoffId: string; canonicalJson: string; handoffHash: string }>;
  for (const row of handoffRows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.canonicalJson);
    } catch {
      problems.push(`execution handoff '${row.handoffId}' in run '${row.runId}' has unparsable canonical payload`);
      continue;
    }
    if (
      parsed === null
      || typeof parsed !== "object"
      || executionHandoffHash(parsed as ExecutionHandoffV1) !== row.handoffHash
    ) {
      problems.push(`execution handoff '${row.handoffId}' in run '${row.runId}' hash does not match its canonical payload`);
    }
  }
  // One canonical handoff per run and per FinalPlan is DDL-enforced; probe the
  // materialized state coherence (§97): last_event_seq is the newest event and
  // the status matches the last event's type.
  const stateDrift = db
    .prepare(
      "SELECT s.run_id AS runId, s.handoff_id AS handoffId FROM execution_handoff_states s "
      + "WHERE s.last_event_seq != (SELECT COALESCE(MAX(e.event_seq), 0) FROM execution_handoff_events e "
      + "WHERE e.run_id = s.run_id AND e.handoff_id = s.handoff_id) "
      + "OR (s.status = 'delivered' AND (SELECT e.event_type FROM execution_handoff_events e "
      + "WHERE e.run_id = s.run_id AND e.handoff_id = s.handoff_id AND e.event_seq = s.last_event_seq) != 'DELIVERED') "
      + "OR (s.status = 'prepared' AND (SELECT e.event_type FROM execution_handoff_events e "
      + "WHERE e.run_id = s.run_id AND e.handoff_id = s.handoff_id AND e.event_seq = s.last_event_seq) = 'DELIVERED') LIMIT 1",
    )
    .get() as { runId?: string; handoffId?: string } | undefined;
  if (stateDrift !== undefined) {
    problems.push(
      `execution handoff state for '${stateDrift.handoffId}' in run '${stateDrift.runId}' is not coherent with its event history`,
    );
  }
  // Every DELIVERED must descend from a PREPARED of the same handoff (§97).
  const deliveredWithoutPrepared = db
    .prepare(
      "SELECT d.run_id AS runId, d.handoff_id AS handoffId FROM execution_handoff_events d "
      + "WHERE d.event_type = 'DELIVERED' AND NOT EXISTS (SELECT 1 FROM execution_handoff_events p "
      + "WHERE p.run_id = d.run_id AND p.handoff_id = d.handoff_id AND p.event_type = 'PREPARED' "
      + "AND p.event_seq < d.event_seq) LIMIT 1",
    )
    .get() as { runId?: string; handoffId?: string } | undefined;
  if (deliveredWithoutPrepared !== undefined) {
    problems.push(
      `execution handoff '${deliveredWithoutPrepared.handoffId}' in run '${deliveredWithoutPrepared.runId}' has a DELIVERED event without PREPARED lineage`,
    );
  }
  // An ExecutionBinding must belong to its run's own workspace (§97).
  const bindingWorkspaceDrift = db
    .prepare(
      "SELECT b.final_plan_id AS finalPlanId FROM execution_bindings b "
      + "JOIN planning_runs r ON r.run_id = b.run_id "
      + "WHERE r.workspace_id != b.workspace_id LIMIT 1",
    )
    .get() as { finalPlanId?: string } | undefined;
  if (bindingWorkspaceDrift !== undefined) {
    problems.push(
      `execution binding for FinalPlan '${bindingWorkspaceDrift.finalPlanId}' does not belong to its run's workspace`,
    );
  }
  // A completed run with a Phase-14 handoff must have it delivered, and a
  // delivered handoff must have its approved FinalPlan in place (§97).
  const completedUndelivered = db
    .prepare(
      "SELECT h.run_id AS runId, h.handoff_id AS handoffId FROM execution_handoffs h "
      + "JOIN planning_runs r ON r.run_id = h.run_id "
      + "LEFT JOIN execution_handoff_states s ON s.run_id = h.run_id AND s.handoff_id = h.handoff_id "
      + "WHERE r.lifecycle = 'completed' AND (s.status IS NULL OR s.status != 'delivered') LIMIT 1",
    )
    .get() as { runId?: string; handoffId?: string } | undefined;
  if (completedUndelivered !== undefined) {
    problems.push(
      `completed run '${completedUndelivered.runId}' still carries undelivered execution handoff '${completedUndelivered.handoffId}'`,
    );
  }
  const deliveredWithoutApproval = db
    .prepare(
      "SELECT h.run_id AS runId, h.handoff_id AS handoffId FROM execution_handoffs h "
      + "JOIN execution_handoff_states s ON s.run_id = h.run_id AND s.handoff_id = h.handoff_id "
      + "LEFT JOIN final_plans f ON f.run_id = h.run_id AND f.final_plan_id = h.final_plan_id "
      + "LEFT JOIN proposal_states ps ON ps.run_id = f.run_id AND ps.proposal_id = f.proposal_id "
      + "AND ps.revision = f.proposal_revision AND ps.status = 'approved' "
      + "WHERE s.status = 'delivered' AND (f.final_plan_id IS NULL OR ps.proposal_id IS NULL) LIMIT 1",
    )
    .get() as { runId?: string; handoffId?: string } | undefined;
  if (deliveredWithoutApproval !== undefined) {
    problems.push(
      `delivered execution handoff '${deliveredWithoutApproval.handoffId}' in run '${deliveredWithoutApproval.runId}' has no approved FinalPlan`,
    );
  }
}

/**
 * Structural + data checks for schema v12 (Phase 15 §5/§83/§E67): the
 * execution-issue / successor-baseline tables and immutability triggers
 * exist; an issue binds its run's exact approved FinalPlan and delivered
 * handoff and its stored hash matches the canonical payload; an adoption
 * points at a real baseline of the same successor; a baseline binds the
 * predecessor's exact FinalPlan hash, delivered handoff hash, and issue-set
 * hash, and its scope rows name exact predecessor FinalPlan sections; a
 * materialization row belongs to its successor's own commit chain. Legacy
 * runs are verified UNTOUCHED: no v12 row may exist without its Phase-14
 * execution world. Store open never re-derives scopes (§83) — only these
 * bounded identity facts.
 */
function validateSchemaV12(db: StoreConnection | StoreTx, problems: string[]): void {
  const objectNames = new Set(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','trigger','index')").all() as {
        name: string;
      }[]
    ).map((row) => row.name),
  );
  for (const table of SCHEMA_V12_TABLES) {
    if (!objectNames.has(table)) {
      problems.push(`${table} table missing for schema version >= 12`);
    }
  }
  for (const trigger of SCHEMA_V12_TRIGGERS) {
    if (!objectNames.has(trigger)) {
      problems.push(`constraint trigger ${trigger} missing for schema version >= 12`);
    }
  }
  for (const index of SCHEMA_V12_INDEXES) {
    if (!objectNames.has(index)) {
      problems.push(`constraint index ${index} missing for schema version >= 12`);
    }
  }
  if (SCHEMA_V12_TABLES.some((table) => !objectNames.has(table))) {
    return;
  }
  const baseWorldPresent = objectNames.has("final_plans") && objectNames.has("execution_handoffs") && objectNames.has("plan_commits");
  if (!baseWorldPresent) {
    return;
  }
  // An issue must bind its run's exact approved FinalPlan and its delivered
  // handoff (§E3), and the stored hash must match the canonical payload (§8).
  const issueBindingDrift = db
    .prepare(
      "SELECT i.run_id AS runId, i.issue_id AS issueId FROM execution_issues i "
      + "LEFT JOIN final_plans f ON f.run_id = i.run_id AND f.final_plan_id = i.final_plan_id AND f.final_plan_hash = i.final_plan_hash "
      + "LEFT JOIN execution_handoffs h ON h.run_id = i.run_id AND h.handoff_id = i.handoff_id AND h.handoff_hash = i.handoff_hash "
      + "WHERE f.final_plan_id IS NULL OR h.handoff_id IS NULL LIMIT 1",
    )
    .get() as { runId?: string; issueId?: string } | undefined;
  if (issueBindingDrift !== undefined) {
    problems.push(
      `execution issue '${issueBindingDrift.issueId}' in run '${issueBindingDrift.runId}' does not bind its run's approved FinalPlan and delivered handoff`,
    );
  }
  // E9 §45 — the version columns exist only from schema 22; the pre-022
  // schema probes every row as v1 (no other vocabulary existed).
  const issueColumns = db.prepare("PRAGMA table_info('execution_issues')").all() as Array<{ name: string }>;
  const versioned = issueColumns.some((column) => column.name === "issue_version");
  const issueRows = db
    .prepare(
      versioned
        ? "SELECT run_id AS runId, issue_id AS issueId, kind, issue_version AS issueVersion, canonical_json AS canonicalJson, issue_hash AS issueHash FROM execution_issues"
        : "SELECT run_id AS runId, issue_id AS issueId, kind, NULL AS issueVersion, canonical_json AS canonicalJson, issue_hash AS issueHash FROM execution_issues",
    )
    .all() as Array<{ runId: string; issueId: string; kind: string; issueVersion: number | null; canonicalJson: string; issueHash: string }>;
  for (const row of issueRows) {
    // Legacy v1 build issues verify under the v1 hash; the E9 replan
    // issue (kind=replan_required, version 2) verifies under the v2 hash.
    // Neither vocabulary is reinterpreted.
    if (row.kind === "replan_required" || row.issueVersion === 2) {
      let v2: unknown;
      try {
        v2 = JSON.parse(row.canonicalJson);
      } catch {
        problems.push(`execution issue '${row.issueId}' in run '${row.runId}' has unparsable canonical payload`);
        continue;
      }
      if (v2 === null || typeof v2 !== "object" || executionIssueV2Hash(v2 as ExecutionIssueV2) !== row.issueHash) {
        problems.push(`execution issue '${row.issueId}' in run '${row.runId}' hash does not match its canonical payload`);
      }
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.canonicalJson);
    } catch {
      problems.push(`execution issue '${row.issueId}' in run '${row.runId}' has unparsable canonical payload`);
      continue;
    }
    if (parsed === null || typeof parsed !== "object" || executionIssueHash(parsed as ExecutionIssueV1) !== row.issueHash) {
      problems.push(`execution issue '${row.issueId}' in run '${row.runId}' hash does not match its canonical payload`);
    }
  }
  // An adoption must point at the baseline that adopted the issue, in the
  // same successor run (§17/§74).
  const adoptionDrift = db
    .prepare(
      "SELECT a.issue_id AS issueId FROM execution_issue_adoptions a "
      + "LEFT JOIN planning_run_baselines b ON b.baseline_id = a.baseline_id AND b.successor_run_id = a.successor_run_id "
      + "WHERE b.baseline_id IS NULL LIMIT 1",
    )
    .get() as { issueId?: string } | undefined;
  if (adoptionDrift !== undefined) {
    problems.push(`execution issue adoption '${adoptionDrift.issueId}' does not point at its successor's baseline`);
  }
  // A baseline must bind its predecessor's exact FinalPlan hash and delivered
  // handoff hash (§E21/§E19).
  const baselineBindingDrift = db
    .prepare(
      "SELECT b.baseline_id AS baselineId FROM planning_run_baselines b "
      + "LEFT JOIN final_plans f ON f.run_id = b.predecessor_run_id AND f.final_plan_id = b.final_plan_id AND f.final_plan_hash = b.final_plan_hash "
      + "LEFT JOIN execution_handoffs h ON h.run_id = b.predecessor_run_id AND h.handoff_id = b.execution_handoff_id AND h.handoff_hash = b.execution_handoff_hash "
      + "WHERE f.final_plan_id IS NULL OR h.handoff_id IS NULL LIMIT 1",
    )
    .get() as { baselineId?: string } | undefined;
  if (baselineBindingDrift !== undefined) {
    problems.push(`planning run baseline '${baselineBindingDrift.baselineId}' does not bind its predecessor's FinalPlan and handoff`);
  }
  // The stored baseline hash must match the canonical payload (§E20).
  const baselineRows = db
    .prepare(
      "SELECT baseline_id AS baselineId, canonical_json AS canonicalJson, baseline_hash AS baselineHash, successor_run_id AS successorRunId FROM planning_run_baselines",
    )
    .all() as Array<{ baselineId: string; canonicalJson: string; baselineHash: string; successorRunId: string }>;
  for (const row of baselineRows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.canonicalJson);
    } catch {
      problems.push(`planning run baseline '${row.baselineId}' has unparsable canonical payload`);
      continue;
    }
    if (
      parsed === null
      || typeof parsed !== "object"
      || planningRunBaselineHash(parsed as PlanningRunBaselineV1) !== row.baselineHash
    ) {
      problems.push(`planning run baseline '${row.baselineId}' hash does not match its canonical payload`);
    }
    // The successor run must exist and the baseline must be its only one
    // (UNIQUE(successor_run_id) enforces cardinality; probe run existence).
    const run = db
      .prepare("SELECT 1 AS one FROM planning_runs WHERE run_id = ?")
      .get(row.successorRunId) as { one?: number } | undefined;
    if (run === undefined) {
      problems.push(`planning run baseline '${row.baselineId}' names a missing successor run`);
    }
  }
  // A materialization must belong to its successor's own commit chain (§53).
  const materializationDrift = db
    .prepare(
      "SELECT m.baseline_id AS baselineId FROM planning_run_baseline_materializations m "
      + "JOIN planning_run_baselines b ON b.baseline_id = m.baseline_id "
      + "LEFT JOIN plan_commits c ON c.commit_id = m.materialized_commit_id AND c.run_id = b.successor_run_id "
      + "WHERE c.commit_id IS NULL LIMIT 1",
    )
    .get() as { baselineId?: string } | undefined;
  if (materializationDrift !== undefined) {
    problems.push(`baseline materialization '${materializationDrift.baselineId}' does not point at its successor's commit`);
  }
}

/**
 * Structural + data checks for schema v13 (Phase 16 §51): the control
 * authorization table, immutability triggers, and lookup index exist; every
 * authorization names an existing run of the SAME workspace; the operation
 * vocabulary is exact; a takeover/abort lineage shows resulting binding
 * generation = expected + 1 (the only legal ownership step, §16); an abort's
 * resulting run revision refers to the same run and is one it actually
 * reached; and the idempotency/proof identities are unique. Bounded LIMIT-1
 * probes only — store open NEVER replays binding history (§51).
 */
function validateSchemaV13(db: StoreConnection | StoreTx, problems: string[]): void {
  const objectNames = new Set(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','trigger','index')").all() as {
        name: string;
      }[]
    ).map((row) => row.name),
  );
  for (const table of SCHEMA_V13_TABLES) {
    if (!objectNames.has(table)) {
      problems.push(`${table} table missing for schema version >= 13`);
    }
  }
  for (const trigger of SCHEMA_V13_TRIGGERS) {
    if (!objectNames.has(trigger)) {
      problems.push(`constraint trigger ${trigger} missing for schema version >= 13`);
    }
  }
  for (const index of SCHEMA_V13_INDEXES) {
    if (!objectNames.has(index)) {
      problems.push(`constraint index ${index} missing for schema version >= 13`);
    }
  }
  if (SCHEMA_V13_TABLES.some((table) => !objectNames.has(table))) {
    return;
  }
  if (!objectNames.has("planning_runs")) {
    return;
  }
  // A1 §49 — v26 re-keyed the control table with typed targets; the v13-era
  // shape (takeover/abort only) stays valid below 26, so every data probe in
  // this block branches on the target_kind column's presence.
  const hasTypedTargets = tableHasColumn(db, "run_control_authorizations", "target_kind");
  // An authorization must name an existing run of the same workspace (§51).
  // A1-II (v26 only): a final_plan_execution row's workspace is the TARGET
  // WorkspaceIdentity (A1 §35 — a FinalPlan may execute in several
  // workspaces) and its run_id is source-planning provenance, never a
  // same-workspace target, so the co-location law covers the two
  // run-targeting kinds only.
  const controlRunDrift = hasTypedTargets
    ? (db
        .prepare(
          "SELECT c.control_id AS controlId FROM run_control_authorizations c "
          + "LEFT JOIN planning_runs r ON r.run_id = c.run_id "
          + "WHERE c.target_kind IN ('planning_run', 'execution_run') "
          + "AND (r.run_id IS NULL OR r.workspace_id != c.workspace_id) LIMIT 1",
        )
        .get() as { controlId?: string } | undefined)
    : (db
        .prepare(
          "SELECT c.control_id AS controlId FROM run_control_authorizations c "
          + "LEFT JOIN planning_runs r ON r.run_id = c.run_id "
          + "WHERE r.run_id IS NULL OR r.workspace_id != c.workspace_id LIMIT 1",
        )
        .get() as { controlId?: string } | undefined);
  if (controlRunDrift !== undefined) {
    problems.push(
      `run control authorization '${controlRunDrift.controlId}' names a missing run or a foreign workspace`,
    );
  }
  // Operation vocabulary is CHECK-enforced; re-derive from data anyway (§51).
  // A1-II: reexecute_final_plan joins the frozen v26 vocabulary (A1 §63 — the
  // schema was prepared so A1-II needs no further migration).
  const operationVocabulary = hasTypedTargets
    ? "('takeover', 'abort', 'reexecute_final_plan')"
    : "('takeover', 'abort')";
  const badOperations = db
    .prepare(`SELECT count(*) AS n FROM run_control_authorizations WHERE operation NOT IN ${operationVocabulary}`)
    .get() as { n: number } | undefined;
  if ((badOperations?.n ?? 0) > 0) {
    problems.push("run_control_authorizations contains unknown operation values");
  }
  // The only legal ownership lineage: resulting generation = expected + 1
  // (§16). E14 §1 bug fix — a human-authorized ABORT is not an ownership
  // lineage move (E12C §17: clear/abort detach never changes the generation),
  // so its authorization legitimately carries no resulting generation and is
  // exempt from the takeover lineage rule. A1-II (v26 only) — a reexecution
  // creation moves no binding either: the new run's supervision attaches at
  // activation under its own generation-1 lineage (A1-II §29/§31), never
  // through this row.
  const nonLineageOperations = hasTypedTargets
    ? "('abort', 'reexecute_final_plan')"
    : "('abort')";
  const generationDrift = db
    .prepare(
      "SELECT control_id AS controlId FROM run_control_authorizations "
      + `WHERE operation NOT IN ${nonLineageOperations} AND (resulting_binding_generation IS NULL `
      + "OR resulting_binding_generation != expected_binding_generation + 1) LIMIT 1",
    )
    .get() as { controlId?: string } | undefined;
  if (generationDrift !== undefined) {
    problems.push(
      `run control authorization '${generationDrift.controlId}' does not advance the binding generation by exactly one`,
    );
  }
  // An abort's resulting run revision must refer to the same run and be a
  // revision that run actually reached (§51).
  const abortRevisionDrift = db
    .prepare(
      "SELECT c.control_id AS controlId FROM run_control_authorizations c "
      + "JOIN planning_runs r ON r.run_id = c.run_id "
      + "WHERE c.operation = 'abort' AND (c.resulting_run_revision IS NULL OR c.resulting_run_revision > r.revision) LIMIT 1",
    )
    .get() as { controlId?: string } | undefined;
  if (abortRevisionDrift !== undefined) {
    problems.push(
      `abort authorization '${abortRevisionDrift.controlId}' names a resulting run revision the run never reached`,
    );
  }
  // The idempotency/proof identities are UNIQUE-enforced; probe anyway so a
  // hand-mangled store fails closed (§51).
  const duplicateOperation = db
    .prepare(
      "SELECT operation_id AS operationId FROM run_control_authorizations GROUP BY operation_id HAVING count(*) > 1 LIMIT 1",
    )
    .get() as { operationId?: string } | undefined;
  if (duplicateOperation !== undefined) {
    problems.push(`run control operation id '${duplicateOperation.operationId}' is not unique`);
  }
  const duplicateRequest = db
    .prepare(
      "SELECT authorization_request_id AS requestId FROM run_control_authorizations GROUP BY authorization_request_id HAVING count(*) > 1 LIMIT 1",
    )
    .get() as { requestId?: string } | undefined;
  if (duplicateRequest !== undefined) {
    problems.push(`run control authorization request id '${duplicateRequest.requestId}' is not unique`);
  }
}

/**
 * Structural + data checks for schema v14 (v0.2.0 E1 §8): the ExecutionRun
 * tables, binding/immutability triggers, and lookup index exist; every run
 * binds an existing FinalPlan of the same run and a registered workspace; the
 * lifecycle vocabulary is exact; a prepared/active lifecycle revision
 * lineage is coherent (active implies at least one revision advance); and
 * each run's event history starts at PREPARED. Bounded LIMIT-1 probes only.
 */
function validateSchemaV14(db: StoreConnection | StoreTx, problems: string[]): void {
  const objectNames = new Set(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','trigger','index')").all() as {
        name: string;
      }[]
    ).map((row) => row.name),
  );
  for (const table of SCHEMA_V14_TABLES) {
    if (!objectNames.has(table)) {
      problems.push(`${table} table missing for schema version >= 14`);
    }
  }
  for (const trigger of SCHEMA_V14_TRIGGERS) {
    if (!objectNames.has(trigger)) {
      problems.push(`constraint trigger ${trigger} missing for schema version >= 14`);
    }
  }
  for (const index of SCHEMA_V14_INDEXES) {
    if (!objectNames.has(index)) {
      problems.push(`constraint index ${index} missing for schema version >= 14`);
    }
  }
  if (SCHEMA_V14_TABLES.some((table) => !objectNames.has(table))) {
    return;
  }
  if (!objectNames.has("planning_runs") || !objectNames.has("final_plans") || !objectNames.has("workspaces")) {
    return;
  }
  // The exact FinalPlan binding must resolve inside the same run (E1 §5).
  const finalPlanDrift = db
    .prepare(
      "SELECT e.run_id AS runId FROM execution_runs e "
      + "LEFT JOIN final_plans f ON f.run_id = e.run_id AND f.final_plan_id = e.final_plan_id "
      + "WHERE f.final_plan_id IS NULL "
      + "OR f.revision != e.final_plan_revision OR f.final_plan_hash != e.final_plan_hash LIMIT 1",
    )
    .get() as { runId?: string } | undefined;
  if (finalPlanDrift !== undefined) {
    problems.push(`execution run '${finalPlanDrift.runId}' is not bound to an exact FinalPlan revision of its run`);
  }
  const workspaceDrift = db
    .prepare(
      "SELECT e.run_id AS runId FROM execution_runs e "
      + "LEFT JOIN workspaces w ON w.workspace_id = e.workspace_id "
      + "LEFT JOIN planning_runs r ON r.run_id = e.run_id "
      + "WHERE w.workspace_id IS NULL OR r.run_id IS NULL OR r.workspace_id != e.workspace_id LIMIT 1",
    )
    .get() as { runId?: string } | undefined;
  if (workspaceDrift !== undefined) {
    problems.push(`execution run '${workspaceDrift.runId}' references a missing workspace or a foreign run workspace`);
  }
  // Lifecycle vocabulary is CHECK-enforced; re-derive from data anyway.
  const badLifecycles = db
    .prepare(
      "SELECT count(*) AS n FROM execution_runs WHERE lifecycle NOT IN ('prepared', 'active', 'completed', 'replan_required', 'aborted')",
    )
    .get() as { n: number };
  if (badLifecycles.n > 0) {
    problems.push("execution_runs contains unknown lifecycle values");
  }
  // An active or terminal run has advanced at least once (revision 2+).
  const lifecycleRevisionDrift = db
    .prepare(
      "SELECT run_id AS runId FROM execution_runs "
      + "WHERE lifecycle != 'prepared' AND revision < 2 LIMIT 1",
    )
    .get() as { runId?: string } | undefined;
  if (lifecycleRevisionDrift !== undefined) {
    problems.push(`execution run '${lifecycleRevisionDrift.runId}' left 'prepared' without a revision advance`);
  }
  // Every lifecycle history starts at PREPARED exactly once (E1 §9). The
  // scope column follows the table's actual shape (legacy run_id up to v25,
  // canonical run_id from v26 on).
  const badFirstEvent = db
    .prepare(
      "SELECT run_id AS runId FROM execution_run_events WHERE event_seq = 1 AND event_type != 'PREPARED' LIMIT 1",
    )
    .get() as { runId?: string } | undefined;
  if (badFirstEvent !== undefined) {
    problems.push(`execution run '${badFirstEvent.runId}' lifecycle history does not start at PREPARED`);
  }
}

/**
 * Structural + data checks for schema v15 (v0.2.0 E2 §5/§6/§16): the
 * SupervisorBinding tables, identity/immutability triggers, and lookup indexes
 * exist; every binding names an existing ExecutionRun of the same workspace;
 * the state vocabulary is exact; an ATTACHED supervision binding is unique per
 * session (the partial index backs the 0..1 writable-owner law); and each
 * binding's ownership history starts at ATTACHED. Bounded LIMIT-1 probes only.
 */
function validateSchemaV15(db: StoreConnection | StoreTx, problems: string[]): void {
  const objectNames = new Set(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','trigger','index')").all() as {
        name: string;
      }[]
    ).map((row) => row.name),
  );
  for (const table of SCHEMA_V15_TABLES) {
    if (!objectNames.has(table)) {
      problems.push(`${table} table missing for schema version >= 15`);
    }
  }
  for (const trigger of SCHEMA_V15_TRIGGERS) {
    if (!objectNames.has(trigger)) {
      problems.push(`constraint trigger ${trigger} missing for schema version >= 15`);
    }
  }
  for (const index of SCHEMA_V15_INDEXES) {
    if (!objectNames.has(index)) {
      problems.push(`constraint index ${index} missing for schema version >= 15`);
    }
  }
  if (SCHEMA_V15_TABLES.some((table) => !objectNames.has(table))) {
    return;
  }
  if (!objectNames.has("execution_runs") || !objectNames.has("workspaces")) {
    return;
  }
  // A binding must name an existing ExecutionRun of the same workspace (E2 §19).
  const bindingScope = "run_id";
  const bindingRunDrift = db
    .prepare(
      `SELECT s.${bindingScope} AS runId FROM supervisor_bindings s `
      + `LEFT JOIN execution_runs e ON e.${bindingScope} = s.${bindingScope} `
      + `WHERE e.${bindingScope} IS NULL OR e.workspace_id != s.workspace_id LIMIT 1`,
    )
    .get() as { runId?: string } | undefined;
  if (bindingRunDrift !== undefined) {
    problems.push(`supervisor binding '${bindingRunDrift.runId}' names a missing execution run or a foreign workspace`);
  }
  // State vocabulary is CHECK-enforced; re-derive from data anyway.
  const badStates = db
    .prepare("SELECT count(*) AS n FROM supervisor_bindings WHERE state NOT IN ('attached', 'detached')")
    .get() as { n: number };
  if (badStates.n > 0) {
    problems.push("supervisor_bindings contains unknown state values");
  }
  // At most one ATTACHED supervision binding per session (E2 §5, XB-02 analog).
  const duplicateActiveSessions = db
    .prepare(
      "SELECT session_id AS sessionId FROM supervisor_bindings WHERE state = 'attached' "
      + "GROUP BY session_id HAVING count(*) > 1 LIMIT 1",
    )
    .get() as { sessionId?: string } | undefined;
  if (duplicateActiveSessions !== undefined) {
    problems.push(`session '${duplicateActiveSessions.sessionId}' holds multiple attached supervision bindings`);
  }
  // Every ownership history starts at ATTACHED (initial attach, E2 §7).
  const eventScope = "run_id";
  const badFirstEvent = db
    .prepare(
      `SELECT ${eventScope} AS runId FROM supervisor_binding_events WHERE event_seq = 1 AND event_type != 'ATTACHED' LIMIT 1`,
    )
    .get() as { runId?: string } | undefined;
  if (badFirstEvent !== undefined) {
    problems.push(`supervisor binding '${badFirstEvent.runId}' ownership history does not start at ATTACHED`);
  }
}

/**
 * Structural + data checks for schema v16 (v0.2.0 E3 §22): the execution
 * structure tables, identity/immutability triggers, and invariant indexes
 * exist; every stage/window names an existing run (and the window's stage
 * belongs to the same run); the status vocabularies are exact; at most one
 * active stage and one open window exist per run (the partial unique indexes
 * back these — re-derived from data); candidate revisions are non-negative;
 * and no fabricated commit/acceptedHead machinery exists. Bounded LIMIT-1
 * probes only.
 */
function validateSchemaV16(db: StoreConnection | StoreTx, problems: string[]): void {
  const objectNames = new Set(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','trigger','index')").all() as {
        name: string;
      }[]
    ).map((row) => row.name),
  );
  for (const table of SCHEMA_V16_TABLES) {
    if (!objectNames.has(table)) {
      problems.push(`${table} table missing for schema version >= 16`);
    }
  }
  for (const trigger of SCHEMA_V16_TRIGGERS) {
    if (!objectNames.has(trigger)) {
      problems.push(`constraint trigger ${trigger} missing for schema version >= 16`);
    }
  }
  for (const index of SCHEMA_V16_INDEXES) {
    if (!objectNames.has(index)) {
      problems.push(`constraint index ${index} missing for schema version >= 16`);
    }
  }
  if (SCHEMA_V16_TABLES.some((table) => !objectNames.has(table))) {
    return;
  }
  if (!objectNames.has("execution_runs")) {
    return;
  }
  // Stage/window run integrity (E3 §5/§12). E10 — once the scope column
  // exists, a stage window must still bind its same-run stage, and a
  // final-closure window must carry NO stage id (E10 §6/§63).
  const stageRunDrift = db
    .prepare(
      "SELECT s.id AS id FROM execution_stages s "
      + `LEFT JOIN execution_runs e ON e.${"run_id"} = s.${"run_id"} `
      + `WHERE e.${"run_id"} IS NULL LIMIT 1`,
    )
    .get() as { id?: string } | undefined;
  if (stageRunDrift !== undefined) {
    problems.push(`execution stage '${stageRunDrift.id}' names a missing execution run`);
  }
  const windowScopeAware = tableHasColumn(db, "verification_windows", "scope_kind");
  const windowRun = "run_id";
  const stageRun = "run_id";
  const windowDrift = windowScopeAware
    ? (db
        .prepare(
          "SELECT w.id AS id FROM verification_windows w "
          + `LEFT JOIN execution_runs e ON e.${windowRun} = w.${windowRun} `
          + "LEFT JOIN execution_stages s ON s.id = w.stage_id "
          + `WHERE e.${windowRun} IS NULL `
          + `OR (w.scope_kind = 'stage' AND (w.stage_id IS NULL OR s.id IS NULL OR s.${stageRun} != w.${windowRun})) `
          + "OR (w.scope_kind = 'final_closure' AND w.stage_id IS NOT NULL) "
          + "OR (w.scope_kind NOT IN ('stage', 'final_closure')) LIMIT 1",
        )
        .get() as { id?: string } | undefined)
    : (db
        .prepare(
          "SELECT w.id AS id FROM verification_windows w "
          + `LEFT JOIN execution_runs e ON e.${windowRun} = w.${windowRun} `
          + "LEFT JOIN execution_stages s ON s.id = w.stage_id "
          + `WHERE e.${windowRun} IS NULL OR s.id IS NULL OR s.${stageRun} != w.${windowRun} LIMIT 1`,
        )
        .get() as { id?: string } | undefined);
  if (windowDrift !== undefined) {
    problems.push(`verification window '${windowDrift.id}' has a cross-run stage, a broken scope, or a missing parent`);
  }
  // Vocabularies are CHECK-enforced; re-derive from data anyway.
  const badStageStatuses = db
    .prepare("SELECT count(*) AS n FROM execution_stages WHERE status NOT IN ('pending', 'active', 'completed', 'superseded')")
    .get() as { n: number };
  if (badStageStatuses.n > 0) {
    problems.push("execution_stages contains unknown status values");
  }
  // Single-active-stage / single-open-window re-derived from data (E3 §9/§14).
  const multiActive = db
    .prepare(
      `SELECT ${"run_id"} AS runId FROM execution_stages WHERE status = 'active' GROUP BY ${"run_id"} HAVING count(*) > 1 LIMIT 1`,
    )
    .get() as { runId?: string } | undefined;
  if (multiActive !== undefined) {
    problems.push(`execution run '${multiActive.runId}' holds multiple active stages`);
  }
  const multiOpen = db
    .prepare(
      `SELECT ${"run_id"} AS runId FROM verification_windows WHERE closed_at IS NULL GROUP BY ${"run_id"} HAVING count(*) > 1 LIMIT 1`,
    )
    .get() as { runId?: string } | undefined;
  if (multiOpen !== undefined) {
    problems.push(`execution run '${multiOpen.runId}' holds multiple open verification windows`);
  }
  const badRevisions = db
    .prepare("SELECT count(*) AS n FROM verification_windows WHERE candidate_revision < 0")
    .get() as { n: number };
  if (badRevisions.n > 0) {
    problems.push("verification_windows contains negative candidate revisions");
  }
  // E3C — Window cardinality: a Stage may own MULTIPLE sequential windows, so
  // NO permanent unique index may cover (run_id, stage_id) or (stage_id).
  // The only uniqueness is the one-open-per-run partial index. Probed from
  // the live index metadata so a hand-mangled or re-introduced 1:1 constraint
  // fails closed.
  const windowIndexes = db
    .prepare("PRAGMA index_list('verification_windows')")
    .all() as Array<{ name: string; unique: number; origin: string }>;
  for (const index of windowIndexes) {
    if (!index.unique) continue;
    const columns = (
      db.prepare(`PRAGMA index_info('${index.name.replace(/'/g, "''")}')`).all() as Array<{ name: string }>
    ).map((column) => column.name);
    const identityLike =
      columns.length === 1 && columns[0] === "stage_id";
    const runStageLike =
      columns.length === 2 && columns.includes("run_id") && columns.includes("stage_id");
    if ((identityLike || runStageLike) && !columns.includes("closed_at")) {
      problems.push(
        `verification_windows carries a permanent unique index '${index.name}' over [${columns.join(", ")}] — one Stage may own multiple sequential windows`,
      );
    }
  }
  // No fabricated commit/acceptedHead machinery may exist (E3 §13/§17).
  // Gated by inspectSchemaState to pre-E6 versions — schema 19 owns these.
}

/**
 * Structural + data checks for schema v17 (v0.2.0 E4 §45): the protocol
 * tables, immutability triggers, and invariant indexes exist; every
 * Directive/Attempt/Report names an existing parent in the right run; the
 * vocabularies are exact; one Attempt exists per exact Directive revision at
 * most, one running Attempt per run at most, one Report per Attempt at most
 * (re-derived from data — the DDL uniquenesses are probed live); Attempt
 * directive-hash bindings match their Directive rows; Reports match their
 * Attempts' directive identity/role; result=blocked rows carry blockers;
 * candidate_mutated is boolean; and no fabricated ExecutionCommit /
 * SupervisorAssessment / acceptedHead machinery exists. Bounded LIMIT-1
 * probes only.
 */
function validateSchemaV17(db: StoreConnection | StoreTx, problems: string[]): void {
  const objectNames = new Set(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','trigger','index')").all() as {
        name: string;
      }[]
    ).map((row) => row.name),
  );
  for (const table of SCHEMA_V17_TABLES) {
    if (!objectNames.has(table)) {
      problems.push(`${table} table missing for schema version >= 17`);
    }
  }
  for (const trigger of SCHEMA_V17_TRIGGERS) {
    if (!objectNames.has(trigger)) {
      problems.push(`constraint trigger ${trigger} missing for schema version >= 17`);
    }
  }
  for (const index of SCHEMA_V17_INDEXES) {
    if (!objectNames.has(index)) {
      problems.push(`constraint index ${index} missing for schema version >= 17`);
    }
  }
  if (SCHEMA_V17_TABLES.some((table) => !objectNames.has(table))) {
    return;
  }
  if (!objectNames.has("execution_runs")) {
    return;
  }
  // Parent integrity: Directive → run; Attempt → run + exact Directive
  // revision (+ hash match); Report → run + Attempt (+ identity match).
  const directiveDrift = db
    .prepare(
      "SELECT d.directive_id AS id FROM execution_directives d "
      + "LEFT JOIN execution_runs e ON e.run_id = d.run_id "
      + "WHERE e.run_id IS NULL LIMIT 1",
    )
    .get() as { id?: string } | undefined;
  if (directiveDrift !== undefined) {
    problems.push(`execution directive '${directiveDrift.id}' names a missing execution run`);
  }
  const attemptDrift = db
    .prepare(
      "SELECT a.attempt_id AS id FROM execution_attempts a "
      + "LEFT JOIN execution_runs e ON e.run_id = a.run_id "
      + "LEFT JOIN execution_directives d ON d.directive_id = a.directive_id AND d.revision = a.directive_revision "
      + "WHERE e.run_id IS NULL OR d.directive_id IS NULL OR d.directive_hash != a.directive_hash OR d.run_id != a.run_id LIMIT 1",
    )
    .get() as { id?: string } | undefined;
  if (attemptDrift !== undefined) {
    problems.push(`execution attempt '${attemptDrift.id}' binds a missing or mismatched Directive revision`);
  }
  const reportDrift = db
    .prepare(
      "SELECT r.report_id AS id FROM execution_reports r "
      + "LEFT JOIN execution_runs e ON e.run_id = r.run_id "
      + "LEFT JOIN execution_attempts a ON a.attempt_id = r.attempt_id "
      + "WHERE e.run_id IS NULL OR a.attempt_id IS NULL "
      + "OR r.directive_id != a.directive_id OR r.directive_revision != a.directive_revision "
      + "OR r.directive_hash != a.directive_hash OR r.worker_role != a.worker_role LIMIT 1",
    )
    .get() as { id?: string } | undefined;
  if (reportDrift !== undefined) {
    problems.push(`execution report '${reportDrift.id}' binds a missing or mismatched Attempt`);
  }
  // Vocabularies are CHECK-enforced; re-derive from data anyway.
  const badAttemptStates = db
    .prepare("SELECT count(*) AS n FROM execution_attempts WHERE state NOT IN ('running', 'reported', 'indeterminate')")
    .get() as { n: number };
  if (badAttemptStates.n > 0) {
    problems.push("execution_attempts contains unknown state values");
  }
  const badResults = db
    .prepare("SELECT count(*) AS n FROM execution_reports WHERE result NOT IN ('completed', 'partial', 'blocked', 'failed')")
    .get() as { n: number };
  if (badResults.n > 0) {
    problems.push("execution_reports contains unknown result values");
  }
  const badMutations = db
    .prepare("SELECT count(*) AS n FROM execution_reports WHERE candidate_mutated NOT IN (0, 1)")
    .get() as { n: number };
  if (badMutations.n > 0) {
    problems.push("execution_reports contains non-boolean candidate_mutated values");
  }
  // Terminal-attempt / ended-at coherence: reported and indeterminate attempts
  // must have ended; running attempts must not.
  const endedIncoherence = db
    .prepare(
      "SELECT count(*) AS n FROM execution_attempts WHERE (state = 'running') != (ended_at IS NULL) OR (state IN ('reported','indeterminate')) != (ended_at IS NOT NULL)",
    )
    .get() as { n: number };
  if (endedIncoherence.n > 0) {
    problems.push("execution_attempts ended_at disagrees with the attempt state");
  }
  // ≤1 running Attempt per run, re-derived from data (E4 §18).
  const multiRunning = db
    .prepare(
      `SELECT ${"run_id"} AS runId FROM execution_attempts WHERE state = 'running' GROUP BY ${"run_id"} HAVING count(*) > 1 LIMIT 1`,
    )
    .get() as { runId?: string } | undefined;
  if (multiRunning !== undefined) {
    problems.push(`execution run '${multiRunning.runId}' holds multiple running attempts`);
  }
  // One logical Attempt per exact Directive revision, re-derived (E4 §17).
  const duplicateAttempts = db
    .prepare(
      "SELECT directive_id AS id, directive_revision AS revision FROM execution_attempts "
      + "GROUP BY directive_id, directive_revision HAVING count(*) > 1 LIMIT 1",
    )
    .get() as { id?: string; revision?: number } | undefined;
  if (duplicateAttempts !== undefined) {
    problems.push(`directive revision '${duplicateAttempts.id}@${duplicateAttempts.revision}' holds multiple attempts`);
  }
  // One Report per Attempt, re-derived (E4 §24).
  const duplicateReports = db
    .prepare(
      "SELECT attempt_id AS id FROM execution_reports GROUP BY attempt_id HAVING count(*) > 1 LIMIT 1",
    )
    .get() as { id?: string } | undefined;
  if (duplicateReports !== undefined) {
    problems.push(`attempt '${duplicateReports.id}' holds multiple reports`);
  }
  // result=blocked carries at least one structured blocker (E4 §27).
  const emptyBlockers = db
    .prepare(
      "SELECT count(*) AS n FROM execution_reports WHERE result = 'blocked' "
      + "AND (blockers_json IS NULL OR blockers_json = '' OR blockers_json = '[]')",
    )
    .get() as { n: number };
  if (emptyBlockers.n > 0) {
    problems.push("execution_reports holds result=blocked rows without a structured blocker");
  }
  // E4 §45 — the live DDL uniquenesses: one attempt per exact revision, one
  // report per attempt, one running attempt per run. Probed from the index
  // metadata so a hand-mangled schema fails closed.
  const probeUniqueIndexes = (table: string, columns: string[]): void => {
    const indexes = db.prepare(`PRAGMA index_list('${table}')`).all() as Array<{ name: string; unique: number }>;
    for (const index of indexes) {
      if (!index.unique) continue;
      const indexed = (
        db.prepare(`PRAGMA index_info('${index.name.replace(/'/g, "''")}')`).all() as Array<{ name: string }>
      ).map((column) => column.name);
      if (columns.every((column) => indexed.includes(column))) {
        return;
      }
    }
    problems.push(`${table} lost its unique constraint over [${columns.join(", ")}]`);
  };
  probeUniqueIndexes("execution_attempts", ["directive_id", "directive_revision"]);
  probeUniqueIndexes("execution_reports", ["attempt_id"]);
  const runningIndexes = db
    .prepare("PRAGMA index_list('execution_attempts')")
    .all() as Array<{ name: string; unique: number }>;
  const hasRunningFence = runningIndexes.some((index) => {
    if (!index.unique) return false;
    const indexed = (
      db.prepare(`PRAGMA index_info('${index.name.replace(/'/g, "''")}')`).all() as Array<{ name: string }>
    ).map((column) => column.name);
    return indexed.length === 1 && indexed[0] === "run_id";
  });
  if (!hasRunningFence) {
    problems.push("execution_attempts lost the partial unique running-attempt-per-run fence");
  }
  // No fabricated commit/assessment machinery may exist (E4 §2/§43).
  // Gated by inspectSchemaState to pre-E6 versions — schema 19 owns these.
}

/**
 * Structural + data checks for schema v18 (v0.2.0 E5 §45/§46): the worker
 * invocation tables, identity/session/terminal triggers, and invariant indexes
 * exist; every invocation names an existing attempt in the same run; the state
 * vocabulary is exact; at most one claimed invocation exists per worker
 * session (re-derived from data and probed live from the index metadata); the
 * claimed session/timestamps agree with the state; and no fabricated
 * assessment/commit machinery exists. Bounded LIMIT-1 probes only.
 */
function validateSchemaV18(db: StoreConnection | StoreTx, problems: string[]): void {
  const objectNames = new Set(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','trigger','index')").all() as {
        name: string;
      }[]
    ).map((row) => row.name),
  );
  for (const table of SCHEMA_V18_TABLES) {
    if (!objectNames.has(table)) {
      problems.push(`${table} table missing for schema version >= 18`);
    }
  }
  for (const trigger of SCHEMA_V18_TRIGGERS) {
    if (!objectNames.has(trigger)) {
      problems.push(`constraint trigger ${trigger} missing for schema version >= 18`);
    }
  }
  for (const index of SCHEMA_V18_INDEXES) {
    if (!objectNames.has(index)) {
      problems.push(`constraint index ${index} missing for schema version >= 18`);
    }
  }
  if (SCHEMA_V18_TABLES.some((table) => !objectNames.has(table))) {
    return;
  }
  if (!objectNames.has("execution_attempts")) {
    return;
  }
  // Invocation → attempt/run integrity: the attempt exists and lives in the
  // same run, and the role matches the attempt's role.
  const drift = db
    .prepare(
      "SELECT w.attempt_id AS id FROM execution_worker_invocations w "
      + "LEFT JOIN execution_attempts a ON a.attempt_id = w.attempt_id "
      + "WHERE a.attempt_id IS NULL OR a.run_id != w.run_id OR a.worker_role != w.worker_role LIMIT 1",
    )
    .get() as { id?: string } | undefined;
  if (drift !== undefined) {
    problems.push(`worker invocation '${drift.id}' binds a missing or mismatched attempt`);
  }
  const badStates = db
    .prepare("SELECT count(*) AS n FROM execution_worker_invocations WHERE state NOT IN ('prepared', 'claimed', 'finished')")
    .get() as { n: number };
  if (badStates.n > 0) {
    problems.push("execution_worker_invocations contains unknown state values");
  }
  // State/session/timestamp coherence (E5 §46).
  const incoherent = db
    .prepare(
      "SELECT count(*) AS n FROM execution_worker_invocations WHERE "
      + "(state = 'prepared') != (worker_session_id IS NULL AND claimed_at IS NULL AND finished_at IS NULL) "
      + "OR (state = 'claimed') != (worker_session_id IS NOT NULL AND claimed_at IS NOT NULL AND finished_at IS NULL) "
      + "OR (state = 'finished') != (finished_at IS NOT NULL)",
    )
    .get() as { n: number };
  if (incoherent.n > 0) {
    problems.push("execution_worker_invocations session/timestamps disagree with the invocation state");
  }
  // ≤1 claimed invocation per worker session, re-derived from data (E5 §46).
  const multiClaimed = db
    .prepare(
      "SELECT worker_session_id AS sessionId FROM execution_worker_invocations WHERE state = 'claimed' "
      + "GROUP BY worker_session_id HAVING count(*) > 1 LIMIT 1",
    )
    .get() as { sessionId?: string } | undefined;
  if (multiClaimed !== undefined) {
    problems.push(`worker session '${multiClaimed.sessionId}' holds multiple claimed invocations`);
  }
  // The claimed-session partial unique fence is probed live.
  const indexes = db
    .prepare("PRAGMA index_list('execution_worker_invocations')")
    .all() as Array<{ name: string; unique: number }>;
  const hasClaimedFence = indexes.some((index) => {
    if (!index.unique) return false;
    const columns = (
      db.prepare(`PRAGMA index_info('${index.name.replace(/'/g, "''")}')`).all() as Array<{ name: string }>
    ).map((column) => column.name);
    return columns.length === 1 && columns[0] === "worker_session_id";
  });
  if (!hasClaimedFence) {
    problems.push("execution_worker_invocations lost the partial unique claimed-session fence");
  }
  // No fabricated assessment/commit machinery may exist (E5 §45).
  // Gated by inspectSchemaState to pre-E6 versions — schema 19 owns these.
}

/**
 * Structural + data checks for schema v19 (v0.2.0 E6 §55/§57): the acceptance
 * tables, immutability triggers, and invariant indexes exist; assessments bind
 * exact run/stage/window/revision rows; judgments reference real same-run
 * reports; commits chain linearly inside one run (parent same run, sequence =
 * parent + 1), one per window and one per accept assessment; the accepted head
 * column references a same-run commit or is NULL; window accepted-base shape
 * and cross-references hold; a closed window has exactly one commit and an
 * open window has none. Semantic acceptance gates (verification quality,
 * judgment semantics) live in Core, not here — the schema layer proves only
 * referential integrity and the DDL-backed uniquenesses. Bounded LIMIT-1
 * probes only.
 */
function validateSchemaV19(db: StoreConnection | StoreTx, problems: string[]): void {
  const objectNames = new Set(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','trigger','index')").all() as {
        name: string;
      }[]
    ).map((row) => row.name),
  );
  for (const table of SCHEMA_V19_TABLES) {
    if (!objectNames.has(table)) {
      problems.push(`${table} table missing for schema version >= 19`);
    }
  }
  for (const trigger of SCHEMA_V19_TRIGGERS) {
    if (!objectNames.has(trigger)) {
      problems.push(`constraint trigger ${trigger} missing for schema version >= 19`);
    }
  }
  for (const index of SCHEMA_V19_INDEXES) {
    if (!objectNames.has(index)) {
      problems.push(`constraint index ${index} missing for schema version >= 19`);
    }
  }
  if (SCHEMA_V19_TABLES.some((table) => !objectNames.has(table))) {
    return;
  }
  const runColumns = db.prepare("PRAGMA table_info('execution_runs')").all() as Array<{ name: string }>;
  if (!runColumns.some((column) => column.name === "accepted_head_commit_id")) {
    problems.push("execution_runs lost the accepted_head_commit_id column");
  }
  const windowColumns = db.prepare("PRAGMA table_info('verification_windows')").all() as Array<{ name: string }>;
  for (const column of ["base_kind", "base_commit_id"]) {
    if (!windowColumns.some((candidate) => candidate.name === column)) {
      problems.push(`verification_windows lost the ${column} column`);
    }
  }
  const windowColumnsReady = ["base_kind", "base_commit_id"].every((column) =>
    windowColumns.some((candidate) => candidate.name === column),
  );
  if (!windowColumnsReady) {
    return;
  }
  // Assessment → exact run/stage/window/revision binding (E6 §57). E10 —
  // scope-aware: a stage assessment binds its same-run Stage; a final-closure
  // assessment binds the final window with NO stage (E10 §31/§63).
  const assessmentScopeAware = tableHasColumn(db, "supervisor_assessments", "scope_kind");
  const assessmentDrift = assessmentScopeAware
    ? (db
        .prepare(
          "SELECT a.assessment_id AS id FROM supervisor_assessments a "
          + "LEFT JOIN execution_runs r ON r.run_id = a.run_id "
          + "LEFT JOIN execution_stages s ON s.id = a.stage_id "
          + "LEFT JOIN verification_windows w ON w.id = a.window_id "
          + "WHERE r.run_id IS NULL OR w.id IS NULL OR w.run_id != a.run_id "
          + "OR w.candidate_revision != a.candidate_revision "
          + "OR (a.scope_kind = 'stage' AND (a.stage_id IS NULL OR s.id IS NULL OR s.run_id != a.run_id OR w.scope_kind != 'stage' OR w.stage_id != a.stage_id)) "
          + "OR (a.scope_kind = 'final_closure' AND (a.stage_id IS NOT NULL OR w.scope_kind != 'final_closure')) "
          + "OR (a.scope_kind NOT IN ('stage', 'final_closure')) LIMIT 1",
        )
        .get() as { id?: string } | undefined)
    : (db
        .prepare(
          "SELECT a.assessment_id AS id FROM supervisor_assessments a "
          + "LEFT JOIN execution_runs r ON r.run_id = a.run_id "
          + "LEFT JOIN execution_stages s ON s.id = a.stage_id "
          + "LEFT JOIN verification_windows w ON w.id = a.window_id "
          + "WHERE r.run_id IS NULL OR s.id IS NULL OR s.run_id != a.run_id "
          + "OR w.id IS NULL OR w.run_id != a.run_id OR w.stage_id != a.stage_id "
          + "OR w.candidate_revision != a.candidate_revision LIMIT 1",
        )
        .get() as { id?: string } | undefined);
  if (assessmentDrift !== undefined) {
    problems.push(`supervisor assessment '${assessmentDrift.id}' binds a missing or mismatched run/stage/window/revision`);
  }
  // Judgments reference real reports of the assessment's own run (E6 §57).
  const judgmentDrift = db
    .prepare(
      "SELECT j.assessment_id AS id FROM supervisor_assessment_report_judgments j "
      + "LEFT JOIN execution_reports rep ON rep.report_id = j.report_id "
      + "LEFT JOIN supervisor_assessments a ON a.assessment_id = j.assessment_id "
      + "WHERE rep.report_id IS NULL OR a.assessment_id IS NULL OR rep.run_id != a.run_id LIMIT 1",
    )
    .get() as { id?: string } | undefined;
  if (judgmentDrift !== undefined) {
    problems.push(`assessment '${judgmentDrift.id}' carries a judgment for a foreign or missing report`);
  }
  // Commit chain integrity: window/stage belong to the same run; the parent is
  // same-run with sequence exactly one less (E6 §57 — linear chain). E10 —
  // scope-aware: stage commits bind their Stage; the Final ExecutionCommit is
  // final_closure-scoped with NO stage (E10 §34/§63).
  const commitScopeAware = tableHasColumn(db, "execution_commits", "scope_kind");
  const commitDrift = commitScopeAware
    ? (db
        .prepare(
          "SELECT c.commit_id AS id FROM execution_commits c "
          + "LEFT JOIN execution_stages s ON s.id = c.stage_id "
          + "LEFT JOIN verification_windows w ON w.id = c.window_id "
          + "WHERE w.id IS NULL OR w.run_id != c.run_id OR w.candidate_revision != c.candidate_revision "
          + "OR (c.scope_kind = 'stage' AND (c.stage_id IS NULL OR s.id IS NULL OR s.run_id != c.run_id OR w.scope_kind != 'stage' OR w.stage_id != c.stage_id)) "
          + "OR (c.scope_kind = 'final_closure' AND (c.stage_id IS NOT NULL OR w.scope_kind != 'final_closure')) "
          + "OR (c.scope_kind NOT IN ('stage', 'final_closure')) LIMIT 1",
        )
        .get() as { id?: string } | undefined)
    : (db
        .prepare(
          "SELECT c.commit_id AS id FROM execution_commits c "
          + "LEFT JOIN execution_stages s ON s.id = c.stage_id "
          + "LEFT JOIN verification_windows w ON w.id = c.window_id "
          + "WHERE s.id IS NULL OR s.run_id != c.run_id "
          + "OR w.id IS NULL OR w.run_id != c.run_id OR w.stage_id != c.stage_id "
          + "OR w.candidate_revision != c.candidate_revision LIMIT 1",
        )
        .get() as { id?: string } | undefined);
  if (commitDrift !== undefined) {
    problems.push(`execution commit '${commitDrift.id}' binds a mismatched stage/window/revision`);
  }
  const parentDrift = db
    .prepare(
      "SELECT c.commit_id AS id FROM execution_commits c "
      + "LEFT JOIN execution_commits p ON p.commit_id = c.parent_commit_id "
      + "WHERE (c.sequence = 1 AND c.parent_commit_id IS NOT NULL) "
      + "OR (c.sequence > 1 AND (p.commit_id IS NULL OR p.run_id != c.run_id OR p.sequence != c.sequence - 1)) LIMIT 1",
    )
    .get() as { id?: string } | undefined;
  if (parentDrift !== undefined) {
    problems.push(`execution commit '${parentDrift.id}' has a broken or cross-run parent link`);
  }
  // The DDL-backed uniquenesses (one commit per window, per run+sequence, per
  // accept assessment) are probed live from the index metadata.
  const probeUniqueIndexes = (table: string, columns: string[]): void => {
    const indexes = db.prepare(`PRAGMA index_list('${table}')`).all() as Array<{ name: string; unique: number }>;
    for (const index of indexes) {
      if (!index.unique) continue;
      const indexed = (
        db.prepare(`PRAGMA index_info('${index.name.replace(/'/g, "''")}')`).all() as Array<{ name: string }>
      ).map((column) => column.name);
      if (columns.every((column) => indexed.includes(column))) {
        return;
      }
    }
    problems.push(`${table} lost its unique constraint over [${columns.join(", ")}]`);
  };
  probeUniqueIndexes("execution_commits", ["run_id", "sequence"]);
  probeUniqueIndexes("execution_commits", ["window_id"]);
  probeUniqueIndexes("execution_commits", ["supervisor_assessment_id"]);
  // The accepted head references a same-run commit (E6 §57).
  const headDrift = db
    .prepare(
      "SELECT r.run_id AS id FROM execution_runs r "
      + "LEFT JOIN execution_commits c ON c.commit_id = r.accepted_head_commit_id "
      + "WHERE r.accepted_head_commit_id IS NOT NULL AND (c.commit_id IS NULL OR c.run_id != r.run_id) LIMIT 1",
    )
    .get() as { id?: string } | undefined;
  if (headDrift !== undefined) {
    problems.push(`execution run '${headDrift.id}' holds a foreign or missing accepted head`);
  }
  // Window accepted-base validity: execution_start base carries no commit ref;
  // execution_commit base names an existing same-run commit (E6 §57).
  const baseShape = db
    .prepare(
      "SELECT count(*) AS n FROM verification_windows WHERE "
      + "(base_kind = 'execution_start' AND base_commit_id IS NOT NULL) "
      + "OR (base_kind = 'execution_commit' AND base_commit_id IS NULL)",
    )
    .get() as { n: number };
  if (baseShape.n > 0) {
    problems.push("verification_windows holds an invalid accepted-base shape");
  }
  const baseDrift = db
    .prepare(
      "SELECT w.id AS id FROM verification_windows w "
      + "LEFT JOIN execution_commits c ON c.commit_id = w.base_commit_id "
      + "WHERE w.base_kind = 'execution_commit' AND (c.commit_id IS NULL OR c.run_id != w.run_id) LIMIT 1",
    )
    .get() as { id?: string } | undefined;
  if (baseDrift !== undefined) {
    problems.push(`verification window '${baseDrift.id}' binds a foreign or missing accepted-base commit`);
  }
  // Closed windows carry exactly one commit — EXCEPT the E9 terminal replan
  // closure (closure_kind='replan_required' creates NO commit by design, E9
  // §23) and the E13 terminal abort closure (closure_kind='aborted' creates
  // NO commit by design, E13 §19). Closure-aware once the column exists (v22+).
  const closedWithoutCommit = tableHasColumn(db, "verification_windows", "closure_kind")
    ? (db
        .prepare(
          "SELECT w.id AS id FROM verification_windows w "
          + "LEFT JOIN execution_commits c ON c.window_id = w.id "
          + "WHERE w.closed_at IS NOT NULL AND c.commit_id IS NULL "
          + "AND (w.closure_kind IS NULL OR (w.closure_kind != 'replan_required' AND w.closure_kind != 'aborted')) LIMIT 1",
        )
        .get() as { id?: string } | undefined)
    : (db
        .prepare(
          "SELECT w.id AS id FROM verification_windows w "
          + "LEFT JOIN execution_commits c ON c.window_id = w.id "
          + "WHERE w.closed_at IS NOT NULL AND c.commit_id IS NULL LIMIT 1",
        )
        .get() as { id?: string } | undefined);
  if (closedWithoutCommit !== undefined) {
    problems.push(`closed verification window '${closedWithoutCommit.id}' has no execution commit`);
  }
  const openWithCommit = db
    .prepare(
      "SELECT c.window_id AS id FROM execution_commits c "
      + "JOIN verification_windows w ON w.id = c.window_id "
      + "WHERE w.closed_at IS NULL LIMIT 1",
    )
    .get() as { id?: string } | undefined;
  if (openWithCommit !== undefined) {
    problems.push(`open verification window '${openWithCommit.id}' already carries an execution commit`);
  }
}

/**
 * Stage-completion provenance integrity (v0.2.0 E7 §44). Semantic Stage-
 * objective truth is NEVER validated in raw SQL — only the structural
 * completed↔provenance coupling, terminality, and dependency mapping are.
 */
function validateSchemaV20(db: StoreConnection | StoreTx, problems: string[]): void {
  const objectNames = new Set(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','trigger','index')").all() as {
        name: string;
      }[]
    ).map((row) => row.name),
  );
  for (const trigger of SCHEMA_V20_TRIGGERS) {
    if (!objectNames.has(trigger)) {
      problems.push(`constraint trigger ${trigger} missing for schema version >= 20`);
    }
  }
  const stageColumns = db.prepare("PRAGMA table_info('execution_stages')").all() as Array<{ name: string }>;
  if (!stageColumns.some((column) => column.name === "completed_by_commit_id")) {
    problems.push("execution_stages lost the completed_by_commit_id column");
    return;
  }
  // A completed Stage carries exact provenance: the commit exists and belongs
  // to the same run and the same stage (E7 §12/§44).
  const completionDrift = db
    .prepare(
      "SELECT s.id AS id FROM execution_stages s "
      + "LEFT JOIN execution_commits c ON c.commit_id = s.completed_by_commit_id "
      + "WHERE s.status = 'completed' "
      + "AND (s.completed_by_commit_id IS NULL OR c.commit_id IS NULL OR c.run_id != s.run_id OR c.stage_id != s.id) "
      + "LIMIT 1",
    )
    .get() as { id?: string } | undefined;
  if (completionDrift !== undefined) {
    problems.push(`execution stage '${completionDrift.id}' is completed without exact same-run/same-stage commit provenance`);
  }
  // Every non-completed Stage has no completion provenance (E7 §12/§44).
  const provenanceWithoutCompletion = db
    .prepare(
      "SELECT id FROM execution_stages WHERE status != 'completed' AND completed_by_commit_id IS NOT NULL LIMIT 1",
    )
    .get() as { id?: string } | undefined;
  if (provenanceWithoutCompletion !== undefined) {
    problems.push(`execution stage '${provenanceWithoutCompletion.id}' carries completion provenance without the completed status`);
  }
  // A completed Stage never owns an open window (E7 §29/§44).
  const completedWithOpenWindow = db
    .prepare(
      "SELECT w.id AS id FROM verification_windows w "
      + "JOIN execution_stages s ON s.id = w.stage_id "
      + "WHERE w.closed_at IS NULL AND s.status = 'completed' LIMIT 1",
    )
    .get() as { id?: string } | undefined;
  if (completedWithOpenWindow !== undefined) {
    problems.push(`completed execution stage still owns open verification window '${completedWithOpenWindow.id}'`);
  }
  // Every explicit dependency references a real same-Run Stage source step
  // (E7 §16/§44 — the plan synthesizer guarantees dependsOn ⊆ implementation
  // order stepIds, so a dangling mapping is store corruption, not a legal
  // waiting state).
  const danglingDependency = db
    .prepare(
      "SELECT s.id AS id, je.value AS dependency FROM execution_stages s, json_each(s.depends_on_json) je "
      + "LEFT JOIN execution_stages p ON p.run_id = s.run_id AND p.source_step_id = je.value "
      + "WHERE p.id IS NULL LIMIT 1",
    )
    .get() as { id?: string; dependency?: string } | undefined;
  if (danglingDependency !== undefined) {
    problems.push(
      `execution stage '${danglingDependency.id}' depends on unknown step '${danglingDependency.dependency}'`,
    );
  }
  // "No ExecutionRun.completed transition artifact added" (E7 §44): E7 adds
  // no run-lifecycle machinery and no finalization surface — asserted
  // behaviorally by E7-T27/T28; there is no schema artifact to probe.
}

/**
 * Verification-policy / conflict integrity (v0.2.0 E8 §47). Semantic truth
 * (whether claims REALLY contradict) is NEVER validated in raw SQL — only the
 * structural policy-legality matrix, source-Report binding, resolver
 * exclusivity, and settlement provenance are.
 */
function validateSchemaV21(db: StoreConnection | StoreTx, problems: string[]): void {
  const objectNames = new Set(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','trigger','index')").all() as {
        name: string;
      }[]
    ).map((row) => row.name),
  );
  for (const table of SCHEMA_V21_TABLES) {
    if (!objectNames.has(table)) {
      problems.push(`${table} table missing for schema version >= 21`);
    }
  }
  for (const trigger of SCHEMA_V21_TRIGGERS) {
    if (!objectNames.has(trigger)) {
      problems.push(`constraint trigger ${trigger} missing for schema version >= 21`);
    }
  }
  for (const index of SCHEMA_V21_INDEXES) {
    if (!objectNames.has(index)) {
      problems.push(`constraint index ${index} missing for schema version >= 21`);
    }
  }
  const directiveColumns = db.prepare("PRAGMA table_info('execution_directives')").all() as Array<{ name: string }>;
  for (const column of ["protocol_version", "verification_requirement", "verification_purpose", "verification_conflict_id"]) {
    if (!directiveColumns.some((candidate) => candidate.name === column)) {
      problems.push(`execution_directives lost the ${column} column`);
    }
  }
  if (SCHEMA_V21_TABLES.some((table) => !objectNames.has(table)) || directiveColumns.length < 4) {
    return;
  }
  // v1 Directives keep the policy columns NULL — historical policy stays
  // explicitly unknown, never backfilled (E8 §46).
  const v1WithPolicy = db
    .prepare(
      "SELECT directive_id AS id FROM execution_directives WHERE protocol_version = 1 "
      + "AND (verification_requirement IS NOT NULL OR verification_purpose IS NOT NULL OR verification_conflict_id IS NOT NULL) LIMIT 1",
    )
    .get() as { id?: string } | undefined;
  if (v1WithPolicy !== undefined) {
    problems.push(`v1 directive '${v1WithPolicy.id}' carries a fabricated verification policy`);
  }
  // The v2 §6 legality matrix, structurally.
  const illegalV2 = db
    .prepare(
      "SELECT directive_id AS id, kind FROM execution_directives WHERE protocol_version = 2 AND ("
      + " (kind = 'implementation' AND (verification_requirement NOT IN ('batchable','immediate') OR verification_requirement IS NULL OR verification_purpose IS NOT NULL OR verification_conflict_id IS NOT NULL))"
      + " OR (kind = 'inspection' AND (verification_requirement IS NOT NULL OR verification_purpose IS NOT NULL OR verification_conflict_id IS NOT NULL))"
      + " OR (kind = 'verification' AND (verification_requirement IS NOT NULL OR verification_purpose NOT IN ('normal','conflict_resolution') OR verification_purpose IS NULL"
      + "     OR (verification_purpose = 'normal' AND verification_conflict_id IS NOT NULL)"
      + "     OR (verification_purpose = 'conflict_resolution' AND verification_conflict_id IS NULL)))) LIMIT 1",
    )
    .get() as { id?: string; kind?: string } | undefined;
  if (illegalV2 !== undefined) {
    problems.push(`v2 ${illegalV2.kind} directive '${illegalV2.id}' violates the verification-policy legality matrix`);
  }
  // Conflict claims bind real same-run/window/revision Reports (E8 §28) —
  // reports reach window/revision through their immutable Directive binding.
  const danglingClaim = db
    .prepare(
      "SELECT c.conflict_id AS id, je.value AS reportId FROM verification_conflicts c, "
      + "json_each(c.claims_json) cj, json_each(cj.value -> '$.sourceReportIds') je "
      + "LEFT JOIN execution_reports r ON r.report_id = je.value "
      + "LEFT JOIN execution_directives d ON d.directive_id = r.directive_id AND d.revision = r.directive_revision "
      + "WHERE r.report_id IS NULL OR r.run_id != c.run_id OR d.window_id IS NOT c.window_id "
      + "OR d.base_candidate_revision IS NOT c.candidate_revision LIMIT 1",
    )
    .get() as { id?: string; reportId?: string } | undefined;
  if (danglingClaim !== undefined) {
    problems.push(`verification conflict '${danglingClaim.id}' claims a foreign or non-current report '${danglingClaim.reportId}'`);
  }
  // The resolver Directive belongs to the same run/window/revision as the
  // conflict, and no Directive resolves two conflicts (E8 §31/§38).
  const resolverDrift = db
    .prepare(
      "SELECT c.conflict_id AS id FROM verification_conflicts c "
      + "LEFT JOIN execution_directives d ON d.directive_id = c.resolution_directive_id AND d.revision = c.resolution_directive_revision "
      + "WHERE c.resolution_directive_id IS NOT NULL "
      + "AND (d.directive_id IS NULL OR d.run_id != c.run_id OR d.window_id != c.window_id OR d.base_candidate_revision != c.candidate_revision "
      + "  OR d.verification_purpose IS NOT 'conflict_resolution' OR d.verification_conflict_id IS NOT c.conflict_id) LIMIT 1",
    )
    .get() as { id?: string } | undefined;
  if (resolverDrift !== undefined) {
    problems.push(`verification conflict '${resolverDrift.id}' carries a mismatched resolver directive binding`);
  }
  const doubleResolved = db
    .prepare(
      "SELECT resolution_directive_id AS id FROM verification_conflicts "
      + "WHERE resolution_directive_id IS NOT NULL GROUP BY resolution_directive_id HAVING count(*) > 1 LIMIT 1",
    )
    .get() as { id?: string } | undefined;
  if (doubleResolved !== undefined) {
    problems.push(`resolution directive '${doubleResolved.id}' is bound to more than one conflict`);
  }
  // Settled conflicts carry an exact same-run resolution Report (E8 §36/§37).
  const settlementDrift = db
    .prepare(
      "SELECT c.conflict_id AS id FROM verification_conflicts c "
      + "LEFT JOIN execution_reports r ON r.report_id = c.resolution_report_id "
      + "WHERE c.status IN ('resolved','verification_blocked') "
      + "AND (r.report_id IS NULL OR r.run_id != c.run_id OR r.candidate_mutated != 0 OR r.result IS NOT 'completed') LIMIT 1",
    )
    .get() as { id?: string } | undefined;
  if (settlementDrift !== undefined) {
    problems.push(`verification conflict '${settlementDrift.id}' settled on a missing or non-completing resolution report`);
  }
  // E8 §45 — no E9+ schema objects.
  for (const forbidden of ["execution_replan_transitions", "execution_run_completions", "final_verification_windows", "execution_observations"]) {
    if (objectNames.has(forbidden)) {
      problems.push(`fabricated E9+ object '${forbidden}' exists`);
    }
  }
}

/**
 * Execution-scope integrity (v0.2.0 E10 §61/§62/§63). The scope shape
 * (stage ↔ non-null id, final_closure ↔ null id) is re-derived from data; the
 * final-closure lifecycle (window ↔ directive ↔ assessment ↔ commit scope
 * agreement, closure-kind ↔ run-lifecycle agreement) is probed structurally;
 * the completed↔completion_commit_id biconditional and its head equality are
 * re-derived. Semantic completion truth is NEVER validated in raw SQL — that
 * is the SupervisorAssessment's judgment under the trust model.
 */
function validateSchemaV23(db: StoreConnection | StoreTx, problems: string[]): void {
  for (const [table, column] of FORBIDDEN_BEFORE_V23_COLUMNS) {
    if (!tableHasColumn(db, table, column)) {
      problems.push(`${table} lost the ${column} column`);
    }
  }
  // The completion DDL fences are probed live (a dropped trigger is silence).
  for (const trigger of [
    "execution_runs_completion_insert_shape",
    "execution_runs_completion_shape",
    "execution_runs_terminal_lifecycle",
  ]) {
    const exists = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = ?")
      .get(trigger);
    if (exists === undefined) {
      problems.push(`constraint trigger ${trigger} missing for schema version >= 23`);
    }
  }
  for (const table of ["verification_windows", "execution_directives", "supervisor_assessments", "execution_commits"]) {
    for (const trigger of [`${table}_scope_insert_shape`, `${table}_scope_update_shape`]) {
      const exists = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = ?")
        .get(trigger);
      if (exists === undefined) {
        problems.push(`constraint trigger ${trigger} missing for schema version >= 23`);
      }
    }
  }
  if (
    !tableHasColumn(db, "verification_windows", "scope_kind")
    || !tableHasColumn(db, "execution_runs", "completion_commit_id")
  ) {
    return;
  }
  // E10 §63 — a Final Closure Window's base is always an accepted commit, and
  // its closure kind agrees with the run lifecycle (open↔active,
  // accepted↔completed, replan_required↔replan_required, aborted↔aborted —
  // E13 §19/§58).
  const finalWindowDrift = db
    .prepare(
      "SELECT w.id AS id FROM verification_windows w "
      + "LEFT JOIN execution_runs r ON r.run_id = w.run_id "
      + "LEFT JOIN execution_commits c ON c.commit_id = w.base_commit_id "
      + "WHERE w.scope_kind = 'final_closure' "
      + "AND (w.stage_id IS NOT NULL OR w.base_kind != 'execution_commit' OR w.base_commit_id IS NULL "
      + "  OR c.commit_id IS NULL OR c.run_id != w.run_id "
      + "  OR r.run_id IS NULL "
      + "  OR (w.closed_at IS NULL AND (r.lifecycle != 'active' OR w.closure_kind IS NOT NULL)) "
      + "  OR (w.closure_kind = 'accepted' AND (r.lifecycle IS NOT 'completed' OR w.closed_at IS NULL)) "
      + "  OR (w.closure_kind = 'replan_required' AND (r.lifecycle IS NOT 'replan_required' OR w.closed_at IS NULL)) "
      + "  OR (w.closure_kind = 'aborted' AND (r.lifecycle IS NOT 'aborted' OR w.closed_at IS NULL))) LIMIT 1",
    )
    .get() as { id?: string } | undefined;
  if (finalWindowDrift !== undefined) {
    problems.push(`final-closure window '${finalWindowDrift.id}' has a broken base, scope, or closure/lifecycle agreement`);
  }
  // E10 §63 — Final Closure Directives bind the exact final window; stage
  // directives bind stage windows of their own stage.
  const directiveScopeDrift = db
    .prepare(
      "SELECT d.directive_id AS id FROM execution_directives d "
      + "LEFT JOIN verification_windows w ON w.id = d.window_id "
      + "WHERE (d.scope_kind = 'stage' AND (d.stage_id IS NULL OR w.scope_kind != 'stage' OR w.stage_id != d.stage_id)) "
      + "OR (d.scope_kind = 'final_closure' AND (d.stage_id IS NOT NULL OR w.scope_kind != 'final_closure')) LIMIT 1",
    )
    .get() as { id?: string } | undefined;
  if (directiveScopeDrift !== undefined) {
    problems.push(`directive '${directiveScopeDrift.id}' scope disagrees with its window scope`);
  }
  // E10 §63 — final-closure assessments bind the exact final window with no
  // stage; stage assessments bind their stage window.
  const assessmentScopeDrift = db
    .prepare(
      "SELECT a.assessment_id AS id FROM supervisor_assessments a "
      + "LEFT JOIN verification_windows w ON w.id = a.window_id "
      + "WHERE (a.scope_kind = 'stage' AND (a.stage_id IS NULL OR w.scope_kind != 'stage' OR w.stage_id != a.stage_id)) "
      + "OR (a.scope_kind = 'final_closure' AND (a.stage_id IS NOT NULL OR w.scope_kind != 'final_closure')) LIMIT 1",
    )
    .get() as { id?: string } | undefined;
  if (assessmentScopeDrift !== undefined) {
    problems.push(`assessment '${assessmentScopeDrift.id}' scope disagrees with its window scope`);
  }
  // E10 §63 — Final ExecutionCommits are final_closure-scoped against the
  // exact final window; stage commits stay stage-scoped.
  const commitScopeDrift = db
    .prepare(
      "SELECT c.commit_id AS id FROM execution_commits c "
      + "LEFT JOIN verification_windows w ON w.id = c.window_id "
      + "WHERE (c.scope_kind = 'stage' AND (c.stage_id IS NULL OR w.scope_kind != 'stage' OR w.stage_id != c.stage_id)) "
      + "OR (c.scope_kind = 'final_closure' AND (c.stage_id IS NOT NULL OR w.scope_kind != 'final_closure')) LIMIT 1",
    )
    .get() as { id?: string } | undefined;
  if (commitScopeDrift !== undefined) {
    problems.push(`execution commit '${commitScopeDrift.id}' scope disagrees with its window scope`);
  }
  // E10 §43/§63 — completed ↔ completion_commit_id, the provenance commit is
  // the same-run final-closure commit and IS the acceptedHead, and a completed
  // run holds no open window and no active/pending ordinary Stage.
  const completedDrift = db
    .prepare(
      "SELECT r.run_id AS id FROM execution_runs r "
      + "LEFT JOIN execution_commits c ON c.commit_id = r.completion_commit_id "
      + "WHERE (r.lifecycle = 'completed') != (r.completion_commit_id IS NOT NULL) "
      + "OR (r.completion_commit_id IS NOT NULL "
      + "  AND (c.commit_id IS NULL OR c.run_id != r.run_id OR c.scope_kind != 'final_closure' "
      + "    OR r.accepted_head_commit_id IS NOT r.completion_commit_id)) "
      + "OR (r.lifecycle = 'completed' AND EXISTS (SELECT 1 FROM verification_windows w WHERE w.run_id = r.run_id AND w.closed_at IS NULL)) "
      + "OR (r.lifecycle = 'completed' AND EXISTS (SELECT 1 FROM execution_stages s WHERE s.run_id = r.run_id AND s.status IN ('active','pending'))) LIMIT 1",
    )
    .get() as { id?: string } | undefined;
  if (completedDrift !== undefined) {
    problems.push(`execution run '${completedDrift.id}' has broken completion provenance or post-completion structure`);
  }
  // E10 §62 — historical rows are stage-scoped with their stage ids unchanged;
  // the vocabulary is CHECK-enforced but re-derived.
  const badScope = db
    .prepare(
      "SELECT (SELECT count(*) FROM verification_windows WHERE scope_kind NOT IN ('stage','final_closure')) "
      + "+ (SELECT count(*) FROM execution_directives WHERE scope_kind NOT IN ('stage','final_closure')) "
      + "+ (SELECT count(*) FROM supervisor_assessments WHERE scope_kind NOT IN ('stage','final_closure')) "
      + "+ (SELECT count(*) FROM execution_commits WHERE scope_kind NOT IN ('stage','final_closure')) AS n",
    )
    .get() as { n: number };
  if (badScope.n > 0) {
    problems.push("execution-scope vocabulary is corrupt");
  }
}

/**
 * Attempt-reconciliation integrity (v0.2.0 E11 §53/§54). The binding and
 * resolution shapes are re-derived from data: the binding targets a still-
 * indeterminate same-run Attempt whose bound Directive is a same-run
 * inspection; the resolution's revision-delta matches its resolution kind, its
 * Report (when present) belongs to the bound reconciliation Directive lineage
 * and is completed and non-mutating, and the resolved Attempt is still
 * indeterminate (E11 §4 — reconciliation never mutates Attempt state).
 */
function validateSchemaV24(db: StoreConnection | StoreTx, problems: string[]): void {
  for (const table of FORBIDDEN_BEFORE_V24_TABLES) {
    if (!tableNames(db).has(table)) {
      problems.push(`${table} table missing for schema version >= 24`);
    }
  }
  for (const table of FORBIDDEN_BEFORE_V24_TABLES) {
    for (const trigger of [`${table}_no_update`, `${table}_no_delete`]) {
      const exists = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = ?")
        .get(trigger);
      if (exists === undefined) {
        problems.push(`constraint trigger ${trigger} missing for schema version >= 24`);
      }
    }
  }
  if (!tableNames(db).has("execution_attempt_reconciliation_bindings")) {
    return;
  }
  // E11 §53 — the binding: same-run indeterminate Attempt + same-run
  // inspection Directive (revisions of the logical id allowed).
  const bindingDrift = db
    .prepare(
      "SELECT b.attempt_id AS id FROM execution_attempt_reconciliation_bindings b "
      + "LEFT JOIN execution_attempts a ON a.attempt_id = b.attempt_id "
      + "LEFT JOIN execution_directives d ON d.directive_id = b.directive_id AND d.revision = b.first_directive_revision "
      + "WHERE a.attempt_id IS NULL OR a.state != 'indeterminate' OR a.run_id != b.run_id "
      + "OR d.directive_id IS NULL OR d.run_id != b.run_id OR d.kind != 'inspection' LIMIT 1",
    )
    .get() as { id?: string } | undefined;
  if (bindingDrift !== undefined) {
    problems.push(`attempt reconciliation binding '${bindingDrift.id}' targets a missing/foreign/non-indeterminate Attempt or a non-inspection Directive`);
  }
  if (!tableNames(db).has("execution_attempt_reconciliations")) {
    return;
  }
  // E11 §54 — the resolution: same-run indeterminate target; delta shape; the
  // inspection Report (when present) belongs to the bound Directive lineage
  // and is completed and non-mutating; the capability proof never carries one.
  const resolutionDrift = db
    .prepare(
      "SELECT r.reconciliation_id AS id FROM execution_attempt_reconciliations r "
      + "LEFT JOIN execution_attempts a ON a.attempt_id = r.attempt_id "
      + "LEFT JOIN execution_directives d ON d.directive_id = r.directive_id AND d.revision = r.directive_revision "
      + "LEFT JOIN execution_reports rep ON rep.report_id = r.inspection_report_id "
      + "WHERE a.attempt_id IS NULL OR a.state != 'indeterminate' OR a.run_id != r.run_id "
      + "OR d.directive_id IS NULL OR d.run_id != r.run_id "
      + "OR (r.inspection_report_id IS NOT NULL AND d.kind != 'inspection') "
      + "OR (r.inspection_report_id IS NULL AND (d.directive_id != a.directive_id OR d.revision != a.directive_revision)) "
      + "OR (r.resolution = 'candidate_changed' AND r.candidate_revision_after != r.candidate_revision_before + 1) "
      + "OR (r.resolution != 'candidate_changed' AND r.candidate_revision_after != r.candidate_revision_before) "
      + "OR (r.resolution = 'no_effect_by_capability' AND r.inspection_report_id IS NOT NULL) "
      + "OR (r.resolution != 'no_effect_by_capability' AND (r.inspection_report_id IS NULL OR rep.report_id IS NULL "
      + "  OR rep.directive_id != r.directive_id OR rep.directive_revision != r.directive_revision "
      + "  OR rep.result != 'completed' OR rep.candidate_mutated != 0)) LIMIT 1",
    )
    .get() as { id?: string } | undefined;
  if (resolutionDrift !== undefined) {
    problems.push(`attempt reconciliation '${resolutionDrift.id}' has a broken resolution/report/revision-delta shape`);
  }
}

/**
 * E13 §58 — the abort-shape validator. Every aborted Run carries exactly one
 * durable abort fact bound to a real 'abort' run-control authorization
 * targeting the same run; aborted runs never carry completion provenance or
 * an open Window; aborted Windows agree with the run lifecycle and carry no
 * ExecutionCommit; active/completed/replan_required runs never carry abort
 * provenance. Stage completion and Attempt reconciliation are deliberately
 * NOT required for an aborted run (E13 §58 — the terminal lifecycle explains
 * why execution stopped).
 */
function validateSchemaV25(db: StoreConnection | StoreTx, problems: string[]): void {
  if (!tableNames(db).has("execution_abort_records")) {
    problems.push("execution_abort_records table missing for schema version >= 25");
    return;
  }
  // An aborted run requires its abort fact; every other lifecycle forbids one.
  const abortFactDrift = db
    .prepare(
      "SELECT r.run_id AS id FROM execution_runs r "
      + "LEFT JOIN execution_abort_records a ON a.run_id = r.run_id "
      + "WHERE (r.lifecycle = 'aborted' AND a.run_id IS NULL) "
      + "OR (r.lifecycle != 'aborted' AND a.run_id IS NOT NULL) LIMIT 1",
    )
    .get() as { id?: string } | undefined;
  if (abortFactDrift !== undefined) {
    problems.push(`execution run '${abortFactDrift.id}' disagrees with its abort provenance (E13 §58)`);
  }
  // The abort fact references a REAL human-authorized 'abort' control record
  // for the SAME run (E13 §59). v25 physical identity: the control row's
  // run_id is the run pointer (the typed execution_run_id column arrives in
  // migration 026; validateSchemaV26 re-keys this probe).
  const abortAuthDrift = db
    .prepare(
      "SELECT a.run_id AS id FROM execution_abort_records a "
      + "LEFT JOIN run_control_authorizations c ON c.control_id = a.control_id "
      + "WHERE c.control_id IS NULL OR c.operation != 'abort' OR c.run_id != a.run_id LIMIT 1",
    )
    .get() as { id?: string } | undefined;
  if (abortAuthDrift !== undefined) {
    problems.push(`abort record '${abortAuthDrift.id}' references a missing/foreign/non-abort run-control authorization (E13 §59)`);
  }
  // An aborted run never carries completion provenance (§58; the DDL shape
  // trigger enforces the biconditional too).
  const abortedWithCompletion = db
    .prepare(
      "SELECT run_id AS id FROM execution_runs WHERE lifecycle = 'aborted' AND completion_commit_id IS NOT NULL LIMIT 1",
    )
    .get() as { id?: string } | undefined;
  if (abortedWithCompletion !== undefined) {
    problems.push(`aborted execution run '${abortedWithCompletion.id}' carries completion provenance (E13 §58)`);
  }
  // An aborted run has no open Window (§58/§19 — the abort transaction closed
  // it); any terminal run holding an open window is shape drift.
  const terminalWithOpenWindow = db
    .prepare(
      "SELECT w.run_id AS id FROM verification_windows w "
      + "JOIN execution_runs r ON r.run_id = w.run_id "
      + "WHERE w.closed_at IS NULL AND r.lifecycle != 'active' LIMIT 1",
    )
    .get() as { id?: string } | undefined;
  if (terminalWithOpenWindow !== undefined) {
    problems.push(`terminal execution run '${terminalWithOpenWindow.id}' still owns an open verification window (E13 §19/§58)`);
  }
  // An aborted Window (stage or final scope) agrees with the run lifecycle
  // and carries NO ExecutionCommit (§19/§58).
  const abortedWindowDrift = db
    .prepare(
      "SELECT w.id AS id FROM verification_windows w "
      + "LEFT JOIN execution_runs r ON r.run_id = w.run_id "
      + "LEFT JOIN execution_commits c ON c.window_id = w.id "
      + "WHERE w.closure_kind = 'aborted' "
      + "AND (r.lifecycle IS NOT 'aborted' OR c.commit_id IS NOT NULL OR w.closed_at IS NULL) LIMIT 1",
    )
    .get() as { id?: string } | undefined;
  if (abortedWindowDrift !== undefined) {
    problems.push(`aborted verification window '${abortedWindowDrift.id}' disagrees with its run lifecycle or carries a commit (E13 §19)`);
  }
}

/** A1-I §4 — the formal presence-probe inventory: every immutable trigger and
 * invariant index the rebuilt v26 estate must carry. Exported for the formal
 * test suite (the probe itself runs on every open via validateSchemaV26). */
export const SCHEMA_V26_OBJECTS = [
  // rebuilt tables' immutability/identity triggers
  "execution_runs_no_delete", "execution_runs_binding_immutable",
  "execution_run_events_no_update", "execution_run_events_no_delete",
  "execution_protocol_events_no_update", "execution_protocol_events_no_delete",
  "execution_acceptance_events_no_update", "execution_acceptance_events_no_delete",
  "execution_stages_no_delete", "execution_stages_provenance_immutable",
  "execution_stages_completion_insert_shape", "execution_stages_completion_consistent",
  "verification_windows_no_delete", "verification_windows_identity_immutable",
  "verification_windows_base_shape", "verification_windows_base_immutable",
  "verification_windows_closure_shape", "verification_windows_closure_insert_shape",
  "execution_directives_no_update", "execution_directives_no_delete",
  "supervisor_bindings_no_delete", "supervisor_bindings_identity_immutable",
  "supervisor_binding_events_no_update", "supervisor_binding_events_no_delete",
  "supervisor_assessments_no_update", "supervisor_assessments_no_delete",
  "supervisor_assessment_report_judgments_no_update", "supervisor_assessment_report_judgments_no_delete",
  "execution_commits_no_update", "execution_commits_no_delete",
  "execution_attempts_no_delete", "execution_attempts_identity_immutable",
  "execution_reports_no_update", "execution_reports_no_delete",
  "verification_conflicts_no_delete", "verification_conflicts_identity_immutable",
  "execution_worker_invocations_no_delete", "execution_worker_invocations_identity_immutable",
  "execution_worker_invocations_session_immutable", "execution_worker_invocations_finished_terminal",
  "execution_worker_invocation_events_no_update", "execution_worker_invocation_events_no_delete",
  "execution_attempt_reconciliation_bindings_no_update", "execution_attempt_reconciliation_bindings_no_delete",
  "execution_attempt_reconciliations_no_update", "execution_attempt_reconciliations_no_delete",
  "execution_issues_no_update", "execution_issues_no_delete",
  "execution_issue_refs_no_update", "execution_issue_refs_no_delete",
  "execution_issue_adoptions_no_update", "execution_issue_adoptions_no_delete",
  "execution_abort_records_no_update", "execution_abort_records_no_delete",
  "run_control_authorizations_no_update", "run_control_authorizations_no_delete",
  // invariant indexes (singletons + fences)
  "idx_verification_windows_open_run",
  "idx_execution_attempts_running_run",
  "idx_execution_stages_active_run",
  "idx_execution_issues_replan_per_run",
  "idx_worker_invocations_claimed_session",
  "idx_supervisor_bindings_active_session",
  "idx_execution_runs_workspace_singleton",
];

/**
 * Structural + data checks for schema v26 (A1-I ExecutionRun identity
 * migration). This is the re-keyed carrier of every execution-era invariant
 * from v14–v25 (which apply only up to v25 — the physical identity changed)
 * plus the A1-I additions: the workspace prepared|active singleton, the
 * no-FK-on-execution_runs(run_id) rule, typed run-control target shape, and
 * the required run_id linkage on Class-1 tables. Bounded LIMIT-1
 * probes only; semantic acceptance truth is never validated in raw SQL.
 */
function validateSchemaV26(db: StoreConnection | StoreTx, problems: string[]): void {
  const objectNames = new Set(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','trigger','index')").all() as {
        name: string;
      }[]
    ).map((row) => row.name),
  );
  const probeUniqueIndexes = (table: string, columns: string[]): void => {
    const indexes = db.prepare(`PRAGMA index_list('${table}')`).all() as Array<{ name: string; unique: number }>;
    for (const index of indexes) {
      if (!index.unique) continue;
      const indexed = (
        db.prepare(`PRAGMA index_info('${index.name.replace(/'/g, "''")}')`).all() as Array<{ name: string }>
      ).map((column) => column.name);
      if (columns.every((column) => indexed.includes(column))) {
        return;
      }
    }
    problems.push(`${table} lost its unique constraint over [${columns.join(", ")}]`);
  };

  // ---- v14/v15/v16/v18/v19/v20/v21/v24/v25 presence carry-forward: the ----
  // ---- rebuilt execution estate must carry its FULL constraint furniture ----
  for (const name of SCHEMA_V26_OBJECTS) {
    if (!objectNames.has(name)) {
      problems.push(`constraint object ${name} missing for schema version >= 26 (A1-I)`);
    }
  }

  // ---- v14: run root integrity (FinalPlan/workspace binding, lifecycle) ----
  const finalPlanDrift = db
    .prepare(
      "SELECT e.run_id AS runId FROM execution_runs e "
      + "LEFT JOIN final_plans f ON f.run_id = e.run_id AND f.final_plan_id = e.final_plan_id "
      + "WHERE f.final_plan_id IS NULL "
      + "OR f.revision != e.final_plan_revision OR f.final_plan_hash != e.final_plan_hash LIMIT 1",
    )
    .get() as { runId?: string } | undefined;
  if (finalPlanDrift !== undefined) {
    problems.push(`execution run '${finalPlanDrift.runId}' is not bound to an exact FinalPlan revision of its source planning run`);
  }
  const workspaceDrift = db
    .prepare(
      "SELECT e.run_id AS runId FROM execution_runs e "
      + "LEFT JOIN workspaces w ON w.workspace_id = e.workspace_id "
      + "LEFT JOIN planning_runs r ON r.run_id = e.run_id "
      + "WHERE w.workspace_id IS NULL OR r.run_id IS NULL OR r.workspace_id != e.workspace_id LIMIT 1",
    )
    .get() as { runId?: string } | undefined;
  if (workspaceDrift !== undefined) {
    problems.push(`execution run '${workspaceDrift.runId}' references a missing workspace or a foreign run workspace`);
  }
  const lifecycleRevisionDrift = db
    .prepare(
      "SELECT execution_run_id AS runId FROM execution_runs "
      + "WHERE lifecycle != 'prepared' AND revision < 2 LIMIT 1",
    )
    .get() as { runId?: string } | undefined;
  if (lifecycleRevisionDrift !== undefined) {
    problems.push(`execution run '${lifecycleRevisionDrift.runId}' left 'prepared' without a revision advance`);
  }
  const badFirstRunEvent = db
    .prepare(
      "SELECT execution_run_id AS runId FROM execution_run_events WHERE event_seq = 1 AND event_type != 'PREPARED' LIMIT 1",
    )
    .get() as { runId?: string } | undefined;
  if (badFirstRunEvent !== undefined) {
    problems.push(`execution run '${badFirstRunEvent.runId}' lifecycle history does not start at PREPARED`);
  }

  // ---- v15: SupervisorBinding integrity (exact-Run scope, generation law) ----
  const bindingRunDrift = db
    .prepare(
      "SELECT s.execution_run_id AS runId FROM supervisor_bindings s "
      + "LEFT JOIN execution_runs e ON e.execution_run_id = s.execution_run_id "
      + "WHERE e.execution_run_id IS NULL OR e.workspace_id != s.workspace_id LIMIT 1",
    )
    .get() as { runId?: string } | undefined;
  if (bindingRunDrift !== undefined) {
    problems.push(`supervisor binding '${bindingRunDrift.runId}' names a missing execution run or a foreign workspace/provenance`);
  }
  const duplicateActiveSupervisors = db
    .prepare(
      "SELECT session_id AS sessionId FROM supervisor_bindings WHERE state = 'attached' "
      + "GROUP BY session_id HAVING count(*) > 1 LIMIT 1",
    )
    .get() as { sessionId?: string } | undefined;
  if (duplicateActiveSupervisors !== undefined) {
    problems.push(`session '${duplicateActiveSupervisors.sessionId}' holds multiple attached supervision bindings`);
  }
  const badFirstBindingEvent = db
    .prepare(
      "SELECT execution_run_id AS runId FROM supervisor_binding_events WHERE event_seq = 1 AND event_type != 'ATTACHED' LIMIT 1",
    )
    .get() as { runId?: string } | undefined;
  if (badFirstBindingEvent !== undefined) {
    problems.push(`supervisor binding '${badFirstBindingEvent.runId}' ownership history does not start at ATTACHED`);
  }

  // ---- v16: stage/window structure (single active stage, single open window) ----
  const stageRunDrift = db
    .prepare(
      "SELECT s.id AS id FROM execution_stages s "
      + `LEFT JOIN execution_runs e ON e.${"execution_run_id"} = s.${"execution_run_id"} `
      + `WHERE e.${"execution_run_id"} IS NULL LIMIT 1`,
    )
    .get() as { id?: string } | undefined;
  if (stageRunDrift !== undefined) {
    problems.push(`execution stage '${stageRunDrift.id}' names a missing execution run`);
  }
  const windowDrift = db
    .prepare(
      "SELECT w.id AS id FROM verification_windows w "
      + "LEFT JOIN execution_runs e ON e.execution_run_id = w.execution_run_id "
      + "LEFT JOIN execution_stages s ON s.id = w.stage_id "
      + "WHERE e.execution_run_id IS NULL "
      + "OR (w.scope_kind = 'stage' AND (w.stage_id IS NULL OR s.id IS NULL OR s.execution_run_id != w.execution_run_id)) "
      + "OR (w.scope_kind = 'final_closure' AND w.stage_id IS NOT NULL) "
      + "OR (w.scope_kind NOT IN ('stage', 'final_closure')) LIMIT 1",
    )
    .get() as { id?: string } | undefined;
  if (windowDrift !== undefined) {
    problems.push(`verification window '${windowDrift.id}' has a cross-run stage, a broken scope, or a missing parent`);
  }
  const multiActiveStage = db
    .prepare(
      "SELECT execution_run_id AS runId FROM execution_stages WHERE status = 'active' GROUP BY execution_run_id HAVING count(*) > 1 LIMIT 1",
    )
    .get() as { runId?: string } | undefined;
  if (multiActiveStage !== undefined) {
    problems.push(`execution run '${multiActiveStage.runId}' holds multiple active stages`);
  }
  const multiOpenWindow = db
    .prepare(
      "SELECT execution_run_id AS runId FROM verification_windows WHERE closed_at IS NULL GROUP BY execution_run_id HAVING count(*) > 1 LIMIT 1",
    )
    .get() as { runId?: string } | undefined;
  if (multiOpenWindow !== undefined) {
    problems.push(`execution run '${multiOpenWindow.runId}' holds multiple open verification windows`);
  }
  if (
    (db.prepare("SELECT count(*) AS n FROM verification_windows WHERE candidate_revision < 0").get() as { n: number }).n > 0
  ) {
    problems.push("verification_windows contains negative candidate revisions");
  }
  const windowIndexes = db
    .prepare("PRAGMA index_list('verification_windows')")
    .all() as Array<{ name: string; unique: number; origin: string }>;
  for (const index of windowIndexes) {
    if (!index.unique) continue;
    const columns = (
      db.prepare(`PRAGMA index_info('${index.name.replace(/'/g, "''")}')`).all() as Array<{ name: string }>
    ).map((column) => column.name);
    const identityLike = columns.length === 1 && columns[0] === "stage_id";
    const runStageLike =
      columns.length === 2 && columns.includes("execution_run_id") && columns.includes("stage_id");
    if ((identityLike || runStageLike) && !columns.includes("closed_at")) {
      problems.push(
        `verification_windows carries a permanent unique index '${index.name}' over [${columns.join(", ")}] — one Stage may own multiple sequential windows`,
      );
    }
  }

  // ---- A1 §27: the workspace nonterminal singleton, re-derived ----
  const multiNonterminal = db
    .prepare(
      "SELECT workspace_id AS id FROM execution_runs WHERE lifecycle IN ('prepared', 'active') "
      + "GROUP BY workspace_id HAVING count(*) > 1 LIMIT 1",
    )
    .get() as { id?: string } | undefined;
  if (multiNonterminal !== undefined) {
    problems.push(`workspace '${multiNonterminal.id}' holds multiple nonterminal execution runs (A1 §27)`);
  }
  if (!objectNames.has("idx_execution_runs_workspace_singleton")) {
    problems.push("execution_runs lost the workspace prepared|active singleton index (A1 §27)");
  }

  // ---- v17: directives/attempts/reports protocol integrity ----
  const directiveRunDrift = db
    .prepare(
      "SELECT d.directive_id AS id FROM execution_directives d "
      + "LEFT JOIN execution_runs e ON e.execution_run_id = d.execution_run_id "
      + "WHERE e.execution_run_id IS NULL OR d.run_id IS NULL OR d.execution_run_id = '' LIMIT 1",
    )
    .get() as { id?: string } | undefined;
  if (directiveRunDrift !== undefined) {
    problems.push(`execution directive '${directiveRunDrift.id}' names a missing execution run or lacks its exact-run linkage`);
  }
  const attemptDrift = db
    .prepare(
      "SELECT a.attempt_id AS id FROM execution_attempts a "
      + "LEFT JOIN execution_runs e ON e.execution_run_id = a.execution_run_id "
      + "LEFT JOIN execution_directives d ON d.directive_id = a.directive_id AND d.revision = a.directive_revision "
      + "WHERE e.execution_run_id IS NULL OR d.directive_id IS NULL OR d.directive_hash != a.directive_hash "
      + "OR d.execution_run_id != a.execution_run_id LIMIT 1",
    )
    .get() as { id?: string } | undefined;
  if (attemptDrift !== undefined) {
    problems.push(`execution attempt '${attemptDrift.id}' binds a missing or mismatched Directive revision`);
  }
  const reportDrift = db
    .prepare(
      "SELECT r.report_id AS id FROM execution_reports r "
      + "LEFT JOIN execution_runs e ON e.execution_run_id = r.execution_run_id "
      + "LEFT JOIN execution_attempts a ON a.attempt_id = r.attempt_id "
      + "WHERE e.execution_run_id IS NULL OR a.attempt_id IS NULL "
      + "OR r.directive_id != a.directive_id OR r.directive_revision != a.directive_revision "
      + "OR r.directive_hash != a.directive_hash OR r.worker_role != a.worker_role LIMIT 1",
    )
    .get() as { id?: string } | undefined;
  if (reportDrift !== undefined) {
    problems.push(`execution report '${reportDrift.id}' binds a missing or mismatched Attempt`);
  }
  if (
    (db.prepare("SELECT count(*) AS n FROM execution_attempts WHERE (state = 'running') != (ended_at IS NULL) OR (state IN ('reported','indeterminate')) != (ended_at IS NOT NULL)").get() as { n: number }).n > 0
  ) {
    problems.push("execution_attempts ended_at disagrees with the attempt state");
  }
  const multiRunningAttempt = db
    .prepare(
      "SELECT execution_run_id AS runId FROM execution_attempts WHERE state = 'running' GROUP BY execution_run_id HAVING count(*) > 1 LIMIT 1",
    )
    .get() as { runId?: string } | undefined;
  if (multiRunningAttempt !== undefined) {
    problems.push(`execution run '${multiRunningAttempt.runId}' holds multiple running attempts`);
  }
  const duplicateAttempts = db
    .prepare(
      "SELECT directive_id AS id, directive_revision AS revision FROM execution_attempts "
      + "GROUP BY directive_id, directive_revision HAVING count(*) > 1 LIMIT 1",
    )
    .get() as { id?: string; revision?: number } | undefined;
  if (duplicateAttempts !== undefined) {
    problems.push(`directive revision '${duplicateAttempts.id}@${duplicateAttempts.revision}' holds multiple attempts`);
  }
  if (
    (db.prepare("SELECT count(*) AS n FROM execution_reports WHERE result = 'blocked' AND (blockers_json IS NULL OR blockers_json = '' OR blockers_json = '[]')").get() as { n: number }).n > 0
  ) {
    problems.push("execution_reports holds result=blocked rows without a structured blocker");
  }
  probeUniqueIndexes("execution_attempts", ["directive_id", "directive_revision"]);
  probeUniqueIndexes("execution_reports", ["attempt_id"]);
  const runningIndexes = db
    .prepare("PRAGMA index_list('execution_attempts')")
    .all() as Array<{ name: string; unique: number }>;
  const hasRunningFence = runningIndexes.some((index) => {
    if (!index.unique) return false;
    const indexed = (
      db.prepare(`PRAGMA index_info('${index.name.replace(/'/g, "''")}')`).all() as Array<{ name: string }>
    ).map((column) => column.name);
    return indexed.length === 1 && indexed[0] === "execution_run_id";
  });
  if (!hasRunningFence) {
    problems.push("execution_attempts lost the partial unique running-attempt-per-run fence");
  }

  // ---- v18: worker invocation integrity (exact-Run authority chain) ----
  const invocationDrift = db
    .prepare(
      "SELECT w.attempt_id AS id FROM execution_worker_invocations w "
      + "LEFT JOIN execution_attempts a ON a.attempt_id = w.attempt_id "
      + "WHERE a.attempt_id IS NULL OR a.execution_run_id != w.execution_run_id OR a.worker_role != w.worker_role LIMIT 1",
    )
    .get() as { id?: string } | undefined;
  if (invocationDrift !== undefined) {
    problems.push(`worker invocation '${invocationDrift.id}' binds a missing or mismatched attempt`);
  }
  const multiClaimed = db
    .prepare(
      "SELECT worker_session_id AS sessionId FROM execution_worker_invocations WHERE state = 'claimed' "
      + "GROUP BY worker_session_id HAVING count(*) > 1 LIMIT 1",
    )
    .get() as { sessionId?: string } | undefined;
  if (multiClaimed !== undefined) {
    problems.push(`worker session '${multiClaimed.sessionId}' holds multiple claimed invocations`);
  }

  // ---- v19: acceptance integrity (commit chain, judgments, accepted head) ----
  const assessmentDrift = db
    .prepare(
      "SELECT a.assessment_id AS id FROM supervisor_assessments a "
      + "LEFT JOIN execution_runs r ON r.execution_run_id = a.execution_run_id "
      + "LEFT JOIN execution_stages s ON s.id = a.stage_id "
      + "LEFT JOIN verification_windows w ON w.id = a.window_id "
      + "WHERE r.execution_run_id IS NULL OR w.id IS NULL OR w.execution_run_id != a.execution_run_id "
      + "OR w.candidate_revision != a.candidate_revision "
      + "OR (a.scope_kind = 'stage' AND (a.stage_id IS NULL OR s.id IS NULL OR s.execution_run_id != a.execution_run_id OR w.scope_kind != 'stage' OR w.stage_id != a.stage_id)) "
      + "OR (a.scope_kind = 'final_closure' AND (a.stage_id IS NOT NULL OR w.scope_kind != 'final_closure')) "
      + "OR (a.scope_kind NOT IN ('stage', 'final_closure')) LIMIT 1",
    )
    .get() as { id?: string } | undefined;
  if (assessmentDrift !== undefined) {
    problems.push(`supervisor assessment '${assessmentDrift.id}' binds a missing or mismatched run/stage/window/revision`);
  }
  const judgmentDrift = db
    .prepare(
      "SELECT j.assessment_id AS id FROM supervisor_assessment_report_judgments j "
      + "LEFT JOIN execution_reports rep ON rep.report_id = j.report_id "
      + "LEFT JOIN supervisor_assessments a ON a.assessment_id = j.assessment_id "
      + "WHERE rep.report_id IS NULL OR a.assessment_id IS NULL OR rep.execution_run_id != a.execution_run_id LIMIT 1",
    )
    .get() as { id?: string } | undefined;
  if (judgmentDrift !== undefined) {
    problems.push(`assessment '${judgmentDrift.id}' carries a judgment for a foreign or missing report`);
  }
  const commitDrift = db
    .prepare(
      "SELECT c.commit_id AS id FROM execution_commits c "
      + "LEFT JOIN execution_stages s ON s.id = c.stage_id "
      + "LEFT JOIN verification_windows w ON w.id = c.window_id "
      + "WHERE w.id IS NULL OR w.execution_run_id != c.execution_run_id OR w.candidate_revision != c.candidate_revision "
      + "OR (c.scope_kind = 'stage' AND (c.stage_id IS NULL OR s.id IS NULL OR s.execution_run_id != c.execution_run_id OR w.scope_kind != 'stage' OR w.stage_id != c.stage_id)) "
      + "OR (c.scope_kind = 'final_closure' AND (c.stage_id IS NOT NULL OR w.scope_kind != 'final_closure')) "
      + "OR (c.scope_kind NOT IN ('stage', 'final_closure')) LIMIT 1",
    )
    .get() as { id?: string } | undefined;
  if (commitDrift !== undefined) {
    problems.push(`execution commit '${commitDrift.id}' binds a mismatched stage/window/revision`);
  }
  const parentDrift = db
    .prepare(
      "SELECT c.commit_id AS id FROM execution_commits c "
      + "LEFT JOIN execution_commits p ON p.commit_id = c.parent_commit_id "
      + "WHERE (c.sequence = 1 AND c.parent_commit_id IS NOT NULL) "
      + "OR (c.sequence > 1 AND (p.commit_id IS NULL OR p.execution_run_id != c.execution_run_id OR p.sequence != c.sequence - 1)) LIMIT 1",
    )
    .get() as { id?: string } | undefined;
  if (parentDrift !== undefined) {
    problems.push(`execution commit '${parentDrift.id}' has a broken or cross-run parent link`);
  }
  probeUniqueIndexes("execution_commits", ["execution_run_id", "sequence"]);
  probeUniqueIndexes("execution_commits", ["window_id"]);
  probeUniqueIndexes("execution_commits", ["supervisor_assessment_id"]);
  // A1 §17/§46 — the accepted head references a same-Run commit.
  const headDrift = db
    .prepare(
      "SELECT r.execution_run_id AS id FROM execution_runs r "
      + "LEFT JOIN execution_commits c ON c.commit_id = r.accepted_head_commit_id "
      + "WHERE r.accepted_head_commit_id IS NOT NULL AND (c.commit_id IS NULL OR c.execution_run_id != r.execution_run_id) LIMIT 1",
    )
    .get() as { id?: string } | undefined;
  if (headDrift !== undefined) {
    problems.push(`execution run '${headDrift.id}' holds a foreign or missing accepted head`);
  }
  const baseDrift = db
    .prepare(
      "SELECT w.id AS id FROM verification_windows w "
      + "LEFT JOIN execution_commits c ON c.commit_id = w.base_commit_id "
      + "WHERE w.base_kind = 'execution_commit' AND (c.commit_id IS NULL OR c.execution_run_id != w.execution_run_id) LIMIT 1",
    )
    .get() as { id?: string } | undefined;
  if (baseDrift !== undefined) {
    problems.push(`verification window '${baseDrift.id}' binds a foreign or missing accepted-base commit`);
  }
  const openWithCommit = db
    .prepare(
      "SELECT c.window_id AS id FROM execution_commits c "
      + "JOIN verification_windows w ON w.id = c.window_id "
      + "WHERE w.closed_at IS NULL LIMIT 1",
    )
    .get() as { id?: string } | undefined;
  if (openWithCommit !== undefined) {
    problems.push(`open verification window '${openWithCommit.id}' already carries an execution commit`);
  }

  // ---- v20: stage completion provenance ----
  const completionProvenanceDrift = db
    .prepare(
      "SELECT s.id AS id FROM execution_stages s "
      + "LEFT JOIN execution_commits c ON c.commit_id = s.completed_by_commit_id "
      + "WHERE s.status = 'completed' "
      + "AND (s.completed_by_commit_id IS NULL OR c.commit_id IS NULL OR c.execution_run_id != s.execution_run_id OR c.stage_id != s.id) "
      + "LIMIT 1",
    )
    .get() as { id?: string } | undefined;
  if (completionProvenanceDrift !== undefined) {
    problems.push(`execution stage '${completionProvenanceDrift.id}' is completed without exact same-run/same-stage commit provenance`);
  }
  const completedWithOpenWindow = db
    .prepare(
      "SELECT w.id AS id FROM verification_windows w "
      + "JOIN execution_stages s ON s.id = w.stage_id "
      + "WHERE w.closed_at IS NULL AND s.status = 'completed' LIMIT 1",
    )
    .get() as { id?: string } | undefined;
  if (completedWithOpenWindow !== undefined) {
    problems.push(`completed execution stage still owns open verification window '${completedWithOpenWindow.id}'`);
  }
  const danglingDependency = db
    .prepare(
      "SELECT s.id AS id, je.value AS dependency FROM execution_stages s, json_each(s.depends_on_json) je "
      + "LEFT JOIN execution_stages p ON p.execution_run_id = s.execution_run_id AND p.source_step_id = je.value "
      + "WHERE p.id IS NULL LIMIT 1",
    )
    .get() as { id?: string; dependency?: string } | undefined;
  if (danglingDependency !== undefined) {
    problems.push(
      `execution stage '${danglingDependency.id}' depends on unknown step '${danglingDependency.dependency}'`,
    );
  }

  // ---- v21: verification-policy / conflict integrity ----
  const v1WithPolicy = db
    .prepare(
      "SELECT directive_id AS id FROM execution_directives WHERE protocol_version = 1 "
      + "AND (verification_requirement IS NOT NULL OR verification_purpose IS NOT NULL OR verification_conflict_id IS NOT NULL) LIMIT 1",
    )
    .get() as { id?: string } | undefined;
  if (v1WithPolicy !== undefined) {
    problems.push(`v1 directive '${v1WithPolicy.id}' carries a fabricated verification policy`);
  }
  const illegalV2 = db
    .prepare(
      "SELECT directive_id AS id, kind FROM execution_directives WHERE protocol_version = 2 AND ("
      + " (kind = 'implementation' AND (verification_requirement NOT IN ('batchable','immediate') OR verification_requirement IS NULL OR verification_purpose IS NOT NULL OR verification_conflict_id IS NOT NULL))"
      + " OR (kind = 'inspection' AND (verification_requirement IS NOT NULL OR verification_purpose IS NOT NULL OR verification_conflict_id IS NOT NULL))"
      + " OR (kind = 'verification' AND (verification_requirement IS NOT NULL OR verification_purpose NOT IN ('normal','conflict_resolution') OR verification_purpose IS NULL"
      + "     OR (verification_purpose = 'normal' AND verification_conflict_id IS NOT NULL)"
      + "     OR (verification_purpose = 'conflict_resolution' AND verification_conflict_id IS NULL)))) LIMIT 1",
    )
    .get() as { id?: string; kind?: string } | undefined;
  if (illegalV2 !== undefined) {
    problems.push(`v2 ${illegalV2.kind} directive '${illegalV2.id}' violates the verification-policy legality matrix`);
  }
  const danglingClaim = db
    .prepare(
      "SELECT c.conflict_id AS id, je.value AS reportId FROM verification_conflicts c, "
      + "json_each(c.claims_json) cj, json_each(cj.value -> '$.sourceReportIds') je "
      + "LEFT JOIN execution_reports r ON r.report_id = je.value "
      + "LEFT JOIN execution_directives d ON d.directive_id = r.directive_id AND d.revision = r.directive_revision "
      + "WHERE r.report_id IS NULL OR r.execution_run_id != c.execution_run_id OR d.window_id IS NOT c.window_id "
      + "OR d.base_candidate_revision IS NOT c.candidate_revision LIMIT 1",
    )
    .get() as { id?: string; reportId?: string } | undefined;
  if (danglingClaim !== undefined) {
    problems.push(`verification conflict '${danglingClaim.id}' claims a foreign or non-current report '${danglingClaim.reportId}'`);
  }
  const resolverDrift = db
    .prepare(
      "SELECT c.conflict_id AS id FROM verification_conflicts c "
      + "LEFT JOIN execution_directives d ON d.directive_id = c.resolution_directive_id AND d.revision = c.resolution_directive_revision "
      + "WHERE c.resolution_directive_id IS NOT NULL "
      + "AND (d.directive_id IS NULL OR d.execution_run_id != c.execution_run_id OR d.window_id != c.window_id OR d.base_candidate_revision != c.candidate_revision "
      + "  OR d.verification_purpose IS NOT 'conflict_resolution' OR d.verification_conflict_id IS NOT c.conflict_id) LIMIT 1",
    )
    .get() as { id?: string } | undefined;
  if (resolverDrift !== undefined) {
    problems.push(`verification conflict '${resolverDrift.id}' carries a mismatched resolver directive binding`);
  }
  const settlementDrift = db
    .prepare(
      "SELECT c.conflict_id AS id FROM verification_conflicts c "
      + "LEFT JOIN execution_reports r ON r.report_id = c.resolution_report_id "
      + "WHERE c.status IN ('resolved','verification_blocked') "
      + "AND (r.report_id IS NULL OR r.execution_run_id != c.execution_run_id OR r.candidate_mutated != 0 OR r.result IS NOT 'completed') LIMIT 1",
    )
    .get() as { id?: string } | undefined;
  if (settlementDrift !== undefined) {
    problems.push(`verification conflict '${settlementDrift.id}' settled on a missing or non-completing resolution report`);
  }

  // ---- v23: execution scope / final closure integrity ----
  for (const [table, column] of FORBIDDEN_BEFORE_V23_COLUMNS) {
    if (!tableHasColumn(db, table, column)) {
      problems.push(`${table} lost the ${column} column`);
    }
  }
  for (const trigger of [
    "execution_runs_completion_insert_shape",
    "execution_runs_completion_shape",
    "execution_runs_terminal_lifecycle",
  ]) {
    if (!objectNames.has(trigger)) {
      problems.push(`constraint trigger ${trigger} missing for schema version >= 23`);
    }
  }
  for (const table of ["verification_windows", "execution_directives", "supervisor_assessments", "execution_commits"]) {
    for (const trigger of [`${table}_scope_insert_shape`, `${table}_scope_update_shape`]) {
      if (!objectNames.has(trigger)) {
        problems.push(`constraint trigger ${trigger} missing for schema version >= 23`);
      }
    }
  }
  const finalWindowDrift = db
    .prepare(
      "SELECT w.id AS id FROM verification_windows w "
      + "LEFT JOIN execution_runs r ON r.execution_run_id = w.execution_run_id "
      + "LEFT JOIN execution_commits c ON c.commit_id = w.base_commit_id "
      + "WHERE w.scope_kind = 'final_closure' "
      + "AND (w.stage_id IS NOT NULL OR w.base_kind != 'execution_commit' OR w.base_commit_id IS NULL "
      + "  OR c.commit_id IS NULL OR c.execution_run_id != w.execution_run_id "
      + "  OR r.execution_run_id IS NULL "
      + "  OR (w.closed_at IS NULL AND (r.lifecycle != 'active' OR w.closure_kind IS NOT NULL)) "
      + "  OR (w.closure_kind = 'accepted' AND (r.lifecycle IS NOT 'completed' OR w.closed_at IS NULL)) "
      + "  OR (w.closure_kind = 'replan_required' AND (r.lifecycle IS NOT 'replan_required' OR w.closed_at IS NULL)) "
      + "  OR (w.closure_kind = 'aborted' AND (r.lifecycle IS NOT 'aborted' OR w.closed_at IS NULL))) LIMIT 1",
    )
    .get() as { id?: string } | undefined;
  if (finalWindowDrift !== undefined) {
    problems.push(`final-closure window '${finalWindowDrift.id}' has a broken base, scope, or closure/lifecycle agreement`);
  }
  const directiveScopeDrift = db
    .prepare(
      "SELECT d.directive_id AS id FROM execution_directives d "
      + "LEFT JOIN verification_windows w ON w.id = d.window_id "
      + "WHERE (d.scope_kind = 'stage' AND (d.stage_id IS NULL OR w.scope_kind != 'stage' OR w.stage_id != d.stage_id)) "
      + "OR (d.scope_kind = 'final_closure' AND (d.stage_id IS NOT NULL OR w.scope_kind != 'final_closure')) LIMIT 1",
    )
    .get() as { id?: string } | undefined;
  if (directiveScopeDrift !== undefined) {
    problems.push(`directive '${directiveScopeDrift.id}' scope disagrees with its window scope`);
  }
  const assessmentScopeDrift = db
    .prepare(
      "SELECT a.assessment_id AS id FROM supervisor_assessments a "
      + "LEFT JOIN verification_windows w ON w.id = a.window_id "
      + "WHERE (a.scope_kind = 'stage' AND (a.stage_id IS NULL OR w.scope_kind != 'stage' OR w.stage_id != a.stage_id)) "
      + "OR (a.scope_kind = 'final_closure' AND (a.stage_id IS NOT NULL OR w.scope_kind != 'final_closure')) LIMIT 1",
    )
    .get() as { id?: string } | undefined;
  if (assessmentScopeDrift !== undefined) {
    problems.push(`assessment '${assessmentScopeDrift.id}' scope disagrees with its window scope`);
  }
  const commitScopeDrift = db
    .prepare(
      "SELECT c.commit_id AS id FROM execution_commits c "
      + "LEFT JOIN verification_windows w ON w.id = c.window_id "
      + "WHERE (c.scope_kind = 'stage' AND (c.stage_id IS NULL OR w.scope_kind != 'stage' OR w.stage_id != c.stage_id)) "
      + "OR (c.scope_kind = 'final_closure' AND (c.stage_id IS NOT NULL OR w.scope_kind != 'final_closure')) LIMIT 1",
    )
    .get() as { id?: string } | undefined;
  if (commitScopeDrift !== undefined) {
    problems.push(`execution commit '${commitScopeDrift.id}' scope disagrees with its window scope`);
  }
  const completedDrift = db
    .prepare(
      "SELECT r.execution_run_id AS id FROM execution_runs r "
      + "LEFT JOIN execution_commits c ON c.commit_id = r.completion_commit_id "
      + "WHERE (r.lifecycle = 'completed') != (r.completion_commit_id IS NOT NULL) "
      + "OR (r.completion_commit_id IS NOT NULL "
      + "  AND (c.commit_id IS NULL OR c.execution_run_id != r.execution_run_id OR c.scope_kind != 'final_closure' "
      + "    OR r.accepted_head_commit_id IS NOT r.completion_commit_id)) "
      + "OR (r.lifecycle = 'completed' AND EXISTS (SELECT 1 FROM verification_windows w WHERE w.execution_run_id = r.execution_run_id AND w.closed_at IS NULL)) "
      + "OR (r.lifecycle = 'completed' AND EXISTS (SELECT 1 FROM execution_stages s WHERE s.execution_run_id = r.execution_run_id AND s.status IN ('active','pending'))) LIMIT 1",
    )
    .get() as { id?: string } | undefined;
  if (completedDrift !== undefined) {
    problems.push(`execution run '${completedDrift.id}' has broken completion provenance or post-completion structure`);
  }
  if (
    (db
      .prepare(
        "SELECT (SELECT count(*) FROM verification_windows WHERE scope_kind NOT IN ('stage','final_closure')) "
        + "+ (SELECT count(*) FROM execution_directives WHERE scope_kind NOT IN ('stage','final_closure')) "
        + "+ (SELECT count(*) FROM supervisor_assessments WHERE scope_kind NOT IN ('stage','final_closure')) "
        + "+ (SELECT count(*) FROM execution_commits WHERE scope_kind NOT IN ('stage','final_closure')) AS n",
      )
      .get() as { n: number }).n > 0
  ) {
    problems.push("execution-scope vocabulary is corrupt");
  }

  // ---- v24: attempt reconciliation integrity (exact-Run scope) ----
  const reconciliationBindingDrift = db
    .prepare(
      "SELECT b.attempt_id AS id FROM execution_attempt_reconciliation_bindings b "
      + "LEFT JOIN execution_attempts a ON a.attempt_id = b.attempt_id "
      + "LEFT JOIN execution_directives d ON d.directive_id = b.directive_id AND d.revision = b.first_directive_revision "
      + "WHERE a.attempt_id IS NULL OR a.state != 'indeterminate' OR a.execution_run_id != b.execution_run_id "
      + "OR d.directive_id IS NULL OR d.execution_run_id != b.execution_run_id OR d.kind != 'inspection' LIMIT 1",
    )
    .get() as { id?: string } | undefined;
  if (reconciliationBindingDrift !== undefined) {
    problems.push(`attempt reconciliation binding '${reconciliationBindingDrift.id}' targets a missing/foreign/non-indeterminate Attempt or a non-inspection Directive`);
  }
  const reconciliationResolutionDrift = db
    .prepare(
      "SELECT r.reconciliation_id AS id FROM execution_attempt_reconciliations r "
      + "LEFT JOIN execution_attempts a ON a.attempt_id = r.attempt_id "
      + "LEFT JOIN execution_directives d ON d.directive_id = r.directive_id AND d.revision = r.directive_revision "
      + "LEFT JOIN execution_reports rep ON rep.report_id = r.inspection_report_id "
      + "WHERE a.attempt_id IS NULL OR a.state != 'indeterminate' OR a.execution_run_id != r.execution_run_id "
      + "OR d.directive_id IS NULL OR d.execution_run_id != r.execution_run_id "
      + "OR (r.inspection_report_id IS NOT NULL AND d.kind != 'inspection') "
      + "OR (r.inspection_report_id IS NULL AND (d.directive_id != a.directive_id OR d.revision != a.directive_revision)) "
      + "OR (r.resolution = 'candidate_changed' AND r.candidate_revision_after != r.candidate_revision_before + 1) "
      + "OR (r.resolution != 'candidate_changed' AND r.candidate_revision_after != r.candidate_revision_before) "
      + "OR (r.resolution = 'no_effect_by_capability' AND r.inspection_report_id IS NOT NULL) "
      + "OR (r.resolution != 'no_effect_by_capability' AND (r.inspection_report_id IS NULL OR rep.report_id IS NULL "
      + "  OR rep.directive_id != r.directive_id OR rep.directive_revision != r.directive_revision "
      + "  OR rep.result != 'completed' OR rep.candidate_mutated != 0)) LIMIT 1",
    )
    .get() as { id?: string } | undefined;
  if (reconciliationResolutionDrift !== undefined) {
    problems.push(`attempt reconciliation '${reconciliationResolutionDrift.id}' has a broken resolution/report/revision-delta shape`);
  }

  // ---- v25: abort provenance (exact-Run one-to-one) ----
  const abortFactDrift = db
    .prepare(
      "SELECT r.execution_run_id AS id FROM execution_runs r "
      + "LEFT JOIN execution_abort_records a ON a.execution_run_id = r.execution_run_id "
      + "WHERE (r.lifecycle = 'aborted' AND a.execution_run_id IS NULL) "
      + "OR (r.lifecycle != 'aborted' AND a.execution_run_id IS NOT NULL) LIMIT 1",
    )
    .get() as { id?: string } | undefined;
  if (abortFactDrift !== undefined) {
    problems.push(`execution run '${abortFactDrift.id}' disagrees with its abort provenance (E13 §58)`);
  }
  const abortAuthDrift = db
    .prepare(
      "SELECT a.execution_run_id AS id FROM execution_abort_records a "
      + "LEFT JOIN run_control_authorizations c ON c.control_id = a.control_id "
      + "WHERE c.control_id IS NULL OR c.operation != 'abort' OR c.execution_run_id != a.execution_run_id LIMIT 1",
    )
    .get() as { id?: string } | undefined;
  if (abortAuthDrift !== undefined) {
    problems.push(`abort record '${abortAuthDrift.id}' references a missing/foreign/non-abort run-control authorization (E13 §59)`);
  }
  const abortedWithCompletion = db
    .prepare(
      "SELECT execution_run_id AS id FROM execution_runs WHERE lifecycle = 'aborted' AND completion_commit_id IS NOT NULL LIMIT 1",
    )
    .get() as { id?: string } | undefined;
  if (abortedWithCompletion !== undefined) {
    problems.push(`aborted execution run '${abortedWithCompletion.id}' carries completion provenance (E13 §58)`);
  }
  const terminalWithOpenWindow = db
    .prepare(
      "SELECT w.execution_run_id AS id FROM verification_windows w "
      + "JOIN execution_runs r ON r.execution_run_id = w.execution_run_id "
      + "WHERE w.closed_at IS NULL AND r.lifecycle != 'active' LIMIT 1",
    )
    .get() as { id?: string } | undefined;
  if (terminalWithOpenWindow !== undefined) {
    problems.push(`terminal execution run '${terminalWithOpenWindow.id}' still owns an open verification window (E13 §19/§58)`);
  }
  const abortedWindowDrift = db
    .prepare(
      "SELECT w.id AS id FROM verification_windows w "
      + "LEFT JOIN execution_runs r ON r.execution_run_id = w.execution_run_id "
      + "LEFT JOIN execution_commits c ON c.window_id = w.id "
      + "WHERE w.closure_kind = 'aborted' "
      + "AND (r.lifecycle IS NOT 'aborted' OR c.commit_id IS NOT NULL OR w.closed_at IS NULL) LIMIT 1",
    )
    .get() as { id?: string } | undefined;
  if (abortedWindowDrift !== undefined) {
    problems.push(`aborted verification window '${abortedWindowDrift.id}' disagrees with its run lifecycle or carries a commit (E13 §19)`);
  }

  // ---- A1-I additions ----

  // A1-I47: no execution-domain table may carry an FK targeting
  // execution_runs(run_id) — execution ownership resolves only through
  // execution_run_id after the re-key.
  const RUN_SCOPED_TABLES = [
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
    "execution_issues",
    "execution_issue_refs",
    "execution_issue_adoptions",
    "run_control_authorizations",
  ];
  for (const table of RUN_SCOPED_TABLES) {
    const foreignKeys = db.prepare(`PRAGMA foreign_key_list('${table}')`).all() as Array<{
      table: string;
      to?: string | null;
    }>;
    for (const foreignKey of foreignKeys) {
      if (foreignKey.table === "execution_runs" && foreignKey.to === "run_id") {
        problems.push(`${table} keeps a foreign key on execution_runs(run_id) — execution ownership must resolve through execution_run_id (A1-I47)`);
      }
    }
  }
  // A1-I1/I4: every execution-scoped child carries its exact-run linkage.
  for (const table of RUN_SCOPED_TABLES) {
    if (!tableHasColumn(db, table, "execution_run_id")) {
      problems.push(`${table} lost the execution_run_id scope column (A1-I4)`);
    }
  }
  // A1-I30/I33: typed control targets — the vocabulary is CHECK-enforced;
  // re-derive that no row mixes shapes (defense in depth) and that a
  // legacy_pre_a1 row never carries typed identifiers.
  const controlShapeDrift = db
    .prepare(
      "SELECT control_id AS id FROM run_control_authorizations WHERE ("
      + "(target_kind = 'planning_run' AND (planning_run_id IS NULL OR execution_run_id IS NOT NULL))"
      + " OR (target_kind = 'execution_run' AND (execution_run_id IS NULL OR planning_run_id IS NOT NULL))"
      + " OR (target_kind = 'final_plan_execution' AND (resulting_execution_run_id IS NULL OR execution_run_id IS NOT NULL))"
      + " OR (target_kind = 'legacy_pre_a1' AND (planning_run_id IS NOT NULL OR execution_run_id IS NOT NULL))) LIMIT 1",
    )
    .get() as { id?: string } | undefined;
  if (controlShapeDrift !== undefined) {
    problems.push(`run control authorization '${controlShapeDrift.id}' violates its typed target shape (A1 §49)`);
  }
  // A1 §20: the directives table is v4-capable from v26.
  const directiveColumns = db.prepare("PRAGMA table_info('execution_directives')").all() as Array<{ name: string }>;
  for (const column of ["execution_run_id", "run_id", "protocol_version"]) {
    if (!directiveColumns.some((candidate) => candidate.name === column)) {
      problems.push(`execution_directives lost the ${column} column (A1 §16)`);
    }
  }
  const badProtocol = db
    .prepare("SELECT count(*) AS n FROM execution_directives WHERE protocol_version NOT IN (1, 2, 3, 4)")
    .get() as { n: number };
  if (badProtocol.n > 0) {
    problems.push("execution_directives contains unknown protocol versions");
  }
  // Anti-fiction: A1-I adds no reexecution machinery.
  for (const forbidden of ["execution_reexecution_requests", "final_plan_execution_authorizations", "execution_run_clones"]) {
    if (objectNames.has(forbidden)) {
      problems.push(`fabricated A1-II object '${forbidden}' exists`);
    }
  }
}

/**
 * Validate full schema state. For version 0 the store may legitimately have
 * no tables at all (fresh or legacy pre-store database); for version N >= 1
 * the migration history must contain exactly rows 1..N and store_metadata
 * must exist as a singleton. From version 2 the infrastructure-table
 * integrity checks apply as well; from version 4 the structural Plan Memory
 * checks apply; from version 5 the Proposal/Approval/PlanCommit structural
 * checks apply; from version 6 the Observation/Evidence structural checks
 * apply; from version 7 the Evidence freshness structural checks apply;
 * from version 8 the Section workflow structural checks apply.
 */
export function inspectSchemaState(db: StoreConnection | StoreTx): SchemaState {
  const version = readSchemaVersion(db);
  // Beyond-support fence: a store newer than this binary must be reported by
  // version alone (callers refuse it as STORE_SCHEMA_TOO_NEW before ever
  // consulting consistency). Running the per-version validators here would
  // probe objects a genuinely newer schema need not have and crash on the
  // first missing one instead of yielding the contract error.
  if (version > SUPPORTED_SCHEMA_VERSION) {
    return {
      version,
      history: [],
      consistent: false,
      problems: [`store schema ${version} is newer than the supported schema ${SUPPORTED_SCHEMA_VERSION}`],
    };
  }
  const tables = tableNames(db);
  const problems: string[] = [];
  let history: MigrationHistoryRow[] = [];

  if (version >= 1) {
    if (!tables.has("schema_migrations")) {
      problems.push("schema_migrations table missing for schema version >= 1");
    } else {
      history = readHistory(db);
      const versions = history.map((row) => row.version).sort((a, b) => a - b);
      const expected = Array.from({ length: version }, (_, i) => i + 1);
      if (versions.length !== expected.length || versions.some((v, i) => v !== expected[i])) {
        problems.push(
          `migration history [${versions.join(",")}] does not match user_version ${version}`,
        );
      }
    }
    if (!tables.has("store_metadata")) {
      problems.push("store_metadata table missing for schema version >= 1");
    }
  }
  if (version >= 2) {
    validateSchemaV2(db, tables, problems);
  }
  if (version >= 3) {
    validateSchemaV3(db, tables, problems);
  }
  if (version >= 4) {
    validateSchemaV4(db, problems);
  }
  if (version >= 5) {
    validateSchemaV5(db, problems);
  }
  if (version >= 6) {
    validateSchemaV6(db, problems);
  }
  if (version >= 7) {
    validateSchemaV7(db, problems);
  }
  if (version >= 8) {
    validateSchemaV8(db, version, problems);
  }
  if (version >= 9) {
    validateSchemaV9(db, problems);
  }
  if (version >= 10) {
    validateSchemaV10(db, problems);
  }
  if (version >= 11) {
    validateSchemaV11(db, problems);
  }
  if (version >= 12) {
    validateSchemaV12(db, problems);
  }
  if (version >= 13) {
    validateSchemaV13(db, problems);
  }
  // A1-I — the execution-era validators below are written against the v25
  // physical identity (run_id columns). From schema 26 the execution domain is
  // execution_run_id-scoped, so they apply only up to v25 and the re-keyed
  // validateSchemaV26 carries every invariant forward (plus the A1 additions).
  if (version >= 14 && version <= 25) {
    validateSchemaV14(db, problems);
  }
  if (version >= 15 && version <= 25) {
    validateSchemaV15(db, problems);
  }
  if (version >= 16 && version <= 25) {
    validateSchemaV16(db, problems);
  }
  if (version >= 17 && version <= 25) {
    validateSchemaV17(db, problems);
  }
  if (version >= 18 && version <= 25) {
    validateSchemaV18(db, problems);
  }
  if (version >= 19 && version <= 25) {
    validateSchemaV19(db, problems);
  }
  if (version >= 20 && version <= 25) {
    validateSchemaV20(db, problems);
  }
  if (version >= 21 && version <= 25) {
    validateSchemaV21(db, problems);
  }
  if (version >= 23 && version <= 25) {
    validateSchemaV23(db, problems);
  }
  if (version >= 24 && version <= 25) {
    validateSchemaV24(db, problems);
  }
  if (version >= 25 && version <= 25) {
    validateSchemaV25(db, problems);
  }
  if (version >= 26) {
    validateSchemaV26(db, problems);
  }
  // E4 §2/§43 + E5 §45 anti-fiction pin — the acceptance objects are
  // fabricated until schema 19 owns them (E6 §55).
  if (version >= 14 && version < 19) {
    const preNineteenObjects = tableNames(db);
    for (const forbidden of FORBIDDEN_BEFORE_V19_OBJECTS) {
      if (preNineteenObjects.has(forbidden)) {
        problems.push(`fabricated execution-progress object '${forbidden}' exists before its owning phase`);
      }
    }
  }
  // E7 §42/§43 anti-fiction pin — the Stage-completion provenance column is
  // fabricated until schema 20 owns it (no pre-E7 path could complete a Stage).
  if (version >= 19 && version < 20) {
    const stageColumns = db.prepare("PRAGMA table_info('execution_stages')").all() as Array<{ name: string }>;
    for (const [table, column] of FORBIDDEN_BEFORE_V20_COLUMNS) {
      if (table === "execution_stages" && stageColumns.some((candidate) => candidate.name === column)) {
        problems.push(`fabricated stage-completion column '${table}.${column}' exists before its owning phase`);
      }
    }
  }
  // E8 §45 anti-fiction pin — the conflict object is fabricated until schema
  // 21 owns it.
  if (version >= 20 && version < 21) {
    const preTwentyOneObjects = tableNames(db);
    for (const forbidden of FORBIDDEN_BEFORE_V21_OBJECTS) {
      if (preTwentyOneObjects.has(forbidden)) {
        problems.push(`fabricated verification-conflict object '${forbidden}' exists before its owning phase`);
      }
    }
  }
  // E10 §61 anti-fiction pin — the execution-scope columns and the terminal
  // completion provenance are fabricated until schema 23 owns them.
  if (version >= 21 && version < 23) {
    for (const [table, column] of FORBIDDEN_BEFORE_V23_COLUMNS) {
      if (tableHasColumn(db, table, column)) {
        problems.push(`fabricated execution-scope column '${table}.${column}' exists before its owning phase`);
      }
    }
  }
  // E11 §51 anti-fiction pin — the reconciliation objects are fabricated until
  // schema 24 owns them.
  if (version >= 23 && version < 24) {
    const preTwentyFourTables = tableNames(db);
    for (const forbidden of FORBIDDEN_BEFORE_V24_TABLES) {
      if (preTwentyFourTables.has(forbidden)) {
        problems.push(`fabricated attempt-reconciliation object '${forbidden}' exists before its owning phase`);
      }
    }
  }

  return { version, history, consistent: problems.length === 0, problems };
}

/** Throwing variant used on write/open paths. */
export function assertSchemaState(db: StoreConnection | StoreTx, databasePath: string): SchemaState {
  const state = inspectSchemaState(db);
  if (!state.consistent) {
    throw storeError("STORE_SCHEMA_INVALID", "Plan Store schema state is inconsistent", {
      cause: state.problems.join("; "),
      detail: {
        detected: state.version,
        path: databasePath,
        problems: [...state.problems],
      },
    });
  }
  return state;
}
