/**
 * Plan Memory artifact vocabulary and exact references (frozen plan §6/§8).
 *
 * A MemoryRef pins an exact immutable revision. Readable ID prefixes
 * (DEC-123 etc.) are UX only — authority is the structured triple plus the
 * owning run, which prevents cross-run contamination by construction.
 */

export const MEMORY_ARTIFACT_KINDS = [
  "constraint",
  "decision",
  "architecture",
  "section",
  "open_question",
  "conflict",
] as const;

export type MemoryArtifactKind = (typeof MEMORY_ARTIFACT_KINDS)[number];

export function isMemoryArtifactKind(value: string): value is MemoryArtifactKind {
  return (MEMORY_ARTIFACT_KINDS as readonly string[]).includes(value);
}

export interface MemoryRef {
  runId: string;
  kind: MemoryArtifactKind;
  id: string;
  revision: number;
}

/** Canonical ref ordering: kind, artifact id, revision (frozen plan §62). */
export function compareMemoryRefs(a: MemoryRef, b: MemoryRef): number {
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return a.revision - b.revision;
}

export function sortMemoryRefs(refs: MemoryRef[]): MemoryRef[] {
  return [...refs].sort(compareMemoryRefs);
}

/**
 * Validate one raw ref object (from persisted JSON). Shape errors are the
 * caller's choice of envelope; this returns a typed ref or null.
 */
export function parseMemoryRefShape(value: unknown): MemoryRef | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.runId !== "string" || candidate.runId === "") return null;
  if (typeof candidate.kind !== "string" || !isMemoryArtifactKind(candidate.kind)) return null;
  if (typeof candidate.id !== "string" || candidate.id === "") return null;
  if (typeof candidate.revision !== "number" || !Number.isInteger(candidate.revision) || candidate.revision < 1) {
    return null;
  }
  return {
    runId: candidate.runId,
    kind: candidate.kind,
    id: candidate.id,
    revision: candidate.revision,
  };
}

/**
 * Parse an array of embedded refs, enforcing that every ref belongs to the
 * SAME run as the revision containing them (cross-run refs are invalid
 * content, not a storage fault).
 */
export function parseEmbeddedMemoryRefs(value: unknown, ownerRunId: string): MemoryRef[] {
  if (!Array.isArray(value)) {
    throw memoryRevisionInvalid("embedded refs must be an array");
  }
  const refs: MemoryRef[] = [];
  for (const entry of value) {
    const ref = parseMemoryRefShape(entry);
    if (ref === null) {
      throw memoryRevisionInvalid("embedded ref has invalid shape");
    }
    if (ref.runId !== ownerRunId) {
      throw memoryRevisionInvalid("embedded ref crosses PlanningRun boundaries");
    }
    refs.push(ref);
  }
  return refs;
}

import { RuntimeError } from "../runtime/errors.js";

export function memoryRevisionInvalid(message: string): Error {
  return new RuntimeError("MEMORY_REVISION_INVALID", message);
}
