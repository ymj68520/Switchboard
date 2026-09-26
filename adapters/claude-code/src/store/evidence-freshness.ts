/**
 * Evidence freshness persistence (Phase 10 §5/§7/§34).
 *
 * Authority = the immutable Evidence revision + the append-only
 * evidence_validation_events. evidence_current_states is a MATERIALIZED
 * projection updated in the SAME transaction as its event — never a second
 * authority (§7). Terminal exact revisions (stale/invalidated) are fenced by
 * the evidence_validation_events_no_revival trigger; the event_seq numbering
 * is per-run and strictly monotonic.
 *
 * The single production caller of the write primitives is the application
 * freshness/entry domain writer (src/application/evidence-freshness-service.ts
 * and the promotion path inside evidence-service.ts).
 */

import { canonicalJson } from "../core/canonical-json.js";
import { RuntimeError } from "../runtime/errors.js";
import type {
  FreshnessState,
  ValidationEventType,
} from "../evidence/freshness.js";
import type { DerivedFromRef } from "./evidence.js";
import type { PlanStore } from "./sqlite-store.js";
import type { StoreTx } from "./transaction.js";

export interface EvidenceRef {
  evidenceId: string;
  revision: number;
}

export interface AppendValidationEventInput {
  runId: string;
  evidenceId: string;
  evidenceRevision: number;
  eventType: ValidationEventType;
  toState: FreshnessState;
  /** Documented vocabulary (src/evidence/freshness.ts); DB has no CHECK by design. */
  reasonCode: string;
  detail: Record<string, unknown>;
  eventId: string;
  /** Previous materialized state; null when none (INITIALIZED). */
  fromState?: FreshnessState | null;
  /** Operation id from the signed HostContext tool use (nullable system fact). */
  requestId?: string | null;
  createdAt: string;
}

export interface ValidationEventView {
  runId: string;
  eventSeq: number;
  eventId: string;
  evidenceId: string;
  evidenceRevision: number;
  eventType: ValidationEventType;
  fromState: FreshnessState | null;
  toState: FreshnessState;
  reasonCode: string;
  detail: Record<string, unknown>;
  requestId: string | null;
  createdAt: string;
}

const EVENT_COLUMNS = [
  "run_id AS runId",
  "event_seq AS eventSeq",
  "event_id AS eventId",
  "evidence_id AS evidenceId",
  "evidence_revision AS evidenceRevision",
  "event_type AS eventType",
  "from_state AS fromState",
  "to_state AS toState",
  "reason_code AS reasonCode",
  "detail_json AS detailJson",
  "request_id AS requestId",
  "created_at AS createdAt",
].join(", ");

interface EventRow {
  runId: string;
  eventSeq: number;
  eventId: string;
  evidenceId: string;
  evidenceRevision: number;
  eventType: ValidationEventType;
  fromState: FreshnessState | null;
  toState: FreshnessState;
  reasonCode: string;
  detailJson: string;
  requestId: string | null;
  createdAt: string;
}

function rowToEvent(row: EventRow): ValidationEventView {
  return {
    runId: row.runId,
    eventSeq: row.eventSeq,
    eventId: row.eventId,
    evidenceId: row.evidenceId,
    evidenceRevision: row.evidenceRevision,
    eventType: row.eventType,
    fromState: row.fromState,
    toState: row.toState,
    reasonCode: row.reasonCode,
    detail: JSON.parse(row.detailJson) as Record<string, unknown>,
    requestId: row.requestId,
    createdAt: row.createdAt,
  };
}

/**
 * Append one validation event and move the materialized state in the SAME
 * transaction (§7). `fromState` must equal the current materialized state
 * (or be null/undefined when none exists); a mismatch is a programming error
 * and fails the store transaction closed rather than writing a divergent
 * projection.
 */
export function appendValidationEventInTx(
  tx: StoreTx,
  input: AppendValidationEventInput,
): ValidationEventView {
  const current = tx
    .prepare(
      "SELECT state AS state, last_event_seq AS lastEventSeq FROM evidence_current_states WHERE run_id = ? AND evidence_id = ? AND evidence_revision = ?",
    )
    .get(input.runId, input.evidenceId, input.evidenceRevision) as
    | { state: FreshnessState; lastEventSeq: number }
    | undefined;
  const fromState = current?.state ?? null;
  if (input.fromState !== undefined && input.fromState !== fromState) {
    throw new RuntimeError(
      "STORE_SCHEMA_INVALID",
      "freshness transition does not match the materialized state",
      {
        detail: {
          runId: input.runId,
          evidenceId: input.evidenceId,
          revision: input.evidenceRevision,
          materialized: fromState,
          expected: input.fromState ?? null,
        },
      },
    );
  }
  if (fromState === "stale" || fromState === "invalidated") {
    // Belt-and-braces mirror of evidence_validation_events_no_revival.
    throw new RuntimeError(
      "EVIDENCE_STATE_INVALID",
      `evidence revision is terminal (${fromState}) and cannot change freshness state`,
      { detail: { runId: input.runId, evidenceId: input.evidenceId, revision: input.evidenceRevision } },
    );
  }

  const maxRow = tx
    .prepare("SELECT MAX(event_seq) AS maxSeq FROM evidence_validation_events WHERE run_id = ?")
    .get(input.runId) as { maxSeq: number | null };
  const eventSeq = (maxRow.maxSeq ?? 0) + 1;

  tx.prepare(
    `INSERT INTO evidence_validation_events (
       run_id, event_seq, event_id, evidence_id, evidence_revision,
       event_type, from_state, to_state, reason_code, detail_json, request_id, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.runId,
    eventSeq,
    input.eventId,
    input.evidenceId,
    input.evidenceRevision,
    input.eventType,
    fromState,
    input.toState,
    input.reasonCode,
    canonicalJson(input.detail),
    input.requestId ?? null,
    input.createdAt,
  );

  if (current === undefined) {
    tx.prepare(
      `INSERT INTO evidence_current_states (run_id, evidence_id, evidence_revision, state, last_event_seq, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(input.runId, input.evidenceId, input.evidenceRevision, input.toState, eventSeq, input.createdAt);
  } else {
    tx.prepare(
      `UPDATE evidence_current_states SET state = ?, last_event_seq = ?, updated_at = ?
       WHERE run_id = ? AND evidence_id = ? AND evidence_revision = ?`,
    ).run(input.toState, eventSeq, input.createdAt, input.runId, input.evidenceId, input.evidenceRevision);
  }
  return {
    runId: input.runId,
    eventSeq,
    eventId: input.eventId,
    evidenceId: input.evidenceId,
    evidenceRevision: input.evidenceRevision,
    eventType: input.eventType,
    fromState,
    toState: input.toState,
    reasonCode: input.reasonCode,
    detail: input.detail,
    requestId: input.requestId ?? null,
    createdAt: input.createdAt,
  };
}

/** Current materialized state of one exact revision (or null when none). */
export function getCurrentStateInTx(
  tx: StoreTx,
  runId: string,
  evidenceId: string,
  revision: number,
): FreshnessState | null {
  const row = tx
    .prepare("SELECT state AS state FROM evidence_current_states WHERE run_id = ? AND evidence_id = ? AND evidence_revision = ?")
    .get(runId, evidenceId, revision) as { state: FreshnessState } | undefined;
  return row?.state ?? null;
}

export function getCurrentState(store: PlanStore, runId: string, evidenceId: string, revision: number): FreshnessState | null {
  return store.withRead((tx) => getCurrentStateInTx(tx, runId, evidenceId, revision));
}

/** Append-only validation history of one exact revision, seq ascending. */
export function getValidationHistory(
  store: PlanStore,
  runId: string,
  evidenceId: string,
  revision: number,
): ValidationEventView[] {
  return store.withRead((tx) => getValidationHistoryInTx(tx, runId, evidenceId, revision));
}

export function getValidationHistoryInTx(
  tx: StoreTx,
  runId: string,
  evidenceId: string,
  revision: number,
): ValidationEventView[] {
  const rows = tx
    .prepare(
      `SELECT ${EVENT_COLUMNS} FROM evidence_validation_events
       WHERE run_id = ? AND evidence_id = ? AND evidence_revision = ? ORDER BY event_seq`,
    )
    .all(runId, evidenceId, revision) as EventRow[];
  return rows.map(rowToEvent);
}

/** All events recorded for one operation id (idempotent-replay lookup, §27). */
export function findEventsByRequest(store: PlanStore, runId: string, requestId: string): ValidationEventView[] {
  return store.withRead((tx) => {
    const rows = tx
      .prepare(`SELECT ${EVENT_COLUMNS} FROM evidence_validation_events WHERE run_id = ? AND request_id = ? ORDER BY event_seq`)
      .all(runId, requestId) as EventRow[];
    return rows.map(rowToEvent);
  });
}

/**
 * Direct dependents of one exact upstream revision: derived revisions whose
 * provenance cites it (same run — propagation never crosses runs, §16).
 */
export function listDerivedDependentsInTx(tx: StoreTx, runId: string, upstream: EvidenceRef): EvidenceRef[] {
  const rows = tx
    .prepare(
      `SELECT evidence_id AS evidenceId, revision AS revision FROM evidence_derived_refs
       WHERE run_id = ? AND derived_from_evidence_id = ? AND derived_from_revision = ?
       ORDER BY evidence_id, revision`,
    )
    .all(runId, upstream.evidenceId, upstream.revision) as EvidenceRef[];
  return rows;
}

/** The lineage-current revision number of an evidence identity (max). */
export function getCurrentRevisionInTx(tx: StoreTx, runId: string, evidenceId: string): number | null {
  const row = tx
    .prepare("SELECT MAX(revision) AS maxRevision FROM evidence_revisions WHERE run_id = ? AND evidence_id = ?")
    .get(runId, evidenceId) as { maxRevision: number | null };
  return row.maxRevision ?? null;
}

// ---------------------------------------------------------------------------
// proposal_evidence_refs (§34) — the relational index of canonical V2's
// requiredEvidence set; immutable, exact-revision FKs both ways.
// ---------------------------------------------------------------------------

export function insertProposalEvidenceRefsInTx(
  tx: StoreTx,
  input: {
    runId: string;
    proposalId: string;
    proposalRevision: number;
    requiredEvidence: EvidenceRef[];
  },
): void {
  const sorted = [...input.requiredEvidence].sort(
    (a, b) => a.evidenceId.localeCompare(b.evidenceId) || a.revision - b.revision,
  );
  sorted.forEach((ref, index) => {
    tx.prepare(
      `INSERT INTO proposal_evidence_refs (run_id, proposal_id, proposal_revision, position, evidence_id, evidence_revision)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(input.runId, input.proposalId, input.proposalRevision, index + 1, ref.evidenceId, ref.revision);
  });
}

export function listProposalEvidenceRefs(
  store: PlanStore,
  runId: string,
  proposalId: string,
  proposalRevision: number,
): DerivedFromRef[] {
  return store.withRead((tx) => listProposalEvidenceRefsInTx(tx, runId, proposalId, proposalRevision));
}

export function listProposalEvidenceRefsInTx(
  tx: StoreTx,
  runId: string,
  proposalId: string,
  proposalRevision: number,
): DerivedFromRef[] {
  const rows = tx
    .prepare(
      `SELECT evidence_id AS evidenceId, evidence_revision AS revision FROM proposal_evidence_refs
       WHERE run_id = ? AND proposal_id = ? AND proposal_revision = ? ORDER BY position`,
    )
    .all(runId, proposalId, proposalRevision) as DerivedFromRef[];
  return rows.map((r) => ({ evidenceId: r.evidenceId, revision: r.revision }));
}
