/**
 * Phase 2G — Read-only Semantic Validation & Section Reopen Admission.
 *
 * Covers: the frozen validator protocol and strict output parsing (§16/§17/§67),
 * structural report validation incl. the §13 clean-forbidden rule (§23),
 * the report hash with golden coverage (§24), the anti-laundering rule (§25/§66),
 * execution failure ≠ findings (§26), the primary findings → reopen → rework
 * integration loop (§76) and the clean integration (§77), reopen admission
 * gates (§41/§53), the dependency-review reopen (§49/§50/§71), reopened
 * checkpointing (§46/§47/§70), plan_memory reads (§59), status (§57), L0
 * guidance (§58), normative boundaries (§54/§55/§60), and the durable
 * restart/corruption/concurrency behavior (§30/§64/§74/§75).
 */
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DurablePlanStore,
  InMemoryPlanStore,
  SEMANTIC_VALIDATION_PROTOCOL,
  computeProposalHash,
  computeValidationReportHash,
  isUltraPlanError,
  parseValidatorOutput,
  renderPlanningProtocol,
  validateValidatorOutput,
} from "../src/index.js";
import type {
  PlanCommit,
  PlanningRun,
  Proposal,
  SectionCheckpointInput,
  SemanticValidator,
  SynthesisInput,
  SynthesisManifest,
  SynthesisManifestDraftInput,
  ValidationReport,
} from "../src/index.js";
import { UltraPlanController } from "../src/core/controller.js";
import { admittedStart } from "./helpers.js";

const FIXED = "2026-09-25T12:00:00.000Z";
const GOAL = "Build the durable planning harness";

// -----------------------------------------------------------------------------
// World builders (same real-flow drive as the Phase 2F suite)
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

async function dagWorld(world: ReturnType<typeof makeWorld> = makeWorld(), sessionID = "ses_val") {
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

async function checkpointActive(world: ReturnType<typeof makeWorld>, sessionID: string): Promise<void> {
  const run = (await world.store.findActiveRunBySession(sessionID)) as PlanningRun;
  const active = run.activeWork?.type === "section" ? run.activeWork.id : undefined;
  if (!active) throw new Error("no active section");
  const prepared = await world.controller.prepareSectionCheckpoint(sessionID, checkpointInput(active as "SEC-001"));
  const begun = await world.controller.beginProposalApproval(sessionID, prepared.proposal.id);
  await world.controller.recordApprovalAndCommit(sessionID, prepared.proposal.id, begun.request);
}

async function checkpointAndComplete(world: ReturnType<typeof makeWorld>, sessionID: string): Promise<PlanCommit> {
  await checkpointActive(world, sessionID);
  const prepared = await world.controller.requestCompletion(sessionID, { kind: "section" });
  const begun = await world.controller.beginProposalApproval(sessionID, prepared.proposal.id);
  return (await world.controller.recordApprovalAndCommit(sessionID, prepared.proposal.id, begun.request)).commit;
}

async function synWorld(world: ReturnType<typeof makeWorld> = makeWorld(), sessionID = "ses_val") {
  await dagWorld(world, sessionID);
  await checkpointAndComplete(world, sessionID);
  await checkpointAndComplete(world, sessionID);
  await checkpointAndComplete(world, sessionID);
  const run = (await world.store.findActiveRunBySession(sessionID)) as PlanningRun;
  expect(run.stage).toBe("synthesis");
  expect(run.activeWork).toBeUndefined();
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

/** Drive the full chain to synthesis with a frozen input and a manifest@1. */
async function manifestWorld(validator?: SemanticValidator) {
  const world = await synWorld(makeWorld(undefined, validator));
  await world.controller.beginSynthesis("ses_val");
  await world.controller.submitSynthesisManifest("ses_val", manifestDraft());
  return world;
}

/** Scripted fake validator — deterministic test double (§10: fakes only in tests). */
function fakeValidator(outputs: string[]) {
  const state = { calls: 0, capsules: [] as string[] };
  const validator: SemanticValidator = {
    async validate(capsule: string) {
      state.calls += 1;
      state.capsules.push(capsule);
      const output = outputs[Math.min(state.calls - 1, outputs.length - 1)];
      return { text: output ?? "{}" };
    },
  };
  return { validator, state };
}

const CLEAN_OUTPUT = JSON.stringify({ result: "clean", findings: [] });

/** A contradiction finding scoped to the exact SEC-002@1 revision. */
function contradictionOutput(statement = "The manifest claims SEC-002 allows in-place mutation, contradicting its approved invariants."): string {
  return JSON.stringify({
    result: "findings",
    findings: [
      {
        category: "contradiction",
        statement,
        scope: { sections: [{ id: "SEC-002", revision: 1 }] },
        manifestItem: { kind: "cross_section_link", index: 1 },
        sources: [{ kind: "section", id: "SEC-002", revision: 1 }],
      },
    ],
  });
}

async function expectErrorCode(promise: Promise<unknown>, code: string): Promise<never | void> {
  try {
    await promise;
  } catch (error) {
    expect(isUltraPlanError(error)).toBe(true);
    expect((error as { code: string }).code).toBe(code);
    return;
  }
  throw new Error(`expected error code ${code}`);
}

// -----------------------------------------------------------------------------
// Strict parser (§17/§67) — no permissive fallback
// -----------------------------------------------------------------------------

describe("strict validator output parsing (§17/§67)", () => {
  it("accepts a strict findings document (exact shape round-trip)", () => {
    const draft = parseValidatorOutput(contradictionOutput());
    expect(draft.result).toBe("findings");
    expect(draft.findings).toHaveLength(1);
    const finding = draft.findings[0];
    expect(finding?.category).toBe("contradiction");
    expect(finding?.scope.sections?.[0]).toEqual({ id: "SEC-002", revision: 1 });
    expect(finding?.manifestItem).toEqual({ kind: "cross_section_link", index: 1 });
  });

  it("accepts a strict clean document (§19: clean is a result, never a finding)", () => {
    const draft = parseValidatorOutput(CLEAN_OUTPUT);
    expect(draft.result).toBe("clean");
    expect(draft.findings).toEqual([]);
  });

  it("rejects markdown-fenced JSON", () => {
    const fenced = "```json\n" + CLEAN_OUTPUT + "\n```";
    expectErrorCode(Promise.resolve().then(() => parseValidatorOutput(fenced)), "validation_output_invalid");
  });

  it("rejects leading commentary and trailing commentary", () => {
    expectErrorCode(Promise.resolve().then(() => parseValidatorOutput(`Here is my report: ${CLEAN_OUTPUT}`)), "validation_output_invalid");
    expectErrorCode(Promise.resolve().then(() => parseValidatorOutput(`${CLEAN_OUTPUT} — hope that helps!`)), "validation_output_invalid");
  });

  it("rejects duplicate keys", () => {
    const duplicate = '{"result":"clean","result":"findings","findings":[]}';
    expectErrorCode(Promise.resolve().then(() => parseValidatorOutput(duplicate)), "validation_output_invalid");
  });

  it("rejects unknown fields (top-level and per-finding)", () => {
    expectErrorCode(
      Promise.resolve().then(() => parseValidatorOutput('{"result":"clean","findings":[],"verdict":"ok"}')),
      "validation_output_invalid",
    );
    expectErrorCode(
      Promise.resolve().then(() =>
        parseValidatorOutput(
          '{"result":"findings","findings":[{"id":"VF-001","category":"contradiction","statement":"s","scope":{"sections":[{"id":"SEC-001","revision":1}]}}]}',
        ),
      ),
      "validation_output_invalid",
    );
  });

  it("rejects invalid result enum and invalid finding category", () => {
    expectErrorCode(
      Promise.resolve().then(() => parseValidatorOutput('{"result":"valid","findings":[]}')),
      "validation_output_invalid",
    );
    expectErrorCode(
      Promise.resolve().then(() =>
        parseValidatorOutput('{"result":"findings","findings":[{"category":"clean","statement":"s","scope":{"architecture":{"id":"ARCH","revision":1}}}]}'),
      ),
      "validation_output_invalid",
    );
  });

  it("rejects clean-with-findings and findings-with-empty-array", () => {
    expectErrorCode(
      Promise.resolve().then(() =>
        parseValidatorOutput(
          '{"result":"clean","findings":[{"category":"contradiction","statement":"s","scope":{"architecture":{"id":"ARCH","revision":1}}}]}',
        ),
      ),
      "validation_output_invalid",
    );
    expectErrorCode(
      Promise.resolve().then(() => parseValidatorOutput('{"result":"findings","findings":[]}')),
      "validation_output_invalid",
    );
  });

  it("rejects malformed section refs, manifest-item refs, and non-integer revisions", () => {
    const malformedSection =
      '{"result":"findings","findings":[{"category":"coverage_gap","statement":"s","scope":{"sections":[{"id":"SEC-001"}]}}]}';
    const malformedItem =
      '{"result":"findings","findings":[{"category":"coverage_gap","statement":"s","scope":{"architecture":{"id":"ARCH","revision":1}},"manifestItem":{"kind":"cross_section_link","order":1}}]}';
    const zeroIndex =
      '{"result":"findings","findings":[{"category":"coverage_gap","statement":"s","scope":{"architecture":{"id":"ARCH","revision":1}},"manifestItem":{"kind":"limitation","index":0}}]}';
    const floatRevision =
      '{"result":"findings","findings":[{"category":"coverage_gap","statement":"s","scope":{"sections":[{"id":"SEC-001","revision":1.5}]}}]}';
    for (const raw of [malformedSection, malformedItem, zeroIndex, floatRevision]) {
      expectErrorCode(Promise.resolve().then(() => parseValidatorOutput(raw)), "validation_output_invalid");
    }
  });

  it("rejects empty statements, scope-less findings, NaN/Infinity, and embedded JSON", () => {
    expectErrorCode(
      Promise.resolve().then(() =>
        parseValidatorOutput('{"result":"findings","findings":[{"category":"coverage_gap","statement":"  ","scope":{"architecture":{"id":"ARCH","revision":1}}}]}'),
      ),
      "validation_output_invalid",
    );
    expectErrorCode(
      Promise.resolve().then(() => parseValidatorOutput('{"result":"findings","findings":[{"category":"coverage_gap","statement":"s"}]}')),
      "validation_output_invalid",
    );
    expectErrorCode(
      Promise.resolve().then(() => parseValidatorOutput('{"result":"clean","findings":[],"note":NaN}')),
      "validation_output_invalid",
    );
    expectErrorCode(
      Promise.resolve().then(() => parseValidatorOutput('The JSON is {"result":"clean","findings":[]} as requested')),
      "validation_output_invalid",
    );
  });
});

// -----------------------------------------------------------------------------
// Structural report validation (§13/§23)
// -----------------------------------------------------------------------------

describe("structural validator-output validation (§13/§23)", () => {
  it("rejects scope sections outside the frozen input and architecture revision mismatches", async () => {
    const { controller } = await manifestWorld();
    const input = (await controller.planStore.getLatestSynthesisInput("PLAN-001" as never)) as SynthesisInput;
    const manifest = (await controller.planStore.getSynthesisManifest("PLAN-001" as never, "SYN-001" as never)) as SynthesisManifest;
    const draft = parseValidatorOutput(
      JSON.stringify({
        result: "findings",
        findings: [
          { category: "coverage_gap", statement: "s", scope: { sections: [{ id: "SEC-002", revision: 2 }] } },
        ],
      }),
    );
    expectErrorCode(Promise.resolve().then(() => validateValidatorOutput(draft, input, manifest)), "validation_output_invalid");
    const archDraft = parseValidatorOutput(
      JSON.stringify({
        result: "findings",
        findings: [{ category: "coverage_gap", statement: "s", scope: { architecture: { id: "ARCH", revision: 9 } } }],
      }),
    );
    expectErrorCode(Promise.resolve().then(() => validateValidatorOutput(archDraft, input, manifest)), "validation_output_invalid");
  });

  it("rejects manifest-item references that do not exist (§21 closed locators)", async () => {
    const { controller } = await manifestWorld();
    const input = (await controller.planStore.getLatestSynthesisInput("PLAN-001" as never)) as SynthesisInput;
    const manifest = (await controller.planStore.getSynthesisManifest("PLAN-001" as never, "SYN-001" as never)) as SynthesisManifest;
    const badLink = parseValidatorOutput(
      JSON.stringify({
        result: "findings",
        findings: [
          { category: "contradiction", statement: "s", scope: { sections: [{ id: "SEC-001", revision: 1 }] }, manifestItem: { kind: "cross_section_link", index: 5 } },
        ],
      }),
    );
    expectErrorCode(Promise.resolve().then(() => validateValidatorOutput(badLink, input, manifest)), "validation_output_invalid");
    const badStep = parseValidatorOutput(
      JSON.stringify({
        result: "findings",
        findings: [
          { category: "coverage_gap", statement: "s", scope: { architecture: { id: "ARCH", revision: 1 } }, manifestItem: { kind: "implementation_step", order: 3 } },
        ],
      }),
    );
    expectErrorCode(Promise.resolve().then(() => validateValidatorOutput(badStep, input, manifest)), "validation_output_invalid");
  });

  it("fails closed on clean while the manifest declares unresolved findings (§13)", async () => {
    const world = await synWorld(makeWorld());
    await world.controller.beginSynthesis("ses_val");
    const draftWithFinding = { ...manifestDraft(), unresolvedFindings: [{ category: "missing_design", statement: "Recovery design is missing." }] };
    await world.controller.submitSynthesisManifest("ses_val", draftWithFinding);
    const input = (await world.store.getLatestSynthesisInput("PLAN-001" as never)) as SynthesisInput;
    const manifest = (await world.store.getSynthesisManifest("PLAN-001" as never, "SYN-001" as never)) as SynthesisManifest;
    const clean = parseValidatorOutput(CLEAN_OUTPUT);
    expectErrorCode(Promise.resolve().then(() => validateValidatorOutput(clean, input, manifest)), "validation_output_invalid");
    // The manifest itself was accepted as structurally valid (the submit above
    // succeeded) — only the clean REPORT is forbidden while findings are declared.
    expect(manifest.unresolvedFindings).toHaveLength(1);
  });
});

// -----------------------------------------------------------------------------
// Report hash (§24) — golden + mutation matrix
// -----------------------------------------------------------------------------

const GOLDEN_FINDINGS = [
  {
    id: "VF-001" as never,
    category: "contradiction" as const,
    statement: "The manifest claims SEC-002 supports state mutation, contradicting the approved invariants.",
    scope: { sections: [{ id: "SEC-002" as never, revision: 1 }] },
    manifestItem: { kind: "cross_section_link" as const, index: 1 },
    sources: [{ kind: "section" as const, id: "SEC-002" as never, revision: 1 }],
  },
];

function goldenHashPayload(overrides: Partial<Parameters<typeof computeValidationReportHash>[0]> = {}) {
  return {
    planID: "PLAN-001" as never,
    input: { id: "SYN-IN-001" as never },
    inputHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    manifest: { id: "SYN-001" as never, revision: 1 },
    manifestHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    baseSnapshot: { id: "SNAP-009" as never },
    validatorProtocol: "semantic-validation:v1",
    result: "findings" as const,
    findings: GOLDEN_FINDINGS,
    ...overrides,
  };
}

describe("ValidationReport hash (§24)", () => {
  it("computes the documented canonical hash (golden)", () => {
    expect(computeValidationReportHash(goldenHashPayload())).toBe(
      "286dc2a5755d46ab1123af6df8921841961e2bd9698355d48e3309f95bfc373b",
    );
  });

  it("changes with every semantic content mutation (§24 mutation matrix)", () => {
    const golden = computeValidationReportHash(goldenHashPayload());
    const mutations = [
      goldenHashPayload({ result: "clean" as const, findings: [] }),
      goldenHashPayload({ inputHash: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" }),
      goldenHashPayload({ manifestHash: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd" }),
      goldenHashPayload({ baseSnapshot: { id: "SNAP-010" as never } }),
      goldenHashPayload({ validatorProtocol: "semantic-validation:v2" }),
      goldenHashPayload({ validatorModel: "test/model" }),
      goldenHashPayload({
        findings: [
          {
            ...GOLDEN_FINDINGS[0]!,
            id: "VF-009" as never,
          },
        ],
      }),
      goldenHashPayload({
        findings: [
          {
            ...GOLDEN_FINDINGS[0]!,
            category: "missing_design" as const,
          },
        ],
      }),
      goldenHashPayload({
        findings: [
          {
            ...GOLDEN_FINDINGS[0]!,
            statement: "A different statement.",
          },
        ],
      }),
      goldenHashPayload({
        findings: [
          {
            ...GOLDEN_FINDINGS[0]!,
            scope: { sections: [{ id: "SEC-003" as never, revision: 1 }] },
          },
        ],
      }),
      goldenHashPayload({
        findings: [{ ...GOLDEN_FINDINGS[0]!, sources: [{ kind: "architecture" as const }] }],
      }),
    ];
    for (const [index, mutated] of mutations.entries()) {
      expect(computeValidationReportHash(mutated)).not.toBe(`#${index} unchanged`);
      expect(computeValidationReportHash(mutated)).not.toBe(golden);
    }
  });
});

// -----------------------------------------------------------------------------
// Primary integration: findings → sanctioned reopen → rework loop (§76)
// -----------------------------------------------------------------------------

describe("semantic validation flow (§76/§77 primary integrations)", () => {
  it("persists a findings report without mutating anything; stage stays synthesis (§76 part 1)", async () => {
    const { validator, state } = fakeValidator([contradictionOutput()]);
    const world = await manifestWorld(validator);
    const runBefore = (await world.store.getRun("PLAN-001" as never)) as PlanningRun;
    const commitsBefore = (await world.store.listCommits("PLAN-001" as never)).length;

    const result = await world.controller.runSemanticValidation("ses_val");
    expect(result.idempotent).toBe(false);
    const report = result.report;
    expect(report.id).toBe("VAL-001");
    expect(report.result).toBe("findings");
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.id).toBe("VF-001");
    expect(report.findings[0]?.scope.sections?.[0]).toEqual({ id: "SEC-002", revision: 1 });
    expect(report.manifest).toEqual({ id: "SYN-001", revision: 1 });
    expect(report.input.id).toBe("SYN-IN-001");
    expect(report.validatorProtocol).toBe("semantic-validation:v1");
    // Hash-bound: recomputes from the stored content.
    const stored = await world.store.getValidationReport("PLAN-001" as never, report.id);
    expect(stored).toEqual(report);
    // Nothing mutated: stage, HEAD, commit chain unchanged; zero new commits.
    const runAfter = (await world.store.getRun("PLAN-001" as never)) as PlanningRun;
    expect(runAfter.stage).toBe("synthesis");
    expect(runAfter.headSnapshot).toBe(runBefore.headSnapshot);
    expect(runAfter.headCommit).toBe(runBefore.headCommit);
    expect((await world.store.listCommits("PLAN-001" as never)).length).toBe(commitsBefore);
    // The validator received exactly the deterministic capsule.
    expect(state.calls).toBe(1);
    expect(state.capsules[0]).toContain("SEMANTIC VALIDATION CAPSULE");
    expect(state.capsules[0]).toContain("SYN-IN-001");
    expect(state.capsules[0]).toContain("SEC-002@1 — Plan Memory");
    // The report is an audit event, not a commit event.
    const events = (await world.store.listEvents("PLAN-001" as never)).map((event) => event.detail.type);
    expect(events).toContain("validation.report_saved");
  });

  it("anti-laundering (§66): the same exact identity returns the SAME findings report without re-invoking the validator", async () => {
    const { validator, state } = fakeValidator([contradictionOutput()]);
    const world = await manifestWorld(validator);
    const first = await world.controller.runSemanticValidation("ses_val");
    expect(state.calls).toBe(1);
    const second = await world.controller.runSemanticValidation("ses_val");
    expect(state.calls).toBe(1); // validator NOT invoked again
    expect(second.idempotent).toBe(true);
    expect(second.report).toEqual(first.report);
    // A different manifest revision creates a NEW identity → new validation.
    const revised: SynthesisManifestDraftInput = { ...manifestDraft(), limitations: [{ statement: "Revised limitation with new content.", sources: [{ kind: "architecture" as const }] }] };
    await world.controller.submitSynthesisManifest("ses_val", revised);
    const third = await world.controller.runSemanticValidation("ses_val");
    expect(state.calls).toBe(2);
    expect(third.idempotent).toBe(false);
    expect(third.report.id).toBe("VAL-002");
    expect(third.report.manifest.revision).toBe(2);
    // The old report stays immutable and readable.
    expect((await world.store.getValidationReport("PLAN-001" as never, first.report.id))?.hash).toBe(first.report.hash);
  });

  it("clean integration (§77): clean report, no mutation, no FinalPlan, request_synthesis unavailable", async () => {
    const { validator, state } = fakeValidator([CLEAN_OUTPUT]);
    const world = await manifestWorld(validator);
    const commitsBefore = (await world.store.listCommits("PLAN-001" as never)).length;
    const result = await world.controller.runSemanticValidation("ses_val");
    expect(result.report.result).toBe("clean");
    expect(result.report.findings).toEqual([]);
    expect(state.calls).toBe(1);
    const run = (await world.store.getRun("PLAN-001" as never)) as PlanningRun;
    expect(run.stage).toBe("synthesis");
    expect((await world.store.listCommits("PLAN-001" as never)).length).toBe(commitsBefore);
    expect(run.finalPlan).toBeUndefined();
    expect(run.headCommit).toBe("COMMIT-008");
    // Idempotent retrieval does not re-invoke the validator.
    const again = await world.controller.runSemanticValidation("ses_val");
    expect(state.calls).toBe(1);
    expect(again.idempotent).toBe(true);
    expect(again.report).toEqual(result.report);
  });

  it("execution failure ≠ findings (§26): a rejected output persists nothing and stays retryable", async () => {
    const { validator, state } = fakeValidator(["I think the plan looks great — clean!"]);
    const world = await manifestWorld(validator);
    await expectErrorCode(world.controller.runSemanticValidation("ses_val"), "validation_output_invalid");
    expect(await world.store.listValidationReports("PLAN-001" as never)).toHaveLength(0);
    // Retry with a valid output succeeds (the failure was not persisted as findings).
    const { validator: retryValidator } = fakeValidator([CLEAN_OUTPUT]);
    const retryWorld = makeWorld(world.store, retryValidator);
    const result = await retryWorld.controller.runSemanticValidation("ses_val");
    expect(result.report.result).toBe("clean");
    expect(state.calls).toBe(1);
  });

  it("fails honestly without a bound validator (§10) and on a stale input (§12)", async () => {
    const world = await manifestWorld();
    await expectErrorCode(world.controller.runSemanticValidation("ses_val"), "validator_unavailable");
    // Stale input: move HEAD with a hostile-but-legal commit, then validation must refuse.
    const { validator } = fakeValidator([CLEAN_OUTPUT]);
    const hostile = makeWorld(world.store, validator);
    // (simulate the HEAD movement via a direct engine commit)
    const run = (await world.store.findActiveRunBySession("ses_val")) as PlanningRun;
    const proposal: Proposal = {
      id: "PROP-STALE" as never,
      type: "amendment",
      scope: { id: "ARCH", revision: 1 },
      revision: 1,
      status: "awaiting_approval",
      title: "stale",
      summary: "moves HEAD",
      changes: [
        {
          kind: "add_decision",
          decision: {
            id: "DEC-STALE" as never,
            revision: 1,
            status: "approved",
            approvedAt: FIXED,
            title: "Stale",
            statement: "s",
            rationale: "r",
            scope: {},
          },
        },
      ] as never,
      dependencies: [],
      impact: { affectedSections: [], affectedDecisions: [] },
      createdFrom: { id: run.headSnapshot as never },
    };
    const frozen = { ...proposal, hash: computeProposalHash(proposal) };
    await world.store.saveProposal(run.id, frozen);
    const approval = await world.store.saveApproval(run.id, {
      id: "APPR-STALE" as never,
      proposalID: frozen.id,
      proposalRevision: 1,
      proposalHash: frozen.hash as string,
      actor: "user",
      createdAt: FIXED,
    });
    await world.store.commitTransaction({ planID: run.id, proposalID: frozen.id, approvalID: approval.id });
    await expectErrorCode(hostile.controller.runSemanticValidation("ses_val"), "synthesis_input_stale");
  });

  it("reports are read through plan_memory by exact id only (§59)", async () => {
    const { validator } = fakeValidator([contradictionOutput()]);
    const world = await manifestWorld(validator);
    const result = await world.controller.runSemanticValidation("ses_val");
    const read = await world.controller.readMemory("ses_val", { ref: { kind: "validation_report", id: result.report.id } });
    expect(read.artifacts[0]?.artifact).toEqual(result.report);
    await expectErrorCode(
      world.controller.readMemory("ses_val", { ref: { kind: "validation_report", id: "VAL-999" } }),
      "unknown_reference",
    );
  });

  it("status renders the four validation states; never 'Final: ready' (§57)", async () => {
    const { validator } = fakeValidator([contradictionOutput()]);
    const world = await manifestWorld(validator);
    // Before validation: not run.
    let status = await world.controller.statusOf("ses_val");
    expect(status).toContain("Semantic validation: not run");
    expect(status).not.toContain("Final:");
    // Running admission surfaces.
    const pairInput = await world.store.getLatestSynthesisInput("PLAN-001" as never);
    const manifest = await world.store.getSynthesisManifest("PLAN-001" as never, "SYN-001" as never);
    await world.store.admitSemanticValidation(
      "PLAN-001" as never,
      {
        inputID: pairInput!.id,
        inputHash: pairInput!.hash,
        manifestID: manifest!.id,
        manifestRevision: manifest!.revision,
        manifestHash: manifest!.hash,
        validatorProtocol: SEMANTIC_VALIDATION_PROTOCOL,
      },
      { now: FIXED, ttlMs: 60_000 },
    );
    status = await world.controller.statusOf("ses_val");
    expect(status).toContain("Semantic validation: running");
    await world.store.releaseSemanticValidation("PLAN-001" as never, `${pairInput!.hash}|${manifest!.hash}|${SEMANTIC_VALIDATION_PROTOCOL}`);
    // Findings.
    await world.controller.runSemanticValidation("ses_val");
    status = await world.controller.statusOf("ses_val");
    expect(status).toContain("Semantic validation: findings");
    expect(status).toContain("Validation report: VAL-001");
    expect(status).toContain("Findings: 1");
    expect(status).toContain("Reopen: available");
    expect(status).not.toContain("Final: ready");
    // Clean (new identity).
    const revised: SynthesisManifestDraftInput = { ...manifestDraft(), limitations: [{ statement: "Another limitation for the clean case.", sources: [{ kind: "architecture" as const }] }] };
    const { validator: cleanValidator } = fakeValidator([CLEAN_OUTPUT]);
    const cleanWorld = makeWorld(world.store, cleanValidator);
    await cleanWorld.controller.submitSynthesisManifest("ses_val", revised);
    await cleanWorld.controller.runSemanticValidation("ses_val");
    status = await cleanWorld.controller.statusOf("ses_val");
    expect(status).toContain("Semantic validation: clean");
    expect(status).toContain("Validation report: VAL-002");
    expect(status).toContain("Finalization: not run");
    expect(status).not.toContain("Final: ready");
  });

  it("L0 guidance pins the three validation fragments verbatim (§58)", async () => {
    const synthesisRun = {
      id: "PLAN-001" as never,
      sessionID: "ses_l0",
      lifecycle: "active" as const,
      stage: "synthesis" as const,
      revision: 1,
      goal: { statement: GOAL },
      constraints: [],
      sections: [{ id: "SEC-001" as never }],
      decisions: [],
      openQuestions: [],
      conflicts: [],
      createdAt: FIXED,
      updatedAt: FIXED,
    };
    const base = {
      inputID: "SYN-IN-001",
      baseSnapshot: "SNAP-009",
      inputHash: "a".repeat(64),
      manifestRef: "SYN-001@1",
      manifestHash: "b".repeat(64),
    };
    const unvalidated = renderPlanningProtocol({ run: synthesisRun, synthesis: { ...base } });
    expect(unvalidated).toContain(
      "The current SynthesisManifest is structurally valid but has not received semantic validation.",
    );
    expect(unvalidated).toContain("Request semantic validation.");
    expect(unvalidated).toContain("Do not self-declare the Manifest clean.");
    const findings = renderPlanningProtocol({ run: synthesisRun, synthesis: { ...base, validationResult: "findings" } });
    expect(findings).toContain("Semantic validation found blocking issues.");
    expect(findings).toContain("Inspect the immutable ValidationReport.");
    expect(findings).toContain("If approved design must change, request sanctioned Section reopen");
    expect(findings).toContain("Do not edit approved design from Synthesis.");
    const clean = renderPlanningProtocol({ run: synthesisRun, synthesis: { ...base, validationResult: "clean" } });
    // Phase 2H §58: the clean fragment now points at deterministic
    // finalization (the gate exists; the model may only REQUEST it).
    expect(clean).toContain("Semantic validation is clean.");
    expect(clean).toContain("You may request deterministic finalization.");
    expect(clean).toContain("- current reachable Evidence audit");
    expect(clean).toContain("You cannot bypass these checks.");
    expect(clean).toContain("- [x] request_finalization");
  });
});

// -----------------------------------------------------------------------------
// Reopen admission (§37-§53, §69)
// -----------------------------------------------------------------------------

describe("sanctioned section reopen (§69 admission matrix)", () => {
  async function findingsWorld() {
    const { validator } = fakeValidator([contradictionOutput()]);
    const world = await manifestWorld(validator);
    await world.controller.runSemanticValidation("ses_val");
    return world;
  }

  it("1-2: a findings report reopens the exact affected approved section through approval", async () => {
    const world = await findingsWorld();
    const report = (await world.store.getCurrentValidationReport("PLAN-001" as never)) as ValidationReport;
    const prepared = await world.controller.requestReopen("ses_val", {
      sectionID: "SEC-002",
      findingIDs: [report.findings[0]?.id ?? "VF-001"],
    });
    expect(prepared.proposal.type).toBe("amendment");
    expect(prepared.proposal.scope).toEqual({ id: "SEC-002" });
    const change = prepared.proposal.changes[0];
    expect(change?.kind).toBe("reopen_section");
    if (change?.kind !== "reopen_section") return;
    // 5: the model cannot provide the revision — the Harness binds @1.
    expect(change.target).toEqual({ id: "SEC-002", revision: 1 });
    // 8-9: exact report hash + finding ids bound in the hashed payload.
    expect(change.reason).toMatchObject({ type: "semantic_validation", reportID: report.id, reportHash: report.hash });
    // Section untouched until approval (6).
    const root = await world.store.getSection("PLAN-001" as never, "SEC-002" as never);
    expect(root?.status).toBe("approved");
    // Approve → atomic reopen commit (10-15).
    const begun = await world.controller.beginProposalApproval("ses_val", prepared.proposal.id);
    const result = await world.controller.recordApprovalAndCommit("ses_val", prepared.proposal.id, begun.request);
    expect(result.run?.stage).toBe("detail");
    expect(result.run?.activeWork).toEqual({ type: "section", id: "SEC-002" });
    const reopened = await world.store.getSection("PLAN-001" as never, "SEC-002" as never);
    expect(reopened?.status).toBe("reopened");
    expect(reopened?.validation).toBe("needs_review");
    // 12-13: pointers unchanged; 16: no new revision; 17: old revision immutable.
    expect(reopened?.currentRevision).toBe(1);
    expect(reopened?.approvedRevision).toBe(1);
    expect((await world.store.listCommits("PLAN-001" as never)).length).toBe(9);
    const revision = await world.store.getSectionRevision("PLAN-001" as never, { id: "SEC-002" as never, revision: 1 });
    expect(revision?.design).toBe("Design SEC-002");
    expect(revision?.projection.contract.revision).toBe(1);
    // 18: exact retry is idempotent.
    const retry = await world.controller.commitApprovedProposal("ses_val", prepared.proposal.id);
    expect(retry.commit.id).toBe(result.commit.id);
    // §51: the report is not mutated by the reopen — still findings, still current history.
    expect((await world.store.getValidationReport("PLAN-001" as never, report.id))?.result).toBe("findings");
  });

  it("1: a clean report cannot authorize a reopen", async () => {
    const { validator } = fakeValidator([CLEAN_OUTPUT]);
    const world = await manifestWorld(validator);
    await world.controller.runSemanticValidation("ses_val");
    // The clean substate does not grant request_reopen at all (§35) — a clean
    // report cannot authorize a reopen, and nothing needs to be reopened.
    await expectErrorCode(
      world.controller.requestReopen("ses_val", { sectionID: "SEC-002", findingIDs: ["VF-001"] }),
      "capability_not_available",
    );
  });

  it("3 + §53: a section no finding affects is rejected — architecture findings stay blocking", async () => {
    const world = await findingsWorld();
    const report = (await world.store.getCurrentValidationReport("PLAN-001" as never)) as ValidationReport;
    await expectErrorCode(
      world.controller.requestReopen("ses_val", { sectionID: "SEC-001", findingIDs: [report.findings[0]?.id ?? "VF-001"] }),
      "reopen_target_unsupported",
    );
    // An architecture-scoped finding can never be mapped to a section.
    const archWorld = await (async () => {
      const { validator: archValidator } = fakeValidator([
        JSON.stringify({
          result: "findings",
          findings: [{ category: "missing_design", statement: "The architecture lacks recovery semantics.", scope: { architecture: { id: "ARCH", revision: 1 } }, sources: [{ kind: "architecture" }] }],
        }),
      ]);
      return manifestWorld(archValidator);
    })();
    await archWorld.controller.runSemanticValidation("ses_val");
    const archReport = (await archWorld.store.getCurrentValidationReport("PLAN-001" as never)) as ValidationReport;
    await expectErrorCode(
      archWorld.controller.requestReopen("ses_val", { sectionID: "SEC-002", findingIDs: [archReport.findings[0]?.id ?? "VF-001"] }),
      "reopen_target_unsupported",
    );
    // The report remains blocking — result is still findings, stage still synthesis.
    const run = (await archWorld.store.getRun("PLAN-001" as never)) as PlanningRun;
    expect(run.stage).toBe("synthesis");
  });

  it("4 (engine): a hostile reopen targeting a non-approved revision fails closed", async () => {
    const world = await findingsWorld();
    const report = (await world.store.getCurrentValidationReport("PLAN-001" as never)) as ValidationReport;
    const run = (await world.store.findActiveRunBySession("ses_val")) as PlanningRun;
    const proposal: Proposal = {
      id: "PROP-HR" as never,
      type: "amendment",
      scope: { id: "SEC-002" as never },
      revision: 1,
      status: "awaiting_approval",
      title: "hostile reopen",
      summary: "wrong revision",
      changes: [
        {
          kind: "reopen_section",
          target: { id: "SEC-002", revision: 3 },
          reason: { type: "semantic_validation", reportID: report.id, reportHash: report.hash, findingIDs: [report.findings[0]?.id ?? "VF-001"] },
          reopen: { sectionTitle: "Plan Memory", validation: "needs_review", fromStage: "synthesis" },
        },
      ] as never,
      dependencies: [],
      impact: { affectedSections: [], affectedDecisions: [] },
      createdFrom: { id: run.headSnapshot as never },
    };
    const frozen = { ...proposal, hash: computeProposalHash(proposal) };
    await world.store.saveProposal(run.id, frozen);
    const approval = await world.store.saveApproval(run.id, {
      id: "APPR-HR" as never,
      proposalID: frozen.id,
      proposalRevision: 1,
      proposalHash: frozen.hash as string,
      actor: "user",
      createdAt: FIXED,
    });
    await expect(
      world.store.commitTransaction({ planID: run.id, proposalID: frozen.id, approvalID: approval.id }),
    ).rejects.toSatisfy((error: unknown) => {
      if (!isUltraPlanError(error)) return false;
      const failures = (error.detail?.failures as { code: string }[] | undefined) ?? [];
      return error.code === "transaction_validation_failed" && failures.some((failure) => failure.code === "reopen_target_invalid");
    });
    // Nothing changed.
    const root = await world.store.getSection("PLAN-001" as never, "SEC-002" as never);
    expect(root?.status).toBe("approved");
  });

  it("10: user rejection leaves the section approved and the stage at synthesis", async () => {
    const world = await findingsWorld();
    const report = (await world.store.getCurrentValidationReport("PLAN-001" as never)) as ValidationReport;
    const prepared = await world.controller.requestReopen("ses_val", {
      sectionID: "SEC-002",
      findingIDs: [report.findings[0]?.id ?? "VF-001"],
    });
    const begun = await world.controller.beginProposalApproval("ses_val", prepared.proposal.id);
    const rejected = await world.controller.rejectProposal("ses_val", prepared.proposal.id, begun.request);
    expect(rejected.status).toBe("rejected");
    const root = await world.store.getSection("PLAN-001" as never, "SEC-002" as never);
    expect(root?.status).toBe("approved");
    const run = (await world.store.getRun("PLAN-001" as never)) as PlanningRun;
    expect(run.stage).toBe("synthesis");
    expect(run.activeWork).toBeUndefined();
  });

  it("reopen without a current findings report is refused (§41)", async () => {
    const world = await manifestWorld();
    // With no report at all, the synthesis substate withholds request_reopen.
    await expectErrorCode(
      world.controller.requestReopen("ses_val", { sectionID: "SEC-002", findingIDs: ["VF-001"] }),
      "capability_not_available",
    );
    // With a findings report bound to the current identity, unknown finding
    // ids are refused.
    const { validator } = fakeValidator([contradictionOutput()]);
    const withFindings = makeWorld(world.store, validator);
    await withFindings.controller.runSemanticValidation("ses_val");
    await expectErrorCode(
      withFindings.controller.requestReopen("ses_val", { sectionID: "SEC-002", findingIDs: ["VF-999"] }),
      "unknown_reference",
    );
  });
});

// -----------------------------------------------------------------------------
// Rework loop continuation + dependency-review reopen (§47/§48/§49/§50/§70/§71)
// -----------------------------------------------------------------------------

describe("rework loop continuation (§70/§71)", () => {
  it("§76 part 2: reopened section checkpoints to a new revision, re-completes, and synthesis re-runs on a new identity", async () => {
    const { validator, state } = fakeValidator([contradictionOutput(), CLEAN_OUTPUT]);
    const world = await manifestWorld(validator);
    await world.controller.runSemanticValidation("ses_val");
    const report = (await world.store.getCurrentValidationReport("PLAN-001" as never)) as ValidationReport;
    const prepared = await world.controller.requestReopen("ses_val", {
      sectionID: "SEC-002",
      findingIDs: [report.findings[0]?.id ?? "VF-001"],
    });
    const begun = await world.controller.beginProposalApproval("ses_val", prepared.proposal.id);
    await world.controller.recordApprovalAndCommit("ses_val", prepared.proposal.id, begun.request);

    // Checkpoint the reopened section: reopened → active, SEC-002@2 (§46/§47/§70).
    const checkpoint = await world.controller.prepareSectionCheckpoint("ses_val", checkpointInput("SEC-002"));
    const checkpointBegun = await world.controller.beginProposalApproval("ses_val", checkpoint.proposal.id);
    await world.controller.recordApprovalAndCommit("ses_val", checkpoint.proposal.id, checkpointBegun.request);
    const root = await world.store.getSection("PLAN-001" as never, "SEC-002" as never);
    expect(root?.status).toBe("active");
    expect(root?.currentRevision).toBe(2);
    expect(root?.approvedRevision).toBe(2);
    expect(root?.validation).toBe("valid");
    // Old @1 immutable; new @2 exact.
    const old = await world.store.getSectionRevision("PLAN-001" as never, { id: "SEC-002" as never, revision: 1 });
    expect(old?.design).toBe("Design SEC-002");
    expect(old?.projection.contract.revision).toBe(1);
    // Downstream propagation preserved (§48): approved SEC-003 was designed
    // against SEC-002@1's contract — the new SEC-002 contract invalidates it.
    const downstream = await world.store.getSection("PLAN-001" as never, "SEC-003" as never);
    expect(downstream?.status).toBe("approved");
    expect(downstream?.validation).toBe("needs_review");

    // Completing SEC-002 while SEC-003 is still needs_review fails the
    // synthesis-entry gate deterministically (all-approved-but-invalid fails
    // closed) — SEC-003 must be revalidated FIRST, via the §49
    // dependency-review reopen (which needs no fresh semantic report).
    const premature = await world.controller.requestCompletion("ses_val", { kind: "section" });
    const prematureBegun = await world.controller.beginProposalApproval("ses_val", premature.proposal.id);
    await expectErrorCode(
      world.controller.recordApprovalAndCommit("ses_val", premature.proposal.id, prematureBegun.request),
      "transaction_validation_failed",
    );
    const reopen003 = await world.controller.requestReopen("ses_val", { sectionID: "SEC-003" });
    const reopen003Begun = await world.controller.beginProposalApproval("ses_val", reopen003.proposal.id);
    await world.controller.recordApprovalAndCommit("ses_val", reopen003.proposal.id, reopen003Begun.request);
    await checkpointActive(world, "ses_val"); // SEC-003@2 binds SEC-002@2's contract
    const sec003 = await world.store.getSection("PLAN-001" as never, "SEC-003" as never);
    expect(sec003?.status).toBe("active");
    expect(sec003?.validation).toBe("valid");

    // Back to SEC-002 (active → focusable), complete both in dependency order.
    const refocus = await world.controller.requestSectionFocus("ses_val", { sectionID: "SEC-002" });
    expect(refocus.run.activeWork).toEqual({ type: "section", id: "SEC-002" });
    const complete002 = await world.controller.requestCompletion("ses_val", { kind: "section" });
    const complete002Begun = await world.controller.beginProposalApproval("ses_val", complete002.proposal.id);
    await world.controller.recordApprovalAndCommit("ses_val", complete002.proposal.id, complete002Begun.request);
    const complete003 = await world.controller.requestCompletion("ses_val", { kind: "section" });
    const complete003Begun = await world.controller.beginProposalApproval("ses_val", complete003.proposal.id);
    await world.controller.recordApprovalAndCommit("ses_val", complete003.proposal.id, complete003Begun.request);
    const runAfterRework = (await world.store.getRun("PLAN-001" as never)) as PlanningRun;
    expect(runAfterRework.stage).toBe("synthesis");
    expect(runAfterRework.activeWork).toBeUndefined();

    // §52: new HEAD → new input → new manifest → new validation identity.
    await world.controller.beginSynthesis("ses_val");
    await world.controller.submitSynthesisManifest("ses_val", {
      ...manifestDraft(),
      crossSectionLinks: [
        {
          statement: "SEC-001 provides isec-001-capability consumed by the reworked SEC-002",
          sources: [
            { kind: "section", id: "SEC-001", revision: 1 },
            { kind: "section", id: "SEC-002", revision: 2 },
          ],
        },
      ],
      implementationOrder: [
        {
          title: "Deliver the reworked runtime",
          description: "Deliver the re-approved sections in dependency order.",
          sections: [
            { id: "SEC-001", revision: 1 },
            { id: "SEC-002", revision: 2 },
            { id: "SEC-003", revision: 2 },
          ],
          sources: [{ kind: "architecture" }],
        },
      ],
    });
    const callsBefore = state.calls;
    const result = await world.controller.runSemanticValidation("ses_val");
    expect(state.calls).toBe(callsBefore + 1); // new identity → validator allowed again
    expect(result.report.result).toBe("clean");
    expect(result.report.id).toBe("VAL-002");
    expect(result.report.input.id).toBe("SYN-IN-002");
    // All old artifacts remain immutable history (§51).
    expect((await world.store.getSynthesisInput("PLAN-001" as never, "SYN-IN-001" as never))?.hash).toBeTruthy();
    expect((await world.store.getValidationReport("PLAN-001" as never, "VAL-001" as never))?.result).toBe("findings");
  });

  it("§71: dependency-review reopen runs in detail without a fresh semantic report and re-completes", async () => {
    // The first approved+needs_review state arises organically from the
    // semantic rework: reopening SEC-001 and committing its amended contract
    // propagates needs_review to the approved downstream SEC-002/SEC-003
    // (§48). The dependency-review reopen then works WITHOUT a fresh
    // semantic ValidationReport (the old report's identity is stale by then).
    const { validator } = fakeValidator([
      JSON.stringify({
        result: "findings",
        findings: [
          { category: "contradiction", statement: "SEC-001 runtime contract is contradicted.", scope: { sections: [{ id: "SEC-001", revision: 1 }] }, sources: [{ kind: "section", id: "SEC-001", revision: 1 }] },
        ],
      }),
    ]);
    const world = await manifestWorld(validator);
    await world.controller.runSemanticValidation("ses_val");
    const report = (await world.store.getCurrentValidationReport("PLAN-001" as never)) as ValidationReport;
    const reopen001 = await world.controller.requestReopen("ses_val", {
      sectionID: "SEC-001",
      findingIDs: [report.findings[0]?.id ?? "VF-001"],
    });
    const begun001 = await world.controller.beginProposalApproval("ses_val", reopen001.proposal.id);
    await world.controller.recordApprovalAndCommit("ses_val", reopen001.proposal.id, begun001.request);
    await checkpointActive(world, "ses_val"); // SEC-001@2

    // Downstream approved sections are now dependency-invalidated (§48).
    const sec002 = await world.store.getSection("PLAN-001" as never, "SEC-002" as never);
    expect(sec002?.status).toBe("approved");
    expect(sec002?.validation).toBe("needs_review");

    // Detail-stage reopen: dependency_review, NO findingIDs, NO current report
    // (the semantic report's identity went stale when SEC-001@2 moved HEAD).
    const prepared = await world.controller.requestReopen("ses_val", { sectionID: "SEC-002" });
    expect(prepared.proposal.type).toBe("amendment");
    const change = prepared.proposal.changes[0];
    expect(change?.kind).toBe("reopen_section");
    if (change?.kind === "reopen_section") {
      expect(change.reason).toEqual({ type: "dependency_review", validation: "needs_review" });
    }
    const begun = await world.controller.beginProposalApproval("ses_val", prepared.proposal.id);
    const result = await world.controller.recordApprovalAndCommit("ses_val", prepared.proposal.id, begun.request);
    // §50: stage remains detail; activeWork → target; validation stays needs_review.
    expect(result.run?.stage).toBe("detail");
    expect(result.run?.activeWork).toEqual({ type: "section", id: "SEC-002" });
    const reopened = await world.store.getSection("PLAN-001" as never, "SEC-002" as never);
    expect(reopened?.status).toBe("reopened");
    expect(reopened?.validation).toBe("needs_review");
    // New checkpoint → active/valid against SEC-001@2's contract (§71 tail).
    await checkpointActive(world, "ses_val");
    const recovered = await world.store.getSection("PLAN-001" as never, "SEC-002" as never);
    expect(recovered?.status).toBe("active");
    expect(recovered?.validation).toBe("valid");
    expect(recovered?.currentRevision).toBe(2);
    // No direct mark_valid tool exists — the matrix never grants one.
    const capabilities = await import("../src/index.js");
    const run = (await world.store.getRun("PLAN-001" as never)) as PlanningRun;
    const granted = capabilities.getCapabilities(run);
    expect(granted.has("mark_valid" as never)).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// Single-flight admission + concurrency (§30/§31/§64)
// -----------------------------------------------------------------------------

describe("validation admission + concurrency (§30/§31/§64)", () => {
  it("a live same-process admission refuses a second concurrent validation", async () => {
    const world = await manifestWorld();
    const input = (await world.store.getLatestSynthesisInput("PLAN-001" as never)) as SynthesisInput;
    const manifest = (await world.store.getSynthesisManifest("PLAN-001" as never, "SYN-001" as never)) as SynthesisManifest;
    const identity = {
      inputID: input.id,
      inputHash: input.hash,
      manifestID: manifest.id,
      manifestRevision: manifest.revision,
      manifestHash: manifest.hash,
      validatorProtocol: SEMANTIC_VALIDATION_PROTOCOL,
    };
    const first = await world.store.admitSemanticValidation("PLAN-001" as never, identity, { now: FIXED, ttlMs: 60_000 });
    expect(first.kind).toBe("admitted");
    await expectErrorCode(
      world.store.admitSemanticValidation("PLAN-001" as never, identity, { now: FIXED, ttlMs: 60_000 }),
      "validation_already_running",
    );
    // Release → retry admitted.
    await world.store.releaseSemanticValidation("PLAN-001" as never, `${input.hash}|${manifest.hash}|${SEMANTIC_VALIDATION_PROTOCOL}`);
    const again = await world.store.admitSemanticValidation("PLAN-001" as never, identity, { now: FIXED, ttlMs: 60_000 });
    expect(again.kind).toBe("admitted");
  });

  it("racing persists converge on ONE report (§64: only the admitted/current one may publish)", async () => {
    const world = await manifestWorld();
    const input = (await world.store.getLatestSynthesisInput("PLAN-001" as never)) as SynthesisInput;
    const manifest = (await world.store.getSynthesisManifest("PLAN-001" as never, "SYN-001" as never)) as SynthesisManifest;
    const build = (id: string, statement: string): ValidationReport => {
      const base = {
        id: id as never,
        planID: "PLAN-001" as never,
        input: { id: input.id },
        inputHash: input.hash,
        manifest: { id: manifest.id, revision: manifest.revision },
        manifestHash: manifest.hash,
        baseSnapshot: input.baseSnapshot,
        validatorProtocol: SEMANTIC_VALIDATION_PROTOCOL,
        result: "findings" as const,
        findings: [
          {
            id: "VF-001" as never,
            category: "contradiction" as const,
            statement,
            scope: { sections: [{ id: "SEC-002" as never, revision: 1 }] },
            sources: [{ kind: "section" as const, id: "SEC-002" as never, revision: 1 }],
          },
        ],
        createdAt: FIXED,
      };
      const { id: _id, createdAt: _createdAt, ...payload } = base;
      void _id;
      void _createdAt;
      return { ...base, hash: computeValidationReportHash(payload) };
    };
    const first = await world.store.saveValidationReport("PLAN-001" as never, build("VAL-001", "first racing validator"));
    expect(first.created).toBe(true);
    const second = await world.store.saveValidationReport("PLAN-001" as never, build("VAL-002", "second racing validator"));
    expect(second.created).toBe(false); // the same exact identity cannot produce a second report
    expect(second.report.id).toBe("VAL-001");
    expect((await world.store.listValidationReports("PLAN-001" as never))).toHaveLength(1);
  });
});

// -----------------------------------------------------------------------------
// Durable validation state (§30/§62 part, §74/§75)
// -----------------------------------------------------------------------------

describe("durable validation state (§74/§75)", () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "ultraplan-2g-"));
    filePath = path.join(dir, "plan-store.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function durableManifestWorld(validator?: SemanticValidator) {
    const store = new DurablePlanStore(filePath, { now: () => FIXED });
    store.open();
    const controller = new UltraPlanController({ store, now: () => FIXED, ...(validator ? { semanticValidator: validator } : {}) });
    const sessionID = "ses_dur";
    await admittedStart(controller, sessionID, GOAL);
    await controller.requestArchitecture(sessionID);
    const completion = await controller.prepareProposal(sessionID, {
      type: "architecture_completion",
      scope: { type: "architecture" },
      title: "Complete architecture",
      summary: "s",
      changes: [ARCH_CHANGE, { kind: "complete_architecture" }] as never,
    });
    const begun = await controller.beginProposalApproval(sessionID, completion.proposal.id);
    await controller.recordApprovalAndCommit(sessionID, completion.proposal.id, begun.request);
    const decomposition = await controller.prepareSectionDecomposition(sessionID, CHAIN_DECOMPOSITION);
    const dagBegun = await controller.beginProposalApproval(sessionID, decomposition.proposal.id);
    await controller.recordApprovalAndCommit(sessionID, decomposition.proposal.id, dagBegun.request);
    for (let index = 0; index < 3; index++) {
      await checkpointAndComplete({ store, controller }, sessionID);
    }
    await controller.beginSynthesis(sessionID);
    await controller.submitSynthesisManifest(sessionID, manifestDraft());
    return { store, controller, sessionID };
  }

  it("§74: manifest-ready, findings, clean, and reopen states survive close/reopen exactly", async () => {
    const { validator } = fakeValidator([contradictionOutput()]);
    const world = await durableManifestWorld(validator);
    const report = (await world.controller.runSemanticValidation(world.sessionID)).report;
    const prepared = await world.controller.requestReopen(world.sessionID, {
      sectionID: "SEC-002",
      findingIDs: [report.findings[0]?.id ?? "VF-001"],
    });
    const begun = await world.controller.beginProposalApproval(world.sessionID, prepared.proposal.id);
    // §74 "reopen Proposal + durable Approval": persist the approval WITHOUT
    // committing — the crash-safe approval state the restart must recover.
    await world.controller.recordApproval(world.sessionID, prepared.proposal.id, begun.request);
    const beforeProposal = await world.store.getProposal("PLAN-001" as never, prepared.proposal.id);
    const rawBefore = await readFile(filePath, "utf8");
    world.store.close();

    const reopened = new DurablePlanStore(filePath, { now: () => FIXED });
    reopened.open();
    const reportAfter = await reopened.getValidationReport("PLAN-001" as never, report.id);
    expect(reportAfter).toEqual(report);
    expect((await reopened.getCurrentValidationReport("PLAN-001" as never))?.id).toBe("VAL-001");
    expect(await reopened.getProposal("PLAN-001" as never, prepared.proposal.id)).toEqual(beforeProposal);
    expect(JSON.stringify(await reopened.listValidationReports("PLAN-001" as never))).toContain("contradiction");
    // Deep-equality of the whole document proves identity/hash survival.
    const rawAfter = await readFile(filePath, "utf8");
    expect(JSON.parse(rawAfter)).toEqual(JSON.parse(rawBefore));
    reopened.close();

    // Commit the reopen from the new instance; the reopened-section state survives too.
    const third = new DurablePlanStore(filePath, { now: () => FIXED });
    third.open();
    const controller = new UltraPlanController({ store: third, now: () => FIXED });
    await controller.commitApprovedProposal(world.sessionID, prepared.proposal.id);
    third.close();
    const fourth = new DurablePlanStore(filePath, { now: () => FIXED });
    fourth.open();
    const root = await fourth.getSection("PLAN-001" as never, "SEC-002" as never);
    expect(root?.status).toBe("reopened");
    const run = await fourth.getRun("PLAN-001" as never);
    expect(run?.stage).toBe("detail");
    expect(run?.activeWork).toEqual({ type: "section", id: "SEC-002" });
    fourth.close();
  });

  it("§75: tampered validation state fails closed at open, never repaired", async () => {
    const { validator } = fakeValidator([contradictionOutput()]);
    const world = await durableManifestWorld(validator);
    await world.controller.runSemanticValidation(world.sessionID);
    world.store.close();

    const pristine = await readFile(filePath, "utf8");
    const reports = (doc: Record<string, unknown>): Record<string, Record<string, unknown>> =>
      ((doc["validationReports"] as Record<string, unknown> | undefined)?.["PLAN-001"] ?? {}) as Record<
        string,
        Record<string, unknown>
      >;
    const firstFinding = (doc: Record<string, unknown>): Record<string, unknown> =>
      (reports(doc)["VAL-001"]!.findings as Record<string, unknown>[])[0]!;

    const cases: [string, (doc: Record<string, unknown>) => void][] = [
      ["tampered report hash", (doc) => {
        reports(doc)["VAL-001"]!.hash = "0".repeat(64);
      }],
      ["report referencing a missing input", (doc) => {
        reports(doc)["VAL-001"]!.input = { id: "SYN-IN-999" };
      }],
      ["report referencing a missing manifest", (doc) => {
        reports(doc)["VAL-001"]!.manifest = { id: "SYN-999", revision: 1 };
      }],
      ["wrong input hash", (doc) => {
        reports(doc)["VAL-001"]!.inputHash = "1".repeat(64);
      }],
      ["wrong manifest hash", (doc) => {
        reports(doc)["VAL-001"]!.manifestHash = "2".repeat(64);
      }],
      ["wrong baseSnapshot", (doc) => {
        reports(doc)["VAL-001"]!.baseSnapshot = { id: "SNAP-999" };
      }],
      ["unsupported finding category", (doc) => {
        firstFinding(doc).category = "too_spicy";
      }],
      ["finding references a non-input section revision", (doc) => {
        firstFinding(doc).scope = { sections: [{ id: "SEC-002", revision: 7 }] };
      }],
      ["invalid manifest item", (doc) => {
        firstFinding(doc).manifestItem = { kind: "cross_section_link", index: 42 };
      }],
      ["clean report carrying findings", (doc) => {
        reports(doc)["VAL-001"]!.result = "clean";
      }],
    ];
    for (const [name, mutator] of cases) {
      const doc = JSON.parse(pristine) as Record<string, unknown>;
      mutator(doc);
      await writeFile(filePath, JSON.stringify(doc));
      const store = new DurablePlanStore(filePath, { now: () => FIXED });
      try {
        store.open();
        throw new Error(`corruption case "${name}" did not fail closed`);
      } catch (error) {
        expect(isUltraPlanError(error)).toBe(true);
        expect((error as { code: string }).code).toBe("store_corrupt");
      } finally {
        store.close();
      }
    }
  });
});
