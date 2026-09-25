/**
 * Phase 2J — Recoverable ExecutionHandoff & Same-session Build Transition.
 *
 * Covers the §145 matrix: freeze preconditions on the exact final state
 * (§17), the deterministic canonical handoff and its hash mutations
 * (§8-§16/§125), the narrow no-model-authority surface (§35/§109/§126), the
 * single-flight delivery state machine with exactly-one dispatch (§19-§24/
 * §38-§45), definite-rejection vs ambiguous failure semantics (§60-§62),
 * lifecycle completion semantics (§46-§49/§106), cross-instance concurrency
 * (§119-§121), restart recovery and the crash windows (§78-§94/§133-§134 —
 * the process-level windows live in durable-crash.test.ts), corruption
 * fail-closed (§122-§124), status rendering (§66-§70) and the §71/§72 L0
 * fragments. Live OpenCode runtime validation is a dedicated script
 * (scripts/opencode-handoff-smoke.mjs).
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DurablePlanStore,
  InMemoryPlanStore,
  computeExecutionHandoffHashFromRecord,
  renderPlanningProtocol,
  renderStatus,
  type ExecutionHandoff,
  type ExecutionRuntimeAdapter,
  type FinalPlanCandidate,
  type HandoffDelivery,
  type HostDeliveryReceipt,
  type SemanticValidator,
} from "../src/index.js";
import { HandoffDispatchRejected } from "../src/runtime/types.js";
import { UltraPlanController, type SectionCheckpointInput } from "../src/core/controller.js";
import type { PlanningRun } from "../src/core/types.js";
import { renderExecutionHandoffPrompt } from "../src/handoff/assemble.js";
import { admittedStart } from "./helpers.js";
import { HandoffIDs } from "../src/core/ids.js";

/**
 * Freeze + prepare WITHOUT dispatching: the durable pre-dispatch state
 * (§38). Returns the frozen handoff and its prepared delivery.
 */
async function freezeAndPrepare(world: Awaited<ReturnType<typeof handoffPendingWorld>>): Promise<{ handoff: ExecutionHandoff; delivery: HandoffDelivery }> {
  const run = (await world.store.getRun(world.runID)) as PlanningRun;
  const finalPlan = (await world.store.listFinalPlans(world.runID))[0]!;
  const { assembleExecutionHandoff } = await import("../src/index.js");
  const requiredContracts = [];
  for (const ref of finalPlan.sections) {
    const revision = await world.store.getSectionRevision(world.runID, ref);
    if (revision) requiredContracts.push(revision.projection.contract);
  }
  const { handoff } = assembleExecutionHandoff({ run, finalPlan, requiredContracts, assign: { id: "HANDOFF-001", now: FIXED } });
  await world.store.saveExecutionHandoff(world.runID, handoff);
  const delivery = (
    await world.store.prepareHandoffDelivery(world.runID, {
      handoffID: HandoffIDs.cast(handoff.id),
      handoffHash: handoff.hash,
      sessionID: world.sessionID,
      deliveryKey: `${world.runID}/HANDOFF-001/${handoff.hash}`,
    })
  ).delivery;
  return { handoff, delivery };
}

const FIXED = "2026-09-25T12:00:00.000Z";
const GOAL = "Build the durable planning harness";

// -----------------------------------------------------------------------------
// World builders (the real-flow drive shared with the 2H/2I suites)
// -----------------------------------------------------------------------------

class FakeExecutionHost implements ExecutionRuntimeAdapter {
  dispatches: { sessionID: string; deliveryKey: string; agent?: string; model?: string; prompt: string }[] = [];
  /** deliveryKey → receipt: the queryable host "history". */
  receipts = new Map<string, HostDeliveryReceipt>();
  /** Definite pre-acceptance rejection (§61). */
  rejectDefinitely = false;
  /** Ambiguous failure possibly AFTER acceptance (§62). */
  failAmbiguously = false;
  /** Record the receipt, then throw ambiguous (crash window D). */
  failAfterAcceptance = false;
  /** History query unsupported (§132 fail-closed path). */
  querySupported = true;
  /** History query failing (transient). */
  queryFails = false;

  async dispatchHandoff(input: { sessionID: string; deliveryKey: string; agent?: string; model?: { providerID: string; modelID: string }; prompt: string }) {
    this.dispatches.push({
      sessionID: input.sessionID,
      deliveryKey: input.deliveryKey,
      ...(input.agent ? { agent: input.agent } : {}),
      ...(input.model ? { model: `${input.model.providerID}/${input.model.modelID}` } : {}),
      prompt: input.prompt,
    });
    if (this.rejectDefinitely) throw new HandoffDispatchRejected("host rejected the handoff");
    const acceptedHere = !this.failAmbiguously;
    if (!this.failAmbiguously || this.failAfterAcceptance) {
      this.receipts.set(input.deliveryKey, {
        sessionID: input.sessionID,
        messageID: `msg_${String(this.dispatches.length).padStart(3, "0")}`,
        ...(input.agent ? { agent: input.agent } : {}),
        ...(input.model ? { model: input.model } : {}),
      });
    }
    if (this.failAfterAcceptance) throw new Error("connection dropped after send (ambiguous)");
    void acceptedHere;
    return { accepted: true as const };
  }

  async findHandoffDelivery(input: { sessionID: string; deliveryKey: string }): Promise<HostDeliveryReceipt | undefined> {
    if (!this.querySupported) throw new Error("history query unavailable");
    if (this.queryFails) throw new Error("history temporarily unavailable");
    const receipt = this.receipts.get(input.deliveryKey);
    if (!receipt || receipt.sessionID !== input.sessionID) return undefined;
    return receipt;
  }
}

function makeWorld(options: { validator?: SemanticValidator; executionAgent?: string; executionModel?: string; withRuntime?: boolean } = {}) {
  const store = new InMemoryPlanStore(() => FIXED);
  const validator = options.validator ?? { async validate() { return { text: JSON.stringify({ result: "clean", findings: [] }) }; } };
  const controller = new UltraPlanController({
    store,
    now: () => FIXED,
    semanticValidator: validator,
    ...((options.withRuntime ?? true)
      ? {
          executionRuntime: {
            adapter: new FakeExecutionHost(),
            ...(options.executionAgent !== undefined ? { executionAgent: options.executionAgent } : {}),
            ...(options.executionModel !== undefined ? { executionModel: options.executionModel } : {}),
          },
        }
      : {}),
  });
  return { store, controller, host: controller["executionRuntime"]?.adapter as FakeExecutionHost | undefined };
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

/** Prepare the final_plan Proposal and move it into awaiting_approval. */
async function prepareAndAwait(world: { controller: UltraPlanController }, sessionID: string) {
  const prepared = await world.controller.prepareFinalPlan(sessionID);
  const begun = await world.controller.beginProposalApproval(sessionID, prepared.proposal.id);
  return { prepared, begun };
}

/**
 * The Phase 2J ENTRY state (§ entry condition): handoff_pending, exact
 * approved FinalPlan, final commit at HEAD, no runtime side effect yet.
 */
async function handoffPendingWorld(options: { executionAgent?: string; executionModel?: string; withRuntime?: boolean } = {}) {
  const world = makeWorld(options);
  const sessionID = "ses_handoff";
  await dagWorld(world, sessionID);
  await checkpointAndComplete(world, sessionID);
  await checkpointAndComplete(world, sessionID);
  await checkpointAndComplete(world, sessionID);
  await world.controller.beginSynthesis(sessionID);
  await world.controller.submitSynthesisManifest(sessionID, manifestDraft());
  await world.controller.runSemanticValidation(sessionID);
  const finalization = await world.controller.requestFinalization(sessionID);
  expect(finalization.gate.result).toBe("pass");
  const candidate: FinalPlanCandidate = finalization.candidate!.candidate;
  const { prepared, begun } = await prepareAndAwait(world, sessionID);
  await world.controller.recordApproval(sessionID, prepared.proposal.id, begun.request);
  await world.controller.commitApprovedProposal(sessionID, prepared.proposal.id);
  const run = (await world.store.getRun((await world.store.findLatestRunBySession(sessionID) as PlanningRun).id))!;
  expect(run.stage).toBe("final");
  expect(run.lifecycle).toBe("handoff_pending");
  return { ...world, sessionID, runID: run.id, candidate, finalProposal: prepared.proposal, run };
}

// -----------------------------------------------------------------------------
// Freeze preconditions (§17; §145 1-4)
// -----------------------------------------------------------------------------

describe("handoff freeze preconditions (§17)", () => {
  it("§145.1/§145.2: handoff requires lifecycle=handoff_pending + stage=final", async () => {
    const world = await handoffPendingWorld();
    // A non-terminal run is not applicable for recovery at all.
    const activeWorld = makeWorld();
    await admittedStart(activeWorld.controller, "ses_active", GOAL);
    expect(await activeWorld.controller.maybeRecoverHandoff("ses_active")).toBeUndefined();
    // A completed run refuses further freezes (hostile direct call).
    await world.controller.recoverExecutionHandoff(world.sessionID);
    const run = (await world.store.getRun(world.runID)) as PlanningRun;
    const finalPlan = (await world.store.listFinalPlans(world.runID))[0]!;
    const { assembleExecutionHandoff } = await import("../src/index.js");
    const { handoff } = assembleExecutionHandoff({ run, finalPlan, requiredContracts: [], assign: { id: "HANDOFF-002", now: FIXED } });
    await expect(world.store.saveExecutionHandoff(world.runID, handoff)).rejects.toMatchObject({ code: "handoff_not_allowed" });
  });

  it("§145.3: handoff requires the exact FinalPlan; a missing pointer is refused", async () => {
    const world = await handoffPendingWorld();
    const run = (await world.store.getRun(world.runID)) as PlanningRun;
    const assembled = {
      ...(await import("../src/index.js")).assembleExecutionHandoff({
        run,
        finalPlan: (await world.store.listFinalPlans(world.runID))[0]!,
        requiredContracts: [],
        assign: { id: "HANDOFF-001", now: FIXED },
      }).handoff,
    };
    // Bind the handoff to a plan ref the run does not carry (hash resealed —
    // so the ref check itself fires, not the hash recompute).
    const tampered = { ...assembled, finalPlan: { id: "FINAL-002" as never, revision: 9 } };
    await expect(
      world.store.saveExecutionHandoff(world.runID, { ...tampered, hash: computeExecutionHandoffHashFromRecord(tampered) }),
    ).rejects.toMatchObject({ code: "handoff_not_allowed" });
  });

  it("§145.4/§17: a handoff bound to a non-HEAD commit is refused", async () => {
    const world = await handoffPendingWorld();
    const run = (await world.store.getRun(world.runID)) as PlanningRun;
    const finalPlan = (await world.store.listFinalPlans(world.runID))[0]!;
    const { assembleExecutionHandoff } = await import("../src/index.js");
    const { handoff } = assembleExecutionHandoff({
      run,
      finalPlan,
      requiredContracts: [],
      assign: { id: "HANDOFF-001", now: FIXED },
    });
    const tampered = { ...handoff, finalCommit: "COMMIT-001" as never };
    await expect(
      world.store.saveExecutionHandoff(world.runID, { ...tampered, hash: computeExecutionHandoffHashFromRecord(tampered) }),
    ).rejects.toMatchObject({ code: "handoff_not_allowed" });
  });
});

// -----------------------------------------------------------------------------
// Deterministic handoff + idempotency (§8-§16; §145 5-15)
// -----------------------------------------------------------------------------

describe("deterministic ExecutionHandoff (§8-§16)", () => {
  it("§145.5-§145.14: the canonical handoff binds exact refs, contracts, decisions, order, limitations", async () => {
    const world = await handoffPendingWorld();
    const result = await world.controller.recoverExecutionHandoff(world.sessionID);
    expect(result.status).toBe("completed");
    const handoff = (await world.store.findExecutionHandoffForPlan(world.runID))!;
    expect(handoff.id).toBe("HANDOFF-001");
    expect(handoff.sessionID).toBe(world.sessionID);
    expect(handoff.finalPlan).toEqual({ id: "FINAL-001", revision: 1 });
    expect(handoff.architecture).toEqual({ id: "ARCH", revision: 1 });
    expect(handoff.sections).toEqual([
      { id: "SEC-001", revision: 1 },
      { id: "SEC-002", revision: 1 },
      { id: "SEC-003", revision: 1 },
    ]);
    // §11: one exact canonical contract per approved SectionRevision.
    expect(handoff.requiredContracts).toHaveLength(3);
    for (const contract of handoff.requiredContracts) {
      expect(contract.invariants).toEqual(["invariant one"]);
    }
    // §12 documented rule: ALL FinalPlan decision refs (here: none exist).
    expect(handoff.criticalDecisions).toEqual([]);
    expect(handoff.implementationSteps).toHaveLength(1);
    expect(handoff.knownLimitations).toEqual(["The approved design leaves repository freshness to the Evidence Audit."]);
    expect(handoff.goal).toBe(GOAL);
    expect(handoff.validationRequirements.length).toBeGreaterThan(0);
  });

  it("§145.6/§16: repeated freeze returns the SAME handoff — no HANDOFF-002", async () => {
    const world = await handoffPendingWorld();
    const run = (await world.store.getRun(world.runID)) as PlanningRun;
    const finalPlan = (await world.store.listFinalPlans(world.runID))[0]!;
    const { assembleExecutionHandoff } = await import("../src/index.js");
    const first = assembleExecutionHandoff({ run, finalPlan, requiredContracts: [], assign: { id: "HANDOFF-001", now: FIXED } });
    const second = assembleExecutionHandoff({ run, finalPlan, requiredContracts: [], assign: { id: "HANDOFF-001", now: "2099-01-01T00:00:00.000Z" } });
    // createdAt is persistence metadata — excluded from the hash (§15/§16).
    expect(second.handoff.hash).toBe(first.handoff.hash);
    const firstSave = await world.store.saveExecutionHandoff(world.runID, first.handoff);
    expect(firstSave.created).toBe(true);
    const secondSave = await world.store.saveExecutionHandoff(world.runID, second.handoff);
    expect(secondSave.created).toBe(false);
    // The ORIGINAL immutable record is returned (original createdAt).
    expect(secondSave.handoff.createdAt).toBe(firstSave.handoff.createdAt);
    expect((await world.store.findExecutionHandoffForPlan(world.runID))!.hash).toBe(first.handoff.hash);
  });

  it("§125/§15: mutating any authority-bearing field changes the handoff hash", async () => {
    const world = await handoffPendingWorld();
    const run = (await world.store.getRun(world.runID)) as PlanningRun;
    const finalPlan = (await world.store.listFinalPlans(world.runID))[0]!;
    const { assembleExecutionHandoff } = await import("../src/index.js");
    const { handoff } = assembleExecutionHandoff({ run, finalPlan, requiredContracts: [], assign: { id: "HANDOFF-001", now: FIXED } });
    const rehash = (mutate: (payload: ExecutionHandoff) => ExecutionHandoff): string =>
      computeExecutionHandoffHashFromRecord(mutate(structuredClone(handoff)));
    const original = handoff.hash;
    expect(rehash((h) => ({ ...h, finalPlanHash: "moved" }))).not.toBe(original);
    expect(rehash((h) => ({ ...h, sections: [{ id: "SEC-001" as never, revision: 2 }, ...h.sections.slice(1)] }))).not.toBe(original);
    expect(rehash((h) => ({ ...h, implementationSteps: [{ ...h.implementationSteps[0]!, title: "X" }] }))).not.toBe(original);
    expect(rehash((h) => ({ ...h, knownLimitations: ["changed"] }))).not.toBe(original);
    expect(rehash((h) => ({ ...h, goal: "changed goal" }))).not.toBe(original);
    expect(rehash((h) => ({ ...h, architecture: { id: "ARCH", revision: 9 } }))).not.toBe(original);
    expect(rehash((h) => ({ ...h, criticalDecisions: [{ id: "DEC-001" as never, revision: 1 }] }))).not.toBe(original);
    expect(rehash((h) => ({ ...h, hardConstraints: [{ id: "CON-001" as never, source: "user" as const, statement: "x", severity: "hard" as const, status: "active" as const }] }))).not.toBe(original);
    expect(rehash((h) => ({ ...h, validationRequirements: ["different"] }))).not.toBe(original);
  });

  it("§25/§26/§54/§55: the payload renders deterministically with the marker and no reapproval ask", async () => {
    const world = await handoffPendingWorld();
    const { handoff, delivery } = await freezeAndPrepare(world);
    const prompt = renderExecutionHandoffPrompt(world.runID, handoff, delivery.deliveryKey);
    expect(prompt).toContain("ULTRA_PLAN_HANDOFF");
    expect(prompt).toContain(`plan=${world.runID}`);
    expect(prompt).toContain(`handoff=HANDOFF-001`);
    expect(prompt).toContain(`hash=${handoff.hash}`);
    expect(prompt).toContain(`finalPlan=FINAL-001@1`);
    expect(prompt).toContain(`delivery-key=${delivery.deliveryKey}`);
    expect(prompt).toContain("ULTRA PLAN EXECUTION HANDOFF");
    expect(prompt).toContain("ARCH@1");
    expect(prompt).toContain("SEC-001@1");
    expect(prompt).toContain("Known Limitations:");
    expect(prompt).toContain("The approved FinalPlan is the execution authority");
    expect(prompt).toContain("Do not mutate committed Plan Memory.");
    expect(prompt).toContain("does NOT bypass OpenCode sandbox, tool permissions");
    expect(prompt).toContain("do not ask whether to implement");
    expect(renderExecutionHandoffPrompt(world.runID, handoff, delivery.deliveryKey)).toBe(prompt);
  });
});

// -----------------------------------------------------------------------------
// No model-facing handoff authority (§35/§109/§126)
// -----------------------------------------------------------------------------

describe("no model-facing handoff authority (§35/§109/§126)", () => {
  it("no handoff tool exists; recovery takes no model-supplied authority arguments", async () => {
    const { TOOL_CONTRACTS, FORBIDDEN_TOOL_NAMES } = await import("../src/index.js");
    expect(Object.keys(TOOL_CONTRACTS).some((name) => name.toLowerCase().includes("handoff"))).toBe(false);
    void FORBIDDEN_TOOL_NAMES;
    // The coordinator's ONLY input is the trusted runtime session identity.
    const world = await handoffPendingWorld();
    const result = await world.controller.recoverExecutionHandoff(world.sessionID);
    expect(result.status).toBe("completed");
  });
});

// -----------------------------------------------------------------------------
// Primary integration + policy + same-session (§136; §145 17-23, 65)
// -----------------------------------------------------------------------------

describe("primary handoff integration (§136)", () => {
  it("§136/§145.65: handoff_pending → freeze → prepare → dispatch → delivered → completed (one of everything)", async () => {
    const world = await handoffPendingWorld();
    const headBefore = ((await world.store.getRun(world.runID)) as PlanningRun).headCommit;
    const finalPlanBefore = (await world.store.listFinalPlans(world.runID))[0]!;
    const result = await world.controller.recoverExecutionHandoff(world.sessionID);
    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    const run = (await world.store.getRun(world.runID)) as PlanningRun;
    // §106: completed means planning+handoff complete — nothing more.
    expect(run.lifecycle).toBe("completed");
    expect(run.stage).toBe("final");
    // §135/§48: final HEAD never moves during handoff.
    expect(run.headCommit).toBe(headBefore);
    const finalPlanAfter = (await world.store.listFinalPlans(world.runID))[0]!;
    expect(finalPlanAfter).toEqual(finalPlanBefore);
    expect(await world.store.listCommits(world.runID)).toHaveLength(9);
    // Exactly one of everything.
    const handoff = (await world.store.findExecutionHandoffForPlan(world.runID))!;
    const delivery = (await world.store.getHandoffDelivery(world.runID, handoff.id))!;
    expect(delivery.state).toBe("delivered");
    expect(delivery.attempt).toBe(1);
    expect(delivery.hostReceipt?.sessionID).toBe(world.sessionID);
    expect(world.host!.dispatches).toHaveLength(1);
    // §27: planning session == handoff target == Build turn session.
    expect(world.host!.dispatches[0]!.sessionID).toBe(world.sessionID);
    // Events in the §113 order.
    const events = (await world.store.listEvents(world.runID)).map((event) => event.detail.type);
    expect(events.indexOf("handoff.prepared")).toBeLessThan(events.indexOf("handoff.dispatch_started"));
    expect(events.indexOf("handoff.dispatch_started")).toBeLessThan(events.indexOf("handoff.delivered"));
    expect(events.indexOf("handoff.delivered")).toBeLessThan(events.lastIndexOf("run.lifecycle_changed"));
    // §83/§134: recovery on the completed run does nothing.
    const again = await world.controller.recoverExecutionHandoff(world.sessionID);
    expect(again.status).toBe("already_completed");
    expect(world.host!.dispatches).toHaveLength(1);
  });

  it("§145.17-23/§128: execution policy is deterministic; the planning model is never reused", async () => {
    const world = await handoffPendingWorld({ executionAgent: "custom-builder", executionModel: "acme/balanced-9" });
    await world.controller.recoverExecutionHandoff(world.sessionID);
    const dispatch = world.host!.dispatches[0]!;
    expect(dispatch.agent).toBe("custom-builder");
    expect(dispatch.model).toBe("acme/balanced-9");
  });

  it("§30 default: with no configured agent the HOST-NATIVE Build agent is used", async () => {
    const world = await handoffPendingWorld();
    await world.controller.recoverExecutionHandoff(world.sessionID);
    expect(world.host!.dispatches[0]!.agent).toBe("build");
    expect(world.host!.dispatches[0]!.model).toBeUndefined(); // host default model
  });

  it("§145.23/§57/§58/§115: unresolvable runtime policy blocks the handoff (stays pending)", async () => {
    const emptyAgent = await handoffPendingWorld({ executionAgent: "" });
    const result = await emptyAgent.controller.recoverExecutionHandoff(emptyAgent.sessionID);
    expect(result.status).toBe("blocked");
    if (result.status === "blocked") expect(result.code).toBe("execution_policy_unresolved");
    expect(((await emptyAgent.store.getRun(emptyAgent.runID)) as PlanningRun).lifecycle).toBe("handoff_pending");
    expect(emptyAgent.host!.dispatches).toHaveLength(0);

    const badModel = await handoffPendingWorld({ executionModel: "not-a-pair" });
    const result2 = await badModel.controller.recoverExecutionHandoff(badModel.sessionID);
    expect(result2.status).toBe("blocked");
    if (result2.status === "blocked") expect(result2.code).toBe("execution_policy_unresolved");
  });

  it("§115/§116: no runtime adapter bound — the handoff stays pending, never faked", async () => {
    const world = await handoffPendingWorld({ withRuntime: false });
    const result = await world.controller.recoverExecutionHandoff(world.sessionID);
    expect(result.status).toBe("blocked");
    if (result.status === "blocked") expect(result.code).toBe("execution_runtime_unavailable");
    expect(((await world.store.getRun(world.runID)) as PlanningRun).lifecycle).toBe("handoff_pending");
    expect(await world.store.findExecutionHandoffForPlan(world.runID)).toBeUndefined();
  });
});

// -----------------------------------------------------------------------------
// Delivery state machine + failure semantics (§38-§45/§60-§62)
// -----------------------------------------------------------------------------

describe("delivery state machine and failures (§38-§45/§60-§62)", () => {
  it("§38/§145.24: `prepared` exists BEFORE the first dispatch", async () => {
    const world = await handoffPendingWorld();
    const { delivery } = await freezeAndPrepare(world);
    expect(delivery.state).toBe("prepared");
    expect(delivery.hostReceipt).toBeUndefined();
    expect(world.host!.dispatches).toHaveLength(0);
  });

  it("§41/§119/§145.26: dispatch single-flight — the second coordinator never dispatches", async () => {
    const world = await handoffPendingWorld();
    const { handoff } = await freezeAndPrepare(world);
    const first = await world.store.beginHandoffDispatch(world.runID, HandoffIDs.cast(handoff.id));
    expect(first.acquired).toBe(true);
    const second = await world.store.beginHandoffDispatch(world.runID, HandoffIDs.cast(handoff.id));
    expect(second.acquired).toBe(false);
    expect(second.delivery.attempt).toBe(1);
  });

  it("§61/§145.27-28: a definite pre-acceptance rejection stays retryable (prepared)", async () => {
    const world = await handoffPendingWorld();
    world.host!.rejectDefinitely = true;
    const result = await world.controller.recoverExecutionHandoff(world.sessionID);
    expect(result.status).toBe("retryable_failure");
    const delivery = (await world.store.getHandoffDelivery(world.runID, HandoffIDs.cast("HANDOFF-001")))!;
    expect(delivery.state).toBe("prepared");
    expect(((await world.store.getRun(world.runID)) as PlanningRun).lifecycle).toBe("handoff_pending");
    // §61: a later recovery retries.
    world.host!.rejectDefinitely = false;
    const retry = await world.controller.recoverExecutionHandoff(world.sessionID);
    expect(retry.status).toBe("completed");
    expect(world.host!.dispatches).toHaveLength(2);
    expect((await world.store.getHandoffDelivery(world.runID, HandoffIDs.cast("HANDOFF-001")))!.attempt).toBe(2);
  });

  it("§62/§145.29: ambiguous acceptance is NOT retried — and recovery completes exactly once (§130/§137)", async () => {
    const world = await handoffPendingWorld();
    world.host!.failAfterAcceptance = true;
    const first = await world.controller.recoverExecutionHandoff(world.sessionID);
    expect(first.status).toBe("ambiguous");
    expect(((await world.store.getRun(world.runID)) as PlanningRun).lifecycle).toBe("handoff_pending");
    // The host HAS the handoff; local state is dispatching.
    expect(world.host!.dispatches).toHaveLength(1);
    expect((await world.store.getHandoffDelivery(world.runID, HandoffIDs.cast("HANDOFF-001")))!.state).toBe("dispatching");
    // Recovery: query the host FIRST, find the receipt, complete — no resend.
    world.host!.failAfterAcceptance = false;
    const second = await world.controller.recoverExecutionHandoff(world.sessionID);
    expect(second.status).toBe("completed");
    expect(world.host!.dispatches).toHaveLength(1);
    const delivery = (await world.store.getHandoffDelivery(world.runID, HandoffIDs.cast("HANDOFF-001")))!;
    expect(delivery.state).toBe("delivered");
    expect(delivery.attempt).toBe(1);
    expect(((await world.store.getRun(world.runID)) as PlanningRun).lifecycle).toBe("completed");
  });

  it("§132/§145.29: no-query adapters leave ambiguity fail-closed — never resend, never complete", async () => {
    const world = await handoffPendingWorld();
    world.host!.failAmbiguously = true;
    world.host!.failAfterAcceptance = true;
    const first = await world.controller.recoverExecutionHandoff(world.sessionID);
    expect(first.status).toBe("ambiguous");
    world.host!.failAfterAcceptance = false;
    world.host!.querySupported = false;
    const second = await world.controller.recoverExecutionHandoff(world.sessionID);
    expect(second.status).toBe("ambiguous");
    expect(world.host!.dispatches).toHaveLength(1);
    expect(((await world.store.getRun(world.runID)) as PlanningRun).lifecycle).toBe("handoff_pending");
  });

  it("§21/§145.30: the deliveryKey is stable and derives from exact handoff identity", async () => {
    const world = await handoffPendingWorld();
    const { handoff, delivery } = await freezeAndPrepare(world);
    expect(delivery.deliveryKey).toBe(`${world.runID}/HANDOFF-001/${handoff.hash}`);
  });

  it("§22/§145.31-34: receipts are validated — wrong session and empty message id refused", async () => {
    const world = await handoffPendingWorld();
    const { handoff } = await freezeAndPrepare(world);
    await world.store.beginHandoffDispatch(world.runID, HandoffIDs.cast(handoff.id));
    await expect(
      world.store.recordHandoffDelivered(world.runID, handoff.id, { sessionID: "ses_OTHER", messageID: "m1" }),
    ).rejects.toMatchObject({ code: "handoff_session_mismatch" });
    await expect(
      world.store.recordHandoffDelivered(world.runID, handoff.id, { sessionID: world.sessionID, messageID: "" }),
    ).rejects.toMatchObject({ code: "handoff_receipt_invalid" });
    expect((await world.store.getHandoffDelivery(world.runID, handoff.id))!.state).toBe("dispatching");
  });

  it("§45/§82/§93/§145.35: a delivered recovery completes WITHOUT resending", async () => {
    const world = await handoffPendingWorld();
    world.host!.failAfterAcceptance = true;
    await world.controller.recoverExecutionHandoff(world.sessionID);
    world.host!.failAfterAcceptance = false;
    const second = await world.controller.recoverExecutionHandoff(world.sessionID);
    expect(second.status).toBe("completed");
    expect(world.host!.dispatches).toHaveLength(1);
  });

  it("§47: completion preconditions — no receipt → no completion", async () => {
    const world = await handoffPendingWorld();
    // No handoff at all.
    await expect(world.store.completeHandoffRun(world.runID)).rejects.toMatchObject({ code: "handoff_not_allowed" });
    // Prepared (not delivered) delivery — still no completion.
    await freezeAndPrepare(world);
    await expect(world.store.completeHandoffRun(world.runID)).rejects.toMatchObject({ code: "handoff_delivery_ambiguous" });
  });
});

// -----------------------------------------------------------------------------
// Lifecycle completion semantics (§46-§49/§106/§121)
// -----------------------------------------------------------------------------

describe("lifecycle completion semantics (§46-§49)", () => {
  it("§48/§145.37-39: completion creates no commit/snapshot, moves no HEAD, keeps FinalPlan", async () => {
    const world = await handoffPendingWorld();
    const commitsBefore = (await world.store.listCommits(world.runID)).length;
    const snapshotsBefore = (await world.store.listEvents(world.runID)).filter((e) => e.detail.type === "head.moved").length;
    await world.controller.recoverExecutionHandoff(world.sessionID);
    expect((await world.store.listCommits(world.runID)).length).toBe(commitsBefore);
    expect((await world.store.listEvents(world.runID)).filter((e) => e.detail.type === "head.moved")).toHaveLength(snapshotsBefore);
    expect((await world.store.getHeadSnapshot(world.runID))!.state.finalPlanRevision).toBe(1);
  });

  it("§121/§145.48: two completion calls are idempotent — one lifecycle event", async () => {
    const world = await handoffPendingWorld();
    await world.controller.recoverExecutionHandoff(world.sessionID);
    await world.store.completeHandoffRun(world.runID);
    const events = (await world.store.listEvents(world.runID)).filter((e) => e.detail.type === "run.lifecycle_changed");
    expect(events).toHaveLength(2); // active→handoff_pending (2I) + handoff_pending→completed
  });

  it("§49/§145.40: a completed run is terminal — /ultra-plan starts a NEW run", async () => {
    const world = await handoffPendingWorld();
    await world.controller.recoverExecutionHandoff(world.sessionID);
    // handoff_pending resumes; completed does not.
    expect(await world.store.findActiveRunBySession(world.sessionID)).toBeUndefined();
    world.controller.issueStartAdmission(world.sessionID);
    const next = await world.controller.startOrResume(world.sessionID, "Another plan");
    expect(next.created).toBe(true);
    expect(next.run.id).not.toBe(world.runID);
  });
});

// -----------------------------------------------------------------------------
// Corruption / fail-closed (§122-§124; §145 49-53)
// -----------------------------------------------------------------------------

describe("handoff corruption fail-closed (§122-§124)", () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "ultra-plan-2j-"));
    filePath = path.join(dir, "plan.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Drive a real durable run to completed via the coordinator + fake host. */
  async function driveDurableHandoff(): Promise<void> {
    const store = new DurablePlanStore(filePath, { now: () => FIXED });
    const controller = new UltraPlanController({
      store,
      now: () => FIXED,
      semanticValidator: { async validate() { return { text: JSON.stringify({ result: "clean", findings: [] }) }; } },
    });
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
    const { prepared, begun } = await prepareAndAwait({ controller }, sessionID);
    await controller.recordApproval(sessionID, prepared.proposal.id, begun.request);
    await controller.commitApprovedProposal(sessionID, prepared.proposal.id);
    store.close();
  }

  it("§122/§145.49: a tampered handoff hash fails store open", async () => {
    await driveDurableHandoff();
    // Freeze + prepare durably via a definite-rejecting runtime (the delivery
    // is reclaimed to prepared; the handoff artifact persists).
    const store = new DurablePlanStore(filePath, { now: () => FIXED });
    const controller = new UltraPlanController({
      store,
      now: () => FIXED,
      executionRuntime: {
        adapter: {
          async dispatchHandoff() {
            throw new HandoffDispatchRejected("stop before dispatch");
          },
        },
      },
    });
    const result = await controller.recoverExecutionHandoff("ses_dur");
    expect(result.status).toBe("retryable_failure");
    store.close();
    const raw = JSON.parse(await readFile(filePath, "utf8")) as Record<string, Record<string, Record<string, Record<string, unknown>>>>;
    const family = raw["executionHandoffs"]!["PLAN-001"]!;
    const key = Object.keys(family)[0]!;
    (family[key] as Record<string, unknown>)["hash"] = "0".repeat(64);
    await writeFile(filePath, JSON.stringify(raw));
    expect(() => new DurablePlanStore(filePath, { now: () => FIXED }).open()).toThrowError(/does not recompute to its frozen hash/);
  });

  it("§123/§145.51: a delivered delivery without a receipt fails store open", async () => {
    await driveDurableHandoff();
    // Fully complete the handoff with a working fake host.
    const store = new DurablePlanStore(filePath, { now: () => FIXED });
    const controller = new UltraPlanController({
      store,
      now: () => FIXED,
      executionRuntime: {
        adapter: {
          async dispatchHandoff(input) {
            return { accepted: true as const, deliveryKey: input.deliveryKey };
          },
          async findHandoffDelivery(input) {
            return { sessionID: input.sessionID, messageID: "msg_001" };
          },
        },
      },
    });
    expect(await controller.recoverExecutionHandoff("ses_dur")).toMatchObject({ status: "completed" });
    store.close();
    const raw = JSON.parse(await readFile(filePath, "utf8")) as Record<string, Record<string, Record<string, Record<string, unknown>>>>;
    const deliveries = raw["handoffDeliveries"]!["PLAN-001"]!;
    const key = Object.keys(deliveries)[0]!;
    const delivery = deliveries[key] as Record<string, unknown>;
    delete delivery["hostReceipt"];
    await writeFile(filePath, JSON.stringify(raw));
    expect(() => new DurablePlanStore(filePath, { now: () => FIXED }).open()).toThrowError(/no valid host receipt/);
  });

  it("§124/§145.52: a completed run without a delivered handoff fails store open", async () => {
    await driveDurableHandoff();
    const raw = JSON.parse(await readFile(filePath, "utf8")) as Record<string, Record<string, Record<string, unknown>>>;
    raw["runs"]!["PLAN-001"]!["lifecycle"] = "completed";
    await writeFile(filePath, JSON.stringify(raw));
    expect(() => new DurablePlanStore(filePath, { now: () => FIXED }).open()).toThrowError(/no delivered handoff delivery/);
  });
});

// -----------------------------------------------------------------------------
// Status rendering (§66-§70; §145 54-58) + L0 (§71/§72)
// -----------------------------------------------------------------------------

describe("handoff status rendering (§66-§70)", () => {
  it("§145.54-§145.58: pending → prepared → dispatching → delivered → completed", async () => {
    const world = await handoffPendingWorld();
    const run = () => world.store.getRun(world.runID) as Promise<PlanningRun>;

    let status = renderStatus(await run(), {
      finalPlan: { ref: "FINAL-001@1", status: "approved" },
      handoff: { state: "not_prepared", lifecycle: "handoff_pending" },
    });
    expect(status).toContain("Execution handoff: not prepared");
    expect(status).toContain("Build: not started");

    status = renderStatus(await run(), {
      finalPlan: { ref: "FINAL-001@1", status: "approved" },
      handoff: { ref: "HANDOFF-001", state: "prepared", lifecycle: "handoff_pending" },
    });
    expect(status).toContain("Execution handoff: HANDOFF-001 prepared");
    expect(status).toContain("Build transition: pending");

    status = renderStatus(await run(), {
      finalPlan: { ref: "FINAL-001@1", status: "approved" },
      handoff: { ref: "HANDOFF-001", state: "dispatching", lifecycle: "handoff_pending" },
    });
    expect(status).toContain("Execution handoff: HANDOFF-001 dispatching");
    expect(status).toContain("Build delivery: awaiting confirmation");

    status = renderStatus(await run(), {
      finalPlan: { ref: "FINAL-001@1", status: "approved" },
      handoff: { ref: "HANDOFF-001", state: "delivered", lifecycle: "handoff_pending" },
    });
    expect(status).toContain("Execution handoff: HANDOFF-001 delivered");
    expect(status).toContain("Build delivery: confirmed");
    expect(status).toContain("Run completion: pending");

    status = renderStatus({ ...(await run()), lifecycle: "completed" }, {
      finalPlan: { ref: "FINAL-001@1", status: "approved" },
      handoff: { ref: "HANDOFF-001", state: "delivered", lifecycle: "completed" },
    });
    expect(status).toContain("Lifecycle: completed");
    expect(status).toContain("Execution handoff: HANDOFF-001 delivered");
    expect(status).toContain("Build: handoff complete");
  });

  it("§71: handoff_pending L0 says the Harness owns the handoff", () => {
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
    expect(text).toContain("The Final Plan is approved and committed.");
    expect(text).toContain("The run is handoff_pending.");
    expect(text).toContain("The Harness is recovering/completing the runtime Build handoff.");
  });

  it("§72: completed-run context is a compact execution capsule", () => {
    const text = renderPlanningProtocol({
      run: {
        id: "PLAN-001" as never,
        sessionID: "s",
        lifecycle: "completed",
        stage: "final",
        revision: 10,
        goal: { statement: "g" },
        constraints: [],
        sections: [],
        decisions: [],
        openQuestions: [],
        conflicts: [],
        createdAt: FIXED,
        updatedAt: FIXED,
      },
      execution: { finalPlanRef: "FINAL-001@1", handoffRef: "HANDOFF-001" },
    });
    expect(text).toContain("Ultra Plan planning is complete.");
    expect(text).toContain("Approved Final Plan: FINAL-001@1");
    expect(text).toContain("Execution handoff: HANDOFF-001 delivered");
    expect(text).toContain("Plan Memory is available READ-ONLY.");
    expect(text).not.toContain("SYNTHESIS GOAL");
  });
});

// -----------------------------------------------------------------------------
// Reads (§111; §145.63)
// -----------------------------------------------------------------------------

describe("execution handoff reads (§111)", () => {
  it("plan_memory kind=execution_handoff resolves the exact record", async () => {
    const world = await handoffPendingWorld();
    await world.controller.recoverExecutionHandoff(world.sessionID);
    const run = (await world.store.getRun(world.runID)) as PlanningRun;
    const read = await world.controller.readMemoryForRun(run, { ref: { kind: "execution_handoff", id: "HANDOFF-001" } });
    const handoff = read.artifacts[0]?.artifact as ExecutionHandoff;
    expect(handoff.id).toBe("HANDOFF-001");
    expect(handoff.hash).toBe(computeExecutionHandoffHashFromRecord(handoff));
  });
});

// -----------------------------------------------------------------------------
// Restart recovery through the RESUME path (§35/§78/§117/§118)
// -----------------------------------------------------------------------------

describe("restart recovery via the resume path (§78/§117)", () => {
  it("a handoff_pending run resumed by /ultra-plan performs the runtime handoff", async () => {
    const world = await handoffPendingWorld();
    // Simulate a restart: a FRESH controller (new process equivalent) bound
    // to the same store + runtime, driven through startOrResume.
    const restarted = new UltraPlanController({
      store: world.store,
      now: () => FIXED,
      executionRuntime: { adapter: world.host! },
    });
    restarted.issueStartAdmission(world.sessionID);
    const result = await restarted.startOrResume(world.sessionID);
    expect(result.handoff?.status).toBe("completed");
    expect(((await world.store.getRun(world.runID)) as PlanningRun).lifecycle).toBe("completed");
    expect(world.host!.dispatches).toHaveLength(1);
  });
});
