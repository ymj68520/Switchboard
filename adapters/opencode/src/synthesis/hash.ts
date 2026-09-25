/**
 * Canonical content hashes for derived synthesis artifacts (Phase 2F brief
 * §16/§38).
 *
 * Canonicalization is the SAME contract as the proposal approval hash
 * (transaction/hash.ts): `stableStringify` — object keys sorted
 * lexicographically, `undefined` fields dropped, arrays kept in order (array
 * order is semantic: section binding order, implementation order, statement
 * order), SHA-256 over the UTF-8 canonical serialization.
 *
 * SynthesisInput hash payload — INCLUDED: planID, baseSnapshot, baseCommit,
 * architecture, sections, decisions, constraints, questions, conflicts,
 * evidence. EXCLUDED: id, createdAt (pure persistence metadata; excluding
 * them is what makes a repeated freeze at the same authoritative state
 * byte-identical — brief §16/§17), hash itself.
 *
 * SynthesisManifest hash payload — INCLUDED: input (ref), baseSnapshot,
 * inputHash, architecture, sections, crossSectionLinks, implementationOrder
 * (with Harness-derived step order), limitations, unresolvedFindings.
 * EXCLUDED: id, revision, createdAt, hash itself. Changing any derived
 * statement, source provenance, step, section ref, step ordering, limitation,
 * or finding changes the hash (brief §38).
 */
import { createHash } from "node:crypto";

import { stableStringify } from "../core/invariants.js";
import type { SynthesisInputPayload, SynthesisManifest, SynthesisManifestDraft } from "./types.js";

export type SynthesisInputHashPayload = SynthesisInputPayload;

export function computeSynthesisInputHash(payload: SynthesisInputHashPayload): string {
  const hash = createHash("sha256");
  hash.update(stableStringify(payload));
  return hash.digest("hex");
}

/**
 * The canonical derived-content payload of a manifest, resolved against its
 * frozen input. Both the idempotency check and the stored record's `hash`
 * recompute use exactly this payload — the stored form differs only by
 * Harness-assigned id/revision/createdAt, which are excluded here.
 */
function manifestPayload(
  draft: Pick<SynthesisManifestDraft, "inputID" | "crossSectionLinks" | "implementationOrder" | "limitations" | "unresolvedFindings">,
  resolved: {
    baseSnapshot: SynthesisManifest["baseSnapshot"];
    inputHash: string;
    architecture: SynthesisManifest["architecture"];
    sections: SynthesisManifest["sections"];
    /** Stored steps already carry their Harness-derived `order`; drafts do not. */
    orderedSteps?: SynthesisManifest["implementationOrder"];
  },
): Record<string, unknown> {
  return {
    input: { id: draft.inputID },
    baseSnapshot: resolved.baseSnapshot,
    inputHash: resolved.inputHash,
    architecture: resolved.architecture,
    sections: resolved.sections,
    crossSectionLinks: draft.crossSectionLinks,
    implementationOrder:
      resolved.orderedSteps ?? draft.implementationOrder.map((step, index) => ({ ...step, order: index + 1 })),
    limitations: draft.limitations,
    unresolvedFindings: draft.unresolvedFindings,
  };
}

/** Draft-side hash: step order is derived from array position (brief §27). */
export function computeSynthesisManifestHash(
  draft: SynthesisManifestDraft,
  resolved: {
    baseSnapshot: SynthesisManifest["baseSnapshot"];
    inputHash: string;
    architecture: SynthesisManifest["architecture"];
    sections: SynthesisManifest["sections"];
  },
): string {
  const hash = createHash("sha256");
  hash.update(stableStringify(manifestPayload(draft, resolved)));
  return hash.digest("hex");
}

/**
 * Stored-record hash recompute (durable fail-closed loading, brief §40): the
 * stored implementationOrder already carries Harness-derived `order`
 * (index+1 by construction), so the payload is identical to the draft-side
 * hash of the same content.
 */
export function computeSynthesisManifestHashFromRecord(
  manifest: Omit<SynthesisManifest, "id" | "revision" | "createdAt" | "hash">,
): string {
  const hash = createHash("sha256");
  hash.update(
    stableStringify(
      manifestPayload(
        {
          inputID: manifest.input.id,
          crossSectionLinks: manifest.crossSectionLinks,
          implementationOrder: manifest.implementationOrder,
          limitations: manifest.limitations,
          unresolvedFindings: manifest.unresolvedFindings,
        },
        {
          baseSnapshot: manifest.baseSnapshot,
          inputHash: manifest.inputHash,
          architecture: manifest.architecture,
          sections: manifest.sections,
          orderedSteps: manifest.implementationOrder,
        },
      ),
    ),
  );
  return hash.digest("hex");
}
