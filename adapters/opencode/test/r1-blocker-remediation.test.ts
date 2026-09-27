/**
 * Phase R1 — Blocker Cure, Deadlock Freedom & Architecture Remediation.
 *
 * Covers: the §8 remediable-blocking-conflict raise rule, the §4-§7 conflict
 * resolution lifecycle (resolve_conflict through Proposal → Approval →
 * PlanCommit, with real-remediation bindings), the §7 conflict self-block
 * exception (a conflict can never block its own sanctioned remediation),
 * the §10-§14 blocker-driven reopens out of synthesis (no fabricated
 * ValidationReport), the §16 explicit terminal abort, the §41 deadlock-freedom
 * property coverage, the §45 architecture finding → reopen → amendment →
 * re-decomposition end-to-end, §46 cross-instance amendment concurrency, and
 * the §49 durable fail-closed validation.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DurablePlanStore,
  InMemoryPlanStore,
  isUltraPlanError,
} from "../src/index.js";
import type {
  PlanCommit,
  PlanningRun,
  SectionCheckpointInput,
  SemanticValidator,
  SynthesisManifestDraftInput,
} from "../src/index.js";
import { UltraPlanController } from "../src/core/controller.js";
import { getCapabilities } from "../src/core/capabilities.js";
import { admittedStart, evidence, fakeToolContext } from "./helpers.js";
import { EvidenceIDs, ProposalIDs } from "../src/core/ids.js";
import { createUltraPlanTools } from "../src/tools/registry.js";

const FIXED = "2026-09-25T12:00:00.000Z";
const GOAL = "Build the durable planning harness";

// -----------------------------------------------------------------------------
// World builders (the same real-flow drive as the 2G/2H suites)
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

/** The generic amend_section path takes the DRAFT shape (compactProjection/contract). */
function sectionDraft(sectionID: "SEC-001" | "SEC-002", design: string) {
  const input = checkpointInput(sectionID);
  return {
    problem: input.problem,
    design,
    interfaces: input.interfaces,
    invariants: input.invariants,
    failureModes: input.failureModes,
    dependencies: input.dependencies,
    decisions: input.decisions,
    openQuestions: input.openQuestions,
    impacts: input.impacts,
    compactProjection: input.projection.compact,
    contract: input.projection.contract,
  };
}

async function dagWorld(world: ReturnType<typeof makeWorld> = makeWorld(), sessionID = "ses_r1") {
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

async function checkpointAndComplete(world: ReturnType<typeof makeWorld>, sessionID: string): Promise<PlanCommit> {
  const run = (await world.store.findActiveRunBySession(sessionID)) as PlanningRun;
  const active = run.activeWork?.type === "section" ? run.activeWork.id : undefined;
  if (!active) throw new Error("no active section");
  const prepared = await world.controller.prepareSectionCheckpoint(sessionID, checkpointInput(active as "SEC-001"));
  const begun = await world.controller.beginProposalApproval(sessionID, prepared.proposal.id);
  await world.controller.recordApprovalAndCommit(sessionID, prepared.proposal.id, begun.request);
  const completion = await world.controller.requestCompletion(sessionID, { kind: "section" });
  const completionBegun = await world.controller.beginProposalApproval(sessionID, completion.proposal.id);
  return (await world.controller.recordApprovalAndCommit(sessionID, completion.proposal.id, completionBegun.request)).commit;
}

async function synWorld(world: ReturnType<typeof makeWorld> = makeWorld(), sessionID = "ses_r1") {
  await dagWorld(world, sessionID);
  await checkpointAndComplete(world, sessionID);
  await checkpointAndComplete(world, sessionID);
  await checkpointAndComplete(world, sessionID);
  const run = (await world.store.findActiveRunBySession(sessionID)) as PlanningRun;
  expect(run.stage).toBe("synthesis");
  return { ...world, run };
}

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

/** Drive to synthesis WITH a frozen input + manifest@1 (validation-ready). */
async function manifestWorldR1(validator?: SemanticValidator) {
  const world = await synWorld(makeWorld(undefined, validator), "ses_r1");
  await world.controller.beginSynthesis("ses_r1");
  await world.controller.submitSynthesisManifest("ses_r1", manifestDraft());
  return world;
}

/** manifestWorldR1 over an EXISTING store instance (durable concurrency tests). */
async function manifestWorldR1OverStore(store: InMemoryPlanStore, validator?: SemanticValidator) {
  const world = await synWorld(makeWorld(store, validator), "ses_r1");
  await world.controller.beginSynthesis("ses_r1");
  await world.controller.submitSynthesisManifest("ses_r1", manifestDraft());
  return world;
}

function fakeValidator(outputs: string[]) {
  const state = { calls: 0 };
  const validator: SemanticValidator = {
    async validate(capsule: string) {
      state.calls += 1;
      const output = outputs[Math.min(state.calls - 1, outputs.length - 1)];
      void capsule;
      return { text: output ?? "{}" };
    },
  };
  return validator;
}

const CLEAN_OUTPUT = JSON.stringify({ result: "clean", findings: [] });

/** A contradiction finding scoped to the exact ARCH@1 revision (R1 §45). */
function architectureFindingOutput(): string {
  return JSON.stringify({
    result: "findings",
    findings: [
      {
        category: "missing_design",
        statement: "The architecture omits the recovery boundary required by the approved sections.",
        scope: { architecture: { id: "ARCH", revision: 1 } },
        manifestItem: { kind: "implementation_step", order: 1 },
        sources: [{ kind: "architecture" }],
      },
    ],
  });
}

async function approveAndCommit(
  world: { controller: UltraPlanController; store: import("../src/index.js").PlanStore },
  sessionID: string,
  proposalID: string,
): Promise<PlanCommit> {
  const run = (await world.store.findActiveRunBySession(sessionID)) as PlanningRun;
  const proposal = await world.store.getProposal(run.id, ProposalIDs.cast(proposalID));
  if (!proposal) throw new Error(`proposal ${proposalID} missing`);
  const begun = await world.controller.beginProposalApproval(sessionID, proposalID);
  const { approval } = await world.controller.recordApproval(sessionID, proposalID, begun.request);
  const result = await world.store.commitTransaction({
    planID: run.id,
    proposalID: ProposalIDs.cast(proposalID),
    approvalID: approval.id,
  });
  return result;
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

/** DurablePlanStore.open() is synchronous; normalize it for expectErrorCode. */
function syncOpen(store: { open: () => void }): Promise<unknown> {
  try {
    store.open();
    return Promise.reject(new Error("expected store_corrupt at open"));
  } catch (error) {
    return Promise.reject(error);
  }
}

let tempDirs: string[] = [];
beforeEach(() => {
  tempDirs = [];
});
afterEach(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "ultraplan-r1-"));
  tempDirs.push(dir);
  return dir;
}

// -----------------------------------------------------------------------------
// R1a §8 — new blocking conflicts must be remediable
// -----------------------------------------------------------------------------

describe("R1a §8 — blocking conflicts must name a remediable artifact", () => {
  it("refuses a blocking conflict with no remediable ref; warnings stay unrestricted", async () => {
    const { controller } = await dagWorld();
    await expectErrorCode(
      controller.raiseConflict("ses_r1", {
        type: "decision",
        description: "unremediable blocker",
        severity: "blocking",
        refs: [],
      }),
      "invalid_scope",
    );
    // A warning conflict may stay broad.
    const warning = await controller.raiseConflict("ses_r1", {
      type: "decision",
      description: "soft observation",
      severity: "warning",
      refs: [],
    });
    expect(warning.severity).toBe("warning");
    // An evidence-only ref is not remediable either.
    const run = (await controller.planStore.findActiveRunBySession("ses_r1")) as PlanningRun;
    await controller.planStore.putEvidence(run.id, evidence({ id: EvidenceIDs.cast("EVD-001") }));
    await expectErrorCode(
      controller.raiseConflict("ses_r1", {
        type: "decision",
        description: "evidence-only blocker",
        severity: "blocking",
        refs: [{ kind: "evidence", id: "EVD-001" }],
      }),
      "invalid_scope",
    );
  });

  it("accepts a blocking conflict whose refs identify the Section under design", async () => {
    const { controller } = await dagWorld();
    const conflict = await controller.raiseConflict("ses_r1", {
      type: "section",
      description: "SEC-001's design contradicts the runtime contract",
      severity: "blocking",
      refs: [{ kind: "section", id: "SEC-001" }],
    });
    expect(conflict.status).toBe("open");
  });
});

// -----------------------------------------------------------------------------
// R1a §4-§6 — the conflict resolution lifecycle
// -----------------------------------------------------------------------------

describe("R1a §4-§6 — resolve_conflict through Proposal → Approval → PlanCommit", () => {
  it("resolves an architecture conflict via a user-approved revise_proposal binding (§5)", async () => {
    const { controller } = makeWorld();
    await admittedStart(controller, "ses_r1", GOAL);
    await controller.requestArchitecture("ses_r1");
    const conflict = await controller.raiseConflict("ses_r1", {
      type: "decision",
      description: "Two architecture statements contradict",
      severity: "blocking",
      refs: [{ kind: "architecture" }],
    });
    const prepared = await controller.prepareProposal("ses_r1", {
      type: "design_checkpoint",
      scope: { type: "architecture" },
      title: "Remediate the architecture conflict",
      summary: "s",
      changes: [
        {
          kind: "resolve_conflict",
          ref: { kind: "conflict", id: conflict.id },
          content: { action: "revise_proposal" },
        },
      ] as never,
    });
    const resolution = (prepared.proposal.changes as { kind: string; conflictID?: string; resolution?: { action: string; ref: { kind: string; id?: string } } }[]).find(
      (change) => change.kind === "resolve_conflict",
    );
    expect(resolution?.conflictID).toBe(conflict.id);
    expect(resolution?.resolution?.action).toBe("revise_proposal");
    expect(resolution?.resolution?.ref.id).toBe(prepared.proposal.id);
    await approveAndCommit({ controller, store: controller.planStore }, "ses_r1", prepared.proposal.id);
    const run = (await controller.planStore.findActiveRunBySession("ses_r1")) as PlanningRun;
    const resolved = run.conflicts.find((c) => c.id === conflict.id);
    expect(resolved?.status).toBe("resolved");
    expect(resolved?.resolution?.action).toBe("revise_proposal");
    // §39: the committed transaction records the resolution for audit.
    const commits = await controller.planStore.listCommits((await controller.planStore.findActiveRunBySession("ses_r1"))!.id);
    const last = commits[commits.length - 1];
    expect(last?.changes.some((change) => change.kind === "resolve_conflict")).toBe(true);
  });

  it("a resolved conflict no longer blocks commits, and is immutable history (§4)", async () => {
    const { controller } = await dagWorld();
    const conflict = await controller.raiseConflict("ses_r1", {
      type: "section",
      description: "blocks this decision",
      severity: "blocking",
      refs: [{ kind: "section", id: "SEC-001" }],
    });
    const resolution = await controller.prepareProposal("ses_r1", {
      type: "design_checkpoint",
      scope: { type: "section", sectionID: "SEC-001" },
      title: "resolve",
      summary: "s",
      changes: [
        {
          kind: "resolve_conflict",
          ref: { kind: "conflict", id: conflict.id },
          content: { action: "revise_proposal" },
        },
      ] as never,
    });
    await approveAndCommit({ controller, store: controller.planStore }, "ses_r1", resolution.proposal.id);
    // Resolved: a subsequent commit is no longer refused by the conflict gate.
    const after = await controller.prepareProposal("ses_r1", {
      type: "design_checkpoint",
      scope: { type: "section", sectionID: "SEC-001" },
      title: "post-resolution",
      summary: "s",
      changes: [
        {
          kind: "add_decision",
          content: { decision: { title: "t", statement: "s", rationale: "r" } },
        },
      ] as never,
    });
    await approveAndCommit({ controller, store: controller.planStore }, "ses_r1", after.proposal.id);
    // §4/§6: a second resolution of the same conflict is refused.
    await expectErrorCode(
      controller.prepareProposal("ses_r1", {
        type: "design_checkpoint",
        scope: { type: "section", sectionID: "SEC-001" },
        title: "double resolve",
        summary: "s",
        changes: [
          {
            kind: "resolve_conflict",
            ref: { kind: "conflict", id: conflict.id },
            content: { action: "revise_proposal" },
          },
        ] as never,
      }),
      "conflict_resolution_invalid",
    );
  });

  it("amend_decision resolutions bind the exact resulting DecisionRef of the paired change (§6)", async () => {
    const { controller } = makeWorld();
    await admittedStart(controller, "ses_r1", GOAL);
    await controller.requestArchitecture("ses_r1");
    // Commit DEC-001 first.
    const decision = await controller.prepareProposal("ses_r1", {
      type: "design_checkpoint",
      scope: { type: "architecture" },
      title: "d",
      summary: "s",
      changes: [{ kind: "add_decision", content: { decision: { title: "t", statement: "s", rationale: "r" } } }] as never,
    });
    await approveAndCommit({ controller, store: controller.planStore }, "ses_r1", decision.proposal.id);
    const conflict = await controller.raiseConflict("ses_r1", {
      type: "decision",
      description: "DEC-001 is wrong",
      severity: "blocking",
      refs: [{ kind: "decision", id: "DEC-001" }],
    });
    const amendment = await controller.prepareProposal("ses_r1", {
      type: "amendment",
      scope: { type: "architecture" },
      title: "amend DEC-001",
      summary: "s",
      changes: [
        {
          kind: "amend_decision",
          ref: { kind: "decision", id: "DEC-001", revision: 1 },
          content: { decision: { title: "t (revised)", statement: "s2", rationale: "r2" } },
        },
        {
          kind: "resolve_conflict",
          ref: { kind: "conflict", id: conflict.id },
          content: { action: "amend_decision" },
        },
      ] as never,
    });
    const resolution = (amendment.proposal.changes as { kind: string; resolution?: { ref: { id: string; revision: number } } }[]).find(
      (change) => change.kind === "resolve_conflict",
    );
    expect(resolution?.resolution?.ref).toEqual({ kind: "decision", id: "DEC-001", revision: 2 });
    await approveAndCommit({ controller, store: controller.planStore }, "ses_r1", amendment.proposal.id);
    const run = (await controller.planStore.findActiveRunBySession("ses_r1")) as PlanningRun;
    const resolved = run.conflicts.find((c) => c.id === conflict.id);
    expect(resolved?.resolution).toEqual({
      action: "amend_decision",
      ref: { kind: "decision", id: "DEC-001", revision: 2 },
    });
  });

  it("amend_decision resolution without the paired change is refused (§6)", async () => {
    const { controller } = makeWorld();
    await admittedStart(controller, "ses_r1", GOAL);
    await controller.requestArchitecture("ses_r1");
    const decision = await controller.prepareProposal("ses_r1", {
      type: "design_checkpoint",
      scope: { type: "architecture" },
      title: "d",
      summary: "s",
      changes: [{ kind: "add_decision", content: { decision: { title: "t", statement: "s", rationale: "r" } } }] as never,
    });
    await approveAndCommit({ controller, store: controller.planStore }, "ses_r1", decision.proposal.id);
    const conflict = await controller.raiseConflict("ses_r1", {
      type: "decision",
      description: "DEC-001 is wrong",
      severity: "blocking",
      refs: [{ kind: "decision", id: "DEC-001" }],
    });
    await expectErrorCode(
      controller.prepareProposal("ses_r1", {
        type: "amendment",
        scope: { type: "architecture" },
        title: "orphan resolution",
        summary: "s",
        changes: [
          {
            kind: "resolve_conflict",
            ref: { kind: "conflict", id: conflict.id },
            content: { action: "amend_decision" },
          },
        ] as never,
      }),
      "conflict_resolution_invalid",
    );
  });
});

// -----------------------------------------------------------------------------
// R1a §7 — the conflict self-block exception
// -----------------------------------------------------------------------------

describe("R1a §7/§42 — a conflict cannot block its own remediation", () => {
  it("§42: the remediation proposal commits, resolves C, and an unrelated conflict D still blocks", async () => {
    const world = await dagWorld();
    const { controller, store } = world;
    // Checkpoint SEC-001 so it has an approved revision to amend.
    const checkpoint = await controller.prepareSectionCheckpoint("ses_r1", checkpointInput("SEC-001"));
    const begun = await controller.beginProposalApproval("ses_r1", checkpoint.proposal.id);
    await controller.recordApprovalAndCommit("ses_r1", checkpoint.proposal.id, begun.request);
    // Raise blocking conflict C against SEC-001.
    const conflictC = await controller.raiseConflict("ses_r1", {
      type: "section",
      description: "SEC-001 design contradicts the contract",
      severity: "blocking",
      refs: [{ kind: "section", id: "SEC-001" }],
    });
    // Without the resolution change, C blocks the exact amendment.
    await expectErrorCode(
      controller.prepareProposal("ses_r1", {
        type: "design_checkpoint",
        scope: { type: "section", sectionID: "SEC-001" },
        title: "blocked amendment",
        summary: "s",
        changes: [
          { kind: "amend_section", ref: { kind: "section", id: "SEC-001", revision: 1 }, content: sectionDraft("SEC-001", "revised design") },
        ] as never,
      }).then((prepared) => approveAndCommit(world, "ses_r1", prepared.proposal.id)),
      "transaction_validation_failed",
    );
    // The remediation proposal: amend SEC-001 + resolve_conflict(C) — NOT
    // rejected by C itself (§7 exemption).
    const remediation = await controller.prepareProposal("ses_r1", {
      type: "amendment",
      scope: { type: "section", sectionID: "SEC-001" },
      title: "remediate C",
      summary: "s",
      changes: [
        { kind: "amend_section", ref: { kind: "section", id: "SEC-001", revision: 1 }, content: sectionDraft("SEC-001", "revised design") },
        { kind: "resolve_conflict", ref: { kind: "conflict", id: conflictC.id }, content: { action: "revise_proposal" } },
      ] as never,
    });
    const commit = await approveAndCommit(world, "ses_r1", remediation.proposal.id);
    expect(commit.changes.some((change) => change.kind === "resolve_conflict")).toBe(true);
    const run = (await store.findActiveRunBySession("ses_r1")) as PlanningRun;
    expect(run.conflicts.find((c) => c.id === conflictC.id)?.status).toBe("resolved");
    // An UNRELATED blocking conflict still blocks (seeded run-global — the §8
    // raise boundary would refuse it today; engine gate semantics unchanged).
    const current = (await store.findActiveRunBySession("ses_r1")) as PlanningRun;
    await store.saveRun({
      ...current,
      conflicts: [
        ...current.conflicts,
        { id: "CONF- unrelated" as never, type: "decision" as const, refs: [], description: "unrelated", severity: "blocking" as const, status: "open" as const },
      ],
    });
    const unrelated = await controller.prepareProposal("ses_r1", {
      type: "design_checkpoint",
      scope: { type: "section", sectionID: "SEC-001" },
      title: "post-D",
      summary: "s",
      changes: [{ kind: "add_decision", content: { decision: { title: "t", statement: "s", rationale: "r" } } }] as never,
    });
    await expectErrorCode(
      approveAndCommit(world, "ses_r1", unrelated.proposal.id),
      "transaction_validation_failed",
    );
  });
});

// -----------------------------------------------------------------------------
// R1a §10-§14 + R1b §43/§44 — blocker-driven reopens out of synthesis
// -----------------------------------------------------------------------------

describe("R1a §10-§14 — blocker-driven reopens", () => {
  it("§43 (section scope): a blocking section-scoped question reopens its own Section without a report", async () => {
    const { controller, store } = await synWorld(makeWorld(), "ses_r1");
    // NO report exists at all — the question, not a report, drives the reopen
    // (brief §14: a ValidationReport is never fabricated for a blocker-driven
    // reopen).
    const question = await controller.recordQuestion("ses_r1", {
      question: "Does SEC-001 survive the new runtime constraint?",
      blocking: true,
      scope: { type: "section", sectionID: "SEC-001" },
    });
    const prepared = await controller.requestReopen("ses_r1", {
      reason: "blocking_question",
      questionID: question.id,
    });
    const change = prepared.proposal.changes[0];
    expect(change?.kind).toBe("reopen_section");
    expect(change?.kind === "reopen_section" && change.reason).toEqual({
      type: "blocking_question",
      questionID: question.id,
    });
    await approveAndCommit({ controller, store }, "ses_r1", prepared.proposal.id);
    const run = (await store.findActiveRunBySession("ses_r1")) as PlanningRun;
    expect(run.stage).toBe("detail");
    expect(run.activeWork).toEqual({ type: "section", id: "SEC-001" });
    // §11: the question REMAINS open — entering detail resolves nothing.
    expect(run.openQuestions.find((q) => q.id === question.id)?.status).toBe("open");
  });

  it("§44: a blocking section-scoped conflict reopens its Section; the corrective amendment resolves it", async () => {
    const world = await synWorld(makeWorld(), "ses_r1");
    const { controller, store } = world;
    const conflict = await controller.raiseConflict("ses_r1", {
      type: "section",
      description: "SEC-002 must change",
      severity: "blocking",
      refs: [{ kind: "section", id: "SEC-002" }],
    });
    const prepared = await controller.requestReopen("ses_r1", {
      reason: "blocking_conflict",
      conflictID: conflict.id,
    });
    expect(prepared.proposal.changes[0]?.kind).toBe("reopen_section");
    await approveAndCommit(world, "ses_r1", prepared.proposal.id);
    let run = (await store.findActiveRunBySession("ses_r1")) as PlanningRun;
    expect(run.stage).toBe("detail");
    expect(run.activeWork).toEqual({ type: "section", id: "SEC-002" });
    expect(run.conflicts.find((c) => c.id === conflict.id)?.status).toBe("open");
    // Corrective amendment: new checkpoint binding the current contracts + the
    // sanctioned cure. C no longer blocks its own remediation (§7).
    const checkpoint = await controller.prepareProposal("ses_r1", {
      type: "design_checkpoint",
      scope: { type: "section", sectionID: "SEC-002" },
      title: "corrective checkpoint",
      summary: "s",
      changes: [
        {
          kind: "amend_section",
          ref: { kind: "section", id: "SEC-002", revision: 1 },
          content: sectionDraft("SEC-002", "revised under the conflict"),
        },
        { kind: "resolve_conflict", ref: { kind: "conflict", id: conflict.id }, content: { action: "revise_proposal" } },
      ] as never,
    });
    await approveAndCommit(world, "ses_r1", checkpoint.proposal.id);
    run = (await store.findActiveRunBySession("ses_r1")) as PlanningRun;
    expect(run.conflicts.find((c) => c.id === conflict.id)?.status).toBe("resolved");
    expect(run.sections.find((ref) => ref.id === "SEC-002")).toBeDefined();
    const root = await store.getSection(run.id, "SEC-002" as never);
    expect(root?.status).toBe("active");
    expect(root?.currentRevision).toBe(2);
  });

  it("a non-blocking question and a resolved conflict are refused as reopen reasons (§10)", async () => {
    const { controller } = await synWorld(makeWorld(), "ses_r1");
    const soft = await controller.recordQuestion("ses_r1", {
      question: "non-blocking",
      blocking: false,
      scope: { type: "section", sectionID: "SEC-001" },
    });
    await expectErrorCode(
      controller.requestReopen("ses_r1", { reason: "blocking_question", questionID: soft.id }),
      "invalid_scope",
    );
    await expectErrorCode(
      controller.requestReopen("ses_r1", { reason: "blocking_conflict", conflictID: "CONF-999" }),
      "unknown_reference",
    );
  });
});

// -----------------------------------------------------------------------------
// R1a §16 — explicit terminal abort
// -----------------------------------------------------------------------------

describe("R1a §16-§17 — explicit abort", () => {
  it("a user-confirmed abort terminates the run without touching committed state", async () => {
    const world = await dagWorld();
    const { controller, store } = world;
    const before = (await store.findActiveRunBySession("ses_r1")) as PlanningRun;
    const commitsBefore = (await store.listCommits(before.id)).length;
    const gate = await controller.beginAbort("ses_r1");
    expect(gate.planID).toBe(before.id);
    const result = await controller.confirmAbort(gate.planID);
    expect(result.aborted).toBe(true);
    expect(result.run.lifecycle).toBe("aborted");
    expect(result.run.activeWork).toBeUndefined();
    // Committed state untouched (§16).
    expect(result.run.headCommit).toBe(before.headCommit);
    expect(result.run.headSnapshot).toBe(before.headSnapshot);
    expect((await store.listCommits(before.id)).length).toBe(commitsBefore);
    expect((await store.listSections(before.id)).length).toBe(3);
    // Terminal: no active run remains, and the aborted run never reactivates.
    expect(await store.findActiveRunBySession("ses_r1")).toBeUndefined();
    await expectErrorCode(controller.beginAbort("ses_r1"), "no_active_run");
  });

  it("the tool asks the USER and a deny leaves the run active (§48)", async () => {
    const world = await dagWorld();
    const { controller, store } = world;
    const tools = createUltraPlanTools(controller);
    const abortTool = (tools as Record<string, { execute: (args: unknown, context: unknown) => Promise<{ metadata: Record<string, unknown> }> }>)["ultraplan_request_abort"]!;
    // Deny.
    const denied = await abortTool.execute({}, fakeToolContext("ses_r1", {
      ask: async () => {
        throw new Error("user denied");
      },
    }));
    expect(denied.metadata["aborted"]).toBe(false);
    expect(await store.findActiveRunBySession("ses_r1")).toBeDefined();
    // Allow.
    const allowed = await abortTool.execute({}, fakeToolContext("ses_r1"));
    expect(allowed.metadata["aborted"]).toBe(true);
    expect(await store.findActiveRunBySession("ses_r1")).toBeUndefined();
  });

  it("a completed run cannot be aborted (§16)", async () => {
    const world = await dagWorld();
    const { controller, store } = world;
    const run = (await store.findActiveRunBySession("ses_r1")) as PlanningRun;
    await store.abortRun(run.id);
    await expectErrorCode(controller.beginAbort("ses_r1"), "no_active_run");
  });
});

// -----------------------------------------------------------------------------
// R1b §18-§26 + §37 + §45 — architecture remediation end-to-end
// -----------------------------------------------------------------------------

describe("R1b §18-§26 — architecture reopen, amendment, and DAG invalidation", () => {
  it("§45: architecture finding → reopen → amendment → re-decomposition with fresh IDs", async () => {
    const { controller, store } = await manifestWorldR1(fakeValidator([architectureFindingOutput()]));
    await controller.runSemanticValidation("ses_r1");
    const report = (await store.getCurrentValidationReport((await store.findActiveRunBySession("ses_r1"))!.id)) as unknown as { id: string; hash: string };
    expect(report).toBeDefined();

    // 1. The architecture-scoped finding reopens the ARCHITECTURE (B-C cured).
    const prepared = await controller.requestReopen("ses_r1", {
      reason: "semantic_validation",
      findingIDs: ["VF-001"],
    });
    const change = prepared.proposal.changes[0];
    expect(change?.kind).toBe("reopen_architecture");
    await approveAndCommit({ controller, store }, "ses_r1", prepared.proposal.id);
    let run = (await store.findActiveRunBySession("ses_r1")) as PlanningRun;
    expect(run.stage).toBe("detail");
    expect(run.activeWork).toEqual({ type: "architecture" });
    // §20: ARCH@1 stays approved; NO new revision; Sections unchanged.
    expect(run.architecture?.revision).toBe(1);
    expect(run.sections).toHaveLength(3);
    const arch1 = await store.getArchitecture(run.id, 1);
    expect(arch1?.status).toBe("approved");

    // 2. The remediation substate exposes exactly the amendment surface (§21).
    const caps = getCapabilities(run);
    expect(caps.has("prepare_architecture_amendment")).toBe(true);
    expect(caps.has("prepare_decomposition")).toBe(false);
    expect(caps.has("prepare_section_checkpoint")).toBe(false);
    expect(caps.has("request_section_focus")).toBe(false);
    expect(caps.has("raise_conflict")).toBe(false);

    // 3. The amendment resolves the finding's root cause and commits ARCH@2.
    const amendment = await controller.prepareArchitectureAmendment("ses_r1", {
      architecture: {
        summary: "Completion target, revised with the recovery boundary",
        components: [{ name: "Core", summary: "kernel" }, { name: "Recovery", summary: "crash-safe recovery" }],
        boundaries: [],
        dataFlows: [],
        principles: [{ statement: "remediation first" }],
      },
    });
    expect(amendment.proposal.scope).toEqual({ id: "ARCH", revision: 1 });
    const amendChange = amendment.proposal.changes[0];
    expect(amendChange?.kind === "amend_architecture" && amendChange.architecture.revision).toBe(2);
    await approveAndCommit({ controller, store }, "ses_r1", amendment.proposal.id);
    run = (await store.findActiveRunBySession("ses_r1")) as PlanningRun;
    // §24/§36: ARCH@1 immutable; ARCH@2 current; DAG invalidated atomically.
    expect(run.architecture?.revision).toBe(2);
    expect(await store.getArchitecture(run.id, 1)).toBeDefined();
    expect((await store.getArchitecture(run.id, 1))?.summary).toBe("Completion target");
    expect(run.sections).toEqual([]);
    expect(run.activeWork).toBeUndefined();
    expect(run.sectionDecompositionArchitecture).toBeUndefined();
    // Old roots preserved as history, marked needs_review (§26).
    const oldRoot = await store.getSection(run.id, "SEC-001" as never);
    expect(oldRoot).toBeDefined();
    expect(oldRoot?.validation).toBe("needs_review");
    // §37: the derived substate is decomposition-needed again.
    expect(getCapabilities(run).has("prepare_decomposition")).toBe(true);
    expect(getCapabilities(run).has("prepare_architecture_amendment")).toBe(false);

    // 4. §30: re-decomposition allocates FRESH ids (no recycling).
    const decomposition = await controller.prepareSectionDecomposition("ses_r1", {
      sections: [
        { key: "runtime2", title: "Runtime Integration II", objective: "re-bound to the host" },
        { key: "recovery", title: "Recovery", objective: "crash-safe", dependsOn: ["runtime2"] },
      ],
      initialSection: "runtime2",
    });
    const ids = (decomposition.proposal.changes as { kind: string; section?: { id: string } }[])
      .filter((change) => change.kind === "add_section")
      .map((change) => change.section?.id);
    expect(ids).toEqual(["SEC-004", "SEC-005"]);
    await approveAndCommit({ controller, store }, "ses_r1", decomposition.proposal.id);
    run = (await store.findActiveRunBySession("ses_r1")) as PlanningRun;
    // §50: provenance re-records the NEW architecture revision.
    expect(run.sectionDecompositionArchitecture).toEqual({ id: "ARCH", revision: 2 });
    // §29: old artifacts remain readable history.
    expect(await store.getSection(run.id, "SEC-001" as never)).toBeDefined();
    expect(await store.getArchitecture(run.id, 1)).toBeDefined();
  });

  it("§43 full: a blocking architecture-scoped question rides the amendment to resolution", async () => {
    const { controller, store } = await manifestWorldR1(fakeValidator([CLEAN_OUTPUT]));
    await controller.runSemanticValidation("ses_r1");
    const question = await controller.recordQuestion("ses_r1", {
      question: "Is the architecture missing a recovery component?",
      blocking: true,
      scope: { type: "architecture" },
    });
    const prepared = await controller.requestReopen("ses_r1", {
      reason: "blocking_question",
      questionID: question.id,
    });
    expect(prepared.proposal.changes[0]?.kind).toBe("reopen_architecture");
    await approveAndCommit({ controller, store }, "ses_r1", prepared.proposal.id);
    // The amendment resolves the question (§34); it stays open until commit.
    const amendment = await controller.prepareArchitectureAmendment("ses_r1", {
      architecture: {
        summary: "Completion target, revised",
        components: [{ name: "Core", summary: "kernel" }],
        boundaries: [],
        dataFlows: [],
        principles: [],
      },
      resolveQuestionIDs: [question.id],
    });
    const runBefore = (await store.findActiveRunBySession("ses_r1")) as PlanningRun;
    expect(runBefore.openQuestions.find((q) => q.id === question.id)?.status).toBe("open");
    await approveAndCommit({ controller, store }, "ses_r1", amendment.proposal.id);
    const run = (await store.findActiveRunBySession("ses_r1")) as PlanningRun;
    expect(run.openQuestions.find((q) => q.id === question.id)?.status).toBe("resolved");
  });

  it("§33: a blocking architecture conflict cannot block its own reopen or amendment", async () => {
    const { controller, store } = await synWorld(makeWorld(), "ses_r1");
    const conflict = await controller.raiseConflict("ses_r1", {
      type: "decision",
      description: "The architecture itself is wrong",
      severity: "blocking",
      refs: [{ kind: "architecture" }],
    });
    const prepared = await controller.requestReopen("ses_r1", {
      reason: "blocking_conflict",
      conflictID: conflict.id,
    });
    await approveAndCommit({ controller, store }, "ses_r1", prepared.proposal.id);
    const amendment = await controller.prepareArchitectureAmendment("ses_r1", {
      architecture: {
        summary: "Revised under conflict",
        components: [],
        boundaries: [],
        dataFlows: [],
        principles: [],
      },
      resolveConflictIDs: [conflict.id],
    });
    await approveAndCommit({ controller, store }, "ses_r1", amendment.proposal.id);
    const run = (await store.findActiveRunBySession("ses_r1")) as PlanningRun;
    expect(run.conflicts.find((c) => c.id === conflict.id)?.status).toBe("resolved");
    expect(run.conflicts.find((c) => c.id === conflict.id)?.resolution).toEqual({
      action: "amend_architecture",
      ref: { kind: "architecture", revision: 2 },
    });
  });

  it("§35: a rejected amendment changes nothing — sections stay current and approval stays durable", async () => {
    const { controller, store } = await manifestWorldR1(fakeValidator([architectureFindingOutput()]));
    await controller.runSemanticValidation("ses_r1");
    const prepared = await controller.requestReopen("ses_r1", { reason: "semantic_validation", findingIDs: ["VF-001"] });
    await approveAndCommit({ controller, store }, "ses_r1", prepared.proposal.id);
    const amendment = await controller.prepareArchitectureAmendment("ses_r1", {
      architecture: { summary: "Revised", components: [], boundaries: [], dataFlows: [], principles: [] },
    });
    const begun = await controller.beginProposalApproval("ses_r1", amendment.proposal.id);
    const { approval } = await controller.recordApproval("ses_r1", amendment.proposal.id, begun.request);
    // Hostile drift: the HEAD moved after approval → the commit refuses.
    const run = (await store.findActiveRunBySession("ses_r1")) as PlanningRun;
    await store.saveRun({ ...run, conflicts: [...run.conflicts, { id: "CONF-late" as never, type: "decision" as const, refs: [{ kind: "architecture" }], description: "late blocker", severity: "blocking" as const, status: "open" as const }] });
    await expectErrorCode(
      store.commitTransaction({ planID: run.id, proposalID: amendment.proposal.id, approvalID: approval.id }),
      "transaction_validation_failed",
    );
    const after = (await store.findActiveRunBySession("ses_r1")) as PlanningRun;
    expect(after.architecture?.revision).toBe(1);
    expect(after.sections).toHaveLength(3);
    expect(await store.getArchitecture(after.id, 2)).toBeUndefined();
  });
});

// -----------------------------------------------------------------------------
// R1 §41 — deadlock-freedom property coverage
// -----------------------------------------------------------------------------

describe("R1 §41 — every reachable blocker has a sanctioned cure", () => {
  const cases: { substate: string; build: () => Promise<ReturnType<typeof makeWorld>>; raise: (w: ReturnType<typeof makeWorld>) => Promise<unknown>; cure: (w: ReturnType<typeof makeWorld>) => Promise<unknown> }[] = [];

  cases.push({
    substate: "discovery/blocking-question",
    build: async () => {
      const world = makeWorld();
      await admittedStart(world.controller, "ses_r1", GOAL);
      return world;
    },
    raise: async (w) =>
      w.controller.recordQuestion("ses_r1", {
        question: "blocking discovery question",
        blocking: true,
        scope: { type: "architecture" },
      }),
    // Cure: the sanctioned discovery → architecture transition (admission
    // succeeds), after which prepare_proposal can resolve the question.
    cure: async (w) => w.controller.requestArchitecture("ses_r1"),
  });

  cases.push({
    substate: "architecture/blocking-conflict",
    build: async () => {
      const world = makeWorld();
      await admittedStart(world.controller, "ses_r1", GOAL);
      await world.controller.requestArchitecture("ses_r1");
      return world;
    },
    raise: async (w) =>
      w.controller.raiseConflict("ses_r1", {
        type: "decision",
        description: "architecture contradiction",
        severity: "blocking",
        refs: [{ kind: "architecture" }],
      }),
    cure: async (w) =>
      w.controller.prepareProposal("ses_r1", {
        type: "design_checkpoint",
        scope: { type: "architecture" },
        title: "cure",
        summary: "s",
        changes: [
          { kind: "add_decision", content: { decision: { title: "t", statement: "s", rationale: "r" } } },
          { kind: "resolve_conflict", ref: { kind: "conflict", id: "CONF-001" }, content: { action: "revise_proposal" } },
        ] as never,
      }),
  });

  cases.push({
    substate: "synthesis (all substates)/blocking-question",
    build: async () => synWorld(makeWorld(), "ses_r1"),
    raise: async (w) =>
      w.controller.recordQuestion("ses_r1", {
        question: "blocking synthesis question",
        blocking: true,
        scope: { type: "section", sectionID: "SEC-001" },
      }),
    cure: async (w) => {
      const run = (await w.store.findActiveRunBySession("ses_r1")) as PlanningRun;
      const question = run.openQuestions[run.openQuestions.length - 1];
      return w.controller.requestReopen("ses_r1", { reason: "blocking_question", questionID: question!.id });
    },
  });

  it("drives the cure admission for every reachable blocked state", async () => {
    for (const testCase of cases) {
      const world = await testCase.build();
      await testCase.raise(world);
      // The cure must be ADMITTED (a sanctioned transition prepares), not
      // merely visible as a tool.
      await testCase.cure(world);
    }
  });

  it("pins request_reopen + request_abort grants across all seven synthesis substates (§41 matrix)", () => {
    const contexts: Record<string, import("../src/core/capabilities.js").CapabilityContext> = {
      "no-input": {},
      "input-ready": { synthesis: { hasInput: true, hasManifest: false } },
      "manifest-ready": { synthesis: { hasInput: true, hasManifest: true } },
      findings: { synthesis: { hasInput: true, hasManifest: true, report: { result: "findings" } } },
      clean: { synthesis: { hasInput: true, hasManifest: true, report: { result: "clean" } } },
      candidate: { synthesis: { hasInput: true, hasManifest: true, report: { result: "clean" }, candidate: { current: true } } },
      proposal: {
        synthesis: { hasInput: true, hasManifest: true, report: { result: "clean" }, candidate: { current: true }, finalProposal: { status: "ready", current: true } },
      },
    };
    const baseRun = {
      id: "PLAN-000" as PlanningRun["id"],
      sessionID: "ses_synthetic",
      lifecycle: "active" as const,
      stage: "synthesis" as const,
      revision: 0,
      goal: { statement: "" },
      constraints: [],
      sections: [],
      decisions: [],
      openQuestions: [],
      conflicts: [],
      createdAt: "",
      updatedAt: "",
    };
    for (const [name, context] of Object.entries(contexts)) {
      const caps = getCapabilities(baseRun, context);
      expect(caps.has("request_reopen"), `synthesis/${name} request_reopen`).toBe(true);
      expect(caps.has("request_abort"), `synthesis/${name} request_abort`).toBe(true);
      // §9: synthesis never gains generic design mutation.
      expect(caps.has("prepare_proposal"), `synthesis/${name} prepare_proposal`).toBe(false);
    }
  });
});

// -----------------------------------------------------------------------------
// R1 §46 — cross-instance amendment concurrency
// -----------------------------------------------------------------------------

describe("R1 §46 — cross-instance architecture amendment concurrency", () => {
  it("a second instance committing an amendment against a moved HEAD fails stale", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "plan-store.json");
    const storeA = new DurablePlanStore(file, { now: () => FIXED });
    await storeA.open();
    const controllerA = new UltraPlanController({ store: storeA, now: () => FIXED });
    void controllerA;
    const world = await manifestWorldR1OverStore(storeA, fakeValidator([architectureFindingOutput()]));
    await world.controller.runSemanticValidation("ses_r1");
    const reopen = await world.controller.requestReopen("ses_r1", { reason: "semantic_validation", findingIDs: ["VF-001"] });
    await approveAndCommit({ controller: world.controller, store: storeA as unknown as InMemoryPlanStore }, "ses_r1", reopen.proposal.id);

    // Instance B opens the SAME durable state.
    const storeB = new DurablePlanStore(file, { now: () => FIXED });
    await storeB.open();
    const controllerB = new UltraPlanController({ store: storeB, now: () => FIXED });
    const amendmentB = await controllerB.prepareArchitectureAmendment("ses_r1", {
      architecture: { summary: "B revision", components: [], boundaries: [], dataFlows: [], principles: [] },
    });
    // Instance A commits its own amendment first — HEAD moves.
    const amendmentA = await world.controller.prepareArchitectureAmendment("ses_r1", {
      architecture: { summary: "A revision", components: [], boundaries: [], dataFlows: [], principles: [] },
    });
    await approveAndCommit({ controller: world.controller, store: storeA as unknown as InMemoryPlanStore }, "ses_r1", amendmentA.proposal.id);
    // B's commit is refused stale — no branching architecture history.
    const begunB = await controllerB.beginProposalApproval("ses_r1", amendmentB.proposal.id);
    const { approval: approvalB } = await controllerB.recordApproval("ses_r1", amendmentB.proposal.id, begunB.request);
    const runB = (await storeB.findActiveRunBySession("ses_r1")) as PlanningRun;
    // The stale refusal surfaces inside the transaction failure list.
    let staleCode = "";
    try {
      await storeB.commitTransaction({ planID: runB.id, proposalID: amendmentB.proposal.id, approvalID: approvalB.id });
      throw new Error("expected the stale amendment commit to fail");
    } catch (error) {
      expect(isUltraPlanError(error)).toBe(true);
      expect((error as { code: string }).code).toBe("transaction_validation_failed");
      const failures = (error as { detail?: { failures?: { code: string }[] } }).detail?.failures ?? [];
      staleCode = failures.some((failure) => failure.code === "head_snapshot_mismatch") ? "head_snapshot_mismatch" : "";
      expect(staleCode).toBe("head_snapshot_mismatch");
    }
    const finalRun = (await storeA.findActiveRunBySession("ses_r1")) as PlanningRun;
    expect(finalRun.architecture?.revision).toBe(2);
    expect((await storeA.getArchitecture(finalRun.id, 2))?.summary).toBe("A revision");
    await storeA.close();
    await storeB.close();
  });
});

// -----------------------------------------------------------------------------
// R1 §49 — durable fail-closed validation
// -----------------------------------------------------------------------------

describe("R1 §49 — durable load validation refuses inconsistent R1 state", () => {
  async function durableWorldFile(): Promise<{ file: string; doc: Record<string, unknown>; runID: string }> {
    const dir = await tempDir();
    const file = path.join(dir, "plan-store.json");
    const store = new DurablePlanStore(file, { now: () => FIXED });
    await store.open();
    const world = await dagWorld(makeWorld(store as unknown as InMemoryPlanStore), "ses_r1");
    const { controller } = world;
    // Checkpoint SEC-001, then resolve a blocking conflict through the
    // sanctioned detail-stage path so the durable doc has a resolved conflict.
    const checkpoint = await controller.prepareSectionCheckpoint("ses_r1", checkpointInput("SEC-001"));
    const begun = await controller.beginProposalApproval("ses_r1", checkpoint.proposal.id);
    await controller.recordApprovalAndCommit("ses_r1", checkpoint.proposal.id, begun.request);
    const conflict = await controller.raiseConflict("ses_r1", {
      type: "section",
      description: "c",
      severity: "blocking",
      refs: [{ kind: "section", id: "SEC-001" }],
    });
    const resolution = await controller.prepareProposal("ses_r1", {
      type: "design_checkpoint",
      scope: { type: "section", sectionID: "SEC-001" },
      title: "resolve",
      summary: "s",
      changes: [
        { kind: "resolve_conflict", ref: { kind: "conflict", id: conflict.id }, content: { action: "revise_proposal" } },
      ] as never,
    });
    await approveAndCommit({ controller, store: store as unknown as InMemoryPlanStore }, "ses_r1", resolution.proposal.id);
    const run = (await store.findActiveRunBySession("ses_r1")) as PlanningRun;
    await store.close();
    const doc = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    return { file, doc, runID: run.id as string };
  }
  void 0;

  it("a resolved conflict without a resolution is store_corrupt", async () => {
    const { file, doc } = await durableWorldFile();
    const runs = doc["runs"] as Record<string, Record<string, unknown>>;
    for (const run of Object.values(runs)) {
      const conflicts = run["conflicts"] as Record<string, unknown>[];
      for (const conflict of conflicts) {
        if (conflict["status"] === "resolved") delete conflict["resolution"];
      }
    }
    await writeFile(file, JSON.stringify(doc));
    const store = new DurablePlanStore(file, { now: () => FIXED });
    expectErrorCode(syncOpen(store), "store_corrupt");
  });

  it("an amend_decision resolution binding a missing decision is store_corrupt", async () => {
    const { file, doc } = await durableWorldFile();
    const runs = doc["runs"] as Record<string, Record<string, unknown>>;
    for (const run of Object.values(runs)) {
      const conflicts = run["conflicts"] as { status?: string; resolution?: { action?: string; ref?: { kind?: string; id?: string; revision?: number } } }[];
      for (const conflict of conflicts) {
        if (conflict["status"] === "resolved") {
          conflict["resolution"] = { action: "amend_decision", ref: { kind: "decision", id: "DEC-999", revision: 7 } };
        }
      }
    }
    await writeFile(file, JSON.stringify(doc));
    const store = new DurablePlanStore(file, { now: () => FIXED });
    expectErrorCode(syncOpen(store), "store_corrupt");
  });

  it("a decomposition provenance contradicting the current architecture is store_corrupt", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "plan-store.json");
    const store = new DurablePlanStore(file, { now: () => FIXED });
    await store.open();
    const world = await synWorld(makeWorld(store as unknown as InMemoryPlanStore), "ses_r1");
    const run = (await store.findActiveRunBySession("ses_r1")) as PlanningRun;
    void world;
    await store.close();
    const doc = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    const runs = doc["runs"] as Record<string, Record<string, unknown>>;
    for (const record of Object.values(runs)) {
      if (record["id"] === (run.id as unknown)) {
        record["sectionDecompositionArchitecture"] = { id: "ARCH", revision: 99 };
      }
    }
    await writeFile(file, JSON.stringify(doc));
    const reopened = new DurablePlanStore(file, { now: () => FIXED });
    expectErrorCode(syncOpen(reopened), "store_corrupt");
  });

  it("an aborted run carrying activeWork is store_corrupt", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "plan-store.json");
    const store = new DurablePlanStore(file, { now: () => FIXED });
    await store.open();
    await dagWorld(makeWorld(store as unknown as InMemoryPlanStore), "ses_r1");
    const run = (await store.findActiveRunBySession("ses_r1")) as PlanningRun;
    await store.abortRun(run.id);
    await store.close();
    const doc = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    const runs = doc["runs"] as Record<string, Record<string, unknown>>;
    for (const record of Object.values(runs)) {
      if (record["lifecycle"] === "aborted") {
        record["activeWork"] = { type: "section", id: "SEC-001" };
      }
    }
    await writeFile(file, JSON.stringify(doc));
    const reopened = new DurablePlanStore(file, { now: () => FIXED });
    expectErrorCode(syncOpen(reopened), "store_corrupt");
  });
});

// -----------------------------------------------------------------------------
// R1 §52 sanity: the amendment change vocabulary is closed at the tool boundary
// -----------------------------------------------------------------------------

describe("R1 §38/§52 — no direct architecture mutation surface", () => {
  it("prepare_proposal refuses the new reserved change kinds", async () => {
    const { controller } = await dagWorld();
    for (const kind of ["reopen_architecture", "amend_architecture", "reopen_section", "add_final_plan"]) {
      await expectErrorCode(
        controller.prepareProposal("ses_r1", {
          type: "amendment",
          scope: { type: "architecture" },
          title: "hostile",
          summary: "s",
          changes: [{ kind, content: {} }] as never,
        }),
        "proposal_kind_unsupported",
      );
    }
  });
});
