/**
 * Synthesis / Semantic Validation canonical models (Phase 12 §13–§51/§80).
 *
 * PURE core: vocabulary, canonical shapes, deterministic hashing, and
 * structural validation. No SQLite, no host, no MCP.
 *
 * Authority model (§1–§3): a SynthesisInput is the frozen world one
 * synthesis cycle may depend on; a SynthesisManifest is a derived projection
 * of that input; a SemanticValidationReport is an independent detector's
 * output over the frozen bundle. None of them are Plan Memory mutations —
 * they never move HEAD, create PlanCommits, or approve design.
 *
 * Canonical identity (§15/§51/§106): hashes cover the semantic payload only.
 * Server-generated identity (input id, manifest id, finding ids, timestamps)
 * is excluded so an idempotent retry or a fresh cycle never changes canonical
 * semantics, and ordering differences never change the input hash (arrays of
 * refs/statements are canonically sorted; implementation steps keep their
 * authored order — the sequence itself is semantic).
 */

import { createHash } from "node:crypto";

import { canonicalJson } from "./canonical-json.js";

export const SYNTHESIS_INPUT_VERSION = 1 as const;
export const SYNTHESIS_MANIFEST_VERSION = 1 as const;
export const SEMANTIC_VALIDATION_REPORT_VERSION = 1 as const;

/** One frozen current design ref inside a SynthesisInput. */
export interface SynthesisInputRef {
  kind: "constraint" | "decision" | "architecture" | "section" | "open_question" | "conflict";
  id: string;
  revision: number;
  content: unknown;
}

/** One frozen SectionContract — embedded in the pinned section revision. */
export interface SynthesisInputSectionContract {
  sectionId: string;
  revision: number;
  contract: unknown;
}

/** One frozen relevant-Evidence state snapshot (§23). */
export interface SynthesisInputEvidence {
  evidenceId: string;
  revision: number;
  confidence: "direct" | "derived" | "uncertain";
  criticality: "critical" | "supporting" | "informational";
  validationStrategy: "fingerprint" | "reobserve";
  state: "fresh" | "needs_validation" | "stale" | "invalidated";
  lastValidationEventSeq: number;
  claim: string;
}

/**
 * SynthesisInputV1 — the canonical frozen world (§27). Every array is
 * deterministic; the hash covers exactly this payload.
 */
export interface SynthesisInputV1 {
  version: typeof SYNTHESIS_INPUT_VERSION;
  runId: string;
  baseRunRevision: number;
  baseHeadSnapshot: string;
  baseHeadCommit: string | null;
  architecture: SynthesisInputRef[];
  sections: SynthesisInputRef[];
  sectionContracts: SynthesisInputSectionContract[];
  decisions: SynthesisInputRef[];
  constraints: SynthesisInputRef[];
  resolvedQuestions: SynthesisInputRef[];
  resolvedConflicts: SynthesisInputRef[];
  relevantEvidence: SynthesisInputEvidence[];
}

/**
 * Canonical input hash (§15/§106): sha256(canonicalJson(SynthesisInputV1)).
 * The hash canonicalizes internally, so presentation order of the ref /
 * evidence arrays never changes it.
 */
export function synthesisInputHash(input: SynthesisInputV1): string {
  return `sha256:${createHash("sha256").update(canonicalJson(canonicalizeSynthesisInput(input)), "utf8").digest("hex")}`;
}

function sortRefs<T extends { kind: string; id?: string; sectionId?: string; revision: number }>(refs: T[]): T[] {
  return [...refs].sort((a, b) => {
    const aId = a.id ?? a.sectionId ?? "";
    const bId = b.id ?? b.sectionId ?? "";
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    if (aId !== bId) return aId < bId ? -1 : 1;
    return a.revision - b.revision;
  });
}

/**
 * Deterministic re-ordering of a freshly assembled input: design refs by
 * (kind, id, revision), evidence by evidence id (§27/§106).
 */
export function canonicalizeSynthesisInput(input: SynthesisInputV1): SynthesisInputV1 {
  return {
    ...input,
    architecture: sortRefs(input.architecture),
    sections: sortRefs(input.sections),
    sectionContracts: [...input.sectionContracts].sort((a, b) => {
      if (a.sectionId !== b.sectionId) return a.sectionId < b.sectionId ? -1 : 1;
      return a.revision - b.revision;
    }),
    decisions: sortRefs(input.decisions),
    constraints: sortRefs(input.constraints),
    resolvedQuestions: sortRefs(input.resolvedQuestions),
    resolvedConflicts: sortRefs(input.resolvedConflicts),
    relevantEvidence: [...input.relevantEvidence].sort((a, b) =>
      a.evidenceId < b.evidenceId ? -1 : a.evidenceId > b.evidenceId ? 1 : a.revision - b.revision,
    ),
  };
}

// ---------------------------------------------------------------------------
// Synthesis manifest
// ---------------------------------------------------------------------------

/**
 * The exact ref vocabulary a derived statement may cite (§38). These are the
 * bundle-facing names; the relational index maps section_contract → section
 * and question → open_question.
 */
export const SYNTHESIS_BUNDLE_REF_KINDS = [
  "architecture",
  "section",
  "section_contract",
  "decision",
  "constraint",
  "question",
  "conflict",
  "evidence",
] as const;
export type SynthesisBundleRefKind = (typeof SYNTHESIS_BUNDLE_REF_KINDS)[number];

export interface SynthesisBundleRef {
  kind: SynthesisBundleRefKind;
  id: string;
  revision: number;
}

/** A derived statement that must cite exact supports (§38). */
export interface DerivedStatement {
  statement: string;
  supportingRefs: SynthesisBundleRef[];
}

/** A manifest-local implementation step (§39). stepId is NOT Plan Memory identity. */
export interface ImplementationStep {
  stepId: string;
  title: string;
  description: string;
  dependsOn: string[];
  supportingRefs: SynthesisBundleRef[];
}

/** The finding vocabulary a manifest's unresolvedFindings may use (§80). */
export const SYNTHESIS_MANIFEST_FINDING_KINDS = [
  "contradiction",
  "missing_design",
  "missing_dependency",
  "coverage_gap",
  "limitation",
] as const;
export type SynthesisManifestFindingKind = (typeof SYNTHESIS_MANIFEST_FINDING_KINDS)[number];

export interface SynthesisManifestFinding {
  kind: SynthesisManifestFindingKind;
  summary: string;
  detail: string;
  subjectRefs: SynthesisBundleRef[];
  supportingRefs: SynthesisBundleRef[];
}

/** SynthesisManifestV1 — the derived projection (§37). */
export interface SynthesisManifestV1 {
  version: typeof SYNTHESIS_MANIFEST_VERSION;
  inputId: string;
  inputHash: string;
  crossSectionLinks: DerivedStatement[];
  implementationOrder: ImplementationStep[];
  limitations: DerivedStatement[];
  unresolvedFindings: SynthesisManifestFinding[];
}

/**
 * Canonical manifest hash: derived-statement collections are canonically
 * sorted (statement text is not an identity), implementation steps keep
 * authored order. Identity fields the server generates later (manifest id,
 * timestamps) are not part of the payload.
 */
export function synthesisManifestHash(manifest: SynthesisManifestV1): string {
  const canonical = {
    ...manifest,
    crossSectionLinks: sortStatements(manifest.crossSectionLinks),
    limitations: sortStatements(manifest.limitations),
    unresolvedFindings: [...manifest.unresolvedFindings].sort((a, b) => {
      if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
      if (a.summary !== b.summary) return a.summary < b.summary ? -1 : 1;
      return a.detail < b.detail ? -1 : 1;
    }),
  };
  return `sha256:${createHash("sha256").update(canonicalJson(canonical), "utf8").digest("hex")}`;
}

function sortStatements<T extends { statement: string }>(statements: T[]): T[] {
  return [...statements].sort((a, b) => (a.statement < b.statement ? -1 : a.statement > b.statement ? 1 : 0));
}

/**
 * Every distinct supporting/subject ref in the manifest, in first-appearance
 * order — the seed for the relational provenance index (§90).
 */
export function manifestSupportRefs(manifest: SynthesisManifestV1): SynthesisBundleRef[] {
  const seen = new Set<string>();
  const refs: SynthesisBundleRef[] = [];
  const push = (ref: SynthesisBundleRef) => {
    const key = `${ref.kind}\u0000${ref.id}\u0000${ref.revision}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push(ref);
  };
  for (const statement of [...manifest.crossSectionLinks, ...manifest.limitations]) {
    for (const ref of statement.supportingRefs) push(ref);
  }
  for (const step of manifest.implementationOrder) {
    for (const ref of step.supportingRefs) push(ref);
  }
  for (const finding of manifest.unresolvedFindings) {
    for (const ref of finding.subjectRefs) push(ref);
    for (const ref of finding.supportingRefs) push(ref);
  }
  return refs;
}

function requireStringField(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`manifest field '${field}' must be a non-empty string`);
  }
  return value;
}

function parseBundleRef(value: unknown): SynthesisBundleRef {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("bundle ref must be an object");
  }
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  if (typeof kind !== "string" || !(SYNTHESIS_BUNDLE_REF_KINDS as readonly string[]).includes(kind)) {
    throw new TypeError(`bundle ref kind '${String(kind)}' is not in the frozen vocabulary`);
  }
  const id = requireStringField(record.id, "ref id");
  const revision = record.revision;
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 1) {
    throw new TypeError("bundle ref revision must be an integer >= 1");
  }
  return { kind: kind as SynthesisBundleRefKind, id, revision };
}

function parseBundleRefs(value: unknown, field: string): SynthesisBundleRef[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`'${field}' must be an array`);
  }
  return value.map((entry) => parseBundleRef(entry));
}

function parseDerivedStatement(value: unknown): DerivedStatement {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("derived statement must be an object");
  }
  const record = value as Record<string, unknown>;
  const supportingRefs = parseBundleRefs(record.supportingRefs, "supportingRefs");
  if (supportingRefs.length === 0) {
    throw new TypeError("derived statements require non-empty supportingRefs");
  }
  return {
    statement: requireStringField(record.statement, "statement"),
    supportingRefs,
  };
}

function parseDerivedStatements(value: unknown, field: string): DerivedStatement[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`'${field}' must be an array`);
  }
  return value.map((entry) => parseDerivedStatement(entry));
}

/**
 * Structural manifest validation (§38–§40): shapes, unique step ids, acyclic
 * dependency graph, non-empty supports. Membership of every ref in the
 * frozen input is enforced by the caller against the loaded input
 * (SYNTHESIS_REF_INVALID).
 */
export function validateSynthesisManifest(raw: unknown): SynthesisManifestV1 {
  if (typeof raw !== "object" || raw === null) {
    throw new TypeError("manifest must be an object");
  }
  const record = raw as Record<string, unknown>;
  if (record.version !== SYNTHESIS_MANIFEST_VERSION) {
    throw new TypeError(`unsupported manifest version: ${String(record.version)}`);
  }
  const inputId = requireStringField(record.inputId, "inputId");
  const inputHash = requireStringField(record.inputHash, "inputHash");
  if (!inputHash.startsWith("sha256:")) {
    throw new TypeError("inputHash must be a sha256:… hash");
  }
  const stepsRaw = record.implementationOrder;
  if (!Array.isArray(stepsRaw)) {
    throw new TypeError("'implementationOrder' must be an array");
  }
  const implementationOrder: ImplementationStep[] = stepsRaw.map((entry) => {
    if (typeof entry !== "object" || entry === null) {
      throw new TypeError("implementation step must be an object");
    }
    const step = entry as Record<string, unknown>;
    const dependsOn = step.dependsOn;
    if (!Array.isArray(dependsOn) || dependsOn.some((d) => typeof d !== "string")) {
      throw new TypeError("step dependsOn must be an array of step ids");
    }
    const supportingRefs = parseBundleRefs(step.supportingRefs, "step supportingRefs");
    if (supportingRefs.length === 0) {
      throw new TypeError("implementation steps require non-empty supportingRefs");
    }
    return {
      stepId: requireStringField(step.stepId, "stepId"),
      title: requireStringField(step.title, "title"),
      description: requireStringField(step.description, "description"),
      dependsOn: [...dependsOn],
      supportingRefs,
    };
  });
  const stepIds = new Set(implementationOrder.map((step) => step.stepId));
  if (stepIds.size !== implementationOrder.length) {
    throw new TypeError("implementation step ids must be unique");
  }
  for (const step of implementationOrder) {
    for (const dependency of step.dependsOn) {
      if (!stepIds.has(dependency)) {
        throw new TypeError(`step '${step.stepId}' depends on unknown step '${dependency}'`);
      }
    }
  }
  assertAcyclic(implementationOrder);
  const findingsRaw = record.unresolvedFindings;
  if (!Array.isArray(findingsRaw)) {
    throw new TypeError("'unresolvedFindings' must be an array");
  }
  const unresolvedFindings: SynthesisManifestFinding[] = findingsRaw.map((entry) => {
    if (typeof entry !== "object" || entry === null) {
      throw new TypeError("unresolved finding must be an object");
    }
    const finding = entry as Record<string, unknown>;
    const kind = finding.kind;
    if (typeof kind !== "string" || !(SYNTHESIS_MANIFEST_FINDING_KINDS as readonly string[]).includes(kind)) {
      throw new TypeError(`unresolved finding kind '${String(kind)}' is not in the frozen vocabulary`);
    }
    const subjectRefs = parseBundleRefs(finding.subjectRefs, "subjectRefs");
    if (subjectRefs.length === 0) {
      throw new TypeError("unresolved findings require non-empty subjectRefs");
    }
    return {
      kind: kind as SynthesisManifestFindingKind,
      summary: requireStringField(finding.summary, "summary"),
      detail: requireStringField(finding.detail, "detail"),
      subjectRefs,
      supportingRefs: parseBundleRefs(finding.supportingRefs ?? [], "supportingRefs"),
    };
  });
  return {
    version: SYNTHESIS_MANIFEST_VERSION,
    inputId,
    inputHash,
    crossSectionLinks: parseDerivedStatements(record.crossSectionLinks, "crossSectionLinks"),
    implementationOrder,
    limitations: parseDerivedStatements(record.limitations, "limitations"),
    unresolvedFindings,
  };
}

/** Deterministic dependency check: step graphs must be acyclic (§39/E20). */
function assertAcyclic(steps: ImplementationStep[]): void {
  const byId = new Map(steps.map((step) => [step.stepId, step]));
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (stepId: string): void => {
    if (done.has(stepId)) return;
    if (visiting.has(stepId)) {
      throw new TypeError(`implementation step dependency graph has a cycle at '${stepId}'`);
    }
    visiting.add(stepId);
    const step = byId.get(stepId);
    if (step !== undefined) {
      for (const dependency of step.dependsOn) visit(dependency);
    }
    visiting.delete(stepId);
    done.add(stepId);
  };
  for (const step of steps) visit(step.stepId);
}

// ---------------------------------------------------------------------------
// Semantic validation reports
// ---------------------------------------------------------------------------

/** The frozen finding vocabulary (§47) — no extensions accepted. */
export const VALIDATION_FINDING_KINDS = [
  "unsupported_new_fact",
  "contradiction",
  "missing_design",
  "missing_dependency",
  "incorrect_derivation",
  "coverage_gap",
  "clean",
] as const;
export type ValidationFindingKind = (typeof VALIDATION_FINDING_KINDS)[number];

export interface ValidationFinding {
  kind: ValidationFindingKind;
  summary: string;
  detail: string;
  subjectRefs: SynthesisBundleRef[];
  supportingRefs: SynthesisBundleRef[];
}

/**
 * SemanticValidationReportV1 — hash payload (§51): input/manifest identity
 * plus canonical findings. Server-generated report id, timestamps, and
 * per-finding ids are excluded (§50).
 */
export interface SemanticValidationReportV1 {
  version: typeof SEMANTIC_VALIDATION_REPORT_VERSION;
  inputId: string;
  inputHash: string;
  manifestId: string;
  manifestHash: string;
  findings: ValidationFinding[];
}

export function semanticValidationReportHash(report: SemanticValidationReportV1): string {
  const canonical = {
    ...report,
    findings: [...report.findings].sort((a, b) => {
      if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
      if (a.summary !== b.summary) return a.summary < b.summary ? -1 : 1;
      return a.detail < b.detail ? -1 : 1;
    }),
  };
  return `sha256:${createHash("sha256").update(canonicalJson(canonical), "utf8").digest("hex")}`;
}

/**
 * CORE-DERIVED clean semantics (§48): clean is valid only as the sole
 * finding; one-or-more non-clean findings is the other legal shape. The
 * model never submits an is_clean flag.
 */
export function derivedIsClean(findings: ValidationFinding[]): boolean {
  return findings.length === 1 && findings[0] !== undefined && findings[0].kind === "clean";
}

export function validateValidationFindings(raw: unknown): ValidationFinding[] {
  if (!Array.isArray(raw)) {
    throw new TypeError("findings must be an array");
  }
  if (raw.length === 0) {
    throw new TypeError("findings must be [clean] or one-or-more non-clean findings");
  }
  const findings = raw.map((entry) => {
    if (typeof entry !== "object" || entry === null) {
      throw new TypeError("finding must be an object");
    }
    const record = entry as Record<string, unknown>;
    const kind = record.kind;
    if (typeof kind !== "string" || !(VALIDATION_FINDING_KINDS as readonly string[]).includes(kind)) {
      throw new TypeError(`finding kind '${String(kind)}' is not in the frozen vocabulary`);
    }
    return {
      kind: kind as ValidationFindingKind,
      summary: requireStringField(record.summary, "summary"),
      detail: requireStringField(record.detail, "detail"),
      subjectRefs: parseBundleRefs(record.subjectRefs ?? [], "subjectRefs"),
      supportingRefs: parseBundleRefs(record.supportingRefs ?? [], "supportingRefs"),
    };
  });
  const cleanCount = findings.filter((f) => f.kind === "clean").length;
  if (cleanCount > 0 && findings.length > 1) {
    throw new TypeError("clean must be the sole finding");
  }
  if (cleanCount === 1 && findings.length === 1) {
    const sole = findings[0];
    if (sole !== undefined && sole.subjectRefs.length > 0) {
      throw new TypeError("the clean finding carries no subjectRefs");
    }
  }
  return findings;
}
