/**
 * Canonical finalization hashes (Phase 2H brief §10/§16/§37).
 *
 * Canonicalization is the SAME contract as every other derived artifact hash
 * (transaction/hash.ts + synthesis/hash.ts + validation/hash.ts):
 * `stableStringify` — object keys sorted lexicographically, `undefined`
 * fields dropped, arrays kept in order, SHA-256 over the UTF-8 canonical
 * serialization.
 *
 * EVIDENCE STATE FINGERPRINT (brief §10): bound per entry — the EXACT
 * referenced revision, its state fields, `derivedFrom` exact refs where
 * present, and the represented source-provenance identities; entries are
 * sorted by (id, revision) so the fingerprint is traversal-order independent.
 * The record's current revision is included so a NEW revision of any
 * reachable record moves the fingerprint even when the referenced revision's
 * own fields are immutable. No repository contents are hashed.
 *
 * AUDIT HASH (brief §16): includes planID, HEAD refs, the synthesis/
 * validation identity refs + hashes, entries, counts, result, blockers, and
 * the evidenceStateHash. EXCLUDES id/createdAt/hash itself.
 *
 * CANDIDATE HASH (brief §37): includes base snapshot/commit, architecture,
 * ordered section revisions, decision refs, constraints, all four bound
 * authority refs + hashes, implementationOrder, limitations, and the
 * validation summary. EXCLUDES id/revision/createdAt/hash itself.
 */
import { createHash } from "node:crypto";

import { stableStringify } from "../core/invariants.js";
import type { Evidence, EvidenceSource } from "../repository/evidence.js";
import type {
  CandidateValidationSummary,
  EvidenceAuditCounts,
  EvidenceAuditEntry,
  EvidenceAuditSnapshot,
  FinalPlanCandidate,
} from "./types.js";

export function sha256(canonical: string): string {
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Provenance identity of one Evidence source record — only the fields the
 * domain actually represents (brief §10: "relevant source fingerprint /
 * provenance identity where already represented"). Repository CONTENTS are
 * never read or hashed.
 */
export function evidenceSourceIdentity(source: EvidenceSource): string {
  const parts: string[] = [source.type];
  if (source.path !== undefined) parts.push(`path=${source.path}`);
  if (source.symbol !== undefined) parts.push(`symbol=${source.symbol}`);
  if (source.range !== undefined) parts.push(`range=${source.range.startLine}-${source.range.endLine}`);
  if (source.command !== undefined) parts.push(`command=${source.command}`);
  if (source.revision !== undefined) {
    const vcs = source.revision.vcs;
    if (vcs !== undefined) {
      parts.push(`vcs=${vcs.type}:${vcs.commit ?? ""}:${vcs.branch ?? ""}`);
    }
    parts.push(`workspace=${source.revision.workspaceFingerprint}`);
  }
  if (source.contentHash !== undefined) parts.push(`content=${source.contentHash}`);
  return parts.join("|");
}

/** The canonical fingerprint payload for one audited evidence record. */
export interface EvidenceFingerprintEntry {
  ref: EvidenceAuditEntry["ref"];
  recordRevision: number;
  confidence: EvidenceAuditEntry["confidence"];
  criticality: EvidenceAuditEntry["criticality"];
  freshness: EvidenceAuditEntry["freshness"];
  status: EvidenceAuditEntry["status"];
  derivedFrom?: NonNullable<EvidenceAuditEntry["derivedFrom"]>;
  sourceIdentities: EvidenceAuditEntry["sourceIdentities"];
}

export function evidenceEntryFingerprint(entry: EvidenceAuditEntry): EvidenceFingerprintEntry {
  return {
    ref: entry.ref,
    recordRevision: entry.latestRevision,
    confidence: entry.confidence,
    criticality: entry.criticality,
    freshness: entry.freshness,
    status: entry.status,
    ...(entry.derivedFrom !== undefined && entry.derivedFrom.length > 0 ? { derivedFrom: entry.derivedFrom } : {}),
    sourceIdentities: entry.sourceIdentities,
  };
}

/** Build one entry's fingerprint inputs from a live Evidence record (assembly time). */
export function evidenceFingerprintInputs(evidence: Evidence): {
  derivedFrom?: Evidence["derivedFrom"];
  sourceIdentities: string[];
} {
  return {
    ...(evidence.derivedFrom !== undefined && evidence.derivedFrom.length > 0
      ? { derivedFrom: evidence.derivedFrom }
      : {}),
    sourceIdentities: evidence.source.map(evidenceSourceIdentity),
  };
}

/** Canonical SHA-256 over the reachable current Evidence state (brief §10). */
export function computeEvidenceStateHash(entries: readonly EvidenceAuditEntry[]): string {
  const sorted = [...entries].sort((a, b) => {
    if (a.ref.id !== b.ref.id) return a.ref.id < b.ref.id ? -1 : 1;
    return a.ref.revision - b.ref.revision;
  });
  return sha256(stableStringify(sorted.map(evidenceEntryFingerprint)));
}

/** The audit's canonical hash payload (brief §16). */
export interface EvidenceAuditHashPayload {
  planID: EvidenceAuditSnapshot["planID"];
  headSnapshot: EvidenceAuditSnapshot["headSnapshot"];
  headCommit: EvidenceAuditSnapshot["headCommit"];
  synthesisInput: EvidenceAuditSnapshot["synthesisInput"];
  synthesisManifest: EvidenceAuditSnapshot["synthesisManifest"];
  validationReport: EvidenceAuditSnapshot["validationReport"];
  entries: EvidenceAuditEntry[];
  counts: EvidenceAuditCounts;
  result: EvidenceAuditSnapshot["result"];
  blockers: EvidenceAuditSnapshot["blockers"];
  evidenceStateHash: string;
}

export function evidenceAuditHashPayload(
  audit: Omit<EvidenceAuditSnapshot, "id" | "createdAt" | "hash">,
): EvidenceAuditHashPayload {
  return {
    planID: audit.planID,
    headSnapshot: audit.headSnapshot,
    headCommit: audit.headCommit,
    synthesisInput: audit.synthesisInput,
    synthesisManifest: audit.synthesisManifest,
    validationReport: audit.validationReport,
    entries: audit.entries,
    counts: audit.counts,
    result: audit.result,
    blockers: audit.blockers,
    evidenceStateHash: audit.evidenceStateHash,
  };
}

export function computeEvidenceAuditHash(payload: EvidenceAuditHashPayload): string {
  return sha256(stableStringify(payload));
}

/** Stored-record recompute for durable fail-closed loading (brief §62). */
export function computeEvidenceAuditHashFromRecord(
  audit: Omit<EvidenceAuditSnapshot, "id" | "createdAt" | "hash">,
): string {
  return computeEvidenceAuditHash(evidenceAuditHashPayload(audit));
}

/** The candidate's canonical hash payload (brief §37). */
export interface FinalPlanCandidateHashPayload {
  planID: FinalPlanCandidate["planID"];
  baseSnapshot: FinalPlanCandidate["baseSnapshot"];
  baseCommit: FinalPlanCandidate["baseCommit"];
  architecture: FinalPlanCandidate["architecture"];
  sections: FinalPlanCandidate["sections"];
  decisions: FinalPlanCandidate["decisions"];
  constraints: FinalPlanCandidate["constraints"];
  synthesisInput: FinalPlanCandidate["synthesisInput"];
  synthesisManifest: FinalPlanCandidate["synthesisManifest"];
  semanticValidation: FinalPlanCandidate["semanticValidation"];
  evidenceAudit: FinalPlanCandidate["evidenceAudit"];
  implementationOrder: FinalPlanCandidate["implementationOrder"];
  limitations: FinalPlanCandidate["limitations"];
  validation: CandidateValidationSummary;
}

export function finalPlanCandidateHashPayload(
  candidate: Omit<FinalPlanCandidate, "id" | "revision" | "createdAt" | "hash">,
): FinalPlanCandidateHashPayload {
  return {
    planID: candidate.planID,
    baseSnapshot: candidate.baseSnapshot,
    baseCommit: candidate.baseCommit,
    architecture: candidate.architecture,
    sections: candidate.sections,
    decisions: candidate.decisions,
    constraints: candidate.constraints,
    synthesisInput: candidate.synthesisInput,
    synthesisManifest: candidate.synthesisManifest,
    semanticValidation: candidate.semanticValidation,
    evidenceAudit: candidate.evidenceAudit,
    implementationOrder: candidate.implementationOrder,
    limitations: candidate.limitations,
    validation: candidate.validation,
  };
}

export function computeFinalPlanCandidateHash(payload: FinalPlanCandidateHashPayload): string {
  return sha256(stableStringify(payload));
}

/** Stored-record recompute for durable fail-closed loading (brief §63). */
export function computeFinalPlanCandidateHashFromRecord(
  candidate: Omit<FinalPlanCandidate, "id" | "revision" | "createdAt" | "hash">,
): string {
  return computeFinalPlanCandidateHash(finalPlanCandidateHashPayload(candidate));
}
