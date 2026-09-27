/**
 * ExecutionIssue canonical model (Phase 15 §1–§11/§63).
 *
 * PURE core: vocabulary, canonical shape, deterministic hashing, and the
 * deterministic affected-scope derivation. No SQLite, no host, no git, no MCP.
 *
 * Semantics (§1): an ExecutionIssue records exactly one fact — "continuing
 * implementation would require changing approved planning semantics". It is
 * NOT an Observation and NOT Evidence (§3): Build has left the live planning
 * capture lifecycle, and a successor PlanningRun must re-observe repository
 * reality from scratch; issue prose is never committed design (§63).
 *
 * Immutability (§7): the issue is server-generated, immutable, and never
 * updated or deleted; its identity is `xissue_<opaque>` and its canonical
 * hash covers CONTENT ONLY (§8) — the issue id, timestamps, session id,
 * binding generation, and toolUseId are excluded, so an idempotent replay of
 * the same semantic payload hashes identically.
 */

import { createHash } from "node:crypto";

import { canonicalJson } from "./canonical-json.js";
import type { RepositoryBaseline } from "./execution-handoff.js";
import type { FinalPlanV1 } from "./finalization.js";

export const EXECUTION_ISSUE_VERSION = 1 as const;

/** §2 — the frozen kind vocabulary. No bug/misc/other/problem/warning exists. */
export const EXECUTION_ISSUE_KINDS = [
  "hard_constraint",
  "invariant",
  "approved_interface",
  "section_contract",
  "approved_decision",
  "explicit_dependency",
  "architecture_choice",
  "critical_repository_assumption",
  "missing_design_obligation",
] as const;

export type ExecutionIssueKind = (typeof EXECUTION_ISSUE_KINDS)[number];

export function isExecutionIssueKind(value: string): value is ExecutionIssueKind {
  return (EXECUTION_ISSUE_KINDS as readonly string[]).includes(value);
}

/**
 * §9 — affectedRefs may ONLY cite the approved FinalPlan closure, typed.
 * Historical superseded revisions, Observations, Evidence, Proposals,
 * arbitrary paths, conversation references, and freeform section names are
 * unrepresentable by construction.
 */
export const EXECUTION_ISSUE_REF_TYPES = [
  "architecture",
  "section",
  "section_contract",
  "decision",
  "constraint",
] as const;

export type ExecutionIssueRefType = (typeof EXECUTION_ISSUE_REF_TYPES)[number];

export function isExecutionIssueRefType(value: string): value is ExecutionIssueRefType {
  return (EXECUTION_ISSUE_REF_TYPES as readonly string[]).includes(value);
}

/** One model-supplied affected ref ({type, id, revision}) — exact only (§10). */
export interface ExecutionIssueAffectedRef {
  type: ExecutionIssueRefType;
  id: string;
  revision: number;
}

/**
 * ExecutionIssueV1 (§8) — every authoritative field server-derived. The
 * FinalPlan/Handoff identity and the repository context come from the signed
 * execution authority and the server's own git observation, never from model
 * input (§12/§16).
 */
export interface ExecutionIssueV1 {
  version: typeof EXECUTION_ISSUE_VERSION;
  finalPlan: { id: string; hash: string };
  handoff: { id: string; hash: string };
  kind: ExecutionIssueKind;
  summary: string;
  detail: string;
  affectedRefs: ExecutionIssueAffectedRef[];
  repositoryContext: RepositoryBaseline;
}

/**
 * Canonical issue hash (§8): sha256 over the canonical content payload with
 * affectedRefs deterministically sorted. Excluded by design: issue id,
 * reportedAt, session id, binding generation, toolUseId.
 */
export function executionIssueHash(issue: ExecutionIssueV1): string {
  const canonical = {
    ...issue,
    affectedRefs: [...issue.affectedRefs].sort(
      (a, b) => a.type.localeCompare(b.type) || a.id.localeCompare(b.id) || a.revision - b.revision,
    ),
  };
  return `sha256:${createHash("sha256").update(canonicalJson(canonical), "utf8").digest("hex")}`;
}

// ---------------------------------------------------------------------------
// §10 — exact FinalPlan-closure membership for affectedRefs
// ---------------------------------------------------------------------------

export type AffectedRefProblem =
  | { ref: ExecutionIssueAffectedRef; problem: "unknown_ref_type" }
  | { ref: ExecutionIssueAffectedRef; problem: "not_in_final_plan" };

/**
 * Validate every affected ref against the EXACT approved FinalPlan closure
 * (§10): `SEC-A@4` may only be cited as `SEC-A@4` — the bare id, an older
 * revision, or "latest" never resolve. Returns the problems found; an empty
 * list means every ref is exact-closure-authoritative. At least one ref is
 * required by the caller (§11 — no completely unscoped issue).
 */
export function affectedRefProblems(plan: FinalPlanV1, refs: ExecutionIssueAffectedRef[]): AffectedRefProblem[] {
  const problems: AffectedRefProblem[] = [];
  for (const ref of refs) {
    if (!isExecutionIssueRefType(ref.type)) {
      problems.push({ ref, problem: "unknown_ref_type" });
      continue;
    }
    const member = matchClosureRef(plan, ref);
    if (!member) {
      problems.push({ ref, problem: "not_in_final_plan" });
    }
  }
  return problems;
}

function matchClosureRef(plan: FinalPlanV1, ref: ExecutionIssueAffectedRef): boolean {
  switch (ref.type) {
    case "architecture":
      return plan.architecture !== null && plan.architecture.id === ref.id && plan.architecture.revision === ref.revision;
    case "section":
    case "section_contract":
      return plan.sections.some((section) => section.sectionId === ref.id && section.revision === ref.revision);
    case "decision":
      return plan.decisions.some((item) => item.kind === "decision" && item.id === ref.id && item.revision === ref.revision);
    case "constraint":
      return plan.constraints.some((item) => item.kind === "constraint" && item.id === ref.id && item.revision === ref.revision);
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// §32–§34 — deterministic affected-scope derivation (Core-derived, no NLP)
// ---------------------------------------------------------------------------

export interface DerivedAffectedScope {
  /** §36 — the successor's initial stage is always architecture or detail. */
  initialStage: "architecture" | "detail";
  /** §33/§34 — sections marked needs_review: affected set + downstream closure. */
  needsReviewSections: string[];
  /** §34 — sections whose predecessor completion carries forward untouched. */
  inheritedCompletedSections: string[];
  /** Architecture-level reasons (empty for a detail-stage successor). */
  architectureReasons: string[];
}

/**
 * §33/§34 — derive the successor's reopened scope from the issue kinds, the
 * validated exact affectedRefs, and the FinalPlan's Section DAG. Deterministic
 * classification:
 *
 *   architecture-level (§33 — ANY hit reopens EVERYTHING)
 *     - an ArchitectureRef
 *     - kind hard_constraint
 *     - kind architecture_choice
 *     - a Decision whose FinalPlan content scope is not an exact section id
 *     - kind critical_repository_assumption (global by definition)
 *     - kind missing_design_obligation NOT scoped to exact section refs
 *       (conservative default — §34 does not list it as section-scoped)
 *     - kind invariant / approved_interface cited with an ArchitectureRef
 *
 *   detail-level (§34 — only when NO issue is architecture-level)
 *     affected sections = exact SectionRef / SectionContractRef sections
 *     + section-scoped decisions' scope id (when it is an exact section id)
 *     + downstream closure over the FinalPlan Section DAG.
 */
export function deriveAffectedScope(
  plan: FinalPlanV1,
  issues: Array<{ kind: ExecutionIssueKind; affectedRefs: ExecutionIssueAffectedRef[] }>,
  readers: {
    /** Section dependency ids from the FinalPlan sections' committed content. */
    sectionDependencies: (sectionId: string) => string[];
    /** A FinalPlan decision's declared scope string, or null when unreadable. */
    decisionScope: (id: string, revision: number) => string | null;
  },
): DerivedAffectedScope {
  const sectionIds = new Set(plan.sections.map((section) => section.sectionId));
  const architectureReasons: string[] = [];
  const affectedSections = new Set<string>();

  for (const issue of issues) {
    const hasArchitectureRef = issue.affectedRefs.some((ref) => ref.type === "architecture");
    const sectionTargets = issue.affectedRefs
      .filter((ref) => ref.type === "section" || ref.type === "section_contract")
      .map((ref) => ref.id)
      .filter((id) => sectionIds.has(id));

    // Decision scope: section-scoped iff the decision content's scope names an
    // exact FinalPlan section id; otherwise architecture-scoped (§33/§34).
    let decisionSectionScoped = false;
    if (issue.kind === "approved_decision") {
      for (const ref of issue.affectedRefs.filter((candidate) => candidate.type === "decision")) {
        const scope = readers.decisionScope(ref.id, ref.revision);
        if (scope !== null && sectionIds.has(scope)) {
          affectedSections.add(scope);
          decisionSectionScoped = true;
        }
      }
    }

    const kindIsArchitectureLevel =
      issue.kind === "hard_constraint" ||
      issue.kind === "architecture_choice" ||
      issue.kind === "critical_repository_assumption" ||
      // missing_design_obligation: architecture-level unless every ref binds
      // an exact section scope (§34 lists no section-scoped variant).
      (issue.kind === "missing_design_obligation" && sectionTargets.length === 0) ||
      // invariant / approved_interface: section invariant / section-scoped
      // interface are detail-level ONLY when cited with section refs (§34).
      ((issue.kind === "invariant" || issue.kind === "approved_interface") && hasArchitectureRef);

    if (kindIsArchitectureLevel || hasArchitectureRef || (issue.kind === "approved_decision" && !decisionSectionScoped)) {
      architectureReasons.push(`${issue.kind}:${issue.affectedRefs.map(formatRef).sort().join(",")}`);
    }
    for (const sectionId of sectionTargets) {
      affectedSections.add(sectionId);
    }
  }

  if (architectureReasons.length > 0 || plan.sections.length === 0) {
    // §33 — every FinalPlan Section reopens; nothing inherits completion.
    return {
      initialStage: "architecture",
      needsReviewSections: [...sectionIds].sort(),
      inheritedCompletedSections: [],
      architectureReasons: [...architectureReasons].sort(),
    };
  }

  // §34 — downstream closure over the predecessor FinalPlan Section DAG.
  const dependents = new Map<string, string[]>();
  for (const section of plan.sections) {
    for (const dependency of readers.sectionDependencies(section.sectionId)) {
      const list = dependents.get(dependency);
      if (list === undefined) {
        dependents.set(dependency, [section.sectionId]);
      } else if (!list.includes(section.sectionId)) {
        list.push(section.sectionId);
      }
    }
  }
  const visited = new Set<string>();
  const queue = [...affectedSections];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const dependent of dependents.get(current) ?? []) {
      if (!visited.has(dependent)) queue.push(dependent);
    }
  }
  const needsReview = [...visited].filter((id) => sectionIds.has(id)).sort();
  const inherited = [...sectionIds].filter((id) => !visited.has(id)).sort();
  return {
    initialStage: "detail",
    needsReviewSections: needsReview,
    inheritedCompletedSections: inherited,
    architectureReasons: [],
  };
}

function formatRef(ref: ExecutionIssueAffectedRef): string {
  return `${ref.type}:${ref.id}@${ref.revision}`;
}
