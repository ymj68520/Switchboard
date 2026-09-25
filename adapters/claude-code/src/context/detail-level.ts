/**
 * Detail-level vocabularies for the Phase 8 read tools (directive §20/§23).
 *
 * get_context: "recovery" additionally returns the rendered Recovery Capsule
 * alongside the structured context; "current" returns the structured
 * projection only.
 *
 * read_memory: fixed finite detail levels over EXACT MemoryRefs (§24) — no
 * latest/current/fuzzy shortcut exists.
 */

export const CONTEXT_DETAILS = ["recovery", "current"] as const;
export type ContextDetail = (typeof CONTEXT_DETAILS)[number];

export const MEMORY_DETAIL_LEVELS = ["identity", "summary", "full", "contract"] as const;
export type MemoryDetailLevel = (typeof MEMORY_DETAIL_LEVELS)[number];

/** Least-surprise default: one-line stable projection. */
export const DEFAULT_MEMORY_DETAIL: MemoryDetailLevel = "summary";

export function isContextDetail(value: unknown): value is ContextDetail {
  return typeof value === "string" && (CONTEXT_DETAILS as readonly string[]).includes(value);
}

export function isMemoryDetailLevel(value: unknown): value is MemoryDetailLevel {
  return typeof value === "string" && (MEMORY_DETAIL_LEVELS as readonly string[]).includes(value);
}
