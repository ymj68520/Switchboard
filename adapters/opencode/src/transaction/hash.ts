/**
 * Proposal approval hash — the frozen canonical hash contract (Phase 2A.1).
 *
 * The approval hash represents EXACTLY the immutable content the user is
 * shown and approves:
 *
 * INCLUDED (canonical payload):  id, revision, type, scope, title, summary,
 *                                changes, dependencies, impact, createdFrom
 * EXCLUDED (workflow/runtime):   status (changes at ready → awaiting_approval
 *                                and approved/rejected), hash itself
 * (The Proposal type carries no timestamps.)
 *
 * Canonicalization: `stableStringify` (core/invariants.ts) — object keys sorted
 * lexicographically, `undefined` fields dropped, arrays kept in order (array
 * order is semantic: changes are an atomic set presented in a specific order),
 * no other normalization. SHA-256 over the UTF-8 canonical serialization.
 *
 * Invariant: the `ready → awaiting_approval` transition does NOT change the
 * hash, because `status` is excluded from the payload. Any content change
 * produces a different hash, which is what makes "what the user approves is
 * exactly what gets committed" verifiable.
 */
import { createHash } from "node:crypto";

import { stableStringify } from "../core/invariants.js";
import type { Proposal } from "./types.js";

/**
 * Canonical hashable projection of a Proposal: everything that defines the
 * approved content, nothing that records workflow state.
 */
export interface ProposalApprovalPayload {
  id: Proposal["id"];
  revision: Proposal["revision"];
  type: Proposal["type"];
  scope: Proposal["scope"];
  title: Proposal["title"];
  summary: Proposal["summary"];
  changes: Proposal["changes"];
  dependencies: Proposal["dependencies"];
  impact: Proposal["impact"];
  createdFrom: Proposal["createdFrom"];
}

export function proposalApprovalPayload(proposal: Proposal): ProposalApprovalPayload {
  return {
    id: proposal.id,
    revision: proposal.revision,
    type: proposal.type,
    scope: proposal.scope,
    title: proposal.title,
    summary: proposal.summary,
    changes: proposal.changes,
    dependencies: proposal.dependencies,
    impact: proposal.impact,
    createdFrom: proposal.createdFrom,
  };
}

export function computeProposalHash(proposal: Proposal): string {
  return computePayloadHash(proposalApprovalPayload(proposal));
}

export function computePayloadHash(payload: ProposalApprovalPayload): string {
  const hash = createHash("sha256");
  hash.update(stableStringify(payload));
  return hash.digest("hex");
}
