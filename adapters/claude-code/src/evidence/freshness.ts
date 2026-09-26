/**
 * Evidence freshness vocabulary and state-transition matrix (Phase 10 §1/§6/§8).
 *
 * Freshness belongs to the EXACT Evidence revision (EV-X@N), never to the
 * identity (§2): `EV-X@1 stale / EV-X@2 invalidated / EV-X@3 fresh` is a legal
 * combination. `fresh` means "the last-known deterministic/semantic validation
 * supports this exact revision" — it never means "the source can no longer
 * change" (§1).
 *
 * Evidence revisions stay immutable (§3): freshness moves through append-only
 * validation events whose materialized projection lives in
 * evidence_current_states. `stale` and `invalidated` are TERMINAL for an exact
 * revision (§8) — a claim supported again is a NEW revision, never a revived
 * one. The DB enforces this with evidence_validation_events_no_revival; this
 * module is the writer-side mirror so violations surface as typed errors at
 * the application boundary.
 */

export const FRESHNESS_STATES = ["fresh", "needs_validation", "stale", "invalidated"] as const;
export type FreshnessState = (typeof FRESHNESS_STATES)[number];

/**
 * §6 event vocabulary — small, closed, and semantic. Deliberately ABSENT:
 * `SET_STATE` / `FORCE_FRESH` (a generic state-setting primitive is exactly
 * what this domain must never have — §20/§71).
 */
export const VALIDATION_EVENT_TYPES = [
  "INITIALIZED",
  "FILE_CHANGED_HINT",
  "SOURCE_CHANGED",
  "FINGERPRINT_VALIDATED",
  "REVALIDATION_UNCERTAIN",
  "REPLACED",
  "INVALIDATED",
  "UPSTREAM_CHANGED",
] as const;
export type ValidationEventType = (typeof VALIDATION_EVENT_TYPES)[number];

/**
 * §8 transition matrix. Allowed: the listed pairs (plus the no-change
 * affirmation fresh→fresh and needs_validation→needs_validation — a new
 * validation FACT about an unresolved revision is still recorded). Terminal:
 * stale/invalidated can never transition again.
 */
export const FRESHNESS_TRANSITIONS: Readonly<Record<ValidationEventType, readonly FreshnessState[]>> = {
  // A revision enters its initial state (migration backfill, promotion init,
  // or the fresh replacement created by a confirmed revalidation).
  INITIALIZED: [],
  // Host file-change hint (§17): fresh → needs_validation only, never a
  // semantic verdict. No producer exists on the probed host (Phase 10 §18);
  // the type stays defined so a future usable host event needs no migration.
  FILE_CHANGED_HINT: ["fresh"],
  // Deterministic fingerprint check found the source changed/unreadable.
  SOURCE_CHANGED: ["fresh", "needs_validation"],
  // Deterministic fingerprint check found the source unchanged.
  FINGERPRINT_VALIDATED: ["fresh", "needs_validation"],
  // Semantic assessment could not confirm the claim (real provenance, no verdict).
  REVALIDATION_UNCERTAIN: ["fresh", "needs_validation"],
  // Confirmed revalidation replaced this revision with EV-X@(N+1).
  REPLACED: ["fresh", "needs_validation"],
  // Contradicted semantic assessment.
  INVALIDATED: ["fresh", "needs_validation"],
  // Derived propagation: an exact upstream revision genuinely changed.
  UPSTREAM_CHANGED: ["fresh"],
};

/** True when a validation event of this type may legally depart from `from`. */
export function isTransitionAllowed(eventType: ValidationEventType, from: FreshnessState | null): boolean {
  if (from === null) {
    return eventType === "INITIALIZED";
  }
  if (from === "stale" || from === "invalidated") {
    return false; // terminal (§8)
  }
  return FRESHNESS_TRANSITIONS[eventType].includes(from);
}

/** Human-readable reason codes persisted on validation events. */
export const FRESHNESS_REASON_CODES = [
  "schema7_failclosed_initialization",
  "promotion_fingerprint_match",
  "promotion_fingerprint_mismatch",
  "promotion_source_unreadable",
  "promotion_reobserve_last_known",
  "promotion_upstream_not_fresh",
  "revalidation_check_unchanged",
  "revalidation_check_changed",
  "revalidation_check_source_unreadable",
  "revalidation_confirmed_replacement",
  "revalidation_contradicted",
  "revalidation_uncertain",
  "git_repository_revision_drift",
  "upstream_revision_changed",
] as const;
export type FreshnessReasonCode = (typeof FRESHNESS_REASON_CODES)[number];
