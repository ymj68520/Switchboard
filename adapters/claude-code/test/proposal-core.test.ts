import { describe, expect, it } from "vitest";

import type { MemoryRef } from "../src/core/memory-refs.js";
import { canonicalJson } from "../src/core/canonical-json.js";
import {
  parseNormalizedProposalChange,
  parseProposalDependencies,
  parseProposalScope,
  type RawProposalChange,
} from "../src/core/proposal.js";
import { buildProposalCanonical, canonicalProposalHash, parseProposalCanonical } from "../src/core/proposal-canonical.js";
import { canonicalDependencies, canonicalImpact, normalizeProposalChanges } from "../src/core/proposal-normalize.js";
import { simulateCandidateSnapshot } from "../src/core/proposal-simulate.js";
import { CONSTRAINT_1, DECISION_1 } from "./proposal-helpers.js";

const RUN = "plan_test-run";

function ref(kind: MemoryRef["kind"], id: string, revision: number): MemoryRef {
  return { runId: RUN, kind, id, revision };
}

const BASE: MemoryRef[] = [
  ref("constraint", "CONST-1", 1),
  ref("decision", "DEC-1", 1),
  ref("section", "SEC-1", 2),
];

describe("normalizeProposalChanges (§13/§14/§15)", () => {
  it("strips model authority: generates ids, derives revisions, binds section contracts", () => {
    const raw: RawProposalChange[] = [
      { op: "ADD_DECISION", content: DECISION_1, compactProjection: "DEC new" },
      { op: "SET_SECTION_REVISION", target: { id: "SEC-1", revision: 2 }, content: {
          title: "Store layer v2",
          objective: "Durable state",
          design: "SQLite WAL + tx",
          interfaces: ["PlanStore"],
          invariants: [],
          failureModes: [],
          dependencies: [],
          decisionRefs: [],
          openQuestionRefs: [],
          impactRefs: [],
          contract: { provides: ["API"], requires: [], invariants: [], interfaces: [], decisions: [] },
        }, compactProjection: "SEC-1 v2" },
    ];
    const { changes, candidateRefs } = normalizeProposalChanges({ runId: RUN, baseRefs: BASE, changes: raw });

    expect(changes[0]).toMatchObject({ op: "ADD_DECISION", artifactId: "DEC-2", result: { kind: "decision", id: "DEC-2", revision: 1 } });
    expect(changes[1]).toMatchObject({ op: "SET_SECTION_REVISION", artifactId: "SEC-1", target: { kind: "section", id: "SEC-1", revision: 2 }, result: { revision: 3 } });
    const sectionChange = changes[1] as Extract<(typeof changes)[number], { op: "SET_SECTION_REVISION" }>;
    expect(sectionChange.content.contract).toMatchObject({ sectionId: "SEC-1", revision: 3 });

    expect(candidateRefs).toEqual([
      ref("constraint", "CONST-1", 1),
      ref("decision", "DEC-1", 1),
      ref("decision", "DEC-2", 1),
      ref("section", "SEC-1", 3),
    ]);
  });

  it("derives supersedes from the target and rejects model-declared supersession", () => {
    const good = normalizeProposalChanges({
      runId: RUN,
      baseRefs: BASE,
      changes: [{ op: "SUPERSEDE_DECISION", target: { id: "DEC-1", revision: 1 }, content: DECISION_1, compactProjection: "DEC-1 v2" }],
    });
    const decision = good.changes[0] as Extract<(typeof good.changes)[number], { op: "SUPERSEDE_DECISION" }>;
    expect(decision.content.supersedes).toEqual(ref("decision", "DEC-1", 1));

    expect(() =>
      normalizeProposalChanges({
        runId: RUN,
        baseRefs: BASE,
        changes: [
          { op: "SUPERSEDE_DECISION", target: { id: "DEC-1", revision: 1 }, content: { ...DECISION_1, supersedes: ref("decision", "DEC-1", 1) }, compactProjection: "x" },
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: "PROPOSAL_INVALID" }));

    expect(() =>
      normalizeProposalChanges({
        runId: RUN,
        baseRefs: BASE,
        changes: [{ op: "ADD_DECISION", content: { ...DECISION_1, supersedes: ref("decision", "DEC-1", 1) }, compactProjection: "x" }],
      }),
    ).toThrowError(expect.objectContaining({ code: "PROPOSAL_INVALID" }));
  });

  it("rejects targets absent from the base snapshot (exact ref required)", () => {
    expect(() =>
      normalizeProposalChanges({
        runId: RUN,
        baseRefs: BASE,
        changes: [{ op: "SUPERSEDE_CONSTRAINT", target: { id: "CONST-1", revision: 3 }, content: CONSTRAINT_1, compactProjection: "x" }],
      }),
    ).toThrowError(expect.objectContaining({ code: "PROPOSAL_INVALID" }));
    expect(() =>
      normalizeProposalChanges({
        runId: RUN,
        baseRefs: BASE,
        changes: [{ op: "SET_ARCHITECTURE_REVISION", target: { id: "ARCH-1", revision: 1 }, content: {
            summary: "s", components: [], boundaries: [], dataFlows: [], principles: [], unresolvedQuestionRefs: [], decisionRefs: [],
          }, compactProjection: "x" }],
      }),
    ).toThrowError(expect.objectContaining({ code: "PROPOSAL_INVALID" }));
  });

  it("rejects two effective revisions of one artifact and premature architecture creation", () => {
    expect(() =>
      normalizeProposalChanges({
        runId: RUN,
        baseRefs: BASE,
        changes: [
          { op: "SUPERSEDE_DECISION", target: { id: "DEC-1", revision: 1 }, content: DECISION_1, compactProjection: "a" },
          { op: "SUPERSEDE_DECISION", target: { id: "DEC-1", revision: 1 }, content: DECISION_1, compactProjection: "b" },
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: "PROPOSAL_INVALID" }));

    expect(() =>
      normalizeProposalChanges({
        runId: RUN,
        baseRefs: [...BASE, ref("architecture", "ARCH-1", 1)],
        changes: [{ op: "SET_ARCHITECTURE_REVISION", target: null, content: {
            summary: "s", components: [], boundaries: [], dataFlows: [], principles: [], unresolvedQuestionRefs: [], decisionRefs: [],
          }, compactProjection: "x" }],
      }),
    ).toThrowError(expect.objectContaining({ code: "PROPOSAL_INVALID" }));
  });

  it("id generation continues after the base world (DEC-2 after DEC-1)", () => {
    const { changes } = normalizeProposalChanges({
      runId: RUN,
      baseRefs: BASE,
      changes: [
        { op: "ADD_DECISION", content: DECISION_1, compactProjection: "a" },
        { op: "ADD_CONSTRAINT", content: CONSTRAINT_1, compactProjection: "b" },
        { op: "ADD_OPEN_QUESTION", content: { question: "q?", blocking: false, scope: "architecture", status: "open" }, compactProjection: "c" },
        { op: "ADD_CONFLICT", content: { type: "t", refs: [], description: "d", severity: "soft", status: "open" }, compactProjection: "d" },
      ],
    });
    expect(changes.map((change) => change.artifactId)).toEqual(["DEC-2", "CONST-2", "Q-1", "CONF-1"]);
  });

  it("validates the candidate section DAG before freeze, stubbing unchanged base sections", () => {
    expect(() =>
      normalizeProposalChanges({
        runId: RUN,
        baseRefs: [ref("section", "SEC-9", 1)],
        changes: [{ op: "SET_SECTION_REVISION", target: null, content: {
            title: "t", objective: "o", design: "d", interfaces: [], invariants: [], failureModes: [],
            dependencies: ["SEC-NEVER"], decisionRefs: [], openQuestionRefs: [], impactRefs: [],
            contract: { provides: [], requires: [], invariants: [], interfaces: [], decisions: [] },
          }, compactProjection: "x" }],
      }),
    ).toThrowError(expect.objectContaining({ code: "SECTION_DAG_INVALID" }));

    // A dependency on an unchanged BASE section resolves through the stub.
    const ok = normalizeProposalChanges({
      runId: RUN,
      baseRefs: [ref("section", "SEC-BASE", 1)],
      changes: [{ op: "SET_SECTION_REVISION", target: null, content: {
          title: "t", objective: "o", design: "d", interfaces: [], invariants: [], failureModes: [],
          dependencies: ["SEC-BASE"], decisionRefs: [], openQuestionRefs: [], impactRefs: [],
          contract: { provides: [], requires: [], invariants: [], interfaces: [], decisions: [] },
        }, compactProjection: "x" }],
    });
    expect(ok.candidateRefs.map((r) => `${r.kind}:${r.id}@${r.revision}`)).toEqual(["section:SEC-1@1", "section:SEC-BASE@1"]);
  });
});

describe("simulateCandidateSnapshot (§17/§40 step 13)", () => {
  const frozen = normalizeProposalChanges({
    runId: RUN,
    baseRefs: BASE,
    changes: [
      { op: "ADD_DECISION", content: DECISION_1, compactProjection: "a" },
      { op: "SUPERSEDE_CONSTRAINT", target: { id: "CONST-1", revision: 1 }, content: CONSTRAINT_1, compactProjection: "b" },
    ],
  });

  it("re-derives identical candidate refs from the frozen changes", () => {
    const simulation = simulateCandidateSnapshot({ runId: RUN, baseRefs: BASE, changes: frozen.changes });
    expect(simulation.candidateRefs).toEqual(frozen.candidateRefs);
  });

  it("fails closed on a frozen change whose target is missing from the live base", () => {
    expect(() =>
      simulateCandidateSnapshot({ runId: RUN, baseRefs: [], changes: frozen.changes }),
    ).toThrowError(expect.objectContaining({ code: "PROPOSAL_INVALID" }));
  });

  it("fails closed on a hand-crafted result revision that breaks sequencing", () => {
    const tampered = frozen.changes.map((change) =>
      change.op === "SUPERSEDE_CONSTRAINT" ? { ...change, result: { ...change.result, revision: 7 } } : change,
    );
    expect(() =>
      simulateCandidateSnapshot({ runId: RUN, baseRefs: BASE, changes: tampered }),
    ).toThrowError(expect.objectContaining({ code: "PROPOSAL_INVALID" }));
  });
});

describe("proposal canonical representation and hash (§22/§23/§24)", () => {
  const changes = normalizeProposalChanges({
    runId: RUN,
    baseRefs: BASE,
    changes: [{ op: "ADD_DECISION", content: DECISION_1, compactProjection: "a" }],
  });

  function buildCanonical(overrides: Partial<Parameters<typeof buildProposalCanonical>[0]> = {}) {
    return buildProposalCanonical({
      runId: RUN,
      proposalId: "PROP-1",
      proposalRevision: 1,
      type: "design_checkpoint",
      scope: { kind: "architecture" },
      baseRunRevision: 2,
      baseHeadSnapshotId: null,
      baseHeadCommitId: null,
      title: "Checkpoint",
      summary: "summary",
      changes: changes.changes,
      dependencies: [],
      impact: { affected: [], notes: [] },
      ...overrides,
    });
  }

  it("same semantic object with different key insertion order → same hash (V2 incl. requiredEvidence)", () => {
    const a = buildCanonical();
    // Rebuild by parsing + re-stringifying through a different object order.
    const scrambled = JSON.parse(canonicalJson(a));
    const reordered = {
      requiredEvidence: scrambled.requiredEvidence,
      impact: scrambled.impact,
      changes: scrambled.changes,
      summary: scrambled.summary,
      title: scrambled.title,
      baseHeadCommitId: scrambled.baseHeadCommitId,
      baseHeadSnapshotId: scrambled.baseHeadSnapshotId,
      baseRunRevision: scrambled.baseRunRevision,
      scope: scrambled.scope,
      type: scrambled.type,
      proposalRevision: scrambled.proposalRevision,
      proposalId: scrambled.proposalId,
      runId: scrambled.runId,
      version: scrambled.version,
      schema: scrambled.schema,
      dependencies: scrambled.dependencies,
    };
    expect(canonicalProposalHash(reordered)).toBe(canonicalProposalHash(a));
  });

  it("semantically different proposals hash differently", () => {
    const base = canonicalProposalHash(buildCanonical());
    expect(canonicalProposalHash(buildCanonical({ title: "Renamed" }))).not.toBe(base);
    expect(canonicalProposalHash(buildCanonical({ proposalRevision: 2 }))).not.toBe(base);
    expect(canonicalProposalHash(buildCanonical({ baseHeadSnapshotId: "snap_x" }))).not.toBe(base);
    expect(
      canonicalProposalHash(buildCanonical({ dependencies: [{ kind: "decision", id: "DEC-1", revision: 1 }] })),
    ).not.toBe(base);
    expect(
      canonicalProposalHash(buildCanonical({ impact: { affected: [{ kind: "decision", id: "DEC-1" }], notes: [] } })),
    ).not.toBe(base);

    const otherChanges = normalizeProposalChanges({
      runId: RUN,
      baseRefs: BASE,
      changes: [{ op: "ADD_DECISION", content: { ...DECISION_1, title: "Different decision" }, compactProjection: "a" }],
    });
    expect(canonicalProposalHash(buildCanonical({ changes: otherChanges.changes }))).not.toBe(base);
  });

  it("canonical marker parse round-trips; V1 readable, foreign markers rejected (Phase 10 §31/§32)", () => {
    const canonical = buildCanonical();
    expect(parseProposalCanonical(JSON.parse(canonicalJson(canonical)))).toEqual(canonical);
    // V1 historical canonicals remain fully readable — never rehashed, never
    // given inferred evidence refs.
    const v1Parsed = JSON.parse(canonicalJson(canonical));
    const v1 = { ...v1Parsed, version: 1 } as Record<string, unknown>;
    delete v1.requiredEvidence;
    expect(() => parseProposalCanonical(v1)).not.toThrow();
    expect(parseProposalCanonical(v1).version).toBe(1);
    expect(() => parseProposalCanonical({ ...v1Parsed, version: 3 })).toThrowError(/marker/);
    expect(() =>
      parseProposalCanonical({ ...v1Parsed, version: 2, requiredEvidence: "not-an-array" }),
    ).toThrowError(/requiredEvidence/);
  });

  it("Phase 10 §62: requiredEvidence participates in the canonical hash", () => {
    const base = buildCanonical();
    const withRefs = buildCanonical({ requiredEvidence: [{ evidenceId: "ev_a", revision: 1 }] });
    expect(canonicalProposalHash(withRefs)).not.toBe(canonicalProposalHash(base));
    // Same set, different insertion order → same canonical hash.
    const reordered = buildCanonical({
      requiredEvidence: [
        { evidenceId: "ev_b", revision: 2 },
        { evidenceId: "ev_a", revision: 1 },
      ],
    });
    const sameSet = buildCanonical({
      requiredEvidence: [
        { evidenceId: "ev_a", revision: 1 },
        { evidenceId: "ev_b", revision: 2 },
      ],
    });
    expect(canonicalProposalHash(reordered)).toBe(canonicalProposalHash(sameSet));
    // Different exact revision → different hash.
    expect(
      canonicalProposalHash(buildCanonical({ requiredEvidence: [{ evidenceId: "ev_a", revision: 2 }] })),
    ).not.toBe(canonicalProposalHash(buildCanonical({ requiredEvidence: [{ evidenceId: "ev_a", revision: 1 }] })));
    // Different evidence id → different hash.
    expect(
      canonicalProposalHash(buildCanonical({ requiredEvidence: [{ evidenceId: "ev_z", revision: 1 }] })),
    ).not.toBe(canonicalProposalHash(buildCanonical({ requiredEvidence: [{ evidenceId: "ev_a", revision: 1 }] })));
  });

  it("hash format is sha256:<lowercase hex>", () => {
    expect(canonicalProposalHash(buildCanonical())).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("canonical sets and parsers", () => {
  it("dependencies dedupe and sort deterministically", () => {
    const deps = canonicalDependencies([ref("decision", "DEC-2", 1), ref("constraint", "CONST-1", 2), ref("decision", "DEC-2", 1)]);
    expect(deps).toEqual([
      { kind: "constraint", id: "CONST-1", revision: 2 },
      { kind: "decision", id: "DEC-2", revision: 1 },
    ]);
  });

  it("impact dedupes affected identities and keeps note order", () => {
    expect(canonicalImpact({ affected: [{ kind: "decision", id: "B" }, { kind: "decision", id: "A" }, { kind: "decision", id: "A" }], notes: ["n2", "n1"] })).toEqual({
      affected: [{ kind: "decision", id: "A" }, { kind: "decision", id: "B" }],
      notes: ["n2", "n1"],
    });
  });

  it("parsers validate scope, dependencies, and persisted changes", () => {
    expect(parseProposalScope({ kind: "architecture" })).toEqual({ kind: "architecture" });
    expect(parseProposalScope({ kind: "section", sectionId: "SEC-1" })).toEqual({ kind: "section", sectionId: "SEC-1" });
    expect(() => parseProposalScope({ kind: "architecture", extra: 1 })).toThrowError(expect.objectContaining({ code: "PROPOSAL_INVALID" }));
    expect(() => parseProposalScope({ kind: "blob" })).toThrowError(expect.objectContaining({ code: "PROPOSAL_INVALID" }));

    expect(parseProposalDependencies([{ kind: "decision", id: "DEC-1", revision: 1 }], RUN)).toEqual([ref("decision", "DEC-1", 1)]);
    // Malformed dependency shapes are rejected (dependencies persist runId-free;
    // the parser rebinds them to the owning run).
    expect(() => parseProposalDependencies([{ kind: "decision", id: "DEC-1" }], RUN)).toThrowError();
    expect(() => parseProposalDependencies([{ kind: "blob", id: "X", revision: 1 }], RUN)).toThrowError();

    const { changes } = normalizeProposalChanges({
      runId: RUN,
      baseRefs: BASE,
      changes: [{ op: "ADD_DECISION", content: DECISION_1, compactProjection: "a" }],
    });
    const reparsed = parseNormalizedProposalChange(JSON.parse(canonicalJson(changes[0])), RUN);
    expect(reparsed).toEqual(changes[0]);
    // Unknown ops and broken results are rejected on re-parse.
    expect(() => parseNormalizedProposalChange({ op: "WRITE_REVISION" }, RUN)).toThrowError(expect.objectContaining({ code: "PROPOSAL_INVALID" }));
    const broken = JSON.parse(canonicalJson(changes[0]));
    broken.result.revision = 9;
    expect(() => parseNormalizedProposalChange(broken, RUN)).toThrowError(expect.objectContaining({ code: "PROPOSAL_INVALID" }));
  });
});
