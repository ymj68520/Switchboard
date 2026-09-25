/**
 * Proposal domain vocabulary and parsers (frozen plan Phase 6 §6–§15/§84).
 *
 * A Proposal is the frozen, hashable boundary between working discussion and
 * committed design. Identity (run + opaque server-generated proposal id) is
 * separate from revisions (immutable frozen content, strict max+1) and from
 * state (awaiting_approval → approved/rejected/superseded, terminal).
 *
 * The schema recognizes the full frozen proposal-type vocabulary, but the
 * Phase 6 production Transaction Engine only opens design_checkpoint,
 * architecture_completion, and amendment — section_completion and final_plan
 * fail closed with PROPOSAL_TYPE_UNAVAILABLE rather than faking Section
 * lifecycle or Finalization semantics that do not exist yet.
 *
 * Normalized changes carry refs WITHOUT the owning runId (the canonical
 * representation pins runId once at the root); every parser rebinds them to
 * the owning run so cross-run contamination is invalid by construction.
 */

import {
  isMemoryArtifactKind,
  parseMemoryRefShape,
  type MemoryArtifactKind,
  type MemoryRef,
} from "./memory-refs.js";
import {
  parseMemoryRevisionContent,
  type ArchitectureContent,
  type ConflictContent,
  type ConstraintContent,
  type DecisionContent,
  type OpenQuestionContent,
  type SectionContent,
} from "./memory-artifacts.js";
import { RuntimeError } from "../runtime/errors.js";

// ---------------------------------------------------------------------------
// Proposal identity / type / scope / status vocabulary
// ---------------------------------------------------------------------------

export const PROPOSAL_TYPES = [
  "design_checkpoint",
  "architecture_completion",
  "section_completion",
  "amendment",
  "final_plan",
] as const;

export type ProposalType = (typeof PROPOSAL_TYPES)[number];

/** Types the Phase 6 Transaction Engine actually implements. */
export const PRODUCTION_PROPOSAL_TYPES = [
  "design_checkpoint",
  "architecture_completion",
  "amendment",
] as const satisfies readonly ProposalType[];

export function isProposalType(value: string): value is ProposalType {
  return (PROPOSAL_TYPES as readonly string[]).includes(value);
}

export function isProductionProposalType(value: string): value is (typeof PRODUCTION_PROPOSAL_TYPES)[number] {
  return (PRODUCTION_PROPOSAL_TYPES as readonly string[]).includes(value);
}

export type ProposalScope = { kind: "architecture" } | { kind: "section"; sectionId: string };

export const PROPOSAL_STATUSES = [
  "awaiting_approval",
  "approved",
  "rejected",
  "superseded",
] as const;

export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

/** awaiting_approval is the only non-terminal status; terminals never reopen. */
export const PROPOSAL_STATUS_TRANSITIONS: Readonly<
  Record<ProposalStatus, readonly ProposalStatus[]>
> = {
  awaiting_approval: ["approved", "rejected", "superseded"],
  approved: [],
  rejected: [],
  superseded: [],
};

export function isProposalStatus(value: string): value is ProposalStatus {
  return (PROPOSAL_STATUSES as readonly string[]).includes(value);
}

/** Structural identity ref (kind + id, no revision) for impact declarations. */
export interface ArtifactIdentityRef {
  kind: MemoryArtifactKind;
  id: string;
}

/** Exact artifact revision ref without the owning runId (canonical form). */
export interface ArtifactRef {
  kind: MemoryArtifactKind;
  id: string;
  revision: number;
}

export interface ImpactAnalysis {
  affected: ArtifactIdentityRef[];
  notes: string[];
}

export function proposalInvalid(message: string, detail?: Record<string, unknown>): RuntimeError {
  return new RuntimeError("PROPOSAL_INVALID", message, { detail, recoverable: false });
}

// ---------------------------------------------------------------------------
// Raw (model-facing) proposal change input — untrusted, pre-normalization
// ---------------------------------------------------------------------------

export interface RawChangeTarget {
  id: string;
  revision: number;
}

/**
 * Raw changes never carry artifact ids or result revisions: ADD/SET(null)
 * ops get server-generated ids, mutation ops pin an exact base target, and
 * the server derives every result revision (frozen plan §14). Content is
 * typed per op and validated by the same parsers as committed memory.
 */
export type RawProposalChange =
  | { op: "ADD_CONSTRAINT"; content: ConstraintContent; compactProjection: string; fullProjection?: string }
  | { op: "SUPERSEDE_CONSTRAINT"; target: RawChangeTarget; content: ConstraintContent; compactProjection: string; fullProjection?: string }
  | { op: "ADD_DECISION"; content: DecisionContent; compactProjection: string; fullProjection?: string }
  | { op: "SUPERSEDE_DECISION"; target: RawChangeTarget; content: DecisionContent; compactProjection: string; fullProjection?: string }
  | { op: "SET_ARCHITECTURE_REVISION"; target: RawChangeTarget | null; content: Omit<ArchitectureContent, never>; compactProjection: string; fullProjection?: string }
  | { op: "SET_SECTION_REVISION"; target: RawChangeTarget | null; content: RawSectionContent; compactProjection: string; fullProjection?: string }
  | { op: "ADD_OPEN_QUESTION"; content: OpenQuestionContent; compactProjection: string; fullProjection?: string }
  | { op: "RESOLVE_OPEN_QUESTION"; target: RawChangeTarget; content: RawResolvedQuestionContent; compactProjection: string; fullProjection?: string }
  | { op: "ADD_CONFLICT"; content: ConflictContent; compactProjection: string; fullProjection?: string }
  | { op: "RESOLVE_CONFLICT"; target: RawChangeTarget; content: ConflictContent; compactProjection: string; fullProjection?: string };

/**
 * Raw section content carries a contract WITHOUT sectionId/revision — the
 * server binds both during normalization (sectionId from the generated or
 * targeted artifact, revision from the derived result revision).
 */
export interface RawSectionContent {
  title: string;
  objective: string;
  design: string;
  interfaces: string[];
  invariants: string[];
  failureModes: string[];
  dependencies: string[];
  decisionRefs: MemoryRef[];
  openQuestionRefs: MemoryRef[];
  impactRefs: MemoryRef[];
  contract: {
    provides: string[];
    requires: string[];
    invariants: string[];
    interfaces: string[];
    decisions: MemoryRef[];
  };
}

/** Resolved question content: resolvedBy pins only the decision ref core. */
export interface RawResolvedQuestionContent extends Omit<OpenQuestionContent, "resolvedBy"> {
  status: "resolved";
  resolution: string;
  resolvedBy?: { id: string; revision: number };
}

// ---------------------------------------------------------------------------
// Normalized (frozen) proposal change representation
// ---------------------------------------------------------------------------

export type NormalizedProposalChange =
  | { op: "ADD_CONSTRAINT"; artifactId: string; content: ConstraintContent; result: ArtifactRef; compactProjection: string; fullProjection?: string }
  | { op: "SUPERSEDE_CONSTRAINT"; target: ArtifactRef; artifactId: string; content: ConstraintContent; result: ArtifactRef; compactProjection: string; fullProjection?: string }
  | { op: "ADD_DECISION"; artifactId: string; content: DecisionContent; result: ArtifactRef; compactProjection: string; fullProjection?: string }
  | { op: "SUPERSEDE_DECISION"; target: ArtifactRef; artifactId: string; content: DecisionContent; result: ArtifactRef; compactProjection: string; fullProjection?: string }
  | { op: "SET_ARCHITECTURE_REVISION"; target: ArtifactRef | null; artifactId: string; content: ArchitectureContent; result: ArtifactRef; compactProjection: string; fullProjection?: string }
  | { op: "SET_SECTION_REVISION"; target: ArtifactRef | null; artifactId: string; content: SectionContent; result: ArtifactRef; compactProjection: string; fullProjection?: string }
  | { op: "ADD_OPEN_QUESTION"; artifactId: string; content: OpenQuestionContent; result: ArtifactRef; compactProjection: string; fullProjection?: string }
  | { op: "RESOLVE_OPEN_QUESTION"; target: ArtifactRef; artifactId: string; content: OpenQuestionContent; result: ArtifactRef; compactProjection: string; fullProjection?: string }
  | { op: "ADD_CONFLICT"; artifactId: string; content: ConflictContent; result: ArtifactRef; compactProjection: string; fullProjection?: string }
  | { op: "RESOLVE_CONFLICT"; target: ArtifactRef; artifactId: string; content: ConflictContent; result: ArtifactRef; compactProjection: string; fullProjection?: string };

export const PROPOSAL_CHANGE_OPS = [
  "ADD_CONSTRAINT",
  "SUPERSEDE_CONSTRAINT",
  "ADD_DECISION",
  "SUPERSEDE_DECISION",
  "SET_ARCHITECTURE_REVISION",
  "SET_SECTION_REVISION",
  "ADD_OPEN_QUESTION",
  "RESOLVE_OPEN_QUESTION",
  "ADD_CONFLICT",
  "RESOLVE_CONFLICT",
] as const;

export type ProposalChangeOp = (typeof PROPOSAL_CHANGE_OPS)[number];

export function isProposalChangeOp(value: string): value is ProposalChangeOp {
  return (PROPOSAL_CHANGE_OPS as readonly string[]).includes(value);
}

/** The committed-memory kind a change op applies to. */
export function changeOpKind(op: ProposalChangeOp): MemoryArtifactKind {
  switch (op) {
    case "ADD_CONSTRAINT":
    case "SUPERSEDE_CONSTRAINT":
      return "constraint";
    case "ADD_DECISION":
    case "SUPERSEDE_DECISION":
      return "decision";
    case "SET_ARCHITECTURE_REVISION":
      return "architecture";
    case "SET_SECTION_REVISION":
      return "section";
    case "ADD_OPEN_QUESTION":
    case "RESOLVE_OPEN_QUESTION":
      return "open_question";
    case "ADD_CONFLICT":
    case "RESOLVE_CONFLICT":
      return "conflict";
  }
}

/** Mutation target of a change, or null for creates (ADD ops and null-target SETs). */
export function changeTarget(change: NormalizedProposalChange): ArtifactRef | null {
  if (
    change.op === "ADD_CONSTRAINT" ||
    change.op === "ADD_DECISION" ||
    change.op === "ADD_OPEN_QUESTION" ||
    change.op === "ADD_CONFLICT"
  ) {
    return null;
  }
  return change.target;
}

function isRawChangeTarget(value: unknown): value is RawChangeTarget {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as RawChangeTarget).id === "string" &&
    (value as RawChangeTarget).id !== "" &&
    typeof (value as RawChangeTarget).revision === "number" &&
    Number.isInteger((value as RawChangeTarget).revision) &&
    (value as RawChangeTarget).revision >= 1
  );
}

function requireProjection(value: Record<string, unknown>): { compactProjection: string; fullProjection?: string } {
  if (typeof value.compactProjection !== "string" || value.compactProjection.trim() === "") {
    throw proposalInvalid("proposal change requires a non-empty compactProjection");
  }
  const out: { compactProjection: string; fullProjection?: string } = {
    compactProjection: value.compactProjection,
  };
  if (value.fullProjection !== undefined) {
    if (typeof value.fullProjection !== "string" || value.fullProjection.trim() === "") {
      throw proposalInvalid("proposal change fullProjection must be a non-empty string when present");
    }
    out.fullProjection = value.fullProjection;
  }
  return out;
}

/**
 * Parse one persisted normalized change back into typed form. The content is
 * revalidated with the exact committed-memory parser (binding section
 * contracts to the frozen result revision) so persisted proposals can never
 * drift from the content model.
 */
export function parseNormalizedProposalChange(value: unknown, runId: string): NormalizedProposalChange {
  if (typeof value !== "object" || value === null) {
    throw proposalInvalid("proposal change must be a JSON object");
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.op !== "string" || !isProposalChangeOp(raw.op)) {
    throw proposalInvalid(`unknown proposal change op '${String(raw.op)}'`);
  }
  const op = raw.op as ProposalChangeOp;
  const kind = changeOpKind(op);
  const { compactProjection, fullProjection } = requireProjection(raw);
  const projection = { compactProjection, ...(fullProjection !== undefined ? { fullProjection } : {}) };

  const parseContent = (contentValue: unknown, artifactId: string, revision: number) =>
    parseMemoryRevisionContent(kind, contentValue, runId, artifactId, revision);

  if (op === "ADD_CONSTRAINT" || op === "ADD_DECISION" || op === "ADD_OPEN_QUESTION" || op === "ADD_CONFLICT") {
    if (typeof raw.artifactId !== "string" || raw.artifactId === "") {
      throw proposalInvalid(`${op} requires a server-assigned artifactId`);
    }
    if (raw.target !== undefined) throw proposalInvalid(`${op} must not carry a target`);
    const result = requireArtifactRef(raw.result, kind, raw.artifactId);
    if (result.revision !== 1) throw proposalInvalid(`${op} result revision must be 1`);
    const content = parseContent(raw.content, raw.artifactId, 1);
    return {
      op,
      artifactId: raw.artifactId,
      content,
      result,
      ...projection,
    } as NormalizedProposalChange;
  }

  if (op === "SET_ARCHITECTURE_REVISION" || op === "SET_SECTION_REVISION") {
    if (typeof raw.artifactId !== "string" || raw.artifactId === "") {
      throw proposalInvalid(`${op} requires a server-assigned artifactId`);
    }
    const target = raw.target === null ? null : requireTargetRef(raw.target, kind);
    const result = requireArtifactRef(raw.result, kind, raw.artifactId);
    const content = parseContent(raw.content, raw.artifactId, result.revision);
    return {
      op,
      target,
      artifactId: raw.artifactId,
      content,
      result,
      ...projection,
    } as NormalizedProposalChange;
  }

  // SUPERSEDE_*/RESOLVE_*: target is required and pins the base revision.
  if (!isRawChangeTarget(raw.target)) {
    throw proposalInvalid(`${op} requires an exact target ref`);
  }
  if (typeof raw.artifactId !== "string" || raw.artifactId === "") {
    throw proposalInvalid(`${op} requires a server-assigned artifactId`);
  }
  const target = requireTargetRef(raw.target, kind);
  const result = requireArtifactRef(raw.result, kind, raw.artifactId);
  const content = parseContent(raw.content, raw.artifactId, result.revision);
  return {
    op,
    target,
    artifactId: raw.artifactId,
    content,
    result,
    ...projection,
  } as NormalizedProposalChange;
}

function requireTargetRef(value: unknown, kind: MemoryArtifactKind): ArtifactRef {
  if (typeof value !== "object" || value === null) {
    throw proposalInvalid("target must be a ref object");
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || raw.id === "") throw proposalInvalid("target.id must be a non-empty string");
  if (typeof raw.revision !== "number" || !Number.isInteger(raw.revision) || raw.revision < 1) {
    throw proposalInvalid("target.revision must be a positive integer");
  }
  return { kind, id: raw.id, revision: raw.revision };
}

function requireArtifactRef(value: unknown, kind: MemoryArtifactKind, id: string): ArtifactRef {
  if (typeof value !== "object" || value === null) {
    throw proposalInvalid("result must be a ref object");
  }
  const raw = value as Record<string, unknown>;
  if (raw.kind !== kind) throw proposalInvalid("result.kind must match the change op kind");
  if (raw.id !== id) throw proposalInvalid("result.id must match the change artifactId");
  if (typeof raw.revision !== "number" || !Number.isInteger(raw.revision) || raw.revision < 1) {
    throw proposalInvalid("result.revision must be a positive integer");
  }
  return { kind, id, revision: raw.revision };
}

/** Parse persisted dependencies (canonical ArtifactRef form) into exact same-run refs. */
export function parseProposalDependencies(value: unknown, runId: string): MemoryRef[] {
  if (!Array.isArray(value)) throw proposalInvalid("dependencies must be an array");
  return value.map((entry) => {
    const ref = parseMemoryRefShape(
      typeof entry === "object" && entry !== null ? { ...(entry as Record<string, unknown>), runId } : entry,
    );
    if (ref === null || ref.runId !== runId) {
      throw proposalInvalid("dependency refs must be exact same-run refs");
    }
    return ref;
  });
}

/** Parse persisted scope JSON into the discriminated ProposalScope. */
export function parseProposalScope(value: unknown): ProposalScope {
  if (typeof value !== "object" || value === null) throw proposalInvalid("scope must be an object");
  const raw = value as Record<string, unknown>;
  if (raw.kind === "architecture") {
    if (Object.keys(raw).length !== 1) throw proposalInvalid("architecture scope carries no extra fields");
    return { kind: "architecture" };
  }
  if (raw.kind === "section") {
    if (typeof raw.sectionId !== "string" || raw.sectionId === "" || Object.keys(raw).length !== 2) {
      throw proposalInvalid("section scope requires exactly a sectionId");
    }
    return { kind: "section", sectionId: raw.sectionId };
  }
  throw proposalInvalid("scope.kind must be 'architecture' or 'section'");
}

/** Parse persisted impact JSON; impact never carries authority (§21). */
export function parseProposalImpact(value: unknown): ImpactAnalysis {
  if (typeof value !== "object" || value === null) throw proposalInvalid("impact must be an object");
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.affected) || !Array.isArray(raw.notes)) {
    throw proposalInvalid("impact requires affected[] and notes[]");
  }
  const affected: ArtifactIdentityRef[] = raw.affected.map((entry) => {
    if (typeof entry !== "object" || entry === null) throw proposalInvalid("impact.affected entries must be objects");
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.kind !== "string" || !isMemoryArtifactKind(candidate.kind)) {
      throw proposalInvalid("impact.affected kind must be a memory artifact kind");
    }
    if (typeof candidate.id !== "string" || candidate.id === "") {
      throw proposalInvalid("impact.affected id must be a non-empty string");
    }
    return { kind: candidate.kind as MemoryArtifactKind, id: candidate.id };
  });
  const notes: string[] = raw.notes.map((note) => {
    if (typeof note !== "string" || note.trim() === "") throw proposalInvalid("impact.notes must be non-empty strings");
    return note;
  });
  return { affected, notes };
}

/** Server-generated readable-but-opaque proposal id (never caller-supplied). */
export function isServerGeneratedProposalId(value: string): boolean {
  return value.startsWith("PROP-") && value.length > "PROP-".length;
}
