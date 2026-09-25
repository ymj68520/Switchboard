/**
 * Phase 2C — Discovery → Architecture Planning Workflow.
 *
 * Covers the workflow the brief freezes: /ultra-plan → discovery →
 * ultraplan_request_architecture → architecture → exact Architecture Proposal
 * → one user Approval → atomic PlanCommit (add_architecture /
 * add_constraint / complete_architecture) → immutable ARCH@n → stage=detail
 * IN THE SAME TRANSACTION — plus restart recovery over the DurablePlanStore
 * and the §34 full-workflow acceptance test.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ToolDefinition } from "@opencode-ai/plugin";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ApprovalIDs,
  DurablePlanStore,
  FORBIDDEN_TOOL_NAMES,
  InMemoryObservationLedger,
  InMemoryPlanStore,
  ProposalIDs,
  TOOL_CONTRACTS,
  UltraPlanError,
  computeProposalHash,
  createUltraPlanTools,
  isUltraPlanError,
  renderPlanningProtocol,
  renderStatus,
} from "../src/index.js";
import type {
  PlanCommit,
  PlanningRun,
  Proposal,
} from "../src/index.js";
import { UltraPlanController } from "../src/core/controller.js";
import { transitionStage } from "../src/core/state-machine.js";
import type { ProposalChange } from "../src/transaction/types.js";
import { admittedStart, fakeToolContext } from "./helpers.js";
import type { CapturedAsk } from "./helpers.js";
import type { Evidence, EvidenceID } from "../src/index.js";

const FIXED = "2026-09-25T09:00:00.000Z";
const GOAL = "Build the durable planning harness";

function makeWorld(store?: InMemoryPlanStore) {
  const planStore = store ?? new InMemoryPlanStore(() => FIXED);
  const ledger = new InMemoryObservationLedger();
  const controller = new UltraPlanController({ store: planStore, ledger, now: () => FIXED });
  return { store: planStore, ledger, controller };
}

/** Start with a user goal and drive discovery → architecture. */
async function inArchitectureStage(world: ReturnType<typeof makeWorld>, sessionID = "ses_arch") {
  let run = (await admittedStart(world.controller, sessionID, GOAL)).run;
  await world.controller.requestArchitecture(sessionID);
  run = (await world.store.getRun(run.id)) as PlanningRun;
  return run;
}

const BASE_ARCH_DRAFT = {
  summary: "Top-level design",
  components: [{ name: "Core", summary: "kernel" }],
  boundaries: [{ name: "Core edge", description: "the only entry" }],
  dataFlows: [{ from: "UI", to: "Core", description: "commands" }],
  principles: [{ statement: "committed memory is authoritative" }],
};

type ArchDraftInput = typeof BASE_ARCH_DRAFT & {
  unresolvedQuestionIDs?: string[];
  basedOn?: string[];
};

function archDraftChange(draft: ArchDraftInput = BASE_ARCH_DRAFT) {
  return { kind: "add_architecture" as const, content: { architecture: draft } };
}

const CONSTRAINT_CHANGE = {
  kind: "add_constraint" as const,
  content: { constraint: { statement: "single writer", source: "environment" as const, severity: "hard" as const } },
};

async function prepareAwaiting(
  world: ReturnType<typeof makeWorld>,
  sessionID: string,
  input: { type: "design_checkpoint" | "architecture_completion"; changes: unknown[]; title?: string },
) {
  const prepared = await world.controller.prepareProposal(sessionID, {
    type: input.type,
    scope: { type: "architecture" },
    title: input.title ?? "Architecture proposal",
    summary: "s",
    changes: input.changes as never,
  });
  const begun = await world.controller.beginProposalApproval(sessionID, prepared.proposal.id);
  const { approval } = await world.controller.recordApproval(sessionID, prepared.proposal.id, begun.request);
  return { prepared, begun, approval };
}

function failCodes(error: unknown): string[] {
  if (!isUltraPlanError(error)) return [];
  const failures = error.detail?.failures as { code: string }[] | undefined;
  return failures?.map((f) => f.code) ?? [];
}

describe("discovery → architecture transition", () => {
  it("a new run begins in discovery (test 1)", async () => {
    const world = makeWorld();
    const { run } = await admittedStart(world.controller, "ses_d", GOAL);
    expect(run.stage).toBe("discovery");
    expect(run.lifecycle).toBe("active");
    expect(run.goal).toEqual({ statement: GOAL });
  });

  it("request_architecture is a discovery-stage capability only (tests 3)", async () => {
    const contract = TOOL_CONTRACTS["ultraplan_request_architecture"];
    expect(contract?.allowedStages).toEqual(["discovery"]);
    expect(contract?.mutatesCommittedMemory).toBe(false);
    // In architecture the capability is gone → deterministic refusal.
    const world = makeWorld();
    const run = await inArchitectureStage(world);
    await expect(world.controller.requestArchitecture("ses_arch")).rejects.toSatisfy(
      (e: unknown) => isUltraPlanError(e) && e.code === "capability_not_available",
    );
    expect(run.stage).toBe("architecture");
  });

  it("request_architecture enforces the structured goal invariant (§11/§12)", async () => {
    const world = makeWorld();
    await admittedStart(world.controller, "ses_g"); // no goal
    await expect(world.controller.requestArchitecture("ses_g")).rejects.toSatisfy(
      (e: unknown) => isUltraPlanError(e) && e.code === "goal_required",
    );
    // A later /ultra-plan invocation WITH arguments fills the empty goal
    // (user-authored), after which the transition succeeds.
    await admittedStart(world.controller, "ses_g", GOAL);
    const result = await world.controller.requestArchitecture("ses_g");
    expect(result.run.stage).toBe("architecture");
    expect(result.run.goal).toEqual({ statement: GOAL });
  });

  it("resume never overwrites an existing goal (§12)", async () => {
    const world = makeWorld();
    await admittedStart(world.controller, "ses_go", "original");
    await admittedStart(world.controller, "ses_go", "must not apply");
    const run = await world.store.findActiveRunBySession("ses_go");
    expect(run?.goal).toEqual({ statement: "original" });
  });

  it("performs ONLY discovery → architecture and audits run.stage_changed (test 4)", async () => {
    const world = makeWorld();
    const run = await inArchitectureStage(world);
    expect(run.stage).toBe("architecture");
    expect(run.architecture).toBeUndefined();
    const events = (await world.store.listEvents(run.id)).map((e) => e.detail);
    const stageChange = events.find((e) => e.type === "run.stage_changed");
    expect(stageChange).toEqual({ type: "run.stage_changed", from: "discovery", to: "architecture" });
  });

  it("architecture Proposals cannot be prepared in discovery (test 2)", async () => {
    const world = makeWorld();
    await admittedStart(world.controller, "ses_p", GOAL);
    await expect(
      world.controller.prepareProposal("ses_p", {
        type: "architecture_completion",
        scope: { type: "architecture" },
        title: "too early",
        summary: "s",
        changes: [archDraftChange(), { kind: "complete_architecture" }],
      }),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "capability_not_available");
  });

  it("no model-visible operation can force a stage (test 5)", () => {
    expect(FORBIDDEN_TOOL_NAMES).toContain("ultraplan_force_stage");
    expect(FORBIDDEN_TOOL_NAMES).toContain("set_stage");
    for (const name of FORBIDDEN_TOOL_NAMES) {
      expect(TOOL_CONTRACTS[name]).toBeUndefined();
    }
    for (const contract of Object.values(TOOL_CONTRACTS)) {
      expect(contract.mutatesCommittedMemory).toBe(false);
    }
  });

  it("the L0 protocol carries stage-specific discovery/architecture guidance (§28)", () => {
    const run = {
      id: "PLAN-001",
      sessionID: "s",
      lifecycle: "active",
      stage: "discovery",
      revision: 1,
      goal: { statement: GOAL },
      constraints: [],
      sections: [],
      decisions: [],
      openQuestions: [],
      conflicts: [],
      createdAt: FIXED,
      updatedAt: FIXED,
    } as unknown as PlanningRun;
    const discovery = renderPlanningProtocol({ run });
    expect(discovery).toContain("DISCOVERY GOAL");
    expect(discovery).toContain("ultraplan_request_architecture");
    const architecture = renderPlanningProtocol({ run: { ...run, stage: "architecture" } });
    expect(architecture).toContain("ARCHITECTURE GOAL");
    expect(architecture).not.toContain("DISCOVERY GOAL");
    const detail = renderPlanningProtocol({ run: { ...run, stage: "detail" } });
    expect(detail).not.toContain("DISCOVERY GOAL");
    expect(detail).not.toContain("ARCHITECTURE GOAL");
  });
});

describe("add_architecture: the initial committed Architecture", () => {
  it("checkpoint commit creates exactly ARCH@1 approved and stays in architecture (tests 7/8/14)", async () => {
    const world = makeWorld();
    const run = await inArchitectureStage(world);
    const { prepared } = await prepareAwaiting(world, "ses_arch", {
      type: "design_checkpoint",
      changes: [archDraftChange(), CONSTRAINT_CHANGE],
    });
    await world.controller.commitApprovedProposal("ses_arch", prepared.proposal.id);

    const architecture = await world.store.getArchitecture(run.id);
    expect(architecture?.id).toBe("ARCH");
    expect(architecture?.revision).toBe(1);
    expect(architecture?.status).toBe("approved");
    expect(architecture?.summary).toBe(BASE_ARCH_DRAFT.summary);
    expect(architecture?.components).toEqual(BASE_ARCH_DRAFT.components);
    expect(architecture?.basedOn).toEqual([]);
    const after = await world.store.getRun(run.id);
    expect(after?.stage).toBe("architecture"); // checkpoint does NOT complete
    expect(after?.architecture).toEqual({ id: "ARCH", revision: 1 });
    expect(after?.constraints.map((c) => c.id)).toEqual(["CON-001"]);
    const snapshot = await world.store.getHeadSnapshot(run.id);
    expect(snapshot?.state.architectureRevision).toBe(1); // test 23
  });

  it("add_architecture is rejected when a committed Architecture already exists (test 9, freeze-time)", async () => {
    const world = makeWorld();
    await inArchitectureStage(world);
    const checkpoint = await prepareAwaiting(world, "ses_arch", { type: "design_checkpoint", changes: [archDraftChange()] });
    await world.controller.commitApprovedProposal("ses_arch", checkpoint.prepared.proposal.id);
    await expect(
      world.controller.prepareProposal("ses_arch", {
        type: "design_checkpoint",
        scope: { type: "architecture" },
        title: "second architecture",
        summary: "s",
        changes: [archDraftChange()],
      }),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "invalid_scope");
  });

  it("add_architecture is rejected by the engine even from hostile direct input (test 9, defense)", async () => {
    const world = makeWorld();
    const run = await inArchitectureStage(world);
    const checkpoint = await prepareAwaiting(world, "ses_arch", { type: "design_checkpoint", changes: [archDraftChange()] });
    await world.controller.commitApprovedProposal("ses_arch", checkpoint.prepared.proposal.id);

    const proposal: Proposal = {
      id: ProposalIDs.from(9),
      type: "design_checkpoint",
      scope: { id: "ARCH", revision: 1 },
      revision: 1,
      status: "awaiting_approval",
      title: "hostile duplicate",
      summary: "s",
      changes: [
        {
          kind: "add_architecture",
          architecture: {
            id: "ARCH",
            revision: 1,
            status: "approved",
            summary: "duplicate",
            components: [],
            boundaries: [],
            dataFlows: [],
            principles: [],
            unresolved: [],
            basedOn: [],
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
    ).rejects.toSatisfy((e: unknown) => failCodes(e).includes("change_invalid"));
  });

  it("unresolved question ids and basedOn decisions resolve against real run state at freeze (§15)", async () => {
    const world = makeWorld();
    const run = await inArchitectureStage(world);
    await world.controller.recordQuestion("ses_arch", {
      question: "Which persistence layout?",
      blocking: false,
      scope: { type: "architecture" },
    });
    const decisionCheckpoint = await prepareAwaiting(world, "ses_arch", {
      type: "design_checkpoint",
      changes: [
        {
          kind: "add_decision",
          content: { decision: { title: "JSON store", statement: "one document", rationale: "atomic rename" } },
        },
      ],
    });
    await world.controller.commitApprovedProposal("ses_arch", decisionCheckpoint.prepared.proposal.id);
    const prepared = await world.controller.prepareProposal("ses_arch", {
      type: "design_checkpoint",
      scope: { type: "architecture" },
      title: "with refs",
      summary: "s",
      changes: [
        archDraftChange({ ...BASE_ARCH_DRAFT, unresolvedQuestionIDs: ["Q-001"], basedOn: ["DEC-001"] }),
      ],
    });
    const change = prepared.proposal.changes.find(
      (c): c is Extract<ProposalChange, { kind: "add_architecture" }> => c.kind === "add_architecture",
    );
    expect(change?.architecture.unresolved.map((q) => q.id)).toEqual(["Q-001"]);
    expect(change?.architecture.basedOn).toEqual(["DEC-001"]);
    expect(run.id).toBe("PLAN-001");

    // Unknown references are refused at freeze time — no dangling ids.
    await expect(
      world.controller.prepareProposal("ses_arch", {
        type: "design_checkpoint",
        scope: { type: "architecture" },
        title: "dangling",
        summary: "s",
        changes: [archDraftChange({ ...BASE_ARCH_DRAFT, basedOn: ["DEC-999"] })],
      }),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "unknown_reference");
  });

  it("the model cannot write committed Architecture directly (test 13)", async () => {
    expect(FORBIDDEN_TOOL_NAMES).toContain("save_architecture");
    const world = makeWorld();
    const run = await inArchitectureStage(world);
    // The run-header mutation path refuses commit-gated fields outright.
    await expect(
      world.store.saveRun({
        ...run,
        architecture: { id: "ARCH", revision: 1 },
      }),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "commit_gated_run_field");
  });
});

describe("approval hash covers the exact Architecture body (tests 10-12)", () => {
  async function hashOf(mutate?: (draft: typeof BASE_ARCH_DRAFT) => void): Promise<string> {
    const world = makeWorld();
    await inArchitectureStage(world);
    const draft = structuredClone(BASE_ARCH_DRAFT);
    mutate?.(draft);
    const prepared = await world.controller.prepareProposal("ses_arch", {
      type: "design_checkpoint",
      scope: { type: "architecture" },
      title: "hash probe",
      summary: "s",
      changes: [archDraftChange(draft)],
    });
    return prepared.hash;
  }

  it("the body participates in the approval hash", async () => {
    const base = await hashOf();
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashOf()).toBe(base); // deterministic
    expect(
      await hashOf((d) => {
        d.components[0] = { name: "Core", summary: "CHANGED kernel summary" };
      }),
    ).not.toBe(base); // test 11
    expect(
      await hashOf((d) => {
        d.boundaries[0] = { name: "Core edge", description: "CHANGED description" };
      }),
    ).not.toBe(base); // test 12
    expect(
      await hashOf((d) => {
        d.dataFlows[0] = { from: "UI", to: "Core", description: "CHANGED" };
      }),
    ).not.toBe(base);
    expect(await hashOf((d) => void (d.summary = "CHANGED summary"))).not.toBe(base);
    expect(
      await hashOf((d) => void d.principles.push({ statement: "one more principle" })),
    ).not.toBe(base);
  });

  it("the frozen hash still recomputes after ready → awaiting_approval (§17/2A.1)", async () => {
    const world = makeWorld();
    await inArchitectureStage(world);
    const { prepared, begun } = await prepareAwaiting(world, "ses_arch", {
      type: "design_checkpoint",
      changes: [archDraftChange()],
    });
    expect(begun.request.proposalHash).toBe(prepared.hash);
    expect(computeProposalHash(begun.proposal)).toBe(prepared.hash);
  });
});

describe("constraint authority resolution (§13/§14, tests 35/36)", () => {
  it("constraints are commit-gated: no working-state path exists", async () => {
    const world = makeWorld();
    const run = await inArchitectureStage(world);
    for (const name of Object.keys(TOOL_CONTRACTS)) {
      expect(name.toLowerCase()).not.toContain("constraint");
    }
    await expect(
      world.store.saveRun({ ...run, constraints: [{ id: "CON-001" as never, source: "model" as never, statement: "smuggled", severity: "hard", status: "active" }] }),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "commit_gated_run_field");
    expect((await world.store.getRun(run.id))?.constraints).toHaveLength(0);
  });

  it("add_constraint commits through approval only, exactly once, deduped at freeze", async () => {
    const world = makeWorld();
    const run = await inArchitectureStage(world);
    const { prepared } = await prepareAwaiting(world, "ses_arch", {
      type: "design_checkpoint",
      changes: [CONSTRAINT_CHANGE],
    });
    await world.controller.commitApprovedProposal("ses_arch", prepared.proposal.id);
    const after = await world.store.getRun(run.id);
    expect(after?.constraints).toHaveLength(1);
    expect(after?.constraints[0]).toMatchObject({ id: "CON-001", statement: "single writer", severity: "hard", status: "active" });
    const snapshot = await world.store.getHeadSnapshot(run.id);
    expect(snapshot?.state.constraintIDs).toEqual(["CON-001"]);
    const events = (await world.store.listEvents(run.id)).map((e) => e.detail);
    expect(events).toContainEqual({ type: "artifact.revised", kind: "constraint", id: "CON-001", revision: 1 });

    // An identical active constraint cannot be proposed again.
    await expect(
      world.controller.prepareProposal("ses_arch", {
        type: "design_checkpoint",
        scope: { type: "architecture" },
        title: "dup constraint",
        summary: "s",
        changes: [CONSTRAINT_CHANGE],
      }),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "proposal_kind_unsupported");
  });

  it("constraint drafts are closed-typed (source/severity validated)", async () => {
    const world = makeWorld();
    await inArchitectureStage(world);
    await expect(
      world.controller.prepareProposal("ses_arch", {
        type: "design_checkpoint",
        scope: { type: "architecture" },
        title: "bad constraint",
        summary: "s",
        changes: [{ kind: "add_constraint", content: { constraint: { statement: "x", source: "model", severity: "hard" } } }],
      }),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "invalid_scope");
  });
});

describe("architecture completion: the atomic stage boundary (§8/§21)", () => {
  async function checkpointedWorld() {
    const world = makeWorld();
    const run = await inArchitectureStage(world);
    const { prepared } = await prepareAwaiting(world, "ses_arch", {
      type: "design_checkpoint",
      changes: [archDraftChange()],
    });
    await world.controller.commitApprovedProposal("ses_arch", prepared.proposal.id);
    return { world, run };
  }

  it("request_completion(kind=architecture) freezes the exact revision (test 15)", async () => {
    const { world, run } = await checkpointedWorld();
    const prepared = await world.controller.requestCompletion("ses_arch", { kind: "architecture" });
    expect(prepared.proposal.type).toBe("architecture_completion");
    expect(prepared.proposal.changes).toEqual([
      { kind: "complete_architecture", target: { id: "ARCH", revision: 1 } },
    ]);
    expect(run.id).toBe("PLAN-001");
  });

  it("architecture-scoped completion cannot touch sections (test 28)", async () => {
    const { world } = await checkpointedWorld();
    const prepared = await world.controller.requestCompletion("ses_arch", { kind: "architecture" });
    for (const change of prepared.proposal.changes) {
      expect(change.kind).not.toBe("complete_section");
    }
    expect(await world.store.listSections((await world.store.getRun("PLAN-001" as never))!.id)).toHaveLength(0);
  });

  it("completion commits architecture + stage=detail in ONE transaction (tests 17/18, in-memory)", async () => {
    const { world, run } = await checkpointedWorld();
    const prepared = await world.controller.requestCompletion("ses_arch", { kind: "architecture" });
    const begun = await world.controller.beginProposalApproval("ses_arch", prepared.proposal.id);
    const result = await world.controller.recordApprovalAndCommit("ses_arch", prepared.proposal.id, begun.request);

    const after = await world.store.getRun(run.id);
    expect(after?.stage).toBe("detail");
    expect(after?.architecture).toEqual({ id: "ARCH", revision: 1 });
    expect(result.proposal?.status).toBe("approved");
    // The stage event is inside the same publication, before HEAD moves
    // (lastIndexOf: this world has TWO commits — checkpoint and completion).
    const events = (await world.store.listEvents(run.id)).map((e) => e.detail);
    const types = events.map((e) => e.type);
    const stageIndex = types.lastIndexOf("run.stage_changed");
    const committedIndex = types.lastIndexOf("transaction.committed");
    const headIndex = types.lastIndexOf("head.moved");
    expect(stageIndex).toBeGreaterThan(-1);
    expect(committedIndex).toBeGreaterThan(stageIndex);
    expect(headIndex).toBe(types.length - 1);
    expect(events[stageIndex]).toEqual({ type: "run.stage_changed", from: "architecture", to: "detail" });
  });

  it("exact retry of the committed completion is idempotent (test 21)", async () => {
    const { world, run } = await checkpointedWorld();
    const prepared = await world.controller.requestCompletion("ses_arch", { kind: "architecture" });
    const begun = await world.controller.beginProposalApproval("ses_arch", prepared.proposal.id);
    const first = await world.controller.recordApprovalAndCommit("ses_arch", prepared.proposal.id, begun.request);
    const again = await world.controller.commitApprovedProposal("ses_arch", prepared.proposal.id);
    expect(again.commit.id).toBe(first.commit.id);
    expect(await world.store.listCommits(run.id)).toHaveLength(2); // checkpoint + completion
  });

  it("completion with a nonexistent Architecture ref fails the transaction (test 16)", async () => {
    const { world, run } = await checkpointedWorld();
    const proposal: Proposal = {
      id: ProposalIDs.from(9),
      type: "architecture_completion",
      scope: { id: "ARCH", revision: 1 },
      revision: 1,
      status: "awaiting_approval",
      title: "stale completion",
      summary: "s",
      changes: [{ kind: "complete_architecture", target: { id: "ARCH", revision: 5 } }] as ProposalChange[],
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
    // State unchanged.
    expect((await world.store.getRun(run.id))?.stage).toBe("architecture");
    expect(await world.store.listCommits(run.id)).toHaveLength(1); // only the checkpoint
  });

  it("completion does NOT run Final Plan finalization (tests 31/32)", async () => {
    const world = makeWorld();
    const run = await inArchitectureStage(world);
    // A blocking open question and zero sections would block plan finalization;
    // architecture completion is NOT finalization.
    await world.controller.recordQuestion("ses_arch", {
      question: "Which transport for the handoff?",
      blocking: true,
      scope: { type: "architecture" },
    });
    const { prepared } = await prepareAwaiting(world, "ses_arch", {
      type: "architecture_completion",
      changes: [archDraftChange(), { kind: "complete_architecture" }],
    });
    await world.controller.recordApprovalAndCommit("ses_arch", prepared.proposal.id, {
      proposalID: prepared.proposal.id,
      proposalRevision: 1,
      proposalHash: prepared.hash,
      oneShot: true,
      requestedAt: FIXED,
    });
    const after = await world.store.getRun(run.id);
    expect(after?.stage).toBe("detail");
    expect(after?.openQuestions[0]?.status).toBe("open");
    // Phase 2H: finalization is not reachable here at all — detail stage never
    // grants request_finalization (the run cannot even be resolved for it).
    await expect(
      world.controller.requestFinalization("ses_arch"),
    ).rejects.toMatchObject({ code: "capability_not_available" });
  });

  it("an ordinary design checkpoint never transitions the stage (tests 14/30)", async () => {
    const world = makeWorld();
    const run = await inArchitectureStage(world);
    const { prepared } = await prepareAwaiting(world, "ses_arch", {
      type: "design_checkpoint",
      changes: [
        {
          kind: "add_decision",
          content: { decision: { title: "Checkpoint decision", statement: "s", rationale: "r" } },
        },
      ],
    });
    await world.controller.commitApprovedProposal("ses_arch", prepared.proposal.id);
    expect((await world.store.getRun(run.id))?.stage).toBe("architecture");
  });

  it("complete_architecture inside a non-completion proposal fails closed (engine defense)", async () => {
    const { world, run } = await checkpointedWorld();
    const proposal: Proposal = {
      id: ProposalIDs.from(9),
      type: "design_checkpoint",
      scope: { id: "ARCH", revision: 1 },
      revision: 1,
      status: "awaiting_approval",
      title: "smuggled completion",
      summary: "s",
      changes: [{ kind: "complete_architecture", target: { id: "ARCH", revision: 1 } }] as ProposalChange[],
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
    ).rejects.toSatisfy((e: unknown) => failCodes(e).includes("completion_type_invalid"));
    expect((await world.store.getRun(run.id))?.stage).toBe("architecture");
  });

  it("injected publication failure leaves Architecture/stage/HEAD unchanged; the Approval stays retriable (tests 19/20)", async () => {
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
    const run = await inArchitectureStage(world);
    const checkpoint = await prepareAwaiting(world, "ses_arch", {
      type: "design_checkpoint",
      changes: [archDraftChange()],
    });
    const checkpointCommit = await world.controller.commitApprovedProposal("ses_arch", checkpoint.prepared.proposal.id);

    const prepared = await world.controller.requestCompletion("ses_arch", { kind: "architecture" });
    const begun = await world.controller.beginProposalApproval("ses_arch", prepared.proposal.id);
    await world.controller.recordApproval("ses_arch", prepared.proposal.id, begun.request);
    store.armed = true;
    await expect(world.controller.commitApprovedProposal("ses_arch", prepared.proposal.id)).rejects.toSatisfy(
      (e: unknown) => isUltraPlanError(e) && e.code === "store_busy",
    );
    // Zero partial mutation.
    const afterFailure = await world.store.getRun(run.id);
    expect(afterFailure?.stage).toBe("architecture");
    expect(afterFailure?.architecture).toEqual({ id: "ARCH", revision: 1 });
    expect(afterFailure?.headCommit).toBe(checkpointCommit.commit.id);
    expect((await world.store.getProposal(run.id, prepared.proposal.id))?.status).toBe("awaiting_approval");
    expect(await world.store.listCommits(run.id)).toHaveLength(1);

    // The SAME durable approval commits on retry — no re-approval needed.
    const retry = await world.controller.commitApprovedProposal("ses_arch", prepared.proposal.id);
    expect((await world.store.getRun(run.id))?.stage).toBe("detail");
    expect(retry.commit.changes.map((c) => c.kind)).toEqual(["complete_architecture"]);
  });
});

describe("section completion scoping (test 29, restored Phase 2E2)", () => {
  it("section-scoped completion cannot complete the Architecture or move the stage; it progresses the focus", async () => {
    const world = makeWorld();
    let run = (await admittedStart(world.controller, "ses_sec", GOAL)).run;
    run = await world.store.saveRun(transitionStage(run, "architecture"));
    run = await world.store.saveRun(transitionStage(run, "detail"));
    // Seed a committed, CHECKPOINTED active section with an approved
    // dependency and one remaining section (as Phase 2E1/2E2 commits would
    // have created) — the Phase 2E2-restored completion path.
    world.store.seedCommittedState(run.id, {
      sections: [
        {
          id: "SEC-001" as never,
          title: "Approved dependency",
          objective: "o",
          dependencies: [],
          status: "approved",
          validation: "valid",
          currentRevision: 1,
          approvedRevision: 1,
        },
        {
          id: "SEC-002" as never,
          title: "Only section",
          objective: "o",
          dependencies: ["SEC-001" as never],
          status: "active",
          validation: "valid",
          currentRevision: 1,
          approvedRevision: 1,
        },
        {
          id: "SEC-003" as never,
          title: "Remaining work",
          objective: "o",
          dependencies: ["SEC-002" as never],
          status: "pending",
          validation: "valid",
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
          decisions: [],
          openQuestions: [],
          impacts: [],
          projection: {
            compact: "c",
            contract: {
              sectionID: "SEC-001" as never,
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
        {
          sectionID: "SEC-002" as never,
          revision: 1,
          status: "approved" as const,
          problem: "p",
          design: "d",
          interfaces: [],
          invariants: [],
          failureModes: [],
          dependencies: [{ sectionID: "SEC-001" as never, consumes: [], contractRevision: 1 }],
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
      // TEST-ONLY seam: the focused section (normally set by the DAG commit).
      activeWork: { type: "section", id: "SEC-002" as never },
    });
    // Phase 2E2: the model supplies no revision — the Harness resolves the
    // exact current approved checkpoint of the ACTIVE section.
    const prepared = await world.controller.requestCompletion("ses_sec", { kind: "section" });
    expect(prepared.proposal.type).toBe("section_completion");
    for (const change of prepared.proposal.changes) {
      expect(change.kind).not.toBe("complete_architecture");
      expect(change.kind).not.toBe("add_architecture");
    }
    expect(prepared.proposal.changes[0]).toMatchObject({
      kind: "complete_section",
      target: { id: "SEC-002", revision: 1 },
    });
    const begun = await world.controller.beginProposalApproval("ses_sec", prepared.proposal.id);
    await world.controller.recordApprovalAndCommit("ses_sec", prepared.proposal.id, begun.request);
    // The commit closes the section, progresses the focus to the remaining
    // work, and leaves the run and Architecture alone.
    const after = await world.store.getRun(run.id);
    expect(after?.stage).toBe("detail");
    expect(after?.architecture).toBeUndefined();
    expect(after?.activeWork).toEqual({ type: "section", id: "SEC-003" });
    const completed = await world.store.getSection(run.id, "SEC-002" as never);
    expect(completed).toMatchObject({ status: "approved", currentRevision: 1, approvedRevision: 1, validation: "valid" });
    await expect(world.store.getArchitecture(run.id)).resolves.toBeUndefined();
  });
});

describe("repository evidence in the architecture workflow (tests 33/34)", () => {
  function evidence(id: EvidenceID, overrides: Partial<Evidence> = {}): Evidence {
    return {
      id,
      revision: 1,
      kind: "file",
      claim: "the store uses atomic rename",
      source: [{ type: "file", path: "src/memory/durable-store.ts" }],
      scope: { kind: "run" },
      confidence: "direct",
      criticality: "critical",
      freshness: "fresh",
      status: "active",
      discoveredAt: FIXED,
      lastValidatedAt: FIXED,
      ...overrides,
    };
  }

  it("evidence refs survive Proposal → commit inside decisions and basedOn (test 33)", async () => {
    const world = makeWorld();
    const run = await inArchitectureStage(world);
    await world.store.putEvidence(run.id, evidence("EVD-001" as never));
    const { prepared } = await prepareAwaiting(world, "ses_arch", {
      type: "architecture_completion",
      changes: [
        {
          kind: "add_decision",
          content: {
            decision: {
              title: "JSON document store",
              statement: "one atomic rename per commit",
              rationale: "proven by the backend gate",
              evidence: [{ id: "EVD-001" }],
            },
          },
        },
        archDraftChange({ ...BASE_ARCH_DRAFT, basedOn: ["DEC-001"] }),
        { kind: "complete_architecture" },
      ],
    });
    await world.controller.recordApprovalAndCommit("ses_arch", prepared.proposal.id, {
      proposalID: prepared.proposal.id,
      proposalRevision: 1,
      proposalHash: prepared.hash,
      oneShot: true,
      requestedAt: FIXED,
    });
    const decision = await world.store.getDecision(run.id, { id: "DEC-001" as never, revision: 1 });
    expect(decision?.evidence).toEqual([{ id: "EVD-001" }]);
    const architecture = await world.store.getArchitecture(run.id);
    expect(architecture?.basedOn).toEqual(["DEC-001"]);
    expect((await world.store.getRun(run.id))?.stage).toBe("detail");
  });

  it("stale critical evidence still fails the architecture transaction (test 34)", async () => {
    const world = makeWorld();
    const run = await inArchitectureStage(world);
    await world.store.putEvidence(
      run.id,
      evidence("EVD-001" as never, { freshness: "stale" }),
    );
    const { prepared } = await prepareAwaiting(world, "ses_arch", {
      type: "architecture_completion",
      changes: [
        {
          kind: "add_decision",
          content: {
            decision: {
              title: "depends on stale fact",
              statement: "s",
              rationale: "r",
              evidence: [{ id: "EVD-001" }],
            },
          },
        },
        archDraftChange({ ...BASE_ARCH_DRAFT, basedOn: ["DEC-001"] }),
        { kind: "complete_architecture" },
      ],
    });
    await expect(
      world.controller.recordApprovalAndCommit("ses_arch", prepared.proposal.id, {
        proposalID: prepared.proposal.id,
        proposalRevision: 1,
        proposalHash: prepared.hash,
        oneShot: true,
        requestedAt: FIXED,
      }),
    ).rejects.toSatisfy((e: unknown) => failCodes(e).includes("evidence_not_fresh"));
    expect((await world.store.getRun(run.id))?.stage).toBe("architecture");
    expect(await world.store.getArchitecture(run.id)).toBeUndefined();
  });
});

describe("deterministic status rendering (tests 25-27, §30)", () => {
  it("renders discovery, architecture-designing, checkpoint, and completion states", async () => {
    const world = makeWorld();
    const { run } = await admittedStart(world.controller, "ses_r", GOAL);
    let report = await world.controller.statusReport("ses_r");
    expect(report.statusText).toContain("Stage: discovery");
    expect(report.statusText).toContain("Architecture: not started"); // test 25

    await world.controller.requestArchitecture("ses_r");
    report = await world.controller.statusReport("ses_r");
    expect(report.statusText).toContain("Stage: architecture");
    expect(report.statusText).toContain("Architecture: designing"); // test 26

    const checkpoint = await prepareAwaiting(world, "ses_r", {
      type: "design_checkpoint",
      changes: [archDraftChange()],
    });
    await world.controller.commitApprovedProposal("ses_r", checkpoint.prepared.proposal.id);
    report = await world.controller.statusReport("ses_r");
    expect(report.statusText).toContain("Stage: architecture");
    expect(report.statusText).toContain("Architecture: ARCH@1 approved");

    const completion = await world.controller.requestCompletion("ses_r", { kind: "architecture" });
    const begun = await world.controller.beginProposalApproval("ses_r", completion.proposal.id);
    await world.controller.recordApprovalAndCommit("ses_r", completion.proposal.id, begun.request);
    report = await world.controller.statusReport("ses_r");
    expect(report.statusText).toContain("Stage: detail");
    expect(report.statusText).toContain("Architecture: ARCH@1 approved"); // test 27
    expect(report.statusText).toContain("Sections: not decomposed"); // 2D §35 substate
    expect(report.statusText).toContain("Active work: none");
    expect(run.id).toBe("PLAN-001");
  });

  it("renderStatus stays deterministic for identical state", () => {
    const run = {
      id: "PLAN-001",
      sessionID: "s",
      lifecycle: "active",
      stage: "architecture",
      revision: 3,
      goal: { statement: GOAL },
      constraints: [],
      sections: [],
      decisions: [],
      openQuestions: [],
      conflicts: [],
      createdAt: FIXED,
      updatedAt: FIXED,
    } as unknown as PlanningRun;
    expect(renderStatus(run)).toBe(renderStatus(run));
    expect(renderStatus(run)).toContain("Architecture: designing");
  });
});

describe("deterministic approval presentation (§18/§19)", () => {
  it("the gateway presents a deterministic projection of the frozen proposal", async () => {
    const world = makeWorld();
    await inArchitectureStage(world, "ses_ask");
    // READY proposal: the tool itself drives ready → awaiting_approval → ask.
    const prepared = await world.controller.prepareProposal("ses_ask", {
      type: "architecture_completion",
      scope: { type: "architecture" },
      title: "One-shot architecture",
      summary: "s",
      changes: [archDraftChange(), CONSTRAINT_CHANGE, { kind: "complete_architecture" }] as never,
    });

    const tools = createUltraPlanTools(world.controller);
    const asks: CapturedAsk[] = [];
    const context = fakeToolContext("ses_ask", {
      ask: async (input) => {
        asks.push(input);
      },
    });
    const approvalTool = tools["ultraplan_request_user_approval"] as ToolDefinition;
    const result = (await approvalTool.execute(
      { proposalID: prepared.proposal.id },
      context,
    )) as { output: string; metadata: Record<string, unknown> };

    const ask = asks[0];
    expect(ask?.always).toEqual([]);
    expect(ask?.patterns).toEqual([]);
    expect(ask?.permission).toContain(`ultraplan.approval:${prepared.proposal.id}@1`);
    expect(ask?.permission).toContain(prepared.hash.slice(0, 16));
    expect(ask?.metadata["proposalHash"]).toBe(prepared.hash);
    const view = String(ask?.metadata["approvalView"]);
    expect(view).toContain("ADD ARCHITECTURE ARCH@1 (status approved)");
    expect(view).toContain("Components: Core — kernel");
    expect(view).toContain("Boundaries: Core edge — the only entry");
    expect(view).toContain("Data flows: UI -> Core (commands)");
    expect(view).toContain("ADD CONSTRAINT CON-001 (hard, source environment): single writer");
    expect(view).toContain("COMPLETE ARCHITECTURE ARCH@1");
    expect(view).toContain(`Approval hash: ${prepared.hash}`);

    const run = await world.store.findActiveRunBySession("ses_ask");
    expect(result.metadata["stage"]).toBe("detail");
    expect(run?.stage).toBe("detail");
    expect(run?.architecture).toEqual({ id: "ARCH", revision: 1 });
  });

  it("the deny path rejects the proposal with no commit and no stage movement", async () => {
    const world = makeWorld();
    await inArchitectureStage(world, "ses_deny");
    const prepared = await world.controller.prepareProposal("ses_deny", {
      type: "architecture_completion",
      scope: { type: "architecture" },
      title: "Denied architecture",
      summary: "s",
      changes: [archDraftChange(), { kind: "complete_architecture" }] as never,
    });
    const tools = createUltraPlanTools(world.controller);
    const context = fakeToolContext("ses_deny", {
      ask: async () => {
        throw new Error("user denied");
      },
    });
    const approvalTool = tools["ultraplan_request_user_approval"] as ToolDefinition;
    await approvalTool.execute({ proposalID: prepared.proposal.id }, context);
    const run = await world.store.findActiveRunBySession("ses_deny");
    expect(run?.stage).toBe("architecture");
    expect(run?.architecture).toBeUndefined();
    expect((await world.store.getProposal("PLAN-001" as never, prepared.proposal.id))?.status).toBe("rejected");
  });
});

// -----------------------------------------------------------------------------
// Durable recovery (§31) — real close/reopen cycles over DurablePlanStore.
// -----------------------------------------------------------------------------

describe("durable workflow recovery (§31/§34)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "ultraplan-arch-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  function openStore(dbFile: string): DurablePlanStore {
    return new DurablePlanStore(dbFile, { now: () => FIXED });
  }

  it("discovery → architecture survives a real restart (test 6)", async () => {
    const dbFile = path.join(dir, "plan-store.json");
    const store = openStore(dbFile);
    const world = makeWorld(store);
    await admittedStart(world.controller, "ses_dr", GOAL);
    await world.controller.requestArchitecture("ses_dr");
    store.close();

    const reopened = openStore(dbFile);
    await reopened.open();
    const run = await reopened.findActiveRunBySession("ses_dr");
    expect(run?.stage).toBe("architecture");
    expect(run?.goal).toEqual({ statement: GOAL });
    reopened.close();
  });

  it("a READY architecture proposal keeps its exact hash across restart (test 37)", async () => {
    const dbFile = path.join(dir, "plan-store.json");
    const store = openStore(dbFile);
    const world = makeWorld(store);
    await inArchitectureStage(world, "ses_ready");
    // READY (not yet begun): only prepareProposal touches it.
    const prepared = await world.controller.prepareProposal("ses_ready", {
      type: "architecture_completion",
      scope: { type: "architecture" },
      title: "Ready architecture",
      summary: "s",
      changes: [archDraftChange(), { kind: "complete_architecture" }] as never,
    });
    const readyHash = prepared.hash;
    store.close();

    const reopened = openStore(dbFile);
    await reopened.open();
    const proposal = await reopened.getProposal("PLAN-001" as never, prepared.proposal.id);
    expect(proposal?.status).toBe("ready");
    expect(proposal?.hash).toBe(readyHash);
    expect(computeProposalHash(proposal as Proposal)).toBe(readyHash);
    reopened.close();
  });

  it("an awaiting proposal with NO approval does not fabricate one after restart (test 38)", async () => {
    const dbFile = path.join(dir, "plan-store.json");
    const store = openStore(dbFile);
    const world = makeWorld(store);
    await inArchitectureStage(world, "ses_await");
    const prepared = await world.controller.prepareProposal("ses_await", {
      type: "architecture_completion",
      scope: { type: "architecture" },
      title: "Awaiting architecture",
      summary: "s",
      changes: [archDraftChange(), { kind: "complete_architecture" }] as never,
    });
    // ready → awaiting_approval WITHOUT any approval being recorded.
    await world.controller.beginProposalApproval("ses_await", prepared.proposal.id);
    store.close();

    const reopened = openStore(dbFile);
    await reopened.open();
    const proposal = await reopened.getProposal("PLAN-001" as never, prepared.proposal.id);
    expect(proposal?.status).toBe("awaiting_approval");
    expect(await reopened.findApprovalForProposal("PLAN-001" as never, prepared.proposal.id)).toBeUndefined();
    // A commit attempt without approval is refused.
    await expect(
      reopened.commitTransaction({
        planID: "PLAN-001" as never,
        proposalID: prepared.proposal.id,
        approvalID: "APPR-001" as never,
      }),
    ).rejects.toSatisfy((e: unknown) => isUltraPlanError(e) && e.code === "approval_not_found");
    // And the honest path still works: record approval, commit.
    const controller = new UltraPlanController({ store: reopened, now: () => FIXED });
    const request = {
      proposalID: prepared.proposal.id,
      proposalRevision: 1,
      proposalHash: prepared.hash,
      oneShot: true as const,
      requestedAt: FIXED,
    };
    await controller.recordApproval("ses_await", prepared.proposal.id, request);
    const result = await controller.commitApprovedProposal("ses_await", prepared.proposal.id);
    expect((await reopened.getRun("PLAN-001" as never))?.stage).toBe("detail");
    expect(result.commit.id).toBe("COMMIT-001");
    reopened.close();
  });

  it("a durable Approval allows the exact retry after restart (test 39)", async () => {
    const dbFile = path.join(dir, "plan-store.json");
    const store = openStore(dbFile);
    const world = makeWorld(store);
    await inArchitectureStage(world, "ses_appr");
    const { prepared, approval } = await prepareAwaiting(world, "ses_appr", {
      type: "architecture_completion",
      changes: [archDraftChange(), { kind: "complete_architecture" }],
    });
    store.close();

    const reopened = openStore(dbFile);
    await reopened.open();
    const stored = await reopened.findApprovalForProposal("PLAN-001" as never, prepared.proposal.id);
    expect(stored?.id).toBe(approval.id);
    const commit = await reopened.commitTransaction({
      planID: "PLAN-001" as never,
      proposalID: prepared.proposal.id,
      approvalID: approval.id,
    });
    expect(commit.changes.map((c) => c.kind)).toEqual(["add_architecture", "complete_architecture"]);
    expect((await reopened.getRun("PLAN-001" as never))?.stage).toBe("detail");
    reopened.close();
  });

  it("§34 PRIMARY: full architecture workflow end-to-end, then reopen shows the identical committed state (tests 17/18/24)", async () => {
    const dbFile = path.join(dir, "plan-store.json");
    const store = openStore(dbFile);
    const world = makeWorld(store);

    // /ultra-plan with the user's goal → discovery.
    const run = (await admittedStart(world.controller, "ses_e2e", GOAL)).run;
    expect(run.stage).toBe("discovery");

    // Discovery: record a question + promote real evidence.
    await world.controller.recordQuestion("ses_e2e", {
      question: "Where does durable state live?",
      blocking: false,
      scope: { type: "architecture" },
    });
    await world.store.putEvidence(run.id, {
      id: "EVD-001" as never,
      revision: 1,
      kind: "file",
      claim: "the host exposes no node:sqlite",
      source: [{ type: "command", command: "backend gate probe" }],
      scope: { kind: "run" },
      confidence: "direct",
      criticality: "critical",
      freshness: "fresh",
      status: "active",
      discoveredAt: FIXED,
      lastValidatedAt: FIXED,
    });

    // Harness-authorized discovery → architecture.
    await world.controller.requestArchitecture("ses_e2e");

    // One exact Architecture Proposal: decision (evidence-backed) +
    // architecture (basedOn the decision, carrying the open question) +
    // constraint + completion. prepareAwaiting drives ready → awaiting_approval
    // atomically; `begun.request` carries the Harness-created binding.
    const { prepared, begun } = await prepareAwaiting(world, "ses_e2e", {
      type: "architecture_completion",
      changes: [
        {
          kind: "add_decision",
          content: {
            decision: {
              title: "JSON document store",
              statement: "one atomic rename per commit",
              rationale: "backend gate evidence",
              evidence: [{ id: "EVD-001" }],
            },
          },
        },
        archDraftChange({
          ...BASE_ARCH_DRAFT,
          unresolvedQuestionIDs: ["Q-001"],
          basedOn: ["DEC-001"],
        }),
        CONSTRAINT_CHANGE,
        { kind: "complete_architecture" },
      ],
    });

    // Simulated structured user ALLOW through the real approval binding.
    const commitResult = await world.controller.recordApprovalAndCommit(
      "ses_e2e",
      prepared.proposal.id,
      begun.request,
    );

    const before = await reopened_view(store);
    async function reopened_view(s: DurablePlanStore) {
      const current = await s.getRun("PLAN-001" as never);
      return {
        stage: current?.stage,
        architecture: current?.architecture,
        architectureBody: await s.getArchitecture("PLAN-001" as never),
        head: current?.headCommit,
        snapshot: await s.getHeadSnapshot("PLAN-001" as never),
        commits: await s.listCommits("PLAN-001" as never),
        proposal: await s.getProposal("PLAN-001" as never, prepared.proposal.id),
        decisions: await s.listDecisions("PLAN-001" as never),
        constraints: current?.constraints ?? [],
        questions: current?.openQuestions ?? [],
      };
    }
    expect(before.stage).toBe("detail");
    expect(before.architecture).toEqual({ id: "ARCH", revision: 1 });
    expect(before.architectureBody?.status).toBe("approved");
    expect(before.architectureBody?.basedOn).toEqual(["DEC-001"]);
    expect(before.architectureBody?.unresolved.map((q) => q.id)).toEqual(["Q-001"]);
    expect(commitResult.commit.id).toBe("COMMIT-001");
    expect(before.head).toBe("COMMIT-001");
    expect(before.snapshot?.id).toBe(commitResult.commit.resultingSnapshot);
    expect(before.proposal?.status).toBe("approved");
    expect(before.decisions[0]?.evidence).toEqual([{ id: "EVD-001" }]);
    expect(before.constraints.map((c) => c.id)).toEqual(["CON-001"]);
    expect(before.questions[0]?.status).toBe("open");

    // REAL close/reopen: no ambiguity about stage, architecture, HEAD.
    store.close();
    const reopened = openStore(dbFile);
    await reopened.open();
    const after = await reopened_view(reopened);
    expect(after.stage).toBe("detail");
    expect(after.architecture).toEqual(before.architecture);
    expect(after.architectureBody).toEqual(before.architectureBody);
    expect(after.head).toBe(before.head);
    expect(after.snapshot).toEqual(before.snapshot);
    expect(after.commits).toEqual(before.commits);
    expect(after.proposal).toEqual(before.proposal);
    reopened.close();
  });
});
