/**
 * PlanStore behavioral parity suite (Phase 2B2 brief §28).
 *
 * The SAME meaningful behavioral contract is executed against the in-memory
 * store and the durable store; the durable store must not acquire weaker
 * semantics. Deep transaction edge cases live in transaction-engine.test.ts
 * (the in-memory oracle); this suite pins the shared contract.
 */
import { expect, it } from "vitest";

import { isUltraPlanError } from "../src/index.js";
import type { InMemoryPlanStore } from "../src/index.js";
import type { UltraPlanController } from "../src/core/controller.js";
import { transitionLifecycle, transitionStage } from "../src/core/state-machine.js";
import { DecisionIDs, PlanIDs, SectionIDs, EvidenceIDs } from "../src/core/ids.js";
import type { PlanningRun } from "../src/core/types.js";
import type { Evidence, EvidenceID, SectionID } from "../src/index.js";

const FIXED = "2026-09-24T18:00:00.000Z";

export interface ParityFixture {
  store: InMemoryPlanStore;
  controller: UltraPlanController;
  seed: (
    planID: Parameters<InMemoryPlanStore["seedCommittedState"]>[0],
    data?: Parameters<InMemoryPlanStore["seedCommittedState"]>[1],
  ) => Promise<void>;
  evidence: (id: EvidenceID) => Evidence;
  close: () => Promise<void>;
}

export interface SectionIDBrandAlias {
  brand: never;
}

export function definePlanStoreContractSuite(
  name: string,
  createFixture: () => Promise<ParityFixture>,
): void {
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

  async function startedWorld(fixture: ParityFixture, sessionID = "ses_parity") {
    fixture.controller.issueStartAdmission(sessionID);
    let run = (await fixture.controller.startOrResume(sessionID)).run;
    run = transitionStage(run, "architecture");
    run = transitionStage(run, "detail");
    run = await fixture.store.saveRun(run);
    return run;
  }

  async function prepareAwaiting(
    fixture: ParityFixture,
    sessionID: string,
    changes: unknown[],
  ) {
    const prepared = await fixture.controller.prepareProposal(sessionID, {
      type: "design_checkpoint",
      scope: { type: "architecture" },
      title: "Parity proposal",
      summary: "s",
      changes: changes as never,
    });
    const begun = await fixture.controller.beginProposalApproval(sessionID, prepared.proposal.id);
    const { approval } = await fixture.controller.recordApproval(
      sessionID,
      prepared.proposal.id,
      begun.request,
    );
    return { prepared, approval };
  }

  it(`[${name}] creates and resumes exactly one run`, async () => {
    const fixture = await createFixture();
    fixture.controller.issueStartAdmission("ses_r");
    const first = await fixture.controller.startOrResume("ses_r");
    fixture.controller.issueStartAdmission("ses_r");
    const second = await fixture.controller.startOrResume("ses_r");
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.run.id).toBe(first.run.id);
    await fixture.close();
  });

  it(`[${name}] enforces the one-active-run invariant`, async () => {
    const fixture = await createFixture();
    fixture.controller.issueStartAdmission("ses_dup");
    const run = await fixture.controller.startOrResume("ses_dup");
    // A second ACTIVE run for the same session violates the invariant (store
    // enforces even though the controller resumes on the tool path).
    const duplicate: PlanningRun = {
      ...run.run,
      id: "PLAN-002" as PlanningRun["id"],
      createdAt: FIXED,
      updatedAt: FIXED,
    };
    await expect(fixture.store.createRun(duplicate)).rejects.toSatisfy(
      (e: unknown) => isUltraPlanError(e) && e.code === "multiple_active_runs",
    );
    await fixture.close();
  });

  it(`[${name}] enforces exact evidence revisions`, async () => {
    const fixture = await createFixture();
    const planID = PlanIDs.from(1);
    const evidence = fixture.evidence(EvidenceIDs.from(1));
    await fixture.store.putEvidence(planID, evidence);
    await expect(
      fixture.store.putEvidence(planID, { ...evidence, claim: "overwrite" }),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "duplicate_revision");
    const listed = await fixture.store.listEvidence(planID);
    expect(listed[0]?.claim).toBe(evidence.claim);
    await fixture.close();
  });

  it(`[${name}] freezes proposals readable by exact id`, async () => {
    const fixture = await createFixture();
    const run = await startedWorld(fixture);
    const { prepared } = await prepareAwaiting(fixture, "ses_parity", [DECISION_DRAFT]);
    const stored = await fixture.store.getProposal(run.id, prepared.proposal.id);
    expect(stored?.status).toBe("awaiting_approval");
    expect(stored?.hash).toBe(prepared.proposal.hash);
    await fixture.close();
  });

  it(`[${name}] persists approvals idempotently (tests 1-2 of the contract)`, async () => {
    const fixture = await createFixture();
    const run = await startedWorld(fixture);
    const { prepared } = await prepareAwaiting(fixture, "ses_parity", [DECISION_DRAFT]);
    // Duplicate delivery of the same binding → same Approval, no duplicates.
    const again = await fixture.controller.recordApproval("ses_parity", prepared.proposal.id, {
      proposalID: prepared.proposal.id,
      proposalRevision: 1,
      proposalHash: prepared.proposal.hash ?? "",
      oneShot: true,
      requestedAt: FIXED,
    });
    const approvals = await fixture.store.listApprovals(run.id);
    expect(approvals).toHaveLength(1);
    expect(again.approval.id).toBe(approvals[0]?.id);
    await fixture.close();
  });

  it(`[${name}] commits atomically: revisions, HEAD, snapshot, approved proposal`, async () => {
    const fixture = await createFixture();
    const run = await startedWorld(fixture);
    const { prepared } = await prepareAwaiting(fixture, "ses_parity", [DECISION_DRAFT]);
    const result = await fixture.controller.recordApprovalAndCommit("ses_parity", prepared.proposal.id, {
      proposalID: prepared.proposal.id,
      proposalRevision: 1,
      proposalHash: prepared.proposal.hash ?? "",
      oneShot: true,
      requestedAt: FIXED,
    });
    expect(result.commit.parentCommit).toBeNull();
    expect(result.proposal?.status).toBe("approved");
    const decision = await fixture.store.getDecision(run.id, {
      id: DecisionIDs.from(1),
      revision: 1,
    });
    expect(decision?.title).toBe("Canonical state");
    const after = await fixture.store.getRun(run.id);
    expect(after?.headCommit).toBe(result.commit.id);
    expect((await fixture.store.getHeadSnapshot(run.id))?.id).toBe(result.commit.resultingSnapshot);
    await fixture.close();
  });

  it(`[${name}] rolls back invalid transactions without partial mutation`, async () => {
    const fixture = await createFixture();
    const run = await startedWorld(fixture);
    await fixture.seed(run.id, {
      sections: [
        {
          id: SectionIDs.from(2),
          title: "Dependent",
          objective: "o",
          dependencies: [SectionIDs.from(9)],
          status: "pending",
          validation: "valid",
          currentRevision: 1,
        },
      ],
      sectionRevisions: [
        {
          sectionID: SectionIDs.from(2),
          revision: 1,
          status: "approved",
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
              sectionID: SectionIDs.from(2),
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
    const proposal = await fixture.controller.prepareProposal("ses_parity", {
      type: "section_completion",
      scope: { type: "section", sectionID: "SEC-002" },
      title: "bad completion",
      summary: "s",
      changes: [{ kind: "complete_section", ref: { kind: "section", id: "SEC-002" } }],
    });
    const begun = await fixture.controller.beginProposalApproval("ses_parity", proposal.proposal.id);
    await fixture.controller.recordApproval("ses_parity", proposal.proposal.id, begun.request);
    const approval = await fixture.store.findApprovalForProposal(run.id, proposal.proposal.id);
    if (!approval) throw new Error("approval should have been recorded");
    await expect(
      fixture.store.commitTransaction({
        planID: run.id,
        proposalID: proposal.proposal.id,
        approvalID: approval.id,
      }),
    ).rejects.toSatisfy(
      (e: unknown) =>
        isUltraPlanError(e) &&
        e.code === "transaction_validation_failed" &&
        JSON.stringify(e.detail).includes("dependency_incomplete"),
    );
    expect(await fixture.store.listCommits(run.id)).toHaveLength(0);
    expect((await fixture.store.getHeadSnapshot(run.id))?.id).toBe("SNAP-001");
    expect((await fixture.store.getProposal(run.id, proposal.proposal.id))?.status).toBe("awaiting_approval");
    await fixture.close();
  });

  it(`[${name}] is idempotent on exact retry`, async () => {
    const fixture = await createFixture();
    const run = await startedWorld(fixture);
    const { prepared, approval } = await prepareAwaiting(fixture, "ses_parity", [DECISION_DRAFT]);
    const first = await fixture.store.commitTransaction({
      planID: run.id,
      proposalID: prepared.proposal.id,
      approvalID: approval.id,
    });
    const again = await fixture.store.commitTransaction({
      planID: run.id,
      proposalID: prepared.proposal.id,
      approvalID: approval.id,
    });
    expect(again.id).toBe(first.id);
    expect(await fixture.store.listCommits(run.id)).toHaveLength(1);
    await fixture.close();
  });

  it(`[${name}] applies question resolution only through the commit`, async () => {
    const fixture = await createFixture();
    await startedWorld(fixture);
    await fixture.controller.recordQuestion("ses_parity", {
      question: "Which storage backend?",
      blocking: true,
      scope: { type: "architecture" },
    });
    await fixture.controller.proposeQuestionResolution("ses_parity", {
      questionID: "Q-001",
      resolution: "plugin storage",
    });
    let current = await fixture.store.findActiveRunBySession("ses_parity");
    expect(current?.openQuestions[0]?.status).toBe("open");

    const proposal = await fixture.controller.prepareProposal("ses_parity", {
      type: "design_checkpoint",
      scope: { type: "architecture" },
      title: "Resolve",
      summary: "s",
      changes: [
        { kind: "resolve_question", ref: { kind: "question", id: "Q-001" }, content: { resolution: "plugin storage" } },
      ],
    });
    const begun = await fixture.controller.beginProposalApproval("ses_parity", proposal.proposal.id);
    await fixture.controller.recordApprovalAndCommit("ses_parity", proposal.proposal.id, begun.request);
    current = await fixture.store.findActiveRunBySession("ses_parity");
    expect(current?.openQuestions[0]?.status).toBe("resolved");
    expect(current?.openQuestions[0]?.resolution).toBe("plugin storage");
    await fixture.close();
  });

  it(`[${name}] propagates needs_review on section amendments committed atomically`, async () => {
    const fixture = await createFixture();
    const run = await startedWorld(fixture);
    await fixture.seed(run.id, {
      sections: [
        {
          id: SectionIDs.from(1),
          title: "Base",
          objective: "o",
          dependencies: [],
          status: "approved",
          validation: "valid",
          currentRevision: 1,
          approvedRevision: 1,
        },
        {
          id: SectionIDs.from(2),
          title: "Dependent",
          objective: "o",
          dependencies: [SectionIDs.from(1)],
          status: "approved",
          validation: "valid",
          currentRevision: 1,
          approvedRevision: 1,
        },
      ],
      sectionRevisions: [1, 2].flatMap((sectionNumber) => {
        const sectionID = SectionIDs.from(sectionNumber as 1 | 2);
        return [
          {
            sectionID,
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
                sectionID,
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
        ];
      }),
    });
    const amendment = await fixture.controller.prepareProposal("ses_parity", {
      type: "amendment",
      scope: { type: "section", sectionID: "SEC-001" },
      title: "Amend base",
      summary: "s",
      changes: [
        {
          kind: "amend_section",
          ref: { kind: "section", id: "SEC-001", revision: 1 },
          content: {
            problem: "p2",
            design: "d2",
            compactProjection: "c2",
            contract: { provides: [], requires: [], invariants: [], interfaces: [], decisions: [] },
          },
        },
      ],
    });
    const begun = await fixture.controller.beginProposalApproval("ses_parity", amendment.proposal.id);
    await fixture.controller.recordApprovalAndCommit("ses_parity", amendment.proposal.id, begun.request);

    const base = await fixture.store.getSection(run.id, SectionIDs.from(1));
    expect(base?.status).toBe("reopened");
    expect(base?.currentRevision).toBe(2);
    const dependent = await fixture.store.getSection(run.id, SectionIDs.from(2));
    expect(dependent?.validation).toBe("needs_review");
    await fixture.close();
  });

  it(`[${name}] keeps evidence reads exact`, async () => {
    const fixture = await createFixture();
    const planID = PlanIDs.from(1);
    await fixture.store.putEvidence(planID, fixture.evidence(EvidenceIDs.from(5)));
    await fixture.store.putEvidence(planID, {
      ...fixture.evidence(EvidenceIDs.from(5)),
      revision: 2,
      claim: "refreshed",
    });
    const exact = await fixture.store.getEvidence(planID, { id: EvidenceIDs.from(5), revision: 1 });
    expect(exact?.claim).not.toBe("refreshed");
    const latest = await fixture.store.getEvidence(planID, { id: EvidenceIDs.from(5) });
    expect(latest?.claim).toBe("refreshed");
    await fixture.close();
  });

  it(`[${name}] exposes terminal lifecycle reads without an active run`, async () => {
    const fixture = await createFixture();
    fixture.controller.issueStartAdmission("ses_term");
    let run = (await fixture.controller.startOrResume("ses_term")).run;
    for (const stage of ["architecture", "detail", "synthesis", "final"] as const) {
      run = transitionStage(run, stage);
      run = await fixture.store.saveRun(run);
    }
    run = transitionLifecycle(run, "handoff_pending");
    run = await fixture.store.saveRun(run);
    run = transitionLifecycle(run, "completed");
    run = await fixture.store.saveRun(run);
    expect(await fixture.store.findActiveRunBySession("ses_term")).toBeUndefined();
    const stored = await fixture.store.getRun(run.id);
    expect(stored?.lifecycle).toBe("completed");
    // Terminal runs still expose durable reads (spec §34 execution read access).
    expect((await fixture.store.getHeadSnapshot(run.id))?.id).toBe("SNAP-001");
    await fixture.close();
  });

  it(`[${name}] moves the event log in the documented order`, async () => {
    const fixture = await createFixture();
    const run = await startedWorld(fixture);
    const { prepared } = await prepareAwaiting(fixture, "ses_parity", [DECISION_DRAFT]);
    await fixture.controller.recordApprovalAndCommit("ses_parity", prepared.proposal.id, {
      proposalID: prepared.proposal.id,
      proposalRevision: 1,
      proposalHash: prepared.proposal.hash ?? "",
      oneShot: true,
      requestedAt: FIXED,
    });
    const types = (await fixture.store.listEvents(run.id)).map((e) => e.detail.type);
    expect(types.indexOf("approval.recorded")).toBeGreaterThan(-1);
    expect(types.indexOf("transaction.committed")).toBeLessThan(types.indexOf("head.moved"));
    expect(types[types.length - 1]).toBe("head.moved");
    await fixture.close();
  });

  void (null as unknown as PlanningRun);
  void (null as unknown as SectionID);
}
