/**
 * Evidence persistence (Phase 9 §23/§30/§31/§44/§52).
 *
 * Evidence identity (ev_…) and its immutable revisions are distinct (§23);
 * revisions are strictly max+1 and never rewritten (§52 — DB triggers block
 * UPDATE/DELETE). Provenance links are part of the immutable revision (§30).
 *
 * Promotion idempotency (§44): UNIQUE(run_id, request_id) is the DB-enforced
 * boundary; the request id derives from the SIGNED HostContext tool use, and
 * the recorded request_hash pins the semantic payload — same request +
 * different semantics → IDEMPOTENCY_CONFLICT (Phase 6 pattern).
 *
 * The single production caller of these write primitives is the application
 * domain writer (src/application/evidence-service.ts); the model never
 * touches the Store.
 */

import { canonicalJson } from "../core/canonical-json.js";
import { RuntimeError } from "../runtime/errors.js";
import type { PlanStore } from "./sqlite-store.js";
import type { SourceFingerprint } from "../observations/types.js";

export type EvidenceWriteTx = {
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
};

export type EvidenceKind = "source_fact" | "locator_fact" | "execution_result" | "derived_claim";
export type EvidenceConfidence = "direct" | "derived" | "uncertain";
export type EvidenceCriticality = "critical" | "supporting" | "informational";
export type EvidenceValidationStrategy = "fingerprint" | "reobserve";

export interface EvidenceScope {
  type: "global" | "architecture" | "section";
  /** Only for type "section" (schema-ready; capability-gated in Phase 9, §34). */
  sectionId?: string;
}

export interface DerivedFromRef {
  evidenceId: string;
  revision: number;
}

export interface InsertEvidenceRevisionInput {
  runId: string;
  evidenceId: string;
  claim: string;
  kind: EvidenceKind;
  scope: EvidenceScope;
  confidence: EvidenceConfidence;
  criticality: EvidenceCriticality;
  validationStrategy: EvidenceValidationStrategy;
  repositoryContext: { repositoryRevision: string | null };
  workspaceContext: { workspaceId: string };
  sourceFingerprints: SourceFingerprint[];
  observationRefs: string[];
  derivedFrom: DerivedFromRef[];
  requestId: string;
  requestHash: string;
  createdAt: string;
}

export interface EvidenceRevisionView {
  runId: string;
  evidenceId: string;
  revision: number;
  claim: string;
  kind: EvidenceKind;
  scope: EvidenceScope;
  confidence: EvidenceConfidence;
  criticality: EvidenceCriticality;
  validationStrategy: EvidenceValidationStrategy;
  repositoryContext: { repositoryRevision: string | null };
  workspaceContext: { workspaceId: string };
  sourceFingerprints: SourceFingerprint[];
  observationRefs: string[];
  derivedFrom: DerivedFromRef[];
  requestId: string;
  createdAt: string;
}

const REVISION_COLUMNS = [
  "run_id AS runId",
  "evidence_id AS evidenceId",
  "revision",
  "claim",
  "kind",
  "scope_json AS scopeJson",
  "confidence",
  "criticality",
  "validation_strategy AS validationStrategy",
  "repository_context_json AS repositoryContextJson",
  "workspace_context_json AS workspaceContextJson",
  "source_fingerprints_json AS sourceFingerprintsJson",
  "request_id AS requestId",
  "request_hash AS requestHash",
  "created_at AS createdAt",
].join(", ");

interface RevisionRow {
  runId: string;
  evidenceId: string;
  revision: number;
  claim: string;
  kind: EvidenceKind;
  scopeJson: string;
  confidence: EvidenceConfidence;
  criticality: EvidenceCriticality;
  validationStrategy: EvidenceValidationStrategy;
  repositoryContextJson: string;
  workspaceContextJson: string;
  sourceFingerprintsJson: string;
  requestId: string;
  requestHash: string;
  createdAt: string;
}

function loadRefsInTx(
  tx: EvidenceWriteTx,
  runId: string,
  evidenceId: string,
  revision: number,
): { observationRefs: string[]; derivedFrom: DerivedFromRef[] } {
  const observationRefs = (
    tx
      .prepare(
        `SELECT observation_id AS observationId FROM evidence_observation_refs
         WHERE run_id = ? AND evidence_id = ? AND revision = ? ORDER BY ref_position`,
      )
      .all(runId, evidenceId, revision) as Array<{ observationId: string }>
  ).map((r) => r.observationId);
  const derivedFrom = (
    tx
      .prepare(
        `SELECT derived_from_evidence_id AS evidenceId, derived_from_revision AS revision FROM evidence_derived_refs
         WHERE run_id = ? AND evidence_id = ? AND revision = ? ORDER BY ref_position`,
      )
      .all(runId, evidenceId, revision) as DerivedFromRef[]
  ).map((r) => ({ evidenceId: r.evidenceId, revision: r.revision }));
  return { observationRefs, derivedFrom };
}

function rowToView(row: RevisionRow, refs: { observationRefs: string[]; derivedFrom: DerivedFromRef[] }): EvidenceRevisionView {
  return {
    runId: row.runId,
    evidenceId: row.evidenceId,
    revision: row.revision,
    claim: row.claim,
    kind: row.kind,
    scope: JSON.parse(row.scopeJson) as EvidenceScope,
    confidence: row.confidence,
    criticality: row.criticality,
    validationStrategy: row.validationStrategy,
    repositoryContext: JSON.parse(row.repositoryContextJson),
    workspaceContext: JSON.parse(row.workspaceContextJson),
    sourceFingerprints: JSON.parse(row.sourceFingerprintsJson),
    ...refs,
    requestId: row.requestId,
    createdAt: row.createdAt,
  };
}

export function insertEvidenceArtifactInTx(
  tx: EvidenceWriteTx,
  input: { runId: string; evidenceId: string; createdAt: string },
): void {
  tx.prepare(
    "INSERT INTO evidence_artifacts (run_id, evidence_id, created_at) VALUES (?, ?, ?)",
  ).run(input.runId, input.evidenceId, input.createdAt);
}

/**
 * Append the next immutable revision of an evidence identity. Revision is
 * strictly current-max + 1 (no gaps, no reuse). The promotion idempotency
 * lookup happens FIRST: an existing (run_id, request_id) with the same
 * request_hash returns the existing revision (status "duplicate"); with a
 * different hash it is an IDEMPOTENCY_CONFLICT (§44).
 */
export function insertEvidenceRevisionInTx(
  tx: EvidenceWriteTx,
  input: InsertEvidenceRevisionInput,
): { status: "inserted"; evidence: EvidenceRevisionView } | { status: "duplicate"; evidence: EvidenceRevisionView } {
  const byRequest = tx
    .prepare(`SELECT ${REVISION_COLUMNS} FROM evidence_revisions WHERE run_id = ? AND request_id = ?`)
    .get(input.runId, input.requestId) as RevisionRow | undefined;
  if (byRequest !== undefined) {
    if (byRequest.requestHash !== input.requestHash) {
      throw new RuntimeError(
        "IDEMPOTENCY_CONFLICT",
        "this promotion operation id was already used with a different semantic payload",
        { detail: { runId: input.runId, requestId: input.requestId, evidenceId: byRequest.evidenceId } },
      );
    }
    return {
      status: "duplicate",
      evidence: rowToView(byRequest, loadRefsInTx(tx, input.runId, byRequest.evidenceId, byRequest.revision)),
    };
  }

  const maxRow = tx
    .prepare("SELECT MAX(revision) AS maxRevision FROM evidence_revisions WHERE run_id = ? AND evidence_id = ?")
    .get(input.runId, input.evidenceId) as { maxRevision: number | null };
  const revision = (maxRow.maxRevision ?? 0) + 1;

  // The identity row precedes its first revision (FK evidence_revisions →
  // evidence_artifacts); for a fresh promotion id this is the artifact's birth.
  insertEvidenceArtifactInTx(tx, { runId: input.runId, evidenceId: input.evidenceId, createdAt: input.createdAt });

  tx.prepare(
    `INSERT INTO evidence_revisions (
      run_id, evidence_id, revision, claim, kind, scope_json, confidence, criticality,
      validation_strategy, repository_context_json, workspace_context_json,
      source_fingerprints_json, request_id, request_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.runId,
    input.evidenceId,
    revision,
    input.claim,
    input.kind,
    canonicalJson(input.scope),
    input.confidence,
    input.criticality,
    input.validationStrategy,
    canonicalJson(input.repositoryContext),
    canonicalJson(input.workspaceContext),
    canonicalJson(input.sourceFingerprints),
    input.requestId,
    input.requestHash,
    input.createdAt,
  );
  const refs = insertEvidenceRefsInTx(tx, {
    runId: input.runId,
    evidenceId: input.evidenceId,
    revision,
    observationRefs: input.observationRefs,
    derivedFrom: input.derivedFrom,
  });
  const row = tx
    .prepare(`SELECT ${REVISION_COLUMNS} FROM evidence_revisions WHERE run_id = ? AND evidence_id = ? AND revision = ?`)
    .get(input.runId, input.evidenceId, revision) as RevisionRow;
  return { status: "inserted", evidence: rowToView(row, refs) };
}

/** Insert the immutable provenance links of one revision (§30/§31). */
export function insertEvidenceRefsInTx(
  tx: EvidenceWriteTx,
  input: {
    runId: string;
    evidenceId: string;
    revision: number;
    observationRefs: string[];
    derivedFrom: DerivedFromRef[];
  },
): { observationRefs: string[]; derivedFrom: DerivedFromRef[] } {
  const observationRefs = [...input.observationRefs].sort();
  observationRefs.forEach((observationId, index) => {
    tx.prepare(
      `INSERT INTO evidence_observation_refs (run_id, evidence_id, revision, observation_id, ref_position)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(input.runId, input.evidenceId, input.revision, observationId, index + 1);
  });
  const derivedFrom = [...input.derivedFrom].sort(
    (a, b) => a.evidenceId.localeCompare(b.evidenceId) || a.revision - b.revision,
  );
  derivedFrom.forEach((ref, index) => {
    tx.prepare(
      `INSERT INTO evidence_derived_refs (run_id, evidence_id, revision, derived_from_evidence_id, derived_from_revision, ref_position)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(input.runId, input.evidenceId, input.revision, ref.evidenceId, ref.revision, index + 1);
  });
  return { observationRefs, derivedFrom };
}

export function getEvidenceRevisionRecord(
  store: PlanStore,
  runId: string,
  evidenceId: string,
  revision: number,
): EvidenceRevisionView | null {
  return store.withRead((tx) => {
    const row = tx
      .prepare(`SELECT ${REVISION_COLUMNS} FROM evidence_revisions WHERE run_id = ? AND evidence_id = ? AND revision = ?`)
      .get(runId, evidenceId, revision) as RevisionRow | undefined;
    return row === undefined ? null : rowToView(row, loadRefsInTx(tx, runId, evidenceId, revision));
  });
}

export interface ListEvidenceFilter {
  confidence?: EvidenceConfidence;
  criticality?: EvidenceCriticality;
  kind?: EvidenceKind;
  limit?: number;
}

export function listEvidenceRecord(
  store: PlanStore,
  runId: string,
  filter: ListEvidenceFilter = {},
): EvidenceRevisionView[] {
  return store.withRead((tx) => {
    const clauses = ["run_id = ?"];
    const params: unknown[] = [runId];
    if (filter.confidence !== undefined) {
      clauses.push("confidence = ?");
      params.push(filter.confidence);
    }
    if (filter.criticality !== undefined) {
      clauses.push("criticality = ?");
      params.push(filter.criticality);
    }
    if (filter.kind !== undefined) {
      clauses.push("kind = ?");
      params.push(filter.kind);
    }
    const rows = tx
      .prepare(`SELECT ${REVISION_COLUMNS} FROM evidence_revisions WHERE ${clauses.join(" AND ")} ORDER BY evidence_id, revision`)
      .all(...params) as RevisionRow[];
    const limit = filter.limit ?? rows.length;
    return rows.slice(0, limit).map((row) => rowToView(row, loadRefsInTx(tx, row.runId, row.evidenceId, row.revision)));
  });
}
