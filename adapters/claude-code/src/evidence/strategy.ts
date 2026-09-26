/**
 * Server-derived validation strategy (Phase 9 §27/§37 rule, shared by the
 * promotion path and the Phase 10 revalidation path so both semantics stay
 * identical): only a DIRECT claim resting entirely on fingerprint-carrying
 * source observations validates by `fingerprint` (reusing the capture-time
 * fingerprints verbatim); anything derived, uncertain, or citing
 * locator/execution observations is `reobserve`; a direct pure-source basis
 * without capture-time fingerprints fails closed — a fingerprint strategy is
 * never silently created without fingerprints.
 */

import { RuntimeError } from "../runtime/errors.js";
import type { EvidenceValidationStrategy } from "../store/evidence.js";
import type { SourceFingerprint } from "../observations/types.js";

export interface StrategyProvenanceInput {
  confidence: "direct" | "derived" | "uncertain";
  derivedFromCount: number;
  observations: Array<{ observationClass: string; sourceFingerprint: SourceFingerprint | null }>;
}

export function deriveValidationStrategy(input: StrategyProvenanceInput): EvidenceValidationStrategy {
  if (input.derivedFromCount > 0) return "reobserve";
  if (
    input.confidence === "direct" &&
    input.observations.length > 0 &&
    input.observations.every((observation) => observation.observationClass === "source")
  ) {
    if (input.observations.some((observation) => observation.sourceFingerprint === null)) {
      throw new RuntimeError(
        "EVIDENCE_SOURCE_FINGERPRINT_UNAVAILABLE",
        "a fingerprint-validated claim requires source observations captured with a whole-file fingerprint",
        { detail: { confidence: input.confidence } },
      );
    }
    return "fingerprint";
  }
  return "reobserve";
}
