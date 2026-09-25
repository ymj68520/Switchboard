/**
 * Phase 2D — Dynamic Section DAG Generation & Detail-Stage Admission.
 *
 * Covers the initial decomposition workflow: draft-local keys → Harness-
 * assigned SEC ids → resolved dependency edges → full DAG validation at
 * freeze AND at commit → one atomic design_checkpoint proposal → explicit
 * user approval → one PlanCommit publishing Section roots + run.sections +
 * activeWork + snapshot + HEAD together (stage stays detail). Durable
 * restart/crash/concurrency live in the later describes and in
 * durable-crash.test.ts (section-decomposition probe mode).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ApprovalIDs,
  DurablePlanStore,
  FORBIDDEN_TOOL_NAMES,
  InMemoryObservationLedger,
  InMemoryPlanStore,
  ProposalIDs,
  SectionIDs,
  TOOL_CONTRACTS,
  UltraPlanError,
  computeProposalHash,
  createUltraPlanTools,
  isUltraPlanError,
  renderPlanningProtocol,
  renderProposalForApproval,
  renderStatus,
} from "../src/index.js";
import type { PlanCommit, PlanningRun, Proposal } from "../src/index.js";
import { UltraPlanController } from "../src/core/controller.js";
import { transitionStage } from "../src/core/state-machine.js";
import type { ProposalChange, SectionDecompositionInput } from "../src/index.js";
import { admittedStart, fakeToolContext } from "./helpers.js";
import type { CapturedAsk } from "./helpers.js";

const FIXED = "2026-09-25T11:00:00.000Z";
const GOAL = "Build the durable planning harness";

function makeWorld(store?: InMemoryPlanStore) {
  const planStore = store ?? new InMemoryPlanStore(() => FIXED);
  const ledger = new InMemoryObservationLedger();
  const controller = new UltraPlanController({ store: planStore, ledger, now: () => FIXED });
  return { store: planStore, ledger, controller };
}

const ARCH_CHANGE = {
  kind: "add_architecture" as const,
  content: {
    architecture: {
      summary: "Decomposition target",
      components: [{ name: "Core", summary: "kernel" }],
      boundaries: [],
      dataFlows: [],
      principles: [],
    },
  },
};

/**
 * The Phase 2D starting state (brief §0): stage=detail, architecture=ARCH@1,
 * sections=[]. Reached through the REAL Phase 2C workflow.
 */
async function detailWorld(world: ReturnType<typeof makeWorld> = makeWorld(), sessionID = "ses_dec") {
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
  run = (await world.store.getRun(run.id)) as PlanningRun;
  expect(run.stage).toBe("detail");
  expect(run.sections).toHaveLength(0);
  return { ...world, run };
}

const THREE_SECTION_DECOMPOSITION: SectionDecompositionInput = {
  sections: [
    { key: "runtime-integration", title: "Runtime Integration", objective: "bind to the OpenCode host" },
    { key: "plan-memory", title: "Plan Memory", objective: "durable authoritative state", dependsOn: ["runtime-integration"] },
    { key: "context-assembly", title: "Context Assembly", objective: "deterministic model context", dependsOn: ["plan-memory"] },
  ],
  initialSection: "runtime-integration",
};

async function prepareAwaiting(
  world: ReturnType<typeof makeWorld>,
  sessionID: string,
  input: SectionDecompositionInput = THREE_SECTION_DECOMPOSITION,
) {
  const prepared = await world.controller.prepareSectionDecomposition(sessionID, input);
  const begun = await world.controller.beginProposalApproval(sessionID, prepared.proposal.id);
  const { approval } = await world.controller.recordApproval(sessionID, prepared.proposal.id, begun.request);
  return { prepared, begun, approval };
}

function failCodes(error: unknown): string[] {
  if (!isUltraPlanError(error)) return [];
  const failures = error.detail?.failures as { code: string }[] | undefined;
  return failures?.map((f) => f.code) ?? [];
}

describe("detail admission and decomposition preconditions (tests 1-4)", () => {
  it("detail after Architecture completion begins with zero Sections (test 1)", async () => {
    const world = await detailWorld();
    const run = await world.store.findActiveRunBySession("ses_dec");
    expect(run?.stage).toBe("detail");
    expect(run?.sections).toHaveLength(0);
    expect(run?.activeWork).toBeUndefined();
    expect(await world.store.getArchitecture("PLAN-001" as never)).toMatchObject({ id: "ARCH", revision: 1, status: "approved" });
  });

  it("decomposition preparation requires stage=detail (test 2)", async () => {
    const world = makeWorld();
    await admittedStart(world.controller, "ses_arch", GOAL);
    await world.controller.requestArchitecture("ses_arch");
    await expect(
      world.controller.prepareSectionDecomposition("ses_arch", THREE_SECTION_DECOMPOSITION),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "capability_not_available");
  });

  it("decomposition requires an exact committed Architecture (test 3)", async () => {
    const world = makeWorld();
    let run = (await admittedStart(world.controller, "ses_noarch", GOAL)).run;
    run = await world.store.saveRun(transitionStage(run, "architecture"));
    await world.store.saveRun(transitionStage(run, "detail"));
    // detail/decomposition-needed grants the capability, but there is no
    // committed Architecture to scope the decomposition to.
    await expect(
      world.controller.prepareSectionDecomposition("ses_noarch", THREE_SECTION_DECOMPOSITION),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "unknown_reference");
  });

  it("a decomposition scoped to a different Architecture revision fails the commit (test 4)", async () => {
    const world = await detailWorld();
    const run = (await world.store.getRun("PLAN-001" as never)) as PlanningRun;
    // Hostile direct engine input: scope ARCH@2 against committed ARCH@1.
    const proposal: Proposal = {
      id: ProposalIDs.from(9),
      type: "design_checkpoint",
      scope: { id: "ARCH", revision: 2 },
      revision: 1,
      status: "awaiting_approval",
      title: "stale decomposition",
      summary: "s",
      changes: [
        {
          kind: "add_section",
          section: {
            id: SectionIDs.from(1),
            title: "X",
            objective: "x",
            dependencies: [],
            status: "pending",
            validation: "valid",
          },
        },
      ] as ProposalChange[],
      dependencies: [],
      impact: { affectedSections: [], affectedDecisions: [] },
      createdFrom: { id: run.headSnapshot as never },
    };
    proposal.hash = computeProposalHash(proposal);
    await world.store.saveProposal(run.id, proposal);
    await world.store.saveApproval(run.id, {
      id: ApprovalIDs.from(9),
      proposalID: proposal.id,
      proposalRevision: 1,
      proposalHash: proposal.hash,
      actor: "user",
      createdAt: FIXED,
    });
    await expect(
      world.store.commitTransaction({ planID: run.id, proposalID: proposal.id, approvalID: ApprovalIDs.from(9) }),
    ).rejects.toSatisfy((e: unknown) => failCodes(e).includes("architecture_scope_mismatch"));
  });
});

describe("draft-local DAG validation at freeze (tests 5-9)", () => {
  it("rejects a zero-section decomposition (test 5)", async () => {
    const world = await detailWorld();
    await expect(
      world.controller.prepareSectionDecomposition("ses_dec", { sections: [], initialSection: "x" }),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "invalid_scope");
  });

  it("rejects duplicate draft-local keys (test 6)", async () => {
    const world = await detailWorld();
    await expect(
      world.controller.prepareSectionDecomposition("ses_dec", {
        sections: [
          { key: "dup", title: "A", objective: "a" },
          { key: "dup", title: "B", objective: "b" },
        ],
        initialSection: "dup",
      }),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "invalid_scope");
  });

  it("rejects unknown dependency keys (test 7)", async () => {
    const world = await detailWorld();
    await expect(
      world.controller.prepareSectionDecomposition("ses_dec", {
        sections: [{ key: "a", title: "A", objective: "a", dependsOn: ["ghost"] }],
        initialSection: "a",
      }),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "unknown_reference");
  });

  it("rejects self dependencies (test 8)", async () => {
    const world = await detailWorld();
    await expect(
      world.controller.prepareSectionDecomposition("ses_dec", {
        sections: [{ key: "a", title: "A", objective: "a", dependsOn: ["a"] }],
        initialSection: "a",
      }),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "invalid_scope");
  });

  it("rejects cycles — backward references cannot express one (test 9)", async () => {
    const world = await detailWorld();
    // A depends on B which appears later: the only way to describe a cycle in
    // draft order, rejected before any id exists.
    await expect(
      world.controller.prepareSectionDecomposition("ses_dec", {
        sections: [
          { key: "a", title: "A", objective: "a", dependsOn: ["b"] },
          { key: "b", title: "B", objective: "b", dependsOn: ["a"] },
        ],
        initialSection: "a",
      }),
    ).rejects.toSatisfy(
      (e: unknown) =>
        isUltraPlanError(e) &&
        e.code === "invalid_scope" &&
        /later in the list/.test(e.message),
    );
    expect(await world.store.listProposals("PLAN-001" as never)).toHaveLength(1); // only the completion
  });

  it("rejects an unknown initialSection key (§12)", async () => {
    const world = await detailWorld();
    await expect(
      world.controller.prepareSectionDecomposition("ses_dec", {
        sections: [{ key: "a", title: "A", objective: "a" }],
        initialSection: "not-a-key",
      }),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "unknown_reference");
  });
});

describe("harness-assigned identity and hash coverage (tests 10-17)", () => {
  it("accepts a valid multi-root DAG and assigns deterministic SEC ids (tests 10-13)", async () => {
    const world = await detailWorld();
    const prepared = await world.controller.prepareSectionDecomposition("ses_dec", {
      sections: [
        { key: "memory", title: "Plan Memory", objective: "state" },
        { key: "reader", title: "Reader", objective: "reads", dependsOn: ["memory"] },
        { key: "ui", title: "UI", objective: "surface" },
      ],
      initialSection: "ui",
    });
    const addChanges = prepared.proposal.changes.filter(
      (c): c is Extract<ProposalChange, { kind: "add_section" }> => c.kind === "add_section",
    );
    // Canonical order = draft order; ids from the durable allocator.
    expect(addChanges.map((c) => c.section.id)).toEqual(["SEC-001", "SEC-002", "SEC-003"]);
    expect(addChanges.map((c) => c.section.title)).toEqual(["Plan Memory", "Reader", "UI"]);
    expect(addChanges[1]?.section.dependencies).toEqual(["SEC-001"]); // local key resolved
    for (const change of addChanges) {
      expect(change.section.status).toBe("pending");
      expect(change.section.validation).toBe("valid");
      expect(change.section.currentRevision).toBeUndefined();
      expect(change.section.approvedRevision).toBeUndefined();
    }
    const selection = prepared.proposal.changes.find(
      (c): c is Extract<ProposalChange, { kind: "select_initial_section" }> => c.kind === "select_initial_section",
    );
    expect(selection?.section).toEqual({ id: "SEC-003" });
    // §5: design_checkpoint scoped to the exact committed ArchitectureRef.
    expect(prepared.proposal.scope).toEqual({ id: "ARCH", revision: 1 });
  });

  it("freezes ids before approval: identical decompositions hash identically (test 12)", async () => {
    const first = await detailWorld();
    const second = await detailWorld();
    const a = await first.controller.prepareSectionDecomposition("ses_dec", THREE_SECTION_DECOMPOSITION);
    const b = await second.controller.prepareSectionDecomposition("ses_dec", THREE_SECTION_DECOMPOSITION);
    expect(a.hash).toBe(b.hash);
    expect(a.proposal.changes).toEqual(b.proposal.changes);
  });

  it("hash changes when title, objective, dependency, or initial focus changes (tests 14-17)", async () => {
    async function hashOf(mutate: (input: SectionDecompositionInput) => void): Promise<string> {
      const world = await detailWorld();
      const input = structuredClone(THREE_SECTION_DECOMPOSITION);
      mutate(input);
      const prepared = await world.controller.prepareSectionDecomposition("ses_dec", input);
      return prepared.hash;
    }
    const base = await hashOf(() => {});
    expect(await hashOf((i) => (i.sections[0]!.title = "Changed Title"))).not.toBe(base); // 14
    expect(await hashOf((i) => (i.sections[1]!.objective = "Changed objective"))).not.toBe(base); // 15
    expect(
      await hashOf((i) => {
        i.sections[2]!.dependsOn = ["runtime-integration"]; // new edge
      }),
    ).not.toBe(base); // 16
    expect(await hashOf((i) => (i.initialSection = "plan-memory"))).not.toBe(base); // 17
  });

  it("add_section/select_initial_section are NOT in the generic proposal vocabulary (§26)", async () => {
    const world = await detailWorld();
    const run = (await world.store.getRun("PLAN-001" as never)) as PlanningRun;
    // Hostile wire input that bypassed the dedicated tool: the generic
    // prepare_proposal boundary refuses decomposition kinds outright.
    for (const kind of ["add_section", "select_initial_section"]) {
      await expect(
        world.controller.prepareProposal("ses_dec", {
          type: "design_checkpoint",
          scope: { type: "architecture" },
          title: "loose section creation",
          summary: "s",
          changes: [{ kind }] as never,
        }),
      ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "proposal_kind_unsupported");
    }
    expect(run.headSnapshot).toBe("SNAP-002");
  });
});

describe("approval, commit, and atomic detail admission (tests 18-28)", () => {
  it("the approval view renders the exact resolved DAG (tests 18/§36)", async () => {
    const world = await detailWorld();
    const { prepared } = await prepareAwaiting(world, "ses_dec");
    const view = renderProposalForApproval(prepared.proposal);
    expect(view).toContain("Architecture scope: ARCH@1");
    expect(view).toContain("ADD SECTION SEC-001 — Runtime Integration");
    expect(view).toContain("ADD SECTION SEC-002 — Plan Memory");
    expect(view).toContain("depends on: SEC-001");
    expect(view).toContain("SELECT INITIAL SECTION SEC-001");
    expect(view).toContain(`Approval hash: ${prepared.hash}`);
    // Deterministic projection: identical call, identical bytes.
    expect(renderProposalForApproval(prepared.proposal)).toBe(view);
  });

  it("the model cannot write Section roots or force activeWork (test 19/§3)", async () => {
    expect(FORBIDDEN_TOOL_NAMES).toContain("set_section_status");
    const world = await detailWorld();
    const run = (await world.store.getRun("PLAN-001" as never)) as PlanningRun;
    await expect(
      world.store.saveRun({
        ...run,
        sections: [{ id: SectionIDs.from(1) }],
        activeWork: { type: "section", id: SectionIDs.from(1) },
      }),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "commit_gated_run_field");
  });

  it("one approval commits every section, run.sections, and activeWork in ONE transaction (tests 20/22-24)", async () => {
    const world = await detailWorld();
    const { prepared } = await prepareAwaiting(world, "ses_dec");
    const result = await world.controller.recordApprovalAndCommit("ses_dec", prepared.proposal.id, {
      proposalID: prepared.proposal.id,
      proposalRevision: 1,
      proposalHash: prepared.hash,
      oneShot: true,
      requestedAt: FIXED,
    });
    // One commit carries the whole DAG + the focus selection.
    expect(result.commit.changes.map((c) => c.kind)).toEqual([
      "add_section",
      "add_section",
      "add_section",
      "select_initial_section",
    ]);
    const run = await world.store.getRun("PLAN-001" as never);
    expect(run?.sections.map((s) => s.id)).toEqual(["SEC-001", "SEC-002", "SEC-003"]);
    expect(run?.activeWork).toEqual({ type: "section", id: "SEC-001" });
    expect(await world.store.listSections("PLAN-001" as never)).toHaveLength(3);
    expect(await world.store.listCommits("PLAN-001" as never)).toHaveLength(2);
    // Root-creation audit events, canonical order.
    const events = (await world.store.listEvents("PLAN-001" as never)).map((e) => e.detail);
    const added = events.filter((e) => e.type === "section.added");
    expect(added.map((e) => (e as { sectionID: string }).sectionID)).toEqual(["SEC-001", "SEC-002", "SEC-003"]);
  });

  it("the stage remains detail after decomposition (tests 21/25, §21)", async () => {
    const world = await detailWorld();
    const { prepared } = await prepareAwaiting(world, "ses_dec");
    await world.controller.recordApprovalAndCommit("ses_dec", prepared.proposal.id, {
      proposalID: prepared.proposal.id,
      proposalRevision: 1,
      proposalHash: prepared.hash,
      oneShot: true,
      requestedAt: FIXED,
    });
    const run = await world.store.getRun("PLAN-001" as never);
    expect(run?.stage).toBe("detail");
    // Exactly two stage events ever: discovery→architecture (the request) and
    // architecture→detail (the completion commit). Decomposition adds none.
    const stageEvents = (await world.store.listEvents("PLAN-001" as never))
      .map((e) => e.detail)
      .filter((e): e is Extract<typeof e, { type: "run.stage_changed" }> => e.type === "run.stage_changed");
    expect(stageEvents).toEqual([
      { type: "run.stage_changed", from: "discovery", to: "architecture" },
      { type: "run.stage_changed", from: "architecture", to: "detail" },
    ]);
  });

  it("the HEAD snapshot represents the DAG with NO fake revisions or contracts (tests 26-28, §27/§31)", async () => {
    const world = await detailWorld();
    const { prepared } = await prepareAwaiting(world, "ses_dec");
    await world.controller.recordApprovalAndCommit("ses_dec", prepared.proposal.id, {
      proposalID: prepared.proposal.id,
      proposalRevision: 1,
      proposalHash: prepared.hash,
      oneShot: true,
      requestedAt: FIXED,
    });
    const snapshot = await world.store.getHeadSnapshot("PLAN-001" as never);
    expect(snapshot?.state.sectionRoots?.map((r) => r.id)).toEqual(["SEC-001", "SEC-002", "SEC-003"]);
    expect(snapshot?.state.sectionRoots?.[2]?.dependencies).toEqual(["SEC-002"]);
    expect(snapshot?.state.sectionRoots?.every((r) => r.status === "pending")).toBe(true);
    // No SectionRevision exists, so no revision pointer may exist either.
    expect(snapshot?.state.sectionRevisions).toEqual({});
    expect(await world.store.getSectionRevision("PLAN-001" as never, { id: "SEC-001" as never, revision: 1 })).toBeUndefined();
  });

  it("rejection commits zero sections and the model can re-propose (tests 21/§37)", async () => {
    const world = await detailWorld();
    const prepared = await world.controller.prepareSectionDecomposition("ses_dec", THREE_SECTION_DECOMPOSITION);
    const begun = await world.controller.beginProposalApproval("ses_dec", prepared.proposal.id);
    await world.controller.rejectProposal("ses_dec", prepared.proposal.id, begun.request);
    let run = await world.store.getRun("PLAN-001" as never);
    expect(run?.sections).toHaveLength(0);
    expect(run?.activeWork).toBeUndefined();
    expect(await world.store.listSections("PLAN-001" as never)).toHaveLength(0);
    expect(await world.store.listCommits("PLAN-001" as never)).toHaveLength(1); // completion only

    // A NEW full decomposition proposal is allowed; the allocator reuses the
    // uncommitted SEC range (nothing was committed), the rejected proposal
    // itself stays frozen and is never renumbered.
    const second = await world.controller.prepareSectionDecomposition("ses_dec", THREE_SECTION_DECOMPOSITION);
    expect(second.proposal.id).toBe("PROP-003");
    expect(second.proposal.changes).toEqual(prepared.proposal.changes);
    const rejected = await world.store.getProposal("PLAN-001" as never, prepared.proposal.id);
    expect(rejected?.status).toBe("rejected");
    expect(rejected?.hash).toBe(prepared.hash);
    run = await world.store.getRun("PLAN-001" as never);
    expect(run?.sections).toHaveLength(0);
  });
});

describe("plan_memory reads over the committed DAG (tests 29-30, §30)", () => {
  async function decomposedWorld() {
    const world = await detailWorld();
    const { prepared } = await prepareAwaiting(world, "ses_dec");
    await world.controller.recordApprovalAndCommit("ses_dec", prepared.proposal.id, {
      proposalID: prepared.proposal.id,
      proposalRevision: 1,
      proposalHash: prepared.hash,
      oneShot: true,
      requestedAt: FIXED,
    });
    return world;
  }

  it("reads a Section root without any SectionRevision (test 29)", async () => {
    const world = await decomposedWorld();
    const read = await world.controller.readMemory("ses_dec", { ref: { kind: "section", id: "SEC-002" } });
    const section = read.artifacts[0]?.artifact as { id: string; title: string; dependencies: string[]; currentRevision?: number };
    expect(section.id).toBe("SEC-002");
    expect(section.title).toBe("Plan Memory");
    expect(section.dependencies).toEqual(["SEC-001"]);
    expect(section.currentRevision).toBeUndefined();
  });

  it("dependency reads return structural roots before contracts exist (test 30)", async () => {
    const world = await decomposedWorld();
    const read = await world.controller.readMemory("ses_dec", { dependenciesOf: "SEC-003" });
    const artifacts = read.artifacts.map((a) => (a.artifact as { id?: string }).id);
    expect(artifacts).toContain("SEC-003");
    expect(artifacts).toContain("SEC-002"); // structural dependency root
    // No contract-carrying revision was fabricated.
    expect(read.artifacts.some((a) => a.ref.kind === "section" && a.ref.revision !== undefined)).toBe(false);
  });
});

describe("immutability, idempotency, and failure semantics (tests 31-37)", () => {
  async function committedWorld() {
    const world = await detailWorld();
    const { prepared } = await prepareAwaiting(world, "ses_dec");
    const result = await world.controller.recordApprovalAndCommit("ses_dec", prepared.proposal.id, {
      proposalID: prepared.proposal.id,
      proposalRevision: 1,
      proposalHash: prepared.hash,
      oneShot: true,
      requestedAt: FIXED,
    });
    return { world, prepared, result };
  }

  it("exact retry of the committed decomposition is idempotent (test 31)", async () => {
    const { world, prepared, result } = await committedWorld();
    const again = await world.controller.commitApprovedProposal("ses_dec", prepared.proposal.id);
    expect(again.commit.id).toBe(result.commit.id);
    expect(await world.store.listCommits("PLAN-001" as never)).toHaveLength(2);
    expect(await world.store.listSections("PLAN-001" as never)).toHaveLength(3);
    const run = await world.store.getRun("PLAN-001" as never);
    expect(run?.activeWork).toEqual({ type: "section", id: "SEC-001" });
  });

  it("a second initial decomposition is refused once the DAG exists (test 32/§19)", async () => {
    const { world } = await committedWorld();
    await expect(
      world.controller.prepareSectionDecomposition("ses_dec", THREE_SECTION_DECOMPOSITION),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "capability_not_available");
    // Engine defense: a hostile direct proposal is also refused.
    const run = (await world.store.getRun("PLAN-001" as never)) as PlanningRun;
    const proposal: Proposal = {
      id: ProposalIDs.from(9),
      type: "design_checkpoint",
      scope: { id: "ARCH", revision: 1 },
      revision: 1,
      status: "awaiting_approval",
      title: "second decomposition",
      summary: "s",
      changes: [
        {
          kind: "add_section",
          section: { id: SectionIDs.from(9), title: "X", objective: "x", dependencies: [], status: "pending", validation: "valid" },
        },
      ] as ProposalChange[],
      dependencies: [],
      impact: { affectedSections: [], affectedDecisions: [] },
      createdFrom: { id: run.headSnapshot as never },
    };
    proposal.hash = computeProposalHash(proposal);
    await world.store.saveProposal(run.id, proposal);
    await world.store.saveApproval(run.id, {
      id: ApprovalIDs.from(9),
      proposalID: proposal.id,
      proposalRevision: 1,
      proposalHash: proposal.hash,
      actor: "user",
      createdAt: FIXED,
    });
    await expect(
      world.store.commitTransaction({ planID: run.id, proposalID: proposal.id, approvalID: ApprovalIDs.from(9) }),
    ).rejects.toSatisfy((e: unknown) => failCodes(e).includes("decomposition_already_committed"));
  });

  it("direct dependency/section mutation is refused (tests 33/34/§43)", async () => {
    const { world } = await committedWorld();
    const run = (await world.store.getRun("PLAN-001" as never)) as PlanningRun;
    const mutated = structuredClone(run);
    mutated.sections = [{ id: "SEC-001" as never }, { id: "SEC-003" as never }]; // drop a section
    await expect(world.store.saveRun(mutated)).rejects.toSatisfy(
      (e: unknown) => isUltraPlanError(e) && e.code === "commit_gated_run_field",
    );
    const refocused = structuredClone(run);
    refocused.activeWork = { type: "section", id: "SEC-003" as never }; // force focus
    await expect(world.store.saveRun(refocused)).rejects.toSatisfy(
      (e: unknown) => isUltraPlanError(e) && e.code === "commit_gated_run_field",
    );
  });

  it("a failed second section staging rolls back the first (test 35)", async () => {
    const world = await detailWorld();
    const run = (await world.store.getRun("PLAN-001" as never)) as PlanningRun;
    const proposal: Proposal = {
      id: ProposalIDs.from(9),
      type: "design_checkpoint",
      scope: { id: "ARCH", revision: 1 },
      revision: 1,
      status: "awaiting_approval",
      title: "partial DAG",
      summary: "s",
      changes: [
        {
          kind: "add_section",
          section: { id: SectionIDs.from(1), title: "OK", objective: "o", dependencies: [], status: "pending", validation: "valid" },
        },
        {
          kind: "add_section",
          section: {
            id: SectionIDs.from(2),
            title: "Bad dep",
            objective: "o",
            dependencies: [SectionIDs.from(99)],
            status: "pending",
            validation: "valid",
          },
        },
      ] as ProposalChange[],
      dependencies: [],
      impact: { affectedSections: [], affectedDecisions: [] },
      createdFrom: { id: run.headSnapshot as never },
    };
    proposal.hash = computeProposalHash(proposal);
    await world.store.saveProposal(run.id, proposal);
    await world.store.saveApproval(run.id, {
      id: ApprovalIDs.from(9),
      proposalID: proposal.id,
      proposalRevision: 1,
      proposalHash: proposal.hash,
      actor: "user",
      createdAt: FIXED,
    });
    await expect(
      world.store.commitTransaction({ planID: run.id, proposalID: proposal.id, approvalID: ApprovalIDs.from(9) }),
    ).rejects.toSatisfy((e: unknown) => failCodes(e).includes("unknown_reference"));
    // Zero partial mutation: the first section was NOT committed.
    expect(await world.store.listSections("PLAN-001" as never)).toHaveLength(0);
    expect((await world.store.getRun("PLAN-001" as never))?.sections).toHaveLength(0);
    expect((await world.store.getRun("PLAN-001" as never))?.activeWork).toBeUndefined();
  });

  it("publication fault leaves zero DAG mutation; the approval stays retriable (tests 36/37)", async () => {
    class FlakyStore extends InMemoryPlanStore {
      armed = false;
      protected override publishTransaction(...args: Parameters<InMemoryPlanStore["publishTransaction"]>): PlanCommit {
        if (this.armed) {
          this.armed = false;
          throw new UltraPlanError("store_busy", "injected publication failure");
        }
        return super.publishTransaction(...args);
      }
    }
    const store = new FlakyStore(() => FIXED);
    const world = makeWorld(store);
    await detailWorld(world);
    const { prepared } = await prepareAwaiting(world, "ses_dec");
    store.armed = true;
    await expect(
      world.controller.commitApprovedProposal("ses_dec", prepared.proposal.id),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "store_busy");
    // Zero committed DAG mutation.
    let run = await world.store.getRun("PLAN-001" as never);
    expect(run?.sections).toHaveLength(0);
    expect(run?.activeWork).toBeUndefined();
    expect(await world.store.listSections("PLAN-001" as never)).toHaveLength(0);
    expect((await world.store.getHeadSnapshot("PLAN-001" as never))?.id).toBe("SNAP-002");
    expect((await world.store.getProposal("PLAN-001" as never, prepared.proposal.id))?.status).toBe("awaiting_approval");
    // Retry with the SAME durable approval succeeds.
    const retry = await world.controller.commitApprovedProposal("ses_dec", prepared.proposal.id);
    expect(retry.commit.changes.map((c) => c.kind)).toEqual([
      "add_section",
      "add_section",
      "add_section",
      "select_initial_section",
    ]);
    run = await world.store.getRun("PLAN-001" as never);
    expect(run?.activeWork).toEqual({ type: "section", id: "SEC-001" });
  });
});

describe("invariants after decomposition (tests 47/48)", () => {
  it("section completion still requires approved dependencies; no needs_review was triggered (tests 47/48)", async () => {
    const world = await detailWorld();
    const { prepared } = await prepareAwaiting(world, "ses_dec");
    await world.controller.recordApprovalAndCommit("ses_dec", prepared.proposal.id, {
      proposalID: prepared.proposal.id,
      proposalRevision: 1,
      proposalHash: prepared.hash,
      oneShot: true,
      requestedAt: FIXED,
    });
    // Phase 2E1 completion deferral (§19): a checkpoint is not a completion,
    // and 2E1 implements no Section completion — request_completion(kind
    // "section") is withheld from EVERY detail substate and fails with the
    // deterministic phase-boundary capability error before any scope check.
    await expect(
      world.controller.requestCompletion("ses_dec", { kind: "section" }),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "capability_not_available");
    // A Section ROOT could never complete anyway — completion requires an
    // actual SectionRevision (design), which decomposition deliberately does
    // not fabricate (§46/§31).

    // Regression for §32: once a design revision exists (seeded via the
    // TEST-ONLY seeding seam, as Phase 2E commits will create it), committing
    // the DAG has not weakened the frozen dependency rule — SEC-002's
    // dependency SEC-001 is still pending, so completion fails.
    world.store.seedCommittedState("PLAN-001" as never, {
      sections: [
        {
          id: "SEC-002" as never,
          title: "Plan Memory",
          objective: "durable authoritative state",
          dependencies: ["SEC-001" as never],
          status: "active" as const,
          validation: "valid" as const,
          currentRevision: 1,
          approvedRevision: 1,
        },
      ],
      sectionRevisions: [
        {
          sectionID: "SEC-002" as never,
          revision: 1,
          status: "approved" as const,
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
            contract: {
              sectionID: "SEC-002" as never,
              revision: 1,
              provides: [],
              requires: [],
              invariants: [],
              interfaces: [],
              decisions: [],
            },
          },
          createdAt: FIXED,
        },
      ],
    });
    const completion = await world.controller.prepareProposal("ses_dec", {
      type: "section_completion",
      scope: { type: "section", sectionID: "SEC-002" },
      title: "Complete SEC-002",
      summary: "s",
      changes: [{ kind: "complete_section", ref: { kind: "section", id: "SEC-002", revision: 1 } }] as never,
    });
    const begun = await world.controller.beginProposalApproval("ses_dec", completion.proposal.id);
    await world.controller.recordApproval("ses_dec", completion.proposal.id, begun.request);
    await expect(
      world.controller.commitApprovedProposal("ses_dec", completion.proposal.id),
    ).rejects.toSatisfy((e: unknown) => failCodes(e).includes("dependency_incomplete"));
    // Decomposition itself triggered no needs_review (§33).
    for (const section of await world.store.listSections("PLAN-001" as never)) {
      expect(section.validation).toBe("valid");
    }
  });
});

describe("deterministic status and L0 protocol (tests 49-51, §34/§35)", () => {
  it("status shows not-decomposed before and DAG + active work after (tests 49/50)", async () => {
    const world = await detailWorld();
    let report = await world.controller.statusReport("ses_dec");
    expect(report.statusText).toContain("Stage: detail");
    expect(report.statusText).toContain("Sections: not decomposed");
    expect(report.statusText).toContain("Active work: none");

    const { prepared } = await prepareAwaiting(world, "ses_dec");
    await world.controller.recordApprovalAndCommit("ses_dec", prepared.proposal.id, {
      proposalID: prepared.proposal.id,
      proposalRevision: 1,
      proposalHash: prepared.hash,
      oneShot: true,
      requestedAt: FIXED,
    });
    report = await world.controller.statusReport("ses_dec");
    expect(report.statusText).toContain("Sections: 3 (0 approved)");
    expect(report.statusText).toContain("Active work: SEC-001");
    // Byte-deterministic for identical state.
    expect(renderStatus((await world.store.getRun("PLAN-001" as never)) as PlanningRun)).toBe(
      renderStatus((await world.store.getRun("PLAN-001" as never)) as PlanningRun),
    );
  });

  it("the L0 protocol changes deterministically across the decomposition boundary (test 51)", async () => {
    const world = await detailWorld();
    const run = (await world.store.getRun("PLAN-001" as never)) as PlanningRun;
    const before = renderPlanningProtocol({ run });
    expect(before).toContain("decompose the approved Architecture");
    expect(before).toContain("ultraplan_prepare_section_decomposition");
    expect(before).not.toContain("Active section:");

    const after = renderPlanningProtocol({
      run: { ...run, sections: [{ id: "SEC-001" as never }, { id: "SEC-002" as never }], activeWork: { type: "section", id: "SEC-002" as never } },
      activeSection: {
        id: "SEC-002",
        title: "Plan Memory",
        objective: "durable state",
        dependencies: ["SEC-001"],
        validation: "valid",
        dependencyContracts: [{ id: "SEC-001", revision: 1 }],
      },
    });
    expect(after).toContain("SECTION DESIGN");
    expect(after).toContain("Active section: SEC-002 — Plan Memory (durable state)");
    expect(after).toContain("Direct dependencies: SEC-001.");
    expect(after).toContain("Dependency contracts: SEC-001@1 approved");
    expect(after).toContain("ultraplan_prepare_section_checkpoint");
    expect(after).not.toContain("decompose the approved Architecture");
  });
});

describe("tool surface (§25/§48 registration contract)", () => {
  it("the dedicated decomposition tool is contracted and registered", () => {
    const world = makeWorld();
    const tools = createUltraPlanTools(world.controller);
    expect(TOOL_CONTRACTS["ultraplan_prepare_section_decomposition"]).toMatchObject({
      authority: "proposal_intent",
      capability: "prepare_decomposition",
      mutatesCommittedMemory: false,
    });
    expect(TOOL_CONTRACTS["ultraplan_prepare_section_decomposition"]?.allowedStages).toEqual(["detail"]);
    expect(tools["ultraplan_prepare_section_decomposition"]).toBeDefined();
    expect(Object.keys(tools).sort()).toEqual(Object.keys(TOOL_CONTRACTS).sort());
  });

  it("drives the full decomposition through the real tool gateway (§49 model-equivalent path)", async () => {
    const world = await detailWorld();
    const tools = createUltraPlanTools(world.controller);
    const decomposeTool = tools["ultraplan_prepare_section_decomposition"] as unknown as {
      execute: (args: unknown, context: unknown) => Promise<{ output: string; metadata: { proposalID: string; hash: string } }>;
    };
    const prepared = await decomposeTool.execute(THREE_SECTION_DECOMPOSITION, fakeToolContext("ses_dec"));
    expect(prepared.metadata.proposalID).toBe("PROP-002");
    expect(prepared.output).toContain("ADD SECTION SEC-001 — Runtime Integration");

    // Structured user allow through the same gateway.
    const asks: CapturedAsk[] = [];
    const approvalTool = tools["ultraplan_request_user_approval"] as unknown as {
      execute: (args: { proposalID: string }, context: unknown) => Promise<{ metadata: Record<string, unknown> }>;
    };
    const result = await approvalTool.execute(
      { proposalID: prepared.metadata.proposalID },
      fakeToolContext("ses_dec", {
        ask: async (input: CapturedAsk) => {
          asks.push(input);
        },
      }),
    );
    expect(asks[0]?.always).toEqual([]);
    expect(result.metadata["stage"]).toBe("detail");
    const run = await world.store.findActiveRunBySession("ses_dec");
    expect(run?.sections.map((s) => s.id)).toEqual(["SEC-001", "SEC-002", "SEC-003"]);
    expect(run?.activeWork).toEqual({ type: "section", id: "SEC-001" });
  });
});

// -----------------------------------------------------------------------------
// Durable recovery, restart matrix, concurrency (§40/§42/§49).
// -----------------------------------------------------------------------------

describe("durable decomposition recovery (§40) and concurrency (§42)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "ultraplan-dec-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  function openStore(dbFile: string): DurablePlanStore {
    return new DurablePlanStore(dbFile, { now: () => FIXED });
  }

  /** Drive a durable store from /ultra-plan to the 2D starting state. */
  async function durableDetailWorld(store: DurablePlanStore, sessionID = "ses_dd") {
    const world = makeWorld(store);
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
    run = (await store.getRun(run.id)) as PlanningRun;
    return { world, run };
  }

  it("§49 PRIMARY: full decomposition, durable close/reopen shows the IDENTICAL workspace", async () => {
    const dbFile = path.join(dir, "plan-store.json");
    const store = openStore(dbFile);
    const { world } = await durableDetailWorld(store);

    const prepared = await world.controller.prepareSectionDecomposition("ses_dd", THREE_SECTION_DECOMPOSITION);
    const begun = await world.controller.beginProposalApproval("ses_dd", prepared.proposal.id);
    const result = await world.controller.recordApprovalAndCommit("ses_dd", prepared.proposal.id, begun.request);

    const before = {
      run: await store.getRun("PLAN-001" as never),
      sections: await store.listSections("PLAN-001" as never),
      snapshot: await store.getHeadSnapshot("PLAN-001" as never),
      proposal: await store.getProposal("PLAN-001" as never, prepared.proposal.id),
      approval: await store.findApprovalForProposal("PLAN-001" as never, prepared.proposal.id),
      events: await store.listEvents("PLAN-001" as never),
    };
    expect(before.run?.stage).toBe("detail");
    expect(before.run?.sections.map((s) => s.id)).toEqual(["SEC-001", "SEC-002", "SEC-003"]);
    expect(before.run?.activeWork).toEqual({ type: "section", id: "SEC-001" });
    expect(before.snapshot?.state.sectionRoots?.map((r) => r.id)).toEqual(["SEC-001", "SEC-002", "SEC-003"]);
    expect(result.commit.id).toBe("COMMIT-002");
    expect(before.run?.headCommit).toBe("COMMIT-002");

    store.close();
    const reopened = openStore(dbFile);
    await reopened.open();
    // tests 38/39/40: identical order, graph, activeWork — and everything else.
    expect(await reopened.getRun("PLAN-001" as never)).toEqual(before.run);
    expect(await reopened.listSections("PLAN-001" as never)).toEqual(before.sections);
    expect(await reopened.getHeadSnapshot("PLAN-001" as never)).toEqual(before.snapshot);
    expect(await reopened.getProposal("PLAN-001" as never, prepared.proposal.id)).toEqual(before.proposal);
    const approval = await reopened.findApprovalForProposal("PLAN-001" as never, prepared.proposal.id);
    expect(approval).toEqual(before.approval);
    // Exact retry after reopen returns the existing commit.
    const retry = await reopened.commitTransaction({
      planID: "PLAN-001" as never,
      proposalID: prepared.proposal.id,
      approvalID: approval?.id as never,
    });
    expect(retry.id).toBe("COMMIT-002");
    reopened.close();
  });

  it("a READY decomposition proposal keeps its exact hash across restart (test 41)", async () => {
    const dbFile = path.join(dir, "plan-store.json");
    const store = openStore(dbFile);
    const { world } = await durableDetailWorld(store);
    const prepared = await world.controller.prepareSectionDecomposition("ses_dd", THREE_SECTION_DECOMPOSITION);
    store.close();

    const reopened = openStore(dbFile);
    await reopened.open();
    const proposal = await reopened.getProposal("PLAN-001" as never, prepared.proposal.id);
    expect(proposal?.status).toBe("ready");
    expect(proposal?.hash).toBe(prepared.hash);
    expect(computeProposalHash(proposal as Proposal)).toBe(prepared.hash);
    reopened.close();
  });

  it("an awaiting decomposition with NO approval stays honest after restart (test 42)", async () => {
    const dbFile = path.join(dir, "plan-store.json");
    const store = openStore(dbFile);
    const { world } = await durableDetailWorld(store);
    const prepared = await world.controller.prepareSectionDecomposition("ses_dd", THREE_SECTION_DECOMPOSITION);
    await world.controller.beginProposalApproval("ses_dd", prepared.proposal.id);
    store.close();

    const reopened = openStore(dbFile);
    await reopened.open();
    expect((await reopened.getProposal("PLAN-001" as never, prepared.proposal.id))?.status).toBe("awaiting_approval");
    expect(await reopened.findApprovalForProposal("PLAN-001" as never, prepared.proposal.id)).toBeUndefined();
    await expect(
      reopened.commitTransaction({
        planID: "PLAN-001" as never,
        proposalID: prepared.proposal.id,
        approvalID: "APPR-002" as never,
      }),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "approval_not_found");
    reopened.close();
  });

  it("a durable decomposition approval commits on exact retry after restart (test 43)", async () => {
    const dbFile = path.join(dir, "plan-store.json");
    const store = openStore(dbFile);
    const { world } = await durableDetailWorld(store);
    const { prepared, approval } = await prepareAwaiting(world, "ses_dd");
    store.close();

    const reopened = openStore(dbFile);
    await reopened.open();
    const commit = await reopened.commitTransaction({
      planID: "PLAN-001" as never,
      proposalID: prepared.proposal.id,
      approvalID: approval.id,
    });
    expect(commit.changes.map((c) => c.kind)).toEqual([
      "add_section",
      "add_section",
      "add_section",
      "select_initial_section",
    ]);
    const run = await reopened.getRun("PLAN-001" as never);
    expect(run?.activeWork).toEqual({ type: "section", id: "SEC-001" });
    reopened.close();
  });

  it("a stale concurrent decomposition writer loses with head_snapshot_mismatch (test 46/§42)", async () => {
    const dbFile = path.join(dir, "plan-store.json");
    // Two INDEPENDENT durable instances over one file, both observing the
    // same detail-stage HEAD (SNAP-002, sections = []).
    const storeA = openStore(dbFile);
    const { world: worldA } = await durableDetailWorld(storeA);
    const storeB = openStore(dbFile);
    await storeB.open();
    const controllerB = new UltraPlanController({ store: storeB, now: () => FIXED });

    // Writer A freezes decomposition A; writer B freezes a DIFFERENT
    // decomposition B — both valid at the same HEAD.
    const proposalA = await worldA.controller.prepareSectionDecomposition("ses_dd", THREE_SECTION_DECOMPOSITION);
    const begunA = await worldA.controller.beginProposalApproval("ses_dd", proposalA.proposal.id);
    const approvalA = await worldA.controller.recordApproval("ses_dd", proposalA.proposal.id, begunA.request);

    const proposalB = await controllerB.prepareSectionDecomposition("ses_dd", {
      sections: [{ key: "other", title: "Other decomposition", objective: "o" }],
      initialSection: "other",
    });
    const begunB = await controllerB.beginProposalApproval("ses_dd", proposalB.proposal.id);
    const approvalB = await controllerB.recordApproval("ses_dd", proposalB.proposal.id, begunB.request);
    expect(proposalA.proposal.createdFrom.id).toBe(proposalB.proposal.createdFrom.id); // same base

    // A commits first: the DAG exists, HEAD moved.
    const commitA = await storeA.commitTransaction({
      planID: "PLAN-001" as never,
      proposalID: proposalA.proposal.id,
      approvalID: approvalA.approval.id,
    });
    expect(commitA.id).toBe("COMMIT-002");

    // B's commit is refused against the NEW durable HEAD — no merge, no fork.
    await expect(
      storeB.commitTransaction({
        planID: "PLAN-001" as never,
        proposalID: proposalB.proposal.id,
        approvalID: approvalB.approval.id,
      }),
    ).rejects.toSatisfy((e: unknown) => failCodes(e).includes("head_snapshot_mismatch"));

    // Exactly one DAG: A's canonical order, one new commit, one snapshot.
    const run = await storeB.getRun("PLAN-001" as never);
    expect(run?.sections.map((s) => s.id)).toEqual(["SEC-001", "SEC-002", "SEC-003"]);
    expect(run?.activeWork).toEqual({ type: "section", id: "SEC-001" });
    expect(await storeB.listCommits("PLAN-001" as never)).toHaveLength(2);
    expect((await storeB.getHeadSnapshot("PLAN-001" as never))?.id).toBe("SNAP-003");
    storeA.close();
    storeB.close();
  });
});
