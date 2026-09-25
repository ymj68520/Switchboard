/**
 * context_epoch — deterministic projection epoch (Phase 8 directive §5/§6).
 *
 * The epoch is an OPTIMIZATION / stale-context hint only. It is never a
 * mutation gate: real correctness is enforced by SessionBinding generation,
 * PlanningRun revision, HEAD/base Snapshot, and Proposal hash (§6). A stale
 * epoch supplied by the model can therefore never override any fence — the
 * read tools simply return the CURRENT epoch.
 *
 * Inputs (directive §5): run identity/revision, HEAD commit/snapshot pair,
 * the awaiting proposal identity/revision/hash, and the active scope. All
 * of these change exactly when the visible authoritative planning context
 * changes. Deliberately EXCLUDED (§5/§38):
 *   - wall clock / random UUIDs / conversation turn numbers / Claude compact
 *     counts (non-deterministic or conversation-derived);
 *   - SessionBinding generation: the binding is an authorization fence, not
 *     planning knowledge; HostContext separately protects ownership. Context
 *     content does not describe the binding, so including it would make the
 *     epoch churn on re-attach without any visible context change.
 */

import { createHash } from "node:crypto";

import { canonicalJson } from "../core/canonical-json.js";
import type { ContextSource } from "./types.js";

export interface ContextEpochInputs {
  runId: string;
  runRevision: number;
  headCommitId: string | null;
  headSnapshotId: string | null;
  awaitingProposal: { id: string; revision: number; hash: string } | null;
  activeScope: { kind: string; sectionId?: string } | null;
}

/** SHA-256 over the canonical form of the epoch inputs — full hex. */
export function deriveContextEpoch(inputs: ContextEpochInputs): string {
  const payload = {
    runId: inputs.runId,
    runRevision: inputs.runRevision,
    headCommitId: inputs.headCommitId,
    headSnapshotId: inputs.headSnapshotId,
    awaitingProposal:
      inputs.awaitingProposal === null
        ? null
        : {
            id: inputs.awaitingProposal.id,
            revision: inputs.awaitingProposal.revision,
            hash: inputs.awaitingProposal.hash,
          },
    activeScope: inputs.activeScope,
  };
  return createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
}

/**
 * Epoch derivation that reads ONLY the cheap authoritative inputs (run row,
 * HEAD pair, awaiting proposal) — no snapshot-member expansion. This is the
 * form used on the normal-turn delta path (directive §34), which must stay a
 * fast read (§40). Returns null when the run does not exist.
 */
export function deriveContextEpochFromSource(source: ContextSource, runId: string): string | null {
  const run = source.getRun(runId);
  if (run === null) return null;
  const head = source.getHeadPair(runId);
  const awaiting = source.getAwaitingProposal(runId);
  return deriveContextEpoch({
    runId: run.runId,
    runRevision: run.revision,
    headCommitId: head.commitId,
    headSnapshotId: head.snapshotId,
    awaitingProposal:
      awaiting === null
        ? null
        : { id: awaiting.proposalId, revision: awaiting.revision, hash: awaiting.hash },
    // §8: active scope does not exist yet — constant null until the Section
    // workflow phase establishes it.
    activeScope: null,
  });
}
