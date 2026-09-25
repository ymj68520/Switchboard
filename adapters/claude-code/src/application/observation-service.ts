/**
 * Observation read APIs (Phase 9 §20/§22) — application layer, read-only.
 *
 * listObservations returns LEDGER SUMMARIES (never whole payloads); the exact
 * payload bytes stay addressable by hash through the CAS. The per-item
 * evidenceRefs expose the promoted Evidence back-references (the minimal
 * Phase 9 context integration — the Recovery Capsule itself is untouched,
 * §49/§50). readObservation re-verifies the blob on every read (§18) and
 * fails closed on corruption.
 */

import type { PlanStore } from "../store/sqlite-store.js";
import type { BlobStore } from "../store/blob-store.js";
import {
  getObservationRecord,
  listEvidenceRefsForObservationRecord,
  listObservationsRecord,
  type ListObservationsFilter,
} from "../store/observations.js";
import type { CapturedObservation } from "../observations/types.js";

export interface ObservationSummary {
  observationId: string;
  observationSeq: number;
  observationClass: CapturedObservation["observationClass"];
  tool: string;
  capturedAt: string;
  input: CapturedObservation["input"];
  payloadSize: number | null;
  payloadHash: string | null;
  promotable: boolean;
  sanitized: string | null;
  /** Promoted Evidence revisions citing this observation ("ev_…@N"). */
  evidenceRefs: string[];
}

export function listObservationSummaries(
  store: PlanStore,
  runId: string,
  filter: ListObservationsFilter,
): ObservationSummary[] {
  return listObservationsRecord(store, runId, filter).map((observation) => ({
    observationId: observation.observationId,
    observationSeq: observation.observationSeq,
    observationClass: observation.observationClass,
    tool: observation.toolName,
    capturedAt: observation.capturedAt,
    input: observation.input,
    payloadSize: observation.payloadSize,
    payloadHash: observation.payloadHash,
    promotable: observation.promotable,
    sanitized: observation.sanitized,
    evidenceRefs: listEvidenceRefsForObservationRecord(store, runId, observation.observationId).map(
      (ref) => `${ref.evidenceId}@${ref.revision}`,
    ),
  }));
}

export interface ObservationRead {
  observation: CapturedObservation;
  /** Verified payload text for textual results; null for metadata-only captures. */
  payloadText: string | null;
}

export function readObservation(
  store: PlanStore,
  blobs: BlobStore,
  runId: string,
  observationId: string,
): ObservationRead | null {
  const observation = getObservationRecord(store, runId, observationId);
  if (observation === null) return null;
  if (observation.payloadHash === null) {
    return { observation, payloadText: null };
  }
  return { observation, payloadText: Buffer.from(blobs.readBytes(observation.payloadHash)).toString("utf8") };
}
