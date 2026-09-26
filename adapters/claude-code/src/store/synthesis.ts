/**
 * Synthesis / Semantic Validation persistence (Phase 12 §11/§13–§14/§35–§36/§46).
 *
 * Every row in this domain is immutable history: the DDL no_update/no_delete
 * triggers enforce it, and the UNIQUE constraints encode the cardinality laws
 * — at most one accepted manifest per frozen input (§45) and at most one
 * accepted report per manifest (§58). Idempotency operation identities
 * (`synthesis:<toolUseId>` / `validation:<toolUseId>`) are UNIQUE per run.
 *
 * The single production callers of the write primitives are the application
 * synthesis service and the plan-commit engine's DETAIL_COMPLETE hook.
 */

import type { PlanStore } from "./sqlite-store.js";
import type { StoreTx } from "./transaction.js";

export interface SynthesisInputRow {
  runId: string;
  inputSeq: number;
  inputId: string;
  baseRunRevision: number;
  baseHeadSnapshotId: string;
  baseHeadCommitId: string | null;
  canonicalJson: string;
  inputHash: string;
  createdAt: string;
}

export interface SynthesisInputRefRow {
  kind: string;
  artifactId: string;
  revision: number;
}

export interface SynthesisInputEvidenceRow {
  evidenceId: string;
  evidenceRevision: number;
  confidence: string;
  criticality: string;
  validationStrategy: string;
  frozenState: string;
  frozenLastEventSeq: number;
}

/** Insert one frozen synthesis input with its exact ref families (§14). */
export function insertSynthesisInputInTx(
  tx: StoreTx,
  input: SynthesisInputRow & {
    refs: SynthesisInputRefRow[];
    evidence: SynthesisInputEvidenceRow[];
  },
): void {
  tx.prepare(
    `INSERT INTO synthesis_inputs (
       run_id, input_seq, input_id, base_run_revision, base_head_snapshot_id,
       base_head_commit_id, canonical_json, input_hash, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.runId,
    input.inputSeq,
    input.inputId,
    input.baseRunRevision,
    input.baseHeadSnapshotId,
    input.baseHeadCommitId,
    input.canonicalJson,
    input.inputHash,
    input.createdAt,
  );
  input.refs.forEach((ref, index) => {
    tx.prepare(
      `INSERT INTO synthesis_input_refs (run_id, input_id, position, kind, artifact_id, revision)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(input.runId, input.inputId, index + 1, ref.kind, ref.artifactId, ref.revision);
  });
  input.evidence.forEach((evidence, index) => {
    tx.prepare(
      `INSERT INTO synthesis_input_evidence (
         run_id, input_id, position, evidence_id, evidence_revision,
         confidence, criticality, validation_strategy, frozen_state, frozen_last_event_seq
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.runId,
      input.inputId,
      index + 1,
      evidence.evidenceId,
      evidence.evidenceRevision,
      evidence.confidence,
      evidence.criticality,
      evidence.validationStrategy,
      evidence.frozenState,
      evidence.frozenLastEventSeq,
    );
  });
}

const INPUT_COLUMNS =
  "run_id AS runId, input_seq AS inputSeq, input_id AS inputId, base_run_revision AS baseRunRevision, "
  + "base_head_snapshot_id AS baseHeadSnapshotId, base_head_commit_id AS baseHeadCommitId, "
  + "canonical_json AS canonicalJson, input_hash AS inputHash, created_at AS createdAt";

interface InputDbRow {
  runId: string;
  inputSeq: number;
  inputId: string;
  baseRunRevision: number;
  baseHeadSnapshotId: string;
  baseHeadCommitId: string | null;
  canonicalJson: string;
  inputHash: string;
  createdAt: string;
}

export function getSynthesisInputInTx(tx: StoreTx, runId: string, inputId: string): SynthesisInputRow | null {
  const row = tx
    .prepare(`SELECT ${INPUT_COLUMNS} FROM synthesis_inputs WHERE run_id = ? AND input_id = ?`)
    .get(runId, inputId) as InputDbRow | undefined;
  return row ?? null;
}

/** The run's newest synthesis input (highest input_seq), or null. */
export function getLatestSynthesisInputInTx(tx: StoreTx, runId: string): SynthesisInputRow | null {
  const row = tx
    .prepare(`SELECT ${INPUT_COLUMNS} FROM synthesis_inputs WHERE run_id = ? ORDER BY input_seq DESC LIMIT 1`)
    .get(runId) as InputDbRow | undefined;
  return row ?? null;
}

export function nextSynthesisInputSeqInTx(tx: StoreTx, runId: string): number {
  const row = tx
    .prepare("SELECT COALESCE(MAX(input_seq), 0) + 1 AS seq FROM synthesis_inputs WHERE run_id = ?")
    .get(runId) as { seq: number };
  return row.seq;
}

export function listSynthesisInputRefsInTx(tx: StoreTx, runId: string, inputId: string): SynthesisInputRefRow[] {
  return tx
    .prepare(
      "SELECT kind, artifact_id AS artifactId, revision FROM synthesis_input_refs "
      + "WHERE run_id = ? AND input_id = ? ORDER BY position",
    )
    .all(runId, inputId) as SynthesisInputRefRow[];
}

export function listSynthesisInputEvidenceInTx(
  tx: StoreTx,
  runId: string,
  inputId: string,
): SynthesisInputEvidenceRow[] {
  return tx
    .prepare(
      "SELECT evidence_id AS evidenceId, evidence_revision AS evidenceRevision, confidence, criticality, "
      + "validation_strategy AS validationStrategy, frozen_state AS frozenState, frozen_last_event_seq AS frozenLastEventSeq "
      + "FROM synthesis_input_evidence WHERE run_id = ? AND input_id = ? ORDER BY position",
    )
    .all(runId, inputId) as SynthesisInputEvidenceRow[];
}

// ---------------------------------------------------------------------------
// Manifests
// ---------------------------------------------------------------------------

export interface SynthesisManifestRow {
  runId: string;
  manifestId: string;
  inputId: string;
  inputHash: string;
  canonicalJson: string;
  manifestHash: string;
  requestId: string;
  createdAt: string;
}

export function insertSynthesisManifestInTx(
  tx: StoreTx,
  manifest: SynthesisManifestRow,
  refs: SynthesisInputRefRow[],
): void {
  tx.prepare(
    `INSERT INTO synthesis_manifests (
       run_id, manifest_id, input_id, input_hash, canonical_json, manifest_hash, request_id, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    manifest.runId,
    manifest.manifestId,
    manifest.inputId,
    manifest.inputHash,
    manifest.canonicalJson,
    manifest.manifestHash,
    manifest.requestId,
    manifest.createdAt,
  );
  refs.forEach((ref, index) => {
    tx.prepare(
      `INSERT INTO synthesis_manifest_refs (run_id, manifest_id, position, kind, artifact_id, revision)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(manifest.runId, manifest.manifestId, index + 1, ref.kind, ref.artifactId, ref.revision);
  });
}

const MANIFEST_COLUMNS =
  "run_id AS runId, manifest_id AS manifestId, input_id AS inputId, input_hash AS inputHash, "
  + "canonical_json AS canonicalJson, manifest_hash AS manifestHash, request_id AS requestId, created_at AS createdAt";

interface ManifestDbRow {
  runId: string;
  manifestId: string;
  inputId: string;
  inputHash: string;
  canonicalJson: string;
  manifestHash: string;
  requestId: string;
  createdAt: string;
}

export function getSynthesisManifestByRequestInTx(tx: StoreTx, runId: string, requestId: string): SynthesisManifestRow | null {
  const row = tx
    .prepare(`SELECT ${MANIFEST_COLUMNS} FROM synthesis_manifests WHERE run_id = ? AND request_id = ?`)
    .get(runId, requestId) as ManifestDbRow | undefined;
  return row ?? null;
}

export function getSynthesisManifestByInputInTx(tx: StoreTx, runId: string, inputId: string): SynthesisManifestRow | null {
  const row = tx
    .prepare(`SELECT ${MANIFEST_COLUMNS} FROM synthesis_manifests WHERE run_id = ? AND input_id = ?`)
    .get(runId, inputId) as ManifestDbRow | undefined;
  return row ?? null;
}

export function getSynthesisManifestInTx(tx: StoreTx, runId: string, manifestId: string): SynthesisManifestRow | null {
  const row = tx
    .prepare(`SELECT ${MANIFEST_COLUMNS} FROM synthesis_manifests WHERE run_id = ? AND manifest_id = ?`)
    .get(runId, manifestId) as ManifestDbRow | undefined;
  return row ?? null;
}

export function listSynthesisManifestRefsInTx(tx: StoreTx, runId: string, manifestId: string): SynthesisInputRefRow[] {
  return tx
    .prepare(
      "SELECT kind, artifact_id AS artifactId, revision FROM synthesis_manifest_refs "
      + "WHERE run_id = ? AND manifest_id = ? ORDER BY position",
    )
    .all(runId, manifestId) as SynthesisInputRefRow[];
}

// ---------------------------------------------------------------------------
// Validation reports
// ---------------------------------------------------------------------------

export interface ValidationReportRow {
  runId: string;
  reportId: string;
  manifestId: string;
  inputId: string;
  inputHash: string;
  manifestHash: string;
  isClean: boolean;
  canonicalJson: string;
  reportHash: string;
  validatorAgentJson: string;
  requestId: string;
  createdAt: string;
}

export interface ValidationFindingRow {
  findingSeq: number;
  findingId: string;
  kind: string;
  summary: string;
  detail: string;
  subjectRefsJson: string;
  supportingRefsJson: string;
}

export function insertValidationReportInTx(
  tx: StoreTx,
  report: ValidationReportRow,
  findings: Array<Omit<ValidationFindingRow, "findingSeq"> & { findingId: string }>,
): void {
  tx.prepare(
    `INSERT INTO semantic_validation_reports (
       run_id, report_id, manifest_id, input_id, input_hash, manifest_hash,
       is_clean, canonical_json, report_hash, validator_agent_json, request_id, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    report.runId,
    report.reportId,
    report.manifestId,
    report.inputId,
    report.inputHash,
    report.manifestHash,
    report.isClean ? 1 : 0,
    report.canonicalJson,
    report.reportHash,
    report.validatorAgentJson,
    report.requestId,
    report.createdAt,
  );
  findings.forEach((finding, index) => {
    tx.prepare(
      `INSERT INTO semantic_validation_findings (
         run_id, report_id, finding_seq, finding_id, kind, summary, detail,
         subject_refs_json, supporting_refs_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      report.runId,
      report.reportId,
      index + 1,
      finding.findingId,
      finding.kind,
      finding.summary,
      finding.detail,
      finding.subjectRefsJson,
      finding.supportingRefsJson,
      report.createdAt,
    );
  });
}

const REPORT_COLUMNS =
  "run_id AS runId, report_id AS reportId, manifest_id AS manifestId, input_id AS inputId, "
  + "input_hash AS inputHash, manifest_hash AS manifestHash, is_clean AS isCleanRaw, "
  + "canonical_json AS canonicalJson, report_hash AS reportHash, "
  + "validator_agent_json AS validatorAgentJson, request_id AS requestId, created_at AS createdAt";

interface ReportDbRow {
  runId: string;
  reportId: string;
  manifestId: string;
  inputId: string;
  inputHash: string;
  manifestHash: string;
  isCleanRaw: number;
  canonicalJson: string;
  reportHash: string;
  validatorAgentJson: string;
  requestId: string;
  createdAt: string;
}

function reportFromRow(row: ReportDbRow): ValidationReportRow {
  return { ...row, isClean: row.isCleanRaw === 1 };
}

export function getValidationReportByRequestInTx(tx: StoreTx, runId: string, requestId: string): ValidationReportRow | null {
  const row = tx
    .prepare(`SELECT ${REPORT_COLUMNS} FROM semantic_validation_reports WHERE run_id = ? AND request_id = ?`)
    .get(runId, requestId) as ReportDbRow | undefined;
  return row === undefined ? null : reportFromRow(row);
}

export function getValidationReportByManifestInTx(tx: StoreTx, runId: string, manifestId: string): ValidationReportRow | null {
  const row = tx
    .prepare(`SELECT ${REPORT_COLUMNS} FROM semantic_validation_reports WHERE run_id = ? AND manifest_id = ?`)
    .get(runId, manifestId) as ReportDbRow | undefined;
  return row === undefined ? null : reportFromRow(row);
}

/** The run's newest report, ordered by its input's cycle seq (§69 — never created_at). */
export function getLatestValidationReportInTx(tx: StoreTx, runId: string): ValidationReportRow | null {
  const row = tx
    .prepare(
      "SELECT r.run_id AS runId, r.report_id AS reportId, r.manifest_id AS manifestId, r.input_id AS inputId, "
      + "r.input_hash AS inputHash, r.manifest_hash AS manifestHash, r.is_clean AS isCleanRaw, "
      + "r.canonical_json AS canonicalJson, r.report_hash AS reportHash, "
      + "r.validator_agent_json AS validatorAgentJson, r.request_id AS requestId, r.created_at AS createdAt "
      + "FROM semantic_validation_reports r "
      + "JOIN synthesis_manifests m ON m.run_id = r.run_id AND m.manifest_id = r.manifest_id "
      + "JOIN synthesis_inputs i ON i.run_id = m.run_id AND i.input_id = m.input_id "
      + "WHERE r.run_id = ? ORDER BY i.input_seq DESC LIMIT 1",
    )
    .get(runId) as ReportDbRow | undefined;
  return row === undefined ? null : reportFromRow(row);
}

export function listValidationFindingsInTx(tx: StoreTx, runId: string, reportId: string): ValidationFindingRow[] {
  return tx
    .prepare(
      "SELECT finding_seq AS findingSeq, finding_id AS findingId, kind, summary, detail, "
      + "subject_refs_json AS subjectRefsJson, supporting_refs_json AS supportingRefsJson "
      + "FROM semantic_validation_findings WHERE run_id = ? AND report_id = ? ORDER BY finding_seq",
    )
    .all(runId, reportId) as ValidationFindingRow[];
}

export function getLatestValidationReport(store: PlanStore, runId: string): ValidationReportRow | null {
  return store.withRead((tx) => getLatestValidationReportInTx(tx, runId));
}

// ---------------------------------------------------------------------------
// §21 Evidence reachability seeds
// ---------------------------------------------------------------------------

/** Every commit's exact proposal binding, in commit order (§21 rule 1). */
export function listRunCommitProposalsInTx(
  tx: StoreTx,
  runId: string,
): Array<{ commitId: string; sequence: number; proposalId: string; proposalRevision: number }> {
  return tx
    .prepare(
      "SELECT commit_id AS commitId, sequence, proposal_id AS proposalId, proposal_revision AS proposalRevision "
      + "FROM plan_commits WHERE run_id = ? ORDER BY sequence",
    )
    .all(runId) as Array<{ commitId: string; sequence: number; proposalId: string; proposalRevision: number }>;
}

/** Exact upstream Evidence revisions of one derived revision (§21 closure). */
export function listEvidenceUpstreamInTx(
  tx: StoreTx,
  runId: string,
  evidenceId: string,
  revision: number,
): Array<{ evidenceId: string; revision: number }> {
  return tx
    .prepare(
      "SELECT derived_from_evidence_id AS evidenceId, derived_from_revision AS revision "
      + "FROM evidence_derived_refs WHERE run_id = ? AND evidence_id = ? AND revision = ? "
      + "ORDER BY derived_from_evidence_id, derived_from_revision",
    )
    .all(runId, evidenceId, revision) as Array<{ evidenceId: string; revision: number }>;
}
