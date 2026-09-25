/**
 * Section DAG validation (frozen plan §26/§27/§77).
 *
 * The DAG is a SNAPSHOT-level property: SEC-A@1 and SEC-A@2 may define
 * different dependencies, so validation always runs against the exact set of
 * section revisions a snapshot selects — never a single revision in
 * isolation. Dependencies reference SECTION IDENTITIES; the snapshot decides
 * the exact dependency revisions. Pure core — no SQL, no filesystem.
 */

import { RuntimeError } from "../runtime/errors.js";

export interface SectionDagEntry {
  sectionId: string;
  dependencies: string[];
}

export interface SectionDagValidation {
  valid: boolean;
  problems: string[];
  cyclePath?: string[];
}

/**
 * Validate a section dependency graph: no self dependencies, all dependency
 * ids must exist as sections, no duplicate edges, and no cycles (a real DAG).
 */
export function validateSectionDag(entries: SectionDagEntry[]): SectionDagValidation {
  const problems: string[] = [];
  const ids = new Set(entries.map((entry) => entry.sectionId));

  const edges = new Map<string, Set<string>>();
  for (const entry of entries) {
    if (ids.size !== new Set(entries.map((e) => e.sectionId)).size && !ids.has(entry.sectionId)) {
      // duplicate section entries handled below via seen set
    }
    const deps = new Set<string>();
    for (const dependency of entry.dependencies) {
      if (dependency === entry.sectionId) {
        problems.push(`section '${entry.sectionId}' depends on itself`);
        continue;
      }
      if (!ids.has(dependency)) {
        problems.push(`section '${entry.sectionId}' depends on missing section '${dependency}'`);
        continue;
      }
      if (deps.has(dependency)) {
        problems.push(`section '${entry.sectionId}' has a duplicate dependency on '${dependency}'`);
        continue;
      }
      deps.add(dependency);
    }
    edges.set(entry.sectionId, deps);
  }

  // Duplicate section entries are a structural problem of their own.
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.sectionId)) {
      problems.push(`duplicate section entry '${entry.sectionId}'`);
    }
    seen.add(entry.sectionId);
  }

  // Cycle detection via iterative DFS with a path stack (kept deterministic:
  // iterate ids in sorted order).
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const id of ids) color.set(id, WHITE);

  let cyclePath: string[] | undefined;
  for (const start of [...ids].sort()) {
    if (color.get(start) !== WHITE) continue;
    const path: string[] = [];
    const visit = (id: string): boolean => {
      color.set(id, GRAY);
      path.push(id);
      for (const dependency of [...(edges.get(id) ?? [])].sort()) {
        if ((color.get(dependency) ?? WHITE) === GRAY) {
          const from = path.indexOf(dependency);
          cyclePath = [...path.slice(from), dependency];
          return false;
        }
        if ((color.get(dependency) ?? WHITE) === WHITE) {
          if (!visit(dependency)) return false;
        }
      }
      color.set(id, BLACK);
      path.pop();
      return true;
    };
    if (!visit(start)) {
      problems.push(`section dependency cycle detected: ${cyclePath?.join(" -> ")}`);
      break;
    }
  }

  return {
    valid: problems.length === 0,
    problems,
    ...(cyclePath !== undefined ? { cyclePath } : {}),
  };
}

/** Throwing variant carrying the frozen SECTION_DAG_INVALID code. */
export function assertValidSectionDag(entries: SectionDagEntry[]): void {
  const result = validateSectionDag(entries);
  if (!result.valid) {
    throw new RuntimeError("SECTION_DAG_INVALID", "section dependency graph is not a valid DAG", {
      detail: {
        problems: result.problems,
        ...(result.cyclePath !== undefined ? { cyclePath: result.cyclePath } : {}),
      },
    });
  }
}
