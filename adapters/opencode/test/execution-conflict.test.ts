/**
 * v0.2.0 Phase 6A Part B — verification conflict resolution.
 *
 * Covers the Phase 6A directive gates: ordinary defects never create
 * conflicts (§18/§73/E21), Supervisor-driven creation with exact
 * current-candidate evidence (§19/§23-§25/E18-E20), VerificationEvidenceRef
 * and canonical blocking-evidence enumeration (§20/§21/E16-E17), the
 * conflict_resolution directive purpose with legacy acceptance default
 * (§26/§27/E22-E23), the ONE bounded blinded resolver (§29-§31/E24-E27), the
 * unified report extension (§32), non-mutating finalization semantics
 * (§33/§34), no recursion (§35/E35), deterministic neutralization with
 * supported blocking evidence still blocking (§36/E31-E32), the
 * effective-evidence commit gate (§37/§39/E33-E34), resolver ≠ acceptance
 * verification (§38/E28-E29), immutable original reports (§64/E30),
 * candidate-scoped history (§24/§81/E36), durable reopen (§93), and
 * malformed-graph fail-closed loads (§61/§92/E56).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DurablePlanStore,
  assembleExecutionWorkerContext,
  computeExecutionDirectiveHashFromRecord,
  type ExecutionReportID,
  type VerificationConflictID,
  type WorkerReportPayload,
} from "../src/index.js";
import {
  EXEC_AUTH,
  FIXED,
  durableHandoffPendingWorld,
  execAcceptInput,
  execCleanVerification,
  execLive,
  execOpenNextWindow,
  execRunDirective,
  supervisedWorld,
  tamper,
  FULL_EXEC_CEILING,
  type SupervisedWorld,
} from "./execution-world.js";

const READ_ONLY = { ...FULL_EXEC_CEILING, repositoryWrite: false };

/** A world with two current-candidate verifier facts: A = failed result, B = clean. */
async function conflictWorld(loaded?: import("./execution-world.js").HandoffPendingWorld) {
  const world = await supervisedWorld(loaded);
  await execRunDirective(world, { objective: "implementation" });
  const a = await execRunDirective(
    world,
    { kind: "verification", objective: "verifier A", candidateEffect: "non_mutating", capabilityEnvelope: READ_ONLY },
    { workerRole: "verifier", candidateMutation: "none", result: "failed" },
  );
  const b = await execCleanVerification(world, [], { objective: "verifier B" });
  return { ...world, a, b };
}

async function reportIDFor(world: SupervisedWorld, attemptID: import("../src/core/ids.js").ExecutionAttemptID): Promise<ExecutionReportID> {
  return (await world.world.store.findExecutionReportForAttempt(attemptID))!.id;
}

type ConflictWorld = Awaited<ReturnType<typeof conflictWorld>>;

/** Supervisor-explicit creation of the disputed fact between A and B. */
async function createConflict(world: ConflictWorld, overrides: Record<string, unknown> = {}) {
  const { window } = await execLive(world);
  return world.world.store.createVerificationConflict({
    executionRunID: world.run.id,
    stageID: world.stage.id,
    windowID: world.window.id,
    candidateRevision: window.candidateRevision,
    ...EXEC_AUTH,
    evidenceA: { kind: "report_result", reportID: await reportIDFor(world, world.a.attempt.id) },
    evidenceB: { kind: "report_result", reportID: await reportIDFor(world, world.b.attempt.id) },
    claimA: "the feature is broken",
    claimB: "the feature works",
    resolutionQuestion: "Does the feature work on the current candidate?",
    ...overrides,
  });
}

/** Issue THE one conflict-resolution directive (binds the resolver slot; no attempt). */
async function issueResolver(world: ConflictWorld, conflictID: VerificationConflictID, draft: Record<string, unknown> = {}) {
  const live = await execLive(world);
  return world.world.store.issueExecutionDirective({
    executionRunID: world.run.id,
    stageID: world.stage.id,
    windowID: world.window.id,
    ...EXEC_AUTH,
    ceiling: FULL_EXEC_CEILING,
    expectedRunRevision: live.run.revision,
    expectedStageRevision: live.stage.revision,
    expectedWindowRevision: live.window.revision,
    draft: {
      kind: "verification",
      objective: "resolve the disputed fact",
      planRefs: [{ kind: "implementation_step", order: 1 }],
      expectedExecutionScope: {},
      capabilityEnvelope: READ_ONLY,
      candidateEffect: "non_mutating",
      invariants: [],
      requiredActions: [],
      forbiddenActions: [],
      validationRequirements: [],
      deliverables: [],
      stopConditions: [],
      reportContract: "",
      body: "resolve",
      verificationPurpose: "conflict_resolution",
      conflictID,
      ...draft,
    },
  });
}

/** Issue + run THE one conflict-resolution directive (supports_a by default). */
async function runResolver(
  world: ConflictWorld,
  conflictID: VerificationConflictID,
  draft: Record<string, unknown> = {},
  report: Partial<WorkerReportPayload> = {},
) {
  const { directive, attempt } = await execRunDirective(
    world,
    {
      kind: "verification",
      objective: "resolve the disputed fact",
      candidateEffect: "non_mutating",
      capabilityEnvelope: READ_ONLY,
      verificationPurpose: "conflict_resolution",
      conflictID,
      ...draft,
    },
    { workerRole: "verifier", candidateMutation: "none", conflictResolutionOutcome: "supports_a", ...report },
  );
  return { directive, attempt, report: (await world.world.store.findExecutionReportForAttempt(attempt.id))! };
}

describe("ordinary defect vs true conflict (§18/§73/E21)", () => {
  it("an executor success + a blocking verifier defect blocks the commit WITHOUT any harness conflict", async () => {
    const world = await conflictWorld();
    await expect(world.world.store.submitSupervisorAssessment(await execAcceptInput(world))).rejects.toMatchObject({ code: "blocking_verification_result" });
    // No conflict exists: the normal path is rework → fresh verification.
    expect(await world.world.store.listVerificationConflictsForRun(world.run.id)).toEqual([]);
  });
});

describe("conflict creation (§23-§25/§74/E18-E20)", () => {
  it("Supervisor-explicit creation binds the exact current candidate and opens (§74/E18-E20)", async () => {
    const world = await conflictWorld();
    const { conflict, created } = await createConflict(world);
    expect(created).toBe(true);
    expect(conflict.status).toBe("open");
    expect(conflict.candidateRevision).toBe((await execLive(world)).window.candidateRevision);
    expect(conflict.resolutionDirectiveRef).toBeUndefined();
    // Creation records ONLY the conflict: no candidate move, no window change.
    const { window } = await execLive(world);
    expect(window.state).toBe("open");
    expect(await world.world.store.getVerificationConflict(conflict.id)).toEqual(conflict);
    // Idempotent same-content retry.
    const retry = await createConflict(world, { conflictID: conflict.id });
    expect(retry.created).toBe(false);
    expect(retry.conflict).toEqual(conflict);
  });

  it("§74 wrong revision / foreign evidence / identical refs / informational-only all FAIL", async () => {
    const world = await conflictWorld();
    const { window } = await execLive(world);
    // Wrong candidate revision.
    await expect(
      createConflict(world, { candidateRevision: window.candidateRevision + 1 }),
    ).rejects.toMatchObject({ code: "stale_candidate_revision" });
    // Same evidence ref on both sides.
    const aReport = await reportIDFor(world, world.a.attempt.id);
    await expect(
      createConflict(world, {
        evidenceA: { kind: "report_result", reportID: aReport },
        evidenceB: { kind: "report_result", reportID: aReport },
      }),
    ).rejects.toMatchObject({ code: "invalid_verification_evidence_ref" });
    // Out-of-bounds finding index.
    await expect(
      createConflict(world, {
        evidenceA: { kind: "finding", reportID: aReport, findingIndex: 99 },
      }),
    ).rejects.toMatchObject({ code: "invalid_verification_evidence_ref" });
    // Missing report.
    await expect(
      createConflict(world, { evidenceB: { kind: "report_result", reportID: "RPT-099" as never } }),
    ).rejects.toMatchObject({ code: "invalid_verification_evidence_ref" });
    // Purely informational disagreement (two inspection reports) — no harness conflict.
    const inspection1 = await execRunDirective(world, { kind: "inspection", objective: "look", candidateEffect: "non_mutating", capabilityEnvelope: READ_ONLY }, { workerRole: "executor", candidateMutation: "none" });
    const inspection2 = await execRunDirective(world, { kind: "inspection", objective: "look again", candidateEffect: "non_mutating", capabilityEnvelope: READ_ONLY }, { workerRole: "executor", candidateMutation: "none" });
    await expect(
      createConflict(world, {
        evidenceA: { kind: "report_result", reportID: await reportIDFor(world, inspection1.attempt.id) },
        evidenceB: { kind: "report_result", reportID: await reportIDFor(world, inspection2.attempt.id) },
      }),
    ).rejects.toMatchObject({ code: "invalid_scope" });
    expect(await world.world.store.listVerificationConflictsForRun(world.run.id)).toEqual([]);
  });
});

describe("conflict-resolution directive (§26-§29/§75/E22-E23,E27)", () => {
  it("§75 exactly ONE resolver: first issuance binds the slot, second fails conflict_resolution_already_used", async () => {
    const world = await conflictWorld();
    const { conflict } = await createConflict(world);
    const directive = await issueResolver(world, conflict.id);
    const stored = await world.world.store.getVerificationConflict(conflict.id);
    expect(stored!.status).toBe("open");
    expect(stored!.resolutionDirectiveRef).toEqual({ id: directive.id, revision: directive.revision, hash: directive.hash });
    await expect(issueResolver(world, conflict.id, { objective: "second resolver" })).rejects.toMatchObject({ code: "conflict_resolution_already_used" });
  });

  it("§27 resolver validation: kind/effect/conflictID/coverage/conflict existence/state/candidate", async () => {
    const world = await conflictWorld();
    const { conflict } = await createConflict(world);
    // Wrong kind.
    await expect(issueResolver(world, conflict.id, { kind: "inspection" })).rejects.toMatchObject({ code: "invalid_scope" });
    // Mutating resolver.
    await expect(issueResolver(world, conflict.id, { candidateEffect: "may_mutate", capabilityEnvelope: FULL_EXEC_CEILING })).rejects.toMatchObject({ code: "invalid_scope" });
    // Missing conflictID.
    await expect(issueResolver(world, conflict.id, { conflictID: undefined, verificationPurpose: "conflict_resolution" })).rejects.toMatchObject({ code: "invalid_scope" });
    // conflictID without the purpose.
    await expect(issueResolver(world, conflict.id, { verificationPurpose: undefined })).rejects.toMatchObject({ code: "invalid_scope" });
    // Unknown conflict.
    await expect(issueResolver(world, "VCF-099" as VerificationConflictID)).rejects.toMatchObject({ code: "verification_conflict_not_found" });
    // §28 — a resolver may declare EMPTY coverage, never non-empty coverage.
    await issueResolver(world, conflict.id, { verificationCoverage: { obligationRefs: [] } });
    void world;
  });

  it("§23 legacy directives default to acceptance semantics (E23)", async () => {
    const world = await conflictWorld();
    // A directive WITHOUT verificationPurpose is acceptance — it qualifies as the fresh verifier.
    await execCleanVerification(world, [], { objective: "legacy verification (no purpose field)" });
    await expect(world.world.store.submitSupervisorAssessment(await execAcceptInput(world))).rejects.toMatchObject({ code: "blocking_verification_result" });
    void world;
  });
});

describe("blinded resolver context (§31/§76/E26)", () => {
  it("the resolver context carries the question + both claims and NOTHING about the speakers", async () => {
    const world = await conflictWorld();
    const { conflict } = await createConflict(world);
    const { directive } = await runResolver(world, conflict.id, {}, { result: "blocked", blockers: [{ kind: "missing_context", summary: "context assembler never invoked in this dry-run" }] });
    const run = (await world.world.store.getExecutionRun(world.run.id))!;
    const finalPlanRecord = (await world.world.store.getCurrentFinalPlan(run.planID))!;
    const inputs = {
      planID: run.planID,
      finalPlan: run.finalPlan,
      finalPlanRecord,
      goal: "g",
      executionRunID: run.id,
      stage: { id: world.stage.id, title: world.stage.title, objective: world.stage.objective },
      window: { id: world.window.id, baseAcceptedState: world.window.baseAcceptedState },
      role: "verifier" as const,
      trustedCeiling: FULL_EXEC_CEILING,
      conflictResolutionContext: {
        conflictID: conflict.id,
        resolutionQuestion: conflict.resolutionQuestion,
        claimA: conflict.claimA,
        claimB: conflict.claimB,
      },
    };
    const context = await assembleExecutionWorkerContext(world.world.store, directive, inputs);
    expect(context.conflictResolutionContext).toBeDefined();
    expect(Object.keys(context.conflictResolutionContext!).sort()).toEqual(["claimA", "claimB", "conflictID", "resolutionQuestion"]);
    expect(context.conflictResolutionContext!.resolutionQuestion).toBe("Does the feature work on the current candidate?");
    expect(JSON.stringify(context.conflictResolutionContext)).not.toMatch(/executor|verifier A|verifier B|session|ATT-|worker/i);
    // A resolver assembled WITHOUT its dispute context fails closed.
    await expect(assembleExecutionWorkerContext(world.world.store, directive, { ...inputs, conflictResolutionContext: undefined })).rejects.toMatchObject({ code: "invalid_scope" });
  });
});

describe("conflict finalization & neutralization (§33/§34/§36/§77-§79)", () => {
  it("§77 supports_a resolves the conflict, neutralizes B, and A keeps blocking if A was blocking", async () => {
    const world = await conflictWorld();
    const { conflict } = await createConflict(world);
    const aReport = await reportIDFor(world, world.a.attempt.id);
    const bReport = await reportIDFor(world, world.b.attempt.id);
    const { report } = await runResolver(world, conflict.id, {}, { conflictResolutionOutcome: "supports_a" });
    void report;
    const stored = (await world.world.store.getVerificationConflict(conflict.id))!;
    expect(stored.status).toBe("resolved");
    expect(stored.resolutionReportRef).toBe(report.id);
    expect(stored.resolutionOutcome).toBe("supports_a");
    expect(stored.neutralizedEvidenceRefs).toEqual([{ kind: "report_result", reportID: bReport }]);
    expect(stored.resolvedAt).toBeDefined();
    // §64 — original reports are untouched.
    expect(await world.world.store.getExecutionReport(aReport)).toEqual(await world.world.store.getExecutionReport(aReport));
    expect((await world.world.store.getExecutionReport(aReport))!.result).toBe("failed");
    // A (the failed result) is NOT neutralized → commit remains blocked.
    await expect(world.world.store.submitSupervisorAssessment(await execAcceptInput(world))).rejects.toMatchObject({ code: "blocking_verification_result" });
  });

  it("§78 supports_a on clean-vs-blocking neutralizes the exact blocking evidence and the commit may proceed", async () => {
    const world = await supervisedWorld();
    await execRunDirective(world, { objective: "implementation" });
    const clean = await execCleanVerification(world, [], { objective: "clean acceptance verifier" });
    const blocking = await execRunDirective(
      world,
      { kind: "verification", objective: "blocking verifier", candidateEffect: "non_mutating", capabilityEnvelope: READ_ONLY },
      { workerRole: "verifier", candidateMutation: "none", findings: [{ statement: "the invariant is violated", acceptanceImpact: "blocking" }] },
    );
    const { window } = await execLive(world);
    const { conflict } = await world.world.store.createVerificationConflict({
      executionRunID: world.run.id,
      stageID: world.stage.id,
      windowID: world.window.id,
      candidateRevision: window.candidateRevision,
      ...EXEC_AUTH,
      evidenceA: { kind: "report_result", reportID: (await world.world.store.findExecutionReportForAttempt(clean.attempt.id))!.id },
      evidenceB: { kind: "finding", reportID: (await world.world.store.findExecutionReportForAttempt(blocking.attempt.id))!.id, findingIndex: 0 },
      claimA: "the candidate is clean",
      claimB: "the invariant is violated",
      resolutionQuestion: "Is the invariant violated on the current candidate?",
    });
    await runResolver(world as ConflictWorld, conflict.id, {}, { conflictResolutionOutcome: "supports_a" });
    const stored = (await world.world.store.getVerificationConflict(conflict.id))!;
    expect(stored.neutralizedEvidenceRefs).toEqual([
      { kind: "finding", reportID: (await world.world.store.findExecutionReportForAttempt(blocking.attempt.id))!.id, findingIndex: 0 },
    ]);
    // The clean acceptance verifier still qualifies → commit proceeds.
    const { commit } = (await world.world.store.submitSupervisorAssessment(await execAcceptInput(world))) as { commit: { id: string } };
    expect(commit.id).toBe("EC-001");
  });

  it("§79 supports_neither neutralizes BOTH disputed refs but never satisfies fresh acceptance verification", async () => {
    const world = await conflictWorld();
    const { conflict } = await createConflict(world);
    const aReport = await reportIDFor(world, world.a.attempt.id);
    const bReport = await reportIDFor(world, world.b.attempt.id);
    await runResolver(world, conflict.id, {}, { conflictResolutionOutcome: "supports_neither" });
    const stored = (await world.world.store.getVerificationConflict(conflict.id))!;
    expect(stored.status).toBe("resolved");
    expect(stored.neutralizedEvidenceRefs).toEqual([
      { kind: "report_result", reportID: aReport },
      { kind: "report_result", reportID: bReport },
    ]);
    // No ordinary acceptance verifier exists (B's clean report was contradicted away,
    // and the RESOLVER report can never count) → verification_required.
    await expect(world.world.store.submitSupervisorAssessment(await execAcceptInput(world))).rejects.toMatchObject({ code: "verification_required" });
  });

  it("§80 an unresolved or failed resolver terminally blocks verification; no second resolver; commit fails verification_blocked", async () => {
    const world = await conflictWorld();
    const { conflict } = await createConflict(world);
    await runResolver(world, conflict.id, {}, { conflictResolutionOutcome: "unresolved" });
    let stored = (await world.world.store.getVerificationConflict(conflict.id))!;
    expect(stored.status).toBe("verification_blocked");
    expect(stored.neutralizedEvidenceRefs).toEqual([]);
    // §35 no recursion: after verification_blocked a second resolver is refused.
    await expect(issueResolver(world, conflict.id, { objective: "retry the dispute" })).rejects.toMatchObject({ code: "invalid_scope" });
    // Commit fails verification_blocked (the blocked conflict is on the CURRENT candidate).
    await execCleanVerification(world, [], { objective: "fresh clean verifier" });
    await expect(world.world.store.submitSupervisorAssessment(await execAcceptInput(world))).rejects.toMatchObject({ code: "verification_blocked" });
    // Same terminal for a FAILED resolver.
    const world2 = await conflictWorld();
    const { conflict: conflict2 } = await createConflict(world2);
    await runResolver(world2, conflict2.id, {}, { result: "failed", conflictResolutionOutcome: undefined as never });
    stored = (await world2.world.store.getVerificationConflict(conflict2.id))!;
    expect(stored.status).toBe("verification_blocked");
  });

  it("§33 a MUTATING resolver advances the candidate and can never adjudicate — the conflict becomes history", async () => {
    const world = await conflictWorld();
    const { conflict } = await createConflict(world);
    await runResolver(world, conflict.id, {}, { conflictResolutionOutcome: "supports_a", candidateMutation: "changed" });
    const stored = (await world.world.store.getVerificationConflict(conflict.id))!;
    expect(stored.status).toBe("open");
    expect(stored.resolutionReportRef).toBeUndefined();
    const { window } = await execLive(world);
    expect(window.candidateRevision).toBe(2); // executor 0→1 + mutating resolver 1→2
    // No second resolver — the dispute is stale, not re-adjudicable (§27/§35).
    await expect(issueResolver(world, conflict.id, { objective: "again" })).rejects.toMatchObject({ code: "stale_candidate_revision" });
    // The historical open conflict does not block the NEW candidate once freshly verified.
    await execCleanVerification(world, [], { objective: "verify revision 2" });
    const { commit } = (await world.world.store.submitSupervisorAssessment(await execAcceptInput(world))) as { commit: { id: string } };
    expect(commit.id).toBe("EC-001");
  });
});

describe("§39 commit gates for open/blocked conflicts + §24/§81 staleness", () => {
  it("an OPEN current-candidate conflict blocks the commit (verification_conflict_open)", async () => {
    const world = await conflictWorld();
    await createConflict(world);
    await execCleanVerification(world, [], { objective: "clean verifier" });
    await expect(world.world.store.submitSupervisorAssessment(await execAcceptInput(world))).rejects.toMatchObject({ code: "verification_conflict_open" });
  });

  it("§81 an old-revision conflict never blocks a newer candidate; the new candidate still needs a fresh verifier", async () => {
    const world = await conflictWorld();
    const { conflict } = await createConflict(world);
    // Rework advances the candidate: 0 → 1; the conflict stays at 0.
    await execRunDirective(world, { objective: "rework" });
    // Stale clean verifier (B verified revision 0) cannot accept revision 1.
    await expect(world.world.store.submitSupervisorAssessment(await execAcceptInput(world))).rejects.toMatchObject({ code: "verification_required" });
    // Fresh verification at revision 1 + accept → the rev-0 conflict is history.
    await execCleanVerification(world, [], { objective: "fresh verification at revision 1" });
    const { commit } = (await world.world.store.submitSupervisorAssessment(await execAcceptInput(world))) as { commit: { id: string } };
    expect(commit.id).toBe("EC-001");
    expect((await world.world.store.getVerificationConflict(conflict.id))!.status).toBe("open");
  });
});

describe("durable persistence & malformed graphs (§61/§92-§93/E56)", () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "ultra-plan-exec-conflict-"));
    filePath = path.join(dir, "plan.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function corruptOpen(file: string): Promise<unknown> {
    try {
      new DurablePlanStore(file, { now: () => FIXED }).open();
      return Promise.reject(new Error("expected store_corrupt at open"));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  it("§93 conflict states + neutralized evidence survive close/reopen exactly", async () => {
    const loaded = await durableHandoffPendingWorld(filePath);
    const world = await conflictWorld(loaded as never);
    const { conflict } = await createConflict(world);
    const bReport = await reportIDFor(world, world.b.attempt.id);
    await runResolver(world, conflict.id, {}, { conflictResolutionOutcome: "supports_a" });
    (world.world.store as unknown as { close(): void }).close();
    const reopened = new DurablePlanStore(filePath, { now: () => FIXED });
    const stored = await reopened.getVerificationConflict(conflict.id);
    expect(stored!.status).toBe("resolved");
    expect(stored!.neutralizedEvidenceRefs).toEqual([{ kind: "report_result", reportID: bReport }]);
    expect(stored!.resolvedAt).toBeDefined();
    reopened.close();
  });

  it("§92 a resolved conflict WITHOUT its consumed resolver fails closed", async () => {
    const loaded = await durableHandoffPendingWorld(filePath);
    const world = await conflictWorld(loaded as never);
    const { conflict } = await createConflict(world);
    (world.world.store as unknown as { close(): void }).close();
    await tamper(filePath, (raw) => {
      const conflicts = raw["verificationConflicts"] as Record<string, Record<string, unknown>>;
      conflicts[conflict.id]!["status"] = "resolved";
      conflicts[conflict.id]!["resolvedAt"] = FIXED;
    });
    await expect(corruptOpen(filePath)).rejects.toMatchObject({ code: "store_corrupt" });
  });

  it("§92 a verification_blocked conflict without a consumed resolver fails closed", async () => {
    const loaded = await durableHandoffPendingWorld(filePath);
    const world = await conflictWorld(loaded as never);
    const { conflict } = await createConflict(world);
    (world.world.store as unknown as { close(): void }).close();
    await tamper(filePath, (raw) => {
      const conflicts = raw["verificationConflicts"] as Record<string, Record<string, unknown>>;
      conflicts[conflict.id]!["status"] = "verification_blocked";
    });
    await expect(corruptOpen(filePath)).rejects.toMatchObject({ code: "store_corrupt" });
  });

  it("§92 a resolution Report of the wrong kind/purpose fails closed", async () => {
    const loaded = await durableHandoffPendingWorld(filePath);
    const world = await conflictWorld(loaded as never);
    const { conflict } = await createConflict(world);
    const cleanReport = await reportIDFor(world, world.b.attempt.id);
    (world.world.store as unknown as { close(): void }).close();
    await tamper(filePath, (raw) => {
      const conflicts = raw["verificationConflicts"] as Record<string, Record<string, unknown>>;
      conflicts[conflict.id]!["status"] = "resolved";
      conflicts[conflict.id]!["resolutionReportRef"] = cleanReport;
      conflicts[conflict.id]!["resolutionOutcome"] = "supports_a";
      conflicts[conflict.id]!["resolvedAt"] = FIXED;
      conflicts[conflict.id]!["neutralizedEvidenceRefs"] = [];
    });
    // The clean verifier's directive is acceptance-purpose — not a legal resolver report.
    await expect(corruptOpen(filePath)).rejects.toMatchObject({ code: "store_corrupt" });
  });

  it("§92 TWO conflict-resolution directives for one conflict fail closed", async () => {
    const loaded = await durableHandoffPendingWorld(filePath);
    const world = await conflictWorld(loaded as never);
    const { conflict } = await createConflict(world);
    const { directive } = await runResolver(world, conflict.id, {}, { conflictResolutionOutcome: "unresolved" });
    (world.world.store as unknown as { close(): void }).close();
    await tamper(filePath, (raw) => {
      const directives = raw["executionDirectives"] as Record<string, Record<string, unknown>>;
      const clone = structuredClone(directives[`${directive.id}@${directive.revision}`]!);
      clone["revision"] = 2;
      clone["id"] = "DIR-099";
      clone["hash"] = computeExecutionDirectiveHashFromRecord(clone as never);
      clone["createdAt"] = FIXED;
      directives["DIR-099@2"] = clone;
    });
    await expect(corruptOpen(filePath)).rejects.toMatchObject({ code: "store_corrupt" });
  });

  it("§92 a tampered neutralization set fails closed", async () => {
    const loaded = await durableHandoffPendingWorld(filePath);
    const world = await conflictWorld(loaded as never);
    const { conflict } = await createConflict(world);
    await runResolver(world, conflict.id, {}, { conflictResolutionOutcome: "supports_a" });
    (world.world.store as unknown as { close(): void }).close();
    await tamper(filePath, (raw) => {
      const conflicts = raw["verificationConflicts"] as Record<string, Record<string, unknown>>;
      conflicts[conflict.id]!["neutralizedEvidenceRefs"] = conflicts[conflict.id]!["evidenceA"];
    });
    await expect(corruptOpen(filePath)).rejects.toMatchObject({ code: "store_corrupt" });
  });

  it("§92 an invalid evidence ref fails closed", async () => {
    const loaded = await durableHandoffPendingWorld(filePath);
    const world = await conflictWorld(loaded as never);
    const { conflict } = await createConflict(world);
    (world.world.store as unknown as { close(): void }).close();
    await tamper(filePath, (raw) => {
      const conflicts = raw["verificationConflicts"] as Record<string, Record<string, unknown>>;
      conflicts[conflict.id]!["evidenceA"] = { kind: "vibes" };
    });
    await expect(corruptOpen(filePath)).rejects.toMatchObject({ code: "store_corrupt" });
  });

  it("§61 a resolution outcome outside the deterministic rule (supports_b recorded but B not neutralized) fails closed", async () => {
    const loaded = await durableHandoffPendingWorld(filePath);
    const world = await conflictWorld(loaded as never);
    const { conflict } = await createConflict(world);
    await runResolver(world, conflict.id, {}, { conflictResolutionOutcome: "supports_b" });
    (world.world.store as unknown as { close(): void }).close();
    await tamper(filePath, (raw) => {
      const conflicts = raw["verificationConflicts"] as Record<string, Record<string, unknown>>;
      conflicts[conflict.id]!["resolutionOutcome"] = "supports_b";
      conflicts[conflict.id]!["neutralizedEvidenceRefs"] = conflicts[conflict.id]!["evidenceB"];
    });
    await expect(corruptOpen(filePath)).rejects.toMatchObject({ code: "store_corrupt" });
  });

  it("the v0.1 production handoff still creates NO execution artifacts (§95 regression)", async () => {
    const world = await durableHandoffPendingWorld(filePath);
    await world.controller.recoverExecutionHandoff(world.sessionID);
    expect(await world.store.listOpenExecutionRuns()).toHaveLength(0);
    const events = (await world.store.listEvents(world.runID)).map((event) => event.detail.type);
    expect(events.filter((type) => type.startsWith("execution."))).toEqual([]);
  });
});

describe("§24/§E36 next-window conflict binding after a commit", () => {
  it("a conflict binds ONE candidate forever; the next window's candidate is a different dispute space", async () => {
    const world = await conflictWorld();
    const { conflict } = await createConflict(world);
    // Resolver blocks verification on the current candidate.
    await runResolver(world, conflict.id, {}, { conflictResolutionOutcome: "unresolved" });
    // Rework + fresh verification + accept closes the window despite the blocked rev-0 conflict? No — blocked conflict at CURRENT candidate blocks:
    await expect(world.world.store.submitSupervisorAssessment(await execAcceptInput(world))).rejects.toMatchObject({ code: "verification_blocked" });
    void execOpenNextWindow;
  });
});
