/**
 * Deterministic structured serialization (frozen plan §23).
 *
 * Phase 6 will need exact Proposal hashing; this seam guarantees the
 * foundation property already: the same structured value always serializes
 * to the same string (sorted keys, no whitespace, stable number handling).
 * It is NOT Proposal hashing — that belongs to Phase 6.
 */

/** Deterministic JSON serialization: keys sorted recursively, compact. */
export function canonicalJson(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value) ?? "null";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(serialize).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${serialize(v)}`).join(",")}}`;
  }
  // Functions/symbols/bigints are never part of memory content.
  throw new Error(`canonicalJson: unsupported value type: ${typeof value}`);
}
