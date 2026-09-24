/**
 * Repository Evidence — spec §21-§30.
 *
 * Evidence is a separate trust domain from Plan Memory: repository-derived,
 * source-backed, freshness-aware. Evidence revisions are immutable but do NOT
 * require user approval (spec §25), so the store boundary exposes a narrow
 * evidence write API — unlike committed Plan Memory, which is only writable
 * through PlanCommit.
 */
import type { DecisionID, EvidenceID, SectionID } from "../core/ids.js";
import type { EvidenceRef, Timestamp } from "../core/refs.js";

export type EvidenceKind =
  | "file"
  | "symbol"
  | "interface"
  | "dependency"
  | "configuration"
  | "behavior"
  | "test"
  | "runtime"
  | "architecture";

export type EvidenceConfidence = "direct" | "derived" | "uncertain";

export type EvidenceCriticality = "critical" | "supporting" | "informational";

export type EvidenceFreshness = "fresh" | "needs_validation" | "stale";

export type EvidenceStatus = "active" | "stale" | "invalidated";

/**
 * Version-control state plus workspace fingerprint (spec §25). Correctness
 * never depends on hashing the whole repository.
 */
export interface RepositoryRevision {
  vcs?: {
    type: "git";
    commit?: string;
    branch?: string;
  };
  workspaceFingerprint: string;
}

/** Where a piece of Evidence applies. Structural, not semantic search. */
export type EvidenceScope =
  | { kind: "run" }
  | { kind: "architecture" }
  | { kind: "section"; sectionID: SectionID }
  | { kind: "decision"; decisionID: DecisionID };

/**
 * Source provenance (spec §24). Every direct Evidence record must reference
 * actual observations or repository sources accessed during the planning
 * session — a direct claim cannot be created solely from model memory.
 */
export interface EvidenceSource {
  type: "file" | "symbol" | "command" | "test" | "package_metadata" | "runtime";
  path?: string;
  symbol?: string;
  range?: {
    startLine: number;
    endLine: number;
  };
  command?: string;
  revision?: RepositoryRevision;
  contentHash?: string;
}

export interface Evidence {
  id: EvidenceID;
  revision: number;

  kind: EvidenceKind;
  claim: string;

  source: EvidenceSource[];
  scope: EvidenceScope;

  confidence: EvidenceConfidence;
  criticality: EvidenceCriticality;
  freshness: EvidenceFreshness;
  status: EvidenceStatus;

  /** Upstream records for derived evidence (spec §26). */
  derivedFrom?: EvidenceRef[];

  discoveredAt: Timestamp;
  lastValidatedAt: Timestamp;
}
