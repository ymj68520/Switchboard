/**
 * Candidate Snapshot simulation (frozen plan Phase 6 §17/§40 step 13/§42).
 *
 * Given the exact base world (current committed HEAD snapshot refs) and the
 * FROZEN normalized changes, re-derive the candidate refs and re-run every
 * structural validation. The commit engine runs this immediately before
 * applying changes: the user authorization may be minutes old, so nothing
 * the proposal froze is trusted without revalidation against live state.
 *
 * This is a pure in-memory simulation — it never writes committed memory.
 */

import { sortMemoryRefs, type MemoryRef } from "./memory-refs.js";
import { changeOpKind, changeTarget, proposalInvalid } from "./proposal.js";
import type { NormalizedProposalChange } from "./proposal.js";
import { candidateSectionDag } from "./proposal-normalize.js";
import { assertValidSectionDag } from "./section-dag.js";

export interface CandidateSimulation {
  candidateRefs: MemoryRef[];
}

/**
 * Re-simulate frozen changes over the base world. Every change is checked
 * against the exact base refs: creates must not collide with existing
 * identities, mutation targets must exist at their exact frozen revision,
 * results must be exactly previous+1, at most one effective change per
 * artifact, and at most one architecture identity in the candidate.
 */
export function simulateCandidateSnapshot(input: {
  runId: string;
  baseRefs: MemoryRef[];
  changes: NormalizedProposalChange[];
}): CandidateSimulation {
  const { baseRefs, changes } = input;

  const baseByIdentity = new Map<string, MemoryRef>();
  for (const ref of baseRefs) baseByIdentity.set(`${ref.kind}:${ref.id}`, ref);
  const baseByKey = new Map<string, MemoryRef>();
  for (const ref of baseRefs) baseByKey.set(`${ref.kind}:${ref.id}:${ref.revision}`, ref);

  const candidate = new Map<string, MemoryRef>(baseByIdentity);
  const mutatedIdentities = new Set<string>();

  changes.forEach((change, index) => {
    const at = { changeIndex: index };
    const kind = changeOpKind(change.op);
    const target = changeTarget(change);
    const identity = `${kind}:${change.artifactId}`;

    if (target === null) {
      if (baseByIdentity.has(identity)) {
        throw proposalInvalid(`frozen change ${index} creates ${kind} '${change.artifactId}' which already exists in the base`, at);
      }
      if (change.result.revision !== 1) {
        throw proposalInvalid(`frozen change ${index} create result must be revision 1`, at);
      }
      if (kind === "architecture" && baseRefs.some((ref) => ref.kind === "architecture")) {
        throw proposalInvalid("frozen change would introduce a second architecture identity", at);
      }
    } else {
      const base = baseByKey.get(`${target.kind}:${target.id}:${target.revision}`);
      if (base === undefined) {
        throw proposalInvalid(
          `frozen change ${index} target ${target.kind} '${target.id}@${target.revision}' is not present in the current base`,
          at,
        );
      }
      if (change.result.revision !== target.revision + 1) {
        throw proposalInvalid(`frozen change ${index} result revision must be exactly ${target.revision + 1}`, at);
      }
    }

    if (mutatedIdentities.has(identity)) {
      throw proposalInvalid(`frozen changes leave two effective revisions of ${kind} '${change.artifactId}'`, at);
    }
    mutatedIdentities.add(identity);
    candidate.set(identity, { runId: input.runId, kind, id: change.artifactId, revision: change.result.revision });
  });

  const candidateRefs = sortMemoryRefs([...candidate.values()]);
  const architectureCount = candidateRefs.filter((ref) => ref.kind === "architecture").length;
  if (architectureCount > 1) {
    throw proposalInvalid("candidate snapshot would contain more than one architecture revision");
  }
  assertValidSectionDag(candidateSectionDag(changes, baseRefs));

  return { candidateRefs };
}

/** Exact-match check that frozen change results equal the simulated world. */
export function assertFrozenResultsMatchSimulation(changes: NormalizedProposalChange[], candidateRefs: MemoryRef[]): void {
  const candidateByKey = new Set<string>();
  for (const ref of candidateRefs) candidateByKey.add(`${ref.kind}:${ref.id}:${ref.revision}`);
  for (const change of changes) {
    const key = `${change.result.kind}:${change.result.id}:${change.result.revision}`;
    if (!candidateByKey.has(key)) {
      throw proposalInvalid(
        `frozen change result ${change.result.kind} '${change.result.id}@${change.result.revision}' is not part of the simulated candidate snapshot`,
      );
    }
  }
}
