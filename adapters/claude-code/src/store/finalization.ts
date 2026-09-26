/**
 * Finalization / Final Plan persistence (Phase 13 §4/§6/§30/§37/§52).
 *
 * Every row in this domain is immutable history: the DDL no_update/no_delete
 * triggers enforce it, and the UNIQUE constraints encode the cardinality laws
 * — at most one candidate per finalization request (§72), at most one
 * approved FinalPlan per run in v0.1 (§52). The single production callers of
 * the write primitives are the application finalization service and the plan
 * commit engine's final authorization path.
 */

import type { StoreTx } from "./transaction.js";

// ---------------------------------------------------------------------------
// Evidence audit snapshots (§6)
// ---------------------------------------------------------------------------

export type EvidenceAuditPurpose = "pre_approval" | "commit_time";

export interface EvidenceAuditSnapshotRow {
  runId: string;
  auditId: string;
  purpose: EvidenceAuditPurpose;
  inputId: string;
  inputHash: string;
  /** Bound candidate for commit_time audits (§34); null for pre_approval. */
  candidateId: string | null;
  auditHash: string;
  canonicalJson: string;
  requestId: string | null;
  createdAt: string;
}

export interface EvidenceAuditEntryRow {
  evidenceId: string;
  evidenceRevision: number;
  confidence: string;
  criticality: string;
  validationStrategy: string;
  state: string;
  disposition: string;
  reasonCode: string;
  lastValidationEventSeq: number | null;
}

export function insertEvidenceAuditSnapshotInTx(
  tx: StoreTx,
  audit: EvidenceAuditSnapshotRow,
  entries: EvidenceAuditEntryRow[],
): void {
  tx.prepare(
    `INSERT INTO evidence_audit_snapshots (
       run_id, audit_id, purpose, input_id, input_hash, candidate_id,
       audit_hash, canonical_json, request_id, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    audit.runId,
    audit.auditId,
    audit.purpose,
    audit.inputId,
    audit.inputHash,
    audit.candidateId,
    audit.auditHash,
    audit.canonicalJson,
    audit.requestId,
    audit.createdAt,
  );
  entries.forEach((entry, index) => {
    tx.prepare(
      `INSERT INTO evidence_audit_entries (
         run_id, audit_id, entry_seq, evidence_id, evidence_revision,
         confidence, criticality, validation_strategy, state, disposition,
         reason_code, last_validation_event_seq, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      audit.runId,
      audit.auditId,
      index + 1,
      entry.evidenceId,
      entry.evidenceRevision,
      entry.confidence,
      entry.criticality,
      entry.validationStrategy,
      entry.state,
      entry.disposition,
      entry.reasonCode,
      entry.lastValidationEventSeq,
      audit.createdAt,
    );
  });
}

const AUDIT_COLUMNS =
  "run_id AS runId, audit_id AS auditId, purpose AS purpose, input_id AS inputId, input_hash AS inputHash, "
  + "candidate_id AS candidateId, audit_hash AS auditHash, canonical_json AS canonicalJson, "
  + "request_id AS requestId, created_at AS createdAt";

interface AuditDbRow {
  runId: string;
  auditId: string;
  purpose: EvidenceAuditPurpose;
  inputId: string;
  inputHash: string;
  candidateId: string | null;
  auditHash: string;
  canonicalJson: string;
  requestId: string | null;
  createdAt: string;
}

export function getEvidenceAuditSnapshotInTx(tx: StoreTx, runId: string, auditId: string): AuditDbRow | null {
  const row = tx
    .prepare(`SELECT ${AUDIT_COLUMNS} FROM evidence_audit_snapshots WHERE run_id = ? AND audit_id = ?`)
    .get(runId, auditId) as AuditDbRow | undefined;
  return row ?? null;
}

/** The run's newest audit snapshot (pre-approval or commit-time), or null. */
export function getLatestEvidenceAuditInTx(tx: StoreTx, runId: string): AuditDbRow | null {
  const row = tx
    .prepare(
      `SELECT ${AUDIT_COLUMNS} FROM evidence_audit_snapshots WHERE run_id = ? ORDER BY created_at DESC, audit_id DESC LIMIT 1`,
    )
    .get(runId) as AuditDbRow | undefined;
  return row ?? null;
}

export function getCommitTimeAuditForCandidateInTx(tx: StoreTx, runId: string, candidateId: string): AuditDbRow | null {
  const row = tx
    .prepare(
      `SELECT ${AUDIT_COLUMNS} FROM evidence_audit_snapshots WHERE run_id = ? AND candidate_id = ? AND purpose = 'commit_time' `
      + "ORDER BY created_at DESC, audit_id DESC LIMIT 1",
    )
    .get(runId, candidateId) as AuditDbRow | undefined;
  return row ?? null;
}

export function listEvidenceAuditEntriesInTx(tx: StoreTx, runId: string, auditId: string): EvidenceAuditEntryRow[] {
  return tx
    .prepare(
      "SELECT evidence_id AS evidenceId, evidence_revision AS evidenceRevision, confidence, criticality, "
      + "validation_strategy AS validationStrategy, state, disposition, reason_code AS reasonCode, "
      + "last_validation_event_seq AS lastValidationEventSeq FROM evidence_audit_entries "
      + "WHERE run_id = ? AND audit_id = ? ORDER BY entry_seq",
    )
    .all(runId, auditId) as EvidenceAuditEntryRow[];
}

// ---------------------------------------------------------------------------
// FinalPlanCandidate (§30/§31)
// ---------------------------------------------------------------------------

export interface FinalPlanCandidateRow {
  runId: string;
  candidateSeq: number;
  candidateId: string;
  baseRunRevision: number;
  baseHeadSnapshotId: string;
  baseHeadCommitId: string | null;
  inputId: string;
  inputHash: string;
  manifestId: string;
  manifestHash: string;
  reportId: string;
  reportHash: string;
  canonicalJson: string;
  candidateHash: string;
  requestId: string;
  createdAt: string;
}

export type CandidateRefFamily = "architecture" | "section" | "decision" | "constraint" | "evidence";

export interface FinalPlanCandidateRefRow {
  family: CandidateRefFamily;
  artifactId: string;
  revision: number;
}

export function insertFinalPlanCandidateInTx(
  tx: StoreTx,
  candidate: FinalPlanCandidateRow,
  refs: FinalPlanCandidateRefRow[],
): void {
  tx.prepare(
    `INSERT INTO final_plan_candidates (
       run_id, candidate_seq, candidate_id, base_run_revision, base_head_snapshot_id,
       base_head_commit_id, input_id, input_hash, manifest_id, manifest_hash,
       report_id, report_hash, canonical_json, candidate_hash, request_id, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    candidate.runId,
    candidate.candidateSeq,
    candidate.candidateId,
    candidate.baseRunRevision,
    candidate.baseHeadSnapshotId,
    candidate.baseHeadCommitId,
    candidate.inputId,
    candidate.inputHash,
    candidate.manifestId,
    candidate.manifestHash,
    candidate.reportId,
    candidate.reportHash,
    candidate.canonicalJson,
    candidate.candidateHash,
    candidate.requestId,
    candidate.createdAt,
  );
  refs.forEach((ref, index) => {
    tx.prepare(
      `INSERT INTO final_plan_candidate_refs (run_id, candidate_id, position, family, artifact_id, revision)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(candidate.runId, candidate.candidateId, index + 1, ref.family, ref.artifactId, ref.revision);
  });
}

const CANDIDATE_COLUMNS =
  "run_id AS runId, candidate_seq AS candidateSeq, candidate_id AS candidateId, "
  + "base_run_revision AS baseRunRevision, base_head_snapshot_id AS baseHeadSnapshotId, "
  + "base_head_commit_id AS baseHeadCommitId, input_id AS inputId, input_hash AS inputHash, "
  + "manifest_id AS manifestId, manifest_hash AS manifestHash, report_id AS reportId, "
  + "report_hash AS reportHash, canonical_json AS canonicalJson, candidate_hash AS candidateHash, "
  + "request_id AS requestId, created_at AS createdAt";

interface CandidateDbRow {
  runId: string;
  candidateSeq: number;
  candidateId: string;
  baseRunRevision: number;
  baseHeadSnapshotId: string;
  baseHeadCommitId: string | null;
  inputId: string;
  inputHash: string;
  manifestId: string;
  manifestHash: string;
  reportId: string;
  reportHash: string;
  canonicalJson: string;
  candidateHash: string;
  requestId: string;
  createdAt: string;
}

export function getFinalPlanCandidateInTx(tx: StoreTx, runId: string, candidateId: string): CandidateDbRow | null {
  const row = tx
    .prepare(`SELECT ${CANDIDATE_COLUMNS} FROM final_plan_candidates WHERE run_id = ? AND candidate_id = ?`)
    .get(runId, candidateId) as CandidateDbRow | undefined;
  return row ?? null;
}

/** The candidate created by one finalization request (§72 idempotency). */
export function getFinalPlanCandidateByRequestInTx(tx: StoreTx, runId: string, requestId: string): CandidateDbRow | null {
  const row = tx
    .prepare(`SELECT ${CANDIDATE_COLUMNS} FROM final_plan_candidates WHERE run_id = ? AND request_id = ?`)
    .get(runId, requestId) as CandidateDbRow | undefined;
  return row ?? null;
}

/** The run's newest candidate (highest candidate_seq), or null. */
export function getLatestFinalPlanCandidateInTx(tx: StoreTx, runId: string): CandidateDbRow | null {
  const row = tx
    .prepare(`SELECT ${CANDIDATE_COLUMNS} FROM final_plan_candidates WHERE run_id = ? ORDER BY candidate_seq DESC LIMIT 1`)
    .get(runId) as CandidateDbRow | undefined;
  return row ?? null;
}

export function nextCandidateSeqInTx(tx: StoreTx, runId: string): number {
  const row = tx
    .prepare("SELECT COALESCE(MAX(candidate_seq), 0) + 1 AS seq FROM final_plan_candidates WHERE run_id = ?")
    .get(runId) as { seq: number };
  return row.seq;
}

export function listFinalPlanCandidateRefsInTx(
  tx: StoreTx,
  runId: string,
  candidateId: string,
): FinalPlanCandidateRefRow[] {
  return tx
    .prepare(
      "SELECT family, artifact_id AS artifactId, revision FROM final_plan_candidate_refs "
      + "WHERE run_id = ? AND candidate_id = ? ORDER BY position",
    )
    .all(runId, candidateId) as FinalPlanCandidateRefRow[];
}

// ---------------------------------------------------------------------------
// Proposal ↔ Candidate binding (§37)
// ---------------------------------------------------------------------------

export interface ProposalFinalPlanRefRow {
  runId: string;
  proposalId: string;
  proposalRevision: number;
  candidateId: string;
  candidateHash: string;
}

export function insertProposalFinalPlanRefInTx(tx: StoreTx, ref: ProposalFinalPlanRefRow): void {
  tx.prepare(
    `INSERT INTO proposal_final_plan_refs (run_id, proposal_id, proposal_revision, candidate_id, candidate_hash)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(ref.runId, ref.proposalId, ref.proposalRevision, ref.candidateId, ref.candidateHash);
}

export function getProposalFinalPlanRefInTx(
  tx: StoreTx,
  runId: string,
  proposalId: string,
  proposalRevision: number,
): ProposalFinalPlanRefRow | null {
  const row = tx
    .prepare(
      "SELECT run_id AS runId, proposal_id AS proposalId, proposal_revision AS proposalRevision, "
      + "candidate_id AS candidateId, candidate_hash AS candidateHash FROM proposal_final_plan_refs "
      + "WHERE run_id = ? AND proposal_id = ? AND proposal_revision = ?",
    )
    .get(runId, proposalId, proposalRevision) as ProposalFinalPlanRefRow | undefined;
  return row ?? null;
}

// ---------------------------------------------------------------------------
// FinalPlan (§52)
// ---------------------------------------------------------------------------

export interface FinalPlanRow {
  runId: string;
  finalPlanId: string;
  revision: number;
  candidateId: string;
  candidateHash: string;
  proposalId: string;
  proposalRevision: number;
  proposalHash: string;
  approvalId: string;
  commitId: string;
  snapshotId: string;
  auditId: string;
  auditHash: string;
  canonicalJson: string;
  finalPlanHash: string;
  createdAt: string;
}

export function insertFinalPlanInTx(tx: StoreTx, plan: FinalPlanRow): void {
  tx.prepare(
    `INSERT INTO final_plans (
       run_id, final_plan_id, revision, candidate_id, candidate_hash,
       proposal_id, proposal_revision, proposal_hash, approval_id, commit_id,
       snapshot_id, audit_id, audit_hash, canonical_json, final_plan_hash, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    plan.runId,
    plan.finalPlanId,
    plan.revision,
    plan.candidateId,
    plan.candidateHash,
    plan.proposalId,
    plan.proposalRevision,
    plan.proposalHash,
    plan.approvalId,
    plan.commitId,
    plan.snapshotId,
    plan.auditId,
    plan.auditHash,
    plan.canonicalJson,
    plan.finalPlanHash,
    plan.createdAt,
  );
}

const FINAL_PLAN_COLUMNS =
  "run_id AS runId, final_plan_id AS finalPlanId, revision AS revision, candidate_id AS candidateId, "
  + "candidate_hash AS candidateHash, proposal_id AS proposalId, proposal_revision AS proposalRevision, "
  + "proposal_hash AS proposalHash, approval_id AS approvalId, commit_id AS commitId, snapshot_id AS snapshotId, "
  + "audit_id AS auditId, audit_hash AS auditHash, canonical_json AS canonicalJson, "
  + "final_plan_hash AS finalPlanHash, created_at AS createdAt";

interface FinalPlanDbRow {
  runId: string;
  finalPlanId: string;
  revision: number;
  candidateId: string;
  candidateHash: string;
  proposalId: string;
  proposalRevision: number;
  proposalHash: string;
  approvalId: string;
  commitId: string;
  snapshotId: string;
  auditId: string;
  auditHash: string;
  canonicalJson: string;
  finalPlanHash: string;
  createdAt: string;
}

export function getFinalPlanInTx(tx: StoreTx, runId: string): FinalPlanDbRow | null {
  const row = tx
    .prepare(`SELECT ${FINAL_PLAN_COLUMNS} FROM final_plans WHERE run_id = ?`)
    .get(runId) as FinalPlanDbRow | undefined;
  return row ?? null;
}
