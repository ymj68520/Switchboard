/**
 * Server-side ProposalChange normalization (frozen plan Phase 6 §13–§15;
 * Phase 11 §27/§31/§40).
 *
 * Normalization is where model input loses every authority it must not have:
 * artifact ids are server-generated, result revisions are derived
 * (previous + 1), supersession targets are pinned to exact base-snapshot
 * refs, and section contracts are rebound to the derived revision. The
 * normalized output is what gets frozen into the proposal hash, so approval
 * always covers the exact revisions a commit will create — which, at freeze
 * time, DO NOT EXIST yet in committed memory.
 *
 * Phase 11: request-local Section aliases (§27) are resolved to
 * server-generated ids before validation, so dependencies may name an alias
 * of a Section the same request creates; aliases never persist. Workflow ops
 * (COMPLETE_SECTION / REOPEN_SECTION) are resolved to exact candidate
 * revisions and placed in the fixed per-Section order REOPEN → design
 * mutation → COMPLETE (§40) — the model's array order never changes
 * transaction semantics.
 *
 * Change array order is semantic (application order) for memory mutations.
 * Dependency and impact sets are deduplicated and deterministically sorted.
 */

import { parseMemoryRevisionContent } from "./memory-artifacts.js";
import { compareMemoryRefs, sortMemoryRefs, type MemoryArtifactKind, type MemoryRef } from "./memory-refs.js";
import {
  changeOpKind,
  isProposalChangeOp,
  proposalInvalid,
  type ArtifactIdentityRef,
  type ArtifactRef,
  type NormalizedProposalChange,
  type RawProposalChange,
  type RawSectionContent,
} from "./proposal.js";
import type { SectionDagEntry } from "./section-dag.js";
import { assertValidSectionDag } from "./section-dag.js";

/** Readable-but-opaque id prefixes per artifact kind (UX only; authority is
 * the server-generated uniqueness, never the readable prefix). */
const KIND_ID_PREFIXES: Readonly<Record<MemoryArtifactKind, string>> = {
  constraint: "CONST",
  decision: "DEC",
  architecture: "ARCH",
  section: "SEC",
  open_question: "Q",
  conflict: "CONF",
};

const CREATE_OPS = new Set<string>(["ADD_CONSTRAINT", "ADD_DECISION", "ADD_OPEN_QUESTION", "ADD_CONFLICT"]);

export interface NormalizedChanges {
  changes: NormalizedProposalChange[];
  /** Base world + every change result — one effective revision per artifact. */
  candidateRefs: MemoryRef[];
  /** Section dependency graph induced by the candidate world (§17). */
  sectionDag: SectionDagEntry[];
}

/**
 * Normalize raw model-facing changes against an exact base world (the refs
 * of the current HEAD snapshot). Throws PROPOSAL_INVALID for any input that
 * tries to reintroduce authority (self-chosen ids/revisions), references a
 * target absent from the base, or would leave two effective revisions of one
 * artifact in the candidate snapshot. Candidate section DAGs are validated
 * before the proposal can freeze.
 */
export function normalizeProposalChanges(input: {
  runId: string;
  baseRefs: MemoryRef[];
  changes: RawProposalChange[];
}): NormalizedChanges {
  const { runId, baseRefs } = input;
  if (!Array.isArray(input.changes)) {
    throw proposalInvalid("proposal changes must be an array");
  }

  const baseByKey = new Map<string, MemoryRef>();
  for (const ref of baseRefs) baseByKey.set(`${ref.kind}:${ref.id}:${ref.revision}`, ref);

  // ID generation is seeded from the base world so re-deriving over the SAME
  // base always yields identical ids.
  const idCounters = new Map<MemoryArtifactKind, number>();
  const takenIds = new Set<string>();
  for (const kind of Object.keys(KIND_ID_PREFIXES) as MemoryArtifactKind[]) {
    let max = 0;
    for (const ref of baseRefs) {
      if (ref.kind !== kind) continue;
      const match = /^([A-Z]+)-(\d+)$/.exec(ref.id);
      if (match && match[1] === KIND_ID_PREFIXES[kind]) max = Math.max(max, Number(match[2]));
    }
    idCounters.set(kind, max);
    for (let n = 1; n <= max; n += 1) takenIds.add(`${KIND_ID_PREFIXES[kind]}-${n}`);
  }

  const candidate = new Map<string, MemoryRef>();
  for (const ref of baseRefs) candidate.set(`${ref.kind}:${ref.id}`, ref);
  const mutatedIdentities = new Set<string>();
  const changes: NormalizedProposalChange[] = [];

  const generateId = (kind: MemoryArtifactKind, at: { changeIndex: number }): string => {
    const next = (idCounters.get(kind) ?? 0) + 1;
    idCounters.set(kind, next);
    const id = `${KIND_ID_PREFIXES[kind]}-${next}`;
    if (takenIds.has(id)) {
      throw proposalInvalid(`generated artifact id '${id}' collides with an existing id`, at);
    }
    takenIds.add(id);
    return id;
  };

  // Phase 11 §27 — request-local alias pre-pass. Every section CREATE that
  // declares a localRef gets its server id allocated FIRST so any change in
  // the same request may reference it, regardless of array order. Aliases
  // never persist: they exist only in this request and are resolved away
  // before the canonical proposal freezes.
  const aliasToId = new Map<string, string>();
  const preallocatedIds = new Map<number, string>();
  input.changes.forEach((change, index) => {
    if (change.op !== "SET_SECTION_REVISION" || change.target !== null) return;
    const localRef = (change as { localRef?: unknown }).localRef;
    if (localRef === undefined) return;
    const at = { changeIndex: index };
    if (typeof localRef !== "string" || localRef.trim() === "") {
      throw proposalInvalid(`change ${index} (SET_SECTION_REVISION) localRef must be a non-empty string`, at);
    }
    if (aliasToId.has(localRef)) {
      throw proposalInvalid(`change ${index}: duplicate request-local alias '${localRef}'`, at);
    }
    if (baseRefs.some((ref) => ref.kind === "section" && ref.id === localRef)) {
      throw proposalInvalid(`change ${index}: localRef '${localRef}' collides with an existing section id`, at);
    }
    if (takenIds.has(localRef)) {
      throw proposalInvalid(`change ${index}: localRef '${localRef}' collides with a generated section id`, at);
    }
    const id = generateId("section", at);
    aliasToId.set(localRef, id);
    preallocatedIds.set(index, id);
  });

  // §31/§40 — raw workflow facts are collected and resolved AFTER the memory
  // mutations, against the fully-resolved candidate world.
  interface PendingWorkflowOp {
    index: number;
    op: "COMPLETE_SECTION" | "REOPEN_SECTION";
    sectionId: string;
    compactProjection: string;
  }
  const pendingWorkflowOps: PendingWorkflowOp[] = [];

  const rewriteSectionDependencies = (raw: RawSectionContent): RawSectionContent => ({
    ...raw,
    dependencies: raw.dependencies.map((dependency) => aliasToId.get(dependency) ?? dependency),
  });

  input.changes.forEach((change, index) => {
    const at = { changeIndex: index };
    if (typeof change !== "object" || change === null || !isProposalChangeOp(change.op)) {
      throw proposalInvalid(`change ${index} has an unknown op`, at);
    }
    const op = change.op;
    const kind = changeOpKind(op);

    // Phase 11 §31/§40: workflow facts carry no content and no revisions of
    // their own — collected and resolved against the final candidate world.
    if (op === "COMPLETE_SECTION" || op === "REOPEN_SECTION") {
      const sectionId = change.sectionId;
      if (typeof sectionId !== "string" || sectionId.trim() === "") {
        throw proposalInvalid(`change ${index} (${op}) requires a non-empty sectionId`, at);
      }
      if (typeof change.compactProjection !== "string" || change.compactProjection.trim() === "") {
        throw proposalInvalid(`change ${index} (${op}) requires a non-empty compactProjection`, at);
      }
      pendingWorkflowOps.push({ index, op, sectionId, compactProjection: change.compactProjection });
      return;
    }

    if (typeof change.compactProjection !== "string" || change.compactProjection.trim() === "") {
      throw proposalInvalid(`change ${index} (${op}) requires a non-empty compactProjection`, at);
    }
    if (change.fullProjection !== undefined && (typeof change.fullProjection !== "string" || change.fullProjection.trim() === "")) {
      throw proposalInvalid(`change ${index} (${op}) fullProjection must be a non-empty string when present`, at);
    }

    const isCreate =
      CREATE_OPS.has(op) ||
      ((op === "SET_ARCHITECTURE_REVISION" || op === "SET_SECTION_REVISION") && change.target === null);

    if (isCreate) {
      const content = change.content as Record<string, unknown>;
      if (content !== null && typeof content === "object" && content.supersedes !== undefined) {
        throw proposalInvalid(`change ${index} (${op}): content must not declare supersedes; use the supersede op`, at);
      }
      if (op === "ADD_OPEN_QUESTION" && content !== null && typeof content === "object" && content.resolvedBy !== undefined) {
        throw proposalInvalid(`change ${index} (${op}): content must not declare resolvedBy; use the resolve op`, at);
      }
      if (op === "SET_ARCHITECTURE_REVISION") {
        for (const ref of baseRefs) {
          if (ref.kind === "architecture") {
            throw proposalInvalid("run already has an architecture identity; SET_ARCHITECTURE_REVISION must target it", at);
          }
        }
      }

      const artifactId = preallocatedIds.get(index) ?? generateId(kind, at);
      const identity = `${kind}:${artifactId}`;
      if (mutatedIdentities.has(identity)) {
        throw proposalInvalid(`two effective revisions of ${kind} '${artifactId}' in one proposal`, at);
      }
      mutatedIdentities.add(identity);
      const result: ArtifactRef = { kind, id: artifactId, revision: 1 };
      const contentValue: unknown =
        op === "SET_SECTION_REVISION"
          ? bindRawSectionContent(rewriteSectionDependencies(change.content as RawSectionContent), artifactId, 1)
          : change.content;
      // Validate with the exact committed-memory parser before freezing.
      parseMemoryRevisionContent(kind, contentValue, runId, artifactId, 1);
      changes.push({
        op,
        // Creates of SET_* carry the semantic target: null (frozen in JSON).
        ...(op === "SET_ARCHITECTURE_REVISION" || op === "SET_SECTION_REVISION" ? { target: null } : {}),
        artifactId,
        content: contentValue,
        result,
        compactProjection: change.compactProjection,
        ...(change.fullProjection !== undefined ? { fullProjection: change.fullProjection } : {}),
      } as NormalizedProposalChange);
      candidate.set(identity, { runId, kind, id: artifactId, revision: 1 });
      return;
    }

    // -- Mutations: exact base target, server-derived next revision ----------
    const rawTarget = (change as { target: { id: string; revision: number } | null }).target;
    if (rawTarget === null || typeof rawTarget !== "object" || !("id" in rawTarget)) {
      throw proposalInvalid(`change ${index} (${op}) requires an exact target from the base snapshot`, at);
    }
    const target = baseByKey.get(`${kind}:${rawTarget.id}:${rawTarget.revision}`);
    if (target === undefined) {
      throw proposalInvalid(
        `change target ${kind} '${rawTarget.id}@${String(rawTarget.revision)}' is not present in the base snapshot`,
        { ...at, target: { kind, id: rawTarget.id, revision: rawTarget.revision } },
      );
    }
    const identity = `${kind}:${target.id}`;
    if (mutatedIdentities.has(identity)) {
      throw proposalInvalid(
        `proposal changes would leave two effective revisions of ${kind} '${target.id}'; one change per artifact per proposal`,
        at,
      );
    }
    mutatedIdentities.add(identity);
    const result: ArtifactRef = { kind, id: target.id, revision: target.revision + 1 };
    const artifactId = target.id;

    let contentValue: unknown = change.content;
    if (op === "SET_SECTION_REVISION") {
      contentValue = bindRawSectionContent(rewriteSectionDependencies(change.content as RawSectionContent), artifactId, result.revision);
    } else if (op === "SUPERSEDE_DECISION") {
      const raw = { ...(change.content as unknown as Record<string, unknown>) };
      if (raw.supersedes !== undefined) {
        throw proposalInvalid(`change ${index} (${op}): content must not declare supersedes; the server derives it from the target`, at);
      }
      raw.supersedes = { runId, kind: "decision", id: target.id, revision: target.revision };
      contentValue = raw;
    } else if (op === "RESOLVE_OPEN_QUESTION") {
      const raw = { ...(change.content as unknown as Record<string, unknown>) } as Record<string, unknown>;
      if (raw.status !== "resolved") {
        throw proposalInvalid(`change ${index} (${op}) must carry status "resolved"`, at);
      }
      if (raw.resolvedBy !== undefined) {
        const resolvedBy = raw.resolvedBy as { id: unknown; revision: unknown };
        if (typeof resolvedBy !== "object" || resolvedBy === null || typeof resolvedBy.id !== "string") {
          throw proposalInvalid(`change ${index} (${op}) resolvedBy must pin a decision ref`, at);
        }
        raw.resolvedBy = { runId, kind: "decision", id: resolvedBy.id, revision: resolvedBy.revision };
      }
      contentValue = raw;
    }

    parseMemoryRevisionContent(kind, contentValue, runId, artifactId, result.revision);
    changes.push({
      op,
      target: { kind: target.kind, id: target.id, revision: target.revision },
      artifactId,
      content: contentValue,
      result,
      compactProjection: change.compactProjection,
      ...(change.fullProjection !== undefined ? { fullProjection: change.fullProjection } : {}),
    } as NormalizedProposalChange);
    candidate.set(identity, { runId, kind, id: artifactId, revision: result.revision });
  });

  // Phase 11 §31/§40 — resolve the collected workflow facts to exact
  // candidate revisions and fix their application order: groups ordered by
  // server section id, REOPEN before COMPLETE within a section. The model's
  // array order cannot change transaction semantics. REOPEN requires an
  // existing base Section (a completion claim cannot create identity);
  // COMPLETE requires the Section to exist in the candidate world.
  const reopenBound = new Set<string>();
  const completeBound = new Set<string>();
  const resolvedWorkflowOps: NormalizedProposalChange[] = [];
  for (const pending of pendingWorkflowOps) {
    const artifactId = aliasToId.get(pending.sectionId) ?? pending.sectionId;
    const identity = `section:${artifactId}`;
    const at = { changeIndex: pending.index };
    if (pending.op === "REOPEN_SECTION") {
      if (reopenBound.has(identity)) {
        throw proposalInvalid(`change ${pending.index}: at most one REOPEN_SECTION per section per proposal`, at);
      }
      const baseSection = baseRefs.find((ref) => ref.kind === "section" && ref.id === artifactId);
      if (baseSection === undefined) {
        throw proposalInvalid(
          `change ${pending.index}: REOPEN_SECTION target '${pending.sectionId}' is not a section in the base snapshot`,
          at,
        );
      }
      const final = candidate.get(identity);
      resolvedWorkflowOps.push({
        op: "REOPEN_SECTION",
        artifactId,
        target: { kind: "section", id: artifactId, revision: baseSection.revision },
        result: { kind: "section", id: artifactId, revision: final?.revision ?? baseSection.revision },
        compactProjection: pending.compactProjection,
      });
      reopenBound.add(identity);
    } else {
      if (completeBound.has(identity)) {
        throw proposalInvalid(`change ${pending.index}: at most one COMPLETE_SECTION per section per proposal`, at);
      }
      const final = candidate.get(identity);
      if (final === undefined) {
        throw proposalInvalid(
          `change ${pending.index}: COMPLETE_SECTION target '${pending.sectionId}' is not a section in the candidate snapshot`,
          at,
        );
      }
      resolvedWorkflowOps.push({
        op: "COMPLETE_SECTION",
        artifactId,
        target: { kind: "section", id: artifactId, revision: final.revision },
        result: { kind: "section", id: artifactId, revision: final.revision },
        compactProjection: pending.compactProjection,
      });
      completeBound.add(identity);
    }
  }
  resolvedWorkflowOps.sort((a, b) =>
    a.artifactId < b.artifactId ? -1 : a.artifactId > b.artifactId ? 1 : a.op === b.op ? 0 : a.op === "REOPEN_SECTION" ? -1 : 1,
  );

  const candidateRefs = sortMemoryRefs([...candidate.values()]);
  const sectionDag = candidateSectionDag(changes, baseRefs);
  assertValidSectionDag(sectionDag);

  return { changes: [...changes, ...resolvedWorkflowOps], candidateRefs, sectionDag };
}

/**
 * Section DAG entries for the candidate world: changed sections contribute
 * their real dependency edges; unchanged base sections contribute stub
 * entries (their own edges were validated when the base snapshot froze, and
 * stub nodes add ids without adding edges, so cycle detection stays exact).
 */
export function candidateSectionDag(changes: NormalizedProposalChange[], baseRefs: MemoryRef[]): SectionDagEntry[] {
  const entries: SectionDagEntry[] = [];
  const changedSectionIds = new Set<string>();
  for (const change of changes) {
    if (change.op === "SET_SECTION_REVISION") {
      changedSectionIds.add(change.artifactId);
      entries.push({ sectionId: change.artifactId, dependencies: [...change.content.dependencies] });
    }
  }
  for (const ref of baseRefs) {
    if (ref.kind === "section" && !changedSectionIds.has(ref.id)) {
      entries.push({ sectionId: ref.id, dependencies: [] });
    }
  }
  return entries;
}

/**
 * Bind a raw section content to its concrete identity: the contract gets the
 * server-derived sectionId/revision; everything else passes through for
 * validation by the committed-memory section parser.
 */
function bindRawSectionContent(raw: RawSectionContent, sectionId: string, revision: number): Record<string, unknown> {
  if (raw === null || typeof raw !== "object") throw proposalInvalid("section content must be an object");
  const contract = raw.contract ?? {
    provides: [],
    requires: [],
    invariants: [],
    interfaces: [],
    decisions: [],
  };
  return {
    title: raw.title,
    objective: raw.objective,
    design: raw.design,
    interfaces: raw.interfaces,
    invariants: raw.invariants,
    failureModes: raw.failureModes,
    dependencies: raw.dependencies,
    decisionRefs: raw.decisionRefs,
    openQuestionRefs: raw.openQuestionRefs,
    impactRefs: raw.impactRefs,
    contract: {
      sectionId,
      revision,
      provides: contract.provides,
      requires: contract.requires,
      invariants: contract.invariants,
      interfaces: contract.interfaces,
      decisions: contract.decisions,
    },
  };
}

/**
 * Canonical (deduplicated, deterministic) dependency list for freezing.
 * Existence at the exact base revision is checked by the caller (§20).
 */
export function canonicalDependencies(refs: MemoryRef[]): ArtifactRef[] {
  const seen = new Map<string, ArtifactRef>();
  for (const ref of refs) {
    seen.set(`${ref.kind}:${ref.id}:${ref.revision}`, { kind: ref.kind, id: ref.id, revision: ref.revision });
  }
  return [...seen.values()].sort((a, b) => compareMemoryRefs({ runId: "", ...a }, { runId: "", ...b }));
}

/** Canonical impact: dedupe affected identities, keep note order. */
export function canonicalImpact(input: { affected?: ArtifactIdentityRef[]; notes?: string[] } | undefined): {
  affected: ArtifactIdentityRef[];
  notes: string[];
} {
  const seen = new Set<string>();
  const affected: ArtifactIdentityRef[] = [];
  for (const entry of input?.affected ?? []) {
    const key = `${entry.kind}:${entry.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    affected.push({ kind: entry.kind, id: entry.id });
  }
  affected.sort((a, b) => (a.kind === b.kind ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.kind < b.kind ? -1 : 1));
  return { affected, notes: [...(input?.notes ?? [])] };
}
