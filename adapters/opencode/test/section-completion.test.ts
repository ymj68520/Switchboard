/**
 * Phase 2E2 — Section Completion, Dependency Closure & Work Progression.
 *
 * Covers the completion workflow: active checkpointed Section → exact
 * section_completion Proposal (Harness-resolved target, no model-supplied
 * revision) → precise blocker errors when deterministic gates fail → user
 * Approval → one atomic PlanCommit that closes the Section, selects the next
 * activeWork by dependency eligibility in canonical order, and — on the last
 * completion — clears the focus and moves detail → synthesis in the SAME
 * commit. Manual focus switching (ultraplan_request_section_focus) keeps the
 * discussion order != completion order rule; the old provisional
 * request_synthesis shortcut is withheld in the now-reachable synthesis stage.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DurablePlanStore,
  InMemoryPlanStore,
  UltraPlanError,
  computeProposalHash,
  isUltraPlanError,
  renderPlanningProtocol,
  renderProposalForApproval,
  renderStatus,
} from "../src/index.js";
import type {
  PlanCommit,
  PlanningRun,
  Proposal,
  ProposalChange,
  Section,
  SectionCheckpointInput,
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

/**
 * Chain DAG (§44): SEC-001 → SEC-002 → SEC-003 in canonical order, initial
 * focus SEC-001. Reached through the REAL Phase 2C/2D workflows.
 */
const CHAIN_DECOMPOSITION = {
  sections: [
    { key: "runtime", title: "Runtime Integration", objective: "bind to the OpenCode host" },
    { key: "plan-memory", title: "Plan Memory", objective: "durable authoritative state", dependsOn: ["runtime"] },
    { key: "context", title: "Context Assembly", objective: "deterministic model context", dependsOn: ["plan-memory"] },
  ],
  initialSection: "runtime",
};

/** Detail world with the committed chain DAG and activeWork SEC-001 (revisionless). */
async function dagWorld(world: ReturnType<typeof makeWorld> = makeWorld(), sessionID = "ses_done") {
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
  expect(run.activeWork).toEqual({ type: "section", id: "SEC-001" });
  return { ...world, run };
}

/** A valid checkpoint draft for the given chain section. */
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

/** checkpoint (prepare + begin + commit) the ACTIVE section. */
async function checkpointActive(world: ReturnType<typeof makeWorld>, sessionID: string): Promise<PlanCommit> {
  const run = (await world.store.findActiveRunBySession(sessionID)) as PlanningRun;
  const active = run.activeWork?.type === "section" ? run.activeWork.id : undefined;
  if (!active) throw new Error("no active section");
  const input = checkpointInput(active as "SEC-001");
  const prepared = await world.controller.prepareSectionCheckpoint(sessionID, input);
  const begun = await world.controller.beginProposalApproval(sessionID, prepared.proposal.id);
  return (await world.controller.recordApprovalAndCommit(sessionID, prepared.proposal.id, begun.request)).commit;
}

/** requestCompletion(kind=section) → begin (awaiting_approval, no approval yet). */
async function prepareCompletion(world: ReturnType<typeof makeWorld>, sessionID: string) {
  const prepared = await world.controller.requestCompletion(sessionID, { kind: "section" });
  const begun = await world.controller.beginProposalApproval(sessionID, prepared.proposal.id);
  return { prepared, begun };
}

/** checkpoint + complete the ACTIVE section through real approvals. */
async function checkpointAndComplete(world: ReturnType<typeof makeWorld>, sessionID: string): Promise<PlanCommit> {
  await checkpointActive(world, sessionID);
  const { prepared, begun } = await prepareCompletion(world, sessionID);
  return (await world.controller.recordApprovalAndCommit(sessionID, prepared.proposal.id, begun.request)).commit;
}

function failCodes(error: unknown): string[] {
  if (!isUltraPlanError(error)) return [];
  const failures = error.detail?.failures as { code: string }[] | undefined;
  return failures?.map((f) => f.code) ?? [];
}

// -----------------------------------------------------------------------------
// Completion preparation (tests 1-7)
// -----------------------------------------------------------------------------

describe("completion preparation (tests 1-7)", () => {
  it("a revisionless Section cannot prepare completion — the capability is withheld (tests 1)", async () => {
    const world = await dagWorld(); // SEC-001 revisionless
    await expect(
      world.controller.requestCompletion("ses_done", { kind: "section" }),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "capability_not_available");
  });

  it("an active checkpointed Section CAN prepare a section_completion proposal scoped to the exact SectionRef (tests 2-4)", async () => {
    const world = await dagWorld();
    await checkpointActive(world, "ses_done");
    const { prepared } = await prepareCompletion(world, "ses_done");
    expect(prepared.proposal.type).toBe("section_completion");
    expect(prepared.proposal.scope).toEqual({ id: "SEC-001" });
  });

  it("the Harness freezes the EXACT current approved revision as the target (tests 5-6)", async () => {
    const world = await dagWorld();
    await checkpointActive(world, "ses_done");
    const { prepared } = await prepareCompletion(world, "ses_done");
    expect(prepared.proposal.changes[0]).toMatchObject({
      kind: "complete_section",
      target: { id: "SEC-001", revision: 1 },
    });
    // The model-facing operation carries no revision/sectionID inputs at all
    // (RequestCompletionInput is {kind}) — a second checkpoint moves the
    // target with the root, never the model's choice.
    const root = await world.store.getSection("PLAN-001" as never, "SEC-001" as never);
    expect(root?.approvedRevision).toBe(1);
  });

  it("divergent root pointers block completion (test 7)", async () => {
    const world = await dagWorld();
    await checkpointActive(world, "ses_done");
    // Hostile/seeded divergence: currentRevision ahead of approvedRevision.
    world.store.seedCommittedState("PLAN-001" as never, {
      activeWork: { type: "section", id: "SEC-001" as never },
    });
    const sections = await world.store.listSections("PLAN-001" as never);
    const sec1 = sections.find((s) => s.id === "SEC-001") as Section;
    world.store.seedCommittedState("PLAN-001" as never, {
      sections: [{ ...sec1, currentRevision: 2 }],
      activeWork: { type: "section", id: "SEC-001" as never },
    });
    await expect(
      world.controller.requestCompletion("ses_done", { kind: "section" }),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "revision_mismatch");
  });
});

// -----------------------------------------------------------------------------
// Deterministic gates (tests 8-11)
// -----------------------------------------------------------------------------

describe("deterministic completion gates (tests 8-11)", () => {
  it("validation=needs_review blocks completion with the precise error (test 8)", async () => {
    const world = await dagWorld();
    await checkpointActive(world, "ses_done");
    const sections = await world.store.listSections("PLAN-001" as never);
    const sec1 = sections.find((s) => s.id === "SEC-001") as Section;
    world.store.seedCommittedState("PLAN-001" as never, {
      sections: [{ ...sec1, validation: "needs_review" }],
      activeWork: { type: "section", id: "SEC-001" as never },
    });
    await expect(
      world.controller.requestCompletion("ses_done", { kind: "section" }),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "section_needs_review");
  });

  it("an incomplete direct dependency blocks completion (test 9)", async () => {
    const world = await dagWorld();
    // Focus the dependent section (sanctioned discussion-ahead switching).
    await world.controller.requestSectionFocus("ses_done", { sectionID: "SEC-002" });
    await checkpointActive(world, "ses_done"); // SEC-001 has no contract → needs_review
    await expect(
      world.controller.requestCompletion("ses_done", { kind: "section" }),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "dependency_incomplete");
  });

  it("a dependency CHECKPOINT alone does not satisfy the dependency gate — only approval status does (test 10)", async () => {
    const world = await dagWorld();
    await checkpointActive(world, "ses_done"); // SEC-001 checkpointed (still active, NOT approved)
    await world.controller.requestSectionFocus("ses_done", { sectionID: "SEC-002" });
    await checkpointActive(world, "ses_done"); // SEC-002 checkpointed, binds SEC-001@1
    await expect(
      world.controller.requestCompletion("ses_done", { kind: "section" }),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "dependency_incomplete");
  });

  it("an APPROVED dependency satisfies the gate (test 11)", async () => {
    const world = await dagWorld();
    await checkpointAndComplete(world, "ses_done"); // SEC-001 approved, focus → SEC-002
    await checkpointActive(world, "ses_done");
    await expect(prepareCompletion(world, "ses_done")).resolves.toBeDefined();
  });
});

// -----------------------------------------------------------------------------
// Commit result semantics (tests 12-19)
// -----------------------------------------------------------------------------

describe("completion commit result (tests 12-19)", () => {
  it("completion creates NO new SectionRevision and regenerates NO contract (tests 12-13)", async () => {
    const world = await dagWorld();
    await checkpointActive(world, "ses_done");
    const before = await world.store.getSectionRevision("PLAN-001" as never, { id: "SEC-001" as never, revision: 1 });
    const { prepared, begun } = await prepareCompletion(world, "ses_done");
    await world.controller.recordApprovalAndCommit("ses_done", prepared.proposal.id, begun.request);
    const after = await world.store.getSectionRevision("PLAN-001" as never, { id: "SEC-001" as never, revision: 1 });
    expect(after).toEqual(before); // byte-identical
    expect(await world.store.getSectionRevision("PLAN-001" as never, { id: "SEC-001" as never, revision: 2 })).toBeUndefined();
  });

  it("the root becomes approved with pointers and validation intact (tests 14-15)", async () => {
    const world = await dagWorld();
    await checkpointAndComplete(world, "ses_done");
    const root = await world.store.getSection("PLAN-001" as never, "SEC-001" as never);
    expect(root).toMatchObject({ status: "approved", currentRevision: 1, approvedRevision: 1, validation: "valid" });
  });

  it("the approval lifecycle never toggles the root status (test 16)", async () => {
    const world = await dagWorld();
    await checkpointActive(world, "ses_done");
    const { prepared } = await prepareCompletion(world, "ses_done");
    const proposal = await world.store.getProposal("PLAN-001" as never, prepared.proposal.id);
    expect(proposal?.status).toBe("awaiting_approval");
    const root = await world.store.getSection("PLAN-001" as never, "SEC-001" as never);
    expect(root?.status).toBe("active"); // reserved awaiting_approval untouched
  });

  it("a rejected completion mutates no Section state (test 17)", async () => {
    const world = await dagWorld();
    await checkpointActive(world, "ses_done");
    const { prepared, begun } = await prepareCompletion(world, "ses_done");
    await world.controller.rejectProposal("ses_done", prepared.proposal.id, begun.request);
    const root = await world.store.getSection("PLAN-001" as never, "SEC-001" as never);
    expect(root).toMatchObject({ status: "active", currentRevision: 1, approvedRevision: 1, validation: "valid" });
    expect((await world.store.getRun("PLAN-001" as never))?.activeWork).toEqual({ type: "section", id: "SEC-001" });
    expect((await world.store.getRun("PLAN-001" as never))?.headCommit).toBe("COMMIT-003");
  });

  it("a failed completion leaves the Approval durable and retriable (test 18)", async () => {
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
    const completion0 = await world.controller.prepareProposal("ses_flaky", {
      type: "architecture_completion",
      scope: { type: "architecture" },
      title: "Complete architecture",
      summary: "s",
      changes: [ARCH_CHANGE, { kind: "complete_architecture" }] as never,
    });
    const begun0 = await world.controller.beginProposalApproval("ses_flaky", completion0.proposal.id);
    await world.controller.recordApprovalAndCommit("ses_flaky", completion0.proposal.id, begun0.request);
    const decomposition = await world.controller.prepareSectionDecomposition("ses_flaky", CHAIN_DECOMPOSITION);
    const dagBegun = await world.controller.beginProposalApproval("ses_flaky", decomposition.proposal.id);
    await world.controller.recordApprovalAndCommit("ses_flaky", decomposition.proposal.id, dagBegun.request);
    run = (await store.getRun(run.id)) as PlanningRun;
    await checkpointActive(world, "ses_flaky");
    const { prepared, begun } = await prepareCompletion(world, "ses_flaky");
    await world.controller.recordApproval("ses_flaky", prepared.proposal.id, begun.request);
    store.armed = true;
    await expect(world.controller.commitApprovedProposal("ses_flaky", prepared.proposal.id)).rejects.toSatisfy(
      (e: unknown) => isUltraPlanError(e) && e.code === "store_busy",
    );
    // Zero partial mutation — Section still active, focus unchanged, HEAD unchanged.
    expect((await store.getSection(run.id, "SEC-001" as never))?.status).toBe("active");
    expect((await store.getRun(run.id))?.activeWork).toEqual({ type: "section", id: "SEC-001" });
    expect((await store.getRun(run.id))?.headCommit).toBe("COMMIT-003");
    // The SAME durable approval commits on retry.
    const retry = await world.controller.commitApprovedProposal("ses_flaky", prepared.proposal.id);
    expect(retry.commit.changes.map((c) => c.kind)).toEqual(["complete_section"]);
  });

  it("an exact completion retry is idempotent (test 19)", async () => {
    const world = await dagWorld();
    await checkpointActive(world, "ses_done");
    const { prepared, begun } = await prepareCompletion(world, "ses_done");
    const first = (await world.controller.recordApprovalAndCommit("ses_done", prepared.proposal.id, begun.request)).commit;
    const retry = await world.controller.commitApprovedProposal("ses_done", prepared.proposal.id);
    expect(retry.commit.id).toBe(first.id);
    expect(await world.store.listCommits("PLAN-001" as never)).toHaveLength(4); // completion, DAG, checkpoint, completion
  });
});

// -----------------------------------------------------------------------------
// Hash + approval view (tests 20-22)
// -----------------------------------------------------------------------------

describe("completion hash + approval view (tests 20-22)", () => {
  it("the hash binds the exact revision target (test 20)", async () => {
    const world = await dagWorld();
    await checkpointActive(world, "ses_done");
    const run = (await world.store.getRun("PLAN-001" as never)) as PlanningRun;
    const crafted: Proposal = {
      id: "PROP-090" as never,
      type: "section_completion",
      scope: { id: "SEC-001" as never },
      revision: 1,
      status: "ready",
      title: "t",
      summary: "s",
      changes: [{ kind: "complete_section", target: { id: "SEC-001" as never, revision: 1 } }],
      dependencies: [],
      impact: { affectedSections: [], affectedDecisions: [] },
      createdFrom: { id: run.headSnapshot as never },
    };
    const other: Proposal = structuredClone(crafted);
    (other.changes[0] as Extract<ProposalChange, { kind: "complete_section" }>).target = {
      id: "SEC-001" as never,
      revision: 2,
    };
    expect(computeProposalHash(crafted)).not.toBe(computeProposalHash(other));
  });

  it("the approval view renders the completion deterministically and names the exact revision (tests 21-22)", async () => {
    const world = await dagWorld();
    await checkpointActive(world, "ses_done");
    const { prepared } = await prepareCompletion(world, "ses_done");
    const view = renderProposalForApproval(prepared.proposal);
    expect(view).toContain("SECTION COMPLETION SEC-001 (active -> approved)");
    expect(view).toContain("Section: SEC-001 Runtime Integration");
    expect(view).toContain("Completing revision: SEC-001@1");
    expect(view).toContain("Status: active -> approved");
    expect(view).toContain("Validation: valid");
    expect(view).toContain("Dependencies: —"); // SEC-001 has no structural deps
    expect(view).toContain("Contract: SEC-001@1 (immutable, unchanged by completion)");
    expect(view).toContain(`Approval hash: ${prepared.hash}`);
    // NOT the design body — completion re-authorizes no design facts.
    expect(view).not.toContain("Design:");
    expect(renderProposalForApproval(prepared.proposal)).toBe(view);
  });
});

// -----------------------------------------------------------------------------
// Evidence / questions / conflicts (tests 23-25)
// -----------------------------------------------------------------------------

describe("evidence, question, and conflict boundaries (tests 23-25)", () => {
  it("stale critical Evidence reachable via SectionRevision → Decision → Evidence blocks completion (test 23)", async () => {
    const world = await dagWorld();
    // Stale critical evidence (uncertain confidence → freshness forced to
    // needs_validation; it can never satisfy the freshness gate).
    const promoted = await world.controller.promoteEvidence("ses_done", {
      claim: "the store uses atomic rename",
      kind: "file",
      scopeType: "run",
      criticality: "critical",
      confidence: "uncertain",
    });
    expect(promoted.freshness).toBe("needs_validation");
    // Seed the reachable chain (TEST-ONLY seam): SEC-001@1 references
    // DEC-001, and DEC-001 carries the stale critical evidence ref. The
    // completion must fail closed along exactly this represented chain —
    // no repository scanning, no speculative reachability.
    world.store.seedCommittedState("PLAN-001" as never, {
      sections: [
        {
          id: "SEC-001" as never,
          title: "Runtime Integration",
          objective: "o",
          dependencies: [],
          status: "active" as const,
          validation: "valid" as const,
          currentRevision: 1,
          approvedRevision: 1,
        },
      ],
      decisions: [
        {
          id: "DEC-001" as never,
          revision: 1,
          title: "Storage shape",
          status: "approved",
          approvedAt: FIXED,
          statement: "append-only",
          rationale: "durable",
          scope: {},
          evidence: [{ id: promoted.id, revision: 1 }],
        },
      ],
      sectionRevisions: [
        {
          sectionID: "SEC-001" as never,
          revision: 1,
          status: "approved" as const,
          problem: "p",
          design: "d",
          interfaces: [],
          invariants: [],
          failureModes: [],
          dependencies: [],
          decisions: ["DEC-001" as never],
          openQuestions: [],
          impacts: [],
          projection: {
            compact: "c",
            contract: { sectionID: "SEC-001" as never, revision: 1, provides: [], requires: [], invariants: [], interfaces: [], decisions: [{ id: "DEC-001" as never, revision: 1 }] },
          },
          createdAt: FIXED,
        },
      ],
      activeWork: { type: "section", id: "SEC-001" as never },
    });
    // Freeze-side: the precise blocker surfaces at preparation.
    await expect(
      world.controller.requestCompletion("ses_done", { kind: "section" }),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "evidence_not_fresh");
  });

  it("an unrelated blocking OpenQuestion does NOT trigger Final Plan rules (test 24)", async () => {
    const world = await dagWorld();
    await checkpointActive(world, "ses_done");
    await world.controller.recordQuestion("ses_done", {
      question: "Which lock primitive?",
      blocking: true,
      scope: { type: "section", sectionID: "SEC-003" },
    });
    // Completion proceeds despite the blocking question — artifact-local
    // boundary, not the finalization predicate.
    await expect(checkpointAndComplete(world, "ses_done")).resolves.toBeDefined();
    const root = await world.store.getSection("PLAN-001" as never, "SEC-001" as never);
    expect(root?.status).toBe("approved");
  });

  it("a relevant blocking conflict still blocks the transaction (test 25)", async () => {
    const world = await dagWorld();
    await checkpointActive(world, "ses_done");
    await world.controller.raiseConflict("ses_done", {
      type: "section",
      refs: [{ kind: "section", id: "SEC-001" }],
      description: "SEC-001 design contradicts the committed constraint",
      severity: "blocking",
    });
    const { prepared, begun } = await prepareCompletion(world, "ses_done");
    await world.controller.recordApproval("ses_done", prepared.proposal.id, begun.request);
    await expect(
      world.controller.commitApprovedProposal("ses_done", prepared.proposal.id),
    ).rejects.toSatisfy((e: unknown) => failCodes(e).includes("conflict_blocking"));
    expect((await world.store.getSection("PLAN-001" as never, "SEC-001" as never))?.status).toBe("active");
  });
});

// -----------------------------------------------------------------------------
// Manual focus switching (tests 26-31)
// -----------------------------------------------------------------------------

describe("manual focus switching (tests 26-31)", () => {
  it("focus targets committed Sections of the run only (test 26)", async () => {
    const world = await dagWorld();
    await expect(
      world.controller.requestSectionFocus("ses_done", { sectionID: "SEC-099" }),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "unknown_reference");
  });

  it("focus cannot target an approved Section (test 27)", async () => {
    const world = await dagWorld();
    await checkpointAndComplete(world, "ses_done"); // SEC-001 approved, focus SEC-002
    await expect(
      world.controller.requestSectionFocus("ses_done", { sectionID: "SEC-001" }),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "invalid_scope");
  });

  it("focus MAY target a Section with incomplete dependencies (test 28)", async () => {
    const world = await dagWorld();
    await expect(
      world.controller.requestSectionFocus("ses_done", { sectionID: "SEC-003" }),
    ).resolves.toBeDefined(); // discussion order != completion order
    const run = (await world.store.getRun("PLAN-001" as never)) as PlanningRun;
    expect(run.activeWork).toEqual({ type: "section", id: "SEC-003" });
    // The focus event is workflow audit, not a PlanCommit.
    const events = (await world.store.listEvents("PLAN-001" as never)).map((e) => e.detail);
    const focusEvent = events.find((e) => e.type === "run.active_work_changed");
    expect(focusEvent).toMatchObject({ from: { type: "section", id: "SEC-001" as never }, to: { type: "section", id: "SEC-003" } });
  });

  it("generic direct activeWork mutation stays forbidden (test 29)", async () => {
    const world = await dagWorld();
    const run = (await world.store.getRun("PLAN-001" as never)) as PlanningRun;
    await expect(
      world.store.saveRun({ ...run, activeWork: { type: "section", id: "SEC-003" as never } }),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "commit_gated_run_field");
  });

  it("an idempotent focus request is a no-op without a duplicate event (§22)", async () => {
    const world = await dagWorld();
    await world.controller.requestSectionFocus("ses_done", { sectionID: "SEC-002" });
    const eventsBefore = (await world.store.listEvents("PLAN-001" as never)).length;
    await world.controller.requestSectionFocus("ses_done", { sectionID: "SEC-002" });
    expect(await world.store.listEvents("PLAN-001" as never)).toHaveLength(eventsBefore);
  });
});

// -----------------------------------------------------------------------------
// Deterministic progression (tests 32-40)
// -----------------------------------------------------------------------------

describe("deterministic next-work selection (tests 32-40)", () => {
  it("an ordinary completion selects the deterministic next eligible Section and keeps stage=detail (tests 32/37)", async () => {
    const world = await dagWorld();
    const commit = await checkpointAndComplete(world, "ses_done");
    const run = (await world.store.getRun("PLAN-001" as never)) as PlanningRun;
    expect(run.activeWork).toEqual({ type: "section", id: "SEC-002" });
    expect(run.stage).toBe("detail");
    expect(commit.changes.map((c) => c.kind)).toEqual(["complete_section"]);
  });

  it("canonical order breaks ties between eligible Sections (test 33)", async () => {
    // Independent DAG: SEC-001 → (SEC-002, SEC-003); completing SEC-001 must
    // focus SEC-002 (first eligible in canonical order), never ask the model.
    const world = makeWorld();
    const sessionID = "ses_tie";
    await admittedStart(world.controller, sessionID, GOAL);
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
    const decomposition = await world.controller.prepareSectionDecomposition(sessionID, {
      sections: [
        { key: "a", title: "A", objective: "o" },
        { key: "b", title: "B", objective: "o" },
        { key: "c", title: "C", objective: "o" },
      ],
      initialSection: "a",
    });
    const dagBegun = await world.controller.beginProposalApproval(sessionID, decomposition.proposal.id);
    await world.controller.recordApprovalAndCommit(sessionID, decomposition.proposal.id, dagBegun.request);
    await checkpointAndComplete(world, sessionID);
    const run = (await world.store.getRun("PLAN-001" as never)) as PlanningRun;
    expect(run.activeWork).toEqual({ type: "section", id: "SEC-002" });
  });

  it("the selector skips Sections whose dependencies are incomplete (test 34)", async () => {
    // Chain DAG: after SEC-001 completes, SEC-003 (deps SEC-002 unapproved)
    // is skipped even though a naive linear scan might pick it.
    const world = await dagWorld();
    await checkpointAndComplete(world, "ses_done"); // → SEC-002 (not SEC-003)
    const run = (await world.store.getRun("PLAN-001" as never)) as PlanningRun;
    expect(run.activeWork).toEqual({ type: "section", id: "SEC-002" });
  });

  it("an unfinished DAG with no eligible target fails closed (test 35)", async () => {
    // Inconsistent state (dangling dependency) — unreachable through real
    // flows, constructed via the TEST-ONLY seam; the completion commit must
    // refuse to pick an arbitrary Section or escape to synthesis.
    const world = makeWorld();
    const sessionID = "ses_stuck";
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
    world.store.seedCommittedState(run.id, {
      sections: [
        { id: "SEC-001" as never, title: "A", objective: "o", dependencies: [], status: "active", validation: "valid", currentRevision: 1, approvedRevision: 1 },
        { id: "SEC-002" as never, title: "B", objective: "o", dependencies: ["SEC-999" as never], status: "pending", validation: "valid" },
      ],
      sectionRevisions: [
        {
          sectionID: "SEC-001" as never,
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
          projection: { compact: "c", contract: { sectionID: "SEC-001" as never, revision: 1, provides: [], requires: [], invariants: [], interfaces: [], decisions: [] } },
          createdAt: FIXED,
        },
      ],
      activeWork: { type: "section", id: "SEC-001" as never },
    });
    const { prepared, begun: begun2 } = await prepareCompletion(world, sessionID);
    await world.controller.recordApproval(sessionID, prepared.proposal.id, begun2.request);
    await expect(
      world.controller.commitApprovedProposal(sessionID, prepared.proposal.id),
    ).rejects.toSatisfy((e: unknown) => failCodes(e).includes("no_eligible_section"));
    // Nothing mutated — no arbitrary pick, no synthesis escape.
    const after = (await world.store.getRun(run.id)) as PlanningRun;
    expect(after.stage).toBe("detail");
    expect(after.activeWork).toEqual({ type: "section", id: "SEC-001" });
    expect((await world.store.getSection(run.id, "SEC-001" as never))?.status).toBe("active");
  });

  it("completion + next activeWork publish ATOMICALLY — a failed commit leaves the focus unchanged (test 36)", async () => {
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
    const sessionID = "ses_atomic";
    let run = (await admittedStart(world.controller, sessionID, GOAL)).run;
    await world.controller.requestArchitecture(sessionID);
    const completion0 = await world.controller.prepareProposal(sessionID, {
      type: "architecture_completion",
      scope: { type: "architecture" },
      title: "Complete architecture",
      summary: "s",
      changes: [ARCH_CHANGE, { kind: "complete_architecture" }] as never,
    });
    const begun0 = await world.controller.beginProposalApproval(sessionID, completion0.proposal.id);
    await world.controller.recordApprovalAndCommit(sessionID, completion0.proposal.id, begun0.request);
    const decomposition = await world.controller.prepareSectionDecomposition(sessionID, CHAIN_DECOMPOSITION);
    const dagBegun = await world.controller.beginProposalApproval(sessionID, decomposition.proposal.id);
    await world.controller.recordApprovalAndCommit(sessionID, decomposition.proposal.id, dagBegun.request);
    run = (await store.getRun(run.id)) as PlanningRun;
    await checkpointActive(world, sessionID);
    const { prepared, begun } = await prepareCompletion(world, sessionID);
    await world.controller.recordApproval(sessionID, prepared.proposal.id, begun.request);
    store.armed = true;
    await expect(world.controller.commitApprovedProposal(sessionID, prepared.proposal.id)).rejects.toSatisfy(
      (e: unknown) => isUltraPlanError(e) && e.code === "store_busy",
    );
    // The focus did NOT move ahead of the approval: no split publication.
    expect((await store.getRun(run.id))?.activeWork).toEqual({ type: "section", id: "SEC-001" });
    expect((await store.getSection(run.id, "SEC-001" as never))?.status).toBe("active");
  });

  it("the LAST completion clears activeWork and moves detail → synthesis in the SAME commit (tests 38-39)", async () => {
    const world = await dagWorld();
    await checkpointAndComplete(world, "ses_done"); // SEC-001 → focus SEC-002
    await checkpointAndComplete(world, "ses_done"); // SEC-002 → focus SEC-003
    const commitsBefore = (await world.store.listCommits("PLAN-001" as never)).length;
    const commit = await checkpointAndComplete(world, "ses_done"); // SEC-003 → synthesis
    const run = (await world.store.getRun("PLAN-001" as never)) as PlanningRun;
    expect(run.stage).toBe("synthesis");
    expect(run.activeWork).toBeUndefined();
    expect(run.lifecycle).toBe("active"); // synthesis admission is NOT finalization
    expect((await world.store.listCommits("PLAN-001" as never)).length).toBe(commitsBefore + 2); // checkpoint + completion
    // The stage transition event is part of the SAME publication.
    const events = (await world.store.listEvents("PLAN-001" as never)).map((e) => e.detail);
    const stageEvent = events.filter((e) => e.type === "run.stage_changed").at(-1);
    expect(stageEvent).toMatchObject({ from: "detail", to: "synthesis" });
    expect(commit.changes.map((c) => c.kind)).toEqual(["complete_section"]);
    // Snapshot represents the closed detail set (§35).
    const snapshot = await world.store.getHeadSnapshot("PLAN-001" as never);
    expect(snapshot?.commit).toBe(commit.id);
    expect(snapshot?.state.sectionRoots?.map((r) => r.status)).toEqual(["approved", "approved", "approved"]);
    expect(snapshot?.state.activeWork).toBeUndefined(); // absence is meaningful
  });

  it("the last completion requires EVERY Section valid — an approved-but-invalid DAG fails closed (test 40)", async () => {
    const world = await dagWorld();
    // Corrupt the (seeded) world: SEC-003 approved but needs_review while
    // SEC-001 completes the remaining work. Unreachable through real flows.
    await checkpointAndComplete(world, "ses_done"); // SEC-001 → focus SEC-002
    const sections = await world.store.listSections("PLAN-001" as never);
    const sec3 = sections.find((s) => s.id === "SEC-003") as Section;
    world.store.seedCommittedState("PLAN-001" as never, {
      sections: [{ ...sec3, status: "approved", validation: "needs_review", currentRevision: 1, approvedRevision: 1 }],
    });
    await checkpointActive(world, "ses_done"); // SEC-002@1
    const { prepared, begun } = await prepareCompletion(world, "ses_done");
    await world.controller.recordApproval("ses_done", prepared.proposal.id, begun.request);
    // Completing SEC-002 approves EVERY section — but SEC-003 is invalid, so
    // the synthesis entry gate fails the commit closed instead.
    await expect(
      world.controller.commitApprovedProposal("ses_done", prepared.proposal.id),
    ).rejects.toSatisfy((e: unknown) => failCodes(e).includes("sections_not_valid"));
    const run = (await world.store.getRun("PLAN-001" as never)) as PlanningRun;
    expect(run.stage).toBe("detail");
    expect(run.activeWork).toEqual({ type: "section", id: "SEC-002" });
    const root2 = await world.store.getSection("PLAN-001" as never, "SEC-002" as never);
    expect(root2?.status).toBe("active"); // SEC-002 NOT completed
  });

  it("the last completion creates no SynthesisManifest or finalization output (test 41)", async () => {
    const world = await dagWorld();
    await checkpointAndComplete(world, "ses_done");
    await checkpointAndComplete(world, "ses_done");
    await checkpointAndComplete(world, "ses_done");
    const run = (await world.store.getRun("PLAN-001" as never)) as PlanningRun;
    expect(run.stage).toBe("synthesis");
    expect(run.finalPlan).toBeUndefined(); // no Final Plan machinery ran
    // Only the section-revision artifacts exist — no synthesis objects.
    const proposals = await world.store.listProposals("PLAN-001" as never);
    expect(proposals.some((p) => p.type === "final_plan")).toBe(false);
  });

  it("synthesis exposes NO provisional finalization shortcut (tests 42-43)", async () => {
    const world = await dagWorld();
    await checkpointAndComplete(world, "ses_done");
    await checkpointAndComplete(world, "ses_done");
    await checkpointAndComplete(world, "ses_done");
    await expect(
      world.controller.requestSynthesis("ses_done"),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "capability_not_available");
    await expect(
      world.controller.prepareProposal("ses_done", {
        type: "design_checkpoint",
        scope: { type: "architecture" },
        title: "t",
        summary: "s",
        changes: [{ kind: "add_decision", content: { title: "t", statement: "s", rationale: "r" } }] as never,
      }),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "capability_not_available");
    await expect(
      world.controller.requestSectionFocus("ses_done", { sectionID: "SEC-001" }),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "capability_not_available");
  });
});

// -----------------------------------------------------------------------------
// Workflows: discussion-ahead + needs_review (tests 53-54, §45/§46)
// -----------------------------------------------------------------------------

describe("discussion-ahead and needs_review workflows (tests 53-54)", () => {
  it("discussion order != completion order; a needs_review section recheckpoints to valid before completing (§45/§46)", async () => {
    const world = await dagWorld(); // focus SEC-001
    // Jump ahead: focus SEC-003 (deps incomplete) and checkpoint it.
    await world.controller.requestSectionFocus("ses_done", { sectionID: "SEC-003" });
    await checkpointActive(world, "ses_done"); // SEC-003@1, dep SEC-002 has no contract → needs_review
    // Completion fails: dependencies incomplete.
    await expect(
      world.controller.requestCompletion("ses_done", { kind: "section" }),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "dependency_incomplete");
    // Focus SEC-001, checkpoint + complete.
    await world.controller.requestSectionFocus("ses_done", { sectionID: "SEC-001" });
    await checkpointAndComplete(world, "ses_done"); // auto-focus SEC-002
    // Checkpoint + complete SEC-002.
    await checkpointAndComplete(world, "ses_done"); // auto-focus: SEC-003 (deps now approved)
    // SEC-003 is needs_review (its dep's contract appeared after its
    // checkpoint) — completion fails until a revalidated checkpoint lands.
    await expect(
      world.controller.requestCompletion("ses_done", { kind: "section" }),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "section_needs_review");
    const sec3Before = await world.store.getSection("PLAN-001" as never, "SEC-003" as never);
    expect(sec3Before?.validation).toBe("needs_review");
    // Revalidation checkpoint binds SEC-002@1 → valid → completion restores
    // the deterministic flow and closes detail into synthesis.
    await checkpointActive(world, "ses_done"); // SEC-003@2
    const { prepared, begun } = await prepareCompletion(world, "ses_done");
    await world.controller.recordApprovalAndCommit("ses_done", prepared.proposal.id, begun.request);
    const run = (await world.store.getRun("PLAN-001" as never)) as PlanningRun;
    expect(run.stage).toBe("synthesis");
    expect(run.activeWork).toBeUndefined();
    const sec3After = await world.store.getSection("PLAN-001" as never, "SEC-003" as never);
    expect(sec3After).toMatchObject({ status: "approved", currentRevision: 2, approvedRevision: 2, validation: "valid" });
    // Revision 1 remains immutable.
    expect(
      await world.store.getSectionRevision("PLAN-001" as never, { id: "SEC-003" as never, revision: 1 }),
    ).toMatchObject({ revision: 1 });
  });
});

// -----------------------------------------------------------------------------
// L0 guidance + status rendering (tests 59-62)
// -----------------------------------------------------------------------------

describe("L0 guidance + status rendering (tests 59-62)", () => {
  it("L0 detail guidance is deterministic for ready and blocked completion (test 59)", async () => {
    const world = await dagWorld();
    const run = (await world.store.getRun("PLAN-001" as never)) as PlanningRun;
    const root = (await world.store.getSection("PLAN-001" as never, "SEC-001" as never)) as Section;
    // Revisionless: checkpoint guidance.
    const revisionless = renderPlanningProtocol({
      run,
      activeSection: {
        id: root.id,
        title: root.title,
        objective: root.objective,
        dependencies: root.dependencies,
        validation: root.validation,
        dependencyContracts: [],
      },
    });
    expect(revisionless).toContain("first checkpoint freezes revision 1");
    expect(renderPlanningProtocol({
      run,
      activeSection: {
        id: root.id,
        title: root.title,
        objective: root.objective,
        dependencies: root.dependencies,
        validation: root.validation,
        dependencyContracts: [],
      },
    })).toBe(revisionless);
    // Checkpointed + blocked: names the blocker and the focus tool.
    const blocked = renderPlanningProtocol({
      run,
      activeSection: {
        id: root.id,
        title: root.title,
        objective: root.objective,
        dependencies: root.dependencies,
        currentRevision: 1,
        validation: "valid",
        dependencyContracts: [],
        completionBlocked: "dependency SEC-009 not approved",
      },
    });
    expect(blocked).toContain("Do not request completion as if it can bypass blockers");
    expect(blocked).toContain("ultraplan_request_section_focus");
    // Checkpointed + ready: names the completion operation and what it verifies.
    const ready = renderPlanningProtocol({
      run,
      activeSection: {
        id: root.id,
        title: root.title,
        objective: root.objective,
        dependencies: root.dependencies,
        currentRevision: 1,
        validation: "valid",
        dependencyContracts: [],
      },
    });
    expect(ready).toContain("You may request Section completion");
    expect(ready).toContain("verify all required dependency Sections are approved");
    expect(renderPlanningProtocol({
      run,
      activeSection: {
        id: root.id,
        title: root.title,
        objective: root.objective,
        dependencies: root.dependencies,
        currentRevision: 1,
        validation: "valid",
        dependencyContracts: [],
      },
    })).toBe(ready);
  });

  it("L0 synthesis guidance is deterministic, authority-bound, and forbids finalization (test 60, updated by Phase 2F §45 + 2G §58)", async () => {
    const world = await dagWorld();
    await checkpointAndComplete(world, "ses_done");
    await checkpointAndComplete(world, "ses_done");
    await checkpointAndComplete(world, "ses_done");
    const run = (await world.store.getRun("PLAN-001" as never)) as PlanningRun;
    const synthesis = renderPlanningProtocol({ run });
    // The 2E2 placeholder is gone; the real Phase 2F authority guidance stands.
    expect(synthesis).not.toContain("Synthesis execution is not implemented in this phase");
    expect(synthesis).toContain("AUTHORITY: only approved Plan Memory and the frozen SynthesisInput are normative inputs");
    expect(synthesis).toContain("You MUST NOT: invent new architecture");
    expect(synthesis).toContain("claim semantic validation passed, evidence audited, or the plan final");
    expect(synthesis).toContain("do not fill the gap here");
    expect(synthesis).toContain("The SynthesisInput is not frozen yet");
    // request_synthesis appears only as an UNCHECKED capability in the
    // checklist — the capability itself is withheld in synthesis.
    expect(synthesis).toContain("- [ ] request_synthesis");
    // The frozen-input substate flips the checklist to submit_synthesis_manifest.
    const withInput = renderPlanningProtocol({
      run,
      synthesis: { inputID: "SYN-IN-001", baseSnapshot: run.headSnapshot, inputHash: "h" },
    });
    expect(withInput).toContain("- [x] begin_synthesis");
    expect(withInput).toContain("- [x] submit_synthesis_manifest");
    expect(withInput).toContain(`Frozen SynthesisInput: SYN-IN-001 (base ${run.headSnapshot}`);
    // Phase 2G §58: a frozen manifest renders the unvalidated fragment; the
    // validation result picks the findings/clean fragments deterministically.
    const withManifest = renderPlanningProtocol({
      run,
      synthesis: { inputID: "SYN-IN-001", baseSnapshot: run.headSnapshot, inputHash: "h", manifestRef: "SYN-001@1", manifestHash: "m" },
    });
    expect(withManifest).toContain(
      "The current SynthesisManifest is structurally valid but has not received semantic validation.",
    );
    expect(withManifest).toContain("Request semantic validation.");
    expect(withManifest).toContain("Do not self-declare the Manifest clean.");
    expect(withManifest).toContain("- [x] run_semantic_validation");
    const withFindings = renderPlanningProtocol({
      run,
      synthesis: { inputID: "SYN-IN-001", baseSnapshot: run.headSnapshot, inputHash: "h", manifestRef: "SYN-001@1", manifestHash: "m", validationResult: "findings" },
    });
    expect(withFindings).toContain("Semantic validation found blocking issues.");
    expect(withFindings).toContain("If approved design must change, request sanctioned Section reopen");
    expect(withFindings).toContain("- [x] request_reopen");
    const withClean = renderPlanningProtocol({
      run,
      synthesis: { inputID: "SYN-IN-001", baseSnapshot: run.headSnapshot, inputHash: "h", manifestRef: "SYN-001@1", manifestHash: "m", validationResult: "clean" },
    });
    // Phase 2H §58: the clean fragment points at deterministic finalization.
    expect(withClean).toContain("Semantic validation is clean.");
    expect(withClean).toContain("You may request deterministic finalization.");
    expect(withClean).toContain("Finalization will independently verify:");
    expect(withClean).toContain("- [x] request_finalization");
    // A CURRENT candidate flips the surface to the minimal candidate-ready
    // recheck set (2H §53/§54): request_finalization for idempotent
    // retrieval; begin/submit/run_validation are unchecked there.
    const withCandidate = renderPlanningProtocol({
      run,
      synthesis: {
        inputID: "SYN-IN-001",
        baseSnapshot: run.headSnapshot,
        inputHash: "h",
        manifestRef: "SYN-001@1",
        manifestHash: "m",
        validationResult: "clean",
        finalization: { state: "passed", candidate: { ref: "FPC-001@1", current: true } },
      },
    });
    expect(withCandidate).toContain("A current FinalPlanCandidate exists.");
    // Phase 2I §86: candidate-ready now points at the formal Final Proposal.
    expect(withCandidate).toContain("You may prepare the formal Final Plan Proposal.");
    expect(withCandidate).toContain("The Finalization Gate will be rerun.");
    expect(withCandidate).toContain("Do not alter approved design.");
    expect(withCandidate).toContain("- [x] request_finalization");
    expect(withCandidate).toContain("- [x] prepare_final_plan");
    expect(withCandidate).toContain("- [ ] submit_synthesis_manifest");
    // A CURRENT final_plan Proposal flips to the final-proposal surface
    // (2I §50/§51) and its §86 verbatim fragment.
    const withFinalProposal = renderPlanningProtocol({
      run,
      synthesis: {
        inputID: "SYN-IN-001",
        baseSnapshot: run.headSnapshot,
        inputHash: "h",
        manifestRef: "SYN-001@1",
        manifestHash: "m",
        validationResult: "clean",
        finalization: { state: "passed", candidate: { ref: "FPC-001@1", current: true } },
        finalProposal: { ref: "PROP-009", status: "ready" },
      },
    });
    expect(withFinalProposal).toContain("The exact Final Plan Proposal is frozen.");
    expect(withFinalProposal).toContain("Request explicit user approval.");
    expect(withFinalProposal).toContain("User approval authorizes only this exact Proposal.");
    expect(withFinalProposal).toContain("- [x] request_user_approval");
    expect(withFinalProposal).toContain("- [ ] submit_synthesis_manifest");
    // The awaiting fragment forbids reinterpretation of conversation (§86).
    const withAwaiting = renderPlanningProtocol({
      run,
      synthesis: {
        inputID: "SYN-IN-001",
        baseSnapshot: run.headSnapshot,
        inputHash: "h",
        manifestRef: "SYN-001@1",
        manifestHash: "m",
        validationResult: "clean",
        finalization: { state: "passed", candidate: { ref: "FPC-001@1", current: true } },
        finalProposal: { ref: "PROP-009", status: "awaiting_approval" },
      },
    });
    expect(withAwaiting).toContain("Await the formal user decision.");
    expect(withAwaiting).toContain("Do not reinterpret normal conversation as approval.");
    expect(renderPlanningProtocol({ run })).toBe(synthesis);
    expect(
      renderPlanningProtocol({ run, synthesis: { inputID: "SYN-IN-001", baseSnapshot: run.headSnapshot, inputHash: "h" } }),
    ).toBe(withInput);
  });

  it("status renders the detail completion state correctly (test 61)", async () => {
    const world = await dagWorld();
    await checkpointActive(world, "ses_done"); // SEC-001 valid, no deps → ready
    const run = (await world.store.getRun("PLAN-001" as never)) as PlanningRun;
    const root = (await world.store.getSection("PLAN-001" as never, "SEC-001" as never)) as Section;
    let status = renderStatus(run, { activeSection: root, completion: { state: "ready" } });
    expect(status).toContain("Completion: ready");
    // Blocked variant with the deterministic reason.
    status = renderStatus(run, { activeSection: root, completion: { state: "blocked", reason: "dependency SEC-009 not approved" } });
    expect(status).toContain("Completion: blocked");
    expect(status).toContain("Reason: dependency SEC-009 not approved");
    // The REAL rendered status (renderRunStatus path) for a dependent section:
    await world.controller.requestSectionFocus("ses_done", { sectionID: "SEC-002" });
    await checkpointActive(world, "ses_done"); // SEC-002 needs_review (SEC-001 no contract... approved? no)
    const report = await world.controller.statusReport("ses_done");
    expect(report.statusText).toContain("Completion: blocked");
    expect(report.statusText).toMatch(/Reason: (dependency SEC-001 not approved|validation needs_review)/);
    void run;
    void root;
  });

  it("status renders the synthesis-entry state correctly (test 62)", async () => {
    const world = await dagWorld();
    await checkpointAndComplete(world, "ses_done");
    await checkpointAndComplete(world, "ses_done");
    await checkpointAndComplete(world, "ses_done");
    const report = await world.controller.statusReport("ses_done");
    expect(report.statusText).toContain("Stage: synthesis");
    expect(report.statusText).toContain("Active work: none");
    expect(report.statusText).toContain("Sections: all approved");
    expect(report.statusText).not.toContain("Synthesis ran");
  });
});

// -----------------------------------------------------------------------------
// Durable recovery (§40), PRIMARY integration (§51), concurrency (§42/§43)
// -----------------------------------------------------------------------------

describe("durable completion recovery, PRIMARY integration, concurrency", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "ultraplan-done-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  function openStore(dbFile: string): DurablePlanStore {
    return new DurablePlanStore(dbFile, { now: () => FIXED });
  }

  /** Drive a REAL durable world: detail → chain DAG → SEC-001 completed. */
  async function durableChainWorld(store: DurablePlanStore, sessionID: string) {
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
    const decomposition = await world.controller.prepareSectionDecomposition(sessionID, CHAIN_DECOMPOSITION);
    const dagBegun = await world.controller.beginProposalApproval(sessionID, decomposition.proposal.id);
    await world.controller.recordApprovalAndCommit(sessionID, decomposition.proposal.id, dagBegun.request);
    run = (await store.getRun(run.id)) as PlanningRun;
    return { world, run };
  }

  it("§51 PRIMARY: three full checkpoint→completion cycles, durable close/reopen deep-equality, synthesis entry", async () => {
    const dbFile = path.join(dir, "plan-store.json");
    const store = openStore(dbFile);
    const { world } = await durableChainWorld(store, "ses_primary");
    // Per Section: checkpoint → Approval → PlanCommit → request completion →
    // Approval → completion PlanCommit → automatic next focus.
    await checkpointAndComplete(world, "ses_primary");
    await checkpointAndComplete(world, "ses_primary");
    await checkpointAndComplete(world, "ses_primary");

    const run = (await store.getRun("PLAN-001" as never)) as PlanningRun;
    expect(run.stage).toBe("synthesis");
    expect(run.activeWork).toBeUndefined();
    expect(run.headCommit).toBe("COMMIT-008");
    const sections = await store.listSections("PLAN-001" as never);
    expect(sections.map((s) => s.status)).toEqual(["approved", "approved", "approved"]);
    expect(sections.map((s) => s.validation)).toEqual(["valid", "valid", "valid"]);

    const before = {
      run,
      sections,
      revisions: [
        await store.getSectionRevision("PLAN-001" as never, { id: "SEC-001" as never, revision: 1 }),
        await store.getSectionRevision("PLAN-001" as never, { id: "SEC-002" as never, revision: 1 }),
        await store.getSectionRevision("PLAN-001" as never, { id: "SEC-003" as never, revision: 1 }),
      ],
      snapshot: await store.getHeadSnapshot("PLAN-001" as never),
      commits: await store.listCommits("PLAN-001" as never),
      events: await store.listEvents("PLAN-001" as never),
    };

    store.close();
    const reopened = openStore(dbFile);
    await reopened.open();
    // Deep equality of the authoritative state — no conversation reconstruction.
    expect(await reopened.getRun("PLAN-001" as never)).toEqual(before.run);
    expect(await reopened.listSections("PLAN-001" as never)).toEqual(before.sections);
    expect(await reopened.getSectionRevision("PLAN-001" as never, { id: "SEC-001" as never, revision: 1 })).toEqual(before.revisions[0]);
    expect(await reopened.getSectionRevision("PLAN-001" as never, { id: "SEC-002" as never, revision: 1 })).toEqual(before.revisions[1]);
    expect(await reopened.getSectionRevision("PLAN-001" as never, { id: "SEC-003" as never, revision: 1 })).toEqual(before.revisions[2]);
    expect(await reopened.getHeadSnapshot("PLAN-001" as never)).toEqual(before.snapshot);
    expect(await reopened.listCommits("PLAN-001" as never)).toEqual(before.commits);
    expect(await reopened.listEvents("PLAN-001" as never)).toEqual(before.events);
    // HEAD is the final completion commit; the snapshot shows the closed DAG
    // with the focus absent (meaningful absence).
    expect(before.snapshot?.commit).toBe("COMMIT-008");
    expect(before.snapshot?.state.activeWork).toBeUndefined();
    reopened.close();
  });

  it("restart preserves the ordinary completion progression and a manual focus switch (tests 44-45)", async () => {
    const dbFile = path.join(dir, "plan-store.json");
    const store = openStore(dbFile);
    const { world } = await durableChainWorld(store, "ses_restart");
    await checkpointAndComplete(world, "ses_restart"); // SEC-001 → focus SEC-002
    await world.controller.requestSectionFocus("ses_restart", { sectionID: "SEC-003" }); // manual switch
    const before = {
      run: await store.getRun("PLAN-001" as never),
      sections: await store.listSections("PLAN-001" as never),
    };
    store.close();

    const reopened = openStore(dbFile);
    await reopened.open();
    expect(await reopened.getRun("PLAN-001" as never)).toEqual(before.run);
    expect(await reopened.listSections("PLAN-001" as never)).toEqual(before.sections);
    expect(before.run?.activeWork).toEqual({ type: "section", id: "SEC-003" });
    const focusEvents = (await reopened.listEvents("PLAN-001" as never))
      .map((e) => e.detail)
      .filter((e) => e.type === "run.active_work_changed");
    expect(focusEvents).toHaveLength(1); // the MANUAL switch only — in-commit
    // progression is auditable through PlanCommit.changes, not a redundant event.
    reopened.close();
  });

  it("restart preserves the synthesis entry state (test 46)", async () => {
    const dbFile = path.join(dir, "plan-store.json");
    const store = openStore(dbFile);
    const { world } = await durableChainWorld(store, "ses_syn");
    await checkpointAndComplete(world, "ses_syn");
    await checkpointAndComplete(world, "ses_syn");
    await checkpointAndComplete(world, "ses_syn");
    const before = await store.getRun("PLAN-001" as never);
    store.close();
    const reopened = openStore(dbFile);
    await reopened.open();
    expect(await reopened.getRun("PLAN-001" as never)).toEqual(before);
    // The withheld shortcut stays withheld after restart.
    await expect(
      world.controller.requestSynthesis("ses_syn"),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "capability_not_available");
    reopened.close();
  });

  it("two instances freeze competing completions; the loser fails stale with no duplicate completion (tests 51-52)", async () => {
    const dbFile = path.join(dir, "plan-store.json");
    const storeA = openStore(dbFile);
    const storeB = openStore(dbFile);
    const { world: worldA } = await durableChainWorld(storeA, "ses_race");
    await checkpointActive(worldA, "ses_race");
    const worldB = makeWorld(storeB);
    const prepA = await prepareCompletion(worldA, "ses_race");
    const prepB = await prepareCompletion(worldB, "ses_race");
    expect(prepB.prepared.proposal.id).not.toBe(prepA.prepared.proposal.id);
    // A commits first: SEC-001 approved, focus moves to SEC-002.
    await worldA.controller.recordApprovalAndCommit("ses_race", prepA.prepared.proposal.id, prepA.begun.request);
    // B loses via HEAD protection; no duplicate completion, no duplicate focus.
    await worldB.controller.recordApproval("ses_race", prepB.prepared.proposal.id, prepB.begun.request);
    await expect(
      worldB.controller.commitApprovedProposal("ses_race", prepB.prepared.proposal.id),
    ).rejects.toSatisfy((e: unknown) => failCodes(e).includes("head_snapshot_mismatch"));
    expect(await storeA.listCommits("PLAN-001" as never)).toHaveLength(4);
    const root = await storeA.getSection("PLAN-001" as never, "SEC-001" as never);
    expect(root?.status).toBe("approved");
    storeA.close();
    storeB.close();
  });

  it("two instances attempting incompatible focus transitions from the same expected focus: the loser fails stale (test 31, §42)", async () => {
    const dbFile = path.join(dir, "plan-store.json");
    const storeA = openStore(dbFile);
    const storeB = openStore(dbFile);
    await durableChainWorld(storeA, "ses_focus");
    const worldA = makeWorld(storeA);
    // BOTH instances observed activeWork = SEC-001 (the expected focus).
    // A's transition wins; B then issues its transition with the SAME stale
    // expected focus — the store-level CAS (revalidated under the write lock
    // after rehydration) refuses it instead of last-writer-wins drift.
    await worldA.controller.requestSectionFocus("ses_focus", { sectionID: "SEC-002" });
    await expect(
      storeB.transitionActiveWork(
        "PLAN-001" as never,
        { type: "section", id: "SEC-001" as never },
        { type: "section", id: "SEC-003" as never },
      ),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "stale_active_work");
    // No last-writer-wins drift: A's transition stands.
    const run = await storeA.getRun("PLAN-001" as never);
    expect(run?.activeWork).toEqual({ type: "section", id: "SEC-002" });
    storeA.close();
    storeB.close();
  });

  it("a manual focus transition persists durably with its event (test 30)", async () => {
    const dbFile = path.join(dir, "plan-store.json");
    const store = openStore(dbFile);
    const { world } = await durableChainWorld(store, "ses_focus2");
    await world.controller.requestSectionFocus("ses_focus2", { sectionID: "SEC-002" });
    const before = await store.getRun("PLAN-001" as never);
    store.close();
    const reopened = openStore(dbFile);
    await reopened.open();
    expect(await reopened.getRun("PLAN-001" as never)).toEqual(before);
    expect(before?.activeWork).toEqual({ type: "section", id: "SEC-002" });
    reopened.close();
  });
});
