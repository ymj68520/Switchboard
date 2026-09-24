/**
 * Approval admission state machine — Phase 2A.1 Correction C (frozen contract
 * for Phase 2B; no Approval persistence or PlanCommit execution here).
 *
 * The frozen lifecycle Phase 2B consumes:
 *
 *   working discussion
 *     ↓ (Harness creates the proposal — never the model)
 *   ready                        ← proposal intent, NOT approvable
 *     ↓ beginApproval(...)       ← Harness-controlled, atomic, content-frozen
 *   awaiting_approval
 *     ↓ structured user decision (one-shot, exact-hash-bound)
 *   approved | rejected          ← applied by the Phase 2B transaction engine
 *
 * The load-bearing rule: a `ready` Proposal is NOT directly approvable and not
 * committable. Before the user is asked, the Harness atomically transitions
 * the exact frozen proposal to `awaiting_approval`; the approval hash does not
 * change during that transition (status is excluded from the payload — see
 * transaction/hash.ts).
 *
 * Authority properties enforced here:
 * - the model cannot construct a valid user decision object; decisions enter
 *   only through this boundary from verified user interaction;
 * - an approval binds the exact proposalID + revision + hash; any mismatch is
 *   rejected (`approval_mismatch`);
 * - a `ready` proposal cannot be treated as approved (`proposal_not_approvable`).
 */
import { ApprovalIDs } from "../core/ids.js";
import type { ProposalID } from "../core/ids.js";
import { UltraPlanError } from "../core/errors.js";
import type { Timestamp } from "../core/refs.js";
import type { Approval, Proposal } from "./types.js";

/**
 * What the Harness presents to the structured user-interaction primitive.
 * `oneShot` is a type-level commitment: OpenCode's `ToolContext.ask` exposes a
 * persistent "always allow" concept via its `always` patterns — the approval
 * gateway contract (see protocol doc §7) forbids passing any, so a permission
 * can never become a standing approval authority.
 */
export interface ApprovalRequest {
  proposalID: ProposalID;
  proposalRevision: number;
  proposalHash: string;
  oneShot: true;
  requestedAt: Timestamp;
}

/**
 * One structured user decision bound to one exact proposal revision. There is
 * deliberately no "always"/persistent variant.
 */
export type UserApprovalDecision =
  | {
      kind: "approved";
      proposalID: ProposalID;
      proposalRevision: number;
      proposalHash: string;
      actor: "user";
    }
  | {
      kind: "rejected";
      proposalID: ProposalID;
      proposalRevision: number;
      proposalHash: string;
      actor: "user";
    };

/** Outcome of a validated decision; the Phase 2B engine consumes this. */
export type ApprovalDecisionOutcome =
  | { kind: "approved"; approval: Approval }
  | { kind: "rejected"; proposalID: ProposalID; proposalRevision: number; proposalHash: string };

/**
 * Validate a user decision against the awaiting proposal + the outstanding
 * request. Throws `approval_mismatch` on any binding mismatch and
 * `proposal_not_approvable` when the proposal is not in `awaiting_approval`.
 * Assigns the ApprovalID (Harness authority) — persistence happens in 2B.
 */
export function applyApprovalDecision(
  proposal: Proposal,
  request: ApprovalRequest,
  decision: UserApprovalDecision,
  now: Timestamp,
): ApprovalDecisionOutcome {
  if (proposal.status !== "awaiting_approval") {
    throw new UltraPlanError(
      "proposal_not_approvable",
      `Proposal ${proposal.id} is ${proposal.status}; only an awaiting_approval proposal can receive a user decision (run beginApproval first)`,
      { proposalID: proposal.id, status: proposal.status },
    );
  }
  if (
    decision.proposalID !== proposal.id ||
    decision.proposalID !== request.proposalID ||
    decision.proposalRevision !== proposal.revision ||
    decision.proposalRevision !== request.proposalRevision ||
    decision.proposalHash !== proposal.hash ||
    decision.proposalHash !== request.proposalHash
  ) {
    throw new UltraPlanError(
      "approval_mismatch",
      `User decision does not bind the exact awaiting proposal (id/revision/hash mismatch)`,
      {
        decision: {
          proposalID: decision.proposalID,
          proposalRevision: decision.proposalRevision,
          proposalHash: decision.proposalHash,
        },
        proposal: { proposalID: proposal.id, proposalRevision: proposal.revision, proposalHash: proposal.hash },
      },
    );
  }
  if (decision.actor !== "user") {
    throw new UltraPlanError("approval_mismatch", "Approval decisions may only originate from the user");
  }

  if (decision.kind === "rejected") {
    return {
      kind: "rejected",
      proposalID: proposal.id,
      proposalRevision: proposal.revision,
      proposalHash: proposal.hash ?? "",
    };
  }

  // v0.1 contract freeze: approvals are not persisted yet, so the id sequence
  // is trivial; the Phase 2B engine assigns ids from the persisted sequence.
  return {
    kind: "approved",
    approval: {
      id: ApprovalIDs.from(1),
      proposalID: proposal.id,
      proposalRevision: proposal.revision,
      proposalHash: proposal.hash ?? "",
      actor: "user",
      createdAt: now,
    },
  };
}

/** Shape of the data a Phase 2B approval flow persists per begun approval. */
export interface BegunApproval {
  request: ApprovalRequest;
  proposal: Proposal;
}
