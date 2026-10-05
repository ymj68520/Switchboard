/**
 * ExecutionReport persistence (v0.2.0 E4 §23–§25).
 *
 * ONE immutable unified report per Attempt (UNIQUE(attempt_id), migration 017).
 * The no-update/no-delete triggers make a persisted Report permanent history —
 * no edit/append/replace path exists at any layer (E4 §24). Reports NEVER
 * create accepted execution progress: no acceptedHead, no commit row, no
 * window close (E4 §1/§26) — the only state a report may move is the Attempt
 * (running → reported) and, when candidateMutated is factual, the Window
 * candidateRevision (via the E3 CAS primitive, in the caller's transaction).
 */

import { parseExecutionReportRow, type ExecutionReport } from "../core/execution-report.js";
import { RuntimeError } from "../runtime/errors.js";
import type { StoreTx } from "./transaction.js";

const REPORT_COLUMNS =
  "report_id AS reportId, execution_run_id AS executionRunId, attempt_id AS attemptId, "
  + "directive_id AS directiveId, directive_revision AS directiveRevision, directive_hash AS directiveHash, "
  + "worker_role AS workerRole, result, candidate_mutated AS candidateMutatedRaw, "
  + "actions_json AS actionPerformedJson, files_examined_json AS filesExaminedJson, "
  + "files_changed_json AS filesChangedJson, commands_json AS commandsRunJson, tests_json AS testsRunJson, "
  + "findings_json AS findingsJson, deviations_json AS deviationsJson, "
  + "blockers_json AS blockersJson, deliverables_json AS deliverablesJson, created_at AS createdAt";

function parseJsonField(raw: Record<string, unknown>, field: string): unknown {
  try {
    return JSON.parse(String(raw[field]));
  } catch {
    throw new RuntimeError("STORE_SCHEMA_INVALID", "execution_reports row is corrupt", {
      detail: { fields: [field] },
    });
  }
}

export function mapReportRow(raw: Record<string, unknown>): ExecutionReport {
  const row: Record<string, unknown> = { ...raw };
  row.candidateMutated = raw.candidateMutatedRaw === 1 || raw.candidateMutatedRaw === true;
  row.actionPerformed = parseJsonField(raw, "actionPerformedJson");
  row.filesExamined = parseJsonField(raw, "filesExaminedJson");
  row.filesChanged = parseJsonField(raw, "filesChangedJson");
  row.commandsRun = parseJsonField(raw, "commandsRunJson");
  row.testsRun = parseJsonField(raw, "testsRunJson");
  row.findings = parseJsonField(raw, "findingsJson");
  row.deviations = parseJsonField(raw, "deviationsJson");
  row.blockers = parseJsonField(raw, "blockersJson");
  row.deliverables = parseJsonField(raw, "deliverablesJson");
  return parseExecutionReportRow(row);
}

export function getExecutionReportInTx(tx: StoreTx, reportId: string): ExecutionReport | null {
  const raw = tx
    .prepare(`SELECT ${REPORT_COLUMNS} FROM execution_reports WHERE report_id = ?`)
    .get(reportId) as Record<string, unknown> | undefined;
  return raw === undefined ? null : mapReportRow(raw);
}

/** The ONE report of an Attempt (null when the attempt has not reported). */
export function getReportForAttemptInTx(tx: StoreTx, attemptId: string): ExecutionReport | null {
  const raw = tx
    .prepare(`SELECT ${REPORT_COLUMNS} FROM execution_reports WHERE attempt_id = ?`)
    .get(attemptId) as Record<string, unknown> | undefined;
  return raw === undefined ? null : mapReportRow(raw);
}

/**
 * Persist the immutable Report. Uniqueness (one per Attempt) is DDL-enforced;
 * the caller owns the full submission protocol (binding checks, contract
 * validation, the atomic attempt transition and candidate-revision advance) —
 * this primitive only writes the row.
 */
export function insertExecutionReportInTx(tx: StoreTx, report: ExecutionReport): void {
  tx.prepare(
    `INSERT INTO execution_reports (
       report_id, execution_run_id, attempt_id, directive_id, directive_revision, directive_hash,
       worker_role, result, candidate_mutated,
       actions_json, files_examined_json, files_changed_json, commands_json, tests_json,
       findings_json, deviations_json, blockers_json, deliverables_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    report.reportId,
    report.executionRunId,
    report.attemptId,
    report.directiveId,
    report.directiveRevision,
    report.directiveHash,
    report.workerRole,
    report.result,
    report.candidateMutated ? 1 : 0,
    JSON.stringify(report.actionPerformed),
    JSON.stringify(report.filesExamined),
    JSON.stringify(report.filesChanged),
    JSON.stringify(report.commandsRun),
    JSON.stringify(report.testsRun),
    JSON.stringify(report.findings),
    JSON.stringify(report.deviations),
    JSON.stringify(report.blockers),
    JSON.stringify(report.deliverables),
    report.createdAt,
  );
}
