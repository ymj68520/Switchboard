import { describe, expect, it } from "vitest";

import {
  ApprovalIDs,
  InMemoryObservationLedger,
  InMemoryPlanStore,
  isUltraPlanError,
  PlanIDs,
  SectionIDs,
  createUltraPlanTools,
  type Approval,
  type PlanningRun,
} from "../src/index.js";
import { UltraPlanController } from "../src/core/controller.js";
import { transitionLifecycle, transitionStage } from "../src/core/state-machine.js";
import type {
  Architecture,
  PlanCommit,
  Section,
  SectionRevision,
} from "../src/index.js";
import { fakeToolContext } from "./helpers.js";
import type { CapturedAsk } from "./helpers.js";

const FIXED = "2026-09-24T15:00:00.000Z";

function makeWorld() {
  const store = new InMemoryPlanStore(() => FIXED);
  const ledger = new InMemoryObservationLedger();
  const controller = new UltraPlanController({ store, ledger, now: () => FIXED });
  return { store, ledger, controller };
}

/** Drive the run to the requested stage through the real state machine. */
async function toStage(
  store: InMemoryPlanStore,
  run: PlanningRun,
  target: "architecture" | "detail" | "synthesis",
): Promise<PlanningRun> {
  const order = ["architecture", "detail", "synthesis"] as const;
  let current = run;
  for (const stage of order.slice(0, order.indexOf(target) + 1)) {
    current = transitionStage(current, stage);
    current = await store.saveRun(current);
  }
  return current;
}

interface Seed {
  architecture: Architecture;
  sections: Section[];
  sectionRevisions: SectionRevision[];
}

function seedWorld(): Seed {
  const architecture: Architecture = {
    id: "ARCH",
    revision: 1,
    status: "awaiting_approval",
    summary: "Seeded architecture",
    components: [],
    boundaries: [],
    dataFlows: [],
    principles: [],
    unresolved: [],
    basedOn: [],
  };
  const sections: Section[] = [
    {
      id: SectionIDs.from(1),
      title: "Plan Memory",
      objective: "durable state",
      dependencies: [],
      status: "approved",
      validation: "valid",
      currentRevision: 1,
      approvedRevision: 1,
    },
    {
      id: SectionIDs.from(2),
      title: "Retrieval",
      objective: "reads from memory",
      dependencies: [SectionIDs.from(1)],
      status: "pending",
      validation: "valid",
      currentRevision: 1,
    },
    {
      id: SectionIDs.from(3),
      title: "Broken",
      objective: "has incomplete deps",
      dependencies: [SectionIDs.from(2)],
      status: "pending",
      validation: "valid",
      currentRevision: 1,
    },
  ];
  const sectionRevisions: SectionRevision[] = sections.map((section) => ({
    sectionID: section.id,
    revision: 1,
    status: "approved",
    problem: `problem ${section.id}`,
    design: `design ${section.id}`,
    interfaces: [],
    invariants: [],
    failureModes: [],
    dependencies: [],
    decisions: [],
    openQuestions: [],
    impacts: [],
    projection: {
      compact: `compact ${section.id}`,
      contract: {
        sectionID: section.id,
        revision: 1,
        provides: [],
        requires: [],
        invariants: [],
        interfaces: [],
        decisions: [],
      },
    },
    createdAt: FIXED,
  }));
  return { architecture, sections, sectionRevisions };
}

/** Full working world: run in detail stage over seeded committed artifacts. */
async function detailedWorld() {
  const world = makeWorld();
  const { store, controller } = world;
  controller.issueStartAdmission("ses_tx");
  let run = (await controller.startOrResume("ses_tx")).run;
  run = await toStage(store, run, "detail");
  store.seedCommittedState(run.id, seedWorld());
  run = (await store.getRun(run.id)) as PlanningRun;
  return { ...world, run };
}

const DECISION_DRAFT = {
  kind: "add_decision" as const,
  content: {
    decision: {
      title: "Canonical state",
      statement: "Plugin storage is canonical state",
      rationale: "Compaction independence",
    },
  },
};

const MOVER_DRAFT = {
  kind: "add_decision" as const,
  content: {
    decision: {
      title: "HEAD mover",
      statement: "s",
      rationale: "r",
    },
  },
};

/** prepare → begin approval → record approval (ready → awaiting → approved-pending). */
async function prepareAwaiting(
  controller: UltraPlanController,
  sessionID: string,
  changes: unknown[],
  type: "design_checkpoint" | "section_completion" | "amendment" = "design_checkpoint",
) {
  const prepared = await controller.prepareProposal(sessionID, {
    type,
    scope: { type: "architecture" },
    title: "Tx proposal",
    summary: "s",
    changes: changes as never,
  });
  const begun = await controller.beginProposalApproval(sessionID, prepared.proposal.id);
  const { approval } = await controller.recordApproval(sessionID, prepared.proposal.id, begun.request);
  return { prepared, begun, approval };
}

function failCodes(error: unknown): string[] {
  if (!isUltraPlanError(error)) return [];
  const failures = error.detail?.failures as { code: string }[] | undefined;
  return failures?.map((f) => f.code) ?? [];
}

describe("approval persistence (tests 1-6)", () => {
  it("persists an exact immutable approval bound to the proposal (test 1)", async () => {
    const { store, controller } = await detailedWorld();
    const { prepared, approval } = await prepareAwaiting(controller, "ses_tx", [DECISION_DRAFT]);

    expect(approval.proposalID).toBe(prepared.proposal.id);
    expect(approval.proposalRevision).toBe(1);
    expect(approval.proposalHash).toBe(prepared.proposal.hash);
    expect(approval.actor).toBe("user");
    const fetched = await store.getApproval(PlanIDs.from(1), approval.id);
    expect(fetched).toEqual(approval);
    expect(await store.findApprovalForProposal(PlanIDs.from(1), prepared.proposal.id)).toEqual(approval);
  });

  it("is idempotent for the exact same binding (test 2)", async () => {
    const { store, controller } = await detailedWorld();
    const { prepared, begun } = await prepareAwaiting(controller, "ses_tx", [DECISION_DRAFT]);

    // Second recordApproval (duplicate delivery) reuses the existing record.
    const again = await controller.recordApproval("ses_tx", prepared.proposal.id, begun.request);
    const all = await store.listApprovals(PlanIDs.from(1));
    expect(all).toHaveLength(1);
    expect(again.approval.id).toBe(ApprovalIDs.from(1));

    // Direct store path: same id + same binding → existing returned.
    const same = await store.saveApproval(PlanIDs.from(1), {
      id: ApprovalIDs.from(1),
      proposalID: prepared.proposal.id,
      proposalRevision: 1,
      proposalHash: prepared.proposal.hash ?? "",
      actor: "user",
      createdAt: FIXED,
    });
    expect(same.id).toBe(ApprovalIDs.from(1));
    expect(await store.listApprovals(PlanIDs.from(1))).toHaveLength(1);
  });

  it("rejects mismatched proposal id / revision / hash / actor (tests 3-6)", async () => {
    const { controller } = await detailedWorld();
    const { prepared, begun } = await prepareAwaiting(controller, "ses_tx", [DECISION_DRAFT]);

    for (const mutate of [
      (d: { kind: "approved"; proposalID: string; proposalRevision: number; proposalHash: string; actor: "user" }) => {
        d.proposalID = "PROP-999";
      },
      (d: { proposalRevision: number }) => {
        d.proposalRevision = 7;
      },
      (d: { proposalHash: string }) => {
        d.proposalHash = "deadbeef";
      },
      (d: { actor: string }) => {
        (d as { actor: string }).actor = "model";
      },
    ]) {
      const decision = {
        kind: "approved",
        proposalID: prepared.proposal.id,
        proposalRevision: 1,
        proposalHash: prepared.proposal.hash ?? "",
        actor: "user",
      };
      mutate(decision as never);
      await expect(
        controller.applyProposalDecision("ses_tx", prepared.proposal.id, begun.request, decision as never),
      ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "approval_mismatch");
    }
  });
});

describe("commit admission (tests 7-9)", () => {
  it("refuses to commit a ready proposal (test 7)", async () => {
    const { store, controller } = await detailedWorld();
    const prepared = await controller.prepareProposal("ses_tx", {
      type: "design_checkpoint",
      scope: { type: "architecture" },
      title: "still ready",
      summary: "s",
      changes: [DECISION_DRAFT],
    });
    // Approval record exists but the proposal was never begun (still ready).
    await store.saveApproval(PlanIDs.from(1), {
      id: ApprovalIDs.from(1),
      proposalID: prepared.proposal.id,
      proposalRevision: 1,
      proposalHash: prepared.proposal.hash ?? "",
      actor: "user",
      createdAt: FIXED,
    });
    try {
      await store.commitTransaction({
        planID: PlanIDs.from(1),
        proposalID: prepared.proposal.id,
        approvalID: ApprovalIDs.from(1),
      });
      expect.unreachable("ready proposal committed");
    } catch (error) {
      expect(failCodes(error)).toContain("proposal_not_awaiting_approval");
    }
  });

  it("commits an awaiting_approval proposal with a valid approval (test 8)", async () => {
    const { controller } = await detailedWorld();
    const { prepared } = await prepareAwaiting(controller, "ses_tx", [DECISION_DRAFT]);
    const result = await controller.recordApprovalAndCommit("ses_tx", prepared.proposal.id, {
      proposalID: prepared.proposal.id,
      proposalRevision: 1,
      proposalHash: prepared.proposal.hash ?? "",
      oneShot: true,
      requestedAt: FIXED,
    });
    expect(result.commit.proposalID).toBe(prepared.proposal.id);
    expect(result.proposal?.status).toBe("approved");
  });

  it("refuses to commit a rejected proposal (test 9)", async () => {
    const { store, controller } = await detailedWorld();
    const { prepared } = await prepareAwaiting(controller, "ses_tx", [DECISION_DRAFT]);
    await controller.rejectProposal("ses_tx", prepared.proposal.id, {
      proposalID: prepared.proposal.id,
      proposalRevision: 1,
      proposalHash: prepared.proposal.hash ?? "",
      oneShot: true,
      requestedAt: FIXED,
    });
    try {
      await store.commitTransaction({
        planID: PlanIDs.from(1),
        proposalID: prepared.proposal.id,
        approvalID: (await store.findApprovalForProposal(PlanIDs.from(1), prepared.proposal.id))?.id ?? ApprovalIDs.from(1),
      });
      expect.unreachable("rejected proposal committed");
    } catch (error) {
      expect(failCodes(error)).toContain("proposal_not_awaiting_approval");
    }
    expect(await store.listCommits(PlanIDs.from(1))).toHaveLength(0);
  });
});

describe("optimistic concurrency (test 10)", () => {
  it("fails closed on a stale createdFrom / HEAD mismatch", async () => {
    const { store, controller } = await detailedWorld();
    const first = await prepareAwaiting(controller, "ses_tx", [DECISION_DRAFT]);
    // Move HEAD with a different proposal.
    const mover = await prepareAwaiting(controller, "ses_tx", [MOVER_DRAFT]);
    await controller.recordApprovalAndCommit("ses_tx", mover.prepared.proposal.id, {
      proposalID: mover.prepared.proposal.id,
      proposalRevision: 1,
      proposalHash: mover.prepared.proposal.hash ?? "",
      oneShot: true,
      requestedAt: FIXED,
    });
    // The FIRST proposal is now stale: its approval is still recorded but the
    // base snapshot no longer matches HEAD.
    try {
      await store.commitTransaction({
        planID: PlanIDs.from(1),
        proposalID: first.prepared.proposal.id,
        approvalID: first.approval.id,
      });
      expect.unreachable("stale proposal committed");
    } catch (error) {
      expect(failCodes(error)).toContain("head_snapshot_mismatch");
    }
  });
});

describe("successful transaction semantics (tests 15-20)", () => {
  it("commits atomically: one commit, linear parent, one snapshot, HEAD moved, proposal approved", async () => {
    const { store, controller, run } = await detailedWorld();
    const { prepared } = await prepareAwaiting(controller, "ses_tx", [DECISION_DRAFT]);
    const result = await controller.recordApprovalAndCommit("ses_tx", prepared.proposal.id, {
      proposalID: prepared.proposal.id,
      proposalRevision: 1,
      proposalHash: prepared.proposal.hash ?? "",
      oneShot: true,
      requestedAt: FIXED,
    });

    const commits = await store.listCommits(run.id);
    expect(commits).toHaveLength(1); // (15)
    expect(result.commit.parentCommit).toBeNull(); // (16) first real commit; S0 has commit=null
    const snapshots = await store.getHeadSnapshot(run.id);
    expect(snapshots?.id).toBe(result.commit.resultingSnapshot); // (17/18)
    expect(snapshots?.state.decisionRevisions).toMatchObject({ "DEC-001": 1 });
    expect(snapshots?.commit).toBe(result.commit.id);

    const after = await store.getRun(run.id);
    expect(after?.headCommit).toBe(result.commit.id); // (19)
    expect(after?.headSnapshot).toBe(result.commit.resultingSnapshot);
    expect((await store.getProposal(run.id, prepared.proposal.id))?.status).toBe("approved"); // (20)

    // Event sequence deterministic (test 35).
    const types = (await store.listEvents(run.id)).map((e) => e.detail.type);
    expect(types).toContain("proposal.awaiting_approval");
    expect(types).toContain("approval.recorded");
    expect(types).toContain("artifact.revised");
    expect(types.indexOf("transaction.committed")).toBeLessThan(types.indexOf("head.moved"));
    expect(types[types.length - 1]).toBe("head.moved");
  });

  it("is idempotent on exact retry and creates zero duplicates (test 21)", async () => {
    const { store, controller, run } = await detailedWorld();
    const { prepared, approval } = await prepareAwaiting(controller, "ses_tx", [DECISION_DRAFT]);
    const first = await store.commitTransaction({
      planID: run.id,
      proposalID: prepared.proposal.id,
      approvalID: approval.id,
    });
    const again = await store.commitTransaction({
      planID: run.id,
      proposalID: prepared.proposal.id,
      approvalID: approval.id,
    });
    expect(again.id).toBe(first.id);
    expect(await store.listCommits(run.id)).toHaveLength(1);
    const head = await store.getHeadSnapshot(run.id);
    expect(head?.id).toBe(first.resultingSnapshot);
  });

  it("keeps approved historical revisions immutable (test 22/24)", async () => {
    const { store, controller, run } = await detailedWorld();
    // add DEC-001 via commit...
    const first = await prepareAwaiting(controller, "ses_tx", [DECISION_DRAFT]);
    await controller.recordApprovalAndCommit("ses_tx", first.prepared.proposal.id, {
      proposalID: first.prepared.proposal.id,
      proposalRevision: 1,
      proposalHash: first.prepared.proposal.hash ?? "",
      oneShot: true,
      requestedAt: FIXED,
    });
    // ...then amend it.
    const amendment = await controller.prepareProposal("ses_tx", {
      type: "amendment",
      scope: { type: "architecture" },
      title: "Amend DEC-001",
      summary: "s",
      changes: [
        {
          kind: "amend_decision",
          ref: { kind: "decision", id: "DEC-001", revision: 1 },
          content: { decision: { title: "Canonical state v2", statement: "Amended statement", rationale: "r" } },
        },
      ],
    });
    const begun = await controller.beginProposalApproval("ses_tx", amendment.proposal.id);
    await controller.recordApprovalAndCommit("ses_tx", amendment.proposal.id, begun.request);

    const v1 = await store.getDecision(run.id, { id: "DEC-001" as never, revision: 1 });
    expect(v1?.title).toBe("Canonical state"); // old revision untouched (24)
    const v2 = await store.getDecision(run.id, { id: "DEC-001" as never, revision: 2 });
    expect(v2?.title).toBe("Canonical state v2");
    expect(v2?.supersedes).toEqual({ id: "DEC-001", revision: 1 });
    expect(v2?.revision).toBe(2);
  });
});

describe("change application semantics (tests 23-27)", () => {
  it("add_decision creates the exact approved revision (test 23)", async () => {
    const { store, controller, run } = await detailedWorld();
    const { prepared } = await prepareAwaiting(controller, "ses_tx", [DECISION_DRAFT]);
    await controller.recordApprovalAndCommit("ses_tx", prepared.proposal.id, {
      proposalID: prepared.proposal.id,
      proposalRevision: 1,
      proposalHash: prepared.proposal.hash ?? "",
      oneShot: true,
      requestedAt: FIXED,
    });
    const decision = await store.getDecision(run.id, { id: "DEC-001" as never, revision: 1 });
    expect(decision).toMatchObject({
      id: "DEC-001",
      revision: 1,
      status: "approved",
      title: "Canonical state",
      statement: "Plugin storage is canonical state",
    });
    const after = await store.getRun(run.id);
    expect(after?.decisions).toContainEqual({ id: "DEC-001", revision: 1 });
  });

  it("amend_section creates a new revision, preserves history, reopens, propagates needs_review (test 25)", async () => {
    const { store, controller, run } = await detailedWorld();
    const amendment = await controller.prepareProposal("ses_tx", {
      type: "amendment",
      scope: { type: "section", sectionID: "SEC-001" },
      title: "Amend SEC-001",
      summary: "s",
      changes: [
        {
          kind: "amend_section",
          ref: { kind: "section", id: "SEC-001", revision: 1 },
          content: {
            problem: "p",
            design: "amended design",
            compactProjection: "compact v2",
            contract: { provides: ["memory"], requires: [], invariants: [], interfaces: [], decisions: [] },
          },
        },
      ],
    });
    const begun = await controller.beginProposalApproval("ses_tx", amendment.proposal.id);
    await controller.recordApprovalAndCommit("ses_tx", amendment.proposal.id, begun.request);

    const oldRevision = await store.getSectionRevision(run.id, { id: SectionIDs.from(1), revision: 1 });
    expect(oldRevision?.design).toBe("design SEC-001"); // history preserved
    const newRevision = await store.getSectionRevision(run.id, { id: SectionIDs.from(1), revision: 2 });
    expect(newRevision?.design).toBe("amended design");
    const section = await store.getSection(run.id, SectionIDs.from(1));
    expect(section?.status).toBe("reopened"); // approved → reopened inside the commit
    expect(section?.currentRevision).toBe(2);
    expect(section?.approvedRevision).toBe(1);
    const downstream = await store.getSection(run.id, SectionIDs.from(2));
    expect(downstream?.validation).toBe("needs_review"); // propagated
  });

  it("resolve_question is the ONLY authoritative open→resolved path (test 26/27)", async () => {
    const { store, controller, run } = await detailedWorld();
    await controller.recordQuestion("ses_tx", {
      question: "Which storage backend?",
      blocking: true,
      scope: { type: "architecture" },
    });
    // Candidate resolution alone leaves the question open+blocking.
    await controller.proposeQuestionResolution("ses_tx", { questionID: "Q-001", resolution: "plugin storage" });
    let current = await store.findActiveRunBySession("ses_tx");
    expect(current?.openQuestions[0]?.status).toBe("open");

    // Even a successful unrelated commit does not resolve it.
    const unrelated = await prepareAwaiting(controller, "ses_tx", [DECISION_DRAFT]);
    await controller.recordApprovalAndCommit("ses_tx", unrelated.prepared.proposal.id, {
      proposalID: unrelated.prepared.proposal.id,
      proposalRevision: 1,
      proposalHash: unrelated.prepared.proposal.hash ?? "",
      oneShot: true,
      requestedAt: FIXED,
    });
    current = await store.findActiveRunBySession("ses_tx");
    expect(current?.openQuestions[0]?.status).toBe("open");

    // The resolve_question proposal is the authoritative path.
    const proposal = await controller.prepareProposal("ses_tx", {
      type: "design_checkpoint",
      scope: { type: "architecture" },
      title: "Resolve storage question",
      summary: "s",
      changes: [
        {
          kind: "resolve_question",
          ref: { kind: "question", id: "Q-001" },
          content: { questionID: "Q-001", resolution: "plugin storage" },
        },
      ],
    });
    const begun = await controller.beginProposalApproval("ses_tx", proposal.proposal.id);
    await controller.recordApprovalAndCommit("ses_tx", proposal.proposal.id, begun.request);

    const after = await store.findActiveRunBySession("ses_tx");
    expect(after?.openQuestions[0]?.status).toBe("resolved");
    expect(after?.openQuestions[0]?.resolution).toBe("plugin storage");
    const head = await store.getHeadSnapshot(run.id);
    expect(head?.state.openQuestionIDs).toHaveLength(0);
    const types = (await store.listEvents(run.id)).map((e) => e.detail.type);
    expect(types).toContain("question.resolved");
  });
});

describe("completion through PlanCommit only (tests 28-30)", () => {
  it("complete_section rejects incomplete dependencies (test 28)", async () => {
    const { controller } = await detailedWorld();
    const proposal = await controller.prepareProposal("ses_tx", {
      type: "section_completion",
      scope: { type: "section", sectionID: "SEC-003" },
      title: "Complete broken section",
      summary: "s",
      changes: [{ kind: "complete_section", ref: { kind: "section", id: "SEC-003" } }],
    });
    const begun = await controller.beginProposalApproval("ses_tx", proposal.proposal.id);
    await expect(
      controller.recordApprovalAndCommit("ses_tx", proposal.proposal.id, begun.request),
    ).rejects.toSatisfy((e: unknown) => failCodes(e).includes("dependency_incomplete"));
  });

  it("complete_section and complete_architecture succeed ONLY through the commit (tests 29/30)", async () => {
    const { store, controller, run } = await detailedWorld();
    // Before: SEC-002 pending, architecture awaiting_approval.
    expect((await store.getSection(run.id, SectionIDs.from(2)))?.status).toBe("pending");

    const proposal = await controller.prepareProposal("ses_tx", {
      type: "section_completion",
      scope: { type: "section", sectionID: "SEC-002" },
      title: "Complete retrieval",
      summary: "s",
      changes: [
        { kind: "complete_section", ref: { kind: "section", id: "SEC-002" } },
        { kind: "complete_architecture" },
      ],
    });
    const begun = await controller.beginProposalApproval("ses_tx", proposal.proposal.id);
    await controller.recordApprovalAndCommit("ses_tx", proposal.proposal.id, begun.request);

    const section = await store.getSection(run.id, SectionIDs.from(2));
    expect(section?.status).toBe("approved");
    expect(section?.approvedRevision).toBe(1);
    const architecture = await store.getArchitecture(run.id);
    expect(architecture?.status).toBe("approved");
    const after = await store.getRun(run.id);
    expect(after?.architecture).toEqual({ id: "ARCH", revision: 1 });
  });
});

describe("conflict + evidence validation (tests 31-33)", () => {
  it("an open blocking conflict that intersects the changes blocks the commit (test 31)", async () => {
    const { controller, run } = await detailedWorld();
    await controller.raiseConflict("ses_tx", {
      type: "decision",
      description: "decisions are frozen until storage is settled",
      severity: "blocking",
      refs: [],
    });
    const { prepared } = await prepareAwaiting(controller, "ses_tx", [DECISION_DRAFT]);
    await expect(
      controller.recordApprovalAndCommit("ses_tx", prepared.proposal.id, {
        proposalID: prepared.proposal.id,
        proposalRevision: 1,
        proposalHash: prepared.proposal.hash ?? "",
        oneShot: true,
        requestedAt: FIXED,
      }),
    ).rejects.toSatisfy((e: unknown) => failCodes(e).includes("conflict_blocking"));
    expect(run.stage).toBe("detail"); // unchanged world
  });
});

describe("atomicity: multi-change rollback + fault injection (test 34, §30)", () => {
  it("an invalid second change rolls back a valid first staged change", async () => {
    const { store, controller, run } = await detailedWorld();
    // Change A (valid): add_decision. Change B (invalid): complete_section on
    // SEC-003 whose dependency SEC-002 is pending.
    const { prepared } = await prepareAwaiting(controller, "ses_tx", [
      DECISION_DRAFT,
      { kind: "complete_section", ref: { kind: "section", id: "SEC-003" } },
    ]);
    try {
      await store.commitTransaction({
        planID: run.id,
        proposalID: prepared.proposal.id,
        approvalID: (
          (await store.findApprovalForProposal(run.id, prepared.proposal.id)) as Approval
        ).id,
      });
      expect.unreachable("invalid transaction committed");
    } catch (error) {
      expect(failCodes(error)).toContain("dependency_incomplete");
    }
    // Zero partial mutation:
    expect(await store.listDecisions(run.id)).toHaveLength(0); // A NOT committed
    expect(await store.listCommits(run.id)).toHaveLength(0);
    const head = await store.getHeadSnapshot(run.id);
    expect(head?.id).toBe("SNAP-001");
    expect((await store.getRun(run.id))?.headCommit).toBeUndefined();
    expect((await store.getProposal(run.id, prepared.proposal.id))?.status).toBe("awaiting_approval");
    const approval = await store.findApprovalForProposal(run.id, prepared.proposal.id);
    expect(approval).toBeDefined(); // still available for retry
    const types = (await store.listEvents(run.id)).map((e) => e.detail.type);
    expect(types).not.toContain("transaction.committed");
    expect(types).not.toContain("head.moved");
  });

  it("injected publication failure leaves committed state exactly unchanged", async () => {
    class FaultyStore extends InMemoryPlanStore {
      protected override publishTransaction(): PlanCommit {
        throw new Error("injected publication failure");
      }
    }
    const store = new FaultyStore(() => FIXED);
    const ledger = new InMemoryObservationLedger();
    const controller = new UltraPlanController({ store, ledger, now: () => FIXED });
    controller.issueStartAdmission("ses_fault");
    let run = (await controller.startOrResume("ses_fault")).run;
    run = await toStage(store, run, "detail");
    store.seedCommittedState(run.id, seedWorld());
    const prepared = await controller.prepareProposal("ses_fault", {
      type: "design_checkpoint",
      scope: { type: "architecture" },
      title: "faulty",
      summary: "s",
      changes: [DECISION_DRAFT],
    });
    const begun = await controller.beginProposalApproval("ses_fault", prepared.proposal.id);
    const { approval } = await controller.recordApproval("ses_fault", prepared.proposal.id, begun.request);

    await expect(
      store.commitTransaction({ planID: run.id, proposalID: prepared.proposal.id, approvalID: approval.id }),
    ).rejects.toThrowError(/injected publication failure/);

    expect(await store.listDecisions(run.id)).toHaveLength(0);
    expect(await store.listCommits(run.id)).toHaveLength(0);
    expect((await store.getHeadSnapshot(run.id))?.id).toBe("SNAP-001");
    expect((await store.getProposal(run.id, prepared.proposal.id))?.status).toBe("awaiting_approval");
    const types = (await store.listEvents(run.id)).map((e) => e.detail.type);
    expect(types).not.toContain("transaction.committed");
    // Approval remains valid for retry on a healthy store.
    expect(await store.findApprovalForProposal(run.id, prepared.proposal.id)).toBeDefined();
  });
});

describe("structured approval gateway (tests 37-39)", () => {
  it("presents the exact binding and never accepts persistent authorization (37/38)", async () => {
    const captured: CapturedAsk[] = [];
    const { store, controller } = await detailedWorld();
    // A previous committed proposal so the gateway commit is COMMIT-002.
    const prior = await prepareAwaiting(controller, "ses_tx", [DECISION_DRAFT]);
    await controller.recordApprovalAndCommit("ses_tx", prior.prepared.proposal.id, {
      proposalID: prior.prepared.proposal.id,
      proposalRevision: 1,
      proposalHash: prior.prepared.proposal.hash ?? "",
      oneShot: true,
      requestedAt: FIXED,
    });
    const fresh = await controller.prepareProposal("ses_tx", {
      type: "design_checkpoint",
      scope: { type: "architecture" },
      title: "Gateway proposal",
      summary: "s",
      changes: [
        { kind: "add_decision", content: { decision: { title: "t", statement: "s", rationale: "r" } } },
      ],
    });

    const tools = createUltraPlanTools(controller);
    const gateway = tools["ultraplan_request_user_approval"];
    if (!gateway) throw new Error("gateway tool missing");

    // Allow path: ask resolves → approval recorded → commit runs. The model
    // passes extra "actor"/"approved" args — the tool ignores them entirely.
    const result = await gateway.execute(
      { proposalID: fresh.proposal.id, actor: "model", approved: true },
      fakeToolContext("ses_tx", {
        ask: async (input) => {
          captured.push(input);
        },
      }),
    );
    if (typeof result === "string") throw new Error("structured result expected");
    expect(captured).toHaveLength(1);
    const ask = captured[0] as CapturedAsk;
    expect(ask.always).toEqual([]); // (38) no persistent authorization
    expect(ask.patterns).toEqual([]);
    expect(ask.metadata).toMatchObject({
      kind: "ultraplan.proposal-approval",
      oneShot: true,
      proposalID: fresh.proposal.id, // (37) exact binding in metadata
      proposalRevision: 1,
      proposalHash: fresh.proposal.hash,
    });
    expect(result.metadata).toMatchObject({ status: "approved" });
    expect((result.metadata as { commitID: string }).commitID).toBe("COMMIT-002"); // prior commit was COMMIT-001
    expect(await store.findApprovalForProposal(PlanIDs.from(1), fresh.proposal.id)).toBeDefined();
  });

  it("deny path rejects the proposal with no approval and no commit", async () => {
    const { store, controller } = await detailedWorld();
    const fresh = await controller.prepareProposal("ses_tx", {
      type: "design_checkpoint",
      scope: { type: "architecture" },
      title: "Deny me",
      summary: "s",
      changes: [
        { kind: "add_decision", content: { decision: { title: "t", statement: "s", rationale: "r" } } },
      ],
    });
    const tools = createUltraPlanTools(controller);
    const gateway = tools["ultraplan_request_user_approval"];
    if (!gateway) throw new Error("gateway tool missing");

    const result = await gateway.execute(
      { proposalID: fresh.proposal.id },
      fakeToolContext("ses_tx", {
        ask: async () => {
          throw new Error("user denied the request");
        },
      }),
    );
    if (typeof result === "string") throw new Error("structured result expected");
    expect(result.metadata).toMatchObject({ proposalID: fresh.proposal.id, status: "rejected" });
    expect(await store.findApprovalForProposal(PlanIDs.from(1), fresh.proposal.id)).toBeUndefined();
    expect(await store.listCommits(PlanIDs.from(1))).toHaveLength(0);
    const types = (await store.listEvents(PlanIDs.from(1))).map((e) => e.detail.type);
    expect(types).toContain("proposal.rejected");
  });

  it("exposes no model primitive that mints actor=user (test 39)", async () => {
    const { controller } = await detailedWorld();
    const tools = createUltraPlanTools(controller);
    // The gateway is a PRESENTATION request; there is no approve/commit tool.
    expect(tools["ultraplan_approve"]).toBeUndefined();
    expect(tools["ultraplan_commit"]).toBeUndefined();
    // Its args carry no decision fields at all.
    const gateway = tools["ultraplan_request_user_approval"];
    if (!gateway) throw new Error("gateway tool missing");
    expect(Object.keys(gateway.args)).toEqual(["proposalID"]);
  });
});

describe("handoff_pending and lifecycle guards", () => {
  it("refuses commits once the run left the active lifecycle", async () => {
    const { store, controller } = await detailedWorld();
    const { prepared, approval } = await prepareAwaiting(controller, "ses_tx", [DECISION_DRAFT]);
    let current = (await store.getRun(PlanIDs.from(1))) as PlanningRun;
    for (const stage of ["synthesis", "final"] as const) {
      current = transitionStage(current, stage);
      current = await store.saveRun(current);
    }
    current = transitionLifecycle(current, "handoff_pending");
    current = await store.saveRun(current);
    current = transitionLifecycle(current, "completed");
    current = await store.saveRun(current);

    try {
      await store.commitTransaction({
        planID: current.id,
        proposalID: prepared.proposal.id,
        approvalID: approval.id,
      });
      expect.unreachable("committed on a completed run");
    } catch (error) {
      expect(failCodes(error)).toContain("run_not_active");
    }
  });
});

