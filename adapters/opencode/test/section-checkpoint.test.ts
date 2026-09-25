/**
 * Phase 2E1 — Section Revision Checkpoint & Contract Freeze.
 *
 * Covers the first real Section design checkpoint: active Section root →
 * planning model develops the detailed design → the Harness freezes the exact
 * SectionRevision (+ stable compact projection + dependency-facing
 * SectionContract) → one design_checkpoint Proposal → explicit user Approval →
 * one atomic PlanCommit → immutable SectionRevision@n, root pointers moved,
 * Section still incomplete. First checkpoints freeze `add_section_revision`;
 * later checkpoints freeze `amend_section` bound to the EXACT prior revision.
 * Dependency contracts are bound by the Harness at freeze (exact SEC-X@N or
 * explicit absence); missing/changed dependency contracts deterministically
 * produce needs_review, and a revalidated checkpoint restores validity.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ApprovalIDs,
  DurablePlanStore,
  InMemoryPlanStore,
  ProposalIDs,
  UltraPlanError,
  computeProposalHash,
  createUltraPlanTools,
  isUltraPlanError,
  nextSequence,
  renderPlanningProtocol,
  renderProposalForApproval,
  renderStatus,
  TOOL_CONTRACTS,
} from "../src/index.js";
import type {
  ApprovedSectionRevision,
  Dependency,
  PlanCommit,
  PlanningRun,
  Proposal,
  ProposalChange,
  Section,
  SectionCheckpointInput,
  SectionID,
} from "../src/index.js";
import { UltraPlanController } from "../src/core/controller.js";
import type { CapturedAsk } from "./helpers.js";
import { admittedStart, fakeToolContext } from "./helpers.js";

const FIXED = "2026-09-25T11:00:00.000Z";
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
      summary: "Checkpoint target",
      components: [{ name: "Core", summary: "kernel" }],
      boundaries: [],
      dataFlows: [],
      principles: [],
    },
  },
};

/**
 * Decomposition with a DEPENDENT initial focus: SEC-001 "Runtime Integration"
 * (no structural dependencies) and SEC-002 "Plan Memory" (depends on SEC-001).
 * The initial focus is SEC-002, so the checkpointed active section has a real
 * dependency context to bind against.
 */
const DECOMPOSITION = {
  sections: [
    { key: "runtime", title: "Runtime Integration", objective: "bind to the OpenCode host" },
    { key: "plan-memory", title: "Plan Memory", objective: "durable authoritative state", dependsOn: ["runtime"] },
  ],
  initialSection: "plan-memory",
};

/** The Phase 2E1 starting state: detail + committed DAG + activeWork SEC-002 (revisionless). */
async function checkpointWorld(world: ReturnType<typeof makeWorld> = makeWorld(), sessionID = "ses_ck") {
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
  const decomposition = await world.controller.prepareSectionDecomposition(sessionID, DECOMPOSITION);
  const dagBegun = await world.controller.beginProposalApproval(sessionID, decomposition.proposal.id);
  await world.controller.recordApprovalAndCommit(sessionID, decomposition.proposal.id, dagBegun.request);
  run = (await world.store.getRun(run.id)) as PlanningRun;
  expect(run.stage).toBe("detail");
  expect(run.sections.map((ref) => ref.id)).toEqual(["SEC-001", "SEC-002"]);
  expect(run.activeWork).toEqual({ type: "section", id: "SEC-002" });
  return { ...world, run };
}

/** A valid checkpoint draft for SEC-002 (records its structural dependency SEC-001). */
function checkpointInput(overrides: Partial<SectionCheckpointInput> = {}): SectionCheckpointInput {
  return {
    problem: "Planning state must survive restarts and compaction",
    design: "Append-only document with atomic rename publication and lock-guarded reload",
    interfaces: [{ name: "PlanStore", description: "Durable storage boundary", signature: "commitTransaction(input)" }],
    invariants: ["HEAD moves last in every publication", "approved revisions are immutable"],
    failureModes: [{ description: "concurrent writers", mitigation: "O_EXCL lock + reload-under-lock" }],
    dependencies: [{ sectionID: "SEC-001" as SectionID, consumes: ["durable-state"] }],
    decisions: [],
    openQuestions: [],
    impacts: [],
    projection: {
      compact: "Durable append-only plan memory; atomic rename; HEAD last.",
      contract: {
        provides: ["durable-plan-memory"],
        requires: ["durable-state"],
        invariants: ["HEAD moves last in every publication"],
        interfaces: [{ name: "PlanStore" }],
        decisions: [],
      },
    },
    ...overrides,
  };
}

async function prepareCheckpoint(
  world: ReturnType<typeof makeWorld>,
  sessionID: string,
  input: SectionCheckpointInput = checkpointInput(),
) {
  const prepared = await world.controller.prepareSectionCheckpoint(sessionID, input);
  const begun = await world.controller.beginProposalApproval(sessionID, prepared.proposal.id);
  return { prepared, begun };
}

async function approveAndCommit(
  world: ReturnType<typeof makeWorld>,
  sessionID: string,
  proposalID: string,
  request: Parameters<UltraPlanController["recordApprovalAndCommit"]>[2],
): Promise<PlanCommit> {
  return (await world.controller.recordApprovalAndCommit(sessionID, proposalID, request)).commit;
}

function failCodes(error: unknown): string[] {
  if (!isUltraPlanError(error)) return [];
  const failures = error.detail?.failures as { code: string }[] | undefined;
  return failures?.map((f) => f.code) ?? [];
}

/**
 * Craft a SectionRevision for the NON-active section SEC-001 directly through
 * the engine (hostile/direct path, the same precedent the 2B/2D suites use).
 * SEC-001 has no structural dependencies, so its revisions carry none. The
 * proposal type is `amendment` — the design_checkpoint activeWork guard
 * correctly refuses off-focus checkpoints, and these crafted revisions
 * simulate the dependency-side commits that Phase 2E2 focus switching will
 * produce through real flows.
 */
async function commitCraftedRuntimeRevision(
  world: ReturnType<typeof makeWorld>,
  sessionID: string,
  revisionNumber: 1 | 2,
  provides: string[],
): Promise<PlanCommit> {
  const run = (await world.store.getRun("PLAN-001" as never)) as PlanningRun;
  const revision: ApprovedSectionRevision = {
    sectionID: "SEC-001" as SectionID,
    revision: revisionNumber,
    status: "approved",
    createdAt: FIXED,
    problem: `runtime problem ${revisionNumber}`,
    design: `runtime design ${revisionNumber}`,
    interfaces: [],
    invariants: [],
    failureModes: [],
    dependencies: [],
    decisions: [],
    openQuestions: [],
    impacts: [],
    projection: {
      compact: `runtime compact ${revisionNumber}`,
      contract: {
        sectionID: "SEC-001" as SectionID,
        revision: revisionNumber,
        provides,
        requires: [],
        invariants: [],
        interfaces: [],
        decisions: [],
      },
    },
  };
  const change: ProposalChange =
    revisionNumber === 1
      ? { kind: "add_section_revision", revision }
      : { kind: "amend_section", supersedes: { id: "SEC-001" as SectionID, revision: 1 }, revision };
  const proposal: Proposal = {
    id: ProposalIDs.from(nextSequence((await world.store.listProposals(run.id)).map((p) => p.id), ProposalIDs.prefix)),
    type: "amendment",
    scope: { id: "SEC-001" as SectionID },
    revision: 1,
    status: "awaiting_approval",
    title: `Crafted SEC-001@${revisionNumber}`,
    summary: "engine-level dependency-side revision",
    changes: [change],
    dependencies: [],
    impact: { affectedSections: ["SEC-001" as SectionID], affectedDecisions: [] },
    createdFrom: { id: run.headSnapshot as never },
  };
  proposal.hash = computeProposalHash(proposal);
  await world.store.saveProposal(run.id, proposal);
  await world.store.saveApproval(run.id, {
    id: ApprovalIDs.from(nextSequence((await world.store.listApprovals(run.id)).map((a) => a.id), ApprovalIDs.prefix)),
    proposalID: proposal.id,
    proposalRevision: 1,
    proposalHash: proposal.hash,
    actor: "user",
    createdAt: FIXED,
  });
  return world.store.commitTransaction({
    planID: run.id,
    proposalID: proposal.id,
    approvalID: (await world.store.findApprovalForProposal(run.id, proposal.id))!.id,
  });
}

/** Craft a hostile proposal straight against the engine (status + hash + approval by hand). */
async function commitHostileProposal(
  world: ReturnType<typeof makeWorld>,
  change: ProposalChange,
  scope: Proposal["scope"],
  type: Proposal["type"] = "design_checkpoint",
): Promise<unknown> {
  const run = (await world.store.getRun("PLAN-001" as never)) as PlanningRun;
  const proposal: Proposal = {
    id: ProposalIDs.from(nextSequence((await world.store.listProposals(run.id)).map((p) => p.id), ProposalIDs.prefix)),
    type,
    scope,
    revision: 1,
    status: "awaiting_approval",
    title: "hostile",
    summary: "hostile",
    changes: [change],
    dependencies: [],
    impact: { affectedSections: [], affectedDecisions: [] },
    createdFrom: { id: run.headSnapshot as never },
  };
  proposal.hash = computeProposalHash(proposal);
  await world.store.saveProposal(run.id, proposal);
  await world.store.saveApproval(run.id, {
    id: ApprovalIDs.from(nextSequence((await world.store.listApprovals(run.id)).map((a) => a.id), ApprovalIDs.prefix)),
    proposalID: proposal.id,
    proposalRevision: 1,
    proposalHash: proposal.hash,
    actor: "user",
    createdAt: FIXED,
  });
  try {
    await world.store.commitTransaction({
      planID: run.id,
      proposalID: proposal.id,
      approvalID: (await world.store.findApprovalForProposal(run.id, proposal.id))!.id,
    });
    return null;
  } catch (error) {
    return error;
  }
}

// -----------------------------------------------------------------------------
// Capability + preconditions (tests 1-7)
// -----------------------------------------------------------------------------

describe("checkpoint preconditions (tests 1-7)", () => {
  it("a revisionless active Section can prepare its first checkpoint; it freezes add_section_revision at exactly revision 1 (tests 1-3)", async () => {
    const world = await checkpointWorld();
    const { prepared } = await prepareCheckpoint(world, "ses_ck");
    const change = prepared.proposal.changes[0] as Extract<ProposalChange, { kind: "add_section_revision" }>;
    expect(change.kind).toBe("add_section_revision");
    expect(change.revision.sectionID).toBe("SEC-002");
    expect(change.revision.revision).toBe(1);
    expect(change.revision.status).toBe("approved");
    expect(change.revision.createdAt).toBe(FIXED);
    expect(change.revision.projection.contract.sectionID).toBe("SEC-002");
    expect(change.revision.projection.contract.revision).toBe(1);
  });

  it("the model cannot provide authoritative revision identity (test 4)", async () => {
    const world = await checkpointWorld();
    const hostile = {
      ...checkpointInput(),
      sectionID: "SEC-003",
      revision: 7,
      status: "draft",
      approvedRevision: 4,
      createdAt: "1999-01-01T00:00:00.000Z",
      projection: {
        ...checkpointInput().projection,
        contract: { ...checkpointInput().projection.contract, sectionID: "SEC-003", revision: 9 },
      },
    } as unknown as SectionCheckpointInput;
    const { prepared } = await prepareCheckpoint(world, "ses_ck", hostile);
    const change = prepared.proposal.changes[0] as Extract<ProposalChange, { kind: "add_section_revision" }>;
    // Harness-assigned identity only — hostile fields never reach the payload.
    expect(change.revision.sectionID).toBe("SEC-002");
    expect(change.revision.revision).toBe(1);
    expect(change.revision.status).toBe("approved");
    expect(change.revision.createdAt).toBe(FIXED);
    expect(change.revision.projection.contract.sectionID).toBe("SEC-002");
    expect(change.revision.projection.contract.revision).toBe(1);
  });

  it("the checkpoint targets activeWork only — the engine refuses an off-focus checkpoint (test 5)", async () => {
    const world = await checkpointWorld();
    // Hostile direct engine proposal: a design_checkpoint targeting SEC-001
    // while activeWork is SEC-002 must fail the §7 discipline.
    const revision: ApprovedSectionRevision = {
      sectionID: "SEC-001" as SectionID,
      revision: 1,
      status: "approved",
      createdAt: FIXED,
      problem: "p",
      design: "d",
      interfaces: [],
      invariants: [],
      failureModes: [],
      dependencies: [],
      decisions: [],
      openQuestions: [],
      impacts: [],
      projection: {
        compact: "c",
        contract: { sectionID: "SEC-001" as SectionID, revision: 1, provides: [], requires: [], invariants: [], interfaces: [], decisions: [] },
      },
    };
    const error = await commitHostileProposal(world, { kind: "add_section_revision", revision }, { id: "SEC-001" as SectionID });
    expect(failCodes(error)).toContain("checkpoint_scope_invalid");
    // The section was not touched.
    expect(await world.store.getSectionRevision("PLAN-001" as never, { id: "SEC-001" as SectionID, revision: 1 })).toBeUndefined();
  });

  it("a nonexistent activeWork fails deterministically (tests 6-7)", async () => {
    // activeWork is commit-gated, so a mispointed focus can only exist as a
    // hostile/corrupted header. A store subclass injects it to prove the
    // controller's defense: the checkpoint refuses before any mutation.
    class GhostFocusStore extends InMemoryPlanStore {
      pointGhostFocus(id: string): void {
        const run = [...this.runs.values()].find((candidate) => candidate.stage === "detail");
        if (run) this.runs.set(run.id, { ...run, activeWork: { type: "section", id: id as never } });
      }
    }
    const store = new GhostFocusStore(() => FIXED);
    const world = makeWorld(store);
    await admittedStart(world.controller, "ses_ghost", GOAL);
    await world.controller.requestArchitecture("ses_ghost");
    const completion = await world.controller.prepareProposal("ses_ghost", {
      type: "architecture_completion",
      scope: { type: "architecture" },
      title: "Complete architecture",
      summary: "s",
      changes: [ARCH_CHANGE, { kind: "complete_architecture" }] as never,
    });
    const begun = await world.controller.beginProposalApproval("ses_ghost", completion.proposal.id);
    await world.controller.recordApprovalAndCommit("ses_ghost", completion.proposal.id, begun.request);
    const decomposition = await world.controller.prepareSectionDecomposition("ses_ghost", DECOMPOSITION);
    const dagBegun = await world.controller.beginProposalApproval("ses_ghost", decomposition.proposal.id);
    await world.controller.recordApprovalAndCommit("ses_ghost", decomposition.proposal.id, dagBegun.request);

    store.pointGhostFocus("SEC-042");
    await expect(
      world.controller.prepareSectionCheckpoint("ses_ghost", checkpointInput()),
    ).rejects.toSatisfy(
      (e: unknown) => isUltraPlanError(e) && e.code === "unknown_reference" && String((e as UltraPlanError).message).includes("SEC-042"),
    );
    // Outside the committed Section set (a section of no run at all).
    store.pointGhostFocus("SEC-999");
    await expect(
      world.controller.prepareSectionCheckpoint("ses_ghost", checkpointInput()),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "unknown_reference");
    // The real focus was untouched by both refusals.
    store.pointGhostFocus("SEC-002");
    await expect(world.controller.prepareSectionCheckpoint("ses_ghost", checkpointInput())).resolves.toBeDefined();
  });

  it("the first checkpoint uses design_checkpoint scoped to the exact SectionRef (tests 8-9)", async () => {
    const world = await checkpointWorld();
    const { prepared } = await prepareCheckpoint(world, "ses_ck");
    expect(prepared.proposal.type).toBe("design_checkpoint");
    expect(prepared.proposal.scope).toEqual({ id: "SEC-002" });
  });
});

// -----------------------------------------------------------------------------
// Draft validation (§8/§11/§12/§22/§23; tests 16-20 + boundary cases)
// -----------------------------------------------------------------------------

describe("checkpoint draft validation", () => {
  it("requires non-empty problem, design, and compact projection", async () => {
    const world = await checkpointWorld();
    for (const field of ["problem", "design"] as const) {
      await expect(
        world.controller.prepareSectionCheckpoint("ses_ck", checkpointInput({ [field]: "" })),
      ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "invalid_scope");
    }
    await expect(
      world.controller.prepareSectionCheckpoint("ses_ck", checkpointInput({ projection: { ...checkpointInput().projection, compact: " " } })),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "invalid_scope");
  });

  it("rejects duplicate interface names", async () => {
    const world = await checkpointWorld();
    await expect(
      world.controller.prepareSectionCheckpoint(
        "ses_ck",
        checkpointInput({ interfaces: [
          { name: "PlanStore", description: "a" },
          { name: "PlanStore", description: "b" },
        ] }),
      ),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "invalid_scope");
  });

  it("requires the EXACT structural dependency context: missing, extra, duplicate, and self edges are rejected (§12)", async () => {
    const world = await checkpointWorld();
    await expect(
      world.controller.prepareSectionCheckpoint("ses_ck", checkpointInput({ dependencies: [] })),
    ).rejects.toSatisfy(
      (e: unknown) => isUltraPlanError(e) && e.code === "invalid_scope" && String((e as UltraPlanError).message).includes("SEC-001"),
    );
    await expect(
      world.controller.prepareSectionCheckpoint(
        "ses_ck",
        checkpointInput({ dependencies: [
          { sectionID: "SEC-001" as SectionID, consumes: [] },
          { sectionID: "SEC-001" as SectionID, consumes: [] },
        ] }),
      ),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "invalid_scope");
    await expect(
      world.controller.prepareSectionCheckpoint(
        "ses_ck",
        checkpointInput({ dependencies: [
          { sectionID: "SEC-001" as SectionID, consumes: [] },
          { sectionID: "SEC-002" as SectionID, consumes: [] },
        ] }),
      ),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "invalid_scope");
    await expect(
      world.controller.prepareSectionCheckpoint(
        "ses_ck",
        checkpointInput({ dependencies: [{ sectionID: "SEC-002" as SectionID, consumes: [] }] }),
      ),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "invalid_scope");
  });

  it("rejects an unknown dependency section (unknown_reference)", async () => {
    const world = await checkpointWorld();
    await expect(
      world.controller.prepareSectionCheckpoint(
        "ses_ck",
        checkpointInput({ dependencies: [{ sectionID: "SEC-009" as SectionID, consumes: [] }] }),
      ),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "unknown_reference");
  });

  it("a consumes name the bound dependency contract does not provide is rejected (§11)", async () => {
    const world = await checkpointWorld();
    await commitCraftedRuntimeRevision(world, "ses_ck", 1, ["host-bindings"]);
    await expect(
      world.controller.prepareSectionCheckpoint(
        "ses_ck",
        checkpointInput({ dependencies: [{ sectionID: "SEC-001" as SectionID, consumes: ["durable-state"] }] }),
      ),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "invalid_scope");
  });

  it("invalid decision / question / impact references are rejected (tests 16-18)", async () => {
    const world = await checkpointWorld();
    await expect(
      world.controller.prepareSectionCheckpoint("ses_ck", checkpointInput({ decisions: ["DEC-099" as never] })),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "unknown_reference");
    await expect(
      world.controller.prepareSectionCheckpoint("ses_ck", checkpointInput({ openQuestions: ["Q-099" as never] })),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "unknown_reference");
    await expect(
      world.controller.prepareSectionCheckpoint("ses_ck", checkpointInput({ impacts: ["SEC-099" as never] })),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "unknown_reference");
  });

  it("contract invariants/interfaces/decisions must restate revision facts (tests 19-20, §11)", async () => {
    const world = await checkpointWorld();
    // Contract invariant absent from the revision.
    await expect(
      world.controller.prepareSectionCheckpoint(
        "ses_ck",
        checkpointInput({ projection: { ...checkpointInput().projection, contract: { ...checkpointInput().projection.contract, invariants: ["made-up invariant"] } } }),
      ),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "invalid_scope");
    // Contract interface not defined by the revision.
    await expect(
      world.controller.prepareSectionCheckpoint(
        "ses_ck",
        checkpointInput({ projection: { ...checkpointInput().projection, contract: { ...checkpointInput().projection.contract, interfaces: [{ name: "Ghost" }] } } }),
      ),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "invalid_scope");
    // Contract decision not referenced by the revision.
    await expect(
      world.controller.prepareSectionCheckpoint(
        "ses_ck",
        checkpointInput({ projection: { ...checkpointInput().projection, contract: { ...checkpointInput().projection.contract, decisions: [{ id: "DEC-001" as never, revision: 1 }] } } }),
      ),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "invalid_scope");
    // Contract decision citing the wrong committed revision.
    await expect(
      world.controller.prepareSectionCheckpoint(
        "ses_ck",
        checkpointInput({
          decisions: ["DEC-001" as never],
          projection: { ...checkpointInput().projection, contract: { ...checkpointInput().projection.contract, decisions: [{ id: "DEC-001" as never, revision: 2 }] } },
        }),
      ),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "unknown_reference");
    // providedBy pointing at another section.
    await expect(
      world.controller.prepareSectionCheckpoint(
        "ses_ck",
        checkpointInput({ projection: { ...checkpointInput().projection, contract: { ...checkpointInput().projection.contract, interfaces: [{ name: "PlanStore", providedBy: "SEC-001" as never }] } } }),
      ),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "invalid_scope");
  });
});

// -----------------------------------------------------------------------------
// Hash sensitivity (§25; tests 10-15)
// -----------------------------------------------------------------------------

describe("proposal hash covers every approved semantic (tests 10-15)", () => {
  it("changing any revision or projection semantic changes the hash", async () => {
    const world = await checkpointWorld();
    // Commit one decision + record one question so reference variants are valid.
    const decisionProposal = await world.controller.prepareProposal("ses_ck", {
      type: "design_checkpoint",
      scope: { type: "architecture" },
      title: "Decision",
      summary: "s",
      changes: [{ kind: "add_decision", content: { title: "Store shape", statement: "append-only", rationale: "durable" } }] as never,
    });
    const decisionBegun = await world.controller.beginProposalApproval("ses_ck", decisionProposal.proposal.id);
    await approveAndCommit(world, "ses_ck", decisionProposal.proposal.id, decisionBegun.request);
    await world.controller.recordQuestion("ses_ck", {
      question: "Which lock primitive?",
      blocking: false,
      scope: { type: "section", sectionID: "SEC-002" },
    });

    const base = (await world.controller.prepareSectionCheckpoint("ses_ck", checkpointInput())).hash;
    const variants: SectionCheckpointInput[] = [
      checkpointInput({ problem: "different problem" }),
      checkpointInput({ design: "different design" }),
      // Interface DESCRIPTION change (names stay contract-consistent).
      checkpointInput({ interfaces: [{ name: "PlanStore", description: "different description" }] }),
      checkpointInput({
        invariants: ["different invariant"],
        // The contract may only restate revision invariants — a changed
        // invariant list moves the contract citation with it (still hashed).
        projection: { ...checkpointInput().projection, contract: { ...checkpointInput().projection.contract, invariants: ["different invariant"] } },
      }),
      checkpointInput({ failureModes: [{ description: "different failure" }] }),
      checkpointInput({ dependencies: [{ sectionID: "SEC-001" as SectionID, consumes: ["different-consumption"] }] }),
      checkpointInput({ decisions: ["DEC-001" as never] }),
      checkpointInput({ openQuestions: ["Q-001" as never] }),
      checkpointInput({ impacts: ["SEC-001" as never] }),
      checkpointInput({ projection: { ...checkpointInput().projection, compact: "different compact" } }),
      checkpointInput({ projection: { ...checkpointInput().projection, contract: { ...checkpointInput().projection.contract, provides: ["different-provision"] } } }),
      checkpointInput({ projection: { ...checkpointInput().projection, contract: { ...checkpointInput().projection.contract, requires: ["different-requirement"] } } }),
      checkpointInput({ projection: { ...checkpointInput().projection, contract: { ...checkpointInput().projection.contract, interfaces: [] } } }),
      // A different SUBSET of revision invariants is a different contract.
      checkpointInput({ projection: { ...checkpointInput().projection, contract: { ...checkpointInput().projection.contract, invariants: ["approved revisions are immutable"] } } }),
    ];
    for (const [index, variant] of variants.entries()) {
      const hash = (await world.controller.prepareSectionCheckpoint("ses_ck", variant)).hash;
      expect(hash, `variant ${index}`).not.toBe(base);
    }
  });

  it("the hash binds the exact resulting revision number and the Harness-assigned dependency binding", async () => {
    const world = await checkpointWorld();
    // Same body, different resulting revision (first vs later checkpoint).
    await commitCraftedRuntimeRevision(world, "ses_ck", 1, ["durable-state"]);
    const first = (await world.controller.prepareSectionCheckpoint("ses_ck", checkpointInput())).hash;
    const secondPrepared = await prepareCheckpoint(world, "ses_ck");
    await approveAndCommit(world, "ses_ck", secondPrepared.prepared.proposal.id, secondPrepared.begun.request);
    const second = (await world.controller.prepareSectionCheckpoint("ses_ck", checkpointInput())).hash;
    expect(second).not.toBe(first);
    // Binding-only difference: a hostile crafted pair whose Dependency
    // contractRevision differs hashes differently.
    const run = (await world.store.getRun("PLAN-001" as never)) as PlanningRun;
    const withBinding: Proposal = {
      id: ProposalIDs.from(90),
      type: "design_checkpoint",
      scope: { id: "SEC-002" as SectionID },
      revision: 1,
      status: "ready",
      title: "t",
      summary: "s",
      changes: [
        {
          kind: "amend_section",
          supersedes: { id: "SEC-002" as SectionID, revision: 2 },
          revision: {
            sectionID: "SEC-002" as SectionID,
            revision: 3,
            status: "approved",
            createdAt: FIXED,
            problem: "p",
            design: "d",
            interfaces: [],
            invariants: [],
            failureModes: [],
            dependencies: [{ sectionID: "SEC-001" as SectionID, consumes: ["durable-state"], contractRevision: 1 }],
            decisions: [],
            openQuestions: [],
            impacts: [],
            projection: { compact: "c", contract: { sectionID: "SEC-002" as SectionID, revision: 3, provides: [], requires: [], invariants: [], interfaces: [], decisions: [] } },
          },
        },
      ],
      dependencies: [],
      impact: { affectedSections: [], affectedDecisions: [] },
      createdFrom: { id: run.headSnapshot as never },
    };
    const other: Proposal = structuredClone(withBinding);
    (other.changes[0] as Extract<ProposalChange, { kind: "amend_section" }>).revision.dependencies = [
      { sectionID: "SEC-001" as SectionID, consumes: ["durable-state"], contractRevision: 2 } as Dependency,
    ];
    expect(computeProposalHash(withBinding)).not.toBe(computeProposalHash(other));
  });
});

// -----------------------------------------------------------------------------
// First checkpoint commit + root state (tests 21-26)
// -----------------------------------------------------------------------------

describe("first checkpoint commit (tests 21-26)", () => {
  it("commits immutable SectionRevision@1 and activates the root without completing it (tests 21-25)", async () => {
    const world = await checkpointWorld();
    const { prepared, begun } = await prepareCheckpoint(world, "ses_ck");
    await approveAndCommit(world, "ses_ck", prepared.proposal.id, begun.request);

    const revision = await world.store.getSectionRevision("PLAN-001" as never, { id: "SEC-002" as SectionID, revision: 1 });
    expect(revision).toMatchObject({ sectionID: "SEC-002", revision: 1, status: "approved" });
    expect(revision?.projection.contract).toMatchObject({ sectionID: "SEC-002", revision: 1 });
    const root = await world.store.getSection("PLAN-001" as never, "SEC-002" as SectionID);
    expect(root).toMatchObject({ status: "active", currentRevision: 1, approvedRevision: 1 });
    // §18: approvedRevision does NOT mean the Section is complete.
    expect(root?.status).not.toBe("approved");
  });

  it("no completion occurs: stage stays detail, activeWork unchanged, no section completion commit (test 26)", async () => {
    const world = await checkpointWorld();
    const before = (await world.store.getRun("PLAN-001" as never)) as PlanningRun;
    const { prepared, begun } = await prepareCheckpoint(world, "ses_ck");
    const commit = await approveAndCommit(world, "ses_ck", prepared.proposal.id, begun.request);
    const after = (await world.store.getRun("PLAN-001" as never)) as PlanningRun;
    expect(after.stage).toBe("detail");
    expect(after.activeWork).toEqual(before.activeWork);
    expect(commit.changes.map((c) => c.kind)).toEqual(["add_section_revision"]);
    expect(commit.changes.some((c) => c.kind === "complete_section")).toBe(false);
  });

  it("the HEAD snapshot represents the checkpointed root (§27)", async () => {
    const world = await checkpointWorld();
    const { prepared, begun } = await prepareCheckpoint(world, "ses_ck");
    await approveAndCommit(world, "ses_ck", prepared.proposal.id, begun.request);
    const snapshot = await world.store.getHeadSnapshot("PLAN-001" as never);
    const roots = snapshot?.state.sectionRoots ?? [];
    expect(roots.map((r) => r.id)).toEqual(["SEC-001", "SEC-002"]);
    const sec2 = roots.find((r) => r.id === "SEC-002");
    expect(sec2).toMatchObject({ status: "active", currentRevision: 1, approvedRevision: 1 });
    // The exact revision reference stays the additive sectionRevisions map.
    expect(snapshot?.state.sectionRevisions).toEqual({ "SEC-002": 1 });
  });
});

// -----------------------------------------------------------------------------
// Later checkpoints (tests 27-31, §6/§17)
// -----------------------------------------------------------------------------

describe("later checkpoints use exact-revision amendment (tests 27-31)", () => {
  async function checkpointedWorld() {
    const world = await checkpointWorld();
    await commitCraftedRuntimeRevision(world, "ses_ck", 1, ["durable-state"]);
    const { prepared, begun } = await prepareCheckpoint(world, "ses_ck");
    await approveAndCommit(world, "ses_ck", prepared.proposal.id, begun.request);
    return world;
  }

  it("the second checkpoint freezes amend_section at supersedes.revision + 1 (test 27)", async () => {
    const world = await checkpointedWorld();
    const { prepared, begun } = await prepareCheckpoint(world, "ses_ck");
    const change = prepared.proposal.changes[0] as Extract<ProposalChange, { kind: "amend_section" }>;
    expect(change.kind).toBe("amend_section");
    expect(change.supersedes).toEqual({ id: "SEC-002", revision: 1 });
    expect(change.revision.revision).toBe(2);
    // The exact prior revision is bound BEFORE the user sees the proposal.
    expect(change.revision.dependencies[0]).toMatchObject({ sectionID: "SEC-001", contractRevision: 1 });
    await approveAndCommit(world, "ses_ck", prepared.proposal.id, begun.request);
  });

  it("revision 1 remains immutable; root pointers move to 2; history stays readable (tests 28-31)", async () => {
    const world = await checkpointedWorld();
    const revision1Before = await world.store.getSectionRevision("PLAN-001" as never, { id: "SEC-002" as SectionID, revision: 1 });
    const { prepared, begun } = await prepareCheckpoint(world, "ses_ck");
    await approveAndCommit(world, "ses_ck", prepared.proposal.id, begun.request);

    const revision1After = await world.store.getSectionRevision("PLAN-001" as never, { id: "SEC-002" as SectionID, revision: 1 });
    expect(revision1After).toEqual(revision1Before); // untouched bytes
    const revision2 = await world.store.getSectionRevision("PLAN-001" as never, { id: "SEC-002" as SectionID, revision: 2 });
    expect(revision2).toMatchObject({ revision: 2, status: "approved" });
    const root = await world.store.getSection("PLAN-001" as never, "SEC-002" as SectionID);
    expect(root).toMatchObject({ status: "active", currentRevision: 2, approvedRevision: 2 });
    // Exact historical contract (embedded in the immutable revision) readable.
    expect(revision1After?.projection.contract).toMatchObject({ sectionID: "SEC-002", revision: 1 });
    expect(revision2?.projection.contract.revision).toBe(2);
  });
});

// -----------------------------------------------------------------------------
// Dependency binding + validation semantics (tests 32-37, §13-§15, §34-§36)
// -----------------------------------------------------------------------------

describe("dependency binding and needs_review semantics (tests 32-37)", () => {
  it("a dependency without a contract does not block the checkpoint; the root commits needs_review (tests 32-33)", async () => {
    const world = await checkpointWorld(); // SEC-001 has no contract yet
    const { prepared, begun } = await prepareCheckpoint(world, "ses_ck");
    const change = prepared.proposal.changes[0] as Extract<ProposalChange, { kind: "add_section_revision" }>;
    // Explicit absence of the binding — never a fabricated contract.
    expect(change.revision.dependencies[0]).toEqual({ sectionID: "SEC-001", consumes: ["durable-state"] });
    await approveAndCommit(world, "ses_ck", prepared.proposal.id, begun.request);
    const root = await world.store.getSection("PLAN-001" as never, "SEC-002" as SectionID);
    expect(root?.validation).toBe("needs_review");
  });

  it("first contract appearing downstream keeps the dependent needs_review (§34)", async () => {
    const world = await checkpointWorld();
    const { prepared, begun } = await prepareCheckpoint(world, "ses_ck");
    await approveAndCommit(world, "ses_ck", prepared.proposal.id, begun.request);
    expect((await world.store.getSection("PLAN-001" as never, "SEC-002" as SectionID))?.validation).toBe("needs_review");
    // SEC-001's FIRST checkpoint produces its first contract.
    await commitCraftedRuntimeRevision(world, "ses_ck", 1, ["durable-state"]);
    // SEC-002 remains needs_review — it was NOT re-reviewed against the new
    // contract, and no downstream revision was deleted or regenerated.
    expect((await world.store.getSection("PLAN-001" as never, "SEC-002" as SectionID))?.validation).toBe("needs_review");
    expect(
      await world.store.getSectionRevision("PLAN-001" as never, { id: "SEC-002" as SectionID, revision: 1 }),
    ).toMatchObject({ revision: 1 });
  });

  it("a revalidation checkpoint binding the exact new contract restores valid (test 35)", async () => {
    const world = await checkpointWorld();
    const { prepared, begun } = await prepareCheckpoint(world, "ses_ck");
    await approveAndCommit(world, "ses_ck", prepared.proposal.id, begun.request);
    await commitCraftedRuntimeRevision(world, "ses_ck", 1, ["durable-state"]);
    expect((await world.store.getSection("PLAN-001" as never, "SEC-002" as SectionID))?.validation).toBe("needs_review");
    const revalidated = await prepareCheckpoint(world, "ses_ck");
    const change = revalidated.prepared.proposal.changes[0] as Extract<ProposalChange, { kind: "amend_section" }>;
    expect(change.revision.dependencies[0]).toMatchObject({ sectionID: "SEC-001", contractRevision: 1 });
    await approveAndCommit(world, "ses_ck", revalidated.prepared.proposal.id, revalidated.begun.request);
    expect((await world.store.getSection("PLAN-001" as never, "SEC-002" as SectionID))?.validation).toBe("valid");
  });

  it("a dependency contract CHANGE propagates needs_review; the old revision stays immutable (test 36-37)", async () => {
    const world = await checkpointWorld();
    await commitCraftedRuntimeRevision(world, "ses_ck", 1, ["durable-state"]);
    const { prepared, begun } = await prepareCheckpoint(world, "ses_ck");
    await approveAndCommit(world, "ses_ck", prepared.proposal.id, begun.request);
    expect((await world.store.getSection("PLAN-001" as never, "SEC-002" as SectionID))?.validation).toBe("valid");
    // SEC-001@2 changes the contract the dependent was designed against.
    await commitCraftedRuntimeRevision(world, "ses_ck", 2, ["durable-state", "host-events"]);
    expect((await world.store.getSection("PLAN-001" as never, "SEC-002" as SectionID))?.validation).toBe("needs_review");
    // No downstream revision deleted; SEC-002@1 remains readable and can be
    // re-validated by a future checkpoint binding SEC-001@2.
    expect(
      await world.store.getSectionRevision("PLAN-001" as never, { id: "SEC-002" as SectionID, revision: 1 }),
    ).toMatchObject({ revision: 1, status: "approved" });
  });

  it("the binding uses the dependency's EXACT approved revision at freeze (test 34)", async () => {
    const world = await checkpointWorld();
    await commitCraftedRuntimeRevision(world, "ses_ck", 1, ["durable-state"]);
    // First checkpoint binds SEC-001@1 exactly.
    const first = await prepareCheckpoint(world, "ses_ck");
    const firstChange = first.prepared.proposal.changes[0] as Extract<ProposalChange, { kind: "add_section_revision" }>;
    expect(firstChange.revision.dependencies[0]?.contractRevision).toBe(1);
    await approveAndCommit(world, "ses_ck", first.prepared.proposal.id, first.begun.request);
    // Advance the dependency to @2; the next checkpoint binds @2 — never an
    // unresolved "latest" reference, and never silently substituted.
    await commitCraftedRuntimeRevision(world, "ses_ck", 2, ["durable-state", "host-events"]);
    const secondPrepared = await prepareCheckpoint(world, "ses_ck");
    const second = secondPrepared.prepared.proposal.changes[0] as Extract<ProposalChange, { kind: "amend_section" }>;
    expect(second.revision.dependencies[0]?.contractRevision).toBe(2);
  });

  it("hostile engine bindings are refused: stale contractRevision, phantom binding, contract identity, and second add_section_revision", async () => {
    const world = await checkpointWorld();
    await commitCraftedRuntimeRevision(world, "ses_ck", 1, ["durable-state"]);
    // SEC-002@1 commits valid against SEC-001@1 (tool path).
    const { prepared, begun } = await prepareCheckpoint(world, "ses_ck");
    await approveAndCommit(world, "ses_ck", prepared.proposal.id, begun.request);

    const baseRevision: ApprovedSectionRevision = {
      sectionID: "SEC-002" as SectionID,
      revision: 2,
      status: "approved",
      createdAt: FIXED,
      problem: "p",
      design: "d",
      interfaces: [],
      invariants: [],
      failureModes: [],
      dependencies: [{ sectionID: "SEC-001" as SectionID, consumes: ["durable-state"] }],
      decisions: [],
      openQuestions: [],
      impacts: [],
      projection: {
        compact: "c",
        contract: { sectionID: "SEC-002" as SectionID, revision: 2, provides: [], requires: [], invariants: [], interfaces: [], decisions: [] },
      },
    };
    // Stale binding: claims SEC-001@2 while SEC-001 is approved at @1.
    const stale = structuredClone(baseRevision);
    stale.dependencies = [{ sectionID: "SEC-001" as SectionID, consumes: [], contractRevision: 2 }];
    expect(failCodes(await commitHostileProposal(
      world,
      { kind: "amend_section", supersedes: { id: "SEC-002" as SectionID, revision: 1 }, revision: stale },
      { id: "SEC-002" as SectionID },
    ))).toContain("change_invalid");
    // Phantom binding: claims a contract on a dependency with none.
    const phantom = structuredClone(baseRevision);
    phantom.dependencies = [{ sectionID: "SEC-999" as SectionID, consumes: [], contractRevision: 1 }];
    expect(failCodes(await commitHostileProposal(
      world,
      { kind: "amend_section", supersedes: { id: "SEC-002" as SectionID, revision: 1 }, revision: phantom },
      { id: "SEC-002" as SectionID },
    ))).toContain("change_invalid");
    // Contract identity mismatch: the projection claims another revision.
    const identity = structuredClone(baseRevision);
    identity.projection.contract.revision = 5;
    expect(failCodes(await commitHostileProposal(
      world,
      { kind: "amend_section", supersedes: { id: "SEC-002" as SectionID, revision: 1 }, revision: identity },
      { id: "SEC-002" as SectionID },
    ))).toContain("change_invalid");
    // A second add_section_revision on a section that already has revisions.
    expect(failCodes(await commitHostileProposal(
      world,
      { kind: "add_section_revision", revision: structuredClone(baseRevision) },
      { id: "SEC-002" as SectionID },
    ))).toContain("change_invalid");
    // And nothing was committed by any of them.
    expect(await world.store.getSectionRevision("PLAN-001" as never, { id: "SEC-002" as SectionID, revision: 2 })).toBeUndefined();
  });

  it("amend_section on a revisionless section is refused — no path crosses the streams (§43)", async () => {
    const world = await checkpointWorld(); // SEC-002 revisionless
    const hostile: ApprovedSectionRevision = {
      sectionID: "SEC-002" as SectionID,
      revision: 1,
      status: "approved",
      createdAt: FIXED,
      problem: "p",
      design: "d",
      interfaces: [],
      invariants: [],
      failureModes: [],
      dependencies: [],
      decisions: [],
      openQuestions: [],
      impacts: [],
      projection: {
        compact: "c",
        contract: { sectionID: "SEC-002" as SectionID, revision: 1, provides: [], requires: [], invariants: [], interfaces: [], decisions: [] },
      },
    };
    const error = await commitHostileProposal(
      world,
      { kind: "amend_section", supersedes: { id: "SEC-002" as SectionID, revision: 1 }, revision: hostile },
      { id: "SEC-002" as SectionID },
    );
    expect(failCodes(error)).toContain("unknown_reference");
    // add_section_revision must be revision 1 exactly.
    const wrongNumber = structuredClone(hostile);
    wrongNumber.revision = 2;
    expect(failCodes(await commitHostileProposal(
      world,
      { kind: "add_section_revision", revision: wrongNumber },
      { id: "SEC-002" as SectionID },
    ))).toContain("change_invalid");
  });
});

// -----------------------------------------------------------------------------
// Approval view (test 38, §24)
// -----------------------------------------------------------------------------

describe("approval view renders the full checkpoint deterministically (test 38)", () => {
  it("shows problem, design, interfaces, invariants, failure modes, bindings, projections, and contract", async () => {
    const world = await checkpointWorld();
    await commitCraftedRuntimeRevision(world, "ses_ck", 1, ["durable-state"]);
    const input = checkpointInput({
      decisions: ["DEC-001" as never],
      openQuestions: ["Q-001" as never],
      impacts: ["SEC-001" as never],
    });
    // Seed one committed decision + one open question for the references.
    const decisionProposal = await world.controller.prepareProposal("ses_ck", {
      type: "design_checkpoint",
      scope: { type: "architecture" },
      title: "Decision",
      summary: "s",
      changes: [{ kind: "add_decision", content: { title: "Store shape", statement: "append-only", rationale: "durable" } }] as never,
    });
    const decisionBegun = await world.controller.beginProposalApproval("ses_ck", decisionProposal.proposal.id);
    await approveAndCommit(world, "ses_ck", decisionProposal.proposal.id, decisionBegun.request);
    await world.controller.recordQuestion("ses_ck", {
      question: "Which lock primitive?",
      blocking: false,
      scope: { type: "section", sectionID: "SEC-002" },
    });
    const { prepared } = await prepareCheckpoint(world, "ses_ck", input);
    const view = renderProposalForApproval(prepared.proposal);
    expect(view).toContain("ADD SECTION REVISION SEC-002@1 (first checkpoint)");
    expect(view).toContain("Problem:");
    expect(view).toContain("Design:");
    expect(view).toContain("Interfaces:");
    expect(view).toContain("Invariants:");
    expect(view).toContain("Failure modes:");
    expect(view).toContain("Dependency bindings:");
    expect(view).toContain("SEC-001@1 contract");
    expect(view).toContain("Decisions: DEC-001");
    expect(view).toContain("Open questions: Q-001");
    expect(view).toContain("Impacts: SEC-001");
    expect(view).toContain("Compact projection:");
    expect(view).toContain("Contract:");
    expect(view).toContain("provides:");
    expect(view).toContain("requires:");
    expect(view).toContain("interfaces:");
    expect(view).toContain("decisions:");
    expect(view).toContain(`Approval hash: ${prepared.hash}`);
    // Deterministic: the same proposal renders identically twice.
    expect(renderProposalForApproval(prepared.proposal)).toBe(view);
    // Unresolved dependency binding is explicit (never a fake contract).
    const unresolvedWorld = await checkpointWorld();
    const unresolved = await prepareCheckpoint(unresolvedWorld, "ses_ck");
    expect(renderProposalForApproval(unresolved.prepared.proposal)).toContain("SEC-001 unresolved (no contract yet)");
  });
});

// -----------------------------------------------------------------------------
// Plan Memory reads (tests 39-43, §26)
// -----------------------------------------------------------------------------

describe("plan memory reads (tests 39-43)", () => {
  it("reads the root without a revision, the exact revision, and refuses fake exactness (tests 39-42)", async () => {
    const world = await checkpointWorld();
    // 39: root read (no revision pointer yet).
    const rootRead = await world.controller.readMemory("ses_ck", { ref: { kind: "section", id: "SEC-002" } });
    expect((rootRead.artifacts[0]?.artifact as Section).currentRevision).toBeUndefined();
    expect(rootRead.artifacts[0]?.artifact).toMatchObject({ id: "SEC-002", status: "pending" });
    const { prepared, begun } = await prepareCheckpoint(world, "ses_ck");
    await approveAndCommit(world, "ses_ck", prepared.proposal.id, begun.request);

    // Exact historical revision read.
    const exact = await world.controller.readMemory("ses_ck", { ref: { kind: "section", id: "SEC-002", revision: 1 } });
    expect(exact.artifacts[0]?.artifact).toMatchObject({ sectionID: "SEC-002", revision: 1 });
    // 42: the exact contract rides canonically inside the revision.
    const revision = exact.artifacts[0]?.artifact as ApprovedSectionRevision;
    expect(revision.projection.contract).toMatchObject({ sectionID: "SEC-002", revision: 1 });
    // A nonexistent exact revision never resolves to latest.
    await expect(
      world.controller.readMemory("ses_ck", { ref: { kind: "section", id: "SEC-002", revision: 99 } }),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "unknown_reference");
  });

  it("dependency retrieval returns roots plus exact contracts, and explicit absence without fabrication (tests 40/43)", async () => {
    const world = await checkpointWorld();
    // 43: before SEC-001 has a contract, its root comes back with no revision
    // artifact and no fabricated contract.
    const before = await world.controller.readMemory("ses_ck", { dependenciesOf: "SEC-002" });
    const depRoot = before.artifacts.find((a) => a.ref.kind === "section" && "id" in a.ref && a.ref.id === "SEC-001");
    expect((depRoot?.artifact as Section).approvedRevision).toBeUndefined(); // explicit absence, never a fake contract
    expect(depRoot?.artifact).toMatchObject({ id: "SEC-001" });
    expect(before.artifacts.some((a) => "revision" in a.ref)).toBe(false);
    // 40: after the dependency's first checkpoint, the exact revision (with
    // its contract) is returned.
    await commitCraftedRuntimeRevision(world, "ses_ck", 1, ["durable-state"]);
    const after = await world.controller.readMemory("ses_ck", { dependenciesOf: "SEC-002" });
    const depRevision = after.artifacts.find((a) => "revision" in a.ref);
    expect(depRevision?.artifact).toMatchObject({ sectionID: "SEC-001", revision: 1 });
    expect((depRevision?.artifact as ApprovedSectionRevision).projection.contract.provides).toEqual(["durable-state"]);
  });
});

// -----------------------------------------------------------------------------
// Rejection, failure atomicity, idempotency (tests 44-47)
// -----------------------------------------------------------------------------

describe("rejection, failure atomicity, idempotency (tests 44-47)", () => {
  it("user rejection mutates no SectionRevision (test 44)", async () => {
    const world = await checkpointWorld();
    const { prepared, begun } = await prepareCheckpoint(world, "ses_ck");
    await world.controller.rejectProposal("ses_ck", prepared.proposal.id, begun.request);
    expect(await world.store.getSectionRevision("PLAN-001" as never, { id: "SEC-002" as SectionID, revision: 1 })).toBeUndefined();
    expect((await world.store.getSection("PLAN-001" as never, "SEC-002" as SectionID))?.status).toBe("pending");
    expect((await world.store.getRun("PLAN-001" as never))?.headCommit).toBe("COMMIT-002");
  });

  it("a failed commit mutates nothing and the approval stays retriable (tests 45-46)", async () => {
    class FlakyStore extends InMemoryPlanStore {
      armed = false;
      protected override publishTransaction(
        ...args: Parameters<InMemoryPlanStore["publishTransaction"]>
      ): PlanCommit {
        if (this.armed) {
          this.armed = false;
          throw new UltraPlanError("store_busy", "injected publication failure");
        }
        return super.publishTransaction(...args);
      }
    }
    const store = new FlakyStore(() => FIXED);
    const world = makeWorld(store);
    let run = (await admittedStart(world.controller, "ses_flaky", GOAL)).run;
    await world.controller.requestArchitecture("ses_flaky");
    const completion = await world.controller.prepareProposal("ses_flaky", {
      type: "architecture_completion",
      scope: { type: "architecture" },
      title: "Complete architecture",
      summary: "s",
      changes: [ARCH_CHANGE, { kind: "complete_architecture" }] as never,
    });
    const begun0 = await world.controller.beginProposalApproval("ses_flaky", completion.proposal.id);
    await world.controller.recordApprovalAndCommit("ses_flaky", completion.proposal.id, begun0.request);
    const decomposition = await world.controller.prepareSectionDecomposition("ses_flaky", DECOMPOSITION);
    const dagBegun = await world.controller.beginProposalApproval("ses_flaky", decomposition.proposal.id);
    await world.controller.recordApprovalAndCommit("ses_flaky", decomposition.proposal.id, dagBegun.request);
    run = (await store.getRun(run.id)) as PlanningRun;

    const { prepared, begun } = await prepareCheckpoint(world, "ses_flaky");
    await world.controller.recordApproval("ses_flaky", prepared.proposal.id, begun.request);
    store.armed = true;
    await expect(world.controller.commitApprovedProposal("ses_flaky", prepared.proposal.id)).rejects.toSatisfy(
      (e: unknown) => isUltraPlanError(e) && e.code === "store_busy",
    );
    // Zero partial mutation.
    expect(await store.getSectionRevision(run.id, { id: "SEC-002" as SectionID, revision: 1 })).toBeUndefined();
    expect((await store.getSection(run.id, "SEC-002" as SectionID))?.status).toBe("pending");
    expect((await store.getRun(run.id))?.headCommit).toBe("COMMIT-002");
    expect((await store.getProposal(run.id, prepared.proposal.id))?.status).toBe("awaiting_approval");
    // The SAME durable approval commits on retry — no re-approval needed.
    const retry = await world.controller.commitApprovedProposal("ses_flaky", prepared.proposal.id);
    expect(retry.commit.changes.map((c) => c.kind)).toEqual(["add_section_revision"]);
    expect((await store.getSection(run.id, "SEC-002" as SectionID))?.status).toBe("active");
  });

  it("an exact commit retry is idempotent (test 47)", async () => {
    const world = await checkpointWorld();
    const { prepared, begun } = await prepareCheckpoint(world, "ses_ck");
    const first = await approveAndCommit(world, "ses_ck", prepared.proposal.id, begun.request);
    // Exact retry: same proposal + same approval → the SAME commit, and the
    // engine does not re-apply anything (recordApproval stays untouched).
    const retry = await world.controller.commitApprovedProposal("ses_ck", prepared.proposal.id);
    expect(retry.commit.id).toBe(first.id);
    expect(await world.store.listCommits("PLAN-001" as never)).toHaveLength(3); // completion, DAG, checkpoint
    expect(await world.store.getSectionRevision("PLAN-001" as never, { id: "SEC-002" as SectionID, revision: 1 })).toMatchObject({ revision: 1 });
  });
});

// -----------------------------------------------------------------------------
// Capability surface, L0, status (tests 54-57)
// -----------------------------------------------------------------------------

describe("capability surface, L0 guidance, status rendering (tests 54-57)", () => {
  it("revisionless sections expose no meaningful completion; reopen refuses non-approved targets (test 54, Phase 2E2 §7 + 2G §49)", async () => {
    const world = await checkpointWorld(); // active section is REVISIONLESS
    // A revisionless Section has no approved checkpoint to complete — the
    // capability is withheld (no meaningful completion exists).
    await expect(
      world.controller.requestCompletion("ses_ck", { kind: "section" }),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "capability_not_available");
    // Phase 2G §49 restored request_reopen in section-ready detail, but a
    // pending revisionless Section cannot satisfy the reopen target gate —
    // the controller rejects with the precise error instead of hiding the
    // operation.
    await expect(
      world.controller.requestReopen("ses_ck", { sectionID: "SEC-002" }),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "invalid_scope");
  });

  it("the dedicated checkpoint tool is contracted, registered, and gated to section-ready detail", async () => {
    const world = makeWorld();
    const tools = createUltraPlanTools(world.controller);
    expect(TOOL_CONTRACTS["ultraplan_prepare_section_checkpoint"]).toMatchObject({
      authority: "proposal_intent",
      capability: "prepare_section_checkpoint",
      requiresActiveRun: true,
    });
    expect(TOOL_CONTRACTS["ultraplan_prepare_section_checkpoint"]?.allowedStages).toEqual(["detail"]);
    expect(tools["ultraplan_prepare_section_checkpoint"]).toBeDefined();
  });

  it("L0 active-section guidance is deterministic and names the checkpoint operation (test 55)", async () => {
    const world = await checkpointWorld();
    const run = (await world.store.getRun("PLAN-001" as never)) as PlanningRun;
    const root = (await world.store.getSection("PLAN-001" as never, "SEC-002" as SectionID)) as Section;
    const input = {
      run,
      activeSection: {
        id: root.id,
        title: root.title,
        objective: root.objective,
        dependencies: root.dependencies,
        validation: root.validation,
        dependencyContracts: [{ id: "SEC-001" }],
      },
    };
    const first = renderPlanningProtocol(input);
    expect(renderPlanningProtocol(input)).toBe(first);
    expect(first).toContain("SECTION DESIGN");
    expect(first).toContain("SEC-001 no contract yet");
    expect(first).toContain("ultraplan_prepare_section_checkpoint");
    expect(first).toContain("checkpoint approval is NOT Section completion");
    // Checkpointed substate names the exact next revision.
    await commitCraftedRuntimeRevision(world, "ses_ck", 1, ["durable-state"]);
    const { prepared, begun } = await prepareCheckpoint(world, "ses_ck");
    await approveAndCommit(world, "ses_ck", prepared.proposal.id, begun.request);
    const checkpointed = renderPlanningProtocol({
      run: (await world.store.getRun("PLAN-001" as never)) as PlanningRun,
      activeSection: {
        id: "SEC-002",
        title: root.title,
        objective: root.objective,
        dependencies: root.dependencies,
        currentRevision: 1,
        validation: "valid",
        dependencyContracts: [{ id: "SEC-001", revision: 1 }],
      },
    });
    expect(checkpointed).toContain("Current approved checkpoint: SEC-002@1");
    expect(checkpointed).toContain("immutable revision 2");
    expect(checkpointed).toContain("SEC-001@1 approved");
  });

  it("the real tool execution surface freezes and commits a checkpoint through the approval gateway (§47)", async () => {
    const world = await checkpointWorld();
    const tools = createUltraPlanTools(world.controller);
    const checkpointTool = tools["ultraplan_prepare_section_checkpoint"] as unknown as {
      execute: (args: Record<string, unknown>, context: unknown) => Promise<{ metadata: Record<string, unknown>; output: string }>;
    };
    const prepared = await checkpointTool.execute(
      {
        problem: "Planning state must survive restarts",
        design: "Append-only document with atomic rename",
        interfaces: [{ name: "PlanStore", description: "storage boundary" }],
        invariants: ["HEAD moves last"],
        failureModes: [],
        dependencies: [{ sectionID: "SEC-001", consumes: [] }],
        decisions: [],
        openQuestions: [],
        impacts: [],
        compactProjection: "durable plan memory",
        contract: {
          provides: ["durable-plan-memory"],
          requires: [],
          invariants: ["HEAD moves last"],
          interfaces: [{ name: "PlanStore" }],
          decisions: [],
        },
      },
      fakeToolContext("ses_ck"),
    );
    expect(prepared.metadata["status"]).toBe("ready");
    expect(prepared.output).toContain("ADD SECTION REVISION SEC-002@1 (first checkpoint)");

    // Structured user allow through the same gateway.
    const asks: CapturedAsk[] = [];
    const approvalTool = tools["ultraplan_request_user_approval"] as unknown as {
      execute: (args: { proposalID: string }, context: unknown) => Promise<{ metadata: Record<string, unknown> }>;
    };
    const result = await approvalTool.execute(
      { proposalID: prepared.metadata["proposalID"] as string },
      fakeToolContext("ses_ck", {
        ask: async (input: CapturedAsk) => {
          asks.push(input);
        },
      }),
    );
    expect(asks[0]?.always).toEqual([]);
    expect(asks[0]?.metadata["approvalView"]).toContain("Dependency bindings:");
    expect(result.metadata["commitID"]).toBeDefined();
    const root = await world.store.getSection("PLAN-001" as never, "SEC-002" as SectionID);
    expect(root).toMatchObject({ status: "active", currentRevision: 1, approvedRevision: 1 });
  });

  it("status renders the revisionless state correctly (test 56)", async () => {
    const world = await checkpointWorld();
    const run = (await world.store.getRun("PLAN-001" as never)) as PlanningRun;
    const root = (await world.store.getSection("PLAN-001" as never, "SEC-002" as SectionID)) as Section;
    const status = renderStatus(run, { activeSection: root });
    expect(status).toContain("Stage: detail");
    expect(status).toContain("Active work: SEC-002");
    expect(status).toContain("Section: SEC-002 pending");
    expect(status).toContain("Revision: none");
    expect(status).toContain("Validation: valid");
    expect(status).not.toContain("completed");
  });

  it("status renders the checkpointed state correctly (test 57)", async () => {
    const world = await checkpointWorld();
    const { prepared, begun } = await prepareCheckpoint(world, "ses_ck");
    await approveAndCommit(world, "ses_ck", prepared.proposal.id, begun.request);
    const run = (await world.store.getRun("PLAN-001" as never)) as PlanningRun;
    const root = (await world.store.getSection("PLAN-001" as never, "SEC-002" as SectionID)) as Section;
    const status = renderStatus(run, { activeSection: root });
    expect(status).toContain("Section: SEC-002 active");
    expect(status).toContain("Revision: SEC-002@1 approved checkpoint");
    expect(status).toContain("Validation: needs_review"); // SEC-001 has no contract
  });
});

// -----------------------------------------------------------------------------
// Durable recovery (§39; tests 48-50) + §48 PRIMARY integration + concurrency
// -----------------------------------------------------------------------------

describe("durable checkpoint recovery (§39), PRIMARY integration (§48), concurrency (§41)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "ultraplan-ck-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  function openStore(dbFile: string): DurablePlanStore {
    return new DurablePlanStore(dbFile, { now: () => FIXED });
  }

  it("§48 PRIMARY: durable checkpoint, close/reopen identity, then an immutable second checkpoint", async () => {
    const dbFile = path.join(dir, "plan-store.json");
    const store = openStore(dbFile);
    const world = makeWorld(store);
    let run = (await admittedStart(world.controller, "ses_primary", GOAL)).run;
    await world.controller.requestArchitecture("ses_primary");
    const completion = await world.controller.prepareProposal("ses_primary", {
      type: "architecture_completion",
      scope: { type: "architecture" },
      title: "Complete architecture",
      summary: "s",
      changes: [ARCH_CHANGE, { kind: "complete_architecture" }] as never,
    });
    const begun0 = await world.controller.beginProposalApproval("ses_primary", completion.proposal.id);
    await world.controller.recordApprovalAndCommit("ses_primary", completion.proposal.id, begun0.request);
    const decomposition = await world.controller.prepareSectionDecomposition("ses_primary", DECOMPOSITION);
    const dagBegun = await world.controller.beginProposalApproval("ses_primary", decomposition.proposal.id);
    await world.controller.recordApprovalAndCommit("ses_primary", decomposition.proposal.id, dagBegun.request);
    run = (await store.getRun(run.id)) as PlanningRun;
    expect(run.activeWork).toEqual({ type: "section", id: "SEC-002" });

    // prepare → exact SEC-002@1 frozen (compact + contract) → structured allow → commit.
    const { prepared, begun } = await prepareCheckpoint(world, "ses_primary");
    expect(prepared.proposal.changes[0]).toMatchObject({ kind: "add_section_revision" });
    const commit = await approveAndCommit(world, "ses_primary", prepared.proposal.id, begun.request);
    const root = await store.getSection(run.id, "SEC-002" as SectionID);
    expect(root).toMatchObject({ status: "active", currentRevision: 1, approvedRevision: 1 });

    const before = {
      run: await store.getRun(run.id),
      sections: await store.listSections(run.id),
      revision: await store.getSectionRevision(run.id, { id: "SEC-002" as SectionID, revision: 1 }),
      snapshot: await store.getHeadSnapshot(run.id),
      proposal: await store.getProposal(run.id, prepared.proposal.id),
      events: await store.listEvents(run.id),
    };

    store.close();
    const reopened = openStore(dbFile);
    await reopened.open();
    expect(await reopened.getRun(run.id)).toEqual(before.run);
    expect(await reopened.listSections(run.id)).toEqual(before.sections);
    expect(await reopened.getSectionRevision(run.id, { id: "SEC-002" as SectionID, revision: 1 })).toEqual(before.revision);
    expect(await reopened.getHeadSnapshot(run.id)).toEqual(before.snapshot);
    expect(await reopened.getProposal(run.id, prepared.proposal.id)).toEqual(before.proposal);
    // Same HEAD; the snapshot carries the checkpointed root pointers.
    expect(before.run?.headCommit).toBe(commit.id);
    expect(before.snapshot?.state.sectionRoots?.find((r) => r.id === "SEC-002")).toMatchObject({
      status: "active",
      currentRevision: 1,
      approvedRevision: 1,
    });

    // Second checkpoint through the reopened store: SEC-002@2, revision 1 immutable.
    const reopenedWorld = makeWorld(reopened);
    const secondPrepared = await reopenedWorld.controller.prepareSectionCheckpoint("ses_primary", checkpointInput());
    const secondChange = secondPrepared.proposal.changes[0] as Extract<ProposalChange, { kind: "amend_section" }>;
    expect(secondChange.kind).toBe("amend_section");
    expect(secondChange.supersedes).toEqual({ id: "SEC-002", revision: 1 });
    expect(secondChange.revision.revision).toBe(2);
    const secondBegun = await reopenedWorld.controller.beginProposalApproval("ses_primary", secondPrepared.proposal.id);
    await reopenedWorld.controller.recordApprovalAndCommit("ses_primary", secondPrepared.proposal.id, secondBegun.request);
    expect(await reopened.getSectionRevision(run.id, { id: "SEC-002" as SectionID, revision: 1 })).toEqual(before.revision);
    expect((await reopened.getSection(run.id, "SEC-002" as SectionID))?.currentRevision).toBe(2);
    reopened.close();
  });

  it("a ready/awaiting checkpoint proposal keeps its exact hash across restart (§39)", async () => {
    const dbFile = path.join(dir, "plan-store.json");
    const store = openStore(dbFile);
    const world = makeWorld(store);
    let run = (await admittedStart(world.controller, "ses_restart", GOAL)).run;
    await world.controller.requestArchitecture("ses_restart");
    const completion = await world.controller.prepareProposal("ses_restart", {
      type: "architecture_completion",
      scope: { type: "architecture" },
      title: "Complete architecture",
      summary: "s",
      changes: [ARCH_CHANGE, { kind: "complete_architecture" }] as never,
    });
    const begun0 = await world.controller.beginProposalApproval("ses_restart", completion.proposal.id);
    await world.controller.recordApprovalAndCommit("ses_restart", completion.proposal.id, begun0.request);
    const decomposition = await world.controller.prepareSectionDecomposition("ses_restart", DECOMPOSITION);
    const dagBegun = await world.controller.beginProposalApproval("ses_restart", decomposition.proposal.id);
    await world.controller.recordApprovalAndCommit("ses_restart", decomposition.proposal.id, dagBegun.request);
    run = (await store.getRun(run.id)) as PlanningRun;
    const { prepared } = await prepareCheckpoint(world, "ses_restart");
    // The helper already moved the proposal to awaiting_approval; no approval
    // is recorded before the restart.
    store.close();

    const reopened = openStore(dbFile);
    await reopened.open();
    const proposal = await reopened.getProposal(run.id, prepared.proposal.id);
    expect(proposal?.status).toBe("awaiting_approval");
    expect(proposal?.hash).toBe(prepared.hash);
    expect(computeProposalHash(proposal as Proposal)).toBe(prepared.hash);
    reopened.close();
  });

  it("downstream needs_review survives restart (§39)", async () => {
    const dbFile = path.join(dir, "plan-store.json");
    const store = openStore(dbFile);
    const world = makeWorld(store);
    let run = (await admittedStart(world.controller, "ses_prop", GOAL)).run;
    await world.controller.requestArchitecture("ses_prop");
    const completion = await world.controller.prepareProposal("ses_prop", {
      type: "architecture_completion",
      scope: { type: "architecture" },
      title: "Complete architecture",
      summary: "s",
      changes: [ARCH_CHANGE, { kind: "complete_architecture" }] as never,
    });
    const begun0 = await world.controller.beginProposalApproval("ses_prop", completion.proposal.id);
    await world.controller.recordApprovalAndCommit("ses_prop", completion.proposal.id, begun0.request);
    const decomposition = await world.controller.prepareSectionDecomposition("ses_prop", DECOMPOSITION);
    const dagBegun = await world.controller.beginProposalApproval("ses_prop", decomposition.proposal.id);
    await world.controller.recordApprovalAndCommit("ses_prop", decomposition.proposal.id, dagBegun.request);
    run = (await store.getRun(run.id)) as PlanningRun;
    const { prepared, begun } = await prepareCheckpoint(world, "ses_prop");
    await approveAndCommit(world, "ses_prop", prepared.proposal.id, begun.request);
    await commitCraftedRuntimeRevision(world, "ses_prop", 1, ["durable-state"]);
    expect((await store.getSection(run.id, "SEC-002" as SectionID))?.validation).toBe("needs_review");
    const before = {
      run: await store.getRun(run.id),
      sections: await store.listSections(run.id),
    };
    store.close();
    const reopened = openStore(dbFile);
    await reopened.open();
    expect(await reopened.getRun(run.id)).toEqual(before.run);
    expect(await reopened.listSections(run.id)).toEqual(before.sections);
    expect((await reopened.getSection(run.id, "SEC-002" as SectionID))?.validation).toBe("needs_review");
    reopened.close();
  });

  it("a stale competing checkpoint loses via HEAD protection — no second competing revision, no merge (§41)", async () => {
    const dbFile = path.join(dir, "plan-store.json");
    const storeA = openStore(dbFile);
    const storeB = openStore(dbFile);
    const worldA = makeWorld(storeA);
    let run = (await admittedStart(worldA.controller, "ses_race", GOAL)).run;
    await worldA.controller.requestArchitecture("ses_race");
    const completion = await worldA.controller.prepareProposal("ses_race", {
      type: "architecture_completion",
      scope: { type: "architecture" },
      title: "Complete architecture",
      summary: "s",
      changes: [ARCH_CHANGE, { kind: "complete_architecture" }] as never,
    });
    const begun0 = await worldA.controller.beginProposalApproval("ses_race", completion.proposal.id);
    await worldA.controller.recordApprovalAndCommit("ses_race", completion.proposal.id, begun0.request);
    const decomposition = await worldA.controller.prepareSectionDecomposition("ses_race", DECOMPOSITION);
    const dagBegun = await worldA.controller.beginProposalApproval("ses_race", decomposition.proposal.id);
    await worldA.controller.recordApprovalAndCommit("ses_race", decomposition.proposal.id, dagBegun.request);
    run = (await storeA.getRun(run.id)) as PlanningRun;

    // Both instances observe the SAME revisionless state and freeze a first
    // checkpoint for SEC-002 (same resulting revision 1).
    const worldB = makeWorld(storeB);
    const prepA = await prepareCheckpoint(worldA, "ses_race");
    const prepB = await prepareCheckpoint(worldB, "ses_race");
    expect(prepB.prepared.proposal.id).not.toBe(prepA.prepared.proposal.id);
    expect(
      (prepB.prepared.proposal.changes[0] as Extract<ProposalChange, { kind: "add_section_revision" }>).revision.revision,
    ).toBe(1);

    // A commits first.
    await approveAndCommit(worldA, "ses_race", prepA.prepared.proposal.id, prepA.begun.request);

    // B commits its stale proposal: HEAD protection refuses it — B must NOT
    // create a second competing revision 1, and nothing merges or renumbers.
    await worldB.controller.recordApproval("ses_race", prepB.prepared.proposal.id, prepB.begun.request);
    await expect(worldB.controller.commitApprovedProposal("ses_race", prepB.prepared.proposal.id)).rejects.toSatisfy(
      (e: unknown) => failCodes(e).includes("head_snapshot_mismatch"),
    );
    const revisions = [];
    for (let revision = 1; revision <= 3; revision++) {
      revisions.push(await storeA.getSectionRevision(run.id, { id: "SEC-002" as SectionID, revision }));
    }
    expect(revisions.filter(Boolean)).toHaveLength(1);
    expect((await storeA.getSection(run.id, "SEC-002" as SectionID))?.currentRevision).toBe(1);
    storeA.close();
    storeB.close();
  });
});
