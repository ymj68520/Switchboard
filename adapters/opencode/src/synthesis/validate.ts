/**
 * Structural provenance/order validation for SynthesisManifest drafts
 * (Phase 2F brief §24/§25/§26/§27/§28/§29/§31/§33/§59/§60).
 *
 * PURE over (draft, frozen input, current blocker state) — no store, no LLM.
 * Fail closed with precise machine-readable codes.
 *
 * STRUCTURAL ≠ SEMANTIC (brief §34): this validation proves "every statement
 * cites exact approved inputs", coverage, and DAG ordering. It CANNOT prove a
 * natural-language statement is entailed by its sources — unsupported facts,
 * contradictions, and incorrect derivations belong to the Phase 2G semantic
 * validator.
 */
import { UltraPlanError } from "../core/errors.js";
import type { ConflictID, QuestionID, SectionID } from "../core/ids.js";
import type {
  SynthesisInput,
  SynthesisManifestDraft,
  SynthesisSourceRef,
  ValidationFinding,
  DerivedStatement,
} from "./types.js";
import { SYNTHESIS_FINDING_CATEGORIES } from "./types.js";

/** Current blocker state findings may additionally cite (brief §33/§53). */
export interface CurrentBlockerState {
  questions?: readonly { id: QuestionID; status: "open" | "resolved" }[];
  conflicts?: readonly { id: ConflictID; status: "open" | "resolved" }[];
}

function requireNonEmptyStatement(statement: unknown, what: string): string {
  if (typeof statement !== "string" || statement.trim().length === 0) {
    throw new UltraPlanError("invalid_scope", `${what} requires a non-empty statement`);
  }
  return statement;
}

/**
 * Resolve one source ref against the frozen input's authority sets (strict —
 * brief §25: no source outside the frozen input). `current` state is consulted
 * ONLY for finding sources (brief §33 "input/current allowed state" + §53).
 */
export function sourceRefResolves(
  ref: SynthesisSourceRef,
  input: SynthesisInput,
  current?: CurrentBlockerState,
): boolean {
  switch (ref.kind) {
    case "architecture":
      return true; // the input binds exactly one architecture
    case "section":
      return input.sections.some((s) => s.ref.id === ref.id && s.ref.revision === ref.revision);
    case "decision":
      return input.decisions.some((d) => d.id === ref.id && d.revision === ref.revision);
    case "constraint":
      return input.constraints.some((c) => c.id === ref.id);
    case "question":
      return (
        input.questions.some((q) => q.id === ref.id) ||
        (current?.questions?.some((q) => q.id === ref.id && q.status === "open") ?? false)
      );
    case "conflict":
      return (
        input.conflicts.some((c) => c.id === ref.id) ||
        (current?.conflicts?.some((c) => c.id === ref.id && c.status === "open") ?? false)
      );
    case "evidence":
      return input.evidence.some((e) => e.id === ref.id && e.revision === ref.revision);
  }
}

function validateSources(
  sources: SynthesisSourceRef[] | undefined,
  what: string,
  input: SynthesisInput,
  current: CurrentBlockerState | undefined,
  options: { required: boolean },
): void {
  if (!Array.isArray(sources) || sources.length === 0) {
    if (options.required) {
      throw new UltraPlanError("provenance_missing", `${what} carries no provenance — every derived statement must cite at least one exact source ref`);
    }
    return;
  }
  for (const ref of sources) {
    if (!ref || typeof ref !== "object" || !["architecture", "section", "decision", "constraint", "question", "conflict", "evidence"].includes(ref.kind)) {
      throw new UltraPlanError("provenance_invalid", `${what} carries an unsupported source ref form`, { source: ref });
    }
    if (!sourceRefResolves(ref, input, current)) {
      throw new UltraPlanError(
        "provenance_invalid",
        `${what} cites a source outside the frozen SynthesisInput authority set: ${JSON.stringify(ref)}`,
        { source: ref },
      );
    }
  }
}

function validateDerivedStatement(
  statement: DerivedStatement,
  what: string,
  input: SynthesisInput,
  current: CurrentBlockerState | undefined,
): void {
  requireNonEmptyStatement(statement?.statement, what);
  validateSources(statement?.sources, what, input, current, { required: true });
}

function validateFinding(
  finding: ValidationFinding,
  index: number,
  input: SynthesisInput,
  current: CurrentBlockerState | undefined,
): void {
  const what = `Finding[${index}]`;
  requireNonEmptyStatement(finding?.statement, what);
  if (!SYNTHESIS_FINDING_CATEGORIES.includes(finding.category)) {
    throw new UltraPlanError(
      "finding_invalid",
      `${what} category "${String(finding.category)}" is not a synthesis finding category (${SYNTHESIS_FINDING_CATEGORIES.join(", ")})`,
      { category: finding.category },
    );
  }
  validateSources(finding?.sources, what, input, current, { required: false });
}

/**
 * Validate a manifest draft (input binding excluded — the store owns it).
 * Throws on the FIRST deterministic failure; every failure is fail-closed
 * (nothing is persisted by the caller).
 */
export function validateManifestDraft(
  draft: Omit<SynthesisManifestDraft, "inputID">,
  input: SynthesisInput,
  current?: CurrentBlockerState,
): void {
  if (!Array.isArray(draft.crossSectionLinks) || !Array.isArray(draft.implementationOrder) || !Array.isArray(draft.limitations) || !Array.isArray(draft.unresolvedFindings)) {
    throw new UltraPlanError("invalid_scope", "A manifest draft requires crossSectionLinks, implementationOrder, limitations, and unresolvedFindings arrays");
  }

  // -- Derived statements: provenance + cross-section rule (§25/§26/§59) -----
  // Statement sources resolve STRICTLY against the frozen input (§25: no
  // source outside the frozen input) — `current` blockers are consulted only
  // for findings (§33/§53).
  draft.crossSectionLinks.forEach((link, index) => {
    validateDerivedStatement(link, `Cross-section link[${index}]`, input, undefined);
    const distinctSections = new Set(
      (link.sources ?? []).filter((ref): ref is Extract<SynthesisSourceRef, { kind: "section" }> => ref.kind === "section").map((ref) => ref.id),
    );
    if (distinctSections.size < 2) {
      throw new UltraPlanError(
        "cross_section_invalid",
        `Cross-section link[${index}] must cite at least two DISTINCT Sections through exact refs (got ${distinctSections.size})`,
        { distinctSections: [...distinctSections] },
      );
    }
  });
  draft.limitations.forEach((limitation, index) => {
    validateDerivedStatement(limitation, `Limitation[${index}]`, input, undefined);
  });

  // -- Implementation steps: exact section refs + provenance (§27/§60) -------
  const sectionIDs = new Set<SectionID>(input.sections.map((section) => section.ref.id));
  const firstOccurrence = new Map<SectionID, number>();
  draft.implementationOrder.forEach((step, index) => {
    const what = `Implementation step[${index}]`;
    if (typeof step?.title !== "string" || step.title.trim().length === 0) {
      throw new UltraPlanError("invalid_scope", `${what} requires a non-empty title`);
    }
    if (typeof step?.description !== "string" || step.description.trim().length === 0) {
      throw new UltraPlanError("invalid_scope", `${what} requires a non-empty description`);
    }
    if (!Array.isArray(step?.sections)) {
      throw new UltraPlanError("invalid_scope", `${what} requires a sections array`);
    }
    for (const ref of step.sections) {
      const covered = input.sections.some((section) => section.ref.id === ref?.id && section.ref.revision === ref?.revision);
      if (!covered) {
        const known = sectionIDs.has(ref?.id);
        throw new UltraPlanError(
          "provenance_invalid",
          known
            ? `${what} binds historical revision ${ref.id}@${String(ref?.revision)} — implementation steps bind the exact frozen input revision ${input.sections.find((s) => s.ref.id === ref?.id)?.ref.revision}`
            : `${what} binds unknown Section ${String(ref?.id)} — implementation steps may only bind Sections of the frozen input`,
          { section: ref },
        );
      }
      if (!firstOccurrence.has(ref.id)) firstOccurrence.set(ref.id, index);
    }
    validateSources(step?.sources, what, input, current, { required: true });
  });

  // -- Coverage: every approved SectionRevision appears in ≥ 1 step (§28) ----
  const uncovered = input.sections.filter((section) => !firstOccurrence.has(section.ref.id));
  if (uncovered.length > 0) {
    throw new UltraPlanError(
      "implementation_coverage_gap",
      `Implementation order does not cover approved Section(s) ${uncovered.map((section) => `${section.ref.id}@${section.ref.revision}`).join(", ")}`,
      { uncovered: uncovered.map((section) => section.ref.id) },
    );
  }

  // -- Deterministic Section-DAG ordering (§29): for SEC-B depends on SEC-A,
  // first(SEC-A) <= first(SEC-B). Same-step grouping is acceptable (equal
  // first occurrence). No model/LLM validation involved.
  for (const section of input.sections) {
    for (const dep of section.dependencies) {
      const depFirst = firstOccurrence.get(dep);
      if (depFirst === undefined) continue; // dependency not bound by any step (already covered above)
      const ownFirst = firstOccurrence.get(section.ref.id) as number;
      if (depFirst > ownFirst) {
        throw new UltraPlanError(
          "implementation_order_violation",
          `Implementation order violates the Section DAG: ${section.ref.id} depends on ${dep}, but ${dep} first appears in step ${depFirst + 1} after ${section.ref.id} (step ${ownFirst + 1})`,
          { section: section.ref.id, dependency: dep },
        );
      }
    }
  }

  // -- Findings (§31) ---------------------------------------------------------
  draft.unresolvedFindings.forEach((finding, index) => {
    validateFinding(finding, index, input, current);
  });
}
