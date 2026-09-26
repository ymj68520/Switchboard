/**
 * Evidence freshness application service (Phase 10 §7/§9/§10/§14–§17/§20–§29/
 * §35/§37/§39–§41/§51/§52).
 *
 * Responsibilities:
 *  - promotion-time initialization (§10): every new revision enters its
 *    initial freshness state in the promotion transaction — fingerprint
 *    strategy re-checks the CURRENT whole-file hashes against the
 *    observation-time fingerprints; reobserve provenance starts fresh as
 *    last-known observation state; derived starts fresh only when every
 *    exact upstream revision is fresh;
 *  - deterministic revalidation (§21, mode=check, fingerprint only);
 *  - semantic revalidation (§22–§25, mode=assess): confirmed creates a NEW
 *    revision and stales the old one — never revives it; contradicted
 *    invalidates; uncertain stays needs_validation. The model can only
 *    express an assessment with real provenance; `state` is never input;
 *  - derived propagation (§16): SOURCE_CHANGED/REPLACED/INVALIDATED on an
 *    exact revision recursively moves fresh dependents to needs_validation
 *    within the same run, transactionally;
 *  - the Proposal critical-Evidence gate (§35/§39–§41), shared by the
 *    prepare path and the post-authorization commit path;
 *  - read models (§52): getEvidenceState / getEvidenceValidationHistory /
 *    resolveEvidenceProvenanceClosure.
 *
 * Reobserve semantics (§14/§45): commands are NEVER replayed — the only
 * deterministic drift signal is the recorded repository revision. Evidence
 * state mutation needs no human Approval (§28) but does need the exact
 * writable binding, an active run, and a stage capability.
 *
 * Idempotent replay (§27) reconstructs the §51 result envelope from the
 * operation's own validation events — no state is ever rewritten to answer a
 * retry, and a reused operation id with different semantics is an
 * IDEMPOTENCY_CONFLICT.
 */

import { createHash } from "node:crypto";

import { canonicalJson } from "../core/canonical-json.js";
import type { PlanningStage } from "../core/state-machine.js";
import {
  FRESHNESS_STATES,
  type FreshnessState,
  type ValidationEventType,
} from "../evidence/freshness.js";
import {
  checkAllSourceFingerprints,
  observeGitHeadSync,
} from "../evidence/fingerprint-check.js";
import { deriveValidationStrategy } from "../evidence/strategy.js";
import { RuntimeError } from "../runtime/errors.js";
import type { StoreClock } from "../store/migration-runner.js";
import type { PlanStore } from "../store/sqlite-store.js";
import type { StoreTx } from "../store/transaction.js";
import type { BlobStore } from "../store/blob-store.js";
import {
  appendValidationEventInTx,
  findEventsByRequest,
  getCurrentRevisionInTx,
  getCurrentStateInTx,
  getValidationHistory,
  listDerivedDependentsInTx,
  listProposalEvidenceRefsInTx,
  type EvidenceRef,
  type ValidationEventView,
} from "../store/evidence-freshness.js";
import {
  getEvidenceRevisionRecord,
  type DerivedFromRef,
  type EvidenceRevisionView,
  type EvidenceValidationStrategy,
} from "../store/evidence.js";
import { assertWritableBindingInTx } from "../store/session-bindings.js";
import type { CapturedObservation, SourceFingerprint } from "../observations/types.js";
import { getObservationRecord } from "../store/observations.js";

export { FRESHNESS_STATES };

/** §29: Evidence mutation stages. Synthesis/Validation/Final stay fail-closed. */
export const EVIDENCE_MUTATION_STAGES: readonly PlanningStage[] = ["discovery", "architecture", "detail"];

function freshnessError(
  code:
    | "EVIDENCE_STATE_INVALID"
    | "EVIDENCE_REVISION_NOT_CURRENT"
    | "EVIDENCE_REVISION_NOT_FOUND"
    | "EVIDENCE_REVALIDATION_INVALID"
    | "EVIDENCE_PROVENANCE_STALE"
    | "EVIDENCE_PROVENANCE_INVALID"
    | "IDEMPOTENCY_CONFLICT"
    | "CAPABILITY_NOT_AVAILABLE",
  message: string,
  detail?: Record<string, unknown>,
): RuntimeError {
  return new RuntimeError(code, message, { detail, recoverable: false });
}

/** Freshness details of one exact revision (read model, §51/§52). */
export interface EvidenceStateView {
  evidenceId: string;
  revision: number;
  state: FreshnessState | null;
  validationStrategy: EvidenceValidationStrategy;
}

function loadWorkspaceRootInTx(tx: StoreTx, workspaceId: string): string {
  const row = tx
    .prepare("SELECT canonical_root AS canonicalRoot FROM workspaces WHERE workspace_id = ?")
    .get(workspaceId) as { canonicalRoot: string } | undefined;
  if (row === undefined) {
    throw freshnessError("EVIDENCE_STATE_INVALID", "run workspace is not registered", { workspaceId });
  }
  return row.canonicalRoot;
}

function loadRevisionInTx(tx: StoreTx, runId: string, ref: EvidenceRef): EvidenceRevisionView {
  const revisionRow = getEvidenceRevisionRecordInTx(tx, runId, ref.evidenceId, ref.revision);
  if (revisionRow === null) {
    throw freshnessError("EVIDENCE_REVISION_NOT_FOUND", `no Evidence revision ${ref.evidenceId}@${ref.revision}`, {
      runId,
      ...ref,
    });
  }
  return revisionRow;
}

/**
 * In-transaction variant of the evidence revision loader (the Phase 9
 * store/evidence.ts loader owns a read-only PlanStore view; freshness moves
 * inside write transactions).
 */
function getEvidenceRevisionRecordInTx(
  tx: StoreTx,
  runId: string,
  evidenceId: string,
  revision: number,
): EvidenceRevisionView | null {
  const row = tx
    .prepare(
      `SELECT evidence_id AS evidenceId, revision, claim, kind,
              scope_json AS scopeJson, confidence, criticality,
              validation_strategy AS validationStrategy,
              repository_context_json AS repositoryContextJson,
              workspace_context_json AS workspaceContextJson,
              source_fingerprints_json AS sourceFingerprintsJson,
              request_id AS requestId, created_at AS createdAt
       FROM evidence_revisions WHERE run_id = ? AND evidence_id = ? AND revision = ?`,
    )
    .get(runId, evidenceId, revision) as
    | {
        evidenceId: string;
        revision: number;
        claim: string;
        kind: EvidenceRevisionView["kind"];
        scopeJson: string;
        confidence: EvidenceRevisionView["confidence"];
        criticality: EvidenceRevisionView["criticality"];
        validationStrategy: EvidenceValidationStrategy;
        repositoryContextJson: string;
        workspaceContextJson: string;
        sourceFingerprintsJson: string;
        requestId: string;
        createdAt: string;
      }
    | undefined;
  if (row === undefined) return null;
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
  return {
    runId,
    evidenceId: row.evidenceId,
    revision: row.revision,
    claim: row.claim,
    kind: row.kind,
    scope: JSON.parse(row.scopeJson),
    confidence: row.confidence,
    criticality: row.criticality,
    validationStrategy: row.validationStrategy,
    repositoryContext: JSON.parse(row.repositoryContextJson),
    workspaceContext: JSON.parse(row.workspaceContextJson),
    sourceFingerprints: JSON.parse(row.sourceFingerprintsJson),
    observationRefs,
    derivedFrom,
    requestId: row.requestId,
    createdAt: row.createdAt,
  };
}

// ---------------------------------------------------------------------------
// §10 — promotion-time initialization
// ---------------------------------------------------------------------------

export interface PromotionFreshnessOutcome {
  state: FreshnessState;
  reasonCode: string;
  detail: Record<string, unknown>;
}

/**
 * Compute (without writing) the §10 initial freshness state of a NEW revision
 * from its provenance. `upstreamStates` carries the materialized state of
 * each exact upstream revision at this moment.
 */
export function computePromotionInitialFreshness(input: {
  validationStrategy: EvidenceValidationStrategy;
  derivedFrom: DerivedFromRef[];
  sourceFingerprints: SourceFingerprint[];
  workspaceRoot: string;
  upstreamStates: Array<{ ref: EvidenceRef; state: FreshnessState | null }>;
}): PromotionFreshnessOutcome {
  if (input.derivedFrom.length > 0) {
    const allFresh = input.upstreamStates.every((upstream) => upstream.state === "fresh");
    return allFresh
      ? { state: "fresh", reasonCode: "promotion_reobserve_last_known", detail: { basis: "all exact upstream revisions fresh" } }
      : {
          state: "needs_validation",
          reasonCode: "promotion_upstream_not_fresh",
          detail: {
            upstream: input.upstreamStates
              .filter((upstream) => upstream.state !== "fresh")
              .map((upstream) => ({ ...upstream.ref, state: upstream.state })),
          },
        };
  }
  if (input.validationStrategy === "fingerprint") {
    const check = checkAllSourceFingerprints(input.workspaceRoot, input.sourceFingerprints);
    if (check.status === "match") {
      return {
        state: "fresh",
        reasonCode: "promotion_fingerprint_match",
        detail: { checked: input.sourceFingerprints.map((fingerprint) => fingerprint.path) },
      };
    }
    if (check.status === "mismatch") {
      return {
        state: "needs_validation",
        reasonCode: "promotion_fingerprint_mismatch",
        detail: { path: check.path, observedSha256: check.observedSha256 ?? null },
      };
    }
    return { state: "needs_validation", reasonCode: "promotion_source_unreadable", detail: { path: check.path } };
  }
  // Reobserve direct provenance: the promotion used a current real
  // Observation — fresh as last-known observation state (§10).
  return { state: "fresh", reasonCode: "promotion_reobserve_last_known", detail: {} };
}

/** Append the INITIALIZED event + materialized row for a fresh promotion (§10). */
export function initializePromotionFreshnessInTx(
  tx: StoreTx,
  input: {
    runId: string;
    workspaceId: string;
    evidenceId: string;
    revision: number;
    validationStrategy: EvidenceValidationStrategy;
    derivedFrom: DerivedFromRef[];
    sourceFingerprints: SourceFingerprint[];
    requestId: string;
    clock: StoreClock;
  },
): PromotionFreshnessOutcome {
  const workspaceRoot = loadWorkspaceRootInTx(tx, input.workspaceId);
  const upstreamStates = input.derivedFrom.map((ref) => ({
    ref: { evidenceId: ref.evidenceId, revision: ref.revision },
    state: getCurrentStateInTx(tx, input.runId, ref.evidenceId, ref.revision),
  }));
  const outcome = computePromotionInitialFreshness({
    validationStrategy: input.validationStrategy,
    derivedFrom: input.derivedFrom,
    sourceFingerprints: input.sourceFingerprints,
    workspaceRoot,
    upstreamStates,
  });
  appendValidationEventInTx(tx, {
    runId: input.runId,
    evidenceId: input.evidenceId,
    evidenceRevision: input.revision,
    eventType: "INITIALIZED",
    toState: outcome.state,
    reasonCode: outcome.reasonCode,
    detail: outcome.detail,
    eventId: `FRE-${input.clock.newId()}`,
    requestId: input.requestId,
    createdAt: input.clock.nowIso(),
  });
  return outcome;
}

// ---------------------------------------------------------------------------
// §16 — deterministic derived propagation
// ---------------------------------------------------------------------------

function keyOf(ref: EvidenceRef): string {
  return `${ref.evidenceId}@${ref.revision}`;
}

/**
 * Recursively move every FRESH derived dependent of `changedRef` to
 * needs_validation (UPSTREAM_CHANGED). Dependents already unresolved or
 * terminal are not re-evented (§16: only currently-fresh dependents
 * transition). Same run, same transaction, BFS over the exact EvidenceRef
 * graph. Returns the affected refs in propagation order.
 */
export function propagateDerivedChangeInTx(
  tx: StoreTx,
  input: {
    runId: string;
    changedRef: EvidenceRef;
    cause: "SOURCE_CHANGED" | "REPLACED" | "INVALIDATED";
    requestId?: string | null;
    clock: StoreClock;
  },
): EvidenceRef[] {
  const affected: EvidenceRef[] = [];
  const visited = new Set<string>([keyOf(input.changedRef)]);
  const queue: EvidenceRef[] = [input.changedRef];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const dependent of listDerivedDependentsInTx(tx, input.runId, current)) {
      if (visited.has(keyOf(dependent))) continue;
      visited.add(keyOf(dependent));
      const state = getCurrentStateInTx(tx, input.runId, dependent.evidenceId, dependent.revision);
      if (state !== "fresh") continue;
      appendValidationEventInTx(tx, {
        runId: input.runId,
        evidenceId: dependent.evidenceId,
        evidenceRevision: dependent.revision,
        eventType: "UPSTREAM_CHANGED",
        toState: "needs_validation",
        reasonCode: "upstream_revision_changed",
        detail: { upstream: current, cause: input.cause },
        eventId: `FRE-${input.clock.newId()}`,
        requestId: input.requestId ?? null,
        createdAt: input.clock.nowIso(),
      });
      affected.push(dependent);
      queue.push(dependent);
    }
  }
  return affected;
}

// ---------------------------------------------------------------------------
// §39/§40 — Proposal critical-Evidence gate
// ---------------------------------------------------------------------------

export interface EvidenceGateFailure {
  evidence_id: string;
  revision: number;
  state: FreshnessState | null;
  reason: string;
  validation_strategy: EvidenceValidationStrategy;
}

export interface EvidenceGateOutcome {
  ok: boolean;
  failures: EvidenceGateFailure[];
}

/**
 * Evaluate the critical requiredEvidence set for a Proposal (§35 prepare /
 * §39 commit). With `recheck: false` (prepare) only the materialized state is
 * consulted. With `recheck: true` (post-authorization, §36/§37/§40) the gate
 * walks the full provenance closure of critical evidence: fingerprint sources
 * are re-hashed, reobserve sources get the coarse repository-revision check,
 * and any discovered change is PERSISTED IN-TX (SOURCE_CHANGED + derived
 * propagation) even when the caller aborts the commit (§37).
 *
 * Supporting/informational evidence never blocks (§41/E34).
 */
export function evaluateCriticalEvidenceGateInTx(
  tx: StoreTx,
  input: {
    runId: string;
    workspaceId: string;
    requiredRefs: EvidenceRef[];
    recheck: boolean;
    clock: StoreClock;
  },
): EvidenceGateOutcome {
  const failures: EvidenceGateFailure[] = [];
  const visited = new Set<string>();

  const check = (ref: EvidenceRef): void => {
    const key = keyOf(ref);
    if (visited.has(key)) return;
    visited.add(key);

    const revision = loadRevisionInTx(tx, input.runId, ref);
    if (revision.criticality !== "critical") return; // §41: only critical blocks
    const state = getCurrentStateInTx(tx, input.runId, ref.evidenceId, ref.revision);
    if (state !== "fresh") {
      failures.push({
        evidence_id: ref.evidenceId,
        revision: ref.revision,
        state,
        reason: state === null ? "no freshness state exists for this revision" : `materialized state is ${state}`,
        validation_strategy: revision.validationStrategy,
      });
      return;
    }
    if (!input.recheck) return;

    const workspaceRoot = loadWorkspaceRootInTx(tx, input.workspaceId);
    let change:
      | { reasonCode: "revalidation_check_changed" | "revalidation_check_source_unreadable" | "git_repository_revision_drift"; detail: Record<string, unknown> }
      | null = null;
    if (revision.validationStrategy === "fingerprint") {
      const result = checkAllSourceFingerprints(workspaceRoot, revision.sourceFingerprints);
      if (result.status === "mismatch") {
        change = {
          reasonCode: "revalidation_check_changed",
          detail: { path: result.path, observedSha256: result.observedSha256 ?? null },
        };
      } else if (result.status === "unreadable") {
        change = { reasonCode: "revalidation_check_source_unreadable", detail: { path: result.path } };
      }
    } else {
      const recorded = revision.repositoryContext.repositoryRevision;
      if (recorded !== null && recorded !== undefined) {
        const current = observeGitHeadSync(workspaceRoot);
        if (current !== null && current !== recorded) {
          change = { reasonCode: "git_repository_revision_drift", detail: { recorded, current } };
        }
      }
    }
    if (change !== null) {
      appendValidationEventInTx(tx, {
        runId: input.runId,
        evidenceId: ref.evidenceId,
        evidenceRevision: ref.revision,
        eventType: "SOURCE_CHANGED",
        toState: "needs_validation",
        reasonCode: change.reasonCode,
        detail: change.detail,
        eventId: `FRE-${input.clock.newId()}`,
        createdAt: input.clock.nowIso(),
      });
      failures.push({
        evidence_id: ref.evidenceId,
        revision: ref.revision,
        state: "needs_validation",
        reason: change.reasonCode,
        validation_strategy: revision.validationStrategy,
      });
      return;
    }
    // Provenance closure (§40): derived evidence checks its exact upstreams.
    for (const upstream of revision.derivedFrom) {
      check(upstream);
    }
  };

  for (const ref of input.requiredRefs) {
    const exists = tx
      .prepare("SELECT 1 AS one FROM evidence_revisions WHERE run_id = ? AND evidence_id = ? AND revision = ?")
      .get(input.runId, ref.evidenceId, ref.revision);
    if (exists === undefined) {
      failures.push({
        evidence_id: ref.evidenceId,
        revision: ref.revision,
        state: null,
        reason: "required Evidence revision does not exist in this run",
        validation_strategy: "reobserve",
      });
      continue;
    }
    check(ref);
  }
  return { ok: failures.length === 0, failures };
}

// ---------------------------------------------------------------------------
// §20–§29 — revalidate_evidence
// ---------------------------------------------------------------------------

export type RevalidationMode = "check" | "assess";
export type RevalidationAssessment = "confirmed" | "contradicted" | "uncertain";

export interface RevalidateEvidenceRequest {
  evidenceId: string;
  revision: number;
  mode: RevalidationMode;
  assessment?: RevalidationAssessment;
  observationRefs: string[];
  derivedFrom: DerivedFromRef[];
}

export interface RevalidateEvidenceInput {
  runId: string;
  workspaceId: string;
  sessionId: string;
  bindingGeneration: number;
  request: RevalidateEvidenceRequest;
  /** Derived from the signed HostContext tool use (§27) — never model input. */
  operationId: string;
}

export interface RevalidateEvidenceResult {
  status: "validated" | "source_changed" | "confirmed" | "contradicted" | "uncertain";
  idempotent: boolean;
  target: {
    evidence_id: string;
    revision: number;
    previous_state: FreshnessState | null;
    current_state: FreshnessState;
  };
  replacement?: { evidence_id: string; revision: number; state: FreshnessState };
  affected_derived?: EvidenceRef[];
  reason: string;
}

function requestHashOf(request: RevalidateEvidenceRequest): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        evidenceId: request.evidenceId,
        revision: request.revision,
        mode: request.mode,
        assessment: request.assessment ?? null,
        observationRefs: [...request.observationRefs].sort(),
        derivedFrom: [...request.derivedFrom].sort(
          (a, b) => a.evidenceId.localeCompare(b.evidenceId) || a.revision - b.revision,
        ),
      }),
    )
    .digest("hex");
}

const PRIMARY_REPLAY_EVENT_TYPES: readonly ValidationEventType[] = [
  "FINGERPRINT_VALIDATED",
  "SOURCE_CHANGED",
  "REPLACED",
  "INVALIDATED",
  "REVALIDATION_UNCERTAIN",
];

/**
 * Reconstruct the §51 result envelope from a prior operation's events (§27).
 * Deterministic: the primary event carries the verdict, UPSTREAM_CHANGED
 * events carry the propagation.
 */
function replayFromEvents(events: ValidationEventView[], requestHash: string): RevalidateEvidenceResult {
  const primary = events.find((event) => PRIMARY_REPLAY_EVENT_TYPES.includes(event.eventType));
  const recordedHash = primary?.detail as { requestHash?: string } | undefined;
  if (primary === undefined || recordedHash?.requestHash !== requestHash) {
    throw new RuntimeError(
      "IDEMPOTENCY_CONFLICT",
      "this revalidation operation id was already used with a different semantic payload",
      { detail: { requestId: primary?.requestId ?? null } },
    );
  }
  const affected = events
    .filter((event) => event.eventType === "UPSTREAM_CHANGED")
    .map((event) => ({ evidenceId: event.evidenceId, revision: event.evidenceRevision }));
  const target = {
    evidence_id: primary.evidenceId,
    revision: primary.evidenceRevision,
    previous_state: primary.fromState,
    current_state: primary.toState,
  };
  switch (primary.eventType) {
    case "FINGERPRINT_VALIDATED":
      return { status: "validated", idempotent: true, target, reason: primary.reasonCode };
    case "SOURCE_CHANGED":
      return {
        status: "source_changed",
        idempotent: true,
        target,
        ...(affected.length > 0 ? { affected_derived: affected } : {}),
        reason: primary.reasonCode,
      };
    case "REPLACED": {
      const initialized = events.find(
        (event) => event.eventType === "INITIALIZED" && (event.detail as { supersedes?: number }).supersedes === primary.evidenceRevision,
      );
      if (initialized === undefined) {
        throw new RuntimeError("STORE_SCHEMA_INVALID", "replaced revision has no replacement event", {
          detail: { requestId: primary.requestId },
        });
      }
      return {
        status: "confirmed",
        idempotent: true,
        target,
        replacement: { evidence_id: initialized.evidenceId, revision: initialized.evidenceRevision, state: initialized.toState },
        ...(affected.length > 0 ? { affected_derived: affected } : {}),
        reason: primary.reasonCode,
      };
    }
    case "INVALIDATED":
      return {
        status: "contradicted",
        idempotent: true,
        target,
        ...(affected.length > 0 ? { affected_derived: affected } : {}),
        reason: primary.reasonCode,
      };
    case "REVALIDATION_UNCERTAIN":
      return { status: "uncertain", idempotent: true, target, reason: primary.reasonCode };
    default:
      throw new RuntimeError("STORE_SCHEMA_INVALID", "unreplayable revalidation event", {
        detail: { eventType: primary.eventType },
      });
  }
}

export function createEvidenceFreshnessService(store: PlanStore, blobs: BlobStore, clock: StoreClock) {
  /** Validate the new provenance a semantic assessment must carry (§22). */
  function validateNewProvenance(
    runId: string,
    request: RevalidateEvidenceRequest,
  ): { observations: CapturedObservation[]; derivedFrom: DerivedFromRef[] } {
    if (request.observationRefs.length === 0 && request.derivedFrom.length === 0) {
      throw freshnessError(
        "EVIDENCE_REVALIDATION_INVALID",
        "a semantic assessment requires new provenance (observation_refs or derived_from)",
        { evidenceId: request.evidenceId, revision: request.revision },
      );
    }
    const observations = request.observationRefs.map((observationId) => {
      const observation = getObservationRecord(store, runId, observationId);
      if (observation === null) {
        throw freshnessError("EVIDENCE_PROVENANCE_INVALID", `no observation '${observationId}' exists in the current run`, {
          observationId,
        });
      }
      if (!observation.promotable) {
        throw freshnessError("EVIDENCE_PROVENANCE_INVALID", `observation '${observationId}' is not promotable`, { observationId });
      }
      return observation;
    });
    for (const ref of request.derivedFrom) {
      const upstream = getEvidenceRevisionRecord(store, runId, ref.evidenceId, ref.revision);
      if (upstream === null) {
        throw freshnessError(
          "EVIDENCE_PROVENANCE_INVALID",
          `assessment provenance references missing Evidence ${ref.evidenceId}@${ref.revision}`,
          { evidenceId: ref.evidenceId, revision: ref.revision },
        );
      }
    }
    // Corrupt/missing payload blobs fail the assessment closed (Phase 9 §66).
    for (const observation of observations) {
      if (observation.payloadHash !== null) blobs.readBytes(observation.payloadHash);
    }
    return { observations, derivedFrom: request.derivedFrom };
  }

  function gateRunAndBinding(input: RevalidateEvidenceInput): void {
    const runRow = store.withRead(
      (tx) =>
        tx
          .prepare("SELECT stage AS stage, lifecycle AS lifecycle, workspace_id AS workspaceId FROM planning_runs WHERE run_id = ?")
          .get(input.runId) as { stage: PlanningStage; lifecycle: string; workspaceId: string } | undefined,
    );
    if (runRow === undefined) {
      throw freshnessError("EVIDENCE_STATE_INVALID", `no PlanningRun exists for '${input.runId}'`, { runId: input.runId });
    }
    if (runRow.workspaceId !== input.workspaceId) {
      throw freshnessError("EVIDENCE_STATE_INVALID", "revalidation is scoped to the run's own workspace", { runId: input.runId });
    }
    if (runRow.lifecycle !== "active") {
      throw freshnessError("EVIDENCE_STATE_INVALID", `PlanningRun '${input.runId}' is not active`, { runId: input.runId });
    }
    if (!(EVIDENCE_MUTATION_STAGES as readonly string[]).includes(runRow.stage)) {
      throw freshnessError(
        "CAPABILITY_NOT_AVAILABLE",
        `Evidence revalidation is not available at stage '${runRow.stage}' (available: ${EVIDENCE_MUTATION_STAGES.join(", ")})`,
      );
    }
    store.withRead((tx) => {
      assertWritableBindingInTx(tx, {
        runId: input.runId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        generation: input.bindingGeneration,
      });
      return null;
    });
  }

  function assertTargetCurrentAndMutable(runId: string, request: RevalidateEvidenceRequest): {
    revision: EvidenceRevisionView;
    state: FreshnessState;
  } {
    const revision = getEvidenceRevisionRecord(store, runId, request.evidenceId, request.revision);
    if (revision === null) {
      throw freshnessError("EVIDENCE_REVISION_NOT_FOUND", `no Evidence revision ${request.evidenceId}@${request.revision}`, {
        runId,
        evidenceId: request.evidenceId,
        revision: request.revision,
      });
    }
    const state = store.withRead((tx) => getCurrentStateInTx(tx, runId, request.evidenceId, request.revision));
    if (state === null) {
      throw freshnessError(
        "EVIDENCE_STATE_INVALID",
        `Evidence ${request.evidenceId}@${request.revision} has no freshness state; it predates the freshness foundation`,
        { evidenceId: request.evidenceId, revision: request.revision },
      );
    }
    const currentRevision = store.withRead((tx) => getCurrentRevisionInTx(tx, runId, request.evidenceId));
    if (currentRevision !== null && currentRevision !== request.revision) {
      // §26 takes precedence for historical revisions: stale or not, they can
      // never again influence the current Evidence lineage.
      throw freshnessError(
        "EVIDENCE_REVISION_NOT_CURRENT",
        `Evidence ${request.evidenceId}@${request.revision} is historical; only the current revision @${currentRevision} can be revalidated`,
        { evidenceId: request.evidenceId, revision: request.revision, currentRevision },
      );
    }
    if (state === "stale" || state === "invalidated") {
      throw freshnessError(
        "EVIDENCE_STATE_INVALID",
        `Evidence ${request.evidenceId}@${request.revision} is terminal (${state}) and cannot be revalidated; promote new provenance instead`,
        { evidenceId: request.evidenceId, revision: request.revision, state },
      );
    }
    return { revision, state };
  }

  function revalidateEvidence(input: RevalidateEvidenceInput): RevalidateEvidenceResult {
    gateRunAndBinding(input);
    const request = input.request;
    if (request.mode !== "check" && request.mode !== "assess") {
      throw freshnessError("EVIDENCE_REVALIDATION_INVALID", "mode must be 'check' or 'assess'");
    }
    const { state } = assertTargetCurrentAndMutable(input.runId, request);
    const hash = requestHashOf(request);

    // Idempotent replay (§27): the recorded events ARE the answer.
    const prior = findEventsByRequest(store, input.runId, input.operationId);
    if (prior.length > 0) {
      return replayFromEvents(prior, hash);
    }

    if (request.mode === "check") {
      if (request.assessment !== undefined) {
        throw freshnessError("EVIDENCE_REVALIDATION_INVALID", "mode=check takes no assessment");
      }
      if (request.observationRefs.length > 0 || request.derivedFrom.length > 0) {
        throw freshnessError("EVIDENCE_REVALIDATION_INVALID", "mode=check takes no new provenance");
      }
      if (state === null) {
        throw freshnessError("EVIDENCE_STATE_INVALID", "this revision has no freshness state to check", {
          evidenceId: request.evidenceId,
          revision: request.revision,
        });
      }
      return store.withWrite((tx) => {
        const revision = loadRevisionInTx(tx, input.runId, {
          evidenceId: request.evidenceId,
          revision: request.revision,
        });
        if (revision.validationStrategy !== "fingerprint") {
          throw freshnessError(
            "EVIDENCE_REVALIDATION_INVALID",
            "deterministic check applies only to fingerprint-validated Evidence",
            { validationStrategy: revision.validationStrategy },
          );
        }
        const workspaceRoot = loadWorkspaceRootInTx(tx, input.workspaceId);
        const result = checkAllSourceFingerprints(workspaceRoot, revision.sourceFingerprints);
        if (result.status === "match") {
          appendValidationEventInTx(tx, {
            runId: input.runId,
            evidenceId: request.evidenceId,
            evidenceRevision: request.revision,
            eventType: "FINGERPRINT_VALIDATED",
            toState: "fresh",
            reasonCode: "revalidation_check_unchanged",
            detail: { checked: revision.sourceFingerprints.map((fingerprint) => fingerprint.path), requestHash: hash },
            eventId: `FRE-${clock.newId()}`,
            requestId: input.operationId,
            createdAt: clock.nowIso(),
          });
          return {
            status: "validated" as const,
            idempotent: false,
            target: { evidence_id: request.evidenceId, revision: request.revision, previous_state: state, current_state: "fresh" as const },
            reason: "revalidation_check_unchanged",
          };
        }
        appendValidationEventInTx(tx, {
          runId: input.runId,
          evidenceId: request.evidenceId,
          evidenceRevision: request.revision,
          eventType: "SOURCE_CHANGED",
          toState: "needs_validation",
          reasonCode: result.status === "mismatch" ? "revalidation_check_changed" : "revalidation_check_source_unreadable",
          detail: {
            path: result.path,
            ...(result.observedSha256 !== undefined ? { observedSha256: result.observedSha256 } : {}),
            requestHash: hash,
          },
          eventId: `FRE-${clock.newId()}`,
          requestId: input.operationId,
          createdAt: clock.nowIso(),
        });
        const affected = propagateDerivedChangeInTx(tx, {
          runId: input.runId,
          changedRef: { evidenceId: request.evidenceId, revision: request.revision },
          cause: "SOURCE_CHANGED",
          requestId: input.operationId,
          clock,
        });
        return {
          status: "source_changed" as const,
          idempotent: false,
          target: {
            evidence_id: request.evidenceId,
            revision: request.revision,
            previous_state: state,
            current_state: "needs_validation" as const,
          },
          ...(affected.length > 0 ? { affected_derived: affected } : {}),
          reason: result.status === "mismatch" ? "revalidation_check_changed" : "revalidation_check_source_unreadable",
        };
      });
    }

    // mode = assess (§22–§25)
    if (request.assessment !== "confirmed" && request.assessment !== "contradicted" && request.assessment !== "uncertain") {
      throw freshnessError("EVIDENCE_REVALIDATION_INVALID", "assessment must be confirmed, contradicted, or uncertain");
    }
    const { observations } = validateNewProvenance(input.runId, request);
    const derivedFrom = request.derivedFrom;

    return store.withWrite((tx) => {
      const workspaceRoot = loadWorkspaceRootInTx(tx, input.workspaceId);
      const at = clock.nowIso();
      const targetRef = { evidenceId: request.evidenceId, revision: request.revision };

      if (request.assessment === "uncertain") {
        appendValidationEventInTx(tx, {
          runId: input.runId,
          evidenceId: request.evidenceId,
          evidenceRevision: request.revision,
          eventType: "REVALIDATION_UNCERTAIN",
          toState: "needs_validation",
          reasonCode: "revalidation_uncertain",
          detail: {
            provenance: {
              observationRefs: [...request.observationRefs].sort(),
              derivedFrom: [...derivedFrom].sort((a, b) => a.evidenceId.localeCompare(b.evidenceId) || a.revision - b.revision),
            },
            requestHash: hash,
          },
          eventId: `FRE-${clock.newId()}`,
          requestId: input.operationId,
          createdAt: at,
        });
        return {
          status: "uncertain" as const,
          idempotent: false,
          target: {
            evidence_id: request.evidenceId,
            revision: request.revision,
            previous_state: state,
            current_state: "needs_validation" as const,
          },
          reason: "revalidation_uncertain",
        };
      }

      if (request.assessment === "contradicted") {
        appendValidationEventInTx(tx, {
          runId: input.runId,
          evidenceId: request.evidenceId,
          evidenceRevision: request.revision,
          eventType: "INVALIDATED",
          toState: "invalidated",
          reasonCode: "revalidation_contradicted",
          detail: {
            contradictionProvenance: {
              observationRefs: [...request.observationRefs].sort(),
              derivedFrom: [...derivedFrom].sort((a, b) => a.evidenceId.localeCompare(b.evidenceId) || a.revision - b.revision),
            },
            requestHash: hash,
          },
          eventId: `FRE-${clock.newId()}`,
          requestId: input.operationId,
          createdAt: at,
        });
        const affected = propagateDerivedChangeInTx(tx, {
          runId: input.runId,
          changedRef: targetRef,
          cause: "INVALIDATED",
          requestId: input.operationId,
          clock,
        });
        return {
          status: "contradicted" as const,
          idempotent: false,
          target: {
            evidence_id: request.evidenceId,
            revision: request.revision,
            previous_state: state,
            current_state: "invalidated" as const,
          },
          ...(affected.length > 0 ? { affected_derived: affected } : {}),
          reason: "revalidation_contradicted",
        };
      }

      // confirmed (§23): create EV-X@(N+1) with the same claim semantics and
      // NEW provenance; the replacement must itself validate fresh, or the
      // whole revalidation fails without creating anything.
      const priorRevision = loadRevisionInTx(tx, input.runId, targetRef);
      const sourceFingerprints = collectSourceFingerprints(observations);
      const strategy = deriveValidationStrategy({
        confidence: priorRevision.confidence,
        derivedFromCount: derivedFrom.length,
        observations,
      });
      const upstreamStates = derivedFrom.map((ref) => ({
        ref: { evidenceId: ref.evidenceId, revision: ref.revision },
        state: getCurrentStateInTx(tx, input.runId, ref.evidenceId, ref.revision),
      }));
      const outcome = computePromotionInitialFreshness({
        validationStrategy: strategy,
        derivedFrom,
        sourceFingerprints,
        workspaceRoot,
        upstreamStates,
      });
      if (outcome.state !== "fresh") {
        throw freshnessError(
          "EVIDENCE_PROVENANCE_STALE",
          "the confirmed assessment's new provenance cannot validate fresh; revalidation failed without creating a revision",
          { reason: outcome.reasonCode, detail: outcome.detail },
        );
      }
      const insertResult = tx
        .prepare(
          `INSERT INTO evidence_revisions (
             run_id, evidence_id, revision, claim, kind, scope_json, confidence, criticality,
             validation_strategy, repository_context_json, workspace_context_json,
             source_fingerprints_json, request_id, request_hash, created_at
           ) VALUES (?, ?, (SELECT COALESCE(MAX(revision), 0) + 1 FROM evidence_revisions WHERE run_id = ? AND evidence_id = ?),
             ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.runId,
          request.evidenceId,
          input.runId,
          request.evidenceId,
          priorRevision.claim,
          priorRevision.kind,
          canonicalJson(priorRevision.scope),
          priorRevision.confidence,
          priorRevision.criticality,
          strategy,
          canonicalJson({
            repositoryRevision:
              observations[0]?.repositoryRevision ?? priorRevision.repositoryContext.repositoryRevision ?? null,
          }),
          canonicalJson(priorRevision.workspaceContext),
          canonicalJson(sourceFingerprints),
          input.operationId,
          hash,
          at,
        );
      if (((insertResult as { changes?: number }).changes ?? 0) !== 1) {
        throw new RuntimeError("STORE_SCHEMA_INVALID", "replacement revision insert failed", {
          detail: { evidenceId: request.evidenceId },
        });
      }
      const newRevision = getCurrentRevisionInTx(tx, input.runId, request.evidenceId);
      if (newRevision === null) {
        throw new RuntimeError("STORE_SCHEMA_INVALID", "replacement revision vanished in-transaction", {
          detail: { evidenceId: request.evidenceId },
        });
      }
      // Provenance links for the replacement (sorted, same as promotion).
      [...request.observationRefs].sort().forEach((observationId, index) => {
        tx.prepare(
          `INSERT INTO evidence_observation_refs (run_id, evidence_id, revision, observation_id, ref_position)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(input.runId, request.evidenceId, newRevision, observationId, index + 1);
      });
      [...derivedFrom]
        .sort((a, b) => a.evidenceId.localeCompare(b.evidenceId) || a.revision - b.revision)
        .forEach((ref, index) => {
          tx.prepare(
            `INSERT INTO evidence_derived_refs (run_id, evidence_id, revision, derived_from_evidence_id, derived_from_revision, ref_position)
             VALUES (?, ?, ?, ?, ?, ?)`,
          ).run(input.runId, request.evidenceId, newRevision, ref.evidenceId, ref.revision, index + 1);
        });

      // New revision → fresh (INITIALIZED); old revision → stale (REPLACED);
      // derived dependents of the OLD exact revision → needs_validation (§23).
      appendValidationEventInTx(tx, {
        runId: input.runId,
        evidenceId: request.evidenceId,
        evidenceRevision: newRevision,
        eventType: "INITIALIZED",
        toState: "fresh",
        reasonCode: "revalidation_confirmed_replacement",
        detail: { supersedes: request.revision, strategy, requestHash: hash },
        eventId: `FRE-${clock.newId()}`,
        requestId: input.operationId,
        createdAt: at,
      });
      appendValidationEventInTx(tx, {
        runId: input.runId,
        evidenceId: request.evidenceId,
        evidenceRevision: request.revision,
        eventType: "REPLACED",
        toState: "stale",
        reasonCode: "revalidation_confirmed_replacement",
        detail: { replacedBy: newRevision, requestHash: hash },
        eventId: `FRE-${clock.newId()}`,
        requestId: input.operationId,
        createdAt: at,
      });
      const affected = propagateDerivedChangeInTx(tx, {
        runId: input.runId,
        changedRef: targetRef,
        cause: "REPLACED",
        requestId: input.operationId,
        clock,
      });
      // Provenance, never authority: a replacement is an evidence write, so
      // it joins EVIDENCE_PROMOTED (the audit log stays untouched otherwise —
      // §74: freshness transitions have their own event authority).
      tx.prepare(
        `INSERT INTO audit_events (event_id, run_id, event_type, subject_json, payload_json, created_at)
         VALUES (?, ?, 'EVIDENCE_PROMOTED', ?, ?, ?)`,
      ).run(
        `EVT-${clock.newId()}`,
        input.runId,
        canonicalJson({ evidenceId: request.evidenceId, revision: newRevision }),
        canonicalJson({
          claim: priorRevision.claim,
          kind: priorRevision.kind,
          scope: priorRevision.scope,
          confidence: priorRevision.confidence,
          criticality: priorRevision.criticality,
          validationStrategy: strategy,
          observationRefs: [...request.observationRefs].sort(),
          derivedFrom: [...derivedFrom].sort((a, b) => a.evidenceId.localeCompare(b.evidenceId) || a.revision - b.revision),
          requestId: input.operationId,
          revalidationReplacement: request.revision,
        }),
        at,
      );
      return {
        status: "confirmed" as const,
        idempotent: false,
        target: { evidence_id: request.evidenceId, revision: request.revision, previous_state: state, current_state: "stale" as const },
        replacement: { evidence_id: request.evidenceId, revision: newRevision, state: "fresh" as const },
        ...(affected.length > 0 ? { affected_derived: affected } : {}),
        reason: "revalidation_confirmed_replacement",
      };
    });
  }

  return { revalidateEvidence };
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

// ---------------------------------------------------------------------------
// §52 — application read models
// ---------------------------------------------------------------------------

export function createEvidenceFreshnessReadModels(store: PlanStore) {
  return {
    getEvidenceState(runId: string, evidenceId: string, revision: number): EvidenceStateView {
      const revisionRow = getEvidenceRevisionRecord(store, runId, evidenceId, revision);
      if (revisionRow === null) {
        throw freshnessError("EVIDENCE_REVISION_NOT_FOUND", `no Evidence revision ${evidenceId}@${revision}`, {
          runId,
          evidenceId,
          revision,
        });
      }
      const state = store.withRead((tx) => getCurrentStateInTx(tx, runId, evidenceId, revision));
      return { evidenceId, revision, state, validationStrategy: revisionRow.validationStrategy };
    },

    getEvidenceValidationHistory(runId: string, evidenceId: string, revision: number): ValidationEventView[] {
      return getValidationHistory(store, runId, evidenceId, revision);
    },

    resolveEvidenceProvenanceClosure(runId: string, evidenceId: string, revision: number): EvidenceRef[] {
      return store.withRead((tx) => {
        const closure: EvidenceRef[] = [];
        const visited = new Set<string>();
        const queue: EvidenceRef[] = [{ evidenceId, revision }];
        while (queue.length > 0) {
          const current = queue.shift()!;
          const revisionRow = getEvidenceRevisionRecordInTx(tx, runId, current.evidenceId, current.revision);
          if (revisionRow === null) continue;
          for (const upstream of revisionRow.derivedFrom) {
            if (visited.has(keyOf(upstream))) continue;
            visited.add(keyOf(upstream));
            closure.push(upstream);
            queue.push(upstream);
          }
        }
        return closure.sort((a, b) => a.evidenceId.localeCompare(b.evidenceId) || a.revision - b.revision);
      });
    },

    listProposalEvidenceRefs: listProposalEvidenceRefsInTx,
  };
}
