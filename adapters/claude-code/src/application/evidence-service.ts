/**
 * Evidence promotion application service (Phase 9 §23–§38, §44–§48, §70–§73).
 *
 * The ONE production writer of Evidence rows. The model expresses a claim and
 * references Observation ids / exact upstream Evidence revisions; every
 * authority field (identity, revision, fingerprints, repository/workspace
 * context, validation strategy) is SERVER-DERIVED from the authoritative rows
 * — model input can never forge payload or source hashes (§29).
 *
 * Evidence needs no formal human Approval (§45): it records provenance, it is
 * not a design commitment. Design consequences still go through
 * Proposal → Approval → PlanCommit. Promotion also performs NO Plan Memory
 * HEAD mutation and does NOT change the PlanningRun revision or the Phase 8
 * context epoch (E35/E36/E37, §49/§50).
 *
 * Validation-strategy server rule (§27/§37, documented): only a DIRECT claim
 * resting entirely on fingerprint-carrying source observations is
 * `fingerprint` (reusing the capture-time fingerprints verbatim); anything
 * derived, uncertain, or citing locator/execution observations is
 * `reobserve`; a direct pure-source basis without capture-time fingerprints
 * fails closed with EVIDENCE_SOURCE_FINGERPRINT_UNAVAILABLE — a fingerprint
 * strategy without fingerprints is never silently created.
 */

import { createHash } from "node:crypto";

import { canonicalJson } from "../core/canonical-json.js";
import type { PlanningStage } from "../core/state-machine.js";
import { RuntimeError } from "../runtime/errors.js";
import type { StoreClock } from "../store/migration-runner.js";
import type { PlanStore } from "../store/sqlite-store.js";
import type { BlobStore } from "../store/blob-store.js";
import { getObservationRecord } from "../store/observations.js";
import {
  getEvidenceRevisionRecord,
  insertEvidenceRevisionInTx,
  listEvidenceRecord,
  type DerivedFromRef,
  type EvidenceConfidence,
  type EvidenceCriticality,
  type EvidenceKind,
  type EvidenceRevisionView,
  type EvidenceScope,
  type EvidenceValidationStrategy,
  type ListEvidenceFilter,
} from "../store/evidence.js";
import { getPlanningRunRecord } from "../store/planning-runs.js";
import type { CapturedObservation, SourceFingerprint } from "../observations/types.js";

/** §46: promotion stages. Synthesis/Validation/Final stay fail-closed. */
export const EVIDENCE_PROMOTION_STAGES: readonly PlanningStage[] = ["discovery", "architecture", "detail"];

const EVIDENCE_KINDS: readonly EvidenceKind[] = ["source_fact", "locator_fact", "execution_result", "derived_claim"];
const EVIDENCE_CONFIDENCES: readonly EvidenceConfidence[] = ["direct", "derived", "uncertain"];
const EVIDENCE_CRITICALITIES: readonly EvidenceCriticality[] = ["critical", "supporting", "informational"];

export interface PromoteEvidenceRequest {
  claim: string;
  kind: EvidenceKind;
  scope: EvidenceScope;
  confidence: EvidenceConfidence;
  criticality: EvidenceCriticality;
  /** Observation ids — the model may only ever REFERENCE, never restate. */
  observationRefs: string[];
  /** Exact upstream revisions (EV-…@N) — never "latest"/"current" (§31). */
  derivedFrom: DerivedFromRef[];
}

export interface PromoteEvidenceInput {
  runId: string;
  workspaceId: string;
  request: PromoteEvidenceRequest;
  /** Derived from the signed HostContext tool use (§44) — never model input. */
  operationId: string;
}

export interface PromoteEvidenceResult {
  evidence: EvidenceRevisionView;
  /** True when this exact operation id had already promoted (idempotent replay). */
  idempotent: boolean;
}

function evidenceError(
  code:
    | "OBSERVATION_NOT_FOUND"
    | "OBSERVATION_NOT_PROMOTABLE"
    | "EVIDENCE_REVISION_NOT_FOUND"
    | "EVIDENCE_PROVENANCE_INVALID"
    | "EVIDENCE_SOURCE_FINGERPRINT_UNAVAILABLE"
    | "EVIDENCE_SCOPE_INVALID"
    | "CAPABILITY_NOT_AVAILABLE"
    | "MCP_INPUT_INVALID",
  message: string,
  detail?: Record<string, unknown>,
): RuntimeError {
  return new RuntimeError(code, message, { detail, recoverable: false });
}

function isEvidenceKind(value: unknown): value is EvidenceKind {
  return typeof value === "string" && (EVIDENCE_KINDS as readonly string[]).includes(value);
}

function isEvidenceConfidence(value: unknown): value is EvidenceConfidence {
  return typeof value === "string" && (EVIDENCE_CONFIDENCES as readonly string[]).includes(value);
}

function isEvidenceCriticality(value: unknown): value is EvidenceCriticality {
  return typeof value === "string" && (EVIDENCE_CRITICALITIES as readonly string[]).includes(value);
}

function validateScope(scope: unknown): EvidenceScope {
  if (typeof scope !== "object" || scope === null || Array.isArray(scope)) {
    throw evidenceError("EVIDENCE_SCOPE_INVALID", "scope must be an object", { scope });
  }
  const record = scope as Record<string, unknown>;
  if (record.type === "global" && Object.keys(record).length === 1) return { type: "global" };
  if (record.type === "architecture" && Object.keys(record).length === 1) return { type: "architecture" };
  // §34: section scope is schema-ready but the Section workflow is not yet
  // authoritative — the production surface stays global/architecture in
  // Phase 9 and a section request is a typed capability error.
  if (record.type === "section") {
    throw evidenceError(
      "CAPABILITY_NOT_AVAILABLE",
      "section-scoped Evidence is not available in this phase; use scope global or architecture",
    );
  }
  throw evidenceError("EVIDENCE_SCOPE_INVALID", "scope.type must be 'global' or 'architecture' in this phase", { scope });
}

export function createEvidenceService(store: PlanStore, blobs: BlobStore, clock: StoreClock) {
  function promoteEvidence(input: PromoteEvidenceInput): PromoteEvidenceResult {
    const request = input.request;

    if (typeof request.claim !== "string" || request.claim.trim() === "") {
      throw evidenceError("MCP_INPUT_INVALID", "claim must be a non-empty string");
    }
    if (!isEvidenceKind(request.kind)) {
      throw evidenceError("MCP_INPUT_INVALID", `kind must be one of: ${EVIDENCE_KINDS.join(", ")}`);
    }
    if (!isEvidenceConfidence(request.confidence)) {
      throw evidenceError("MCP_INPUT_INVALID", `confidence must be one of: ${EVIDENCE_CONFIDENCES.join(", ")}`);
    }
    if (!isEvidenceCriticality(request.criticality)) {
      throw evidenceError("MCP_INPUT_INVALID", `criticality must be one of: ${EVIDENCE_CRITICALITIES.join(", ")}`);
    }
    const scope = validateScope(request.scope);
    const observationRefs = request.observationRefs.map((ref) => {
      if (typeof ref !== "string" || ref.trim() === "") {
        throw evidenceError("EVIDENCE_PROVENANCE_INVALID", "observation refs must be non-empty observation ids");
      }
      return ref;
    });
    const derivedFrom = request.derivedFrom.map((ref) => {
      if (
        typeof ref !== "object" ||
        ref === null ||
        typeof (ref as DerivedFromRef).evidenceId !== "string" ||
        !Number.isInteger((ref as DerivedFromRef).revision) ||
        (ref as DerivedFromRef).revision < 1
      ) {
        throw evidenceError("EVIDENCE_PROVENANCE_INVALID", "derived refs must be exact {evidenceId, revision} pairs");
      }
      return { evidenceId: (ref as DerivedFromRef).evidenceId, revision: (ref as DerivedFromRef).revision };
    });

    // §32 — confidence/provenance matrix.
    if (request.confidence === "direct" && (observationRefs.length === 0 || derivedFrom.length > 0)) {
      throw evidenceError("EVIDENCE_PROVENANCE_INVALID", "confidence=direct requires observation provenance and no derived refs");
    }
    if (request.confidence === "derived" && derivedFrom.length === 0) {
      throw evidenceError("EVIDENCE_PROVENANCE_INVALID", "confidence=derived requires exact upstream Evidence revisions");
    }
    if (request.confidence === "uncertain" && observationRefs.length + derivedFrom.length === 0) {
      throw evidenceError("EVIDENCE_PROVENANCE_INVALID", "uncertain Evidence still requires at least one provenance source");
    }

    const run = getPlanningRunRecord(store, input.runId);
    if (run === null) {
      throw new RuntimeError("RUN_NOT_FOUND", `no PlanningRun exists for '${input.runId}'`, {
        detail: { runId: input.runId },
      });
    }
    if (run.lifecycle !== "active") {
      throw new RuntimeError("RUN_TERMINAL", `PlanningRun '${input.runId}' is not active`, { detail: { runId: input.runId } });
    }
    if (run.workspaceId !== input.workspaceId) {
      throw new RuntimeError("WORKSPACE_MISMATCH", "Evidence promotion is scoped to the run's own workspace", {
        detail: { runId: input.runId, workspaceId: input.workspaceId },
      });
    }
    if (!(EVIDENCE_PROMOTION_STAGES as readonly string[]).includes(run.stage)) {
      throw evidenceError(
        "CAPABILITY_NOT_AVAILABLE",
        `Evidence promotion is not available at stage '${run.stage}' (available: ${EVIDENCE_PROMOTION_STAGES.join(", ")})`,
      );
    }

    // §28/§29 — reload exact authoritative observations; nothing is taken
    // from model input except the ids themselves.
    const observations: CapturedObservation[] = observationRefs.map((observationId) => {
      const observation = getObservationRecord(store, input.runId, observationId);
      if (observation === null) {
        throw evidenceError("OBSERVATION_NOT_FOUND", `no observation '${observationId}' exists in the current run`, {
          runId: input.runId,
          observationId,
        });
      }
      if (!observation.promotable) {
        throw evidenceError("OBSERVATION_NOT_PROMOTABLE", `observation '${observationId}' is not promotable`, {
          observationId,
          ...(observation.sanitized === null ? {} : { sanitized: observation.sanitized }),
        });
      }
      return observation;
    });

    // §66 — corrupt/missing blobs fail promotion closed (§18).
    for (const observation of observations) {
      if (observation.payloadHash !== null) blobs.readBytes(observation.payloadHash);
    }

    // §31 — exact upstream revisions, same run, must exist.
    for (const ref of derivedFrom) {
      const upstream = getEvidenceRevisionRecord(store, input.runId, ref.evidenceId, ref.revision);
      if (upstream === null) {
        throw evidenceError(
          "EVIDENCE_REVISION_NOT_FOUND",
          `derived provenance references missing Evidence ${ref.evidenceId}@${ref.revision}`,
          { runId: input.runId, evidenceId: ref.evidenceId, revision: ref.revision },
        );
      }
    }

    // Server-derived validation strategy (documented rule above): only a
    // DIRECT claim resting entirely on fingerprint-carrying source
    // observations validates by fingerprint; anything derived, uncertain, or
    // citing locator/execution observations validates by reobserve.
    const sourceFingerprints = collectSourceFingerprints(observations);
    let validationStrategy: EvidenceValidationStrategy;
    if (derivedFrom.length > 0) {
      validationStrategy = "reobserve";
    } else if (
      request.confidence === "direct" &&
      observations.length > 0 &&
      observations.every((observation) => observation.observationClass === "source")
    ) {
      if (observations.some((observation) => observation.sourceFingerprint === null)) {
        throw evidenceError(
          "EVIDENCE_SOURCE_FINGERPRINT_UNAVAILABLE",
          "a fingerprint-validated claim requires source observations captured with a whole-file fingerprint",
          { observationIds: observationRefs },
        );
      }
      validationStrategy = "fingerprint";
    } else {
      validationStrategy = "reobserve";
    }

    const claim = request.claim.trim();
    const requestHash = createHash("sha256")
      .update(
        canonicalJson({
          claim,
          kind: request.kind,
          scope,
          confidence: request.confidence,
          criticality: request.criticality,
          observationRefs: [...observationRefs].sort(),
          derivedFrom: [...derivedFrom].sort(
            (a, b) => a.evidenceId.localeCompare(b.evidenceId) || a.revision - b.revision,
          ),
        }),
      )
      .digest("hex");

    const createdAt = clock.nowIso();
    return store.withWrite((tx) => {
      const inserted = insertEvidenceRevisionInTx(tx, {
        runId: input.runId,
        evidenceId: `ev_${clock.newId()}`,
        claim,
        kind: request.kind,
        scope,
        confidence: request.confidence,
        criticality: request.criticality,
        validationStrategy,
        repositoryContext: { repositoryRevision: observations[0]?.repositoryRevision ?? null },
        workspaceContext: { workspaceId: input.workspaceId },
        sourceFingerprints,
        observationRefs,
        derivedFrom,
        requestId: input.operationId,
        requestHash,
        createdAt,
      });
      if (inserted.status === "inserted") {
        tx.prepare(
          `INSERT INTO audit_events (event_id, run_id, event_type, subject_json, payload_json, created_at)
           VALUES (?, ?, 'EVIDENCE_PROMOTED', ?, ?, ?)`,
        ).run(
          `EVT-${clock.newId()}`,
          input.runId,
          canonicalJson({ evidenceId: inserted.evidence.evidenceId, revision: inserted.evidence.revision }),
          canonicalJson({
            claim,
            kind: request.kind,
            scope,
            confidence: request.confidence,
            criticality: request.criticality,
            validationStrategy,
            observationRefs,
            derivedFrom,
            requestId: input.operationId,
          }),
          createdAt,
        );
      }
      return { evidence: inserted.evidence, idempotent: inserted.status === "duplicate" };
    });
  }

  function readEvidenceRevision(
    runId: string,
    evidenceId: string,
    revision: number,
  ): EvidenceRevisionView | null {
    return getEvidenceRevisionRecord(store, runId, evidenceId, revision);
  }

  function listEvidence(runId: string, filter: ListEvidenceFilter = {}): EvidenceRevisionView[] {
    return listEvidenceRecord(store, runId, filter);
  }

  return { promoteEvidence, readEvidenceRevision, listEvidence };
}

function collectSourceFingerprints(observations: CapturedObservation[]): SourceFingerprint[] {
  const seen = new Set<string>();
  const fingerprints: SourceFingerprint[] = [];
  for (const observation of observations) {
    const fingerprint = observation.sourceFingerprint;
    if (fingerprint === null) continue;
    const key = `${fingerprint.path}:${fingerprint.sha256}`;
    if (seen.has(key)) continue;
    seen.add(key);
    fingerprints.push(fingerprint);
  }
  return fingerprints.sort((a, b) => a.path.localeCompare(b.path) || a.sha256.localeCompare(b.sha256));
}
