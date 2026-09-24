/**
 * Frozen invariants, expressed as code — spec §35 (Core Invariants).
 *
 * These are pure functions over explicit inputs so they are testable without a
 * store and reusable by the Phase 2 transaction engine. Prompt instructions
 * never carry these rules; the harness enforces them.
 */
import type { Evidence } from "../repository/evidence.js";
import { UltraPlanError } from "./errors.js";
import type { SectionID } from "./ids.js";
import type { Architecture, Conflict, OpenQuestion, PlanningRun, Section } from "./types.js";

// ---------------------------------------------------------------------------
// Revision discipline (spec §35 invariants 7, 11, 12)
// ---------------------------------------------------------------------------

/**
 * Approved/committed revisions are immutable: a registry may never accept the
 * same artifact revision twice, and revisions must be strictly sequential so
 * an amendment always creates a NEW revision.
 */
export function assertRevisionMonotonic(
  highestExisting: number | undefined,
  incoming: number,
  what: string,
): void {
  if (!Number.isInteger(incoming) || incoming < 1) {
    throw new UltraPlanError(
      "non_monotonic_revision",
      `${what}: revisions are 1-based integers (got ${incoming})`,
      { incoming },
    );
  }
  if (highestExisting !== undefined && incoming !== highestExisting + 1) {
    throw new UltraPlanError(
      "non_monotonic_revision",
      `${what}: revision ${incoming} does not follow highest existing revision ${highestExisting}; amendments must create new revisions`,
      { highestExisting, incoming },
    );
  }
}

// ---------------------------------------------------------------------------
// Section DAG (spec §6, §35 invariants 13, 14)
// ---------------------------------------------------------------------------

/**
 * Section dependencies must not contain cycles (including self-dependency).
 * Unknown dependencies are not this function's concern; they are reported by
 * assertSectionCanComplete when completion is attempted.
 */
export function assertAcyclicSections(sections: readonly Section[]): void {
  const dependencies = new Map<SectionID, readonly SectionID[]>();
  for (const section of sections) {
    dependencies.set(section.id, section.dependencies);
  }

  const state = new Map<SectionID, "visiting" | "done">();
  const path: SectionID[] = [];

  const visit = (id: SectionID): void => {
    const current = state.get(id);
    if (current === "done") return;
    if (current === "visiting") {
      const start = path.indexOf(id);
      const cycle = start >= 0 ? [...path.slice(start), id] : [id];
      throw new UltraPlanError(
        "section_dependency_cycle",
        `Section dependency cycle: ${cycle.join(" -> ")}`,
        { cycle },
      );
    }
    state.set(id, "visiting");
    path.push(id);
    for (const dep of dependencies.get(id) ?? []) {
      if (dependencies.has(dep)) visit(dep);
    }
    path.pop();
    state.set(id, "done");
  };

  for (const section of sections) visit(section.id);
}

/**
 * A section cannot complete while a required dependency is incomplete
 * (spec §6: "it cannot be committed as complete until required dependencies
 * are approved"). An unknown dependency can never be proven approved.
 */
export function assertSectionCanComplete(
  sections: readonly Section[],
  sectionID: SectionID,
): void {
  const byId = new Map<SectionID, Section>(sections.map((s): [SectionID, Section] => [s.id, s]));
  const section = byId.get(sectionID);
  if (!section) {
    throw new UltraPlanError("unknown_section", `Section ${sectionID} is not part of the plan`, {
      sectionID,
    });
  }
  for (const dep of section.dependencies) {
    const depSection = byId.get(dep);
    if (!depSection || depSection.status !== "approved") {
      throw new UltraPlanError(
        "dependency_incomplete",
        `Section ${sectionID} cannot complete: dependency ${dep} is ${
          depSection ? depSection.status : "not part of the plan"
        }`,
        { sectionID, dependency: dep, dependencyStatus: depSection?.status },
      );
    }
  }
}

/**
 * Transitive dependents of the changed sections, in stable discovery order
 * (excluding the changed sections themselves).
 */
export function collectDownstreamSections(
  sections: readonly Section[],
  changed: readonly SectionID[],
): SectionID[] {
  const dependents = new Map<SectionID, SectionID[]>();
  for (const section of sections) {
    for (const dep of section.dependencies) {
      const list = dependents.get(dep);
      if (list) list.push(section.id);
      else dependents.set(dep, [section.id]);
    }
  }

  const seen = new Set<SectionID>(changed);
  const queue: SectionID[] = [...changed];
  const downstream: SectionID[] = [];

  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined) break;
    for (const dependent of dependents.get(id) ?? []) {
      if (!seen.has(dependent)) {
        seen.add(dependent);
        downstream.push(dependent);
        queue.push(dependent);
      }
    }
  }
  return downstream;
}

/**
 * Dependency changes propagate `validation = needs_review` to all affected
 * downstream artifacts (spec §8, invariant 13). Sections are never deleted;
 * status is untouched — reopening is an explicit separate action. Transitive
 * propagation is deliberate: an upstream change can invalidate any downstream
 * consumer through the chain, and needs_review only demands review.
 */
export function propagateNeedsReview(
  sections: readonly Section[],
  changed: readonly SectionID[],
): Section[] {
  const downstream = new Set<SectionID>(collectDownstreamSections(sections, changed));
  return sections.map((section) =>
    downstream.has(section.id) ? { ...section, validation: "needs_review" as const } : section,
  );
}

// ---------------------------------------------------------------------------
// Finalization predicate (spec §33 preconditions, §30 evidence audit)
// ---------------------------------------------------------------------------

export type FinalizationFailure =
  | "architecture_not_approved"
  | "sections_not_approved"
  | "sections_not_valid"
  | "blocking_questions_open"
  | "blocking_conflicts_open"
  | "critical_evidence_not_fresh";

export interface FinalizationInput {
  architecture: Architecture | undefined;
  sections: readonly Section[];
  openQuestions: readonly OpenQuestion[];
  conflicts: readonly Conflict[];
  evidence: readonly Evidence[];
}

export interface FinalizationCheck {
  ok: boolean;
  /** Deterministic: failures appear in the fixed order of FinalizationFailure. */
  failures: FinalizationFailure[];
}

/**
 * Finalization is valid only when:
 *
 *   architecture approved
 *   AND all required sections approved
 *   AND all required sections valid
 *   AND blocking questions == 0
 *   AND blocking conflicts == 0
 *   AND critical evidence is fresh
 *
 * Zero sections is treated as "not approved": after architecture approval the
 * plan must have been decomposed (spec §6) before synthesis/final.
 */
export function checkFinalization(input: FinalizationInput): FinalizationCheck {
  const failures: FinalizationFailure[] = [];

  if (!input.architecture || input.architecture.status !== "approved") {
    failures.push("architecture_not_approved");
  }
  if (
    input.sections.length === 0 ||
    input.sections.some((section) => section.status !== "approved")
  ) {
    failures.push("sections_not_approved");
  }
  if (input.sections.some((section) => section.validation !== "valid")) {
    failures.push("sections_not_valid");
  }
  if (input.openQuestions.some((q) => q.blocking && q.status === "open")) {
    failures.push("blocking_questions_open");
  }
  if (input.conflicts.some((c) => c.severity === "blocking" && c.status === "open")) {
    failures.push("blocking_conflicts_open");
  }
  if (
    input.evidence.some(
      (e) => e.criticality === "critical" && !(e.status === "active" && e.freshness === "fresh"),
    )
  ) {
    failures.push("critical_evidence_not_fresh");
  }

  return { ok: failures.length === 0, failures };
}

// ---------------------------------------------------------------------------
// Committed run fields (spec §35 invariant 8: only a PlanCommit may mutate
// committed Plan Memory)
// ---------------------------------------------------------------------------

/**
 * PlanningRun fields that mirror committed Plan Memory. They advance only
 * atomically with a PlanCommit — never through the run-header mutation path.
 * (openQuestions/conflicts/constraints are working state raised during
 * discussion; they do not require a commit to exist.)
 */
const COMMIT_GATED_RUN_FIELDS = [
  "architecture",
  "sections",
  "decisions",
  "finalPlan",
  "headCommit",
  "headSnapshot",
] as const satisfies readonly (keyof PlanningRun)[];

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export function assertCommittedRunFieldsUnchanged(before: PlanningRun, after: PlanningRun): void {
  for (const field of COMMIT_GATED_RUN_FIELDS) {
    if (stableStringify(before[field]) !== stableStringify(after[field])) {
      throw new UltraPlanError(
        "commit_gated_run_field",
        `PlanningRun.${field} may only change through commitTransaction (PlanCommit), per spec invariant 8`,
        { field: field as string },
      );
    }
  }
}
