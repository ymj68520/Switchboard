/**
 * Phase 2I — Formal Final Proposal, Final Approval & Final PlanCommit.
 *
 * Covers the §89 matrix: candidate-gated preparation with a rerun gate
 * (§6-§8/§19), the Harness-assigned FINAL-###@1 identity and the exact
 * candidate projection (§9-§15/§33), the closed single-change final Proposal
 * and its hash mutations (§16-§18), the narrow approval boundary with pre-ask
 * staleness refusal (§20-§24/§57), the MANDATORY second FinalizationGate
 * inside the transaction engine with exact identity equality (§25-§27) and
 * every post-approval drift scenario (§28-§31), the atomic Final PlanCommit
 * effects (§34-§44), competing/concurrent proposals (§58-§60), publication
 * fault injection (§66), the handoff_pending boundary with no Build side
 * effects (§37/§38/§52/§79/§80), exact reads (§47), the deterministic
 * approval view (§45/§46/§75), status rendering (§85), and durable
 * corruption fail-closed matrices (§70-§74). Process-level crash recovery
 * (§67/§68) lives in durable-crash.test.ts.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DurablePlanStore,
  InMemoryPlanStore,
  buildFinalPlanFromCandidate,
  computeFinalPlanHashFromContent,
  computeProposalHash,
  getCapabilities,
  isUltraPlanError,
  renderFinalPlanBody,
  renderPlanningProtocol,
  renderProposalForApproval,
  type FinalPlanCandidate,
  type SemanticValidator,
} from "../src/index.js";
import { UltraPlanController, type SectionCheckpointInput } from "../src/core/controller.js";
import type { FinalPlan, PlanningRun } from "../src/core/types.js";
import type { ApprovalRequest } from "../src/transaction/approval.js";
import type { Proposal } from "../src/transaction/types.js";
import { EvidenceIDs, FinalPlanIDs } from "../src/core/ids.js";
import { admittedStart, evidence } from "./helpers.js";

const FIXED = "2026-09-25T12:00:00.000Z";
const FIXED2 = "2026-09-25T12:30:00.000Z";
const GOAL = "Build the durable planning harness";

type World = {
  store: InMemoryPlanStore;
  controller: UltraPlanController;
  sessionID: string;
  runID: ReturnType<InMemoryPlanStore["getRun"]> extends Promise<infer R> ? R extends { id: infer I } ? I : never : never;
};

// -----------------------------------------------------------------------------
// World builders (the real-flow drive shared with the 2F/2G/2H suites)
// -----------------------------------------------------------------------------

function makeWorld(store?: InMemoryPlanStore, validator?: SemanticValidator) {
  const planStore = store ?? new InMemoryPlanStore(() => FIXED);
  const controller = new UltraPlanController({
    store: planStore,
    now: () => FIXED,
    ...(validator ? { semanticValidator: validator } : {}),
  });
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

async function dagWorld(world: { store: InMemoryPlanStore; controller: UltraPlanController }, sessionID: string) {
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
}

async function checkpointAndComplete(world: { store: InMemoryPlanStore; controller: UltraPlanController }, sessionID: string, overrides: Partial<SectionCheckpointInput> = {}): Promise<void> {
  const run = (await world.store.findActiveRunBySession(sessionID)) as PlanningRun;
  const active = run.activeWork?.type === "section" ? run.activeWork.id : undefined;
  if (!active) throw new Error("no active section");
  const prepared = await world.controller.prepareSectionCheckpoint(sessionID, checkpointInput(active as "SEC-001", overrides));
  const begun = await world.controller.beginProposalApproval(sessionID, prepared.proposal.id);
  await world.controller.recordApprovalAndCommit(sessionID, prepared.proposal.id, begun.request);
  const completion = await world.controller.requestCompletion(sessionID, { kind: "section" });
  const completionBegun = await world.controller.beginProposalApproval(sessionID, completion.proposal.id);
  await world.controller.recordApprovalAndCommit(sessionID, completion.proposal.id, completionBegun.request);
}

function manifestDraft(): Parameters<UltraPlanController["submitSynthesisManifest"]>[1] {
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

const CLEAN_VALIDATOR: SemanticValidator = { async validate() { return { text: JSON.stringify({ result: "clean", findings: [] }) }; } };

/** Drive: sections complete → synthesis → input → manifest → clean validation. */
async function cleanWorld(sessionID = "ses_final", validator: SemanticValidator = CLEAN_VALIDATOR): Promise<World> {
  const world = makeWorld(undefined, validator);
  await dagWorld(world, sessionID);
  await checkpointAndComplete(world, sessionID);
  await checkpointAndComplete(world, sessionID);
  await checkpointAndComplete(world, sessionID);
  await world.controller.beginSynthesis(sessionID);
  await world.controller.submitSynthesisManifest(sessionID, manifestDraft());
  await world.controller.runSemanticValidation(sessionID);
  const run = (await world.store.findActiveRunBySession(sessionID)) as PlanningRun;
  return { ...world, sessionID, runID: run.id } as World;
}

/** Drive to a CURRENT passing FinalPlanCandidate (the Phase 2I entry state). */
async function candidateWorld(sessionID = "ses_final"): Promise<World & { candidate: FinalPlanCandidate }> {
  const world = await cleanWorld(sessionID);
  const result = await world.controller.requestFinalization(sessionID);
  expect(result.gate.result).toBe("pass");
  return { ...world, candidate: result.candidate!.candidate };
}

/**
 * Candidate world WITH reachable evidence: a committed Decision DEC-001
 * citing EVD-001, anchored by SEC-001's approved checkpoint. This is the
 * world where an evidence revision bump (without HEAD movement) genuinely
 * moves the reachable-evidence fingerprint (§28/§61).
 */
async function evidenceCandidateWorld(): Promise<World & { candidate: FinalPlanCandidate }> {
  const world = makeWorld(undefined, CLEAN_VALIDATOR);
  const sessionID = "ses_evd";
  await admittedStart(world.controller, sessionID, GOAL);
  await world.controller.requestArchitecture(sessionID);
  const startRun = (await world.store.findActiveRunBySession(sessionID)) as PlanningRun;
  await world.store.putEvidence(startRun.id, evidence({ id: EvidenceIDs.cast("EVD-001") }));
  const decision = await world.controller.prepareProposal(sessionID, {
    type: "design_checkpoint",
    scope: { type: "architecture" },
    title: "Use direct evidence",
    summary: "s",
    changes: [
      {
        kind: "add_decision",
        content: { decision: { title: "Use direct evidence", statement: "s", rationale: "r", evidence: [{ id: "EVD-001" }] } },
      },
    ] as never,
  });
  const begun = await world.controller.beginProposalApproval(sessionID, decision.proposal.id);
  await world.controller.recordApprovalAndCommit(sessionID, decision.proposal.id, begun.request);
  const completion = await world.controller.prepareProposal(sessionID, {
    type: "architecture_completion",
    scope: { type: "architecture" },
    title: "Complete architecture",
    summary: "s",
    changes: [ARCH_CHANGE, { kind: "complete_architecture" }] as never,
  });
  const completionBegun = await world.controller.beginProposalApproval(sessionID, completion.proposal.id);
  await world.controller.recordApprovalAndCommit(sessionID, completion.proposal.id, completionBegun.request);
  const decomposition = await world.controller.prepareSectionDecomposition(sessionID, CHAIN_DECOMPOSITION);
  const dagBegun = await world.controller.beginProposalApproval(sessionID, decomposition.proposal.id);
  await world.controller.recordApprovalAndCommit(sessionID, decomposition.proposal.id, dagBegun.request);
  await checkpointAndComplete(world, sessionID, { decisions: ["DEC-001" as never] });
  await checkpointAndComplete(world, sessionID);
  await checkpointAndComplete(world, sessionID);
  await world.controller.beginSynthesis(sessionID);
  await world.controller.submitSynthesisManifest(sessionID, manifestDraft());
  await world.controller.runSemanticValidation(sessionID);
  const result = await world.controller.requestFinalization(sessionID);
  expect(result.gate.result).toBe("pass");
  return { ...world, sessionID, runID: startRun.id, candidate: result.candidate!.candidate } as World & { candidate: FinalPlanCandidate };
}

async function expectErrorCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(isUltraPlanError(error)).toBe(true);
    expect((error as { code: string }).code).toBe(code);
    return;
  }
  throw new Error(`expected error code ${code}`);
}

/** Prepare the Final Proposal and move it into awaiting_approval. */
async function prepareAndAwait(world: World, sessionID: string) {
  const prepared = await world.controller.prepareFinalPlan(sessionID);
  const begun = await world.controller.beginProposalApproval(sessionID, prepared.proposal.id);
  return { prepared, begun };
}

/** Approve + commit through the controller (the sanctioned orchestration). */
async function approveAndCommit(world: World, proposalID: Proposal["id"], request: ApprovalRequest) {
  const { approval } = await world.controller.recordApproval(world.sessionID, proposalID, request);
  const result = await world.controller.commitApprovedProposal(world.sessionID, proposalID);
  return { approval, commit: result.commit };
}

/** The committed world: full approval chain through the Final PlanCommit. */
async function committedWorld() {
  const world = await candidateWorld();
  const { prepared, begun } = await prepareAndAwait(world, world.sessionID);
  const { approval, commit } = await approveAndCommit(world, prepared.proposal.id, begun.request);
  const run = (await world.store.getRun(world.runID)) as PlanningRun;
  return { ...world, prepared, begun, approval, commit, run };
}

/** The sanctioned evidence-drift recovery loop: re-freeze → manifest → validation → candidate@2. */
async function recoverToSecondCandidate(world: World): Promise<FinalPlanCandidate> {
  await world.controller.beginSynthesis(world.sessionID);
  await world.controller.submitSynthesisManifest(world.sessionID, manifestDraft());
  await world.controller.runSemanticValidation(world.sessionID);
  const refinalized = await world.controller.requestFinalization(world.sessionID);
  expect(refinalized.gate.result).toBe("pass");
  return refinalized.candidate!.candidate;
}

// -----------------------------------------------------------------------------
// Preparation (§5-§10/§19; §89 1-8, 22, 25)
// -----------------------------------------------------------------------------

describe("final proposal preparation (§5-§10/§19)", () => {
  it("§6/§7/§4: the current candidate produces the exact final_plan Proposal (gate rerun)", async () => {
    const world = await candidateWorld();
    const prepared = await world.controller.prepareFinalPlan(world.sessionID);
    expect(prepared.proposal.type).toBe("final_plan");
    expect(prepared.proposal.status).toBe("ready");
    expect(prepared.proposal.changes).toHaveLength(1);
    expect(prepared.proposal.changes[0]?.kind).toBe("add_final_plan");
    // §3: nothing moved — no approval, no commit, no HEAD movement, no stage change.
    const run = (await world.store.getRun(world.runID)) as PlanningRun;
    expect(run.stage).toBe("synthesis");
    expect(run.lifecycle).toBe("active");
    expect(run.finalPlan).toBeUndefined();
    expect((await world.store.listFinalPlans(world.runID)).length).toBe(0);
  });

  it("§89.1: no candidate — the capability is withheld in the clean (un-finalized) substate", async () => {
    const world = await cleanWorld();
    await expectErrorCode(world.controller.prepareFinalPlan(world.sessionID), "capability_not_available");
  });

  it("§89.2/§89.3: a stale candidate (live blocking question appeared) cannot prepare", async () => {
    const world = await candidateWorld();
    await world.controller.recordQuestion(world.sessionID, {
      question: "Which repository hosts the deployment scripts?",
      blocking: true,
      scope: { type: "architecture" },
    });
    await expectErrorCode(world.controller.prepareFinalPlan(world.sessionID), "capability_not_available");
  });

  it("§89.6/§89.7/§89.8: the Harness assigns FINAL-001@1; the operation accepts no model content", async () => {
    const world = await candidateWorld();
    const prepared = await world.controller.prepareFinalPlan(world.sessionID);
    const change = prepared.proposal.changes[0] as Extract<Proposal["changes"][number], { kind: "add_final_plan" }>;
    expect(change.finalPlan.id).toBe("FINAL-001");
    expect(change.finalPlan.revision).toBe(1);
    expect(prepared.proposal.impact).toEqual({ affectedSections: [], affectedDecisions: [] });
  });

  it("§10: after the Final PlanCommit, preparation is refused deterministically (initial-only)", async () => {
    const world = await committedWorld();
    await expectErrorCode(world.controller.prepareFinalPlan(world.sessionID), "capability_not_available");
  });

  it("§19/§89.22: repeated prepare returns the SAME current ready Proposal (idempotent)", async () => {
    const world = await candidateWorld();
    const first = await world.controller.prepareFinalPlan(world.sessionID);
    const second = await world.controller.prepareFinalPlan(world.sessionID);
    expect(second.idempotent).toBe(true);
    expect(second.proposal.id).toBe(first.proposal.id);
    expect(second.hash).toBe(first.hash);
    const list = await world.store.listProposals(world.runID);
    expect(list.filter((proposal) => proposal.type === "final_plan")).toHaveLength(1);
  });

  it("§19/§54: a REJECTED Final Proposal is never resurrected; a new preparation is a NEW Proposal", async () => {
    const world = await candidateWorld();
    const first = await world.controller.prepareFinalPlan(world.sessionID);
    const begun = await world.controller.beginProposalApproval(world.sessionID, first.proposal.id);
    await world.controller.rejectProposal(world.sessionID, first.proposal.id, begun.request);
    const second = await world.controller.prepareFinalPlan(world.sessionID);
    expect(second.idempotent).toBe(false);
    expect(second.proposal.id).not.toBe(first.proposal.id);
    expect(second.proposal.status).toBe("ready");
  });

  it("§89.25: no ordinary design-proposal path exists in synthesis to smuggle into the approval flow", async () => {
    const world = await candidateWorld();
    await expectErrorCode(
      world.controller.prepareProposal(world.sessionID, {
        type: "design_checkpoint",
        scope: { type: "architecture" },
        title: "smuggle",
        summary: "s",
        changes: [{ kind: "add_decision", content: { decision: { title: "t", statement: "s", rationale: "r" } } }] as never,
      }),
      "capability_not_available",
    );
  });
});

// -----------------------------------------------------------------------------
// Payload exactness + hash mutations (§9-§18/§33; §89 9-21)
// -----------------------------------------------------------------------------

describe("final proposal payload and hash (§9-§18/§33)", () => {
  async function frozenChange(world: World & { candidate: FinalPlanCandidate }) {
    const prepared = await world.controller.prepareFinalPlan(world.sessionID);
    return { prepared, change: prepared.proposal.changes[0] as Extract<Proposal["changes"][number], { kind: "add_final_plan" }> };
  }

  it("§13/§11/§12: exact refs, exact manifest copies, structural provenance chain", async () => {
    const world = await evidenceCandidateWorld();
    const { change } = await frozenChange(world);
    expect(change.finalPlan.architecture).toEqual({ id: "ARCH", revision: 1 });
    expect(change.finalPlan.sections).toEqual([
      { id: "SEC-001", revision: 1 },
      { id: "SEC-002", revision: 1 },
      { id: "SEC-003", revision: 1 },
    ]);
    expect(change.finalPlan.decisions).toEqual([{ id: "DEC-001", revision: 1 }]);
    expect(change.finalPlan.implementationOrder).toHaveLength(1);
    expect(change.finalPlan.limitations).toHaveLength(1);
    expect(change.finalPlan.finalPlanCandidate).toEqual({
      id: world.candidate.id,
      revision: world.candidate.revision,
      hash: world.candidate.hash,
    });
    expect(change.finalPlan.semanticValidation.result).toBe("clean");
    expect(change.finalPlan.evidenceAudit.result).toBe("pass");
    expect(change.finalPlan.baseSnapshot.id).toBe(((await world.store.getRun(world.runID)) as PlanningRun).headSnapshot);
  });

  it("§9/§14/§15: body is the deterministic projection; approvedAt is commit metadata outside the frozen content", () => {
    const candidate: FinalPlanCandidate = {
      id: "FPC-001" as FinalPlanCandidate["id"],
      revision: 1,
      planID: "PLAN-001" as FinalPlanCandidate["planID"],
      baseSnapshot: { id: "SNAP-001" as FinalPlanCandidate["baseSnapshot"]["id"] },
      baseCommit: null,
      architecture: { id: "ARCH", revision: 2 },
      sections: [{ id: "SEC-001" as FinalPlanCandidate["sections"][number]["id"], revision: 3 }],
      decisions: [],
      constraints: [],
      synthesisInput: { id: "SYN-IN-001" as FinalPlanCandidate["synthesisInput"]["id"], hash: "ih" },
      synthesisManifest: { id: "SYN-001" as FinalPlanCandidate["synthesisManifest"]["id"], revision: 1, hash: "mh" },
      semanticValidation: { reportID: "VAL-001" as FinalPlanCandidate["semanticValidation"]["reportID"], hash: "vh" },
      evidenceAudit: { id: "AUD-001" as FinalPlanCandidate["evidenceAudit"]["id"], hash: "ah" },
      implementationOrder: [{ order: 1, title: "T", description: "D", sections: [], sources: [] }],
      limitations: [],
      validation: { blockingQuestions: 0, blockingConflicts: 0, invalidSections: 0, semanticValidation: "clean", evidenceAudit: "pass" },
      createdAt: FIXED,
      hash: "ch",
    };
    const content = buildFinalPlanFromCandidate({ candidate, assign: { id: FinalPlanIDs.from(1), revision: 1 } });
    expect(content.body).toBe(renderFinalPlanBody(content));
    expect(content.body).toContain("# Final Plan FINAL-001@1");
    expect(content.body).toContain("ARCH@2");
    expect(content.body).toContain("SEC-001@3");
    const record = { ...content, status: "approved" as const, approvedAt: FIXED2 };
    const hash = computeFinalPlanHashFromContent(record);
    expect(hash).toBe(computeFinalPlanHashFromContent(record));
    expect(computeFinalPlanHashFromContent({ ...record, approvedAt: FIXED })).not.toBe(hash);
  });

  it("§18/§89.18-21: mutating any authority-bearing payload field changes the Proposal hash", async () => {
    const world = await evidenceCandidateWorld();
    const { prepared, change } = await frozenChange(world);
    const original = computeProposalHash(prepared.proposal);
    const rehash = (mutate: (plan: typeof change.finalPlan) => typeof change.finalPlan): string =>
      computeProposalHash({ ...prepared.proposal, changes: [{ kind: "add_final_plan", finalPlan: mutate(structuredClone(change.finalPlan)) }] });
    // §89.18: candidate hash.
    expect(rehash((plan) => ({ ...plan, finalPlanCandidate: { ...plan.finalPlanCandidate, hash: "moved" } }))).not.toBe(original);
    // §89.19: Section revision.
    expect(rehash((plan) => ({ ...plan, sections: [{ id: "SEC-001" as FinalPlanCandidate["sections"][number]["id"], revision: 2 }, ...plan.sections.slice(1)] }))).not.toBe(original);
    // §89.20: implementation order.
    expect(rehash((plan) => ({ ...plan, implementationOrder: [{ ...plan.implementationOrder[0]!, title: "Reordered" }] }))).not.toBe(original);
    // §89.21: EvidenceAudit identity.
    expect(rehash((plan) => ({ ...plan, evidenceAudit: { ...plan.evidenceAudit, id: "AUD-002" as FinalPlanCandidate["evidenceAudit"]["id"] } }))).not.toBe(original);
    // §17: base snapshot + FinalPlan identity are bound too.
    expect(rehash((plan) => ({ ...plan, baseSnapshot: { id: "SNAP-999" as FinalPlanCandidate["baseSnapshot"]["id"] } }))).not.toBe(original);
    expect(rehash((plan) => ({ ...plan, id: "FINAL-002" as FinalPlan["id"] }))).not.toBe(original);
  });
});

// -----------------------------------------------------------------------------
// Approval boundary (§20-§24/§57/§83; §89 23-31)
// -----------------------------------------------------------------------------

describe("formal approval boundary (§20-§24/§57)", () => {
  it("§24/§89.29/§89.30: allow persists the immutable Approval; the Proposal STAYS awaiting_approval", async () => {
    const world = await candidateWorld();
    const { prepared, begun } = await prepareAndAwait(world, world.sessionID);
    const { approval, proposal } = await world.controller.recordApproval(world.sessionID, prepared.proposal.id, begun.request);
    expect(approval.proposalHash).toBe(prepared.hash);
    expect(proposal.status).toBe("awaiting_approval");
    const run = (await world.store.getRun(world.runID)) as PlanningRun;
    expect(run.stage).toBe("synthesis");
    expect(run.finalPlan).toBeUndefined();
    expect((await world.store.listFinalPlans(world.runID)).length).toBe(0);
  });

  it("§23/§54/§83/§89.26-28: denial rejects the Proposal — stage synthesis, lifecycle active, no FinalPlan, candidate preserved", async () => {
    const world = await candidateWorld();
    const { prepared, begun } = await prepareAndAwait(world, world.sessionID);
    const rejected = await world.controller.rejectProposal(world.sessionID, prepared.proposal.id, begun.request);
    expect(rejected.status).toBe("rejected");
    const run = (await world.store.getRun(world.runID)) as PlanningRun;
    expect(run.stage).toBe("synthesis");
    expect(run.lifecycle).toBe("active");
    expect(run.finalPlan).toBeUndefined();
    expect((await world.store.listFinalPlans(world.runID)).length).toBe(0);
    // §83: no Approval authorization was created for the final Proposal.
    expect(await world.store.findApprovalForProposal(world.runID, prepared.proposal.id)).toBeUndefined();
    const again = await world.controller.prepareFinalPlan(world.sessionID);
    expect(again.idempotent).toBe(false);
    expect(again.proposal.status).toBe("ready");
  });

  it("§57/§89.23: a stale Final Proposal is refused BEFORE any user ask (final_proposal_stale)", async () => {
    const world = await evidenceCandidateWorld();
    const prepared = await world.controller.prepareFinalPlan(world.sessionID);
    await world.store.putEvidence(world.runID, evidence({ id: EvidenceIDs.cast("EVD-001"), revision: 2 }));
    const second = await recoverToSecondCandidate(world);
    expect(second.revision).toBe(2);
    await expectErrorCode(
      world.controller.beginProposalApproval(world.sessionID, prepared.proposal.id),
      "final_proposal_stale",
    );
  });

  it("§20/§82: the approved-but-drifted Final Proposal cannot commit (engine re-verifies, finalization_stale)", async () => {
    const world = await evidenceCandidateWorld();
    const { prepared, begun } = await prepareAndAwait(world, world.sessionID);
    await world.controller.recordApproval(world.sessionID, prepared.proposal.id, begun.request);
    await world.store.putEvidence(world.runID, evidence({ id: EvidenceIDs.cast("EVD-001"), revision: 2 }));
    await expectErrorCode(
      world.controller.commitApprovedProposal(world.sessionID, prepared.proposal.id),
      "finalization_stale",
    );
    const run = (await world.store.getRun(world.runID)) as PlanningRun;
    expect(run.stage).toBe("synthesis");
    expect(run.finalPlan).toBeUndefined();
  });
});

// -----------------------------------------------------------------------------
// Mandatory second gate + post-approval drift (§25-§31; §89 31-39)
// -----------------------------------------------------------------------------

describe("mandatory post-approval FinalizationGate (§25-§31)", () => {
  it("§28/§61/§89.32: evidence drift after Approval — DIRECT engine commit refused finalization_stale, zero state change", async () => {
    const world = await evidenceCandidateWorld();
    const { prepared, begun } = await prepareAndAwait(world, world.sessionID);
    const { approval } = await world.controller.recordApproval(world.sessionID, prepared.proposal.id, begun.request);
    const headBefore = ((await world.store.getRun(world.runID)) as PlanningRun).headCommit ?? null;
    await world.store.putEvidence(world.runID, evidence({ id: EvidenceIDs.cast("EVD-001"), revision: 2 }));
    await expectErrorCode(
      world.store.commitTransaction({ planID: world.runID, proposalID: prepared.proposal.id, approvalID: approval.id }),
      "finalization_stale",
    );
    const run = (await world.store.getRun(world.runID)) as PlanningRun;
    expect(run.stage).toBe("synthesis");
    expect(run.lifecycle).toBe("active");
    expect(run.finalPlan).toBeUndefined();
    expect(run.headCommit ?? null).toBe(headBefore);
    expect((await world.store.listFinalPlans(world.runID)).length).toBe(0);
    expect(await world.store.findApprovalForProposal(world.runID, prepared.proposal.id)).toBeDefined();
    expect((await world.store.getProposal(world.runID, prepared.proposal.id))?.status).toBe("awaiting_approval");
  });

  it("§29/§62/§89.33: a blocking Question after Approval → finalization_blocked, no commit", async () => {
    const world = await evidenceCandidateWorld();
    const { prepared, begun } = await prepareAndAwait(world, world.sessionID);
    const { approval } = await world.controller.recordApproval(world.sessionID, prepared.proposal.id, begun.request);
    await world.controller.recordQuestion(world.sessionID, {
      question: "New blocking question after approval?",
      blocking: true,
      scope: { type: "architecture" },
    });
    await expectErrorCode(
      world.store.commitTransaction({ planID: world.runID, proposalID: prepared.proposal.id, approvalID: approval.id }),
      "finalization_blocked",
    );
    expect(((await world.store.getRun(world.runID)) as PlanningRun).finalPlan).toBeUndefined();
  });

  it("§29/§62/§89.34: a blocking Conflict after Approval → finalization_blocked, no commit", async () => {
    const world = await evidenceCandidateWorld();
    const { prepared, begun } = await prepareAndAwait(world, world.sessionID);
    const { approval } = await world.controller.recordApproval(world.sessionID, prepared.proposal.id, begun.request);
    await world.controller.raiseConflict(world.sessionID, {
      type: "decision",
      refs: [],
      description: "Blocking conflict after approval",
      severity: "blocking",
    });
    await expectErrorCode(
      world.store.commitTransaction({ planID: world.runID, proposalID: prepared.proposal.id, approvalID: approval.id }),
      "finalization_blocked",
    );
  });

  it("§30/§63/§89.35: manifest revision drift after Approval → finalization_stale", async () => {
    const world = await evidenceCandidateWorld();
    const { prepared, begun } = await prepareAndAwait(world, world.sessionID);
    const { approval } = await world.controller.recordApproval(world.sessionID, prepared.proposal.id, begun.request);
    // A genuinely revised manifest (exact resubmission would replay @1).
    const input = (await world.store.getLatestSynthesisInput(world.runID))!;
    const draft = manifestDraft();
    await world.store.saveSynthesisManifest(world.runID, {
      inputID: input.id,
      crossSectionLinks: draft.crossSectionLinks as never,
      implementationOrder: draft.implementationOrder as never,
      limitations: [
        ...draft.limitations,
        { statement: "Post-approval limitation revision.", sources: [{ kind: "architecture" }] },
      ] as never,
      unresolvedFindings: [],
    });
    await expectErrorCode(
      world.store.commitTransaction({ planID: world.runID, proposalID: prepared.proposal.id, approvalID: approval.id }),
      "finalization_stale",
    );
  });

  it("§30/§31/§64/§65/§89.36-38: a NEW current candidate makes the old Proposal final_proposal_stale — a different passing identity never authorizes it", async () => {
    const world = await evidenceCandidateWorld();
    const { prepared, begun } = await prepareAndAwait(world, world.sessionID);
    const { approval } = await world.controller.recordApproval(world.sessionID, prepared.proposal.id, begun.request);
    await world.store.putEvidence(world.runID, evidence({ id: EvidenceIDs.cast("EVD-001"), revision: 2 }));
    const second = await recoverToSecondCandidate(world);
    expect(second.revision).toBe(2);
    await expectErrorCode(
      world.store.commitTransaction({ planID: world.runID, proposalID: prepared.proposal.id, approvalID: approval.id }),
      "final_proposal_stale",
    );
    // §56: the old Approval is NOT mutated — its historical statement stays true.
    const oldApproval = await world.store.findApprovalForProposal(world.runID, prepared.proposal.id);
    expect(oldApproval?.id).toBe(approval.id);
  });

  it("§33/§76/§89.40: a hostile DIRECT transaction with a tampered payload is rejected (exact candidate projection)", async () => {
    const world = await evidenceCandidateWorld();
    const prepared = await world.controller.prepareFinalPlan(world.sessionID);
    const change = prepared.proposal.changes[0] as Extract<Proposal["changes"][number], { kind: "add_final_plan" }>;
    // Tamper the payload while keeping the candidate ref; mark it awaiting,
    // RESEAL the proposal hash, and bind a fresh Approval — every hostile-direct
    // precondition is satisfied, so only the §33 projection check can refuse.
    const hostileBase: Proposal = {
      ...prepared.proposal,
      id: "PROP-900" as Proposal["id"],
      status: "awaiting_approval",
      changes: [
        {
          kind: "add_final_plan",
          finalPlan: {
            ...change.finalPlan,
            implementationOrder: [{ ...change.finalPlan.implementationOrder[0]!, title: "Malicious reorder" }],
          },
        },
      ],
    };
    const hostile: Proposal = { ...hostileBase, hash: computeProposalHash(hostileBase) };
    await world.store.saveProposal(world.runID, hostile);
    const hostileApproval = await world.store.saveApproval(world.runID, {
      id: "APPR-900" as never,
      proposalID: hostile.id,
      proposalRevision: hostile.revision,
      proposalHash: computeProposalHash(hostile),
      actor: "user",
      createdAt: FIXED,
    });
    await expectErrorCode(
      world.store.commitTransaction({ planID: world.runID, proposalID: hostile.id, approvalID: hostileApproval.id }),
      "final_proposal_stale",
    );
    expect((await world.store.listFinalPlans(world.runID)).length).toBe(0);
  });
});

// -----------------------------------------------------------------------------
// Final PlanCommit effects (§34-§44; §89 41-52)
// -----------------------------------------------------------------------------

describe("Final PlanCommit effects (§34-§44)", () => {
  it("§81/§89.41-51: the primary integration — one atomic commit publishes everything", async () => {
    const world = await candidateWorld();
    const headBefore = ((await world.store.getRun(world.runID)) as PlanningRun).headCommit ?? null;
    const { prepared, begun } = await prepareAndAwait(world, world.sessionID);
    const runAfterPrepare = (await world.store.getRun(world.runID)) as PlanningRun;
    expect(runAfterPrepare.stage).toBe("synthesis");
    expect(runAfterPrepare.lifecycle).toBe("active");
    const { approval, commit } = await approveAndCommit(world, prepared.proposal.id, begun.request);
    const run = (await world.store.getRun(world.runID)) as PlanningRun;
    const plans = await world.store.listFinalPlans(world.runID);
    expect(plans).toHaveLength(1);
    const plan = plans[0]!;
    expect(run.finalPlan).toEqual({ id: plan.id, revision: plan.revision });
    expect(run.stage).toBe("final");
    expect(run.lifecycle).toBe("handoff_pending");
    expect(plan.status).toBe("approved");
    expect(plan.approvedAt).toBe(approval.createdAt);
    expect(commit.changes).toEqual([
      { kind: "add_final_plan", ref: { kind: "final_plan", id: plan.id, revision: plan.revision }, resultingRevision: plan.revision },
    ]);
    expect(commit.proposalID).toBe(prepared.proposal.id);
    expect(commit.approvalID).toBe(approval.id);
    const snapshot = (await world.store.getHeadSnapshot(world.runID))!;
    expect(snapshot.id).toBe(commit.resultingSnapshot);
    expect(snapshot.state.finalPlanRevision).toBe(plan.revision);
    expect((await world.store.getProposal(world.runID, prepared.proposal.id))?.status).toBe("approved");
    expect(run.headCommit).toBe(commit.id);
    expect(run.headCommit).not.toBe(headBefore);
    expect(commit.parentCommit).toBe(headBefore);
    expect(run.lifecycle).not.toBe("completed");
  });

  it("§40/§89.47 pin: approvedAt equals the stored Approval's createdAt exactly", async () => {
    const world = await committedWorld();
    const plan = (await world.store.listFinalPlans(world.runID))[0]!;
    expect(plan.approvedAt).toBe(world.approval.createdAt);
  });

  it("§59/§89.52: exact retry of the committed transaction returns the SAME commit (idempotent)", async () => {
    const world = await committedWorld();
    const retry = await world.store.commitTransaction({
      planID: world.runID,
      proposalID: world.prepared.proposal.id,
      approvalID: world.approval.id,
    });
    expect(retry.id).toBe(world.commit.id);
    expect((await world.store.listFinalPlans(world.runID)).length).toBe(1);
  });

  it("§60/§89.53: a competing Final Proposal loses stale — exactly one FinalPlan ever exists", async () => {
    const world = await evidenceCandidateWorld();
    const first = await world.controller.prepareFinalPlan(world.sessionID);
    const firstBegun = await world.controller.beginProposalApproval(world.sessionID, first.proposal.id);
    const { approval: firstApproval } = await world.controller.recordApproval(world.sessionID, first.proposal.id, firstBegun.request);
    await world.store.putEvidence(world.runID, evidence({ id: EvidenceIDs.cast("EVD-001"), revision: 2 }));
    await recoverToSecondCandidate(world);
    const second = await world.controller.prepareFinalPlan(world.sessionID);
    expect(second.proposal.id).not.toBe(first.proposal.id);
    const secondBegun = await world.controller.beginProposalApproval(world.sessionID, second.proposal.id);
    const { approval: secondApproval } = await world.controller.recordApproval(world.sessionID, second.proposal.id, secondBegun.request);
    // The stale first proposal cannot commit — the gate PASSES for the NEW
    // identity, so the §27 exactness rule classifies it final_proposal_stale.
    await expectErrorCode(
      world.store.commitTransaction({ planID: world.runID, proposalID: first.proposal.id, approvalID: firstApproval.id }),
      "final_proposal_stale",
    );
    // …the second commits, and an exact retry is the idempotent §59 replay
    // (same commit, still exactly one FinalPlan — never a duplicate).
    const committed = await world.controller.commitApprovedProposal(world.sessionID, second.proposal.id);
    const replay = await world.store.commitTransaction({ planID: world.runID, proposalID: second.proposal.id, approvalID: secondApproval.id });
    expect(replay.id).toBe(committed.commit.id);
    expect((await world.store.listFinalPlans(world.runID)).length).toBe(1);
    await expectErrorCode(
      world.store.commitTransaction({ planID: world.runID, proposalID: first.proposal.id, approvalID: firstApproval.id }),
      "run_not_active",
    );
  });

  it("§66/§67/§89.55: publication fault after staging yields ZERO partial FinalPlan state; the exact retry commits", async () => {
    const world = await candidateWorld();
    const { prepared, begun } = await prepareAndAwait(world, world.sessionID);
    const { approval } = await world.controller.recordApproval(world.sessionID, prepared.proposal.id, begun.request);
    const headBefore = ((await world.store.getRun(world.runID)) as PlanningRun).headCommit ?? null;
    const store = world.store as InMemoryPlanStore & { publishTransaction: () => unknown };
    const original = store.publishTransaction.bind(store);
    store.publishTransaction = () => {
      throw new Error("injected publication failure");
    };
    try {
      await world.store.commitTransaction({ planID: world.runID, proposalID: prepared.proposal.id, approvalID: approval.id });
      throw new Error("expected the commit to fail");
    } catch (error) {
      expect((error as Error).message).toContain("injected publication failure");
    } finally {
      store.publishTransaction = original;
    }
    const run = (await world.store.getRun(world.runID)) as PlanningRun;
    expect(run.stage).toBe("synthesis");
    expect(run.lifecycle).toBe("active");
    expect(run.finalPlan).toBeUndefined();
    expect(run.headCommit ?? null).toBe(headBefore);
    expect((await world.store.listFinalPlans(world.runID)).length).toBe(0);
    expect((await world.store.getProposal(world.runID, prepared.proposal.id))?.status).toBe("awaiting_approval");
    expect(await world.store.findApprovalForProposal(world.runID, prepared.proposal.id)).toBeDefined();
    const retry = await world.controller.commitApprovedProposal(world.sessionID, prepared.proposal.id);
    expect(((await world.store.getRun(world.runID)) as PlanningRun).stage).toBe("final");
    expect(retry.commit.changes[0]?.kind).toBe("add_final_plan");
  });
});

// -----------------------------------------------------------------------------
// Handoff-pending boundary + no Build side effects (§37/§38/§52/§79/§80)
// -----------------------------------------------------------------------------

describe("handoff_pending boundary (§37/§38/§52/§79/§80)", () => {
  it("§79: after the commit, NO planning mutation capability remains (reads only)", async () => {
    const world = await committedWorld();
    const run = (await world.store.getRun(world.runID)) as PlanningRun;
    const capabilities = getCapabilities(run);
    for (const capability of [
      "prepare_final_plan",
      "request_finalization",
      "request_user_approval",
      "prepare_proposal",
      "prepare_section_checkpoint",
      "submit_synthesis_manifest",
      "begin_synthesis",
      "request_synthesis",
      "request_completion",
      "request_reopen",
    ] as const) {
      expect(capabilities.has(capability), capability).toBe(false);
    }
    expect(capabilities.has("read_status")).toBe(true);
    expect(capabilities.has("read_memory")).toBe(true);
  });

  it("§80/§89.62-64: no runtime switch, no ExecutionHandoff, lifecycle never completed", async () => {
    const world = await candidateWorld();
    const headMovesBefore = (await world.store.listEvents(world.runID)).filter((event) => event.detail.type === "head.moved").length;
    const { prepared, begun } = await prepareAndAwait(world, world.sessionID);
    await approveAndCommit(world, prepared.proposal.id, begun.request);
    const run = (await world.store.getRun(world.runID)) as PlanningRun;
    expect(run.lifecycle).toBe("handoff_pending");
    expect(run.activeWork).toBeUndefined();
    const events = await world.store.listEvents(world.runID);
    for (const event of events) {
      expect(event.detail.type).not.toBe("runtime.activated");
    }
    expect(events.some((event) => event.detail.type === "run.lifecycle_changed")).toBe(true);
    // The Final PlanCommit moved HEAD exactly once more than the drive commits.
    expect(events.filter((event) => event.detail.type === "head.moved")).toHaveLength(headMovesBefore + 1);
  });

  it("§89.78: request_synthesis stays dead after the commit too", async () => {
    const world = await committedWorld();
    await expectErrorCode(world.controller.requestSynthesis(world.sessionID), "capability_not_available");
  });
});

// -----------------------------------------------------------------------------
// Reads (§47; §89 65-66)
// -----------------------------------------------------------------------------

describe("FinalPlan reads (§47)", () => {
  it("§89.65: plan_memory kind=final_plan resolves the exact committed record", async () => {
    const world = await committedWorld();
    const read = await world.controller.readMemoryForRun((await world.store.getRun(world.runID)) as PlanningRun, {
      ref: { kind: "final_plan", id: "FINAL-001" },
    });
    const plan = read.artifacts[0]?.artifact as FinalPlan;
    expect(plan.id).toBe("FINAL-001");
    expect(plan.revision).toBe(1);
    expect(plan.status).toBe("approved");
  });

  it("§89.66: historical exact reads stay exact — a missing revision is an error, never latest", async () => {
    const world = await committedWorld();
    const run = (await world.store.getRun(world.runID)) as PlanningRun;
    const exact = await world.controller.readMemoryForRun(run, { ref: { kind: "final_plan", id: "FINAL-001", revision: 1 } });
    expect((exact.artifacts[0]?.artifact as FinalPlan).revision).toBe(1);
    await expectErrorCode(
      world.controller.readMemoryForRun(run, { ref: { kind: "final_plan", id: "FINAL-001", revision: 2 } }),
      "unknown_reference",
    );
  });
});

// -----------------------------------------------------------------------------
// Approval view + status rendering (§45/§46/§75/§85; §89 71-76)
// -----------------------------------------------------------------------------

describe("approval view and status (§45/§46/§75/§85)", () => {
  it("§75/§89.71/§89.72: the final approval view is a deterministic projection — Build NOT started", async () => {
    const world = await candidateWorld();
    const prepared = await world.controller.prepareFinalPlan(world.sessionID);
    const view = renderProposalForApproval(prepared.proposal);
    expect(view).toContain("FINAL PLAN APPROVAL");
    expect(view).toContain("Final Plan: FINAL-001@1");
    expect(view).toContain(`Base: ${prepared.proposal.createdFrom.id}`);
    expect(view).toContain("Architecture: ARCH@1");
    expect(view).toContain("SEC-001@1");
    expect(view).toContain("Implementation Order:");
    expect(view).toContain("Known Limitations:");
    expect(view).toMatch(/Semantic Validation: VAL-\d+ clean/);
    expect(view).toMatch(/Evidence Audit: AUD-\d+ pass/);
    expect(view).toContain(`Final Candidate: ${world.candidate.id}@${world.candidate.revision} hash ${world.candidate.hash}`);
    expect(view).toContain("stage -> final");
    expect(view).toContain("lifecycle -> handoff_pending");
    expect(view).toContain("Build handoff will NOT run in this phase");
    expect(view).toContain("Approval authorizes the Final PlanCommit.");
    expect(view).toContain("Runtime Build handoff occurs only from handoff_pending in the next workflow.");
    expect(view).toContain(`Approval hash: ${prepared.hash}`);
    expect(renderProposalForApproval(prepared.proposal)).toBe(view);
  });

  it("§85/§89.73-76: status renders candidate → proposal ready → awaiting → handoff_pending", async () => {
    const world = await candidateWorld();
    const candidateStatus = (await world.controller.statusReport(world.sessionID)).statusText;
    expect(candidateStatus).toContain("Final candidate: FPC-001@1 current");
    expect(candidateStatus).toContain("Final proposal: none");
    expect(candidateStatus).toContain("Final approval: not requested");
    expect(candidateStatus).toContain("Stage: synthesis");

    const prepared = await world.controller.prepareFinalPlan(world.sessionID);
    const readyStatus = (await world.controller.statusReport(world.sessionID)).statusText;
    expect(readyStatus).toContain(`Final proposal: ${prepared.proposal.id}`);
    expect(readyStatus).toContain("Final approval: ready");

    const begun = await world.controller.beginProposalApproval(world.sessionID, prepared.proposal.id);
    await world.controller.recordApproval(world.sessionID, prepared.proposal.id, begun.request);
    const awaitingStatus = (await world.controller.statusReport(world.sessionID)).statusText;
    expect(awaitingStatus).toContain("Final approval: awaiting user");
    expect(awaitingStatus).toContain("Stage: synthesis");

    await world.controller.commitApprovedProposal(world.sessionID, prepared.proposal.id);
    const finalStatus = (await world.controller.statusReport(world.sessionID)).statusText;
    expect(finalStatus).toContain("Stage: final");
    expect(finalStatus).toContain("Lifecycle: handoff_pending");
    expect(finalStatus).toContain("Final Plan: FINAL-001@1 approved");
    // Phase 2J §66: the not-prepared handoff state lines (supersede the 2I
    // "Build handoff: pending" line).
    expect(finalStatus).toContain("Execution handoff: not prepared");
    expect(finalStatus).toContain("Build: not started");
    expect(finalStatus).not.toContain("Build started");
    expect(finalStatus).not.toContain("Run completed");
  });

  it("§86: handoff_pending L0 guidance closes planning mutation honestly", () => {
    const text = renderPlanningProtocol({
      run: {
        id: "PLAN-001" as never,
        sessionID: "s",
        lifecycle: "handoff_pending",
        stage: "final",
        revision: 9,
        goal: { statement: "g" },
        constraints: [],
        sections: [],
        decisions: [],
        openQuestions: [],
        conflicts: [],
        createdAt: FIXED,
        updatedAt: FIXED,
      },
    });
    // Phase 2J §71 wording (supersedes the 2I fragment).
    expect(text).toContain("The Final Plan is approved and committed.");
    expect(text).toContain("The run is handoff_pending.");
    expect(text).toContain("Do not modify planning state.");
    expect(text).toContain("The Harness is recovering/completing the runtime Build handoff.");
    expect(text).not.toContain("Build started");
  });
});

// -----------------------------------------------------------------------------
// Durable restart + corruption (§69-§74; §89 59-60, 67-70)
// -----------------------------------------------------------------------------

describe("durable FinalPlan state (§69-§74)", () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "ultra-plan-2i-"));
    filePath = path.join(dir, "plan.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Drive the full approval chain to a committed FinalPlan in a durable store. */
  async function driveDurableCommit(): Promise<DurablePlanStore> {
    const store = new DurablePlanStore(filePath, { now: () => FIXED });
    const controller = new UltraPlanController({ store, now: () => FIXED, semanticValidator: CLEAN_VALIDATOR });
    const sessionID = "ses_dur";
    await dagWorld({ store, controller }, sessionID);
    await checkpointAndComplete({ store, controller }, sessionID);
    await checkpointAndComplete({ store, controller }, sessionID);
    await checkpointAndComplete({ store, controller }, sessionID);
    await controller.beginSynthesis(sessionID);
    await controller.submitSynthesisManifest(sessionID, manifestDraft());
    await controller.runSemanticValidation(sessionID);
    const result = await controller.requestFinalization(sessionID);
    expect(result.gate.result).toBe("pass");
    const prepared = await controller.prepareFinalPlan(sessionID);
    const begun = await controller.beginProposalApproval(sessionID, prepared.proposal.id);
    await controller.recordApproval(sessionID, prepared.proposal.id, begun.request);
    await controller.commitApprovedProposal(sessionID, prepared.proposal.id);
    return store;
  }

  it("§69/§81/§89.59/§89.60: restart from handoff_pending recovers the exact state; the session resumes the SAME run", async () => {
    const store = await driveDurableCommit();
    const before = await readFile(filePath, "utf8");
    const reopened = new DurablePlanStore(filePath, { now: () => FIXED });
    reopened.open();
    // Byte-identical durable state after reopen (no rewrite on open).
    expect(await readFile(filePath, "utf8")).toBe(before);
    const run = (await reopened.getRun("PLAN-001" as never))!;
    expect(run.stage).toBe("final");
    expect(run.lifecycle).toBe("handoff_pending");
    expect(run.finalPlan).toEqual({ id: FinalPlanIDs.from(1), revision: 1 });
    const plans = await reopened.listFinalPlans("PLAN-001" as never);
    expect(plans).toHaveLength(1);
    expect(plans[0]!.status).toBe("approved");
    expect(plans[0]!.hash).toBe(computeFinalPlanHashFromContent(plans[0]!));
    expect(plans[0]!.body).toBe(renderFinalPlanBody(plans[0]!));
    const resumed = await reopened.findActiveRunBySession("ses_dur");
    expect(resumed?.id).toBe(run.id);
    reopened.close();
    store.close();
  });

  it("§73/§76/§89.67: a tampered payload (body + hash resealed) still fails on the candidate-projection check", async () => {
    await driveDurableCommit();
    const raw = JSON.parse(await readFile(filePath, "utf8")) as Record<string, Record<string, Record<string, Record<string, unknown>>>>;
    const family = raw["finalPlans"]!["PLAN-001"]!;
    const key = Object.keys(family)[0]!;
    const plan = family[key] as Record<string, unknown>;
    const order = plan["implementationOrder"] as { title: string }[];
    order[0]!.title = "Tampered order";
    // Sophisticated tampering: re-derive the deterministic body AND reseal the
    // hash, so ONLY the candidate-projection check can catch the mutation.
    plan["body"] = renderFinalPlanBody(plan as never);
    delete plan["hash"];
    plan["hash"] = computeFinalPlanHashFromContent(plan as never);
    await writeFile(filePath, JSON.stringify(raw));
    expect(() => new DurablePlanStore(filePath, { now: () => FIXED }).open()).toThrowError(/implementationOrder differs from its bound candidate/);
  });

  it("§73/§14: a tampered body (projection divergence, hash resealed) fails store open", async () => {
    await driveDurableCommit();
    const raw = JSON.parse(await readFile(filePath, "utf8")) as Record<string, Record<string, Record<string, Record<string, unknown>>>>;
    const family = raw["finalPlans"]!["PLAN-001"]!;
    const key = Object.keys(family)[0]!;
    const plan = family[key] as Record<string, unknown>;
    plan["body"] = "hand-edited body";
    delete plan["hash"];
    plan["hash"] = computeFinalPlanHashFromContent(plan as never);
    await writeFile(filePath, JSON.stringify(raw));
    expect(() => new DurablePlanStore(filePath, { now: () => FIXED }).open()).toThrowError(/body differs/);
  });

  it("§58/§59: two store instances converge on ONE Final Proposal and ONE final commit", async () => {
    // Instance A drives to a committed FinalPlan.
    const storeA = await driveDurableCommit();
    const committed = await storeA.listFinalPlans("PLAN-001" as never);
    // Instance B opens the same durable file independently.
    const storeB = new DurablePlanStore(filePath, { now: () => FIXED2 });
    storeB.open();
    // §52: handoff_pending exposes no preparation surface — B sees the run as
    // read-only and re-preparing through a controller on B is refused.
    const controllerB = new UltraPlanController({ store: storeB, now: () => FIXED2, semanticValidator: CLEAN_VALIDATOR });
    await expectErrorCode(controllerB.prepareFinalPlan("ses_dur"), "capability_not_available");
    // §59: the EXACT same transaction replayed by B returns A's commit — one
    // Final PlanCommit, one FinalPlan, one HEAD move across instances.
    const commitA = [...(await storeB.listCommits("PLAN-001" as never))].at(-1)!;
    const approvalA = await storeB.findApprovalForProposal("PLAN-001" as never, commitA.proposalID);
    const replay = await storeB.commitTransaction({
      planID: "PLAN-001" as never,
      proposalID: commitA.proposalID,
      approvalID: approvalA!.id,
    });
    expect(replay.id).toBe(commitA.id);
    expect(await storeB.listFinalPlans("PLAN-001" as never)).toEqual(committed);
    storeB.close();
  });

  it("§73: a plainly tampered payload (hash NOT resealed) fails the hash recompute", async () => {
    await driveDurableCommit();
    const raw = JSON.parse(await readFile(filePath, "utf8")) as Record<string, Record<string, Record<string, Record<string, unknown>>>>;
    const family = raw["finalPlans"]!["PLAN-001"]!;
    const key = Object.keys(family)[0]!;
    (family[key] as Record<string, unknown>)["approvedAt"] = FIXED2;
    await writeFile(filePath, JSON.stringify(raw));
    expect(() => new DurablePlanStore(filePath, { now: () => FIXED }).open()).toThrowError(/does not recompute to its frozen hash/);
  });

  it("§73: a FinalPlan binding a BLOCKED audit result fails open", async () => {
    await driveDurableCommit();
    const raw = JSON.parse(await readFile(filePath, "utf8")) as Record<string, Record<string, Record<string, Record<string, unknown>>>>;
    const family = raw["finalPlans"]!["PLAN-001"]!;
    const key = Object.keys(family)[0]!;
    const plan = family[key] as Record<string, unknown>;
    (plan["evidenceAudit"] as Record<string, unknown>)["result"] = "blocked";
    await writeFile(filePath, JSON.stringify(raw));
    expect(() => new DurablePlanStore(filePath, { now: () => FIXED }).open()).toThrowError(/missing\/blocked evidence audit|does not recompute/);
  });

  it("§71/§74/§89.68/§89.69: a run.finalPlan pointer to a missing FinalPlan fails closed", async () => {
    await driveDurableCommit();
    const raw = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
    delete (raw["finalPlans"] as Record<string, unknown>)["PLAN-001"];
    await writeFile(filePath, JSON.stringify(raw));
    expect(() => new DurablePlanStore(filePath, { now: () => FIXED }).open()).toThrowError(/finalPlan references missing FinalPlan/);
  });

  it("§72/§74: handoff_pending whose HEAD commit is not the approved final transaction fails closed", async () => {
    await driveDurableCommit();
    const raw = JSON.parse(await readFile(filePath, "utf8")) as Record<string, Record<string, Record<string, unknown>>>;
    const commits = Object.keys(raw["commits"]!["PLAN-001"]!).sort();
    raw["runs"]!["PLAN-001"]!["headCommit"] = commits[0];
    await writeFile(filePath, JSON.stringify(raw));
    expect(() => new DurablePlanStore(filePath, { now: () => FIXED }).open()).toThrowError(/HEAD commit is not an approved final_plan transaction|does not carry the committed finalPlan ref/);
  });

  it("§74: an approved final_plan proposal without its commit fails closed", async () => {
    await driveDurableCommit();
    const raw = JSON.parse(await readFile(filePath, "utf8")) as Record<string, Record<string, string>>;
    delete raw["commitByProposal"]!["PLAN-001:PROP-009"];
    await writeFile(filePath, JSON.stringify(raw));
    expect(() => new DurablePlanStore(filePath, { now: () => FIXED }).open()).toThrowError(/no corresponding final commit/);
  });
});
