/**
 * Typed Plan Memory content models and parsers (frozen plan §12–§22).
 *
 * Persisted revision content never reaches the core or the read model as an
 * unchecked cast: every kind has one validating parser. Content-shape
 * violations are domain validation (MEMORY_REVISION_INVALID); unparsable
 * JSON text is a storage fault (STORE_SCHEMA_INVALID, thrown by the store
 * layer before these parsers run).
 *
 * Supersession never rewrites history: an old revision stays exactly as it
 * was; `supersedes`/`resolvedBy` are immutable content of the NEW revision,
 * and the HEAD Snapshot decides what is currently effective.
 */

import { memoryRevisionInvalid, parseEmbeddedMemoryRefs, type MemoryArtifactKind, type MemoryRef } from "./memory-refs.js";

export interface ConstraintContent {
  source: "user" | "repository" | "environment" | "runtime";
  statement: string;
  severity: "hard" | "soft";
  status: "active" | "superseded";
}

export interface DecisionContent {
  title: string;
  statement: string;
  rationale: string;
  alternatives: string[];
  consequences: string[];
  scope: string;
  supportingRefs: MemoryRef[];
  supersedes?: MemoryRef;
}

export interface ArchitectureContent {
  summary: string;
  components: string[];
  boundaries: string[];
  dataFlows: string[];
  principles: string[];
  unresolvedQuestionRefs: MemoryRef[];
  decisionRefs: MemoryRef[];
}

export interface SectionContract {
  sectionId: string;
  revision: number;
  provides: string[];
  requires: string[];
  invariants: string[];
  interfaces: string[];
  decisions: MemoryRef[];
}

export interface SectionContent {
  title: string;
  objective: string;
  design: string;
  interfaces: string[];
  invariants: string[];
  failureModes: string[];
  /** Dependency SECTION artifact ids — the snapshot decides exact revisions. */
  dependencies: string[];
  decisionRefs: MemoryRef[];
  openQuestionRefs: MemoryRef[];
  impactRefs: MemoryRef[];
  contract: SectionContract;
}

export interface OpenQuestionContent {
  question: string;
  blocking: boolean;
  scope: string;
  status: "open" | "resolved";
  resolution?: string;
  resolvedBy?: MemoryRef;
}

export interface ConflictContent {
  type: string;
  refs: MemoryRef[];
  description: string;
  severity: "hard" | "soft";
  status: "open" | "resolved";
  resolution?: string;
}

export type MemoryRevisionContent =
  | ConstraintContent
  | DecisionContent
  | ArchitectureContent
  | SectionContent
  | OpenQuestionContent
  | ConflictContent;

function requireObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw memoryRevisionInvalid("content must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw memoryRevisionInvalid(`${field} must be a non-empty string`);
  }
  return value;
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    throw memoryRevisionInvalid(`${field} must be an array of non-empty strings`);
  }
  return value as string[];
}

function requireEnum<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw memoryRevisionInvalid(`${field} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw memoryRevisionInvalid(`${field} must be a boolean`);
  }
  return value;
}

const CONSTRAINT_SOURCES = ["user", "repository", "environment", "runtime"] as const;
const SEVERITIES = ["hard", "soft"] as const;

function parseConstraint(value: unknown): ConstraintContent {
  const raw = requireObject(value);
  return {
    source: requireEnum(raw.source, "source", CONSTRAINT_SOURCES),
    statement: requireString(raw.statement, "statement"),
    severity: requireEnum(raw.severity, "severity", SEVERITIES),
    status: requireEnum(raw.status, "status", ["active", "superseded"] as const),
  };
}

function parseDecision(value: unknown, runId: string): DecisionContent {
  const raw = requireObject(value);
  const content: DecisionContent = {
    title: requireString(raw.title, "title"),
    statement: requireString(raw.statement, "statement"),
    rationale: requireString(raw.rationale, "rationale"),
    alternatives: requireStringArray(raw.alternatives, "alternatives"),
    consequences: requireStringArray(raw.consequences, "consequences"),
    scope: requireString(raw.scope, "scope"),
    supportingRefs: parseEmbeddedMemoryRefs(raw.supportingRefs ?? [], runId),
  };
  if (raw.supersedes !== undefined) {
    const ref = parseEmbeddedMemoryRefs([raw.supersedes], runId)[0];
    if (ref === undefined) throw memoryRevisionInvalid("supersedes must be a same-run MemoryRef");
    if (ref.kind !== "decision") {
      throw memoryRevisionInvalid("supersedes must reference a decision artifact");
    }
    content.supersedes = ref;
  }
  return content;
}

function parseArchitecture(value: unknown, runId: string): ArchitectureContent {
  const raw = requireObject(value);
  return {
    summary: requireString(raw.summary, "summary"),
    components: requireStringArray(raw.components, "components"),
    boundaries: requireStringArray(raw.boundaries, "boundaries"),
    dataFlows: requireStringArray(raw.dataFlows, "dataFlows"),
    principles: requireStringArray(raw.principles, "principles"),
    unresolvedQuestionRefs: parseEmbeddedMemoryRefs(raw.unresolvedQuestionRefs ?? [], runId),
    decisionRefs: parseEmbeddedMemoryRefs(raw.decisionRefs ?? [], runId),
  };
}

function parseSectionContract(value: unknown, runId: string, sectionId: string, revision: number): SectionContract {
  const raw = requireObject(value);
  const contract: SectionContract = {
    sectionId: requireString(raw.sectionId, "contract.sectionId"),
    revision: typeof raw.revision === "number" ? raw.revision : Number.NaN,
    provides: requireStringArray(raw.provides, "contract.provides"),
    requires: requireStringArray(raw.requires, "contract.requires"),
    invariants: requireStringArray(raw.invariants, "contract.invariants"),
    interfaces: requireStringArray(raw.interfaces, "contract.interfaces"),
    decisions: parseEmbeddedMemoryRefs(raw.decisions ?? [], runId),
  };
  for (const decisionRef of contract.decisions) {
    if (decisionRef.kind !== "decision") {
      throw memoryRevisionInvalid("contract decisions must reference decision artifacts");
    }
  }
  if (contract.sectionId !== sectionId) {
    throw memoryRevisionInvalid("contract.sectionId must match the section artifact id");
  }
  if (contract.revision !== revision) {
    throw memoryRevisionInvalid("contract.revision must match the section revision");
  }
  return contract;
}

function parseSection(value: unknown, runId: string, sectionId: string, revision: number): SectionContent {
  const raw = requireObject(value);
  const content: SectionContent = {
    title: requireString(raw.title, "title"),
    objective: requireString(raw.objective, "objective"),
    design: requireString(raw.design, "design"),
    interfaces: requireStringArray(raw.interfaces, "interfaces"),
    invariants: requireStringArray(raw.invariants, "invariants"),
    failureModes: requireStringArray(raw.failureModes, "failureModes"),
    dependencies: requireStringArray(raw.dependencies, "dependencies"),
    decisionRefs: parseEmbeddedMemoryRefs(raw.decisionRefs ?? [], runId),
    openQuestionRefs: parseEmbeddedMemoryRefs(raw.openQuestionRefs ?? [], runId),
    impactRefs: parseEmbeddedMemoryRefs(raw.impactRefs ?? [], runId),
    contract: parseSectionContract(raw.contract, runId, sectionId, revision),
  };
  for (const decisionRef of content.decisionRefs) {
    if (decisionRef.kind !== "decision") {
      throw memoryRevisionInvalid("section decisionRefs must reference decision artifacts");
    }
  }
  for (const questionRef of content.openQuestionRefs) {
    if (questionRef.kind !== "open_question") {
      throw memoryRevisionInvalid("section openQuestionRefs must reference open_question artifacts");
    }
  }
  if (content.dependencies.includes(sectionId)) {
    throw memoryRevisionInvalid("section cannot depend on itself");
  }
  return content;
}

function parseOpenQuestion(value: unknown, runId: string): OpenQuestionContent {
  const raw = requireObject(value);
  const status = requireEnum(raw.status, "status", ["open", "resolved"] as const);
  const content: OpenQuestionContent = {
    question: requireString(raw.question, "question"),
    blocking: requireBoolean(raw.blocking, "blocking"),
    scope: requireString(raw.scope, "scope"),
    status,
  };
  if (status === "resolved") {
    content.resolution = requireString(raw.resolution, "resolution");
  } else if (raw.resolution !== undefined) {
    throw memoryRevisionInvalid("open question cannot carry a resolution while open");
  }
  if (raw.resolvedBy !== undefined) {
    const ref = parseEmbeddedMemoryRefs([raw.resolvedBy], runId)[0];
    if (ref === undefined || ref.kind !== "decision") {
      throw memoryRevisionInvalid("resolvedBy must reference a same-run decision revision");
    }
    if (status !== "resolved") {
      throw memoryRevisionInvalid("resolvedBy requires status resolved");
    }
    content.resolvedBy = ref;
  }
  return content;
}

function parseConflict(value: unknown, runId: string): ConflictContent {
  const raw = requireObject(value);
  const content: ConflictContent = {
    type: requireString(raw.type, "type"),
    refs: parseEmbeddedMemoryRefs(raw.refs ?? [], runId),
    description: requireString(raw.description, "description"),
    severity: requireEnum(raw.severity, "severity", SEVERITIES),
    status: requireEnum(raw.status, "status", ["open", "resolved"] as const),
  };
  if (content.status === "resolved") {
    content.resolution = requireString(raw.resolution, "resolution");
  } else if (raw.resolution !== undefined) {
    throw memoryRevisionInvalid("open conflict cannot carry a resolution");
  }
  return content;
}

/** Parse raw persisted content for a kind. `artifactId`/`revision` bind contracts. */
export function parseMemoryRevisionContent(
  kind: MemoryArtifactKind,
  value: unknown,
  runId: string,
  artifactId: string,
  revision: number,
): MemoryRevisionContent {
  switch (kind) {
    case "constraint":
      return parseConstraint(value);
    case "decision":
      return parseDecision(value, runId);
    case "architecture":
      return parseArchitecture(value, runId);
    case "section":
      return parseSection(value, runId, artifactId, revision);
    case "open_question":
      return parseOpenQuestion(value, runId);
    case "conflict":
      return parseConflict(value, runId);
  }
}

/** Sections are the only kind that carries a contract projection (§19). */
export function requiresContractProjection(kind: MemoryArtifactKind): boolean {
  return kind === "section";
}
