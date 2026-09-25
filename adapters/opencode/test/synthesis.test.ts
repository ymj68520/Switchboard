/**
 * Phase 2F — Frozen Synthesis Input & Provenance-bound Synthesis Manifest.
 *
 * Covers the real Synthesis workflow: HEAD-anchored SynthesisInput freezing
 * (deterministic entry gates, exact-ref authority sets, canonical hash with
 * golden coverage, idempotent re-freeze), provenance-bound manifest drafts
 * (structural validation, cross-section rule, implementation-order coverage
 * and Section-DAG ordering, findings), immutable manifest revisions with
 * exact-resubmission idempotency, plan_memory reads for derived artifacts,
 * status/L0 rendering, the normative boundary (no PlanCommit/HEAD movement,
 * no authority fields, request_synthesis still withheld), and the durable
 * restart/corruption/concurrency behavior of the derived-artifact store.
 */
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DurablePlanStore,
  InMemoryPlanStore,
  computeProposalHash,
  computeSynthesisInputHash,
  computeSynthesisManifestHash,
  isUltraPlanError,
  renderPlanningProtocol,
  renderSynthesisCapsule,
  sourceRefResolves,
  validateManifestDraft,
} from "../src/index.js";
import type {
  FrozenSectionState,
  PlanCommit,
  PlanningRun,
  Proposal,
  Section,
  SectionCheckpointInput,
  SynthesisInput,
  SynthesisInputPayload,
  SynthesisManifestDraft,
  SynthesisManifestDraftInput,
  SynthesisSourceRefInput,
} from "../src/index.js";
import { UltraPlanController } from "../src/core/controller.js";
import { admittedStart } from "./helpers.js";

const FIXED = "2026-09-25T12:00:00.000Z";
const GOAL = "Build the durable planning harness";

function makeWorld(store?: InMemoryPlanStore) {
  const planStore = store ?? new InMemoryPlanStore(() => FIXED);
  const controller = new UltraPlanController({ store: planStore, now: () => FIXED });
  return { store: planStore, controller };
}

const ARCH_CHANGE = {
  kind: "add_architecture" as const,
  content: {
    architecture: {
      summary: "Completion target",
      components: [{ name: "Core", summary: "kernel" }],
      boundaries: [],
      dataFlows: [],
      principles: [],
    },
  },
};

/** Chain DAG (canonical order SEC-001 → SEC-002 → SEC-003, initial focus SEC-001). */
const CHAIN_DECOMPOSITION = {
  sections: [
    { key: "runtime", title: "Runtime Integration", objective: "bind to the OpenCode host" },
    { key: "plan-memory", title: "Plan Memory", objective: "durable authoritative state", dependsOn: ["runtime"] },
    { key: "context", title: "Context Assembly", objective: "deterministic model context", dependsOn: ["plan-memory"] },
  ],
  initialSection: "runtime",
};

function checkpointInput(sectionID: "SEC-001" | "SEC-002" | "SEC-003", overrides: Partial<SectionCheckpointInput> = {}): SectionCheckpointInput {
  const depID = sectionID === "SEC-001" ? undefined : sectionID === "SEC-002" ? "SEC-001" : "SEC-002";
  return {
    problem: `Problem ${sectionID}`,
    design: `Design ${sectionID}`,
    interfaces: [{ name: `I${sectionID}`, description: "boundary" }],
    invariants: ["invariant one"],
    failureModes: [],
    dependencies: depID ? [{ sectionID: depID as never, consumes: [] }] : [],
    decisions: [],
    openQuestions: [],
    impacts: [],
    projection: {
      compact: `compact ${sectionID}`,
      contract: {
        provides: [`${sectionID.toLowerCase()}-capability`],
        requires: [],
        invariants: ["invariant one"],
        interfaces: [{ name: `I${sectionID}` }],
        decisions: [],
      },
    },
    ...overrides,
  };
}

async function dagWorld(world: ReturnType<typeof makeWorld> = makeWorld(), sessionID = "ses_syn") {
  let run = (await admittedStart(world.controller, sessionID, GOAL)).run;
  await world.controller.requestArchitecture(sessionID);
  const completion = await world.controller.prepareProposal(sessionID, {
    type: "architecture_completion",
    scope: { type: "architecture" },
    title: "Complete architecture",
    summary: "s",
    changes: [ARCH_CHANGE, { kind: "complete_architecture" }] as never,
  });
  const begun = await world.controller.beginProposalApproval(sessionID, completion.proposal.id);
  await world.controller.recordApprovalAndCommit(sessionID, completion.proposal.id, begun.request);
  const decomposition = await world.controller.prepareSectionDecomposition(sessionID, CHAIN_DECOMPOSITION);
  const dagBegun = await world.controller.beginProposalApproval(sessionID, decomposition.proposal.id);
  await world.controller.recordApprovalAndCommit(sessionID, decomposition.proposal.id, dagBegun.request);
  run = (await world.store.getRun(run.id)) as PlanningRun;
  expect(run.stage).toBe("detail");
  return world;
}

async function checkpointActive(world: ReturnType<typeof makeWorld>, sessionID: string): Promise<void> {
  const run = (await world.store.findActiveRunBySession(sessionID)) as PlanningRun;
  const active = run.activeWork?.type === "section" ? run.activeWork.id : undefined;
  if (!active) throw new Error("no active section");
  const prepared = await world.controller.prepareSectionCheckpoint(sessionID, checkpointInput(active as "SEC-001"));
  const begun = await world.controller.beginProposalApproval(sessionID, prepared.proposal.id);
  await world.controller.recordApprovalAndCommit(sessionID, prepared.proposal.id, begun.request);
}

async function checkpointAndComplete(world: ReturnType<typeof makeWorld>, sessionID: string): Promise<PlanCommit> {
  await checkpointActive(world, sessionID);
  const prepared = await world.controller.requestCompletion(sessionID, { kind: "section" });
  const begun = await world.controller.beginProposalApproval(sessionID, prepared.proposal.id);
  return (await world.controller.recordApprovalAndCommit(sessionID, prepared.proposal.id, begun.request)).commit;
}

/** Detail world driven through the REAL full completion cycles into synthesis. */
async function synWorld(world: ReturnType<typeof makeWorld> = makeWorld(), sessionID = "ses_syn") {
  await dagWorld(world, sessionID);
  await checkpointAndComplete(world, sessionID);
  await checkpointAndComplete(world, sessionID);
  await checkpointAndComplete(world, sessionID);
  const run = (await world.store.findActiveRunBySession(sessionID)) as PlanningRun;
  expect(run.stage).toBe("synthesis");
  expect(run.activeWork).toBeUndefined();
  return { ...world, run };
}

/** A provenance-bound manifest draft over the chain input (2 links, 1 full-coverage step order). */
function manifestDraft(): SynthesisManifestDraftInput {
  return {
    crossSectionLinks: [
      {
        statement: "SEC-001 provides isec-001-capability consumed by SEC-002",
        sources: [
          { kind: "section", id: "SEC-001", revision: 1 },
          { kind: "section", id: "SEC-002", revision: 1 },
        ],
      },
    ],
    implementationOrder: [
      {
        title: "Deliver the runtime",
        description: "Implement the three approved sections in dependency order as one delivery wave.",
        sections: [
          { id: "SEC-001", revision: 1 },
          { id: "SEC-002", revision: 1 },
          { id: "SEC-003", revision: 1 },
        ],
        sources: [{ kind: "architecture" }, { kind: "section", id: "SEC-001", revision: 1 }],
      },
    ],
    limitations: [
      {
        statement: "The approved design leaves repository freshness to the Evidence Audit.",
        sources: [{ kind: "architecture" }],
      },
    ],
    unresolvedFindings: [],
  };
}

/** Move HEAD with a hostile-but-legal direct engine commit (amendment type). */
async function moveHeadWithHostileCommit(world: { store: InMemoryPlanStore }, sessionID: string): Promise<PlanCommit> {
  const run = (await world.store.findActiveRunBySession(sessionID)) as PlanningRun;
  const proposal: Proposal = {
    id: `PROP-H${(await world.store.listProposals(run.id)).length + 1}` as never,
    type: "amendment",
    scope: { id: "ARCH", revision: 1 },
    revision: 1,
    status: "awaiting_approval",
    title: "Hostile amendment",
    summary: "moves HEAD",
    changes: [
      {
        kind: "add_decision",
        decision: {
          id: `DEC-H${(await world.store.listDecisions(run.id)).length + 1}` as never,
          revision: 1,
          status: "approved",
          approvedAt: FIXED,
          title: "Hostile",
          statement: "hostile decision",
          rationale: "r",
          scope: {},
        },
      },
    ] as never,
    dependencies: [],
    impact: { affectedSections: [], affectedDecisions: [] },
    createdFrom: { id: run.headSnapshot as never },
  };
  const frozen: Proposal = { ...proposal, hash: computeProposalHash(proposal) };
  await world.store.saveProposal(run.id, frozen);
  const approval = await world.store.saveApproval(run.id, {
    id: `APPR-H${(await world.store.listApprovals(run.id)).length + 1}` as never,
    proposalID: frozen.id,
    proposalRevision: 1,
    proposalHash: frozen.hash as string,
    actor: "user",
    createdAt: FIXED,
  });
  return world.store.commitTransaction({ planID: run.id, proposalID: frozen.id, approvalID: approval.id });
}

// -----------------------------------------------------------------------------
// Golden hashes (brief §16/§38)
// -----------------------------------------------------------------------------

const GOLDEN_INPUT_PAYLOAD: SynthesisInputPayload = {
  planID: "PLAN-001" as never,
  baseSnapshot: { id: "SNAP-009" as never },
  baseCommit: "COMMIT-008" as never,
  architecture: { id: "ARCH", revision: 1 },
  sections: [{ ref: { id: "SEC-001" as never, revision: 1 }, title: "Runtime Integration", dependencies: [] }],
  decisions: [{ id: "DEC-001" as never, revision: 1 }],
  constraints: [],
  questions: [],
  conflicts: [],
  evidence: [],
};

const GOLDEN_MANIFEST_DRAFT: SynthesisManifestDraft = {
  inputID: "SYN-IN-001" as never,
  crossSectionLinks: [
    {
      statement: "SEC-001 provides ISEC-001 consumed by SEC-002",
      sources: [
        { kind: "section", id: "SEC-001" as never, revision: 1 },
        { kind: "section", id: "SEC-002" as never, revision: 1 },
      ],
    },
  ],
  implementationOrder: [
    {
      title: "Deliver the runtime",
      description: "step",
      sections: [{ id: "SEC-001" as never, revision: 1 }],
      sources: [{ kind: "architecture" }],
    },
  ],
  limitations: [],
  unresolvedFindings: [],
};

const GOLDEN_MANIFEST_RESOLVED = {
  baseSnapshot: { id: "SNAP-009" as never },
  inputHash: "deadbeef",
  architecture: { id: "ARCH" as const, revision: 1 },
  sections: GOLDEN_INPUT_PAYLOAD.sections,
};

describe("synthesis input hash (brief §16)", () => {
  it("golden hash: the canonical input payload hashes to the pinned digest", () => {
    expect(computeSynthesisInputHash(GOLDEN_INPUT_PAYLOAD)).toBe(
      "eae9176e5755bb249a9e36adc09bb695e400d6b5c55e44088cc934be52091042",
    );
  });

  it("changing any authority field changes the hash; id/createdAt are not part of the payload", () => {
    const base = computeSynthesisInputHash(GOLDEN_INPUT_PAYLOAD);
    const goldenSection: FrozenSectionState =
      GOLDEN_INPUT_PAYLOAD.sections[0] ??
      { ref: { id: "SEC-001" as never, revision: 1 }, title: "Runtime Integration", dependencies: [] };
    const mutations: [string, SynthesisInputPayload][] = [
      ["baseSnapshot", { ...GOLDEN_INPUT_PAYLOAD, baseSnapshot: { id: "SNAP-010" as never } }],
      ["baseCommit", { ...GOLDEN_INPUT_PAYLOAD, baseCommit: null }],
      ["architecture", { ...GOLDEN_INPUT_PAYLOAD, architecture: { id: "ARCH", revision: 2 } }],
      [
        "section revision set",
        { ...GOLDEN_INPUT_PAYLOAD, sections: [{ ...goldenSection, ref: { id: "SEC-001" as never, revision: 2 } }] },
      ],
      [
        "section order",
        {
          ...GOLDEN_INPUT_PAYLOAD,
          sections: [
            goldenSection,
            { ref: { id: "SEC-002" as never, revision: 1 }, title: "Plan Memory", dependencies: ["SEC-001" as never] },
          ],
        },
      ],
      ["decisions", { ...GOLDEN_INPUT_PAYLOAD, decisions: [] }],
      ["constraints", { ...GOLDEN_INPUT_PAYLOAD, constraints: [{ id: "CON-001" as never, source: "user" as const, statement: "s", severity: "hard" as const, status: "active" as const }] }],
      ["questions", { ...GOLDEN_INPUT_PAYLOAD, questions: [{ id: "Q-001" as never, question: "q", blocking: true, status: "open" as const }] }],
      ["conflicts", { ...GOLDEN_INPUT_PAYLOAD, conflicts: [{ id: "CONF-001" as never, type: "section" as const, description: "d", severity: "blocking" as const, status: "open" as const }] }],
      ["evidence", { ...GOLDEN_INPUT_PAYLOAD, evidence: [{ id: "EVD-001" as never, revision: 1, confidence: "direct" as const, criticality: "critical" as const, freshness: "fresh" as const, status: "active" as const }] }],
    ];
    for (const [what, mutated] of mutations) {
      expect(computeSynthesisInputHash(mutated), what).not.toBe(base);
    }
  });

  it("golden hash: the manifest content payload hashes to the pinned digest", () => {
    expect(computeSynthesisManifestHash(GOLDEN_MANIFEST_DRAFT, GOLDEN_MANIFEST_RESOLVED)).toBe(
      "6cf58984c6dcc19c8c2a15661f26df3b915a3fe5d5c9ed91646580e772b2d039",
    );
  });

  it("changing any derived content field changes the manifest hash (brief §38)", () => {
    const base = computeSynthesisManifestHash(GOLDEN_MANIFEST_DRAFT, GOLDEN_MANIFEST_RESOLVED);
    const goldenLink =
      GOLDEN_MANIFEST_DRAFT.crossSectionLinks[0] ??
      { statement: "s", sources: [{ kind: "section" as const, id: "SEC-001" as never, revision: 1 }] };
    const goldenStep =
      GOLDEN_MANIFEST_DRAFT.implementationOrder[0] ??
      { title: "t", description: "d", sections: [{ id: "SEC-001" as never, revision: 1 }], sources: [{ kind: "architecture" as const }] };
    const linkSourceSwapped = {
      ...GOLDEN_MANIFEST_DRAFT,
      crossSectionLinks: [
        {
          statement: goldenLink.statement,
          sources: [...goldenLink.sources].reverse(),
        },
      ],
    };
    const stepOrderSwapped = {
      ...GOLDEN_MANIFEST_DRAFT,
      implementationOrder: [
        {
          ...goldenStep,
          title: "Renamed step",
        },
      ],
    };
    const limitationAdded = {
      ...GOLDEN_MANIFEST_DRAFT,
      limitations: [{ statement: "l", sources: [{ kind: "architecture" as const }] }],
    };
    const findingAdded = {
      ...GOLDEN_MANIFEST_DRAFT,
      unresolvedFindings: [{ category: "coverage_gap" as const, statement: "f" }],
    };
    expect(computeSynthesisManifestHash(linkSourceSwapped, GOLDEN_MANIFEST_RESOLVED)).not.toBe(base);
    expect(computeSynthesisManifestHash(stepOrderSwapped, GOLDEN_MANIFEST_RESOLVED)).not.toBe(base);
    expect(computeSynthesisManifestHash(limitationAdded, GOLDEN_MANIFEST_RESOLVED)).not.toBe(base);
    expect(computeSynthesisManifestHash(findingAdded, GOLDEN_MANIFEST_RESOLVED)).not.toBe(base);
  });
});

// -----------------------------------------------------------------------------
// Input freezing (brief §7/§8/§9/§14/§15/§17/§20)
// -----------------------------------------------------------------------------

describe("begin synthesis (input freezing)", () => {
  it("freezes the exact HEAD-anchored input: approved architecture, canonical exact Section revisions, and derived provenance-only shape (brief §7/§9/§62)", async () => {
    const world = await synWorld();
    const { input } = await world.controller.beginSynthesis("ses_syn");
    expect(input.id).toBe("SYN-IN-001");
    expect(input.baseSnapshot.id).toBe((await world.store.getRun("PLAN-001" as never))?.headSnapshot);
    expect(input.baseCommit).toBe((await world.store.getRun("PLAN-001" as never))?.headCommit);
    expect(input.architecture).toEqual({ id: "ARCH", revision: 1 });
    // Canonical order = the approved DAG order; exact revisions, never "latest".
    expect(input.sections.map((section) => section.ref)).toEqual([
      { id: "SEC-001", revision: 1 },
      { id: "SEC-002", revision: 1 },
      { id: "SEC-003", revision: 1 },
    ]);
    expect(input.sections.map((section) => section.dependencies)).toEqual([[], ["SEC-001"], ["SEC-002"]]);
    // Derived-artifact authority shape: no stage/HEAD fields, no approval state.
    expect(Object.keys(input).sort()).toEqual(
      [
        "architecture",
        "baseCommit",
        "baseSnapshot",
        "conflicts",
        "constraints",
        "createdAt",
        "decisions",
        "evidence",
        "hash",
        "id",
        "planID",
        "questions",
        "sections",
      ].sort(),
    );
  });

  it("is gated to the synthesis stage — detail/architecture runs refuse with capability_not_available", async () => {
    const world = await dagWorld();
    await expect(world.controller.beginSynthesis("ses_syn")).rejects.toSatisfy(
      (e: unknown) => isUltraPlanError(e) && e.code === "capability_not_available",
    );
  });

  it("a synthesis run that still carries a workflow focus fails the entry gate closed (brief §8)", async () => {
    const world = await synWorld();
    world.store.seedCommittedState("PLAN-001" as never, {
      activeWork: { type: "section", id: "SEC-001" as never },
    });
    await expect(world.controller.beginSynthesis("ses_syn")).rejects.toSatisfy(
      (e: unknown) => isUltraPlanError(e) && e.code === "synthesis_entry_invalid",
    );
  });

  it("a seeded invalid Section fails the entry gate closed (brief §8)", async () => {
    const world = await synWorld();
    const sections = await world.store.listSections("PLAN-001" as never);
    const sec1 = sections.find((s) => s.id === "SEC-001") as Section;
    world.store.seedCommittedState("PLAN-001" as never, { sections: [{ ...sec1, validation: "needs_review" }] });
    await expect(world.controller.beginSynthesis("ses_syn")).rejects.toSatisfy(
      (e: unknown) => isUltraPlanError(e) && e.code === "synthesis_entry_invalid",
    );
  });

  it("a repeated freeze at the same authoritative state returns the SAME input (brief §17)", async () => {
    const world = await synWorld();
    const first = await world.controller.beginSynthesis("ses_syn");
    const second = await world.controller.beginSynthesis("ses_syn");
    expect(second.input.id).toBe(first.input.id);
    expect(second.input.hash).toBe(first.input.hash);
    expect(second.capsule).toBe(first.capsule);
    expect(await world.store.listSynthesisInputs("PLAN-001" as never)).toHaveLength(1);
  });

  it("freezes the OPEN blocker state and reachable evidence (brief §14/§15/§52)", async () => {
    const world = await dagWorld();
    // Blockers and evidence committed/raised during DETAIL (synthesis grants
    // no prepare_proposal), then the run completes into synthesis.
    await world.controller.recordQuestion("ses_syn", {
      question: "Which lock primitive?",
      blocking: true,
      scope: { type: "architecture" },
    });
    await world.store.putEvidence("PLAN-001" as never, {
      id: "EVD-001" as never,
      revision: 1,
      kind: "file",
      claim: "the store uses atomic rename",
      source: [{ type: "file", path: "src/store.ts" }],
      scope: { kind: "run" },
      confidence: "uncertain",
      criticality: "supporting",
      freshness: "needs_validation",
      status: "active",
      discoveredAt: FIXED,
      lastValidatedAt: FIXED,
    });
    const decisionPrepared = await world.controller.prepareProposal("ses_syn", {
      type: "amendment",
      scope: { type: "architecture" },
      title: "Decision",
      summary: "s",
      changes: [
        {
          kind: "add_decision",
          content: {
            decision: {
              title: "Storage shape",
              statement: "append-only",
              rationale: "durable",
              evidence: [{ id: "EVD-001" }],
            },
          },
        },
      ] as never,
    });
    const decisionBegun = await world.controller.beginProposalApproval("ses_syn", decisionPrepared.proposal.id);
    await world.controller.recordApprovalAndCommit("ses_syn", decisionPrepared.proposal.id, decisionBegun.request);
    await world.controller.raiseConflict("ses_syn", {
      type: "section",
      refs: [{ kind: "section", id: "SEC-003" }],
      description: "SEC-003 vs SEC-001 naming",
      severity: "warning",
    });
    await checkpointAndComplete(world, "ses_syn");
    await checkpointAndComplete(world, "ses_syn");
    await checkpointAndComplete(world, "ses_syn");

    const { input } = await world.controller.beginSynthesis("ses_syn");
    expect(input.questions).toEqual([{ id: "Q-001", question: "Which lock primitive?", blocking: true, status: "open" }]);
    expect(input.conflicts).toHaveLength(1);
    expect(input.conflicts[0]).toMatchObject({ id: "CONF-001", severity: "warning", status: "open" });
    // Evidence captured along the SectionRevision → Decision → Evidence chain.
    expect(input.evidence).toEqual([
      { id: "EVD-001", revision: 1, confidence: "uncertain", criticality: "supporting", freshness: "needs_validation", status: "active" },
    ]);
    expect(input.decisions).toEqual([{ id: "DEC-001", revision: 1 }]);
  });

  it("the frozen evidence record is NOT mutated when live evidence later changes (brief §52)", async () => {
    const world = await dagWorld();
    await world.store.putEvidence("PLAN-001" as never, {
      id: "EVD-002" as never,
      revision: 1,
      kind: "file",
      claim: "claim v1",
      source: [{ type: "file", path: "src/store.ts" }],
      scope: { kind: "run" },
      confidence: "direct",
      criticality: "supporting",
      freshness: "fresh",
      status: "active",
      discoveredAt: FIXED,
      lastValidatedAt: FIXED,
    });
    const decisionPrepared = await world.controller.prepareProposal("ses_syn", {
      type: "amendment",
      scope: { type: "architecture" },
      title: "Decision",
      summary: "s",
      changes: [
        {
          kind: "add_decision",
          content: { decision: { title: "t", statement: "s", rationale: "r", evidence: [{ id: "EVD-002" }] } },
        },
      ] as never,
    });
    const decisionBegun = await world.controller.beginProposalApproval("ses_syn", decisionPrepared.proposal.id);
    await world.controller.recordApprovalAndCommit("ses_syn", decisionPrepared.proposal.id, decisionBegun.request);
    await checkpointAndComplete(world, "ses_syn");
    await checkpointAndComplete(world, "ses_syn");
    await checkpointAndComplete(world, "ses_syn");
    const { input } = await world.controller.beginSynthesis("ses_syn");
    expect(input.evidence).toEqual([
      { id: "EVD-002", revision: 1, confidence: "direct", criticality: "supporting", freshness: "fresh", status: "active" },
    ]);
    // Later live change: a new immutable revision supersedes freshness — the
    // frozen input record stays exactly as it was at freeze time.
    await world.store.putEvidence("PLAN-001" as never, {
      id: "EVD-002" as never,
      revision: 2,
      kind: "file",
      claim: "claim v1",
      source: [{ type: "file", path: "src/store.ts" }],
      scope: { kind: "run" },
      confidence: "direct",
      criticality: "supporting",
      freshness: "stale",
      status: "stale",
      discoveredAt: FIXED,
      lastValidatedAt: FIXED,
    });
    expect(input.evidence[0]).toEqual({
      id: "EVD-002",
      revision: 1,
      confidence: "direct",
      criticality: "supporting",
      freshness: "fresh",
      status: "active",
    });
  });

  it("returns a deterministic synthesis capsule with stable projections and exact refs (brief §21)", async () => {
    const world = await synWorld();
    const { input, capsule } = await world.controller.beginSynthesis("ses_syn");
    expect(capsule).toContain(`Synthesis Input: ${input.id}`);
    expect(capsule).toContain(`Base: ${input.baseSnapshot.id}`);
    expect(capsule).toContain(`Hash: ${input.hash}`);
    expect(capsule).toContain("Architecture: ARCH@1 approved");
    expect(capsule).toContain("SEC-001@1 — Runtime Integration");
    expect(capsule).toContain("Compact: compact SEC-001");
    expect(capsule).toContain("Contract provides: sec-001-capability");
    expect(capsule).toContain("SEC-003@1 — Context Assembly");
    // Byte-stable for identical state; never regenerated by an inference.
    expect(await renderSynthesisCapsule(world.store, input)).toBe(capsule);
  });
});

/** A fresh full-coverage implementation step (canonical order, architecture provenance). */
function manifestStep(): {
  title: string;
  description: string;
  sections: { id: string; revision: number }[];
  sources: SynthesisSourceRefInput[];
} {
  return {
    title: "Deliver the runtime",
    description: "Implement the three approved sections in dependency order as one delivery wave.",
    sections: [
      { id: "SEC-001", revision: 1 },
      { id: "SEC-002", revision: 1 },
      { id: "SEC-003", revision: 1 },
    ],
    sources: [{ kind: "architecture" }, { kind: "section", id: "SEC-001", revision: 1 }],
  };
}

// -----------------------------------------------------------------------------
// Manifest submission (brief §24-§37, §59, §60)
// -----------------------------------------------------------------------------

describe("submit synthesis manifest", () => {
  it("refuses when no SynthesisInput is frozen (brief §33): the capability is not granted in the no-input substate", async () => {
    const world = await synWorld();
    // Tool path: submit is not granted in the no-input substate at all.
    await expect(world.controller.submitSynthesisManifest("ses_syn", manifestDraft())).rejects.toSatisfy(
      (e: unknown) => isUltraPlanError(e) && e.code === "capability_not_available",
    );
    // Direct store path (hostile/defense): a draft bound to a missing input fails closed.
    await expect(
      world.store.saveSynthesisManifest("PLAN-001" as never, { ...manifestDraft(), inputID: "SYN-IN-999" } as never),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "unknown_reference");
  });

  it("saves a structurally valid manifest with Harness-assigned identity, step order, and copied input binding (brief §22/§24/§27)", async () => {
    const world = await synWorld();
    const { input } = await world.controller.beginSynthesis("ses_syn");
    const { manifest, idempotent } = await world.controller.submitSynthesisManifest("ses_syn", manifestDraft());
    expect(idempotent).toBe(false);
    expect(manifest.id).toBe("SYN-001");
    expect(manifest.revision).toBe(1);
    expect(manifest.input).toEqual({ id: input.id });
    expect(manifest.inputHash).toBe(input.hash);
    expect(manifest.baseSnapshot).toEqual(input.baseSnapshot);
    expect(manifest.architecture).toEqual(input.architecture);
    expect(manifest.sections).toEqual(input.sections);
    expect(manifest.implementationOrder.map((step) => step.order)).toEqual([1]);
    // No authority fields exist on the shape (brief §35).
    expect(Object.keys(manifest).sort()).toEqual(
      [
        "architecture",
        "baseSnapshot",
        "createdAt",
        "crossSectionLinks",
        "hash",
        "id",
        "implementationOrder",
        "input",
        "inputHash",
        "limitations",
        "revision",
        "sections",
        "unresolvedFindings",
      ].sort(),
    );
  });

  it("provenance (§59): zero sources, outside-input sources, and historical non-input revisions all fail closed", async () => {
    const world = await synWorld();
    await world.controller.beginSynthesis("ses_syn");

    // Zero sources.
    const zeroSources = manifestDraft();
    zeroSources.limitations = [{ statement: "no provenance", sources: [] }];
    await expect(world.controller.submitSynthesisManifest("ses_syn", zeroSources)).rejects.toSatisfy(
      (e: unknown) => isUltraPlanError(e) && e.code === "provenance_missing",
    );

    // Source outside the frozen input (unknown decision).
    const outsideSource = manifestDraft();
    outsideSource.limitations = [
      { statement: "s", sources: [{ kind: "decision", id: "DEC-999", revision: 1 }] },
    ];
    await expect(world.controller.submitSynthesisManifest("ses_syn", outsideSource)).rejects.toSatisfy(
      (e: unknown) => isUltraPlanError(e) && e.code === "provenance_invalid",
    );

    // Historical non-input Section revision (known id, wrong revision).
    const historical = manifestDraft();
    historical.implementationOrder = [
      { ...manifestStep(), sections: [
        { id: "SEC-001", revision: 2 },
        { id: "SEC-002", revision: 1 },
        { id: "SEC-003", revision: 1 },
      ] },
    ];
    await expect(world.controller.submitSynthesisManifest("ses_syn", historical)).rejects.toSatisfy(
      (e: unknown) => isUltraPlanError(e) && e.code === "provenance_invalid",
    );

    // Unknown Section ref.
    const unknown = manifestDraft();
    unknown.implementationOrder = [{ ...manifestStep(), sections: [{ id: "SEC-999", revision: 1 }] }];
    await expect(world.controller.submitSynthesisManifest("ses_syn", unknown)).rejects.toSatisfy(
      (e: unknown) => isUltraPlanError(e) && e.code === "provenance_invalid",
    );
  });

  it("provenance (§59): an Evidence ref not captured by the frozen input is rejected", async () => {
    const world = await synWorld();
    await world.controller.beginSynthesis("ses_syn");
    // Evidence that exists LIVE but was never reachable at freeze time.
    await world.store.putEvidence("PLAN-001" as never, {
      id: "EVD-009" as never,
      revision: 1,
      kind: "file",
      claim: "post-freeze evidence",
      source: [{ type: "file", path: "x.ts" }],
      scope: { kind: "run" },
      confidence: "direct",
      criticality: "supporting",
      freshness: "fresh",
      status: "active",
      discoveredAt: FIXED,
      lastValidatedAt: FIXED,
    });
    const draft = manifestDraft();
    draft.limitations = [{ statement: "s", sources: [{ kind: "evidence", id: "EVD-009", revision: 1 }] }];
    await expect(world.controller.submitSynthesisManifest("ses_syn", draft)).rejects.toSatisfy(
      (e: unknown) => isUltraPlanError(e) && e.code === "provenance_invalid",
    );
  });

  it("cross-section rule (§26/§59): one distinct Section is rejected, two are accepted", async () => {
    const world = await synWorld();
    await world.controller.beginSynthesis("ses_syn");
    const single = manifestDraft();
    single.crossSectionLinks = [
      {
        statement: "s",
        sources: [
          { kind: "section", id: "SEC-001", revision: 1 },
          { kind: "architecture" },
        ],
      },
    ];
    await expect(world.controller.submitSynthesisManifest("ses_syn", single)).rejects.toSatisfy(
      (e: unknown) => isUltraPlanError(e) && e.code === "cross_section_invalid",
    );
    const pair = manifestDraft();
    pair.crossSectionLinks = [
      {
        statement: "s",
        sources: [
          { kind: "section", id: "SEC-003", revision: 1 },
          { kind: "section", id: "SEC-001", revision: 1 },
        ],
      },
    ];
    const { manifest } = await world.controller.submitSynthesisManifest("ses_syn", pair);
    expect(manifest.crossSectionLinks).toHaveLength(1);
  });

  it("implementation-order coverage (§28/§60): every approved Section must appear; duplicate participation is permitted", async () => {
    const world = await synWorld();
    await world.controller.beginSynthesis("ses_syn");
    const uncovered = manifestDraft();
    uncovered.implementationOrder = [
      { ...manifestStep(), sections: [
        { id: "SEC-001", revision: 1 },
        { id: "SEC-002", revision: 1 },
      ] },
    ];
    await expect(world.controller.submitSynthesisManifest("ses_syn", uncovered)).rejects.toSatisfy(
      (e: unknown) => isUltraPlanError(e) && e.code === "implementation_coverage_gap",
    );
    // SEC-002 legitimately participates in two steps — accepted.
    const duplicates = manifestDraft();
    duplicates.implementationOrder = [
      {
        title: "Foundation",
        description: "d",
        sections: [
          { id: "SEC-001", revision: 1 },
          { id: "SEC-002", revision: 1 },
        ],
        sources: [{ kind: "architecture" }],
      },
      {
        title: "Integration",
        description: "d",
        sections: [
          { id: "SEC-002", revision: 1 },
          { id: "SEC-003", revision: 1 },
        ],
        sources: [{ kind: "architecture" }],
      },
    ];
    const { manifest } = await world.controller.submitSynthesisManifest("ses_syn", duplicates);
    expect(manifest.implementationOrder.map((step) => step.order)).toEqual([1, 2]);
  });

  it("Section-DAG order (§29/§60): dependent before dependency is rejected; same-step grouping is accepted", async () => {
    const world = await synWorld();
    await world.controller.beginSynthesis("ses_syn");
    const violation = manifestDraft();
    violation.implementationOrder = [
      {
        title: "Dependent first",
        description: "d",
        sections: [
          { id: "SEC-002", revision: 1 },
          { id: "SEC-003", revision: 1 },
        ],
        sources: [{ kind: "architecture" }],
      },
      {
        title: "Dependency later",
        description: "d",
        sections: [{ id: "SEC-001", revision: 1 }],
        sources: [{ kind: "architecture" }],
      },
    ];
    await expect(world.controller.submitSynthesisManifest("ses_syn", violation)).rejects.toSatisfy(
      (e: unknown) => isUltraPlanError(e) && e.code === "implementation_order_violation",
    );
    // Same-step grouping: all three in one step (dependency order equal) — accepted.
    const grouped = manifestDraft();
    grouped.implementationOrder = [
      { ...manifestStep(), sections: [
        { id: "SEC-003", revision: 1 },
        { id: "SEC-001", revision: 1 },
        { id: "SEC-002", revision: 1 },
      ] },
    ];
    const { manifest } = await world.controller.submitSynthesisManifest("ses_syn", grouped);
    expect(manifest.implementationOrder).toHaveLength(1);
  });

  it("findings (§31): the frozen v0.1 categories validate; an unknown category fails closed", () => {
    const input = {
      sections: [
        { ref: { id: "SEC-001" as never, revision: 1 }, title: "t", dependencies: [] },
        { ref: { id: "SEC-002" as never, revision: 1 }, title: "t2", dependencies: ["SEC-001" as never] },
      ],
      decisions: [],
      constraints: [],
      questions: [],
      conflicts: [],
      evidence: [],
      architecture: { id: "ARCH" as const, revision: 1 },
    } as unknown as SynthesisInput;
    const draft: SynthesisManifestDraft = {
      inputID: "SYN-IN-001" as never,
      crossSectionLinks: [
        { statement: "s", sources: [{ kind: "section", id: "SEC-001" as never, revision: 1 }, { kind: "section", id: "SEC-002" as never, revision: 1 }] },
      ],
      implementationOrder: [
        {
          title: "t",
          description: "d",
          sections: [
            { id: "SEC-001" as never, revision: 1 },
            { id: "SEC-002" as never, revision: 1 },
          ],
          sources: [{ kind: "architecture" }],
        },
      ],
      limitations: [],
      unresolvedFindings: [
        { category: "missing_design", statement: "no design covers X", sources: [{ kind: "section", id: "SEC-001" as never, revision: 1 }] },
      ],
    };
    expect(() => validateManifestDraft(draft, input)).not.toThrow();
    const badCategory: SynthesisManifestDraft = {
      ...draft,
      unresolvedFindings: [{ category: "unsupported_new_fact" as never, statement: "f" }],
    };
    try {
      validateManifestDraft(badCategory, input);
      expect.unreachable("unknown finding category must fail closed");
    } catch (error) {
      expect(isUltraPlanError(error) && error.code).toBe("finding_invalid");
    }
    // Pure source resolution helper: statement sources are strict; finding
    // sources may consult current blockers (brief §33/§53).
    expect(sourceRefResolves({ kind: "question", id: "Q-001" as never }, input)).toBe(false);
    expect(
      sourceRefResolves({ kind: "question", id: "Q-001" as never }, input, { questions: [{ id: "Q-001" as never, status: "open" }] }),
    ).toBe(true);
  });

  it("a finding may cite a blocker raised AFTER the freeze; derived statements may not (brief §53)", async () => {
    const world = await synWorld();
    await world.controller.beginSynthesis("ses_syn");
    await world.controller.recordQuestion("ses_syn", {
      question: "Post-freeze blocker",
      blocking: false,
      scope: { type: "architecture" },
    });
    const draft = manifestDraft();
    draft.unresolvedFindings = [
      { category: "missing_design", statement: "needs design for the post-freeze blocker", sources: [{ kind: "question", id: "Q-001" }] },
    ];
    const { manifest } = await world.controller.submitSynthesisManifest("ses_syn", draft);
    expect(manifest.unresolvedFindings[0]?.sources).toEqual([{ kind: "question", id: "Q-001" }]);
    const statementCiting = manifestDraft();
    statementCiting.limitations = [{ statement: "s", sources: [{ kind: "question", id: "Q-001" }] }];
    await expect(world.controller.submitSynthesisManifest("ses_syn", statementCiting)).rejects.toSatisfy(
      (e: unknown) => isUltraPlanError(e) && e.code === "provenance_invalid",
    );
  });

  it("exact resubmission is idempotent; different content creates the next immutable revision; old content replays the exact old revision (brief §36/§37)", async () => {
    const world = await synWorld();
    await world.controller.beginSynthesis("ses_syn");
    const first = await world.controller.submitSynthesisManifest("ses_syn", manifestDraft());
    expect(first.manifest.revision).toBe(1);
    expect(first.idempotent).toBe(false);

    const replay = await world.controller.submitSynthesisManifest("ses_syn", manifestDraft());
    expect(replay.manifest.id).toBe(first.manifest.id);
    expect(replay.manifest.revision).toBe(1);
    expect(replay.manifest.hash).toBe(first.manifest.hash);
    expect(replay.idempotent).toBe(true);

    const revised = manifestDraft();
    revised.limitations = [...revised.limitations, { statement: "extra limitation", sources: [{ kind: "architecture" }] }];
    const second = await world.controller.submitSynthesisManifest("ses_syn", revised);
    expect(second.manifest.revision).toBe(2);
    expect(second.manifest.id).toBe(first.manifest.id); // stable identity
    expect(second.manifest.hash).not.toBe(first.manifest.hash);

    // Resubmitting the @1 content returns @1 — never a meaningless duplicate.
    const oldReplay = await world.controller.submitSynthesisManifest("ses_syn", manifestDraft());
    expect(oldReplay.manifest.revision).toBe(1);
    expect(oldReplay.idempotent).toBe(true);
    const all = await world.store.listSynthesisManifests("PLAN-001" as never);
    expect(all).toHaveLength(2);
    // Prior revisions stay immutable/readable (brief §36).
    const stored1 = await world.store.getSynthesisManifest("PLAN-001" as never, first.manifest.id, 1);
    expect(stored1?.hash).toBe(first.manifest.hash);
  });
});

// -----------------------------------------------------------------------------
// Staleness + normative boundary (brief §18/§50/§61/§43/§44/§48/§49)
// -----------------------------------------------------------------------------

describe("staleness and the normative boundary", () => {
  it("a manifest against a stale input fails closed with synthesis_input_stale; the input stays readable (brief §18/§50)", async () => {
    const world = await synWorld();
    const { input } = await world.controller.beginSynthesis("ses_syn");
    await moveHeadWithHostileCommit(world, "ses_syn");
    await expect(world.controller.submitSynthesisManifest("ses_syn", manifestDraft())).rejects.toSatisfy(
      (e: unknown) => isUltraPlanError(e) && e.code === "synthesis_input_stale",
    );
    // The historical input remains readable for audit — not rebased, not deleted.
    const stored = await world.store.getSynthesisInput("PLAN-001" as never, input.id);
    expect(stored?.hash).toBe(input.hash);
    expect(stored?.baseSnapshot.id).toBe(input.baseSnapshot.id);
    // A fresh freeze at the NEW HEAD produces a NEW canonical input.
    const second = await world.controller.beginSynthesis("ses_syn");
    expect(second.input.id).not.toBe(input.id);
    expect(second.input.baseSnapshot.id).toBe((await world.store.getRun("PLAN-001" as never))?.headSnapshot);
  });

  it("manifest submission creates zero PlanCommits, zero HEAD movement, and zero committed-artifact mutation (brief §61)", async () => {
    const world = await synWorld();
    await world.controller.beginSynthesis("ses_syn");
    const beforeRun = (await world.store.getRun("PLAN-001" as never)) as PlanningRun;
    const beforeCommits = await world.store.listCommits("PLAN-001" as never);
    const beforeSnapshot = await world.store.getHeadSnapshot("PLAN-001" as never);
    const beforeArchitecture = await world.store.getArchitecture("PLAN-001" as never);
    const beforeSections = await world.store.listSections("PLAN-001" as never);

    const { manifest } = await world.controller.submitSynthesisManifest("ses_syn", manifestDraft());
    expect(manifest.revision).toBe(1);

    const afterRun = (await world.store.getRun("PLAN-001" as never)) as PlanningRun;
    expect(afterRun.headCommit).toBe(beforeRun.headCommit);
    expect(afterRun.headSnapshot).toBe(beforeRun.headSnapshot);
    expect(afterRun.stage).toBe("synthesis");
    expect(await world.store.listCommits("PLAN-001" as never)).toHaveLength(beforeCommits.length);
    expect(await world.store.getHeadSnapshot("PLAN-001" as never)).toEqual(beforeSnapshot);
    expect(await world.store.getArchitecture("PLAN-001" as never)).toEqual(beforeArchitecture);
    expect(await world.store.listSections("PLAN-001" as never)).toEqual(beforeSections);
  });

  it("request_synthesis remains unable to bypass the real workflow (DoD; brief §43)", async () => {
    const world = await synWorld();
    await expect(world.controller.requestSynthesis("ses_syn")).rejects.toSatisfy(
      (e: unknown) => isUltraPlanError(e) && e.code === "capability_not_available",
    );
    await world.controller.beginSynthesis("ses_syn");
    await world.controller.submitSynthesisManifest("ses_syn", manifestDraft());
    await expect(world.controller.requestSynthesis("ses_syn")).rejects.toSatisfy(
      (e: unknown) => isUltraPlanError(e) && e.code === "capability_not_available",
    );
    const run = (await world.store.getRun("PLAN-001" as never)) as PlanningRun;
    expect(run.stage).toBe("synthesis");
    expect(run.finalPlan).toBeUndefined();
  });

  it("no synthesis-path tool can create design artifacts: prepare_proposal is denied from synthesis (brief §61)", async () => {
    const world = await synWorld();
    await expect(
      world.controller.prepareProposal("ses_syn", {
        type: "amendment",
        scope: { type: "architecture" },
        title: "t",
        summary: "s",
        changes: [{ kind: "add_decision", content: { decision: { title: "t", statement: "s", rationale: "r" } } }],
      }),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "capability_not_available");
  });
});

// -----------------------------------------------------------------------------
// Reads, status, protocol (brief §41/§45/§46/§47)
// -----------------------------------------------------------------------------

describe("reads, status rendering, and the L0 protocol", () => {
  it("plan_memory reads serve exact derived artifacts; exact manifest revisions never resolve to latest (brief §41)", async () => {
    const world = await synWorld();
    const { input } = await world.controller.beginSynthesis("ses_syn");
    const first = await world.controller.submitSynthesisManifest("ses_syn", manifestDraft());
    const revised = manifestDraft();
    revised.limitations = [...revised.limitations, { statement: "extra", sources: [{ kind: "architecture" }] }];
    await world.controller.submitSynthesisManifest("ses_syn", revised);

    const inputRead = await world.controller.readMemoryForRun((await world.store.getRun("PLAN-001" as never)) as PlanningRun, {
      ref: { kind: "synthesis_input", id: input.id },
    });
    expect(inputRead.artifacts[0]?.artifact).toMatchObject({ id: input.id, hash: input.hash });
    // Exact historical read.
    const exactRead = await world.controller.readMemoryForRun((await world.store.getRun("PLAN-001" as never)) as PlanningRun, {
      ref: { kind: "synthesis_manifest", id: first.manifest.id, revision: 1 },
    });
    expect(exactRead.artifacts[0]?.artifact).toMatchObject({ id: first.manifest.id, revision: 1 });
    // A missing exact revision is an error, NEVER resolved to latest.
    await expect(
      world.controller.readMemoryForRun((await world.store.getRun("PLAN-001" as never)) as PlanningRun, {
        ref: { kind: "synthesis_manifest", id: first.manifest.id, revision: 99 },
      }),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "unknown_reference");
    // Without a revision: the newest revision of that manifest id.
    const latestRead = await world.controller.readMemoryForRun((await world.store.getRun("PLAN-001" as never)) as PlanningRun, {
      ref: { kind: "synthesis_manifest", id: first.manifest.id },
    });
    expect(latestRead.artifacts[0]?.artifact).toMatchObject({ revision: 2 });
  });

  it("status renders the three §47 states exactly, byte-stable, and never claims clean/final", async () => {
    const world = await synWorld();
    const before = await world.controller.statusReport("ses_syn");
    expect(before.statusText).toContain("Synthesis input: not frozen");
    expect(before.statusText).toContain("Synthesis manifest: none");
    expect(before.statusText).not.toContain("Validation: clean");
    expect(before.statusText).not.toContain("Final: ready");

    const { input } = await world.controller.beginSynthesis("ses_syn");
    const afterInput = await world.controller.statusReport("ses_syn");
    expect(afterInput.statusText).toContain(`Synthesis input: ${input.id}`);
    expect(afterInput.statusText).toContain(`Base: ${input.baseSnapshot.id}`);
    expect(afterInput.statusText).toContain("Synthesis manifest: none");

    const { manifest } = await world.controller.submitSynthesisManifest("ses_syn", manifestDraft());
    const afterManifest = await world.controller.statusReport("ses_syn");
    expect(afterManifest.statusText).toContain(`Synthesis input: ${input.id}`);
    expect(afterManifest.statusText).toContain(`Synthesis manifest: ${manifest.id}@${manifest.revision}`);
    expect(afterManifest.statusText).toContain("Manifest status: structurally valid");
    expect(afterManifest.statusText).toContain("Semantic validation: not run");
    expect(afterManifest.statusText).not.toContain("Validation: clean");
    // Byte-stable.
    expect((await world.controller.statusReport("ses_syn")).statusText).toBe(afterManifest.statusText);
  });

  it("status marks a stale input deterministically (brief §18)", async () => {
    const world = await synWorld();
    const { input } = await world.controller.beginSynthesis("ses_syn");
    await moveHeadWithHostileCommit(world, "ses_syn");
    const report = await world.controller.statusReport("ses_syn");
    expect(report.statusText).toContain(`Synthesis input: ${input.id}`);
    expect(report.statusText).toContain(`Input status: stale (HEAD moved past ${input.baseSnapshot.id})`);
  });

  it("the L0 protocol exposes the minimal synthesis projection (brief §46)", async () => {
    const world = await synWorld();
    const { input } = await world.controller.beginSynthesis("ses_syn");
    const run = (await world.store.getRun("PLAN-001" as never)) as PlanningRun;
    const protocol = renderPlanningProtocol({
      run,
      synthesis: {
        inputID: input.id,
        baseSnapshot: input.baseSnapshot.id,
        inputHash: input.hash,
        blockerCount: 0,
      },
    });
    expect(protocol).toContain(`Frozen SynthesisInput: ${input.id} (base ${input.baseSnapshot.id}`);
    expect(protocol).toContain("No SynthesisManifest yet");
    expect(protocol).toContain("- [x] submit_synthesis_manifest");
    const withManifest = renderPlanningProtocol({
      run,
      synthesis: {
        inputID: input.id,
        baseSnapshot: input.baseSnapshot.id,
        inputHash: input.hash,
        manifestRef: "SYN-001@1",
        manifestHash: "abc",
        stale: true,
        blockerCount: 2,
      },
    });
    expect(withManifest).toContain("Current SynthesisManifest: SYN-001@1");
    // Phase 2G §58 supersedes the 2F fragment with the exact unvalidated text.
    expect(withManifest).toContain(
      "The current SynthesisManifest is structurally valid but has not received semantic validation.",
    );
    expect(withManifest).toContain("Request semantic validation.");
    expect(withManifest).toContain("STALE");
    expect(withManifest).toContain("2 open blocker(s)");
  });
});

// -----------------------------------------------------------------------------
// Durable behavior (brief §39/§40/§55/§57/§62/§63)
// -----------------------------------------------------------------------------

describe("durable derived artifacts", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "ultraplan-synthesis-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function openStore(dbFile: string): DurablePlanStore {
    const store = new DurablePlanStore(dbFile, { now: () => FIXED });
    store.open();
    return store;
  }

  /** The §62 PRIMARY acceptance test — durable end-to-end with reopen. */
  it("PRIMARY: freeze → manifest → no mutation → close → reopen → identical artifacts (brief §62)", async () => {
    const dbFile = path.join(dir, "plan-store.json");
    const store = openStore(dbFile);
    const controller = new UltraPlanController({ store, now: () => FIXED });
    const sessionID = "ses_primary";
    await admittedStart(controller, sessionID, GOAL);
    await controller.requestArchitecture(sessionID);
    const completion = await controller.prepareProposal(sessionID, {
      type: "architecture_completion",
      scope: { type: "architecture" },
      title: "Complete architecture",
      summary: "s",
      changes: [ARCH_CHANGE, { kind: "complete_architecture" }] as never,
    });
    const begun = await controller.beginProposalApproval(sessionID, completion.proposal.id);
    await controller.recordApprovalAndCommit(sessionID, completion.proposal.id, begun.request);
    const decomposition = await controller.prepareSectionDecomposition(sessionID, CHAIN_DECOMPOSITION);
    const dagBegun = await controller.beginProposalApproval(sessionID, decomposition.proposal.id);
    await controller.recordApprovalAndCommit(sessionID, decomposition.proposal.id, dagBegun.request);
    // Three full checkpoint+completion cycles → synthesis.
    for (let index = 0; index < 3; index++) {
      const run = (await store.findActiveRunBySession(sessionID)) as PlanningRun;
      const active = (run.activeWork as { id: "SEC-001" }).id;
      const prepared = await controller.prepareSectionCheckpoint(sessionID, checkpointInput(active));
      const checkpointBegun = await controller.beginProposalApproval(sessionID, prepared.proposal.id);
      await controller.recordApprovalAndCommit(sessionID, prepared.proposal.id, checkpointBegun.request);
      const completionPrepared = await controller.requestCompletion(sessionID, { kind: "section" });
      const completionBegun = await controller.beginProposalApproval(sessionID, completionPrepared.proposal.id);
      await controller.recordApprovalAndCommit(sessionID, completionPrepared.proposal.id, completionBegun.request);
    }
    const preSynthesisRun = (await store.getRun("PLAN-001" as never)) as PlanningRun;
    expect(preSynthesisRun.stage).toBe("synthesis");
    const commitCountBeforeSynthesis = (await store.listCommits("PLAN-001" as never)).length;

    // Freeze + submit through the REAL model-facing operations.
    const { input, capsule } = await controller.beginSynthesis(sessionID);
    const { manifest } = await controller.submitSynthesisManifest(sessionID, manifestDraft());
    expect(input.sections.map((section) => section.ref)).toEqual([
      { id: "SEC-001", revision: 1 },
      { id: "SEC-002", revision: 1 },
      { id: "SEC-003", revision: 1 },
    ]);
    expect(manifest.implementationOrder[0]?.order).toBe(1);

    const runAfterManifest = (await store.getRun("PLAN-001" as never)) as PlanningRun;
    expect(runAfterManifest.stage).toBe("synthesis");
    expect(runAfterManifest.headCommit).toBe(preSynthesisRun.headCommit);
    expect(runAfterManifest.headSnapshot).toBe(preSynthesisRun.headSnapshot);
    // Manifest creation created zero PlanCommits (brief §61).
    expect(await store.listCommits("PLAN-001" as never)).toHaveLength(commitCountBeforeSynthesis);
    store.close();

    // Reopen: identical artifacts, hashes, refs, provenance.
    const store2 = openStore(dbFile);
    const reopenedInput = await store2.getSynthesisInput("PLAN-001" as never, input.id);
    const reopenedManifest = await store2.getSynthesisManifest("PLAN-001" as never, manifest.id, 1);
    expect(reopenedInput).toEqual(input);
    expect(reopenedManifest).toEqual(manifest);
    const recapsule = await renderSynthesisCapsule(store2, reopenedInput as SynthesisInput);
    expect(recapsule).toBe(capsule);
    // Exact manifest read by id still works after reopen.
    expect((await store2.listSynthesisManifests("PLAN-001" as never))).toHaveLength(1);
    store2.close();
  });

  it("restart matrix (§57): synthesis/no-input, input/no-manifest, manifest@1, manifest@2, stale input — all identical after reopen", async () => {
    const dbFile = path.join(dir, "plan-store.json");
    const store = openStore(dbFile);
    const controller = new UltraPlanController({ store, now: () => FIXED });
    await admittedStart(controller, "ses_restart", GOAL);
    await controller.requestArchitecture("ses_restart");
    const completion = await controller.prepareProposal("ses_restart", {
      type: "architecture_completion",
      scope: { type: "architecture" },
      title: "Complete architecture",
      summary: "s",
      changes: [ARCH_CHANGE, { kind: "complete_architecture" }] as never,
    });
    const begun = await controller.beginProposalApproval("ses_restart", completion.proposal.id);
    await controller.recordApprovalAndCommit("ses_restart", completion.proposal.id, begun.request);
    const decomposition = await controller.prepareSectionDecomposition("ses_restart", CHAIN_DECOMPOSITION);
    const dagBegun = await controller.beginProposalApproval("ses_restart", decomposition.proposal.id);
    await controller.recordApprovalAndCommit("ses_restart", decomposition.proposal.id, dagBegun.request);
    for (let index = 0; index < 3; index++) {
      const run = (await store.findActiveRunBySession("ses_restart")) as PlanningRun;
      const prepared = await controller.prepareSectionCheckpoint(
        "ses_restart",
        checkpointInput((run.activeWork as { id: "SEC-001" }).id),
      );
      const checkpointBegun = await controller.beginProposalApproval("ses_restart", prepared.proposal.id);
      await controller.recordApprovalAndCommit("ses_restart", prepared.proposal.id, checkpointBegun.request);
      const completionPrepared = await controller.requestCompletion("ses_restart", { kind: "section" });
      const completionBegun = await controller.beginProposalApproval("ses_restart", completionPrepared.proposal.id);
      await controller.recordApprovalAndCommit("ses_restart", completionPrepared.proposal.id, completionBegun.request);
    }

    const snapshotAfterRestart = async (target: DurablePlanStore): Promise<unknown> => ({
      inputs: await target.listSynthesisInputs("PLAN-001" as never),
      manifests: await target.listSynthesisManifests("PLAN-001" as never),
      headSnapshot: (await target.getRun("PLAN-001" as never))?.headSnapshot,
      headCommit: (await target.getRun("PLAN-001" as never))?.headCommit,
    });
    const before = await snapshotAfterRestart(store);
    store.close();
    const reopened = openStore(dbFile);
    expect(await snapshotAfterRestart(reopened)).toEqual(before);

    // manifest@1 → manifest@2 → stale input, each survives reopen identically.
    const controller2 = new UltraPlanController({ store: reopened, now: () => FIXED });
    await controller2.beginSynthesis("ses_restart");
    const stateAfterInput = await snapshotAfterRestart(reopened);
    reopened.close();
    const reopened2 = openStore(dbFile);
    expect(await snapshotAfterRestart(reopened2)).toEqual(stateAfterInput);

    const controller3 = new UltraPlanController({ store: reopened2, now: () => FIXED });
    await controller3.submitSynthesisManifest("ses_restart", manifestDraft());
    const revised = manifestDraft();
    revised.limitations = [...revised.limitations, { statement: "extra", sources: [{ kind: "architecture" }] }];
    await controller3.submitSynthesisManifest("ses_restart", revised);
    const stateAfterM2 = await snapshotAfterRestart(reopened2);
    reopened2.close();
    const reopened3 = openStore(dbFile);
    expect(await snapshotAfterRestart(reopened3)).toEqual(stateAfterM2);

    // Stale input after a HEAD change survives reopen with its hashes intact.
    await moveHeadWithHostileCommit({ store: reopened3 }, "ses_restart");
    const stateAfterStale = await snapshotAfterRestart(reopened3);
    reopened3.close();
    const reopened4 = openStore(dbFile);
    expect(await snapshotAfterRestart(reopened4)).toEqual(stateAfterStale);
    reopened4.close();
  });

  it("corruption (§58): tampered input hash, manifest hash, missing input ref, mirrored-ref drift, malformed provenance, and broken revision chains all fail closed", async () => {
    const dbFile = path.join(dir, "plan-store.json");
    const store = openStore(dbFile);
    const controller = new UltraPlanController({ store, now: () => FIXED });
    await admittedStart(controller, "ses_corrupt", GOAL);
    await controller.requestArchitecture("ses_corrupt");
    const completion = await controller.prepareProposal("ses_corrupt", {
      type: "architecture_completion",
      scope: { type: "architecture" },
      title: "Complete architecture",
      summary: "s",
      changes: [ARCH_CHANGE, { kind: "complete_architecture" }] as never,
    });
    const begun = await controller.beginProposalApproval("ses_corrupt", completion.proposal.id);
    await controller.recordApprovalAndCommit("ses_corrupt", completion.proposal.id, begun.request);
    const decomposition = await controller.prepareSectionDecomposition("ses_corrupt", CHAIN_DECOMPOSITION);
    const dagBegun = await controller.beginProposalApproval("ses_corrupt", decomposition.proposal.id);
    await controller.recordApprovalAndCommit("ses_corrupt", decomposition.proposal.id, dagBegun.request);
    for (let index = 0; index < 3; index++) {
      const run = (await store.findActiveRunBySession("ses_corrupt")) as PlanningRun;
      const prepared = await controller.prepareSectionCheckpoint(
        "ses_corrupt",
        checkpointInput((run.activeWork as { id: "SEC-001" }).id),
      );
      const checkpointBegun = await controller.beginProposalApproval("ses_corrupt", prepared.proposal.id);
      await controller.recordApprovalAndCommit("ses_corrupt", prepared.proposal.id, checkpointBegun.request);
      const completionPrepared = await controller.requestCompletion("ses_corrupt", { kind: "section" });
      const completionBegun = await controller.beginProposalApproval("ses_corrupt", completionPrepared.proposal.id);
      await controller.recordApprovalAndCommit("ses_corrupt", completionPrepared.proposal.id, completionBegun.request);
    }
    await controller.beginSynthesis("ses_corrupt");
    await controller.submitSynthesisManifest("ses_corrupt", manifestDraft());
    store.close();

    const tamper = async (mutate: (doc: Record<string, unknown>) => void): Promise<unknown> => {
      const raw = JSON.parse(await readFile(dbFile, "utf8")) as Record<string, unknown>;
      mutate(raw);
      const tamperedPath = `${dbFile}.tampered`;
      await writeFile(tamperedPath, JSON.stringify(raw));
      let opened: DurablePlanStore | undefined;
      try {
        opened = openStore(tamperedPath);
        return null;
      } catch (error) {
        return error;
      } finally {
        opened?.close();
      }
    };

    /** Index into raw JSON without noUncheckedIndexedAccess friction. */
    const at = (parent: unknown, key: string): Record<string, unknown> =>
      (parent as Record<string, Record<string, unknown>>)[key] as Record<string, unknown>;

    // Tampered input hash.
    expect(
      await tamper((doc) => {
        at(at(doc.synthesisInputs, "PLAN-001"), "SYN-IN-001").hash = "0".repeat(64);
      }),
    ).toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "store_corrupt");

    // Tampered manifest hash.
    expect(
      await tamper((doc) => {
        at(at(doc.synthesisManifests, "PLAN-001"), "SYN-001@1").hash = "0".repeat(64);
      }),
    ).toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "store_corrupt");

    // Manifest references a missing input.
    expect(
      await tamper((doc) => {
        (at(at(doc.synthesisManifests, "PLAN-001"), "SYN-001@1").input as Record<string, unknown>).id =
          "SYN-IN-999";
      }),
    ).toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "store_corrupt");

    // Manifest architecture differs from its input.
    expect(
      await tamper((doc) => {
        at(at(doc.synthesisManifests, "PLAN-001"), "SYN-001@1").architecture = { id: "ARCH", revision: 2 };
      }),
    ).toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "store_corrupt");

    // Manifest Section set differs from its input.
    expect(
      await tamper((doc) => {
        at(at(doc.synthesisManifests, "PLAN-001"), "SYN-001@1").sections = [];
      }),
    ).toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "store_corrupt");

    // Invalid provenance ref form (section source without a revision).
    expect(
      await tamper((doc) => {
        const links = at(at(doc.synthesisManifests, "PLAN-001"), "SYN-001@1")
          .crossSectionLinks as { sources: unknown[] }[];
        const firstLink = links[0] as { sources: unknown[] };
        firstLink.sources[0] = { kind: "section", id: "SEC-001" };
      }),
    ).toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "store_corrupt");

    // Broken manifest revision chain (SYN-001@2 without @1).
    expect(
      await tamper((doc) => {
        const family = at(doc.synthesisManifests, "PLAN-001");
        const manifest = structuredClone(family["SYN-001@1"]) as Record<string, unknown>;
        manifest.revision = 2;
        family["SYN-001@2"] = manifest;
        delete family["SYN-001@1"];
      }),
    ).toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "store_corrupt");
  });

  it("cross-instance concurrency (§55): simultaneous freezes produce ONE canonical input; competing manifests serialize into distinct revisions", async () => {
    const dbFile = path.join(dir, "plan-store.json");
    const store = openStore(dbFile);
    const controller = new UltraPlanController({ store, now: () => FIXED });
    await admittedStart(controller, "ses_conc", GOAL);
    await controller.requestArchitecture("ses_conc");
    const completion = await controller.prepareProposal("ses_conc", {
      type: "architecture_completion",
      scope: { type: "architecture" },
      title: "Complete architecture",
      summary: "s",
      changes: [ARCH_CHANGE, { kind: "complete_architecture" }] as never,
    });
    const begun = await controller.beginProposalApproval("ses_conc", completion.proposal.id);
    await controller.recordApprovalAndCommit("ses_conc", completion.proposal.id, begun.request);
    const decomposition = await controller.prepareSectionDecomposition("ses_conc", CHAIN_DECOMPOSITION);
    const dagBegun = await controller.beginProposalApproval("ses_conc", decomposition.proposal.id);
    await controller.recordApprovalAndCommit("ses_conc", decomposition.proposal.id, dagBegun.request);
    for (let index = 0; index < 3; index++) {
      const run = (await store.findActiveRunBySession("ses_conc")) as PlanningRun;
      const prepared = await controller.prepareSectionCheckpoint(
        "ses_conc",
        checkpointInput((run.activeWork as { id: "SEC-001" }).id),
      );
      const checkpointBegun = await controller.beginProposalApproval("ses_conc", prepared.proposal.id);
      await controller.recordApprovalAndCommit("ses_conc", prepared.proposal.id, checkpointBegun.request);
      const completionPrepared = await controller.requestCompletion("ses_conc", { kind: "section" });
      const completionBegun = await controller.beginProposalApproval("ses_conc", completionPrepared.proposal.id);
      await controller.recordApprovalAndCommit("ses_conc", completionPrepared.proposal.id, completionBegun.request);
    }
    store.close();

    // Two instances freeze the same state concurrently → one canonical input.
    const storeA = openStore(dbFile);
    const storeB = openStore(dbFile);
    const controllerA = new UltraPlanController({ store: storeA, now: () => FIXED });
    const controllerB = new UltraPlanController({ store: storeB, now: () => FIXED });
    const [a, b] = await Promise.all([
      controllerA.beginSynthesis("ses_conc"),
      controllerB.beginSynthesis("ses_conc"),
    ]);
    expect(a.input.id).toBe(b.input.id);
    expect(a.input.hash).toBe(b.input.hash);
    expect(await storeA.listSynthesisInputs("PLAN-001" as never)).toHaveLength(1);
    expect(await storeB.listSynthesisInputs("PLAN-001" as never)).toHaveLength(1);

    // Two DIFFERENT manifest submissions serialize into distinct revisions.
    const revised = manifestDraft();
    revised.limitations = [...revised.limitations, { statement: "extra", sources: [{ kind: "architecture" }] }];
    const [m1, m2] = await Promise.all([
      controllerA.submitSynthesisManifest("ses_conc", manifestDraft()),
      controllerB.submitSynthesisManifest("ses_conc", revised),
    ]);
    expect(new Set([m1.manifest.revision, m2.manifest.revision])).toEqual(new Set([1, 2]));
    expect(m1.manifest.id).toBe(m2.manifest.id);
    // Two IDENTICAL submissions are idempotent (same revision).
    const [i1, i2] = await Promise.all([
      controllerA.submitSynthesisManifest("ses_conc", manifestDraft()),
      controllerB.submitSynthesisManifest("ses_conc", manifestDraft()),
    ]);
    expect(i1.manifest.revision).toBe(i2.manifest.revision);
    storeA.close();
    storeB.close();
  });

  it("compaction-independence (§63): a fresh controller over a reopened store reconstructs the full synthesis state from durable artifacts alone", async () => {
    const dbFile = path.join(dir, "plan-store.json");
    const store = openStore(dbFile);
    const controller = new UltraPlanController({ store, now: () => FIXED });
    await admittedStart(controller, "ses_compact", GOAL);
    await controller.requestArchitecture("ses_compact");
    const completion = await controller.prepareProposal("ses_compact", {
      type: "architecture_completion",
      scope: { type: "architecture" },
      title: "Complete architecture",
      summary: "s",
      changes: [ARCH_CHANGE, { kind: "complete_architecture" }] as never,
    });
    const begun = await controller.beginProposalApproval("ses_compact", completion.proposal.id);
    await controller.recordApprovalAndCommit("ses_compact", completion.proposal.id, begun.request);
    const decomposition = await controller.prepareSectionDecomposition("ses_compact", CHAIN_DECOMPOSITION);
    const dagBegun = await controller.beginProposalApproval("ses_compact", decomposition.proposal.id);
    await controller.recordApprovalAndCommit("ses_compact", decomposition.proposal.id, dagBegun.request);
    for (let index = 0; index < 3; index++) {
      const run = (await store.findActiveRunBySession("ses_compact")) as PlanningRun;
      const prepared = await controller.prepareSectionCheckpoint(
        "ses_compact",
        checkpointInput((run.activeWork as { id: "SEC-001" }).id),
      );
      const checkpointBegun = await controller.beginProposalApproval("ses_compact", prepared.proposal.id);
      await controller.recordApprovalAndCommit("ses_compact", prepared.proposal.id, checkpointBegun.request);
      const completionPrepared = await controller.requestCompletion("ses_compact", { kind: "section" });
      const completionBegun = await controller.beginProposalApproval("ses_compact", completionPrepared.proposal.id);
      await controller.recordApprovalAndCommit("ses_compact", completionPrepared.proposal.id, completionBegun.request);
    }
    const { input, capsule } = await controller.beginSynthesis("ses_compact");
    const { manifest } = await controller.submitSynthesisManifest("ses_compact", manifestDraft());
    store.close();

    // "Compaction": the model-facing conversation is gone — a brand-new
    // controller with a DIFFERENT session id over the reopened store.
    const store2 = openStore(dbFile);
    const controller2 = new UltraPlanController({ store: store2, now: () => FIXED });
    const run = (await store2.getRun("PLAN-001" as never)) as PlanningRun;
    expect(run.sessionID).not.toBe("ses_reconstructed");
    // Input + manifest + exact Plan Memory reads reconstruct the authority.
    const reconstructedInput = await store2.getSynthesisInput("PLAN-001" as never, input.id);
    expect(reconstructedInput).toEqual(input);
    expect(await renderSynthesisCapsule(store2, reconstructedInput as SynthesisInput)).toBe(capsule);
    const manifestRead = await controller2.readMemoryForRun(run, {
      ref: { kind: "synthesis_manifest", id: manifest.id, revision: manifest.revision },
    });
    expect(manifestRead.artifacts[0]?.artifact).toEqual(manifest);
    const architectureRead = await controller2.readMemoryForRun(run, { ref: { kind: "architecture", revision: 1 } });
    expect(architectureRead.artifacts[0]?.artifact).toMatchObject({ id: "ARCH", revision: 1 });
    // The status block is reproducible from durable state alone.
    const protocol = renderPlanningProtocol({
      run,
      synthesis: {
        inputID: input.id,
        baseSnapshot: input.baseSnapshot.id,
        inputHash: input.hash,
        manifestRef: `${manifest.id}@${manifest.revision}`,
        manifestHash: manifest.hash,
        blockerCount: 0,
      },
    });
    expect(protocol).toContain(`Frozen SynthesisInput: ${input.id}`);
    store2.close();
  });
});
