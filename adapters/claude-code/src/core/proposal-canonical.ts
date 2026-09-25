/**
 * Proposal canonical representation and deterministic hash (frozen plan
 * Phase 6 §22–§24).
 *
 * ProposalCanonicalV1 is the ONE unique semantic serialization of a frozen
 * proposal revision: design content plus the exact base it was prepared
 * against. Timestamps, approval ids, commit ids, and status are excluded —
 * they are not design semantics, so amending them can never change a hash.
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

export const PROPOSAL_CANONICAL_SCHEMA = "phase-plan.proposal";
export const PROPOSAL_CANONICAL_VERSION = 1;

export interface ProposalCanonicalV1 {
  schema: typeof PROPOSAL_CANONICAL_SCHEMA;
  version: typeof PROPOSAL_CANONICAL_VERSION;
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

export function buildProposalCanonical(input: {
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
}): ProposalCanonicalV1 {
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
  };
}

/** `sha256:<lowercase hex>` over the canonical serialization (§23). */
export function canonicalProposalHash(canonical: ProposalCanonicalV1): string {
  const digest = createHash("sha256").update(canonicalJson(canonical), "utf8").digest("hex");
  return `sha256:${digest}`;
}

/**
 * Structural check that a parsed canonical object really is a v1 proposal
 * canonical (used when re-loading persisted canonical_json before hashing).
 */
export function parseProposalCanonical(value: unknown): ProposalCanonicalV1 {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("proposal canonical must be a JSON object");
  }
  const raw = value as Record<string, unknown>;
  if (raw.schema !== PROPOSAL_CANONICAL_SCHEMA || raw.version !== PROPOSAL_CANONICAL_VERSION) {
    throw new TypeError("proposal canonical schema/version marker mismatch");
  }
  return raw as unknown as ProposalCanonicalV1;
}
