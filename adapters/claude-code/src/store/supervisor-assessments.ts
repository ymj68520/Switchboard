/**
 * SupervisorAssessment persistence (v0.2.0 E6 §4–§11/§41).
 *
 * Assessments and their per-Report judgments are APPEND-ONLY execution memory
 * (migration 019): no_update/no_delete triggers make every persisted judgment
 * permanent history, so a changed Supervisor judgment is a NEW assessment row
 * and historical assessments stay queryable (E6 §5/§45). Multiple non-accept
 * assessments may coexist for the same Window + candidateRevision; the UNIQUE
 * window/assessment linkage on execution_commits lets at most one accept
 * assessment ever gate a commit (E6 §28).
 *
 * The only production caller of the insert primitive is the application
 * acceptance service (the E6 §21 gate inside the supervisor-authority fence).
 * Model code never writes assessment rows directly — there is deliberately no
 * set_assessment_disposition surface (E6 §51).
 */

import {
  parseReportJudgmentRow,
  parseSupervisorAssessmentRow,
  type AssessmentReportJudgmentRow,
  type ReportJudgment,
  type SupervisorAssessment,
} from "../core/supervisor-assessment.js";
import { RuntimeError } from "../runtime/errors.js";
import type { StoreTx } from "./transaction.js";

const ASSESSMENT_COLUMNS =
  "assessment_id AS assessmentId, execution_run_id AS executionRunId, scope_kind AS scopeKind, stage_id AS stageId, window_id AS windowId, "
  + "candidate_revision AS candidateRevision, disposition, "
  + "supervisor_session_id AS supervisorSessionId, supervisor_generation AS supervisorGeneration, "
  + "plan_refs_json AS planRefs, covered_obligations_json AS coveredObligations, "
  + "rationale, created_at AS createdAt";

function parseJsonField(raw: Record<string, unknown>, field: string): unknown {
  try {
    return JSON.parse(String(raw[field]));
  } catch {
    throw new RuntimeError("STORE_SCHEMA_INVALID", "supervisor_assessments row is corrupt", {
      detail: { fields: [field] },
    });
  }
}

/** Reassemble the canonical row shape parseSupervisorAssessmentRow expects. */
function mapAssessmentRow(raw: Record<string, unknown>): SupervisorAssessment {
  const row: Record<string, unknown> = { ...raw };
  row.planRefs = parseJsonField(raw, "planRefs");
  row.coveredObligations = parseJsonField(raw, "coveredObligations");
  return parseSupervisorAssessmentRow(row);
}

export function getSupervisorAssessmentInTx(tx: StoreTx, assessmentId: string): SupervisorAssessment | null {
  const raw = tx
    .prepare(`SELECT ${ASSESSMENT_COLUMNS} FROM supervisor_assessments WHERE assessment_id = ?`)
    .get(assessmentId) as Record<string, unknown> | undefined;
  return raw === undefined ? null : mapAssessmentRow(raw);
}

/** Every assessment of one Window, protocol order (oldest first, E6 §5). */
export function listWindowAssessmentsInTx(tx: StoreTx, windowId: string): SupervisorAssessment[] {
  return (tx
    .prepare(
      `SELECT ${ASSESSMENT_COLUMNS} FROM supervisor_assessments WHERE window_id = ? ORDER BY created_at, assessment_id`,
    )
    .all(windowId) as Record<string, unknown>[]).map(mapAssessmentRow);
}

/** Every assessment of one run, newest first (recovery/context projections). */
export function listRunAssessmentsInTx(tx: StoreTx, executionRunId: string): SupervisorAssessment[] {
  return (tx
    .prepare(
      `SELECT ${ASSESSMENT_COLUMNS} FROM supervisor_assessments WHERE execution_run_id = ? ORDER BY created_at DESC, assessment_id DESC`,
    )
    .all(executionRunId) as Record<string, unknown>[]).map(mapAssessmentRow);
}

export function listJudgmentsForAssessmentInTx(tx: StoreTx, assessmentId: string): AssessmentReportJudgmentRow[] {
  return (tx
    .prepare(
      "SELECT assessment_id AS assessmentId, report_id AS reportId, disposition, "
      + "superseded_by_report_id AS supersededByReportId, rationale "
      + "FROM supervisor_assessment_report_judgments WHERE assessment_id = ? ORDER BY report_id",
    )
    .all(assessmentId) as Record<string, unknown>[]).map(parseReportJudgmentRow);
}

/**
 * Persist the immutable assessment + its judgment rows inside the caller's
 * transaction (E6 §21). The DDL triggers make the write permanent history.
 */
export function insertSupervisorAssessmentInTx(
  tx: StoreTx,
  input: { assessment: SupervisorAssessment; judgments: ReportJudgment[] },
): void {
  const a = input.assessment;
  tx.prepare(
    `INSERT INTO supervisor_assessments (
       assessment_id, execution_run_id, scope_kind, stage_id, window_id, candidate_revision, disposition,
       supervisor_session_id, supervisor_generation, plan_refs_json, covered_obligations_json,
       rationale, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    a.assessmentId,
    a.executionRunId,
    a.stageId === null ? "final_closure" : "stage",
    a.stageId,
    a.windowId,
    a.candidateRevision,
    a.disposition,
    a.supervisorSessionId,
    a.supervisorGeneration,
    JSON.stringify(a.planRefs),
    JSON.stringify(a.coveredObligations),
    a.rationale,
    a.createdAt,
  );
  for (const judgment of input.judgments) {
    tx.prepare(
      `INSERT INTO supervisor_assessment_report_judgments (
         assessment_id, report_id, disposition, superseded_by_report_id, rationale
       ) VALUES (?, ?, ?, ?, ?)`,
    ).run(
      a.assessmentId,
      judgment.reportId,
      judgment.disposition,
      judgment.supersededByReportId ?? null,
      judgment.rationale ?? null,
    );
  }
}

/** Append one acceptance event inside the caller's transaction (Core-owned seq). */
export function insertAcceptanceEventInTx(
  tx: StoreTx,
  input: {
    executionRunId: string;
    eventType: "ASSESSMENT_RECORDED" | "EXECUTION_COMMIT_CREATED";
    assessmentId?: string;
    commitId?: string;
  },
  now: string,
): void {
  const head = tx
    .prepare("SELECT MAX(event_seq) AS seq FROM execution_acceptance_events WHERE execution_run_id = ?")
    .get(input.executionRunId) as { seq: number | null };
  tx.prepare(
    "INSERT INTO execution_acceptance_events (execution_run_id, event_seq, event_type, assessment_id, commit_id, created_at) "
    + "VALUES (?, ?, ?, ?, ?, ?)",
  ).run(input.executionRunId, (head.seq ?? 0) + 1, input.eventType, input.assessmentId ?? null, input.commitId ?? null, now);
}

export interface AcceptanceEventRow {
  eventType: string;
  assessmentId: string | null;
  commitId: string | null;
  createdAt: string;
}

export function listAcceptanceEventsInTx(tx: StoreTx, executionRunId: string): AcceptanceEventRow[] {
  return tx
    .prepare(
      "SELECT event_type AS eventType, assessment_id AS assessmentId, commit_id AS commitId, created_at AS createdAt "
      + "FROM execution_acceptance_events WHERE execution_run_id = ? ORDER BY event_seq",
    )
    .all(executionRunId) as AcceptanceEventRow[];
}
