import { describe, expect, it } from "vitest";

import {
  ApprovalIDs,
  InMemoryObservationLedger,
  InMemoryPlanStore,
  InMemoryStartAdmissionLedger,
  isUltraPlanError,
  PlanIDs,
  ProposalIDs,
  proposalApprovalPayload,
  computeProposalHash,
  applyApprovalDecision,
  SectionIDs,
  TOOL_CONTRACTS,
  FORBIDDEN_TOOL_NAMES,
  createUltraPlanTools,
  ULTRA_PLAN_START_TOOL,
  type ApprovalRequest,
  type PlanningRun,
  type UserApprovalDecision,
} from "../src/index.js";
import { UltraPlanController } from "../src/core/controller.js";
import { transitionStage } from "../src/core/state-machine.js";
import { fakeToolContext } from "./helpers.js";

function setup(clock?: () => string): {
  store: InMemoryPlanStore;
  ledger: InMemoryObservationLedger;
  controller: UltraPlanController;
} {
  const store = new InMemoryPlanStore();
  const ledger = new InMemoryObservationLedger();
  const controller = new UltraPlanController({
    store,
    ledger,
    ...(clock ? { now: clock } : {}),
  });
  return { store, ledger, controller };
}

async function expectErrorCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    expect.unreachable(`expected ${code}`);
  } catch (error) {
    const actual = isUltraPlanError(error) ? error.code : `non-UltraPlanError: ${String(error)}`;
    expect(actual, `${code} expected, got ${String(error)}`).toBe(code);
  }
}

async function runToTerminal(
  store: InMemoryPlanStore,
  controller: UltraPlanController,
  sessionID: string,
): Promise<PlanningRun> {
  controller.issueStartAdmission(sessionID);
  let run = (await controller.startOrResume(sessionID)).run;
  for (const stage of ["architecture", "detail", "synthesis", "final"] as const) {
    run = transitionStage(run, stage);
    run = await store.saveRun(run);
  }
  const sm = await import("../src/core/state-machine.js");
  run = sm.transitionLifecycle(run, "handoff_pending");
  run = await store.saveRun(run);
  run = sm.transitionLifecycle(run, "completed");
  run = await store.saveRun(run);
  return run;
}

const COMMIT_INPUT = {
  planID: PlanIDs.from(1),
  proposalID: ProposalIDs.cast("PROP-001"),
  approvalID: ApprovalIDs.cast("APPR-001"),
} as const;

/**
 * Golden hash for the canonical approval payload, pinned in the golden test
 * below (fixed clock 2026-09-24T12:00:00.000Z).
 */
const GOLDEN_HASH = "075fe64f8d5413e70756b070b0bfdf7853c20e79115437a908395705ba9dba28";

describe("Correction B — explicit plan-entry admission", () => {
  it("denies direct ultraplan_start without command admission (test 1)", async () => {
    const { store, controller } = setup();
    await expectErrorCode(controller.startOrResume("ses_a"), "start_not_authorized");
    expect(await store.findLatestRunBySession("ses_a")).toBeUndefined();

    // The same holds through the tool surface the model sees.
    const tools = createUltraPlanTools(controller);
    const start = tools[ULTRA_PLAN_START_TOOL];
    if (!start) throw new Error("start tool missing");
    const result = await start.execute({}, fakeToolContext("ses_a"));
    if (typeof result === "string") throw new Error("expected structured result");
    expect(result.output).toContain("ERROR [start_not_authorized]");
  });

  it("creates a valid, unconsumed, expiring admission (test 2)", async () => {
    const { controller } = setup();
    const admission = controller.issueStartAdmission("ses_adm");
    expect(admission.sessionID).toBe("ses_adm");
    expect(admission.command).toBe("ultra-plan");
    expect(admission.consumedAt).toBeNull();
    expect(Date.parse(admission.expiresAt)).toBeGreaterThan(Date.parse(admission.issuedAt));
  });

  it("keeps admissions session-scoped (tests 3/5)", async () => {
    const { controller } = setup();
    controller.issueStartAdmission("ses_A");
    // Session B has no admission of its own.
    await expectErrorCode(controller.startOrResume("ses_B"), "start_not_authorized");
    // And consuming A's admission works only for A.
    await controller.startOrResume("ses_A");
    await expectErrorCode(controller.startOrResume("ses_A"), "start_not_authorized");
    await expectErrorCode(controller.startOrResume("ses_B"), "start_not_authorized");
  });

  it("never reuses a consumed admission (test 4)", async () => {
    const { controller } = setup();
    controller.issueStartAdmission("ses_once");
    await controller.startOrResume("ses_once");
    // Even a second /ultra-plan-shaped attempt without a NEW command fails.
    await expectErrorCode(controller.startOrResume("ses_once"), "start_not_authorized");
  });

  it("expires stale admissions (defense in depth)", async () => {
    let clockMs = 1_000_000_000_000;
    const clock = () => new Date(clockMs).toISOString();
    const ledger = new InMemoryStartAdmissionLedger(clock, 60_000);
    const store = new InMemoryPlanStore();
    const controller = new UltraPlanController({ store, admissions: ledger, now: clock });

    ledger.issue("ses_t", "ultra-plan");
    clockMs += 61_000; // past the 60s TTL
    await expectErrorCode(controller.startOrResume("ses_t"), "start_not_authorized");
  });

  it("creates a run for an explicit command with no run (test 6)", async () => {
    const { controller } = setup();
    const result = await (
      async () => {
        controller.issueStartAdmission("ses_new");
        return controller.startOrResume("ses_new", "explicit entry");
      }
    )();
    expect(result.created).toBe(true);
    expect(result.run.stage).toBe("discovery");
  });

  it("resumes the same run for an explicit command with an active run (test 7)", async () => {
    const { controller } = setup();
    controller.issueStartAdmission("ses_res");
    const first = await controller.startOrResume("ses_res");
    controller.issueStartAdmission("ses_res");
    const second = await controller.startOrResume("ses_res");
    expect(second.created).toBe(false);
    expect(second.run.id).toBe(first.run.id);
  });

  it("requires a FRESH admission to start a new run after a terminal run, and resumes handoff_pending (test 8)", async () => {
    const { store, controller } = setup();
    await runToTerminal(store, controller, "ses_term");

    // No admission → cannot start a new run over a completed one.
    await expectErrorCode(controller.startOrResume("ses_term"), "start_not_authorized");

    // Fresh explicit /ultra-plan admission → new run.
    controller.issueStartAdmission("ses_term");
    const second = await controller.startOrResume("ses_term");
    expect(second.created).toBe(true);
    expect(second.run.id).toBe("PLAN-002");

    // handoff_pending: /ultra-plan RESUMES, never creates or re-enters handoff.
    controller.issueStartAdmission("ses_hp");
    let run = (await controller.startOrResume("ses_hp")).run;
    for (const stage of ["architecture", "detail", "synthesis", "final"] as const) {
      run = transitionStage(run, stage);
      run = await store.saveRun(run);
    }
    const sm = await import("../src/core/state-machine.js");
    run = sm.transitionLifecycle(run, "handoff_pending");
    run = await store.saveRun(run);
    controller.issueStartAdmission("ses_hp");
    const resumed = await controller.startOrResume("ses_hp");
    expect(resumed.created).toBe(false);
    expect(resumed.run.lifecycle).toBe("handoff_pending");
    expect(resumed.run.stage).toBe("final");
  });
});

describe("Correction A — question resolution boundary", () => {
  it("does not expose any model-callable path that clears a blocking question (tests 9/10)", async () => {
    const { store, controller } = setup();
    controller.issueStartAdmission("ses_q");
    await controller.startOrResume("ses_q");
    await controller.recordQuestion("ses_q", {
      question: "Which storage backend?",
      blocking: true,
      scope: { type: "architecture" },
    });

    // The old resolver is gone from the API surface entirely.
    expect(
      (controller as unknown as Record<string, unknown>)["resolveQuestion"],
    ).toBeUndefined();
    expect(FORBIDDEN_TOOL_NAMES).toContain("ultraplan_resolve_question");
    expect(createUltraPlanTools(controller)["ultraplan_resolve_question"]).toBeUndefined();

    // The replacement records only a candidate; the question stays open+blocking.
    const proposed = await controller.proposeQuestionResolution("ses_q", {
      questionID: "Q-001",
      resolution: "use plugin-owned storage",
    });
    expect(proposed.status).toBe("open");
    expect(proposed.blocking).toBe(true);
    expect(proposed.resolution).toBeUndefined();
    expect(proposed.proposedResolution?.text).toBe("use plugin-owned storage");

    const run = await store.findActiveRunBySession("ses_q");
    expect(run?.openQuestions[0]?.status).toBe("open");
    expect(run?.openQuestions[0]?.blocking).toBe(true);
  });

  it("permits resolve_question as PROPOSAL intent (test 11)", async () => {
    const { controller } = setup();
    controller.issueStartAdmission("ses_qp");
    let run = (await controller.startOrResume("ses_qp")).run;
    run = transitionStage(run, "architecture");
    run = await controller.planStore.saveRun(run);
    void run;
    await controller.recordQuestion("ses_qp", {
      question: "Canonical memory location?",
      blocking: true,
      scope: { type: "architecture" },
    });

    const prepared = await controller.prepareProposal("ses_qp", {
      type: "design_checkpoint",
      scope: { type: "architecture" },
      title: "Persistence",
      summary: "s",
      changes: [
        {
          kind: "resolve_question",
          ref: { kind: "question", id: "Q-001" },
          content: { questionID: "Q-001", resolution: "plugin storage" },
        },
      ],
    });
    expect(prepared.proposal.changes[0]?.kind).toBe("resolve_question");
    // And the question itself is STILL open.
    const still = await controller.planStore.findActiveRunBySession("ses_qp");
    expect(still?.openQuestions[0]?.status).toBe("open");
  });
});

describe("Correction C — approval admission lifecycle", () => {
  async function preparedProposal(sessionID: string) {
    const { store, controller } = setup();
    controller.issueStartAdmission(sessionID);
    let run = (await controller.startOrResume(sessionID)).run;
    run = transitionStage(run, "architecture");
    run = await store.saveRun(run);
    const prepared = await controller.prepareProposal(sessionID, {
      type: "design_checkpoint",
      scope: { type: "architecture" },
      title: "Persistence model",
      summary: "s",
      changes: [
        {
          kind: "add_decision",
          content: {
            decision: {
              title: "Canonical state",
              statement: "Plugin storage is canonical",
              rationale: "compaction independence",
            },
          },
        },
      ],
    });
    return { store, controller, run, prepared };
  }

  it("treats a ready proposal as NOT approvable (test 12)", async () => {
    const { controller, prepared } = await preparedProposal("ses_ready");
    const request: ApprovalRequest = {
      proposalID: prepared.proposal.id,
      proposalRevision: prepared.proposal.revision,
      proposalHash: prepared.proposal.hash ?? "",
      oneShot: true,
      requestedAt: "2026-09-24T00:00:00.000Z",
    };
    await expectErrorCode(
      controller.applyProposalDecision("ses_ready", prepared.proposal.id, request, {
        kind: "approved",
        proposalID: prepared.proposal.id,
        proposalRevision: prepared.proposal.revision,
        proposalHash: prepared.proposal.hash ?? "",
        actor: "user",
      }),
      "proposal_not_approvable",
    );
  });

  it("transitions ready → awaiting_approval without changing the hash or content (tests 13/14)", async () => {
    const { store, controller, prepared } = await preparedProposal("ses_ba");
    const hashBefore = prepared.proposal.hash;

    const begun = await controller.beginProposalApproval("ses_ba", prepared.proposal.id);
    expect(begun.proposal.status).toBe("awaiting_approval");
    expect(begun.proposal.hash).toBe(hashBefore);
    expect(begun.request).toMatchObject({
      proposalID: prepared.proposal.id,
      proposalRevision: 1,
      proposalHash: hashBefore,
      oneShot: true,
    });

    // Only status moved; every other field is untouched.
    const { status, ...restBefore } = prepared.proposal;
    const { status: _after, ...restAfter } = begun.proposal;
    void status;
    void _after;
    expect(restAfter).toEqual(restBefore);

    // Content remains immutable: id reuse still rejected, status transition
    // cannot rewrite content.
    await expectErrorCode(
      store.saveProposal(PlanIDs.from(1), { ...begun.proposal, title: "rewritten" }),
      "proposal_immutable",
    );
  });

  it("rejects decisions whose id/revision/hash binding does not match (tests 15/16)", async () => {
    const { controller, prepared } = await preparedProposal("ses_bind");
    const begun = await controller.beginProposalApproval("ses_bind", prepared.proposal.id);

    const wrongHash: UserApprovalDecision = {
      kind: "approved",
      proposalID: prepared.proposal.id,
      proposalRevision: 1,
      proposalHash: "deadbeef",
      actor: "user",
    };
    await expectErrorCode(
      controller.applyProposalDecision("ses_bind", prepared.proposal.id, begun.request, wrongHash),
      "approval_mismatch",
    );

    const wrongRevision: UserApprovalDecision = {
      kind: "approved",
      proposalID: prepared.proposal.id,
      proposalRevision: 2,
      proposalHash: prepared.proposal.hash ?? "",
      actor: "user",
    };
    await expectErrorCode(
      controller.applyProposalDecision("ses_bind", prepared.proposal.id, begun.request, wrongRevision),
      "approval_mismatch",
    );

    const wrongId: UserApprovalDecision = {
      kind: "approved",
      proposalID: "PROP-999" as UserApprovalDecision["proposalID"],
      proposalRevision: 1,
      proposalHash: prepared.proposal.hash ?? "",
      actor: "user",
    };
    await expectErrorCode(
      controller.applyProposalDecision("ses_bind", prepared.proposal.id, begun.request, wrongId),
      "approval_mismatch",
    );

    // The exact binding succeeds and produces the Approval record for 2B.
    const outcome = await controller.applyProposalDecision("ses_bind", prepared.proposal.id, begun.request, {
      kind: "approved",
      proposalID: prepared.proposal.id,
      proposalRevision: 1,
      proposalHash: prepared.proposal.hash ?? "",
      actor: "user",
    });
    expect(outcome.kind).toBe("approved");
    if (outcome.kind === "approved") {
      expect(outcome.approval).toMatchObject({
        proposalID: prepared.proposal.id,
        proposalRevision: 1,
        proposalHash: prepared.proposal.hash,
        actor: "user",
      });
    }
  });

  it("binds every decision to one exact hash and never to persistent permissions (tests 17/18)", () => {
    // No model-visible tool carries approval/commit authority.
    for (const contract of Object.values(TOOL_CONTRACTS)) {
      // (String-widened: the union type itself already proves no such class
      // exists; the runtime assertion documents that guarantee.)
      expect(["approval", "commit"].includes(String(contract.authority))).toBe(false);
      expect(contract.mutatesCommittedMemory).toBe(false);
    }
    // The approval primitive the gateway will use exposes an "always allow"
    // concept — the frozen contract refuses it structurally: an
    // ApprovalRequest is one-shot and carries no pattern/persistence fields.
    const request: ApprovalRequest = {
      proposalID: "PROP-001" as ApprovalRequest["proposalID"],
      proposalRevision: 1,
      proposalHash: "abc",
      oneShot: true,
      requestedAt: "2026-09-24T00:00:00.000Z",
    };
    expect(request.oneShot).toBe(true);
    expect(Object.keys(request).filter((k) => ["always", "patterns", "persist"].includes(k))).toEqual([]);

    // A decision object with actor !== "user" is rejected at the boundary.
    const forged = {
      kind: "approved",
      proposalID: "PROP-001",
      proposalRevision: 1,
      proposalHash: "abc",
      actor: "model",
    } as unknown as UserApprovalDecision;
    const proposal = {
      id: "PROP-001",
      revision: 1,
      status: "awaiting_approval",
      hash: "abc",
    } as unknown as Parameters<typeof applyApprovalDecision>[0];
    expect(() =>
      applyApprovalDecision(proposal, request, forged, "2026-09-24T00:00:00.000Z"),
    ).toThrowError(/originate from the user/);
  });
});

describe("completion / reopen authority audit (tests 19/20)", () => {
  it("request_completion never approves or completes an artifact directly (test 19)", async () => {
    const { store, controller } = setup();
    controller.issueStartAdmission("ses_rc");
    let run = (await controller.startOrResume("ses_rc")).run;
    for (const stage of ["architecture", "detail"] as const) {
      run = transitionStage(run, stage);
      run = await store.saveRun(run);
    }

    // No committed sections exist, so a completion request fails scope
    // validation — and nothing anywhere is marked complete.
    await expectErrorCode(
      controller.requestCompletion("ses_rc", { sectionID: "SEC-001" }),
      "invalid_scope",
    );
    expect(await store.getSection(run.id, SectionIDs.cast("SEC-001"))).toBeUndefined();
    expect(await store.listSections(run.id)).toHaveLength(0);
    await expectErrorCode(store.commitTransaction(COMMIT_INPUT), "unknown_reference");
  });

  it("request_reopen only prepares amendment intent — reopened status is commit-applied (test 20)", async () => {
    const { store, controller } = setup();
    controller.issueStartAdmission("ses_rr");
    let run = (await controller.startOrResume("ses_rr")).run;
    for (const stage of ["architecture", "detail"] as const) {
      run = transitionStage(run, stage);
      run = await store.saveRun(run);
    }

    // Reopen targets approved artifacts, which only exist after commits —
    // today it fails deterministically and mutates nothing.
    await expectErrorCode(
      controller.requestReopen("ses_rr", { ref: { kind: "section", id: "SEC-001" } }),
      "unknown_reference",
    );
    expect(await store.listSections(run.id)).toHaveLength(0);
    await expectErrorCode(store.commitTransaction(COMMIT_INPUT), "unknown_reference");
  });
});

describe("proposal hash contract (golden)", () => {
  it("computes the documented canonical hash (golden test, brief §7)", async () => {
    // Artifact timestamps are set at freeze and participate in the hash, so
    // the golden test pins the clock.
    const FIXED = "2026-09-24T12:00:00.000Z";
    const store = new InMemoryPlanStore();
    const controller = new UltraPlanController({ store, now: () => FIXED });
    controller.issueStartAdmission("ses_gold");
    let run = (await controller.startOrResume("ses_gold")).run;
    run = transitionStage(run, "architecture");
    run = await store.saveRun(run);
    void run;
    const prepared = await controller.prepareProposal("ses_gold", {
      type: "design_checkpoint",
      scope: { type: "architecture" },
      title: "Golden proposal",
      summary: "Canonical content",
      changes: [
        {
          kind: "add_decision",
          content: {
            decision: {
              title: "Canonical state",
              statement: "Plugin storage is canonical",
              rationale: "compaction independence",
            },
          },
        },
      ],
    });

    const payload = proposalApprovalPayload(prepared.proposal);
    expect(Object.keys(payload).sort()).toEqual([
      "changes",
      "createdFrom",
      "dependencies",
      "id",
      "impact",
      "revision",
      "scope",
      "summary",
      "title",
      "type",
    ]);

    // Golden literal pins the canonical serialization: any change to field
    // set, key ordering, or normalization rules breaks this test loudly.
    expect(payload).toEqual({
      id: "PROP-001",
      revision: 1,
      type: "design_checkpoint",
      scope: { id: "ARCH", revision: 1 },
      title: "Golden proposal",
      summary: "Canonical content",
      changes: [
        {
          kind: "add_decision",
          decision: {
            id: "DEC-001",
            revision: 1,
            status: "approved",
            approvedAt: FIXED,
            title: "Canonical state",
            statement: "Plugin storage is canonical",
            rationale: "compaction independence",
            scope: {},
          },
        },
      ],
      dependencies: [],
      impact: { affectedSections: [], affectedDecisions: ["DEC-001"] },
      createdFrom: { id: "SNAP-001" },
    });
    expect(prepared.hash).toBe(GOLDEN_HASH);

    // Status is workflow state, not content: transitioning does not move the hash.
    const begun = await controller.beginProposalApproval("ses_gold", prepared.proposal.id);
    expect(computeProposalHash(begun.proposal)).toBe(prepared.hash);
  });
});
