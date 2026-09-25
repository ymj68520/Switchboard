/**
 * Phase 2H — deterministic finalization (frozen architecture §30 "Evidence
 * Audit Before Final Plan"; Phase 2H brief §3-§51).
 *
 * AUTHORITY CLASS: everything here is a DERIVED workflow artifact, the same
 * family as the Phase 2F synthesis artifacts and the Phase 2G ValidationReport.
 * An EvidenceAuditSnapshot and a FinalPlanCandidate are durable, immutable,
 * canonical-hashed, exact-ref-bound — and NOT committed Plan Memory: creating
 * one requires no Proposal, no Approval, no PlanCommit, moves HEAD nowhere,
 * creates zero Snapshots, and changes no stage (brief §5/§42). Neither artifact
 * ever sets PlanningRun.finalPlan (brief §40) or transitions synthesis → final
 * (brief §41): a candidate is NOT the FinalPlan, NOT user authorization, and
 * does not authorize Build handoff (brief §30/§76).
 *
 * ONE FINALIZATION AUTHORITY (brief §3): the legacy infrastructure predicate
 * (core/invariants.ts checkFinalization) is REPLACED by the deterministic gate
 * in finalization/gate.ts. The gate has no model call; the model may only
 * REQUEST finalization (ultraplan_request_finalization) — it can never declare
 * an audit passed, a plan final, or a stage change.
 *
 * EVIDENCE RULES (brief §11; frozen architecture §30):
 * - critical: blocks unless status=active AND freshness=fresh AND
 *   confidence != uncertain;
 * - supporting: conservatively blocks unless status=active AND freshness=fresh
 *   (the existing state model has no other revalidation signal, so any
 *   needs_validation/stale/invalidated supporting record fails closed);
 * - informational: state is RECORDED but never blocks by itself (architecture
 *   §30: "Informational Evidence does not block finalization").
 */
import type {
  CommitID,
  EvidenceAuditID,
  EvidenceID,
  FinalPlanCandidateID,
  PlanID,
  SectionID,
  SynthesisInputID,
  SynthesisManifestID,
  ValidationReportID,
} from "../core/ids.js";
import type {
  ArchitectureRef,
  DecisionRef,
  SnapshotRef,
  Timestamp,
} from "../core/refs.js";
import type { Constraint } from "../core/types.js";
import type {
  EvidenceConfidence,
  EvidenceCriticality,
  EvidenceFreshness,
  EvidenceStatus,
} from "../repository/evidence.js";
import type { DerivedStatement, ImplementationStep } from "../synthesis/types.js";
import type { SectionRevisionRef } from "../core/refs.js";

// ---------------------------------------------------------------------------
// Evidence audit (brief §5-§17)
// ---------------------------------------------------------------------------

/**
 * How one evidence record was reached (brief §7): the exact committed Decision
 * revision citing it, plus the approved design anchors that pull that decision
 * in — the exact Architecture revision (basedOn), an exact approved
 * SectionRevision (decisions list), or the HEAD snapshot's own decision
 * binding (a committed decision HEAD represents that no design anchor cites).
 */
export interface EvidenceReachability {
  decision: DecisionRef;
  anchors: EvidenceReachabilityAnchor[];
}

export type EvidenceReachabilityAnchor =
  | { kind: "architecture" }
  | { kind: "section"; id: SectionID; revision: number }
  | { kind: "head_snapshot" };

/**
 * One audited Evidence record (brief §14 "entries"). `ref` is the EXACT
 * referenced revision — a decision that pinned EVD-017@2 is audited at @2,
 * never silently rebased to a newer revision (brief §8). `latestRevision` is
 * the record's current newest revision, so "a newer revision exists" is
 * explicit, and the state fingerprint below binds it (any new revision moves
 * the audit identity — a known source change can never hide).
 *
 * The entry carries ALL fingerprint inputs (state fields, derivedFrom exact
 * refs, represented source-provenance identities) so the evidenceStateHash
 * recomputes from stored entries alone during durable load validation (§62).
 */
export interface EvidenceAuditEntry {
  ref: { id: EvidenceID; revision: number };
  latestRevision: number;
  confidence: EvidenceConfidence;
  criticality: EvidenceCriticality;
  freshness: EvidenceFreshness;
  status: EvidenceStatus;
  /** Exact upstream refs of derived evidence, when the record represents them (brief §10). */
  derivedFrom?: import("../core/refs.js").EvidenceRef[];
  /** Provenance identities of the record's represented sources (brief §10; never repository contents). */
  sourceIdentities: string[];
  reachableFrom: EvidenceReachability[];
  /** Per-entry rule outcome (brief §11). Informational entries never flag. */
  verdict: "pass" | "flagged";
  /** Entry-level blocker codes (subset of EVIDENCE_AUDIT_BLOCKER_CODES). */
  blockers: EvidenceAuditBlockerCode[];
}

/**
 * Closed machine-readable audit blocker vocabulary (brief §15).
 * `synthesis_evidence_stale` is the brief §9 cross-check: the CURRENT
 * authoritative state of a relevant (frozen-input) evidence record differs
 * materially from the state synthesis/validation consumed. It is the GATE's
 * job (not the audit's) to classify it as STALE rather than blocked — the
 * audit only records the fact (brief §28: never conflate the two).
 */
export const EVIDENCE_AUDIT_BLOCKER_CODES = [
  "critical_not_fresh",
  "critical_uncertain",
  "supporting_needs_validation",
  "evidence_stale",
  "evidence_invalidated",
  "evidence_missing",
  "evidence_revision_mismatch",
  "synthesis_evidence_stale",
] as const;
export type EvidenceAuditBlockerCode = (typeof EVIDENCE_AUDIT_BLOCKER_CODES)[number];

/** One audit-level blocker: the closed code plus what it names. */
export interface EvidenceAuditBlocker {
  code: EvidenceAuditBlockerCode;
  /** The evidence record involved, when the code names one. */
  evidence?: { id: EvidenceID; revision?: number };
  /** Stable machine detail — never prose the model must parse (brief §15). */
  detail?: string;
}

/**
 * The immutable Evidence Audit authority snapshot (brief §14). The hash covers
 * the full authority payload EXCLUDING id/createdAt/hash (the existing
 * derived-hash convention, brief §16) so auditing the exact same authoritative
 * state twice is byte-identical (brief §17).
 */
export interface EvidenceAuditSnapshot {
  id: EvidenceAuditID;
  planID: PlanID;

  headSnapshot: SnapshotRef;
  headCommit: CommitID | null;

  synthesisInput: {
    id: SynthesisInputID;
    hash: string;
  };

  synthesisManifest: {
    id: SynthesisManifestID;
    revision: number;
    hash: string;
  };

  validationReport: {
    id: ValidationReportID;
    hash: string;
  };

  entries: EvidenceAuditEntry[];

  counts: EvidenceAuditCounts;

  result: "pass" | "blocked";

  blockers: EvidenceAuditBlocker[];

  /**
   * Canonical fingerprint over the reachable CURRENT Evidence state (brief
   * §10). Part of the audit's identity: evidence can change without HEAD, and
   * any change moves this hash — the gate re-checks it against a live
   * recompute on every request (brief §26).
   */
  evidenceStateHash: string;

  createdAt: Timestamp;
  hash: string;
}

/** Diagnostic tallies over the audited entries (brief §14). Recomputed and checked on load. */
export interface EvidenceAuditCounts {
  freshCritical: number;
  freshSupporting: number;
  informational: number;
  needsValidation: number;
  stale: number;
  invalidated: number;
  criticalUncertain: number;
}

/**
 * The audit's content-level identity (brief §17): the exact audited
 * authoritative state. Auditing the same state twice REUSES the same snapshot
 * (no duplicate audits); any change — HEAD, synthesis identity, validation
 * report, or any reachable evidence record — moves at least one component.
 */
export interface EvidenceAuditIdentity {
  headSnapshot: string;
  inputHash: string;
  manifestHash: string;
  reportHash: string;
  evidenceStateHash: string;
}

/** Canonical key for identity lookup. */
export function evidenceAuditIdentityKey(identity: EvidenceAuditIdentity): string {
  return [identity.headSnapshot, identity.inputHash, identity.manifestHash, identity.reportHash, identity.evidenceStateHash].join("|");
}

// ---------------------------------------------------------------------------
// Deterministic finalization gate (brief §18-§29)
// ---------------------------------------------------------------------------

/** Gate blocker vocabulary — SEMANTIC deficiencies of the current state (brief §28). */
export const FINALIZATION_BLOCKER_CODES = [
  "lifecycle_not_active",
  "stage_not_synthesis",
  "active_work_present",
  "head_missing",
  "sections_missing",
  "architecture_missing",
  "architecture_not_approved",
  "architecture_snapshot_mismatch",
  "section_not_approved",
  "section_needs_review",
  "section_revision_mismatch",
  "section_contract_missing",
  "synthesis_input_missing",
  "synthesis_manifest_missing",
  "manifest_input_mismatch",
  "manifest_unresolved_findings",
  "validation_not_clean",
  "evidence_audit_missing",
  "evidence_audit_blocked",
  "blocking_question",
  "blocking_conflict",
] as const;
export type FinalizationBlockerCode = (typeof FINALIZATION_BLOCKER_CODES)[number];

/** Gate staleness vocabulary — state MOVED ON; re-resolve, never rebase (brief §28). */
export const FINALIZATION_STALENESS_CODES = [
  "head_changed",
  "synthesis_input_stale",
  "manifest_not_current",
  "validation_report_not_current",
  "evidence_audit_stale",
  "synthesis_evidence_stale",
] as const;
export type FinalizationStalenessCode = (typeof FINALIZATION_STALENESS_CODES)[number];

/** One gate blocker: closed code plus the exact objects it names. */
export interface FinalizationBlocker {
  code: FinalizationBlockerCode;
  sectionID?: SectionID;
  questionIDs?: string[];
  conflictIDs?: string[];
  /** Aggregated audit blockers, for evidence_audit_blocked. */
  evidenceBlockers?: EvidenceAuditBlocker[];
  detail?: string;
}

/** One staleness reason: closed code plus what moved. */
export interface FinalizationStaleness {
  code: FinalizationStalenessCode;
  detail?: string;
}

/**
 * The successful gate's exact authority identity — the inputs a
 * FinalPlanCandidate binds (brief §28/§31).
 */
export interface FinalizationIdentity {
  headSnapshot: SnapshotRef;
  headCommit: CommitID | null;
  architecture: ArchitectureRef;
  synthesisInput: { id: SynthesisInputID; hash: string };
  synthesisManifest: { id: SynthesisManifestID; revision: number; hash: string };
  validationReport: { id: ValidationReportID; hash: string };
  evidenceAudit: { id: EvidenceAuditID; hash: string };
}

export type FinalizationGateResult =
  | { result: "pass"; identity: FinalizationIdentity }
  | { result: "blocked"; blockers: FinalizationBlocker[] }
  | { result: "stale"; stale: FinalizationStaleness[] };

// ---------------------------------------------------------------------------
// FinalPlanCandidate (brief §30-§51)
// ---------------------------------------------------------------------------

/**
 * The candidate's validation summary — frozen AT GATE TIME from verified
 * counts (never model-supplied, never recomputed into optimism; brief §31).
 * Durable load validation requires every value to still hold (§63).
 */
export interface CandidateValidationSummary {
  blockingQuestions: 0;
  blockingConflicts: 0;
  invalidSections: 0;
  semanticValidation: "clean";
  evidenceAudit: "pass";
}

/**
 * Harness-level draft the controller hands to the store (the candidate minus
 * its Harness-assigned identity: id, revision, createdAt, hash — assigned
 * IN-LOCK by the store after the identity lookup, mirroring the
 * SynthesisManifest design so concurrent instances converge on one revision).
 * This exact object is the canonical hash payload (brief §37).
 */
export interface FinalPlanCandidateDraft {
  planID: PlanID;

  baseSnapshot: SnapshotRef;
  baseCommit: CommitID | null;

  architecture: ArchitectureRef;
  /** Exact approved Section revisions, canonical DAG order. */
  sections: SectionRevisionRef[];
  /** Exact committed Decision revisions bound by HEAD (never "latest", brief §35). */
  decisions: DecisionRef[];
  /** Committed constraints HEAD binds (identity-only domain, brief §36). */
  constraints: Constraint[];

  synthesisInput: {
    id: SynthesisInputID;
    hash: string;
  };

  synthesisManifest: {
    id: SynthesisManifestID;
    revision: number;
    hash: string;
  };

  semanticValidation: {
    reportID: ValidationReportID;
    hash: string;
  };

  evidenceAudit: {
    id: EvidenceAuditID;
    hash: string;
  };

  /** EXACT copy of the validated manifest implementation order (brief §33). */
  implementationOrder: ImplementationStep[];
  /** EXACT copy of the validated manifest limitations (brief §34). */
  limitations: DerivedStatement[];

  validation: CandidateValidationSummary;
}

/**
 * The immutable FinalPlanCandidate (brief §31) — the smallest complete
 * execution-facing projection assembled DETERMINISTICALLY from approved Plan
 * Memory + the current SynthesisManifest + the current clean ValidationReport
 * + the current EvidenceAuditSnapshot (brief §32; no model call, no new
 * normative prose). The hash covers the full authority payload EXCLUDING
 * id/revision/createdAt/hash (brief §37; the existing derived-hash convention).
 */
export interface FinalPlanCandidate {
  id: FinalPlanCandidateID;
  planID: PlanID;
  /** Harness-assigned 1..n per candidate family; prior revisions immutable (brief §39). */
  revision: number;

  baseSnapshot: SnapshotRef;
  baseCommit: CommitID | null;

  architecture: ArchitectureRef;
  /** Exact approved Section revisions, canonical DAG order (brief §31/§35-style exactness). */
  sections: SectionRevisionRef[];
  /** Exact committed Decision revisions bound by HEAD (never "latest", brief §35). */
  decisions: DecisionRef[];
  /** Committed constraints HEAD binds (identity-only domain; no invented revisions, brief §36). */
  constraints: Constraint[];

  synthesisInput: {
    id: SynthesisInputID;
    hash: string;
  };

  synthesisManifest: {
    id: SynthesisManifestID;
    revision: number;
    hash: string;
  };

  semanticValidation: {
    reportID: ValidationReportID;
    hash: string;
  };

  evidenceAudit: {
    id: EvidenceAuditID;
    hash: string;
  };

  /** EXACT copy of the validated manifest implementation order (brief §33 — never regenerated). */
  implementationOrder: ImplementationStep[];
  /** EXACT copy of the validated manifest limitations (brief §34 — never silently dropped). */
  limitations: DerivedStatement[];

  validation: CandidateValidationSummary;

  createdAt: Timestamp;
  hash: string;
}

/**
 * The candidate's content-level identity (brief §38): the exact successful
 * gate identity. request_finalization over the same state returns the same
 * candidate; any authority-input change requires a new revision.
 */
export interface FinalPlanCandidateIdentity {
  headSnapshot: string;
  inputHash: string;
  manifestHash: string;
  reportHash: string;
  auditHash: string;
}

/** Canonical key for candidate identity lookup. */
export function finalPlanCandidateIdentityKey(identity: FinalPlanCandidateIdentity): string {
  return [identity.headSnapshot, identity.inputHash, identity.manifestHash, identity.reportHash, identity.auditHash].join("|");
}
