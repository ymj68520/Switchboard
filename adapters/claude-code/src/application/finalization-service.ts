/**
 * Finalization application service (Phase 13 §2/§6–§11/§15–§29/§65–§77).
 *
 * Authority model (§1): the FinalizationGate itself is the PURE core
 * evaluator (core/finalization.ts); this layer loads FinalizationFacts from
 * the authoritative Store, runs the deterministic Evidence audit (§6–§11 —
 * the ONLY place fingerprint/git checks happen), and owns the two legal
 * finalization transactions:
 *
 *   request_finalization (§29)  gate → [pre-approval audit + candidate +
 *                               final Proposal + VALIDATION_CLEAN
 *                               validation→final + run revision +1] atomically
 *   commit-time rerun (§48)     exact candidate reload + hash revalidation +
 *                               full gate rerun + commit-time audit BEFORE any
 *                               Approval/PlanCommit/FinalPlan row is written
 *
 * §3 — the second gate never trusts the first: nothing derived at
 * request_finalization time is carried into the authorization beyond the
 * frozen candidate identity itself; every world fact is reloaded.
 *
 * §10/§11 — the audit NEVER replays commands: a reobserve revision needing
 * re-observation blocks finalization; discovered source changes persist as
 * real freshness events + Section review facts even when the gate denies.
 */

import { canonicalJson } from "../core/canonical-json.js";
import { nextStage } from "../core/state-machine.js";
import type { MemoryRef } from "../core/memory-refs.js";
import { RuntimeError } from "../runtime/errors.js";
import {
  evidenceAuditHash,
  evaluateFinalization,
  finalPlanCandidateHash,
  type CandidateEvidenceRef,
  type CandidateItemRef,
  type CandidateSectionRef,
  type EvidenceAuditEntry,
  type EvidenceAuditSnapshotV1,
  type FinalizationDecision,
  type FinalizationEvidenceFact,
  type FinalizationFacts,
  type FinalizationReason,
  type FinalPlanCandidateV1,
} from "../core/finalization.js";
import type { SynthesisManifestV1 } from "../core/synthesis.js";
import { buildFinalPlanProposalCanonical, canonicalProposalHash } from "../core/proposal-canonical.js";
import { parsePlanningRunRow, type PlanningRun } from "../core/planning-run.js";
import { checkAllSourceFingerprints, observeGitHeadSync } from "../evidence/fingerprint-check.js";
import { assertWritableBindingInTx } from "../store/session-bindings.js";
import { getHeadPairInTx } from "../store/plan-commits.js";
import { getSnapshotRefsInTx } from "../store/plan-memory.js";
import { runStateError } from "../store/planning-runs.js";
import { getActiveSectionInTx, listSectionWorkflowStatesInTx } from "../store/section-workflow.js";
import { getBaselineScopeForSectionInTx } from "../store/successor-baselines.js";
import {
  appendValidationEventInTx,
  getCurrentStateInTx,
  type EvidenceRef,
} from "../store/evidence-freshness.js";
import {
  getLatestEvidenceAuditInTx,
  getFinalPlanCandidateByRequestInTx,
  getFinalPlanCandidateInTx,
  getLatestFinalPlanCandidateInTx,
  getProposalFinalPlanRefInTx,
  insertEvidenceAuditSnapshotInTx,
  insertFinalPlanCandidateInTx,
  insertProposalFinalPlanRefInTx,
  listEvidenceAuditEntriesInTx,
  nextCandidateSeqInTx,
  type CandidateRefFamily,
  type EvidenceAuditPurpose,
  type EvidenceAuditEntryRow,
  type FinalPlanCandidateRefRow,
} from "../store/finalization.js";
import {
  getLatestSynthesisInputInTx,
  getSynthesisManifestByInputInTx,
  getValidationReportByManifestInTx,
  listSynthesisInputEvidenceInTx,
  listSynthesisInputRefsInTx,
} from "../store/synthesis.js";
import {
  insertProposalIdentityInTx,
  insertProposalRevisionInTx,
  insertProposalStateInTx,
} from "../store/proposals.js";
import { propagateEvidenceSectionReviewInTx } from "./section-workflow-service.js";
import { listRelevantEvidenceInTx } from "./synthesis-service.js";
import { propagateDerivedChangeInTx } from "./evidence-freshness-service.js";
import type { PlanStore } from "../store/sqlite-store.js";
import type { StoreClock } from "../store/migration-runner.js";
import type { StoreTx } from "../store/transaction.js";
import type { CallerAgent } from "./synthesis-service.js";

/** The audit scope keys are exact Evidence revisions (§7). */
function evidenceKey(ref: { evidenceId: string; revision: number }): string {
  return `${ref.evidenceId}\u0000${ref.revision}`;
}

export function finalizationDeniedError(reasons: FinalizationReason[]): RuntimeError {
  return new RuntimeError(
    "FINALIZATION_DENIED",
    `the FinalizationGate denied finalization for ${reasons.length} reason(s)`,
    { detail: { reasons }, recoverable: false },
  );
}

function finalizationError(
  code:
    | "FINALIZATION_ALREADY_PREPARED"
    | "FINAL_PLAN_CANDIDATE_REQUIRED"
    | "FINAL_PLAN_CANDIDATE_STALE"
    | "FINAL_PLAN_PROPOSAL_INVALID"
    | "EVIDENCE_AUDIT_FAILED"
    | "VALIDATOR_MUTATION_FORBIDDEN",
  message: string,
  detail?: Record<string, unknown>,
): RuntimeError {
  return new RuntimeError(code, message, { detail });
}

// ---------------------------------------------------------------------------
// §6–§11 — the deterministic Evidence audit
// ---------------------------------------------------------------------------

export interface AuditedEvidenceEntry {
  evidenceId: string;
  revision: number;
  confidence: string;
  criticality: "critical" | "supporting" | "informational";
  validationStrategy: string;
  /** Post-revalidation state (informational entries: recorded as-is). */
  state: "fresh" | "needs_validation" | "stale" | "invalidated";
  disposition: "pass" | "blocked" | "recorded";
  reasonCode: string;
  lastValidationEventSeq: number | null;
  /** §10 — a reobserve revision that now needs a new observation. */
  requiresReobservation: boolean;
}

interface AuditWalkResult {
  entries: AuditedEvidenceEntry[];
  /** Exact scope refs whose real basis changed (for the Section bridge). */
  changed: EvidenceRef[];
}

export interface AuditScopeEntry {
  evidenceId: string;
  revision: number;
  confidence: string;
  criticality: "critical" | "supporting" | "informational";
  validationStrategy: string;
  frozenLastEventSeq: number;
}

interface EvidenceRevisionAuditRecord {
  validationStrategy: "fingerprint" | "reobserve";
  sourceFingerprints: Array<{ path: string; sha256: string; size: number }>;
  repositoryRevision: string | null;
  derivedFrom: EvidenceRef[];
}

function loadEvidenceRevisionForAuditInTx(tx: StoreTx, runId: string, ref: EvidenceRef): EvidenceRevisionAuditRecord | null {
  const row = tx
    .prepare(
      "SELECT validation_strategy AS validationStrategy, source_fingerprints_json AS sourceFingerprintsJson, "
      + "repository_context_json AS repositoryContextJson FROM evidence_revisions "
      + "WHERE run_id = ? AND evidence_id = ? AND revision = ?",
    )
    .get(runId, ref.evidenceId, ref.revision) as
    | { validationStrategy: string; sourceFingerprintsJson: string; repositoryContextJson: string }
    | undefined;
  if (row === undefined) return null;
  const repositoryContext = JSON.parse(row.repositoryContextJson) as { repositoryRevision?: string | null };
  return {
    validationStrategy: row.validationStrategy as EvidenceRevisionAuditRecord["validationStrategy"],
    sourceFingerprints: JSON.parse(row.sourceFingerprintsJson),
    repositoryRevision: repositoryContext.repositoryRevision ?? null,
    derivedFrom: (
      tx
        .prepare(
          "SELECT derived_from_evidence_id AS evidenceId, derived_from_revision AS revision FROM evidence_derived_refs "
          + "WHERE run_id = ? AND evidence_id = ? AND revision = ? ORDER BY derived_from_evidence_id, derived_from_revision",
        )
        .all(runId, ref.evidenceId, ref.revision) as EvidenceRef[]
    ).map((upstream) => ({ evidenceId: upstream.evidenceId, revision: upstream.revision })),
  };
}

function workspaceRootInTx(tx: StoreTx, workspaceId: string): string {
  const row = tx
    .prepare("SELECT canonical_root AS canonicalRoot FROM workspaces WHERE workspace_id = ?")
    .get(workspaceId) as { canonicalRoot: string } | undefined;
  if (row === undefined) {
    throw new RuntimeError("WORKSPACE_NOT_FOUND", `workspace '${workspaceId}' is not registered`, {
      detail: { workspaceId },
    });
  }
  return row.canonicalRoot;
}

/** The Section review bridge (same semantics as the Phase 10/11 §48 bridge). */
function propagateSectionReviewBridgeInTx(
  tx: StoreTx,
  input: { runId: string; affected: EvidenceRef[]; requestId: string | null; clock: StoreClock },
): void {
  if (input.affected.length === 0) return;
  const head = getHeadPairInTx(tx, input.runId);
  const headSectionRefs: MemoryRef[] = head === null ? [] : (getSnapshotRefsInTx(tx, head.headSnapshotId) ?? []);
  propagateEvidenceSectionReviewInTx(
    tx,
    {
      runId: input.runId,
      headSectionRefs,
      affectedEvidence: input.affected.map((ref) => ({ evidenceId: ref.evidenceId, revision: ref.revision })),
      ...(input.requestId !== null ? { requestId: input.requestId } : {}),
    },
    input.clock,
  );
}

interface WalkVerdict {
  state: AuditedEvidenceEntry["state"];
  requiresReobservation: boolean;
  reasonCode: string;
}

/**
 * Audit-time deterministic evaluation of the frozen Evidence scope (§6–§11).
 * Runs INSIDE the caller's write transaction: discovered source changes are
 * appended as real SOURCE_CHANGED events with derived propagation (§11) and
 * feed the Section review bridge, persisting whether or not the gate passes.
 * Critical AND supporting entries are revalidated; informational entries are
 * recorded only (§9/§36). No command is ever replayed (§10).
 */
function auditEvidenceScopeInTx(
  tx: StoreTx,
  input: {
    runId: string;
    workspaceId: string;
    scope: AuditScopeEntry[];
    requestId: string | null;
    clock: StoreClock;
  },
): AuditWalkResult {
  const entries: AuditedEvidenceEntry[] = [];
  const changed: EvidenceRef[] = [];
  const verdicts = new Map<string, WalkVerdict>();
  const workspaceRoot = workspaceRootInTx(tx, input.workspaceId);

  const check = (ref: EvidenceRef): WalkVerdict => {
    const key = evidenceKey(ref);
    const memo = verdicts.get(key);
    if (memo !== undefined) return memo;
    const revision = loadEvidenceRevisionForAuditInTx(tx, input.runId, ref);
    if (revision === null) {
      throw finalizationError(
        "EVIDENCE_AUDIT_FAILED",
        `audited evidence '${ref.evidenceId}'@${ref.revision} has no revision record`,
        { evidenceId: ref.evidenceId, revision: ref.revision },
      );
    }
    let state = getCurrentStateInTx(tx, input.runId, ref.evidenceId, ref.revision);
    let requiresReobservation = false;
    let reasonCode = "audit_state_current";
    if (state === null) {
      state = "invalidated";
      reasonCode = "audit_state_missing";
    } else if (state !== "fresh") {
      reasonCode = `audit_state_${state}`;
      // §70 — a deterministic fingerprint revision whose needs_validation came
      // from its OWN source check can return to fresh at gate time when the
      // exact original content has been restored. Never for stale/invalidated
      // (terminal) states, and never for needs_validation caused by an
      // upstream replacement — the own-source last event is the gate.
      if (state === "needs_validation" && revision.validationStrategy === "fingerprint") {
        const lastEvent = tx
          .prepare(
            "SELECT event_type AS eventType, reason_code AS reasonCode FROM evidence_validation_events "
            + "WHERE run_id = ? AND evidence_id = ? AND evidence_revision = ? "
            + "ORDER BY event_seq DESC LIMIT 1",
          )
          .get(input.runId, ref.evidenceId, ref.revision) as { eventType: string; reasonCode: string } | undefined;
        const ownSourceChange =
          lastEvent !== undefined &&
          lastEvent.eventType === "SOURCE_CHANGED" &&
          (lastEvent.reasonCode === "revalidation_check_changed" ||
            lastEvent.reasonCode === "revalidation_check_source_unreadable");
        if (ownSourceChange && checkAllSourceFingerprints(workspaceRoot, revision.sourceFingerprints).status === "match") {
          appendValidationEventInTx(tx, {
            runId: input.runId,
            evidenceId: ref.evidenceId,
            evidenceRevision: ref.revision,
            eventType: "FINGERPRINT_VALIDATED",
            toState: "fresh",
            reasonCode: "finalization_gate_content_restored",
            detail: { checked: revision.sourceFingerprints.map((fingerprint) => fingerprint.path) },
            eventId: `FRE-${input.clock.newId()}`,
            requestId: input.requestId,
            createdAt: input.clock.nowIso(),
          });
          state = "fresh";
          reasonCode = "finalization_gate_content_restored";
        }
      }
    } else if (revision.validationStrategy === "fingerprint") {
      const result = checkAllSourceFingerprints(workspaceRoot, revision.sourceFingerprints);
      if (result.status !== "match") {
        reasonCode = result.status === "mismatch" ? "revalidation_check_changed" : "revalidation_check_source_unreadable";
        appendValidationEventInTx(tx, {
          runId: input.runId,
          evidenceId: ref.evidenceId,
          evidenceRevision: ref.revision,
          eventType: "SOURCE_CHANGED",
          toState: "needs_validation",
          reasonCode,
          detail: { path: result.path, ...(result.observedSha256 !== undefined ? { observedSha256: result.observedSha256 } : {}) },
          eventId: `FRE-${input.clock.newId()}`,
          requestId: input.requestId,
          createdAt: input.clock.nowIso(),
        });
        for (const dependent of propagateDerivedChangeInTx(tx, {
          runId: input.runId,
          changedRef: ref,
          cause: "SOURCE_CHANGED",
          requestId: input.requestId,
          clock: input.clock,
        })) {
          changed.push(dependent);
        }
        changed.push(ref);
        state = "needs_validation";
      }
    } else {
      // §10 — reobserve: the only deterministic drift signal is the recorded
      // repository revision; a drift means re-observation is REQUIRED and can
      // never be satisfied inside finalization.
      const recorded = revision.repositoryRevision;
      if (recorded !== null) {
        const current = observeGitHeadSync(workspaceRoot);
        if (current !== null && current !== recorded) {
          reasonCode = "git_repository_revision_drift";
          appendValidationEventInTx(tx, {
            runId: input.runId,
            evidenceId: ref.evidenceId,
            evidenceRevision: ref.revision,
            eventType: "SOURCE_CHANGED",
            toState: "needs_validation",
            reasonCode,
            detail: { recorded, current },
            eventId: `FRE-${input.clock.newId()}`,
            requestId: input.requestId,
            createdAt: input.clock.nowIso(),
          });
          for (const dependent of propagateDerivedChangeInTx(tx, {
            runId: input.runId,
            changedRef: ref,
            cause: "SOURCE_CHANGED",
            requestId: input.requestId,
            clock: input.clock,
          })) {
            changed.push(dependent);
          }
          changed.push(ref);
          state = "needs_validation";
          requiresReobservation = true;
        }
      }
    }
    // §40 — provenance closure: derived evidence audits its exact upstreams.
    if (state === "fresh") {
      for (const upstream of revision.derivedFrom) {
        const upstreamResult = check(upstream);
        if (upstreamResult.state !== "fresh") {
          state = "needs_validation";
          reasonCode = `audit_upstream_${upstreamResult.reasonCode}`;
        }
      }
    }
    const verdict: WalkVerdict = { state, requiresReobservation, reasonCode };
    verdicts.set(key, verdict);
    return verdict;
  };

  for (const entry of input.scope) {
    if (entry.criticality === "informational") {
      // §9/§36 — informational state is recorded, never re-evaluated, never
      // blocking.
      const state = getCurrentStateInTx(tx, input.runId, entry.evidenceId, entry.revision);
      entries.push({
        evidenceId: entry.evidenceId,
        revision: entry.revision,
        confidence: entry.confidence,
        criticality: entry.criticality,
        validationStrategy: entry.validationStrategy,
        state: state ?? "invalidated",
        disposition: "recorded",
        reasonCode: "informational_recorded",
        lastValidationEventSeq: entry.frozenLastEventSeq,
        requiresReobservation: false,
      });
      continue;
    }
    const ref: EvidenceRef = { evidenceId: entry.evidenceId, revision: entry.revision };
    const verdict = check(ref);
    const auditedState = getCurrentStateInTx(tx, input.runId, entry.evidenceId, entry.revision) ?? verdict.state;
    entries.push({
      evidenceId: entry.evidenceId,
      revision: entry.revision,
      confidence: entry.confidence,
      criticality: entry.criticality,
      validationStrategy: entry.validationStrategy,
      state: auditedState,
      disposition: auditedState === "fresh" ? "pass" : "blocked",
      reasonCode: verdict.reasonCode,
      lastValidationEventSeq: entry.frozenLastEventSeq,
      requiresReobservation: verdict.requiresReobservation,
    });
  }
  entries.sort((a, b) => a.evidenceId.localeCompare(b.evidenceId) || a.revision - b.revision);
  // Phase 11 §48 bridge — real basis changes discovered by the audit put the
  // affected completed Sections into review, in this same transaction (§11).
  propagateSectionReviewBridgeInTx(tx, {
    runId: input.runId,
    affected: changed,
    requestId: input.requestId,
    clock: input.clock,
  });
  return { entries, changed };
}

function auditedEntriesToRows(entries: EvidenceAuditEntry[]): EvidenceAuditEntryRow[] {
  return entries.map((entry) => ({
    evidenceId: entry.evidenceId,
    evidenceRevision: entry.revision,
    confidence: entry.confidence,
    criticality: entry.criticality,
    validationStrategy: entry.validationStrategy,
    state: entry.state,
    disposition: entry.disposition,
    reasonCode: entry.reasonCode,
    lastValidationEventSeq: entry.lastValidationEventSeq,
  }));
}

// ---------------------------------------------------------------------------
// §12/§15–§24 — FinalizationFacts loading
// ---------------------------------------------------------------------------

/** The parsed pieces of the frozen world the candidate derives from. */
interface FrozenWorld {
  inputId: string;
  inputHash: string;
  baseHeadSnapshotId: string;
  baseHeadCommitId: string | null;
  architecture: Array<{ id: string; revision: number }>;
  sections: CandidateSectionRef[];
  decisions: CandidateItemRef[];
  constraints: CandidateItemRef[];
  scope: AuditScopeEntry[];
}

/**
 * Load the run's current finalization world (§15–§24) inside the caller's
 * transaction. The deterministic Evidence audit always runs here (both
 * production paths are write transactions), so facts carry post-revalidation
 * states and discovered system facts are already persisted (§11).
 */
export function buildFinalizationFactsInTx(
  tx: StoreTx,
  input: {
    runId: string;
    workspaceId: string;
    /** The final proposal being authorized — excluded from the awaiting check. */
    excludeAwaitingProposalId?: string;
    clock: StoreClock;
    requestId: string | null;
  },
): { facts: FinalizationFacts; world: FrozenWorld | null; audited: AuditWalkResult | null } {
  const runRow = tx
    .prepare(
      "SELECT run_id AS runId, workspace_id AS workspaceId, lifecycle, stage, revision, goal, "
      + "created_at AS createdAt, updated_at AS updatedAt FROM planning_runs WHERE run_id = ?",
    )
    .get(input.runId) as Record<string, unknown> | undefined;
  if (runRow === undefined) {
    throw runStateError("RUN_NOT_FOUND", `no PlanningRun exists for '${input.runId}'`, { runId: input.runId });
  }
  const run = parsePlanningRunRow(runRow);
  const head = getHeadPairInTx(tx, input.runId);
  const headRefs: MemoryRef[] = head === null ? [] : (getSnapshotRefsInTx(tx, head.headSnapshotId) ?? []);

  const latest = getLatestSynthesisInputInTx(tx, input.runId);
  if (latest === null) {
    return {
      facts: {
        run: { lifecycle: run.lifecycle, stage: run.stage, revision: run.revision },
        head: { snapshotId: head?.headSnapshotId ?? null, commitId: head?.headCommitId ?? null },
        synthesis: null,
        architecture: null,
        pinnedArchitecture: null,
        sections: [],
        activeSection: null,
        blockingQuestionCount: 0,
        blockingConflictCount: 0,
        evidence: [],
        evidenceScopeMatches: false,
        awaitingProposal: null,
      },
      world: null,
      audited: null,
    };
  }

  // §17 — the exact chain identities.
  const manifest = getSynthesisManifestByInputInTx(tx, input.runId, latest.inputId);
  const report = manifest === null ? null : getValidationReportByManifestInTx(tx, input.runId, manifest.manifestId);
  const manifestCanonical =
    manifest === null ? null : (JSON.parse(manifest.canonicalJson) as SynthesisManifestV1);

  const inputRefs = listSynthesisInputRefsInTx(tx, input.runId, latest.inputId);
  const architecture = inputRefs
    .filter((ref) => ref.kind === "architecture")
    .map((ref) => ({ id: ref.artifactId, revision: ref.revision }));
  const pinnedArchitecture = architecture[0] ?? null;
  const sections: CandidateSectionRef[] = inputRefs
    .filter((ref) => ref.kind === "section")
    .map((ref) => ({ sectionId: ref.artifactId, revision: ref.revision }));
  const decisions: CandidateItemRef[] = inputRefs
    .filter((ref) => ref.kind === "decision")
    .map((ref) => ({ kind: "decision" as const, id: ref.artifactId, revision: ref.revision }));
  const constraints: CandidateItemRef[] = inputRefs
    .filter((ref) => ref.kind === "constraint")
    .map((ref) => ({ kind: "constraint" as const, id: ref.artifactId, revision: ref.revision }));
  const scope: AuditScopeEntry[] = listSynthesisInputEvidenceInTx(tx, input.runId, latest.inputId).map((row) => ({
    evidenceId: row.evidenceId,
    revision: row.evidenceRevision,
    confidence: row.confidence,
    criticality: row.criticality as AuditScopeEntry["criticality"],
    validationStrategy: row.validationStrategy,
    frozenLastEventSeq: row.frozenLastEventSeq,
  }));

  // §6–§11 — the deterministic audit.
  const audited = auditEvidenceScopeInTx(tx, {
    runId: input.runId,
    workspaceId: input.workspaceId,
    scope,
    requestId: input.requestId,
    clock: input.clock,
  });

  // §20 — the CURRENT HEAD architecture.
  const headArchitectureRefs = headRefs.filter((ref) => ref.kind === "architecture");
  const currentArchitecture =
    headArchitectureRefs.length === 1
      ? { id: headArchitectureRefs[0]!.id, revision: headArchitectureRefs[0]!.revision }
      : null;

  // §21 — current Sections joined to workflow state.
  // Phase 15 §56/§58 — sections with no local workflow row resolve through
  // the successor baseline scope: inherited_completed at the exact HEAD
  // revision satisfies the completion gate; needs_review blocks. A local row
  // always wins (once amended, inheritance ceases).
  const workflowStates = new Map(
    listSectionWorkflowStatesInTx(tx, input.runId).map((state) => [state.sectionId, state]),
  );
  const worldSections = headRefs
    .filter((ref) => ref.kind === "section")
    .map((ref) => {
      const state = workflowStates.get(ref.id);
      if (state !== undefined) {
        return {
          sectionId: ref.id,
          revision: ref.revision,
          status: state.status,
          completedRevision: state.completedRevision ?? null,
        };
      }
      const scope = getBaselineScopeForSectionInTx(tx, input.runId, ref.id);
      if (scope !== null && scope.scopeState === "inherited_completed" && scope.originRevision === ref.revision) {
        return {
          sectionId: ref.id,
          revision: ref.revision,
          status: "completed" as const,
          completedRevision: scope.originRevision,
        };
      }
      return {
        sectionId: ref.id,
        revision: ref.revision,
        status: scope?.scopeState === "needs_review" ? ("needs_review" as const) : ("open" as const),
        completedRevision: null,
      };
    })
    .sort((a, b) => a.sectionId.localeCompare(b.sectionId));

  // §22/§23 — typed blocking conditions re-read from the CURRENT HEAD.
  let blockingQuestions = 0;
  let blockingConflicts = 0;
  const readContent = (ref: MemoryRef): Record<string, unknown> | null => {
    const row = tx
      .prepare(
        "SELECT content_json AS contentJson FROM memory_revisions "
        + "WHERE run_id = ? AND kind = ? AND artifact_id = ? AND revision = ?",
      )
      .get(ref.runId, ref.kind, ref.id, ref.revision) as { contentJson: string } | undefined;
    return row === undefined ? null : (JSON.parse(row.contentJson) as Record<string, unknown>);
  };
  for (const ref of headRefs) {
    if (ref.kind === "open_question") {
      const content = readContent(ref) as { status?: string; blocking?: boolean } | null;
      if (content !== null && content.status === "open" && content.blocking === true) blockingQuestions += 1;
    }
    if (ref.kind === "conflict") {
      const content = readContent(ref) as { status?: string; severity?: string } | null;
      if (content !== null && content.status === "open" && content.severity === "hard") blockingConflicts += 1;
    }
  }

  // §7 — the frozen scope must still be exactly the committed-design
  // reachability.
  const recomputed = listRelevantEvidenceInTx(tx, input.runId, headRefs).map(evidenceKey).sort();
  const frozen = scope.map((entry) => evidenceKey(entry)).sort();
  const evidenceScopeMatches =
    recomputed.length === frozen.length && recomputed.every((key, index) => key === frozen[index]);

  // §14 — any other awaiting Proposal blocks.
  const awaitingRow = tx
    .prepare(
      "SELECT s.proposal_id AS proposalId, r.proposal_type AS type "
      + "FROM proposal_states s JOIN proposal_revisions r ON r.run_id = s.run_id AND r.proposal_id = s.proposal_id AND r.revision = s.revision "
      + "WHERE s.run_id = ? AND s.status = 'awaiting_approval' AND s.proposal_id != ? LIMIT 1",
    )
    .get(input.runId, input.excludeAwaitingProposalId ?? "") as
    | { proposalId: string; type: string }
    | undefined;

  const evidenceFacts: FinalizationEvidenceFact[] = audited.entries.map((entry) => ({
    evidenceId: entry.evidenceId,
    revision: entry.revision,
    criticality: entry.criticality,
    validationStrategy: entry.validationStrategy as FinalizationEvidenceFact["validationStrategy"],
    state: entry.state,
    requiresReobservation: entry.requiresReobservation,
  }));

  const facts: FinalizationFacts = {
    run: { lifecycle: run.lifecycle, stage: run.stage, revision: run.revision },
    head: { snapshotId: head?.headSnapshotId ?? null, commitId: head?.headCommitId ?? null },
    synthesis: {
      inputId: latest.inputId,
      inputHash: latest.inputHash,
      baseHeadSnapshot: latest.baseHeadSnapshotId,
      baseHeadCommit: latest.baseHeadCommitId,
      manifestId: manifest?.manifestId ?? null,
      manifestHash: manifest?.manifestHash ?? null,
      reportId: report?.reportId ?? null,
      reportHash: report?.reportHash ?? null,
      reportIsClean: report?.isClean ?? null,
      unresolvedFindingCount: manifestCanonical?.unresolvedFindings.length ?? 0,
    },
    architecture: currentArchitecture,
    pinnedArchitecture,
    sections: worldSections,
    activeSection: getActiveSectionInTx(tx, input.runId),
    blockingQuestionCount: blockingQuestions,
    blockingConflictCount: blockingConflicts,
    evidence: evidenceFacts,
    evidenceScopeMatches,
    awaitingProposal: awaitingRow === undefined ? null : { proposalId: awaitingRow.proposalId, type: awaitingRow.type },
  };

  return {
    facts,
    world: {
      inputId: latest.inputId,
      inputHash: latest.inputHash,
      baseHeadSnapshotId: latest.baseHeadSnapshotId,
      baseHeadCommitId: latest.baseHeadCommitId,
      architecture,
      sections,
      decisions,
      constraints,
      scope,
    },
    audited,
  };
}

// ---------------------------------------------------------------------------
// §26–§29 — request_finalization
// ---------------------------------------------------------------------------

export interface RequestFinalizationInput {
  runId: string;
  workspaceId: string;
  sessionId: string;
  bindingGeneration: number;
  requestId: string;
  callerAgent: CallerAgent | null;
}

export interface RequestFinalizationResult {
  idempotent: boolean;
  candidateId: string;
  candidateHash: string;
  candidateSeq: number;
  auditId: string;
  auditHash: string;
  proposalId: string;
  proposalRevision: number;
  proposalHash: string;
  stage: PlanningRun["stage"];
  runRevision: number;
}

function loadRunInTx(tx: StoreTx, runId: string): PlanningRun {
  const row = tx
    .prepare(
      "SELECT run_id AS runId, workspace_id AS workspaceId, lifecycle, stage, revision, goal, "
      + "created_at AS createdAt, updated_at AS updatedAt FROM planning_runs WHERE run_id = ?",
    )
    .get(runId) as Record<string, unknown> | undefined;
  if (row === undefined) {
    throw runStateError("RUN_NOT_FOUND", `no PlanningRun exists for '${runId}'`, { runId });
  }
  return parsePlanningRunRow(row);
}

function bumpRunStageInTx(
  tx: StoreTx,
  input: { runId: string; expectedRevision: number; nextStage: PlanningRun["stage"] },
  now: string,
): void {
  const result = tx
    .prepare("UPDATE planning_runs SET stage = ?, revision = revision + 1, updated_at = ? WHERE run_id = ? AND revision = ?")
    .run(input.nextStage, now, input.runId, input.expectedRevision) as { changes?: number };
  if ((result.changes ?? 0) !== 1) {
    throw runStateError("STALE_RUN_REVISION", "run revision changed during the finalization transition", {
      runId: input.runId,
      expected: input.expectedRevision,
    });
  }
}

/** Relational candidate refs (§30/§91 membership). */
function candidateRefRows(candidate: FinalPlanCandidateV1): FinalPlanCandidateRefRow[] {
  const rows: Array<{ family: CandidateRefFamily; artifactId: string; revision: number }> = [];
  if (candidate.architecture !== null) {
    rows.push({ family: "architecture", artifactId: candidate.architecture.id, revision: candidate.architecture.revision });
  }
  for (const section of candidate.sections) {
    rows.push({ family: "section", artifactId: section.sectionId, revision: section.revision });
  }
  for (const decision of candidate.decisions) {
    rows.push({ family: "decision", artifactId: decision.id, revision: decision.revision });
  }
  for (const constraint of candidate.constraints) {
    rows.push({ family: "constraint", artifactId: constraint.id, revision: constraint.revision });
  }
  for (const evidence of candidate.evidenceScope) {
    rows.push({ family: "evidence", artifactId: evidence.evidenceId, revision: evidence.revision });
  }
  return rows;
}

export function createFinalizationService(store: PlanStore, clock: StoreClock) {
  return {
    /**
     * §26–§29 — run the pre-approval FinalizationGate and, on pass, freeze
     * [pre-approval EvidenceAuditSnapshot + FinalPlanCandidate + exact
     * final_plan Proposal + VALIDATION_CLEAN validation→final + run revision
     * +1 exactly once] in ONE transaction. Never moves HEAD; never touches
     * Plan Memory. The validator subagent is denied (§26).
     */
    requestFinalization(input: RequestFinalizationInput): RequestFinalizationResult {
      return store.withWrite((tx) => {
        // §72 — same-invocation retry replays the frozen outcome.
        const replay = getFinalPlanCandidateByRequestInTx(tx, input.runId, input.requestId);
        if (replay !== null) {
          const bindingRow = tx
            .prepare(
              "SELECT proposal_id AS proposalId, proposal_revision AS proposalRevision "
              + "FROM proposal_final_plan_refs WHERE run_id = ? AND candidate_id = ? LIMIT 1",
            )
            .get(input.runId, replay.candidateId) as
            | { proposalId: string; proposalRevision: number }
            | undefined;
          if (bindingRow === undefined) {
            throw finalizationError(
              "FINAL_PLAN_PROPOSAL_INVALID",
              "the recorded finalization request has no final proposal binding",
              { candidateId: replay.candidateId },
            );
          }
          const proposalRow = tx
            .prepare(
              "SELECT proposal_hash AS proposalHash FROM proposal_revisions "
              + "WHERE run_id = ? AND proposal_id = ? AND revision = ?",
            )
            .get(input.runId, bindingRow.proposalId, bindingRow.proposalRevision) as
            | { proposalHash: string }
            | undefined;
          const auditRow = tx
            .prepare(
              "SELECT audit_id AS auditId, audit_hash AS auditHash FROM evidence_audit_snapshots "
              + "WHERE run_id = ? AND request_id = ? AND purpose = 'pre_approval' LIMIT 1",
            )
            .get(input.runId, input.requestId) as { auditId: string; auditHash: string } | undefined;
          const run = loadRunInTx(tx, input.runId);
          return {
            idempotent: true,
            candidateId: replay.candidateId,
            candidateHash: replay.candidateHash,
            candidateSeq: replay.candidateSeq,
            auditId: auditRow?.auditId ?? "",
            auditHash: auditRow?.auditHash ?? "",
            proposalId: bindingRow.proposalId,
            proposalRevision: bindingRow.proposalRevision,
            proposalHash: proposalRow?.proposalHash ?? "",
            stage: run.stage,
            runRevision: run.revision,
          };
        }

        const run = loadRunInTx(tx, input.runId);
        if (run.workspaceId !== input.workspaceId) {
          throw new RuntimeError("WORKSPACE_MISMATCH", `PlanningRun '${run.runId}' belongs to a different workspace`, {
            detail: { expected: run.workspaceId, detected: input.workspaceId },
          });
        }
        assertWritableBindingInTx(tx, {
          runId: input.runId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          generation: input.bindingGeneration,
        });
        if (run.lifecycle !== "active") {
          throw runStateError("RUN_TERMINAL", `PlanningRun '${run.runId}' is ${run.lifecycle} and can no longer mutate`, {
            runId: run.runId,
            lifecycle: run.lifecycle,
          });
        }
        // §26/E4 — the validator only ever reports findings.
        if (input.callerAgent?.agentType !== undefined && input.callerAgent.agentType !== "") {
          throw finalizationError(
            "VALIDATOR_MUTATION_FORBIDDEN",
            `request_finalization is a main planning capability; caller is attested as '${input.callerAgent.agentType}'`,
            { agentType: input.callerAgent.agentType },
          );
        }
        // §73/§86 — a concurrent loser must see the already-prepared identity
        // of the current cycle, not the stage the winner moved the run to.
        const latest = getLatestSynthesisInputInTx(tx, input.runId);
        const latestCandidate = getLatestFinalPlanCandidateInTx(tx, input.runId);
        if (latestCandidate !== null && latest !== null && latestCandidate.inputId === latest.inputId) {
          throw finalizationError(
            "FINALIZATION_ALREADY_PREPARED",
            "this frozen synthesis input already has a FinalPlanCandidate and final proposal",
            { candidateId: latestCandidate.candidateId, inputId: latest.inputId },
          );
        }
        // §15 — the first request runs at stage validation.
        if (run.stage !== "validation") {
          throw new RuntimeError(
            "CAPABILITY_NOT_AVAILABLE",
            `request_finalization is available only at stage validation (run is at '${run.stage}')`,
            { detail: { stage: run.stage } },
          );
        }

        // §12/§25 — facts + the pure gate.
        const { facts, world, audited } = buildFinalizationFactsInTx(tx, {
          runId: input.runId,
          workspaceId: input.workspaceId,
          clock,
          requestId: input.requestId,
        });
        const decision: FinalizationDecision = evaluateFinalization(facts);
        if (decision.status === "deny") {
          throw finalizationDeniedError(decision.reasons);
        }
        if (world === null || audited === null || facts.synthesis === null) {
          throw finalizationError("EVIDENCE_AUDIT_FAILED", "finalization facts carry no synthesis chain", {
            runId: input.runId,
          });
        }

        // §30/§31 — the server-derived candidate. baseRunRevision is the
        // POST-bump revision the final proposal (and later the authorization)
        // is fenced against.
        const nextRevision = run.revision + 1;
        const head = getHeadPairInTx(tx, input.runId);
        const manifestCanonical = JSON.parse(
          getSynthesisManifestByInputInTx(tx, input.runId, world.inputId)!.canonicalJson,
        ) as SynthesisManifestV1;
        const candidate: FinalPlanCandidateV1 = {
          version: 1,
          runId: input.runId,
          baseRunRevision: nextRevision,
          baseHeadSnapshot: world.baseHeadSnapshotId,
          baseHeadCommit: world.baseHeadCommitId,
          synthesisInput: { inputId: world.inputId, inputHash: world.inputHash },
          synthesisManifest: {
            manifestId: facts.synthesis.manifestId!,
            manifestHash: facts.synthesis.manifestHash!,
          },
          semanticValidation: {
            reportId: facts.synthesis.reportId!,
            reportHash: facts.synthesis.reportHash!,
          },
          architecture: world.architecture[0] ?? null,
          sections: world.sections,
          decisions: world.decisions,
          constraints: world.constraints,
          implementationOrder: manifestCanonical.implementationOrder,
          limitations: manifestCanonical.limitations,
          evidenceScope: world.scope.map(
            (entry): CandidateEvidenceRef => ({ evidenceId: entry.evidenceId, revision: entry.revision }),
          ),
        };
        const candidateHash = finalPlanCandidateHash(candidate);
        const candidateId = `fpc_${clock.newId()}`;
        const candidateSeq = nextCandidateSeqInTx(tx, input.runId);
        const now = clock.nowIso();

        // §6/§33 — the pre-approval audit snapshot.
        const auditSnapshot: EvidenceAuditSnapshotV1 = {
          version: 1,
          runId: input.runId,
          inputId: world.inputId,
          inputHash: world.inputHash,
          entries: audited.entries.map((entry) => ({
            evidenceId: entry.evidenceId,
            revision: entry.revision,
            confidence: entry.confidence,
            criticality: entry.criticality,
            validationStrategy: entry.validationStrategy,
            state: entry.state,
            disposition: entry.disposition,
            reasonCode: entry.reasonCode,
            lastValidationEventSeq: entry.lastValidationEventSeq,
          })),
        };
        const auditId = `evaud_${clock.newId()}`;
        const auditHash = evidenceAuditHash(auditSnapshot);
        insertEvidenceAuditSnapshotInTx(
          tx,
          {
            runId: input.runId,
            auditId,
            purpose: "pre_approval",
            inputId: world.inputId,
            inputHash: world.inputHash,
            candidateId: null,
            auditHash,
            canonicalJson: canonicalJson(auditSnapshot),
            requestId: input.requestId,
            createdAt: now,
          },
          auditedEntriesToRows(auditSnapshot.entries),
        );

        // §30 — the immutable candidate.
        insertFinalPlanCandidateInTx(
          tx,
          {
            runId: input.runId,
            candidateSeq,
            candidateId,
            baseRunRevision: candidate.baseRunRevision,
            baseHeadSnapshotId: candidate.baseHeadSnapshot,
            baseHeadCommitId: candidate.baseHeadCommit,
            inputId: world.inputId,
            inputHash: world.inputHash,
            manifestId: candidate.synthesisManifest.manifestId,
            manifestHash: candidate.synthesisManifest.manifestHash,
            reportId: candidate.semanticValidation.reportId,
            reportHash: candidate.semanticValidation.reportHash,
            canonicalJson: canonicalJson(candidate),
            candidateHash,
            requestId: input.requestId,
            createdAt: now,
          },
          candidateRefRows(candidate),
        );

        // §37/§38/§39/§40 — the server-generated final_plan Proposal: V3
        // canonical, changes = [], requiredEvidence = candidate.evidenceScope.
        const proposalId = `PROP-${clock.newId()}`;
        const canonical = buildFinalPlanProposalCanonical({
          runId: input.runId,
          proposalId,
          proposalRevision: 1,
          type: "final_plan",
          scope: { kind: "architecture" },
          baseRunRevision: nextRevision,
          baseHeadSnapshotId: head?.headSnapshotId ?? null,
          baseHeadCommitId: head?.headCommitId ?? null,
          title: "Final plan",
          summary:
            "Server-frozen Final Plan Candidate: the FinalizationGate passed over the current clean synthesis world.",
          changes: [],
          dependencies: [],
          impact: { affected: [], notes: ["final_plan authorization commits zero design changes"] },
          requiredEvidence: candidate.evidenceScope.map((ref) => ({
            evidenceId: ref.evidenceId,
            revision: ref.revision,
          })),
          finalPlanCandidate: { candidateId, candidateHash },
        });
        const proposalHash = canonicalProposalHash(canonical);
        insertProposalIdentityInTx(tx, { runId: input.runId, proposalId, prepareRequestId: input.requestId }, now);
        insertProposalRevisionInTx(
          tx,
          {
            runId: input.runId,
            proposalId,
            revision: 1,
            type: "final_plan",
            scope: { kind: "architecture" },
            title: canonical.title,
            summary: canonical.summary,
            changes: [],
            dependencies: [],
            impact: canonical.impact,
            baseRunRevision: nextRevision,
            baseHeadSnapshotId: head?.headSnapshotId ?? null,
            baseHeadCommitId: head?.headCommitId ?? null,
            canonicalJson: canonicalJson(canonical),
            proposalHash,
          },
          now,
        );
        insertProposalStateInTx(tx, { runId: input.runId, proposalId, revision: 1 }, now);
        insertProposalFinalPlanRefInTx(tx, {
          runId: input.runId,
          proposalId,
          proposalRevision: 1,
          candidateId,
          candidateHash,
        });

        // §41/§84 — the first production VALIDATION_CLEAN: validation → final,
        // run revision +1 EXACTLY once, in the same transaction.
        const targetStage = nextStage("validation", "VALIDATION_CLEAN");
        bumpRunStageInTx(tx, { runId: input.runId, expectedRevision: run.revision, nextStage: targetStage }, now);

        return {
          idempotent: false,
          candidateId,
          candidateHash,
          candidateSeq,
          auditId,
          auditHash,
          proposalId,
          proposalRevision: 1,
          proposalHash,
          stage: targetStage,
          runRevision: nextRevision,
        };
      });
    },

    /**
     * §49 — the post-denial persistence path: after an authorization that the
     * commit-time gate denied rolls back, re-run ONLY the Evidence audit in a
     * fresh transaction so the discovered source changes / Section review
     * facts persist. No candidate/proposal/approval/commit row is touched.
     */
    persistDiscoveredEvidenceFacts(input: { runId: string; workspaceId: string }): void {
      store.withWrite((tx) => {
        buildFinalizationFactsInTx(tx, {
          runId: input.runId,
          workspaceId: input.workspaceId,
          clock,
          requestId: null,
        });
        return null;
      });
    },
  };
}

// ---------------------------------------------------------------------------
// §47/§48 — the commit-time rerun (called by the plan commit engine)
// ---------------------------------------------------------------------------

/**
 * Reload the exact candidate, revalidate its hash, rebuild the world facts,
 * rerun the FinalizationGate, and freeze the COMMIT-TIME EvidenceAuditSnapshot
 * (§34) — all inside the authorization transaction, BEFORE any Approval /
 * PlanCommit / FinalPlan row is written (§48). Any deny throws
 * FINALIZATION_DENIED and rolls the whole authorization back (§68/§69/§100).
 */
export function runCommitTimeFinalizationInTx(
  tx: StoreTx,
  input: {
    runId: string;
    workspaceId: string;
    proposalId: string;
    proposalRevision: number;
    clock: StoreClock;
  },
): { candidate: FinalPlanCandidateV1; candidateId: string; candidateHash: string; auditId: string; auditHash: string } {
  const ref = getProposalFinalPlanRefInTx(tx, input.runId, input.proposalId, input.proposalRevision);
  if (ref === null) {
    // §77 — a legacy schema-9 final run has stage=final with no candidate.
    throw finalizationError(
      "FINAL_PLAN_CANDIDATE_REQUIRED",
      "the final proposal has no FinalPlanCandidate binding; the run cannot be approved in this state (request_reopen recovers)",
      { proposalId: input.proposalId },
    );
  }
  const candidateRow = getFinalPlanCandidateInTx(tx, input.runId, ref.candidateId);
  if (candidateRow === null) {
    throw new RuntimeError("STORE_SCHEMA_INVALID", "final proposal references a missing candidate", {
      detail: { candidateId: ref.candidateId },
    });
  }
  // §3/§48 — the frozen candidate is re-derived from its stored canonical and
  // the stored hash must re-match (identity revalidation, never cached trust).
  const candidate = JSON.parse(candidateRow.canonicalJson) as FinalPlanCandidateV1;
  const recomputedHash = finalPlanCandidateHash(candidate);
  if (recomputedHash !== candidateRow.candidateHash || recomputedHash !== ref.candidateHash) {
    throw finalizationError(
      "FINAL_PLAN_CANDIDATE_STALE",
      "the frozen candidate no longer matches its recorded hash",
      { candidateId: ref.candidateId },
    );
  }

  // §48 — reload the whole world and rerun the gate. The awaiting final
  // proposal being authorized is excluded from the AWAITING_PROPOSAL_EXISTS
  // check; everything else must hold exactly as at request time.
  const { facts, audited } = buildFinalizationFactsInTx(tx, {
    runId: input.runId,
    workspaceId: input.workspaceId,
    excludeAwaitingProposalId: input.proposalId,
    clock: input.clock,
    requestId: null,
  });
  const decision = evaluateFinalization(facts);
  if (decision.status === "deny") {
    throw finalizationDeniedError(decision.reasons);
  }
  if (audited === null) {
    throw finalizationError("EVIDENCE_AUDIT_FAILED", "commit-time finalization facts carry no audit", {
      runId: input.runId,
    });
  }
  // §35 — the commit-time audited scope must be exactly the candidate's
  // frozen scope.
  const auditedKeys = audited.entries.map((entry) => evidenceKey(entry)).sort();
  const candidateKeys = candidate.evidenceScope.map((entry) => evidenceKey(entry)).sort();
  if (auditedKeys.length !== candidateKeys.length || auditedKeys.some((key, index) => key !== candidateKeys[index])) {
    throw finalizationDeniedError([
      {
        code: "EVIDENCE_AUDIT_FAILED",
        detail: { reason: "commit-time evidence scope differs from the candidate's frozen scope" },
      },
    ]);
  }

  const auditSnapshot: EvidenceAuditSnapshotV1 = {
    version: 1,
    runId: input.runId,
    inputId: candidate.synthesisInput.inputId,
    inputHash: candidate.synthesisInput.inputHash,
    entries: audited.entries.map((entry) => ({
      evidenceId: entry.evidenceId,
      revision: entry.revision,
      confidence: entry.confidence,
      criticality: entry.criticality,
      validationStrategy: entry.validationStrategy,
      state: entry.state,
      disposition: entry.disposition,
      reasonCode: entry.reasonCode,
      lastValidationEventSeq: entry.lastValidationEventSeq,
    })),
  };
  const auditId = `evaud_${input.clock.newId()}`;
  const auditHash = evidenceAuditHash(auditSnapshot);
  insertEvidenceAuditSnapshotInTx(
    tx,
    {
      runId: input.runId,
      auditId,
      purpose: "commit_time",
      inputId: candidate.synthesisInput.inputId,
      inputHash: candidate.synthesisInput.inputHash,
      candidateId: ref.candidateId,
      auditHash,
      canonicalJson: canonicalJson(auditSnapshot),
      requestId: null,
      createdAt: input.clock.nowIso(),
    },
    auditedEntriesToRows(auditSnapshot.entries),
  );
  return { candidate, candidateId: ref.candidateId, candidateHash: ref.candidateHash, auditId, auditHash };
}

// ---------------------------------------------------------------------------
// Read helpers for the MCP/context layers
// ---------------------------------------------------------------------------

/** The run's newest candidate + newest audit snapshot (read-only views). */
export function loadFinalizationContextInTx(tx: StoreTx, runId: string): {
  candidate: { candidateId: string; candidateHash: string; candidateSeq: number; canonical: FinalPlanCandidateV1 } | null;
  audit: { auditId: string; auditHash: string; purpose: EvidenceAuditPurpose; entries: number } | null;
} {
  const candidateRow = getLatestFinalPlanCandidateInTx(tx, runId);
  const candidate =
    candidateRow === null
      ? null
      : {
          candidateId: candidateRow.candidateId,
          candidateHash: candidateRow.candidateHash,
          candidateSeq: candidateRow.candidateSeq,
          canonical: JSON.parse(candidateRow.canonicalJson) as FinalPlanCandidateV1,
        };
  const latestAudit = getLatestEvidenceAuditInTx(tx, runId);
  const audit =
    latestAudit === null
      ? null
      : {
          auditId: latestAudit.auditId,
          auditHash: latestAudit.auditHash,
          purpose: latestAudit.purpose,
          entries: listEvidenceAuditEntriesInTx(tx, runId, latestAudit.auditId).length,
        };
  return { candidate, audit };
}
