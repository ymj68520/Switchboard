/**
 * Observation Ledger persistence (Phase 9 §5/§6/§20/§40/§41).
 *
 * TRANSACTION-SCOPED, INTERNAL-ONLY write primitives. The single production
 * caller is the hook-side capture orchestrator (src/observations/capture.ts);
 * tests use the primitives directly to build fixtures (the sanctioned
 * boundary — immutability is enforced by the DATABASE, not by this module).
 *
 * Idempotency (§40/§41): UNIQUE(run_id, tool_use_id) is the DB-enforced
 * boundary. A repeated capture of the same tool use returns the EXISTING
 * observation when the recorded facts match byte-for-byte and fails closed
 * (OBSERVATION_CONFLICT) when they differ. All writes run inside BEGIN
 * IMMEDIATE transactions, so concurrent hook processes serialize; the unique
 * index is the backstop, never an application pre-check alone.
 *
 * Ledger order (§20): observation_seq is a per-run, gap-free monotonic
 * sequence assigned inside the write transaction (MAX+1 under IMMEDIATE) —
 * deterministic even when wall-clock captured_at ties.
 */

import { canonicalJson } from "../core/canonical-json.js";
import { RuntimeError } from "../runtime/errors.js";
import type { PlanStore } from "./sqlite-store.js";
import type {
  CapturedObservation,
  ObservationClass,
  ObservationInputProjection,
  SourceFingerprint,
} from "../observations/types.js";

export type ObservationWriteTx = {
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
};

export interface InsertObservationInput {
  runId: string;
  workspaceId: string;
  sessionId: string;
  observationId: string;
  toolName: string;
  toolUseId: string;
  observationClass: ObservationClass;
  input: ObservationInputProjection;
  payloadHash: string | null;
  payloadSize: number | null;
  contentType: string;
  sourceFingerprint: SourceFingerprint | null;
  repositoryRevision: string | null;
  promotable: boolean;
  sanitized: string | null;
  capturedAt: string;
}

const OBSERVATION_COLUMNS = [
  "run_id AS runId",
  "observation_id AS observationId",
  "observation_seq AS observationSeq",
  "workspace_id AS workspaceId",
  "session_id AS sessionId",
  "tool_name AS toolName",
  "tool_use_id AS toolUseId",
  "observation_class AS observationClass",
  "input_projection_json AS inputProjectionJson",
  "payload_hash AS payloadHash",
  "payload_size AS payloadSize",
  "content_type AS contentType",
  "source_fingerprint_json AS sourceFingerprintJson",
  "repository_revision AS repositoryRevision",
  "promotable AS promotable",
  "sanitized AS sanitized",
  "captured_at AS capturedAt",
].join(", ");

interface ObservationRow {
  runId: string;
  observationId: string;
  observationSeq: number;
  workspaceId: string;
  sessionId: string;
  toolName: string;
  toolUseId: string;
  observationClass: ObservationClass;
  inputProjectionJson: string;
  payloadHash: string | null;
  payloadSize: number | null;
  contentType: string;
  sourceFingerprintJson: string | null;
  repositoryRevision: string | null;
  promotable: number;
  sanitized: string | null;
  capturedAt: string;
}

function rowToView(row: ObservationRow): CapturedObservation {
  return {
    runId: row.runId,
    workspaceId: row.workspaceId,
    observationId: row.observationId,
    observationSeq: row.observationSeq,
    observationClass: row.observationClass,
    toolName: row.toolName,
    toolUseId: row.toolUseId,
    input: JSON.parse(row.inputProjectionJson) as ObservationInputProjection,
    payloadHash: row.payloadHash,
    payloadSize: row.payloadSize,
    contentType: row.contentType,
    sourceFingerprint: row.sourceFingerprintJson === null ? null : (JSON.parse(row.sourceFingerprintJson) as SourceFingerprint),
    repositoryRevision: row.repositoryRevision,
    promotable: row.promotable === 1,
    sanitized: row.sanitized,
    capturedAt: row.capturedAt,
  };
}

/** Recorded facts compared on a repeated (run_id, tool_use_id) capture (§40). */
function observationFactsMatch(a: ObservationRow, input: InsertObservationInput): boolean {
  return (
    a.toolName === input.toolName &&
    a.observationClass === input.observationClass &&
    a.inputProjectionJson === canonicalJson(input.input) &&
    a.payloadHash === input.payloadHash &&
    a.contentType === input.contentType &&
    a.sanitized === input.sanitized
  );
}

/**
 * Idempotent ledger insert. Same (run_id, tool_use_id) with identical
 * recorded facts → the existing row (status "duplicate"); differing facts →
 * OBSERVATION_CONFLICT, never an overwrite or a second row (§40).
 */
export function insertObservationInTx(
  tx: ObservationWriteTx,
  input: InsertObservationInput,
): { status: "inserted"; observation: CapturedObservation } | { status: "duplicate"; observation: CapturedObservation } {
  const existing = tx
    .prepare(`SELECT ${OBSERVATION_COLUMNS} FROM observations WHERE run_id = ? AND tool_use_id = ?`)
    .get(input.runId, input.toolUseId) as ObservationRow | undefined;
  if (existing !== undefined) {
    if (!observationFactsMatch(existing, input)) {
      throw new RuntimeError(
        "OBSERVATION_CONFLICT",
        `tool use '${input.toolUseId}' was already captured with different recorded facts`,
        {
          detail: {
            runId: input.runId,
            toolUseId: input.toolUseId,
            existingObservationId: existing.observationId,
          },
        },
      );
    }
    return { status: "duplicate", observation: rowToView(existing) };
  }
  const seqRow = tx
    .prepare("SELECT COALESCE(MAX(observation_seq), 0) + 1 AS nextSeq FROM observations WHERE run_id = ?")
    .get(input.runId) as { nextSeq: number };
  tx.prepare(
    `INSERT INTO observations (
      run_id, observation_id, observation_seq, workspace_id, session_id,
      tool_name, tool_use_id, observation_class, input_projection_json,
      payload_hash, payload_size, content_type, source_fingerprint_json,
      repository_revision, promotable, sanitized, captured_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.runId,
    input.observationId,
    seqRow.nextSeq,
    input.workspaceId,
    input.sessionId,
    input.toolName,
    input.toolUseId,
    input.observationClass,
    canonicalJson(input.input),
    input.payloadHash,
    input.payloadSize,
    input.contentType,
    input.sourceFingerprint === null ? null : canonicalJson(input.sourceFingerprint),
    input.repositoryRevision,
    input.promotable ? 1 : 0,
    input.sanitized,
    input.capturedAt,
  );
  const inserted = tx
    .prepare(`SELECT ${OBSERVATION_COLUMNS} FROM observations WHERE run_id = ? AND observation_id = ?`)
    .get(input.runId, input.observationId) as ObservationRow;
  return { status: "inserted", observation: rowToView(inserted) };
}

// ---------------------------------------------------------------------------
// Read model (never mutates; no writable binding required)
// ---------------------------------------------------------------------------

export function getObservationRecord(
  store: PlanStore,
  runId: string,
  observationId: string,
): CapturedObservation | null {
  return store.withRead((tx) => {
    const row = tx
      .prepare(`SELECT ${OBSERVATION_COLUMNS} FROM observations WHERE run_id = ? AND observation_id = ?`)
      .get(runId, observationId) as ObservationRow | undefined;
    return row === undefined ? null : rowToView(row);
  });
}

export interface ListObservationsFilter {
  observationClass?: ObservationClass;
  /** Exclusive ledger cursor: only rows with observation_seq > afterSeq. */
  afterSeq?: number;
  limit: number;
}

/** Deterministic ledger order: observation_seq ascending (§20). */
export function listObservationsRecord(
  store: PlanStore,
  runId: string,
  filter: ListObservationsFilter,
): CapturedObservation[] {
  return store.withRead((tx) => {
    const clauses = ["run_id = ?"];
    const params: unknown[] = [runId];
    if (filter.observationClass !== undefined) {
      clauses.push("observation_class = ?");
      params.push(filter.observationClass);
    }
    if (filter.afterSeq !== undefined) {
      clauses.push("observation_seq > ?");
      params.push(filter.afterSeq);
    }
    params.push(filter.limit);
    const rows = tx
      .prepare(
        `SELECT ${OBSERVATION_COLUMNS} FROM observations WHERE ${clauses.join(" AND ")} ORDER BY observation_seq ASC LIMIT ?`,
      )
      .all(...params) as ObservationRow[];
    return rows.map(rowToView);
  });
}

/** Evidence revisions citing one observation — the promotion back-reference. */
export function listEvidenceRefsForObservationRecord(
  store: PlanStore,
  runId: string,
  observationId: string,
): Array<{ evidenceId: string; revision: number }> {
  return store.withRead((tx) =>
    (
      tx
        .prepare(
          `SELECT evidence_id AS evidenceId, revision FROM evidence_observation_refs
           WHERE run_id = ? AND observation_id = ? ORDER BY evidence_id, revision`,
        )
        .all(runId, observationId) as Array<{ evidenceId: string; revision: number }>
    ).map((r) => ({ evidenceId: r.evidenceId, revision: r.revision })),
  );
}
