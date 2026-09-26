/**
 * Proposal canonical representations and deterministic hash (frozen plan
 * Phase 6 §22–§24; Phase 10 §31–§33).
 *
 * ProposalCanonicalV1 is the historical Phase-6 serialization — fully readable
 * and hash-verifiable forever, and never rewritten or re-hashed (§32). No V1
 * proposal ever gains inferred Evidence refs (no retroactive inference).
 *
 * ProposalCanonicalV2 (Phase 10 §31) adds `requiredEvidence: EvidenceRef[]` —
 * the exact Evidence revisions this proposal depends on, deterministically
 * sorted, hashed into the canonical form. A user approving a V2 proposal
 * therefore approves the design change AND the exact evidence set it rests on.
 * ALL proposals created after Phase 10 use V2, even with an empty set (§33).
 *
 * The hash is server-generated: callers may only echo back
 * (proposalId, proposalRevision, proposalHash) for authorization; the server
 * reloads the authoritative canonical form and recomputes. Nobody can hand
 * the engine a body+hash pair and have the hash believed.
 */

import { createHash } from "node:crypto";

import { canonicalJson } from "./canonical-json.js";
import type {
  ArtifactRef,
  ImpactAnalysis,
  NormalizedProposalChange,
  ProposalScope,
  ProposalType,
} from "./proposal.js";
import type { DerivedFromRef } from "../store/evidence.js";

export const PROPOSAL_CANONICAL_SCHEMA = "phase-plan.proposal";
export const PROPOSAL_CANONICAL_V1_VERSION = 1;
export const PROPOSAL_CANONICAL_VERSION = 2;

/** Exact upstream Evidence reference ({evidenceId, revision}). */
export type ProposalEvidenceRef = DerivedFromRef;

export interface ProposalCanonicalV1 {
  schema: typeof PROPOSAL_CANONICAL_SCHEMA;
  version: typeof PROPOSAL_CANONICAL_V1_VERSION;
  runId: string;
  proposalId: string;
  proposalRevision: number;
  type: ProposalType;
  scope: ProposalScope;
  baseRunRevision: number;
  baseHeadSnapshotId: string | null;
  baseHeadCommitId: string | null;
  title: string;
  summary: string;
  changes: NormalizedProposalChange[];
  dependencies: ArtifactRef[];
  impact: ImpactAnalysis;
}

export interface ProposalCanonicalV2 extends Omit<ProposalCanonicalV1, "version"> {
  version: typeof PROPOSAL_CANONICAL_VERSION;
  /** Exact Evidence revisions this proposal depends on (§31); [] when none. */
  requiredEvidence: ProposalEvidenceRef[];
}

/** The shared non-version fields of a proposal canonical. */
interface CanonicalBase {
  runId: string;
  proposalId: string;
  proposalRevision: number;
  type: ProposalType;
  scope: ProposalScope;
  baseRunRevision: number;
  baseHeadSnapshotId: string | null;
  baseHeadCommitId: string | null;
  title: string;
  summary: string;
  changes: NormalizedProposalChange[];
  dependencies: ArtifactRef[];
  impact: ImpactAnalysis;
}

/** The frozen Phase-6 builder — kept verbatim for V1 hash compatibility (§32). */
export function buildProposalCanonicalV1(input: CanonicalBase): ProposalCanonicalV1 {
  return {
    schema: PROPOSAL_CANONICAL_SCHEMA,
    version: PROPOSAL_CANONICAL_V1_VERSION,
    runId: input.runId,
    proposalId: input.proposalId,
    proposalRevision: input.proposalRevision,
    type: input.type,
    scope: input.scope,
    baseRunRevision: input.baseRunRevision,
    baseHeadSnapshotId: input.baseHeadSnapshotId,
    baseHeadCommitId: input.baseHeadCommitId,
    title: input.title,
    summary: input.summary,
    changes: input.changes,
    dependencies: input.dependencies,
    impact: input.impact,
  };
}

/**
 * The Phase-10 builder: every newly frozen proposal revision is V2 (§33),
 * with requiredEvidence deterministically sorted (evidenceId, then revision).
 */
export function buildProposalCanonical(input: CanonicalBase & { requiredEvidence?: ProposalEvidenceRef[] }): ProposalCanonicalV2 {
  return {
    schema: PROPOSAL_CANONICAL_SCHEMA,
    version: PROPOSAL_CANONICAL_VERSION,
    runId: input.runId,
    proposalId: input.proposalId,
    proposalRevision: input.proposalRevision,
    type: input.type,
    scope: input.scope,
    baseRunRevision: input.baseRunRevision,
    baseHeadSnapshotId: input.baseHeadSnapshotId,
    baseHeadCommitId: input.baseHeadCommitId,
    title: input.title,
    summary: input.summary,
    changes: input.changes,
    dependencies: input.dependencies,
    impact: input.impact,
    requiredEvidence: [...(input.requiredEvidence ?? [])].sort(
      (a, b) => a.evidenceId.localeCompare(b.evidenceId) || a.revision - b.revision,
    ),
  };
}

/** `sha256:<lowercase hex>` over the canonical serialization (§23). */
export function canonicalProposalHash(canonical: ProposalCanonicalV1 | ProposalCanonicalV2): string {
  const digest = createHash("sha256").update(canonicalJson(canonical), "utf8").digest("hex");
  return `sha256:${digest}`;
}

/**
 * Structural check that a parsed canonical object really is a proposal
 * canonical (used when re-loading persisted canonical_json before hashing).
 * V1 parses with requiredEvidence = [] — historical proposals NEVER gain
 * inferred evidence refs (§32); the refs table is the only V2 index.
 */
export function parseProposalCanonical(value: unknown): ProposalCanonicalV1 | ProposalCanonicalV2 {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("proposal canonical must be a JSON object");
  }
  const raw = value as Record<string, unknown>;
  if (raw.schema !== PROPOSAL_CANONICAL_SCHEMA) {
    throw new TypeError("proposal canonical schema marker mismatch");
  }
  if (raw.version === PROPOSAL_CANONICAL_V1_VERSION) {
    return raw as unknown as ProposalCanonicalV1;
  }
  if (raw.version === PROPOSAL_CANONICAL_VERSION) {
    if (!Array.isArray(raw.requiredEvidence)) {
      throw new TypeError("proposal canonical V2 requires a requiredEvidence array");
    }
    return raw as unknown as ProposalCanonicalV2;
  }
  throw new TypeError("proposal canonical version marker mismatch");
}

/** The exact requiredEvidence set of a parsed canonical (V1 → [], §32). */
export function requiredEvidenceOf(canonical: ProposalCanonicalV1 | ProposalCanonicalV2): ProposalEvidenceRef[] {
  return canonical.version === PROPOSAL_CANONICAL_VERSION ? canonical.requiredEvidence : [];
}
