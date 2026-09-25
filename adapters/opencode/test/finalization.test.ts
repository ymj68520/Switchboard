/**
 * Phase 2H — Evidence Audit, Deterministic Finalization Gate & Final Plan
 * Candidate.
 *
 * Covers: the pure gate matrix — run/HEAD/synthesis/validation/architecture/
 * section/live-blocker/evidence terms, blocker-vs-staleness separation, and
 * the exact pass identity (§18-§29/§66) — plus audit construction with
 * reachability reasons and exact revisions (§6-§9/§67), the deterministic
 * candidate assembly and its invariants (§31-§37/§42/§75/§76), the
 * evidence-state race (§48/§68) and live-blocker races (§49/§50/§69),
 * idempotency and drift (§17/§38/§70), derived-artifact reads (§56), status
 * and L0 rendering (§51/§57/§58), and the durable restart/corruption
 * behavior (§61-§65/§71/§74).
 */
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DurablePlanStore,
  InMemoryPlanStore,
  assembleFinalPlanCandidate,
  buildEvidenceAudit,
  collectReachableEvidence,
  computeEvidenceAuditHashFromRecord,
  computeFinalPlanCandidateHashFromRecord,
  evaluateEvidenceEntryRules,
  evaluateFinalizationGate,
  isUltraPlanError,
  renderPlanningProtocol,
  resolveSynthesisFinalization,
  type EvidenceAuditSnapshot,
  type FinalizationGateDeps,
  type SemanticValidator,
  type SynthesisInput,
  type SynthesisManifest,
  type ValidationReport,
} from "../src/index.js";
import type { PlanningRun, Section, SectionRevision } from "../src/core/types.js";
import type { Snapshot, SectionRootSnapshot } from "../src/memory/snapshots.js";
import { EvidenceIDs } from "../src/core/ids.js";
import { UltraPlanController, type SectionCheckpointInput } from "../src/core/controller.js";
import type { PlanCommit } from "../src/transaction/types.js";
import { admittedStart, evidence } from "./helpers.js";

const FIXED = "2026-09-25T12:00:00.000Z";
const GOAL = "Build the durable planning harness";

// -----------------------------------------------------------------------------
// World builders (same real-flow drive as the Phase 2F/2G suites)
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

async function dagWorld(world: ReturnType<typeof makeWorld> = makeWorld(), sessionID = "ses_fin") {
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

async function checkpointActive(world: ReturnType<typeof makeWorld>, sessionID: string, overrides: Partial<SectionCheckpointInput> = {}): Promise<void> {
  const run = (await world.store.findActiveRunBySession(sessionID)) as PlanningRun;
  const active = run.activeWork?.type === "section" ? run.activeWork.id : undefined;
  if (!active) throw new Error("no active section");
  const prepared = await world.controller.prepareSectionCheckpoint(
    sessionID,
    checkpointInput(active as "SEC-001", overrides),
  );
  const begun = await world.controller.beginProposalApproval(sessionID, prepared.proposal.id);
  await world.controller.recordApprovalAndCommit(sessionID, prepared.proposal.id, begun.request);
}

async function checkpointAndComplete(
  world: ReturnType<typeof makeWorld>,
  sessionID: string,
  overrides: Partial<SectionCheckpointInput> = {},
): Promise<PlanCommit> {
  await checkpointActive(world, sessionID, overrides);
  const prepared = await world.controller.requestCompletion(sessionID, { kind: "section" });
  const begun = await world.controller.beginProposalApproval(sessionID, prepared.proposal.id);
  return (await world.controller.recordApprovalAndCommit(sessionID, prepared.proposal.id, begun.request)).commit;
}

async function synWorld(world: ReturnType<typeof makeWorld> = makeWorld(), sessionID = "ses_fin") {
  await dagWorld(world, sessionID);
  await checkpointAndComplete(world, sessionID);
  await checkpointAndComplete(world, sessionID);
  await checkpointAndComplete(world, sessionID);
  const run = (await world.store.findActiveRunBySession(sessionID)) as PlanningRun;
  expect(run.stage).toBe("synthesis");
  expect(run.activeWork).toBeUndefined();
  return { ...world, run };
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

/** Drive the full chain to synthesis with a frozen input and a manifest@1. */
async function manifestWorld(validator?: SemanticValidator) {
  const world = await synWorld(makeWorld(undefined, validator));
  await world.controller.beginSynthesis("ses_fin");
  await world.controller.submitSynthesisManifest("ses_fin", manifestDraft());
  return world;
}

const CLEAN_OUTPUT = JSON.stringify({ result: "clean", findings: [] });

/** Clean semantic validation over the plain flow: the passing-state entry point. */
async function cleanWorld(validator?: SemanticValidator) {
  const world = await manifestWorld(validator ?? { async validate() { return { text: CLEAN_OUTPUT }; } });
  await world.controller.runSemanticValidation("ses_fin");
  return world;
}

/** Passing finalization: the full vertical with a frozen current candidate. */
async function passingWorld() {
  const world = await cleanWorld();
  const result = await world.controller.requestFinalization("ses_fin");
  expect(result.gate.result).toBe("pass");
  return { ...world, result };
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

/**
 * World with REACHABLE evidence: two committed decisions citing EVD-001
 * (twice — the dedup path) and EVD-002 (informational stale), one uncited
 * EVD-003 (the unreachable path), and SEC-001's checkpoint citing DEC-001
 * (the section anchor). Driven to a CURRENT clean validation.
 */
async function reachabilityCleanWorld() {
  const world = makeWorld();
  const sessionID = "ses_reach";
  await admittedStart(world.controller, sessionID, GOAL);
  await world.controller.requestArchitecture(sessionID);
  const run = (await world.store.findActiveRunBySession(sessionID)) as PlanningRun;
  await world.store.putEvidence(run.id, evidence({ id: EvidenceIDs.cast("EVD-001") }));
  await world.store.putEvidence(
    run.id,
    evidence({ id: EvidenceIDs.cast("EVD-002"), criticality: "informational", freshness: "stale" }),
  );
  await world.store.putEvidence(run.id, evidence({ id: EvidenceIDs.cast("EVD-003") }));
  // Two committed decisions citing the records (EVD-001 twice — the dedup
  // path). One add_decision per proposal: freeze-time id assignment resolves
  // each proposal's add_decision against committed state only.
  const firstDecision = await world.controller.prepareProposal(sessionID, {
    type: "design_checkpoint",
    scope: { type: "architecture" },
    title: "Use direct evidence",
    summary: "s",
    changes: [
      {
        kind: "add_decision",
        content: {
          decision: {
            title: "Use direct evidence",
            statement: "s",
            rationale: "r",
            evidence: [{ id: "EVD-001" }, { id: "EVD-002" }],
          },
        },
      },
    ] as never,
  });
  const begun = await world.controller.beginProposalApproval(sessionID, firstDecision.proposal.id);
  await world.controller.recordApprovalAndCommit(sessionID, firstDecision.proposal.id, begun.request);
  const secondDecision = await world.controller.prepareProposal(sessionID, {
    type: "design_checkpoint",
    scope: { type: "architecture" },
    title: "Reiterate evidence",
    summary: "s",
    changes: [
      {
        kind: "add_decision",
        content: {
          decision: {
            title: "Reiterate evidence",
            statement: "s",
            rationale: "r",
            evidence: [{ id: "EVD-001" }],
          },
        },
      },
    ] as never,
  });
  const secondBegun = await world.controller.beginProposalApproval(sessionID, secondDecision.proposal.id);
  await world.controller.recordApprovalAndCommit(sessionID, secondDecision.proposal.id, secondBegun.request);
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
  const validating = makeWorld(world.store, { async validate() { return { text: CLEAN_OUTPUT }; } });
  await validating.controller.runSemanticValidation(sessionID);
  return { world, controller: validating.controller, sessionID };
}

/**
 * Persist a NEW manifest revision through the STORE boundary: the
 * candidate-ready capability surface deliberately withholds
 * submit_synthesis_manifest (§54 minimal surface), so identity-drift tests
 * drive the derived-artifact store API directly.
 */
async function submitNewManifestDirectly(world: { store: InMemoryPlanStore }): Promise<void> {
  const input = (await world.store.getLatestSynthesisInput("PLAN-001" as never))!;
  const draft = manifestDraft();
  await world.store.saveSynthesisManifest("PLAN-001" as never, {
    inputID: input.id,
    crossSectionLinks: [
      ...draft.crossSectionLinks,
      {
        statement: "SEC-003 consumes isec-002-capability from SEC-002",
        sources: [
          { kind: "section", id: "SEC-002", revision: 1 },
          { kind: "section", id: "SEC-003", revision: 1 },
        ],
      },
    ] as never,
    implementationOrder: draft.implementationOrder as never,
    limitations: draft.limitations as never,
    unresolvedFindings: [],
  });
}

// -----------------------------------------------------------------------------
// Pure-gate fixture (§18-§29): one consistent "perfect" dep set, mutated per case
// -----------------------------------------------------------------------------

function gateSection(): Section {
  return {
    id: "SEC-001" as never,
    title: "Runtime",
    objective: "bind",
    dependencies: [],
    status: "approved",
    validation: "valid",
    currentRevision: 1,
    approvedRevision: 1,
  };
}

function gateRoot(): SectionRootSnapshot {
  return {
    id: "SEC-001" as never,
    title: "Runtime",
    objective: "bind",
    dependencies: [],
    status: "approved",
    validation: "valid",
    currentRevision: 1,
    approvedRevision: 1,
  };
}

function gateRevision(): SectionRevision {
  return {
    sectionID: "SEC-001" as never,
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
  };
}

function gateSnapshot(): Snapshot {
  return {
    id: "SNAP-001" as never,
    planID: "PLAN-001" as never,
    commit: "COMMIT-001" as never,
    state: {
      architectureRevision: 1,
      sectionRevisions: {},
      decisionRevisions: {},
      constraintIDs: [],
      openQuestionIDs: [],
      sectionRoots: [gateRoot()],
    },
    createdAt: FIXED,
  };
}

function gateRun(snapshot: Snapshot): PlanningRun {
  return {
    id: "PLAN-001" as never,
    sessionID: "ses_gate",
    lifecycle: "active",
    stage: "synthesis",
    revision: 1,
    goal: { statement: GOAL },
    constraints: [],
    architecture: { id: "ARCH", revision: 1 },
    sections: [{ id: "SEC-001" as never }],
    decisions: [],
    openQuestions: [],
    conflicts: [],
    headCommit: snapshot.commit ?? undefined,
    headSnapshot: snapshot.id,
    createdAt: FIXED,
    updatedAt: FIXED,
  };
}

function gateInput(snapshot: Snapshot): SynthesisInput {
  return {
    id: "SYN-IN-001" as never,
    planID: "PLAN-001" as never,
    baseSnapshot: { id: snapshot.id },
    baseCommit: snapshot.commit,
    architecture: { id: "ARCH", revision: 1 },
    sections: [{ ref: { id: "SEC-001" as never, revision: 1 }, title: "Runtime", dependencies: [] }],
    decisions: [],
    constraints: [],
    questions: [],
    conflicts: [],
    evidence: [],
    createdAt: FIXED,
    hash: "input-hash",
  };
}

function gateManifest(input: SynthesisInput): SynthesisManifest {
  return {
    id: "SYN-001" as never,
    revision: 1,
    input: { id: input.id },
    baseSnapshot: input.baseSnapshot,
    inputHash: input.hash,
    architecture: input.architecture,
    sections: input.sections,
    crossSectionLinks: [],
    implementationOrder: [
      { order: 1, title: "Deliver", description: "d", sections: [{ id: "SEC-001" as never, revision: 1 }], sources: [] },
    ],
    limitations: [],
    unresolvedFindings: [],
    createdAt: FIXED,
    hash: "manifest-hash",
  };
}

function gateReport(input: SynthesisInput, manifest: SynthesisManifest): ValidationReport {
  return {
    id: "VAL-001" as never,
    planID: input.planID,
    input: { id: input.id },
    inputHash: input.hash,
    manifest: { id: manifest.id, revision: manifest.revision },
    manifestHash: manifest.hash,
    baseSnapshot: input.baseSnapshot,
    validatorProtocol: "semantic-validation:v1",
    result: "clean",
    findings: [],
    createdAt: FIXED,
    hash: "report-hash",
  };
}

type GateAuditEntry = EvidenceAuditSnapshot["entries"][number];

function gateAuditEntry(overrides: Partial<GateAuditEntry> = {}): GateAuditEntry {
  return {
    ref: { id: "EVD-001" as never, revision: 1 },
    latestRevision: 1,
    confidence: "direct",
    criticality: "critical",
    freshness: "fresh",
    status: "active",
    sourceIdentities: ["file|path=src/example.ts"],
    reachableFrom: [{ decision: { id: "DEC-001" as never, revision: 1 }, anchors: [{ kind: "head_snapshot" }] }],
    verdict: "pass",
    blockers: [],
    ...overrides,
  };
}

function gateAudit(input: SynthesisInput, manifest: SynthesisManifest, report: ValidationReport, overrides: Partial<EvidenceAuditSnapshot> = {}): EvidenceAuditSnapshot {
  return {
    id: "AUD-001" as never,
    planID: input.planID,
    headSnapshot: input.baseSnapshot,
    headCommit: input.baseCommit,
    synthesisInput: { id: input.id, hash: input.hash },
    synthesisManifest: { id: manifest.id, revision: manifest.revision, hash: manifest.hash },
    validationReport: { id: report.id, hash: report.hash },
    entries: [],
    counts: {
      freshCritical: 0,
      freshSupporting: 0,
      informational: 0,
      needsValidation: 0,
      stale: 0,
      invalidated: 0,
      criticalUncertain: 0,
    },
    result: "pass",
    blockers: [],
    evidenceStateHash: "evidence-hash",
    createdAt: FIXED,
    hash: "audit-hash",
    ...overrides,
  };
}

function gateDeps(overrides: Partial<FinalizationGateDeps> = {}): FinalizationGateDeps {
  const snapshot = overrides.snapshot ?? gateSnapshot();
  const run = overrides.run ?? gateRun(snapshot);
  const input = overrides.input ?? gateInput(snapshot);
  const manifest = overrides.manifest ?? gateManifest(input);
  const report = overrides.report ?? gateReport(input, manifest);
  const base: FinalizationGateDeps = {
    run,
    snapshot,
    architecture: {
      ref: run.architecture,
      record: { id: "ARCH", revision: 1, status: "approved", summary: "s", components: [], boundaries: [], dataFlows: [], principles: [], unresolved: [], basedOn: [] },
    },
    sections: [
      {
        root: gateRoot(),
        live: gateSection(),
        revision: { approvedRevision: 1, record: gateRevision() },
      },
    ],
    input,
    manifest,
    report,
    audit: gateAudit(input, manifest, report),
    currentEvidenceStateHash: "evidence-hash",
  };
  return { ...base, ...overrides };
}

function expectBlocked(result: ReturnType<typeof evaluateFinalizationGate>, codes: readonly string[]): void {
  expect(result.result).toBe("blocked");
  if (result.result === "blocked") {
    expect(result.blockers.map((blocker) => blocker.code)).toEqual(codes);
  }
}

function expectStale(result: ReturnType<typeof evaluateFinalizationGate>, codes: readonly string[]): void {
  expect(result.result).toBe("stale");
  if (result.result === "stale") {
    expect(result.stale.map((entry) => entry.code)).toEqual(codes);
  }
}

/** Flagged-audit fixture for the evidence-term cases: one entry + its blocker. */
function flaggedAudit(codes: readonly string[], entryOverrides: Partial<GateAuditEntry> = {}): FinalizationGateDeps["audit"] {
  const snapshot = gateSnapshot();
  const input = gateInput(snapshot);
  const manifest = gateManifest(input);
  const report = gateReport(input, manifest);
  return gateAudit(input, manifest, report, {
    entries: [gateAuditEntry({ verdict: "flagged", blockers: codes as never, ...entryOverrides })],
    result: "blocked",
    blockers: codes.map((code) => ({ code: code as never, evidence: { id: "EVD-001" as never, revision: 1 } })),
  });
}

// -----------------------------------------------------------------------------
// Pure gate matrix (§66 cases 1-26 + §28/§29)
// -----------------------------------------------------------------------------

describe("pure Finalization Gate matrix (§66/§28/§29)", () => {
  it("passes on the perfect deps and returns the exact FinalizationIdentity", () => {
    const result = evaluateFinalizationGate(gateDeps());
    expect(result.result).toBe("pass");
    if (result.result === "pass") {
      expect(result.identity.headSnapshot).toEqual({ id: "SNAP-001" });
      expect(result.identity.headCommit).toBe("COMMIT-001");
      expect(result.identity.architecture).toEqual({ id: "ARCH", revision: 1 });
      expect(result.identity.synthesisInput).toEqual({ id: "SYN-IN-001", hash: "input-hash" });
      expect(result.identity.synthesisManifest).toEqual({ id: "SYN-001", revision: 1, hash: "manifest-hash" });
      expect(result.identity.validationReport).toEqual({ id: "VAL-001", hash: "report-hash" });
      expect(result.identity.evidenceAudit).toEqual({ id: "AUD-001", hash: "audit-hash" });
    }
  });

  it("1-3: rejects non-active lifecycle, non-synthesis stage, and a present activeWork", () => {
    expectBlocked(
      evaluateFinalizationGate(gateDeps({ run: { ...gateRun(gateSnapshot()), lifecycle: "completed" } as never })),
      ["lifecycle_not_active"],
    );
    expectBlocked(evaluateFinalizationGate(gateDeps({ run: { ...gateRun(gateSnapshot()), stage: "detail" } })), [
      "stage_not_synthesis",
    ]);
    expectBlocked(
      evaluateFinalizationGate(gateDeps({ run: { ...gateRun(gateSnapshot()), activeWork: { type: "section", id: "SEC-001" as never } } })),
      ["active_work_present"],
    );
  });

  it("4: missing HEAD is a blocker", () => {
    const run = { ...gateRun(gateSnapshot()), headSnapshot: undefined, headCommit: undefined } as PlanningRun;
    expectBlocked(evaluateFinalizationGate(gateDeps({ run, snapshot: undefined, currentEvidenceStateHash: undefined })), [
      "head_missing",
    ]);
  });

  it("5: stale SynthesisInput is STALE (the whole identity chain derived from it co-fires)", () => {
    const snapshot = gateSnapshot();
    const input = { ...gateInput(snapshot), baseSnapshot: { id: "SNAP-000" as never } };
    const result = evaluateFinalizationGate(gateDeps({ input }));
    expect(result.result).toBe("stale");
    if (result.result === "stale") {
      expect(result.stale.map((entry) => entry.code)).toContain("synthesis_input_stale");
      expect(result.stale.map((entry) => entry.code)).toContain("evidence_audit_stale");
    }
  });

  it("6: manifest anchored elsewhere is STALE (manifest_not_current)", () => {
    const snapshot = gateSnapshot();
    const input = gateInput(snapshot);
    const manifest = { ...gateManifest(input), baseSnapshot: { id: "SNAP-000" as never } };
    expectStale(evaluateFinalizationGate(gateDeps({ manifest })), ["manifest_not_current"]);
  });

  it("7: unresolved manifest findings block (manifest_unresolved_findings)", () => {
    const snapshot = gateSnapshot();
    const input = gateInput(snapshot);
    const manifest = {
      ...gateManifest(input),
      unresolvedFindings: [{ category: "coverage_gap" as const, statement: "s" }],
    };
    expectBlocked(evaluateFinalizationGate(gateDeps({ manifest })), ["manifest_unresolved_findings"]);
  });

  it("8-9: a missing or findings report blocks (validation_not_clean)", () => {
    expectBlocked(evaluateFinalizationGate(gateDeps({ report: undefined })), ["validation_not_clean"]);
    const snapshot = gateSnapshot();
    const input = gateInput(snapshot);
    const manifest = gateManifest(input);
    expectBlocked(
      evaluateFinalizationGate(gateDeps({ report: { ...gateReport(input, manifest), result: "findings" } })),
      ["validation_not_clean"],
    );
  });

  it("10: a clean report for a historical manifest is STALE (validation_report_not_current)", () => {
    const snapshot = gateSnapshot();
    const input = gateInput(snapshot);
    const report = { ...gateReport(input, gateManifest(input)), manifestHash: "old-manifest-hash" };
    expectStale(evaluateFinalizationGate(gateDeps({ report })), ["validation_report_not_current"]);
  });

  it("11-12: missing or unapproved Architecture blocks (no latest resolution)", () => {
    const run = { ...gateRun(gateSnapshot()), architecture: undefined } as PlanningRun;
    expectBlocked(evaluateFinalizationGate(gateDeps({ run })), ["architecture_missing"]);
    expectBlocked(
      evaluateFinalizationGate(
        gateDeps({
          architecture: {
            ref: { id: "ARCH", revision: 1 },
            record: { id: "ARCH", revision: 1, status: "awaiting_approval", summary: "s", components: [], boundaries: [], dataFlows: [], principles: [], unresolved: [], basedOn: [] },
          },
        }),
      ),
      ["architecture_not_approved"],
    );
    // Snapshot/run ref disagreement is its own code (§22).
    expectBlocked(
      evaluateFinalizationGate(gateDeps({ run: { ...gateRun(gateSnapshot()), architecture: { id: "ARCH", revision: 2 } } })),
      ["architecture_snapshot_mismatch"],
    );
  });

  it("13-16: section approval, review, revision, and contract terms", () => {
    const base = gateDeps().sections[0]!;
    expectBlocked(
      evaluateFinalizationGate(gateDeps({ sections: [{ ...base, live: { ...base.live!, status: "active" } }] })),
      ["section_not_approved"],
    );
    expectBlocked(
      evaluateFinalizationGate(gateDeps({ sections: [{ ...base, live: { ...base.live!, validation: "needs_review" } }] })),
      ["section_needs_review"],
    );
    expectBlocked(
      evaluateFinalizationGate(gateDeps({ sections: [{ ...base, live: { ...base.live!, currentRevision: 2 } }] })),
      ["section_revision_mismatch"],
    );
    const contractDrift = gateRevision();
    (contractDrift.projection.contract as { revision: number }).revision = 2;
    expectBlocked(
      evaluateFinalizationGate(gateDeps({ sections: [{ ...base, revision: { approvedRevision: 1, record: contractDrift } }] })),
      ["section_contract_missing"],
    );
  });

  it("17-18: live blocking questions/conflicts block with exact ids (current run state, §24/§25)", () => {
    const run = {
      ...gateRun(gateSnapshot()),
      openQuestions: [{ id: "Q-001" as never, question: "q", blocking: true, scope: { id: "ARCH" } as never, status: "open" }],
    } as PlanningRun;
    const blocked = evaluateFinalizationGate(gateDeps({ run }));
    expectBlocked(blocked, ["blocking_question"]);
    if (blocked.result === "blocked") expect(blocked.blockers[0]?.questionIDs).toEqual(["Q-001"]);

    const runConflict = {
      ...gateRun(gateSnapshot()),
      conflicts: [
        { id: "CONF-001" as never, type: "decision" as const, refs: [], description: "d", severity: "blocking" as const, status: "open" as const },
      ],
    } as PlanningRun;
    const blockedConflict = evaluateFinalizationGate(gateDeps({ run: runConflict }));
    expectBlocked(blockedConflict, ["blocking_conflict"]);
    if (blockedConflict.result === "blocked") expect(blockedConflict.blockers[0]?.conflictIDs).toEqual(["CONF-001"]);

    // A stale clean report is NOT permission to ignore a live conflict (§25).
    const nonBlocking = {
      ...gateRun(gateSnapshot()),
      conflicts: [
        { id: "CONF-001" as never, type: "decision" as const, refs: [], description: "d", severity: "warning" as const, status: "open" as const },
      ],
    } as PlanningRun;
    expect(evaluateFinalizationGate(gateDeps({ run: nonBlocking })).result).toBe("pass");
  });

  it("19-22: critical evidence — needs_validation, stale, invalidated, uncertain all block", () => {
    const cases: [Parameters<typeof flaggedAudit>[0], Partial<GateAuditEntry>][] = [
      [["critical_not_fresh"], { freshness: "needs_validation" }],
      [["evidence_stale"], { status: "stale" }],
      [["evidence_invalidated"], { status: "invalidated" }],
      [["critical_uncertain"], { confidence: "uncertain" as never }],
    ];
    for (const [codes, entryOverrides] of cases) {
      const blocked = evaluateFinalizationGate(gateDeps({ audit: flaggedAudit(codes, entryOverrides) }));
      expectBlocked(blocked, ["evidence_audit_blocked"]);
      if (blocked.result === "blocked") {
        expect(blocked.blockers[0]?.evidenceBlockers?.map((blocker) => blocker.code)).toEqual(codes);
      }
    }
  });

  it("23-24: supporting evidence blocks in needs_validation / stale / invalidated state", () => {
    const cases: [Parameters<typeof flaggedAudit>[0], Partial<GateAuditEntry>][] = [
      [["supporting_needs_validation"], { criticality: "supporting" as never, freshness: "needs_validation" }],
      [["evidence_stale"], { criticality: "supporting" as never, status: "stale" }],
      [["evidence_invalidated"], { criticality: "supporting" as never, status: "invalidated" }],
    ];
    for (const [codes, entryOverrides] of cases) {
      const blocked = evaluateFinalizationGate(gateDeps({ audit: flaggedAudit(codes, entryOverrides) }));
      expectBlocked(blocked, ["evidence_audit_blocked"]);
      if (blocked.result === "blocked") {
        expect(blocked.blockers[0]?.evidenceBlockers?.map((blocker) => blocker.code)).toEqual(codes);
      }
    }
  });

  it("25: informational stale evidence is REPORTED but non-blocking (documented interpretation, §11)", () => {
    const snapshot = gateSnapshot();
    const input = gateInput(snapshot);
    const manifest = gateManifest(input);
    const report = gateReport(input, manifest);
    const audit = gateAudit(input, manifest, report, {
      entries: [gateAuditEntry({ criticality: "informational", freshness: "stale", verdict: "pass", blockers: [] })],
      counts: { freshCritical: 0, freshSupporting: 0, informational: 1, needsValidation: 0, stale: 1, invalidated: 0, criticalUncertain: 0 },
      result: "pass",
      blockers: [],
    });
    expect(evaluateFinalizationGate(gateDeps({ audit })).result).toBe("pass");
  });

  it("26: synthesis-consumed evidence state differing from current is STALE, not blocked", () => {
    const snapshot = gateSnapshot();
    const input = gateInput(snapshot);
    const manifest = gateManifest(input);
    const report = gateReport(input, manifest);
    const audit = gateAudit(input, manifest, report, {
      result: "blocked",
      blockers: [
        {
          code: "synthesis_evidence_stale",
          evidence: { id: "EVD-001" as never, revision: 1 },
          detail: "synthesis consumed EVD-001@1; the record is now at @2",
        },
      ],
    });
    expectStale(evaluateFinalizationGate(gateDeps({ audit })), ["synthesis_evidence_stale"]);
  });

  it("staleness takes precedence over blockers; the buckets are never conflated (§28)", () => {
    const snapshot = gateSnapshot();
    const input = { ...gateInput(snapshot), baseSnapshot: { id: "SNAP-000" as never } };
    const run = {
      ...gateRun(snapshot),
      openQuestions: [{ id: "Q-001" as never, question: "q", blocking: true, scope: { id: "ARCH" } as never, status: "open" }],
    } as PlanningRun;
    const staleResult = evaluateFinalizationGate(gateDeps({ run, input }));
    expect(staleResult.result).toBe("stale");
    if (staleResult.result === "stale") {
      expect(staleResult.stale.map((entry) => entry.code)).toContain("synthesis_input_stale");
    }
  });

  it("a moved audit identity is STALE (evidence_audit_stale — §26 mandatory re-check)", () => {
    expectStale(evaluateFinalizationGate(gateDeps({ currentEvidenceStateHash: "evidence-hash-2" })), [
      "evidence_audit_stale",
    ]);
    expectStale(
      evaluateFinalizationGate(gateDeps({ audit: { ...gateDeps().audit!, headSnapshot: { id: "SNAP-000" as never } } })),
      ["evidence_audit_stale"],
    );
  });

  it("a missing audit blocks (evidence_audit_missing) — the caller builds it first", () => {
    expectBlocked(evaluateFinalizationGate(gateDeps({ audit: undefined })), ["evidence_audit_missing"]);
  });
});

// -----------------------------------------------------------------------------
// Audit construction + reachability (§6-§9/§67) — real controller flow
// -----------------------------------------------------------------------------

describe("evidence audit reachability (§6-§9/§67/§68)", () => {
  it("audits exactly the reachable evidence, deduplicated, with reasons and exact revisions; unreachable evidence is ignored", async () => {
    const { controller, sessionID } = await reachabilityCleanWorld();
    const result = await controller.requestFinalization(sessionID);
    expect(result.gate.result).toBe("pass");
    const audit = result.audit!;
    // Reachable set: EVD-001 + EVD-002; EVD-003 (uncited) ignored (§67).
    expect(audit.entries.map((entry) => entry.ref.id)).toEqual(["EVD-001", "EVD-002"]);
    expect(audit.entries.every((entry) => entry.ref.revision === 1)).toBe(true);
    // EVD-001: deduplicated reachability with BOTH decision paths preserved.
    const first = audit.entries[0]!;
    expect(first.reachableFrom.map((reach) => reach.decision.id)).toEqual(["DEC-001", "DEC-002"]);
    // Downstream/current Section revisions are the traversal anchors (§67):
    expect(first.reachableFrom[0]!.anchors).toContainEqual({ kind: "section", id: "SEC-001", revision: 1 });
    expect(first.reachableFrom[1]!.anchors).toEqual([{ kind: "head_snapshot" }]);
    // Informational stale is recorded (counts.stale = 1) but never flags (§11/§25).
    const informational = audit.entries[1]!;
    expect(informational.criticality).toBe("informational");
    expect(informational.freshness).toBe("stale");
    expect(informational.verdict).toBe("pass");
    expect(audit.counts.stale).toBe(1);
    expect(audit.result).toBe("pass");
  });

  it("§8: a pinned reference is audited EXACTLY — a newer revision flags evidence_revision_mismatch, never a silent rebase", async () => {
    const world = makeWorld();
    const sessionID = "ses_exact";
    await admittedStart(world.controller, sessionID, GOAL);
    await world.controller.requestArchitecture(sessionID);
    const run = (await world.store.findActiveRunBySession(sessionID)) as PlanningRun;
    await world.store.putEvidence(run.id, evidence({ id: EvidenceIDs.cast("EVD-001") }));
    // A newer revision of the same record arrives; the design pinned @1.
    await world.store.putEvidence(run.id, evidence({ id: EvidenceIDs.cast("EVD-001"), revision: 2, claim: "updated claim" }));
    const decisions = await world.controller.prepareProposal(sessionID, {
      type: "design_checkpoint",
      scope: { type: "architecture" },
      title: "Pinned",
      summary: "s",
      changes: [
        {
          kind: "add_decision",
          content: {
            decision: { title: "Pinned evidence", statement: "s", rationale: "r", evidence: [{ id: "EVD-001", revision: 1 }] },
          },
        },
      ] as never,
    });
    const begun = await world.controller.beginProposalApproval(sessionID, decisions.proposal.id);
    await world.controller.recordApprovalAndCommit(sessionID, decisions.proposal.id, begun.request);
    const snapshot = (await world.store.getHeadSnapshot(run.id))!;
    const collected = await collectReachableEvidence(world.store, run.id, snapshot);
    expect(collected.entries).toHaveLength(1);
    const entry = collected.entries[0]!;
    expect(entry.referencedRevision).toBe(1);
    expect(entry.evidence.claim).toBe("Claim for EVD-001");
    expect(entry.latestRevision).toBe(2);
    expect(evaluateEvidenceEntryRules(entry).blockers).toContain("evidence_revision_mismatch");
  });

  it("§7: unreachable evidence never moves the fingerprint — the gate still passes", async () => {
    const { world, controller, sessionID } = await reachabilityCleanWorld();
    const run = (await world.store.findActiveRunBySession(sessionID)) as PlanningRun;
    await world.store.putEvidence(run.id, evidence({ id: EvidenceIDs.cast("EVD-777"), claim: "unreachable" }));
    const result = await controller.requestFinalization(sessionID);
    expect(result.gate.result).toBe("pass");
    expect(result.audit!.entries.map((entry) => entry.ref.id)).not.toContain("EVD-777");
  });

  it("§68: reachable evidence changes after the audit → the candidate persist fails finalization_stale, no candidate", async () => {
    const { world, sessionID } = await reachabilityCleanWorld();
    const run = (await world.store.findActiveRunBySession(sessionID)) as PlanningRun;
    // A begins finalization over evidence state E1: audit built + persisted.
    const snapshot = (await world.store.getHeadSnapshot(run.id))!;
    const input = (await world.store.getLatestSynthesisInput(run.id))!;
    const manifest = (await world.store.listSynthesisManifests(run.id)).reduce((a, b) => (a.revision > b.revision ? a : b));
    const report = await world.store.getCurrentValidationReport(run.id);
    const audit = await buildEvidenceAudit(
      world.store,
      { planID: run.id, snapshot, input, manifest, report: report! },
      { id: "AUD-001" as never, now: FIXED },
    );
    expect(audit.result).toBe("pass");
    await world.store.saveEvidenceAudit(run.id, audit);
    // B writes new REACHABLE evidence state E2 (HEAD unchanged).
    await world.store.putEvidence(run.id, evidence({ id: EvidenceIDs.cast("EVD-001"), revision: 2, claim: "re-observed" }));
    // A attempts the candidate persist bound to the E1 audit → stale.
    const draft = assembleFinalPlanCandidate({
      identity: {
        headSnapshot: { id: snapshot.id },
        headCommit: snapshot.commit,
        architecture: input.architecture,
        synthesisInput: { id: input.id, hash: input.hash },
        synthesisManifest: { id: manifest.id, revision: manifest.revision, hash: manifest.hash },
        validationReport: { id: report!.id, hash: report!.hash },
        evidenceAudit: { id: audit.id, hash: audit.hash },
      },
      input,
      manifest,
    });
    await expectErrorCode(world.store.saveFinalPlanCandidate(run.id, draft), "finalization_stale");
    expect(await world.store.listFinalPlanCandidates(run.id)).toHaveLength(0);
    // HEAD-only concurrency was never sufficient: HEAD did not move at all.
    expect(run.headSnapshot).toBe(snapshot.id);
  });

  it("§9 (end-to-end): reachable evidence advanced after a passing candidate → the next request is STALE with synthesis_evidence_stale", async () => {
    const { world, controller, sessionID } = await reachabilityCleanWorld();
    const first = await controller.requestFinalization(sessionID);
    expect(first.gate.result).toBe("pass");
    const run = (await world.store.findActiveRunBySession(sessionID)) as PlanningRun;
    await world.store.putEvidence(run.id, evidence({ id: EvidenceIDs.cast("EVD-001"), revision: 2, claim: "re-observed" }));
    const second = await controller.requestFinalization(sessionID);
    expect(second.gate.result).toBe("stale");
    if (second.gate.result === "stale") {
      expect(second.gate.stale.map((entry) => entry.code)).toContain("synthesis_evidence_stale");
    }
    // The old candidate is untouched and historical — never rebased (§47/§51).
    const candidates = await world.store.listFinalPlanCandidates(run.id);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.evidenceAudit.id).toBe(first.gate.result === "pass" ? first.gate.identity.evidenceAudit.id : undefined);
  });
});

// -----------------------------------------------------------------------------
// Passing vertical (§66 27-32 + §32-§37/§42/§75/§76) — real controller flow
// -----------------------------------------------------------------------------

describe("passing finalization vertical (§66 27-32/§42/§75/§76)", () => {
  it("27-32: pass returns the exact audit + exact candidate; nothing committed; stage synthesis; finalPlan unset", async () => {
    const world = await passingWorld();
    const { result } = world;
    expect(result.audit!.id).toBe("AUD-001");
    expect(result.audit!.result).toBe("pass");
    expect(result.candidate!.candidate.id).toBe("FPC-001");
    expect(result.candidate!.candidate.revision).toBe(1);
    const candidate = result.candidate!.candidate;
    const manifest = (await world.store.listSynthesisManifests(candidate.planID))[0]!;
    expect(candidate.sections).toEqual([
      { id: "SEC-001", revision: 1 },
      { id: "SEC-002", revision: 1 },
      { id: "SEC-003", revision: 1 },
    ]);
    // §33/§34: exact manifest copies; §35/§36: exact committed refs.
    expect(candidate.implementationOrder).toEqual(manifest.implementationOrder);
    expect(candidate.limitations).toEqual(manifest.limitations);
    expect(candidate.decisions).toEqual([]);
    expect(candidate.constraints).toEqual([]);
    expect(candidate.validation).toEqual({
      blockingQuestions: 0,
      blockingConflicts: 0,
      invalidSections: 0,
      semanticValidation: "clean",
      evidenceAudit: "pass",
    });
    // The hash recomputes from the frozen payload.
    const { id: _id, revision: _revision, createdAt: _createdAt, hash: _hash, ...rest } = candidate;
    void _id;
    void _revision;
    void _createdAt;
    void _hash;
    expect(computeFinalPlanCandidateHashFromRecord(rest)).toBe(candidate.hash);
    // 29-32: zero PlanCommits beyond the design chain, HEAD unchanged,
    // stage synthesis, finalPlan unset (§40), exactly one audit + candidate.
    const run = (await world.store.getRun(candidate.planID)) as PlanningRun;
    expect(run.stage).toBe("synthesis");
    expect(run.finalPlan).toBeUndefined();
    expect(run.headSnapshot).toBe(result.gate.result === "pass" ? result.gate.identity.headSnapshot.id : undefined);
    expect(await world.store.listCommits(run.id)).toHaveLength(8);
    expect(await world.store.listEvidenceAudits(run.id)).toHaveLength(1);
    expect(await world.store.listFinalPlanCandidates(run.id)).toHaveLength(1);
  });

  it("§75: the candidate is NOT a Proposal — no approval path, no commit, no finalPlan", async () => {
    const world = await passingWorld();
    const runID = "PLAN-001" as never;
    const proposalsBefore = await world.store.listProposals(runID);
    const approvalsBefore = await world.store.listApprovals(runID);
    const commitsBefore = await world.store.listCommits(runID);
    // A second request for the same identity creates no second anything.
    await world.controller.requestFinalization("ses_fin");
    expect(await world.store.listProposals(runID)).toEqual(proposalsBefore);
    expect(await world.store.listApprovals(runID)).toEqual(approvalsBefore);
    expect(await world.store.listCommits(runID)).toEqual(commitsBefore);
    const run = (await world.store.getRun(runID)) as PlanningRun;
    expect(run.finalPlan).toBeUndefined();
    expect(run.lifecycle).toBe("active");
    // The stored candidate is a derived artifact with no authorization fields.
    const candidate = (await world.store.getCurrentFinalPlanCandidate(runID)) as Record<string, unknown> | undefined;
    expect(candidate).toBeDefined();
    expect(candidate).not.toHaveProperty("status");
    expect(candidate).not.toHaveProperty("approved");
    expect(candidate!.validation).toMatchObject({ semanticValidation: "clean", evidenceAudit: "pass" });
  });

  it("§76: request_finalization pass leaves the stage at synthesis — pinned", async () => {
    const world = await passingWorld();
    const run = (await world.store.getRun("PLAN-001" as never)) as PlanningRun;
    expect(run.stage).toBe("synthesis");
    expect(run.lifecycle).toBe("active");
  });

  it("§45: the preview is deterministic and carries the §43 content", async () => {
    const world = await passingWorld();
    const first = await world.controller.requestFinalization("ses_fin");
    const second = await world.controller.requestFinalization("ses_fin");
    expect(first.candidate!.preview).toBe(second.candidate!.preview);
    expect(first.candidate!.preview).toContain("Final Plan Candidate");
    expect(first.candidate!.preview).toContain(`Base: ${first.gate.result === "pass" ? first.gate.identity.headSnapshot.id : ""}`);
    expect(first.candidate!.preview).toContain("Architecture: ARCH@1");
    expect(first.candidate!.preview).toContain("SEC-001@1");
    expect(first.candidate!.preview).toContain("1. Deliver the runtime");
    expect(first.candidate!.preview).toContain("Known limitations:");
    expect(first.candidate!.preview).toContain("Semantic validation: clean / VAL-001");
    expect(first.candidate!.preview).toContain("Evidence audit: pass / AUD-001");
    expect(first.candidate!.preview).toContain("NOT user-approved");
  });
});

// -----------------------------------------------------------------------------
// Idempotency, live-blocker races, identity drift (§17/§38/§46/§49/§50/§69/§70)
// -----------------------------------------------------------------------------

describe("idempotency, live-blocker races, and identity drift (§46/§49/§50/§69/§70)", () => {
  it("§70: the exact same request reuses the same audit and candidate — no duplicates", async () => {
    const world = await passingWorld();
    const firstAudit = (await world.store.listEvidenceAudits("PLAN-001" as never))[0]!;
    const firstCandidate = (await world.store.listFinalPlanCandidates("PLAN-001" as never))[0]!;
    const second = await world.controller.requestFinalization("ses_fin");
    expect(second.gate.result).toBe("pass");
    expect(second.audit!.id).toBe(firstAudit.id);
    expect(second.audit!.hash).toBe(firstAudit.hash);
    expect(second.candidate!.candidate.id).toBe(firstCandidate.id);
    expect(second.candidate!.candidate.revision).toBe(firstCandidate.revision);
    expect(second.candidate!.candidate.hash).toBe(firstCandidate.hash);
    expect(second.candidate!.idempotent).toBe(true);
    expect(await world.store.listEvidenceAudits("PLAN-001" as never)).toHaveLength(1);
    expect(await world.store.listFinalPlanCandidates("PLAN-001" as never)).toHaveLength(1);
  });

  it("§50/§69: a live blocking question appearing after the audit → the candidate persist fails finalization_stale", async () => {
    const world = await cleanWorld();
    const run = (await world.store.findActiveRunBySession("ses_fin")) as PlanningRun;
    const snapshot = (await world.store.getHeadSnapshot(run.id))!;
    const input = (await world.store.getLatestSynthesisInput(run.id))!;
    const manifest = (await world.store.listSynthesisManifests(run.id)).reduce((a, b) => (a.revision > b.revision ? a : b));
    const report = await world.store.getCurrentValidationReport(run.id);
    const audit = await buildEvidenceAudit(
      world.store,
      { planID: run.id, snapshot, input, manifest, report: report! },
      { id: "AUD-001" as never, now: FIXED },
    );
    await world.store.saveEvidenceAudit(run.id, audit);
    // A live blocking question appears AFTER the audit (record_question is a
    // granted harmless blocker tool in the validation-clean substate).
    await world.controller.recordQuestion("ses_fin", {
      question: "Does the deployment target include airgapped hosts?",
      blocking: true,
      scope: { type: "architecture" },
    });
    const draft = assembleFinalPlanCandidate({
      identity: {
        headSnapshot: { id: snapshot.id },
        headCommit: snapshot.commit,
        architecture: input.architecture,
        synthesisInput: { id: input.id, hash: input.hash },
        synthesisManifest: { id: manifest.id, revision: manifest.revision, hash: manifest.hash },
        validationReport: { id: report!.id, hash: report!.hash },
        evidenceAudit: { id: audit.id, hash: audit.hash },
      },
      input,
      manifest,
    });
    await expectErrorCode(world.store.saveFinalPlanCandidate(run.id, draft), "finalization_stale");
    expect(await world.store.listFinalPlanCandidates(run.id)).toHaveLength(0);
  });

  it("§50: a live blocker BEFORE the request blocks the gate; the audit still persists (§46)", async () => {
    const world = await cleanWorld();
    await world.controller.recordQuestion("ses_fin", {
      question: "Blocking operational constraint?",
      blocking: true,
      scope: { type: "architecture" },
    });
    const result = await world.controller.requestFinalization("ses_fin");
    expect(result.gate.result).toBe("blocked");
    if (result.gate.result === "blocked") {
      expect(result.gate.blockers.map((blocker) => blocker.code)).toEqual(["blocking_question"]);
    }
    expect(result.audit).toBeDefined();
    expect(result.candidate).toBeUndefined();
    expect(await world.store.listFinalPlanCandidates("PLAN-001" as never)).toHaveLength(0);
  });

  it("§70: changed manifest identity → new gate required; the old candidate stays historical", async () => {
    const world = await passingWorld();
    // The candidate-ready surface withholds submit_synthesis_manifest
    // deliberately (§54); the drift is driven through the store boundary.
    await submitNewManifestDirectly(world);
    // The demoted identity has no report → the surface demotes to
    // manifest-ready, and request_finalization is correctly UNGRANTED (§52).
    await expectErrorCode(world.controller.requestFinalization("ses_fin"), "capability_not_available");
    // Fresh validation of the new identity, then the new gate.
    await world.controller.runSemanticValidation("ses_fin");
    const result = await world.controller.requestFinalization("ses_fin");
    expect(result.gate.result).toBe("pass");
    expect(result.candidate!.candidate.revision).toBe(2);
    expect(result.audit!.id).toBe("AUD-002"); // new identity → new audit, old immutable
    const candidates = await world.store.listFinalPlanCandidates("PLAN-001" as never);
    expect(candidates).toHaveLength(2); // the old candidate stays historical (§38/§39)
    expect(candidates.map((candidate) => candidate.revision).sort()).toEqual([1, 2]);
    const currency = await resolveSynthesisFinalization(
      world.store,
      (await world.store.getRun("PLAN-001" as never)) as PlanningRun,
      (await world.store.getLatestSynthesisInput("PLAN-001" as never))!,
      (await world.store.listSynthesisManifests("PLAN-001" as never)).reduce((a, b) => (a.revision > b.revision ? a : b)),
      await world.store.getCurrentValidationReport("PLAN-001" as never),
    );
    expect(currency.state).toBe("passed");
    expect(currency.candidate).toMatchObject({ ref: "FPC-001@2", current: true });
  });

  it("§49: blocked finalization creates no candidate, no stage transition, no HEAD movement", async () => {
    const world = await cleanWorld();
    const runBefore = (await world.store.getRun("PLAN-001" as never)) as PlanningRun;
    await world.controller.raiseConflict("ses_fin", {
      type: "decision",
      refs: [],
      description: "Blocking disagreement",
      severity: "blocking",
    });
    const result = await world.controller.requestFinalization("ses_fin");
    expect(result.gate.result).toBe("blocked");
    const runAfter = (await world.store.getRun("PLAN-001" as never)) as PlanningRun;
    expect(runAfter.stage).toBe("synthesis");
    expect(runAfter.headSnapshot).toBe(runBefore.headSnapshot);
    expect(await world.store.listFinalPlanCandidates("PLAN-001" as never)).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------------
// Reads, status, and L0 guidance (§51/§56/§57/§58)
// -----------------------------------------------------------------------------

describe("candidate reads, status, and L0 (§51/§56/§57/§58)", () => {
  it("§56: exact reads — AUD by id; FPC by id (latest) and by exact revision; no silent latest resolution", async () => {
    const world = await passingWorld();
    const auditRead = await world.controller.readMemory("ses_fin", { ref: { kind: "evidence_audit", id: "AUD-001" } });
    expect((auditRead.artifacts[0]?.artifact as EvidenceAuditSnapshot).id).toBe("AUD-001");
    const candidateRead = await world.controller.readMemory("ses_fin", { ref: { kind: "final_plan_candidate", id: "FPC-001" } });
    expect((candidateRead.artifacts[0]?.artifact as { revision: number }).revision).toBe(1);
    const exactRead = await world.controller.readMemory("ses_fin", {
      ref: { kind: "final_plan_candidate", id: "FPC-001", revision: 1 },
    });
    expect((exactRead.artifacts[0]?.artifact as { id: string }).id).toBe("FPC-001");
    await expectErrorCode(
      world.controller.readMemory("ses_fin", { ref: { kind: "final_plan_candidate", id: "FPC-001", revision: 9 } }),
      "unknown_reference",
    );
    await expectErrorCode(
      world.controller.readMemory("ses_fin", { ref: { kind: "evidence_audit", id: "AUD-999" } }),
      "unknown_reference",
    );
  });

  it("§57: status renders unavailable → not run → blocked → passed; never Final approved / Ready for Build", async () => {
    const clean = await cleanWorld();
    const beforeClean = (await clean.controller.statusOf("ses_fin")) ?? "";
    expect(beforeClean).toContain("Finalization: not run");
    expect(beforeClean).not.toContain("Final approved");
    expect(beforeClean).not.toContain("Ready for Build");

    await clean.controller.recordQuestion("ses_fin", {
      question: "Block finalization?",
      blocking: true,
      scope: { type: "architecture" },
    });
    const blocked = await clean.controller.requestFinalization("ses_fin");
    expect(blocked.gate.result).toBe("blocked");
    const blockedStatus = (await clean.controller.statusOf("ses_fin")) ?? "";
    // The audit's EVIDENCE term passes (no reachable evidence problem); the
    // gate is blocked by the live question — derived honestly (§57).
    expect(blockedStatus).toContain("Finalization: blocked");
    expect(blockedStatus).toContain("Evidence audit: AUD-001 pass");
    expect(blockedStatus).toContain("Blockers: blocking_question(");
    expect(blockedStatus).not.toContain("Final approved");

    const passing = await passingWorld();
    const passedStatus = (await passing.controller.statusOf("ses_fin")) ?? "";
    expect(passedStatus).toContain("Finalization: passed");
    expect(passedStatus).toContain("Evidence audit: AUD-001 pass");
    expect(passedStatus).toContain("Final candidate: FPC-001@1");
    expect(passedStatus).toContain("Stage: synthesis");
    expect(passedStatus).toContain("Final approval: not requested");
    expect(passedStatus).not.toContain("Final approved");
    expect(passedStatus).not.toContain("Ready for Build");

    const early = await manifestWorld();
    const earlyStatus = (await early.controller.statusOf("ses_fin")) ?? "";
    expect(earlyStatus).toContain("Finalization: unavailable");
  });

  it("§51: a stored candidate is never mutated stale — currency is derived", async () => {
    const world = await passingWorld();
    const runID = "PLAN-001" as never;
    const run = (await world.store.getRun(runID)) as PlanningRun;
    const input = (await world.store.getLatestSynthesisInput(runID))!;
    const manifest = (await world.store.listSynthesisManifests(runID)).reduce((a, b) => (a.revision > b.revision ? a : b));
    const report = await world.store.getCurrentValidationReport(runID);
    const passed = await resolveSynthesisFinalization(world.store, run, input, manifest, report ?? undefined);
    expect(passed.state).toBe("passed");
    expect(passed.candidate).toMatchObject({ ref: "FPC-001@1", current: true });
    const before = JSON.stringify(await world.store.getCurrentFinalPlanCandidate(runID));
    // Invalidating: a live blocking question makes the candidate non-current.
    await world.controller.recordQuestion("ses_fin", {
      question: "Late blocking question",
      blocking: true,
      scope: { type: "architecture" },
    });
    const updatedRun = (await world.store.getRun(runID)) as PlanningRun;
    const after = await resolveSynthesisFinalization(world.store, updatedRun, input, manifest, report ?? undefined);
    // The gate would now BLOCK on the live question — derived, not stored.
    expect(after.state).toBe("blocked");
    expect(after.candidate).toMatchObject({ ref: "FPC-001@1", current: false });
    expect(JSON.stringify(await world.store.getCurrentFinalPlanCandidate(runID))).toBe(before);
  });

  it("§58: L0 guidance pins — clean (may request), blocked, candidate-ready verbatim", () => {
    const run = gateRun(gateSnapshot());
    const base = { inputID: "SYN-IN-001", baseSnapshot: "SNAP-001", inputHash: "h", manifestRef: "SYN-001@1", manifestHash: "m" };
    const clean = renderPlanningProtocol({
      run,
      synthesis: { ...base, validationResult: "clean", finalization: { state: "not_run" } },
    });
    expect(clean).toContain("Semantic validation is clean.");
    expect(clean).toContain("You may request deterministic finalization.");
    expect(clean).toContain("You cannot bypass these checks.");
    expect(clean).not.toContain("not implemented in this phase");
    expect(clean).toContain("- [x] request_finalization");

    const blocked = renderPlanningProtocol({
      run,
      synthesis: { ...base, validationResult: "clean", finalization: { state: "blocked" } },
    });
    expect(blocked).toContain("Finalization is blocked.");
    expect(blocked).toContain("Inspect the exact machine blockers.");
    expect(blocked).toContain("Do not claim the plan is final.");
    expect(blocked).toContain("Resolve through normal planning/evidence workflows.");

    const ready = renderPlanningProtocol({
      run,
      synthesis: {
        ...base,
        validationResult: "clean",
        finalization: { state: "passed", candidate: { ref: "FPC-001@1", current: true } },
      },
    });
    // Phase 2I §86: candidate-ready points at the formal Final Proposal now.
    expect(ready).toContain("A current FinalPlanCandidate exists.");
    expect(ready).toContain("You may prepare the formal Final Plan Proposal.");
    expect(ready).toContain("The Finalization Gate will be rerun.");
    expect(ready).toContain("Do not alter approved design.");
    expect(ready).toContain("- [x] prepare_final_plan");
    expect(ready).not.toContain("- [x] request_user_approval");

    // §86: a CURRENT final Proposal selects the final-proposal fragment and
    // the narrow §50/§51 surface.
    const proposalReady = renderPlanningProtocol({
      run,
      synthesis: {
        ...base,
        validationResult: "clean",
        finalization: { state: "passed", candidate: { ref: "FPC-001@1", current: true } },
        finalProposal: { ref: "PROP-009", status: "ready" },
      },
    });
    expect(proposalReady).toContain("The exact Final Plan Proposal is frozen.");
    expect(proposalReady).toContain("Request explicit user approval.");
    expect(proposalReady).toContain("User approval authorizes only this exact Proposal.");
    expect(proposalReady).toContain("- [x] request_user_approval");

    // §86: awaiting — the user decides; conversation is never authorization.
    const awaiting = renderPlanningProtocol({
      run,
      synthesis: {
        ...base,
        validationResult: "clean",
        finalization: { state: "passed", candidate: { ref: "FPC-001@1", current: true } },
        finalProposal: { ref: "PROP-009", status: "awaiting_approval" },
      },
    });
    expect(awaiting).toContain("Await the formal user decision.");
    expect(awaiting).toContain("Do not reinterpret normal conversation as approval.");

    // §86: handoff_pending — planning mutation closed, Build handoff NOT done.
    const handoff = renderPlanningProtocol({ run: { ...run, stage: "final", lifecycle: "handoff_pending" } });
    // Phase 2J §71 wording.
    expect(handoff).toContain("The Final Plan is approved and committed.");
    expect(handoff).toContain("The run is handoff_pending.");
    expect(handoff).toContain("Do not modify planning state.");
    expect(handoff).toContain("The Harness is recovering/completing the runtime Build handoff.");
  });
});

// -----------------------------------------------------------------------------
// Durable restart, compaction independence, corruption (§61-§65/§71/§74)
// -----------------------------------------------------------------------------

describe("durable finalization state (§61-§65/§71/§74)", () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "ultraplan-2h-"));
    filePath = path.join(dir, "plan-store.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function durableWorld() {
    const store = new DurablePlanStore(filePath, { now: () => FIXED });
    store.open();
    const controller = new UltraPlanController({
      store,
      now: () => FIXED,
      semanticValidator: { async validate() { return { text: CLEAN_OUTPUT }; } },
    });
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

  /** Durable world whose reachable evidence blocks the audit (critical uncertain). */
  async function durableBlockedWorld() {
    const store = new DurablePlanStore(filePath, { now: () => FIXED });
    store.open();
    const controller = new UltraPlanController({
      store,
      now: () => FIXED,
      semanticValidator: { async validate() { return { text: CLEAN_OUTPUT }; } },
    });
    const sessionID = "ses_blk";
    await admittedStart(controller, sessionID, GOAL);
    await controller.requestArchitecture(sessionID);
    const run = (await store.findActiveRunBySession(sessionID)) as PlanningRun;
    await store.putEvidence(run.id, evidence({ id: EvidenceIDs.cast("EVD-001"), criticality: "critical", confidence: "uncertain" }));
    const decisions = await controller.prepareProposal(sessionID, {
      type: "design_checkpoint",
      scope: { type: "architecture" },
      title: "Critical uncertain evidence",
      summary: "s",
      changes: [
        {
          kind: "add_decision",
          content: { decision: { title: "d", statement: "s", rationale: "r", evidence: [{ id: "EVD-001" }] } },
        },
      ] as never,
    });
    const begun = await controller.beginProposalApproval(sessionID, decisions.proposal.id);
    await controller.recordApprovalAndCommit(sessionID, decisions.proposal.id, begun.request);
    const completion = await controller.prepareProposal(sessionID, {
      type: "architecture_completion",
      scope: { type: "architecture" },
      title: "Complete architecture",
      summary: "s",
      changes: [ARCH_CHANGE, { kind: "complete_architecture" }] as never,
    });
    const completionBegun = await controller.beginProposalApproval(sessionID, completion.proposal.id);
    await controller.recordApprovalAndCommit(sessionID, completion.proposal.id, completionBegun.request);
    const decomposition = await controller.prepareSectionDecomposition(sessionID, CHAIN_DECOMPOSITION);
    const dagBegun = await controller.beginProposalApproval(sessionID, decomposition.proposal.id);
    await controller.recordApprovalAndCommit(sessionID, decomposition.proposal.id, dagBegun.request);
    for (let index = 0; index < 3; index++) {
      await checkpointAndComplete({ store, controller }, sessionID);
    }
    await controller.beginSynthesis(sessionID);
    await controller.submitSynthesisManifest(sessionID, manifestDraft());
    await controller.runSemanticValidation(sessionID);
    return { store, controller, sessionID };
  }

  it("§71/§74: validation-clean, passing audit, current candidate, and stale-candidate states survive close/reopen exactly", async () => {
    const world = await durableWorld();
    await world.controller.runSemanticValidation(world.sessionID);
    world.store.close();
    // (1) validation-clean / no finalization survives.
    const reopened = new DurablePlanStore(filePath, { now: () => FIXED });
    reopened.open();
    expect(await reopened.getCurrentValidationReport("PLAN-001" as never)).toMatchObject({ result: "clean" });
    expect(await reopened.listEvidenceAudits("PLAN-001" as never)).toHaveLength(0);
    reopened.close();

    // (2) passing audit + current candidate survive exactly; retry idempotent.
    const second = new DurablePlanStore(filePath, { now: () => FIXED });
    second.open();
    const controller = new UltraPlanController({ store: second, now: () => FIXED });
    const result = await controller.requestFinalization(world.sessionID);
    expect(result.gate.result).toBe("pass");
    const rawBefore = await readFile(filePath, "utf8");
    second.close();

    const third = new DurablePlanStore(filePath, { now: () => FIXED });
    third.open();
    const audit = await third.getCurrentEvidenceAudit("PLAN-001" as never);
    expect(audit).toMatchObject({ id: "AUD-001", result: "pass" });
    const candidate = await third.getCurrentFinalPlanCandidate("PLAN-001" as never);
    expect(candidate).toMatchObject({ id: "FPC-001", revision: 1 });
    const retryController = new UltraPlanController({ store: third, now: () => FIXED });
    const retry = await retryController.requestFinalization(world.sessionID);
    expect(retry.gate.result).toBe("pass");
    expect(retry.candidate!.idempotent).toBe(true);
    expect(retry.candidate!.candidate.hash).toBe(candidate!.hash);
    expect(JSON.stringify(await third.listFinalPlanCandidates("PLAN-001" as never))).toBe(JSON.stringify([candidate]));
    third.close();
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual(JSON.parse(rawBefore));

    // (3) a changed synthesis identity makes the candidate historical; the
    // derived staleness survives restarts (compaction independence §74).
    const fourth = new DurablePlanStore(filePath, { now: () => FIXED });
    fourth.open();
    const input4 = (await fourth.getLatestSynthesisInput("PLAN-001" as never))!;
    const draft4 = manifestDraft();
    await fourth.saveSynthesisManifest("PLAN-001" as never, {
      inputID: input4.id,
      crossSectionLinks: [
        ...draft4.crossSectionLinks,
        {
          statement: "SEC-003 consumes isec-002-capability from SEC-002",
          sources: [
            { kind: "section", id: "SEC-002", revision: 1 },
            { kind: "section", id: "SEC-003", revision: 1 },
          ],
        },
      ] as never,
      implementationOrder: draft4.implementationOrder as never,
      limitations: draft4.limitations as never,
      unresolvedFindings: [],
    });
    fourth.close();
    const fifth = new DurablePlanStore(filePath, { now: () => FIXED });
    fifth.open();
    const run = await fifth.getRun("PLAN-001" as never);
    const input = await fifth.getLatestSynthesisInput("PLAN-001" as never);
    const manifest = (await fifth.listSynthesisManifests("PLAN-001" as never)).reduce((a, b) =>
      a.revision > b.revision ? a : b,
    );
    const currency = await resolveSynthesisFinalization(fifth, run!, input!, manifest, undefined);
    expect(currency.state).toBe("unavailable"); // the new identity has no report yet
    expect(await fifth.listFinalPlanCandidates("PLAN-001" as never)).toHaveLength(1); // historical, immutable
    fifth.close();
  });

  it("§71: a blocked EvidenceAudit persists and survives restart with its exact blockers (§46)", async () => {
    const world = await durableBlockedWorld();
    const result = await world.controller.requestFinalization(world.sessionID);
    expect(result.gate.result).toBe("blocked");
    if (result.gate.result === "blocked") {
      const evidenceBlockers = result.gate.blockers.find((blocker) => blocker.code === "evidence_audit_blocked");
      expect(evidenceBlockers?.evidenceBlockers?.map((blocker) => blocker.code)).toEqual(["critical_uncertain"]);
    }
    expect(result.candidate).toBeUndefined();
    const raw = await readFile(filePath, "utf8");
    world.store.close();

    const reopened = new DurablePlanStore(filePath, { now: () => FIXED });
    reopened.open();
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual(JSON.parse(raw));
    const audit = await reopened.getCurrentEvidenceAudit("PLAN-001" as never);
    expect(audit).toMatchObject({ id: "AUD-001", result: "blocked" });
    expect(audit!.blockers.map((blocker) => blocker.code)).toEqual(["critical_uncertain"]);
    expect(audit!.entries[0]).toMatchObject({ ref: { id: "EVD-001", revision: 1 }, confidence: "uncertain", criticality: "critical" });
    expect(await reopened.listFinalPlanCandidates("PLAN-001" as never)).toHaveLength(0);
    reopened.close();
  });

  it("§65: tampered audits fail closed at open, never repaired", async () => {
    const world = await durableWorld();
    await world.controller.runSemanticValidation(world.sessionID);
    await world.controller.requestFinalization(world.sessionID);
    world.store.close();
    const base = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;

    const audits = (doc: Record<string, unknown>): Record<string, Record<string, unknown>> =>
      ((doc["evidenceAudits"] as Record<string, unknown> | undefined)?.["PLAN-001"] ?? {}) as Record<
        string,
        Record<string, unknown>
      >;
    /** Re-seal so the mutated record is hash-consistent and the DEEPER checks fire. */
    const reseal = (record: Record<string, unknown>): void => {
      const { id: _id, createdAt: _createdAt, hash: _hash, ...rest } = record;
      void _id;
      void _createdAt;
      void _hash;
      record["hash"] = computeEvidenceAuditHashFromRecord(rest as never);
    };

    const cases: [string, (doc: Record<string, unknown>, reseal: (record: Record<string, unknown>) => void) => void][] = [
      ["tampered audit hash", (doc) => {
        audits(doc)["AUD-001"]!.hash = "0".repeat(64);
      }],
      ["audit referencing a missing HEAD snapshot", (doc, resealFn) => {
        const record = audits(doc)["AUD-001"]!;
        record.headSnapshot = { id: "SNAP-999" };
        resealFn(record);
      }],
      ["wrong input hash mirror", (doc, resealFn) => {
        const record = audits(doc)["AUD-001"]!;
        (record.synthesisInput as Record<string, unknown>).hash = "1".repeat(64);
        resealFn(record);
      }],
      ["wrong manifest hash mirror", (doc, resealFn) => {
        const record = audits(doc)["AUD-001"]!;
        (record.synthesisManifest as Record<string, unknown>).hash = "2".repeat(64);
        resealFn(record);
      }],
      ["wrong report hash mirror", (doc, resealFn) => {
        const record = audits(doc)["AUD-001"]!;
        (record.validationReport as Record<string, unknown>).hash = "3".repeat(64);
        resealFn(record);
      }],
      ["unknown evidence ref in entries", (doc, resealFn) => {
        const record = audits(doc)["AUD-001"]!;
        (record.entries as unknown[]).push({
          ref: { id: "EVD-999", revision: 1 },
          latestRevision: 1,
          confidence: "direct",
          criticality: "supporting",
          freshness: "fresh",
          status: "active",
          sourceIdentities: [],
          reachableFrom: [],
          verdict: "pass",
          blockers: [],
        });
        resealFn(record);
      }],
      ["wrong evidenceStateHash", (doc, resealFn) => {
        const record = audits(doc)["AUD-001"]!;
        record.evidenceStateHash = "4".repeat(64);
        resealFn(record);
      }],
      ["count mismatch", (doc, resealFn) => {
        const record = audits(doc)["AUD-001"]!;
        (record.counts as Record<string, unknown>).freshCritical = 3;
        resealFn(record);
      }],
      ["pass with blocking entry", (doc, resealFn) => {
        const record = audits(doc)["AUD-001"]!;
        (record.entries as unknown[]).push({
          ref: { id: "EVD-001", revision: 1 },
          latestRevision: 1,
          confidence: "direct",
          criticality: "critical",
          freshness: "needs_validation",
          status: "active",
          sourceIdentities: [],
          reachableFrom: [],
          verdict: "flagged",
          blockers: ["critical_not_fresh"],
        });
        resealFn(record);
      }],
      ["blocked with inconsistent blocker", (doc, resealFn) => {
        const record = audits(doc)["AUD-001"]!;
        (record as { result: string }).result = "blocked";
        resealFn(record);
      }],
    ];

    for (const [name, mutate] of cases) {
      const doc = structuredClone(base);
      mutate(doc, reseal);
      const casePath = path.join(dir, `corrupt-audit-${name.replace(/\W+/g, "-")}.json`);
      await writeFile(casePath, JSON.stringify(doc));
      const store = new DurablePlanStore(casePath, { now: () => FIXED });
      expect(() => store.open()).toThrow(/corrupt/);
    }
  });

  it("§64: tampered candidates fail closed at open, never repaired", async () => {
    const world = await durableWorld();
    await world.controller.runSemanticValidation(world.sessionID);
    await world.controller.requestFinalization(world.sessionID);
    world.store.close();
    const base = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;

    const candidates = (doc: Record<string, unknown>): Record<string, Record<string, unknown>> =>
      ((doc["finalPlanCandidates"] as Record<string, unknown> | undefined)?.["PLAN-001"] ?? {}) as Record<
        string,
        Record<string, unknown>
      >;
    const reseal = (record: Record<string, unknown>): void => {
      const { id: _id, revision: _revision, createdAt: _createdAt, hash: _hash, ...rest } = record;
      void _id;
      void _revision;
      void _createdAt;
      void _hash;
      record["hash"] = computeFinalPlanCandidateHashFromRecord(rest as never);
    };

    const cases: [string, (doc: Record<string, unknown>, reseal: (record: Record<string, unknown>) => void) => void][] = [
      ["tampered candidate hash", (doc) => {
        candidates(doc)["FPC-001@1"]!.hash = "0".repeat(64);
      }],
      ["missing evidence audit", (doc, resealFn) => {
        delete ((doc["evidenceAudits"] as Record<string, unknown>)["PLAN-001"] as Record<string, unknown>)["AUD-001"];
        resealFn(candidates(doc)["FPC-001@1"]!);
      }],
      ["blocked audit referenced by candidate", (doc, resealFn) => {
        const audit = ((doc["evidenceAudits"] as Record<string, unknown>)["PLAN-001"] as Record<string, unknown>)["AUD-001"] as Record<string, unknown>;
        (audit as { result: string }).result = "blocked";
        const { id: _id, createdAt: _createdAt, hash: _hash, ...auditRest } = audit;
        void _id;
        void _createdAt;
        void _hash;
        audit.hash = computeEvidenceAuditHashFromRecord(auditRest as never);
        (candidates(doc)["FPC-001@1"]!.evidenceAudit as Record<string, unknown>).hash = audit.hash as string;
        resealFn(candidates(doc)["FPC-001@1"]!);
      }],
      ["wrong manifest hash", (doc, resealFn) => {
        const record = candidates(doc)["FPC-001@1"]!;
        (record.synthesisManifest as Record<string, unknown>).hash = "1".repeat(64);
        resealFn(record);
      }],
      ["wrong validation report hash", (doc, resealFn) => {
        const record = candidates(doc)["FPC-001@1"]!;
        (record.semanticValidation as Record<string, unknown>).hash = "2".repeat(64);
        resealFn(record);
      }],
      ["wrong synthesis input hash", (doc, resealFn) => {
        const record = candidates(doc)["FPC-001@1"]!;
        (record.synthesisInput as Record<string, unknown>).hash = "3".repeat(64);
        resealFn(record);
      }],
      ["section set mismatch", (doc, resealFn) => {
        const record = candidates(doc)["FPC-001@1"]!;
        (record.sections as unknown[]).push({ id: "SEC-999", revision: 1 });
        resealFn(record);
      }],
      ["implementation order mismatch", (doc, resealFn) => {
        const record = candidates(doc)["FPC-001@1"]!;
        ((record.implementationOrder as Record<string, unknown>[])[0]!).title = "Reordered";
        resealFn(record);
      }],
      ["validation summary inconsistent", (doc, resealFn) => {
        const record = candidates(doc)["FPC-001@1"]!;
        (record.validation as Record<string, unknown>).blockingQuestions = 2;
        resealFn(record);
      }],
    ];

    for (const [name, mutate] of cases) {
      const doc = structuredClone(base);
      mutate(doc, reseal);
      const casePath = path.join(dir, `corrupt-candidate-${name.replace(/\W+/g, "-")}.json`);
      await writeFile(casePath, JSON.stringify(doc));
      const store = new DurablePlanStore(casePath, { now: () => FIXED });
      expect(() => store.open()).toThrow(/corrupt/);
    }
  });

  it("§64 (store-level): a candidate referencing a missing audit is refused at save — no partial state", async () => {
    const world = await cleanWorld();
    const run = (await world.store.findActiveRunBySession("ses_fin")) as PlanningRun;
    const snapshot = (await world.store.getHeadSnapshot(run.id))!;
    const input = (await world.store.getLatestSynthesisInput(run.id))!;
    const manifest = (await world.store.listSynthesisManifests(run.id)).reduce((a, b) => (a.revision > b.revision ? a : b));
    const report = await world.store.getCurrentValidationReport(run.id);
    const draft = assembleFinalPlanCandidate({
      identity: {
        headSnapshot: { id: snapshot.id },
        headCommit: snapshot.commit,
        architecture: input.architecture,
        synthesisInput: { id: input.id, hash: input.hash },
        synthesisManifest: { id: manifest.id, revision: manifest.revision, hash: manifest.hash },
        validationReport: { id: report!.id, hash: report!.hash },
        evidenceAudit: { id: "AUD-404" as never, hash: "missing" },
      },
      input,
      manifest,
    });
    await expectErrorCode(world.store.saveFinalPlanCandidate(run.id, draft), "unknown_reference");
    expect(await world.store.listFinalPlanCandidates(run.id)).toHaveLength(0);
  });

  /** Durable world with one cited FRESH supporting evidence record (passing audit with an entry). */
  async function durableEvidenceWorld() {
    const store = new DurablePlanStore(filePath, { now: () => FIXED });
    store.open();
    const controller = new UltraPlanController({
      store,
      now: () => FIXED,
      semanticValidator: { async validate() { return { text: CLEAN_OUTPUT }; } },
    });
    const sessionID = "ses_evd";
    await admittedStart(controller, sessionID, GOAL);
    await controller.requestArchitecture(sessionID);
    const run = (await store.findActiveRunBySession(sessionID)) as PlanningRun;
    await store.putEvidence(run.id, evidence({ id: EvidenceIDs.cast("EVD-001") }));
    const decisions = await controller.prepareProposal(sessionID, {
      type: "design_checkpoint",
      scope: { type: "architecture" },
      title: "Cited evidence",
      summary: "s",
      changes: [
        {
          kind: "add_decision",
          content: { decision: { title: "d", statement: "s", rationale: "r", evidence: [{ id: "EVD-001" }] } },
        },
      ] as never,
    });
    const begun = await controller.beginProposalApproval(sessionID, decisions.proposal.id);
    await controller.recordApprovalAndCommit(sessionID, decisions.proposal.id, begun.request);
    const completion = await controller.prepareProposal(sessionID, {
      type: "architecture_completion",
      scope: { type: "architecture" },
      title: "Complete architecture",
      summary: "s",
      changes: [ARCH_CHANGE, { kind: "complete_architecture" }] as never,
    });
    const completionBegun = await controller.beginProposalApproval(sessionID, completion.proposal.id);
    await controller.recordApprovalAndCommit(sessionID, completion.proposal.id, completionBegun.request);
    const decomposition = await controller.prepareSectionDecomposition(sessionID, CHAIN_DECOMPOSITION);
    const dagBegun = await controller.beginProposalApproval(sessionID, decomposition.proposal.id);
    await controller.recordApprovalAndCommit(sessionID, decomposition.proposal.id, dagBegun.request);
    for (let index = 0; index < 3; index++) {
      await checkpointAndComplete({ store, controller }, sessionID);
    }
    await controller.beginSynthesis(sessionID);
    await controller.submitSynthesisManifest(sessionID, manifestDraft());
    await controller.runSemanticValidation(sessionID);
    return { store, controller, sessionID };
  }

  it("§73: two instances requesting finalization for the same state converge on ONE audit + ONE candidate identity", async () => {
    const world = await durableEvidenceWorld();
    // Two independent runtime instances over ONE durable store file.
    const instanceA = new DurablePlanStore(filePath, { now: () => FIXED, staleLockMs: 200 });
    instanceA.open();
    const instanceB = new DurablePlanStore(filePath, { now: () => FIXED, staleLockMs: 200 });
    instanceB.open();
    const controllerA = new UltraPlanController({ store: instanceA, now: () => FIXED });
    const controllerB = new UltraPlanController({ store: instanceB, now: () => FIXED });

    const resultA = await controllerA.requestFinalization(world.sessionID);
    expect(resultA.gate.result).toBe("pass");
    const resultB = await controllerB.requestFinalization(world.sessionID);
    expect(resultB.gate.result).toBe("pass");
    // Convergence: same audit identity, same candidate identity/revision.
    expect(resultB.audit!.id).toBe(resultA.audit!.id);
    expect(resultB.audit!.hash).toBe(resultA.audit!.hash);
    expect(resultB.candidate!.candidate.id).toBe(resultA.candidate!.candidate.id);
    expect(resultB.candidate!.candidate.revision).toBe(resultA.candidate!.candidate.revision);
    expect(resultB.candidate!.candidate.hash).toBe(resultA.candidate!.candidate.hash);
    expect(resultB.candidate!.idempotent).toBe(true);
    // One audit identity + one candidate identity in the durable state both see.
    expect(await instanceB.listEvidenceAudits("PLAN-001" as never)).toHaveLength(1);
    expect(await instanceB.listFinalPlanCandidates("PLAN-001" as never)).toHaveLength(1);
    instanceA.close();
    instanceB.close();
  });

  it("§73: different current evidence state is NOT collapsed into the same audit identity", async () => {
    const world = await durableEvidenceWorld();
    const instanceA = new DurablePlanStore(filePath, { now: () => FIXED, staleLockMs: 200 });
    instanceA.open();
    const controllerA = new UltraPlanController({ store: instanceA, now: () => FIXED });
    const resultA = await controllerA.requestFinalization(world.sessionID);
    expect(resultA.gate.result).toBe("pass");
    const auditA = resultA.audit!;
    // Evidence state advances (new revision of the cited record) — HEAD unchanged.
    const run = (await instanceA.getRun("PLAN-001" as never)) as PlanningRun;
    await instanceA.putEvidence(run.id, evidence({ id: EvidenceIDs.cast("EVD-001"), revision: 2, claim: "re-observed" }));
    // A second instance audits over the NEW evidence state: a NEW audit
    // identity (different fingerprint) — never collapsed into AUD-001.
    const instanceB = new DurablePlanStore(filePath, { now: () => FIXED, staleLockMs: 200 });
    instanceB.open();
    const controllerB = new UltraPlanController({ store: instanceB, now: () => FIXED });
    const resultB = await controllerB.requestFinalization(world.sessionID);
    expect(resultB.gate.result).toBe("stale"); // §9: synthesis consumed @1
    expect(resultB.audit!.id).toBe("AUD-002");
    expect(resultB.audit!.evidenceStateHash).not.toBe(auditA.evidenceStateHash);
    expect(await instanceB.listEvidenceAudits("PLAN-001" as never)).toHaveLength(2);
    // No candidate was freezable for the stale identity.
    expect(await instanceB.listFinalPlanCandidates("PLAN-001" as never)).toHaveLength(1);
    instanceA.close();
    instanceB.close();
  });
});
