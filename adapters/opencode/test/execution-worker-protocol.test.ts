/**
 * v0.2.0 Phase 4 — ExecutionDirective + ExecutionAttempt + ExecutionReport +
 * ExecutionWorker foundation.
 *
 * Covers the Phase 4 directive gates: the structured bounded-authorization
 * Directive with canonical hash and immutable revisions (§5/§9/§16-§18/§55/
 * §56), the issuance gate with exact structure/candidate bindings and the
 * trusted capability ceiling (§7/§8/§12/§14/§19), the Attempt protocol —
 * one logical Attempt per exact Directive revision, one running Attempt per
 * run, running→reported/indeterminate terminal states (§21-§25/§57), stale
 * candidate refusal at start (§58), the unified Executor/Verifier Report
 * with explicit orthogonal candidateMutation and structured blockers
 * (§27-§29/§34-§36/§59/§62), the ATOMIC report transaction with candidate
 * advance (§30/§31/§60), unexpected-mutation preservation (§32/§61), the
 * planRef-scoped Worker context and common worker port (§39/§41-§43/§63/
 * §64), durable concurrency (§65-§67), indeterminate facts + recovery
 * projection (§26/§50/§51/§68), persistence/backward-compatibility (§45/
 * §69), and the scope gates: no Assessment/Commit/acceptedHead/Window-close/
 * Stage-complete/verifier-scheduler (§2/§38/E38-E41), no model-facing API
 * (§53/E42), no production callers (§54/E43).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DurablePlanStore,
  assembleExecutionWorkerContext,
  computeExecutionDirectiveHash,
  capabilityEnvelope,
  type ExecutionDirective,
  type ExecutionRun,
  type ExecutionStage,
  type FinalPlanID,
  type InMemoryPlanStore as InMemoryPlanStoreType,
  type PlanID,
  type VerificationWindow,
  type WorkerReportPayload,
} from "../src/index.js";
import type { PlanningRun } from "../src/core/types.js";
import {
  FIXED,
  WORKSPACE,
  durableHandoffPendingWorld,
  handoffPendingWorld,
  prepareInput,
  tamper,
} from "./execution-world.js";

const OWNER = "ses_worker_supervisor";
const AUTH = { sessionID: OWNER, workspace: WORKSPACE, generation: 1 };
const FULL_CEILING = capabilityEnvelope([
  "repositoryRead",
  "repositoryWrite",
  "commandExecution",
  "networkAccess",
  "dependencyMutation",
  "gitCommit",
  "gitPush",
  "externalServiceMutation",
]);
const READONLY_CEILING = capabilityEnvelope(["repositoryRead"]);

/** A supervised-active world with an active Stage and an open Window. */
async function directiveWorld(world?: { store: InMemoryPlanStoreType; runID: PlanID; finalPlan: { id: FinalPlanID; revision: number; hash: string } }): Promise<DirectiveWorld> {
  const base = world ?? (await handoffPendingWorld());
  const { run } = await base.store.prepareInitialExecutionRun(prepareInput(base));
  await base.store.attachExecutionSupervisor({ executionRunID: run.id, sessionID: OWNER, workspace: WORKSPACE });
  const active = await base.store.activateSupervisedExecutionRun({
    executionRunID: run.id,
    sessionID: OWNER,
    workspace: WORKSPACE,
    generation: 1,
    runRevision: run.revision,
    finalPlan: run.finalPlan,
  });
  const stages = await base.store.createExecutionStages({
    executionRunID: active.id,
    ...AUTH,
    drafts: [{ title: "Stage A", objective: "objective", planRefs: [{ kind: "implementation_step", order: 1 }], dependsOn: [] }],
  });
  const stage = stages[0]!;
  const activatedStage = await base.store.activateExecutionStage({
    executionRunID: active.id,
    stageID: stage.id,
    ...AUTH,
    expectedRunRevision: active.revision,
    expectedStageRevision: stage.revision,
  });
  const { window, run: openRun } = await base.store.openVerificationWindow({
    executionRunID: active.id,
    stageID: stage.id,
    ...AUTH,
    expectedRunRevision: activatedStage.run.revision,
    expectedStageRevision: activatedStage.stage.revision,
  });
  return { world: base, run: openRun, stage: activatedStage.stage, window };
}

interface DirectiveWorld {
  world: { store: InMemoryPlanStoreType; runID: PlanID; finalPlan: { id: FinalPlanID; revision: number; hash: string } };
  run: ExecutionRun;
  stage: ExecutionStage;
  window: VerificationWindow;
}

const DRAFT = {
  kind: "implementation" as const,
  objective: "Implement the runtime core obligations",
  planRefs: [{ kind: "implementation_step" as const, order: 1 }],
  expectedExecutionScope: { files: ["src/runtime.ts"], symbols: ["startRuntime"] },
  capabilityEnvelope: capabilityEnvelope(["repositoryRead", "repositoryWrite"]),
  candidateEffect: "may_mutate" as const,
  invariants: ["no public API changes"],
  requiredActions: ["wire the runtime"],
  forbiddenActions: ["no dependency mutation"],
  validationRequirements: ["tests must pass"],
  deliverables: ["working runtime"],
  stopConditions: ["stop when blocked"],
  reportContract: "report completed/partial/blocked/failed with candidateMutation",
  body: "Implement the runtime integration for the approved sections.",
};

const issueInput = (world: DirectiveWorld, overrides: Record<string, unknown> = {}) => ({
  executionRunID: world.run.id,
  stageID: world.stage.id,
  windowID: world.window.id,
  ...AUTH,
  ceiling: FULL_CEILING,
  expectedRunRevision: world.run.revision,
  expectedStageRevision: world.stage.revision,
  expectedWindowRevision: world.window.revision,
  draft: { ...DRAFT },
  ...overrides,
});

/** Fresh CAS expectations from live store state (for tests that mutate structure first). */
async function rereadCAs(world: DirectiveWorld) {
  const run = (await world.world.store.getExecutionRun(world.run.id))!;
  const stage = (await world.world.store.getExecutionStage(world.stage.id))!;
  const window = (await world.world.store.findOpenVerificationWindow(world.run.id))!;
  return { expectedRunRevision: run.revision, expectedStageRevision: stage.revision, expectedWindowRevision: window.revision };
}

/** Issue → start → returns the running Attempt + its directive. */
async function runningAttempt(world: DirectiveWorld, draft: Record<string, unknown> = {}) {
  const directive = await world.world.store.issueExecutionDirective(issueInput(world, { draft: { ...DRAFT, ...draft } }));
  const { attempt } = await world.world.store.startExecutionAttempt({
    executionRunID: world.run.id,
    directive: { id: directive.id, revision: directive.revision },
    ...AUTH,
    ceiling: FULL_CEILING,
  });
  return { directive, attempt };
}

const payload = (world: DirectiveWorld, directive: ExecutionDirective, overrides: Partial<WorkerReportPayload> = {}): WorkerReportPayload => ({
  directive: { id: directive.id, revision: directive.revision, hash: directive.hash },
  workerRole: "executor",
  result: "completed",
  actionsPerformed: ["edited src/runtime.ts"],
  filesExamined: ["src/runtime.ts"],
  filesChanged: ["src/runtime.ts"],
  commandsRun: ["npm test"],
  testsRun: ["npm test"],
  findings: [],
  deviations: [],
  blockers: [],
  deliverables: ["runtime wired"],
  candidateMutation: "changed",
  baseCandidateRevision: world.window.candidateRevision,
  ...overrides,
});

// -----------------------------------------------------------------------------
// §5/§9/§19/§55 — Directive issuance gate
// -----------------------------------------------------------------------------

describe("Directive issuance (§5/§9/§19/§55)", () => {
  it("issues implementation / inspection / verification directives bound to the exact structure", async () => {
    for (const kind of ["implementation", "inspection", "verification"] as const) {
      const world = await directiveWorld();
      const directive = await world.world.store.issueExecutionDirective(issueInput(world, { draft: { ...DRAFT, kind } }));
      expect(directive).toMatchObject({
        id: "DIR-001",
        revision: 1,
        executionRunID: world.run.id,
        stageID: world.stage.id,
        windowID: world.window.id,
        kind,
        baseAcceptedState: { kind: "execution_start", executionRunID: world.run.id },
        baseCandidateRevision: world.window.candidateRevision,
        finalPlan: { id: world.world.finalPlan.id, revision: world.world.finalPlan.revision },
      });
      // §20 frozen role mapping.
      const { attempt } = await world.world.store.startExecutionAttempt({
        executionRunID: world.run.id,
        directive: { id: directive.id, revision: directive.revision },
        ...AUTH,
        ceiling: FULL_CEILING,
      });
      expect(attempt.workerRole).toBe(kind === "verification" ? "verifier" : "executor");
    }
  });

  it("refuses wrong structure, stale candidate, wrong FinalPlan, invalid planRef, capability above ceiling (§55)", async () => {
    const world = await directiveWorld();
    // A pending (non-active) stage name → directive_not_current.
    const stages = await world.world.store.createExecutionStages({ executionRunID: world.run.id, ...AUTH, drafts: [{ ...{ title: "B", objective: "o", planRefs: [], dependsOn: [] } }] });
    await expect(world.world.store.issueExecutionDirective(issueInput(world, { stageID: stages[0]!.id }))).rejects.toMatchObject({ code: "directive_not_current" });
    // Wrong window.
    await expect(world.world.store.issueExecutionDirective(issueInput(world, { windowID: "WIN-099" as never }))).rejects.toMatchObject({ code: "directive_not_current" });
    // Stale run CAS.
    await expect(world.world.store.issueExecutionDirective(issueInput(world, { expectedRunRevision: world.run.revision - 1 }))).rejects.toMatchObject({ code: "stale_execution_run" });
    // Invalid planRef (unknown section revision).
    await expect(
      world.world.store.issueExecutionDirective(issueInput(world, { draft: { ...DRAFT, planRefs: [{ kind: "section_revision", id: "SEC-001", revision: 9 }] } })),
    ).rejects.toMatchObject({ code: "invalid_scope" });
    // Capability above the trusted ceiling (§14: narrow only).
    await expect(
      world.world.store.issueExecutionDirective(issueInput(world, { ceiling: READONLY_CEILING })),
    ).rejects.toMatchObject({ code: "capability_not_available" });
    // Wrong FinalPlan binding is impossible by construction (copied from the run) — prove the copy:
    const directive = await world.world.store.issueExecutionDirective(issueInput(world));
    expect(directive.finalPlanHash).toBe(world.world.finalPlan.hash);
  });

  it("issuing does NOT advance candidateRevision and does NOT start a worker (§19)", async () => {
    const world = await directiveWorld();
    await world.world.store.issueExecutionDirective(issueInput(world));
    expect((await world.world.store.findOpenVerificationWindow(world.run.id))!.candidateRevision).toBe(world.window.candidateRevision);
    expect(await world.world.store.findRunningExecutionAttempt(world.run.id)).toBeUndefined();
  });
});

// -----------------------------------------------------------------------------
// §16/§17/§18/§56 — Immutable revisions + canonical hash
// -----------------------------------------------------------------------------

describe("Directive revisions & hash (§16-§18/§56)", () => {
  it("@1 stays immutable when @2 is issued; hashes differ; both durable", async () => {
    const world = await directiveWorld();
    const first = await world.world.store.issueExecutionDirective(issueInput(world));
    const firstHash = first.hash;
    // Re-issuing IDENTICAL content under the same logical id is idempotent.
    const same = await world.world.store.issueExecutionDirective(issueInput(world, { draft: { ...DRAFT, directiveID: first.id } }));
    expect(same.id).toBe(first.id);
    expect(same.revision).toBe(1);
    expect(same.hash).toBe(firstHash);
    // New content under the same logical id → new revision, old stays.
    const second = await world.world.store.issueExecutionDirective(
      issueInput(world, { draft: { ...DRAFT, directiveID: first.id, body: `${DRAFT.body} (clarified)` } }),
    );
    expect(second.revision).toBe(2);
    expect(second.hash).not.toBe(firstHash);
    const reread1 = await world.world.store.getExecutionDirective(first.id, 1);
    expect(reread1).toEqual(first);
    expect((await world.world.store.getExecutionDirective(first.id))!.revision).toBe(2);
    // Same logical id with a different base candidate revision (window advanced) also creates @3.
    await world.world.store.advanceCandidateRevision({ executionRunID: world.run.id, ...AUTH, expectedCandidateRevision: 0 });
    const third = await world.world.store.issueExecutionDirective(
      issueInput(world, { draft: { ...DRAFT, directiveID: first.id }, expectedRunRevision: world.run.revision, expectedStageRevision: world.stage.revision, expectedWindowRevision: world.window.revision + 1 }),
    );
    expect(third.id).toBe(first.id);
    expect(third.revision).toBe(3);
    expect(third.baseCandidateRevision).toBe(1);
  });

  it("hash discipline: same content → same hash; body/capability/candidate/planRef changes → different hash (§56)", async () => {
    const world = await directiveWorld();
    const directive = await world.world.store.issueExecutionDirective(issueInput(world));
    const rehash = (mutate: (d: ExecutionDirective) => ExecutionDirective): string =>
      computeExecutionDirectiveHash((() => {
        const { createdAt: _c, hash: _h, ...payload } = mutate(structuredClone(directive));
        void _c;
        void _h;
        return payload;
      })());
    expect(rehash((d) => d)).toBe(directive.hash);
    expect(rehash((d) => ({ ...d, body: "changed" }))).not.toBe(directive.hash);
    expect(rehash((d) => ({ ...d, capabilityEnvelope: { ...d.capabilityEnvelope, networkAccess: true } }))).not.toBe(directive.hash);
    expect(rehash((d) => ({ ...d, baseCandidateRevision: d.baseCandidateRevision + 1 }))).not.toBe(directive.hash);
    expect(rehash((d) => ({ ...d, planRefs: [{ kind: "implementation_step", order: 1 }, { kind: "implementation_step", order: 1 }] }))).not.toBe(directive.hash);
    // createdAt excluded from the hash (logical content compares stably).
    expect(rehash((d) => ({ ...d, createdAt: "2099-01-01T00:00:00.000Z" }))).toBe(directive.hash);
  });
});

// -----------------------------------------------------------------------------
// §21-§25/§57/§58 — Attempt protocol
// -----------------------------------------------------------------------------

describe("Attempt protocol (§21-§25/§57/§58)", () => {
  it("one Attempt per exact Directive revision; second start FAILs attempt_already_consumed (§22)", async () => {
    const world = await directiveWorld();
    const { directive, attempt } = await runningAttempt(world);
    expect(attempt.state).toBe("running");
    await expect(
      world.world.store.startExecutionAttempt({
        executionRunID: world.run.id,
        directive: { id: directive.id, revision: directive.revision },
        ...AUTH,
        ceiling: FULL_CEILING,
      }),
    ).rejects.toMatchObject({ code: "attempt_already_consumed" });
  });

  it("a second running Attempt in the same run FAILs active_attempt_conflict (§23)", async () => {
    const world = await directiveWorld();
    await runningAttempt(world, {});
    const stages = await world.world.store.createExecutionStages({ executionRunID: world.run.id, ...AUTH, drafts: [{ title: "B", objective: "o", planRefs: [], dependsOn: [] }] });
    void stages;
    // Issue a second directive on the SAME window/structure (legal) and try to start it.
    const second = await world.world.store.issueExecutionDirective(
      issueInput(world, { draft: { ...DRAFT, objective: "second" } }),
    );
    void second;
    await expect(
      world.world.store.startExecutionAttempt({
        executionRunID: world.run.id,
        directive: { id: second.id, revision: second.revision },
        ...AUTH,
        ceiling: FULL_CEILING,
      }),
    ).rejects.toMatchObject({ code: "active_attempt_conflict" });
  });

  it("state machine: running → reported and running → indeterminate PASS; terminal states refuse everything (§25/§57)", async () => {
    // Indeterminate arm (separate world: Phase 6A §42 reconciliation mode
    // forbids issuing follow-up work after an indeterminate Attempt).
    const indeterminateWorld = await directiveWorld();
    const first = await runningAttempt(indeterminateWorld);
    await indeterminateWorld.world.store.markExecutionAttemptIndeterminate({ executionRunID: indeterminateWorld.run.id, attemptID: first.attempt.id, ...AUTH });
    await expect(
      indeterminateWorld.world.store.markExecutionAttemptIndeterminate({ executionRunID: indeterminateWorld.run.id, attemptID: first.attempt.id, ...AUTH }),
    ).rejects.toMatchObject({ code: "invalid_attempt_transition" });
    await expect(
      indeterminateWorld.world.store.submitExecutionReport({
        executionRunID: indeterminateWorld.run.id,
        attemptID: first.attempt.id,
        report: payload(indeterminateWorld, first.directive, { candidateMutation: "none", baseCandidateRevision: 0 }),
        ...AUTH,
      }),
    ).rejects.toMatchObject({ code: "invalid_attempt_transition" });
    // Reported arm: running → reported works; then terminal.
    const world = await directiveWorld();
    const second = await runningAttempt(world);
    const { report } = await world.world.store.submitExecutionReport({
      executionRunID: world.run.id,
      attemptID: second.attempt.id,
      report: payload(world, second.directive, { candidateMutation: "none" }),
      ...AUTH,
    });
    expect(report.result).toBe("completed");
    expect((await world.world.store.getExecutionAttempt(second.attempt.id))!.state).toBe("reported");
    await expect(
      world.world.store.markExecutionAttemptIndeterminate({ executionRunID: world.run.id, attemptID: second.attempt.id, ...AUTH }),
    ).rejects.toMatchObject({ code: "invalid_attempt_transition" });
  });

  it("a Directive on a stale candidate revision can no longer START (§8/§58)", async () => {
    const world = await directiveWorld();
    const directive = await world.world.store.issueExecutionDirective(issueInput(world));
    // A reported mutation advances the window past the directive's base.
    await world.world.store.advanceCandidateRevision({ executionRunID: world.run.id, ...AUTH, expectedCandidateRevision: 0 });
    await expect(
      world.world.store.startExecutionAttempt({
        executionRunID: world.run.id,
        directive: { id: directive.id, revision: directive.revision },
        ...AUTH,
        ceiling: FULL_CEILING,
      }),
    ).rejects.toMatchObject({ code: "stale_candidate_revision" });
    // The fresh directive revision binds the new base and starts.
    const fresh = await world.world.store.issueExecutionDirective(
      issueInput(world, { draft: { ...DRAFT, directiveID: directive.id }, ...(await rereadCAs(world)) }),
    );
    expect(fresh.baseCandidateRevision).toBe(1);
    const { attempt } = await world.world.store.startExecutionAttempt({
      executionRunID: world.run.id,
      directive: { id: fresh.id, revision: fresh.revision },
      ...AUTH,
      ceiling: FULL_CEILING,
    });
    expect(attempt.state).toBe("running");
  });

  it("capability ceiling re-checked at start (§24/§44)", async () => {
    const world = await directiveWorld();
    const directive = await world.world.store.issueExecutionDirective(issueInput(world));
    await expect(
      world.world.store.startExecutionAttempt({
        executionRunID: world.run.id,
        directive: { id: directive.id, revision: directive.revision },
        ...AUTH,
        ceiling: READONLY_CEILING,
      }),
    ).rejects.toMatchObject({ code: "capability_not_available" });
  });
});

// -----------------------------------------------------------------------------
// §27-§31/§34-§36/§59-§62 — Report schema & transaction
// -----------------------------------------------------------------------------

describe("Report transaction (§27-§31/§59-§62)", () => {
  it("result ⊥ mutation: every combination persists; only changed advances +1 (§29/§59)", async () => {
    for (const [index, [result, mutation]] of (
      [
        ["completed", "changed"],
        ["completed", "none"],
        ["partial", "changed"],
        ["blocked", "none"],
        ["blocked", "changed"],
        ["failed", "none"],
        ["failed", "changed"],
      ] as const
    ).entries()) {
      const world = await directiveWorld();
      const { directive, attempt } = await runningAttempt(world);
      const blockers = result === "blocked" ? [{ kind: "missing_context" as const, summary: "need the schema" }] : [];
      const { report, window } = await world.world.store.submitExecutionReport({
        executionRunID: world.run.id,
        attemptID: attempt.id,
        report: payload(world, directive, { result, candidateMutation: mutation, blockers }),
        ...AUTH,
      });
      expect(report.result).toBe(result);
      expect(report.candidateMutation).toBe(mutation);
      expect(window.candidateRevision).toBe(mutation === "changed" ? 1 : 0);
      expect(report.resultingCandidateRevision).toBe(window.candidateRevision);
      expect((await world.world.store.getExecutionAttempt(attempt.id))!.state).toBe("reported");
      void index;
    }
  });

  it("blocked requires ≥1 blocker; non-blocked forbids blockers (§62)", async () => {
    const world = await directiveWorld();
    const { directive, attempt } = await runningAttempt(world);
    await expect(
      world.world.store.submitExecutionReport({
        executionRunID: world.run.id,
        attemptID: attempt.id,
        report: payload(world, directive, { result: "blocked", candidateMutation: "none", blockers: [] }),
        ...AUTH,
      }),
    ).rejects.toMatchObject({ code: "invalid_scope" });
    await expect(
      world.world.store.submitExecutionReport({
        executionRunID: world.run.id,
        attemptID: attempt.id,
        report: payload(world, directive, { result: "completed", candidateMutation: "none", blockers: [{ kind: "missing_context", summary: "x" }] }),
        ...AUTH,
      }),
    ).rejects.toMatchObject({ code: "invalid_scope" });
    // Attempt still running — nothing was consumed by the refused reports.
    expect((await world.world.store.getExecutionAttempt(attempt.id))!.state).toBe("running");
  });

  it("report/directive/role mismatches fail; one report per attempt (§30)", async () => {
    const world = await directiveWorld();
    const { directive, attempt } = await runningAttempt(world);
    await expect(
      world.world.store.submitExecutionReport({
        executionRunID: world.run.id,
        attemptID: attempt.id,
        report: payload(world, directive, { directive: { id: directive.id, revision: 9, hash: directive.hash } }),
        ...AUTH,
      }),
    ).rejects.toMatchObject({ code: "report_directive_mismatch" });
    await expect(
      world.world.store.submitExecutionReport({
        executionRunID: world.run.id,
        attemptID: attempt.id,
        report: payload(world, directive, { workerRole: "verifier" }),
        ...AUTH,
      }),
    ).rejects.toMatchObject({ code: "invalid_worker_role" });
    await expect(
      world.world.store.submitExecutionReport({
        executionRunID: world.run.id,
        attemptID: attempt.id,
        report: payload(world, directive, { baseCandidateRevision: 5 }),
        ...AUTH,
      }),
    ).rejects.toMatchObject({ code: "stale_candidate_revision" });
    await world.world.store.submitExecutionReport({
      executionRunID: world.run.id,
      attemptID: attempt.id,
      report: payload(world, directive, { candidateMutation: "none" }),
      ...AUTH,
    });
    // The attempt is already terminal, so the state guard fires before the
    // report-conflict check; one-report-per-attempt is storage-proven in the
    // malformed suite below (duplicate Report -> corrupt).
    await expect(
      world.world.store.submitExecutionReport({
        executionRunID: world.run.id,
        attemptID: attempt.id,
        report: payload(world, directive, { candidateMutation: "none" }),
        ...AUTH,
      }),
    ).rejects.toMatchObject({ code: "invalid_attempt_transition" });
  });

  it("deviations are preserved, never auto-failures (§36)", async () => {
    const world = await directiveWorld();
    const { directive, attempt } = await runningAttempt(world);
    const { report } = await world.world.store.submitExecutionReport({
      executionRunID: world.run.id,
      attemptID: attempt.id,
      report: payload(world, directive, {
        candidateMutation: "changed",
        deviations: [{ kind: "symbol", expected: "startRuntime", actual: "bootstrapRuntime", note: "repository reality uses a different symbol name" }],
      }),
      ...AUTH,
    });
    expect(report.deviations).toHaveLength(1);
    expect(report.result).toBe("completed");
  });
});

// -----------------------------------------------------------------------------
// §31/§60/§61 — Atomic candidate advance + unexpected mutation
// -----------------------------------------------------------------------------

describe("atomic candidate advance (§31/§60/§61)", () => {
  it("report + attempt completion + candidate advance are one durable transaction (§60)", async () => {
    let dir: string | undefined;
    try {
      dir = await mkdtemp(path.join(tmpdir(), "ultra-plan-worker-"));
      const file = path.join(dir, "plan.json");
      const world = await durableHandoffPendingWorld(file);
      const dw = await directiveWorld(world);
      const { directive, attempt } = await runningAttempt(dw);
      await dw.world.store.submitExecutionReport({
        executionRunID: dw.run.id,
        attemptID: attempt.id,
        report: payload(dw, directive, { candidateMutation: "changed" }),
        ...AUTH,
      });
      // One event carries report ref + provenance; the window advanced in the
      // same transaction — never report-then-bump.
      const events = (await dw.world.store.listEvents(world.runID)).filter((event) => event.detail.type === "execution.attempt_reported");
      expect(events).toHaveLength(1);
      (dw.world.store as unknown as { close(): void }).close();
      const verify = new DurablePlanStore(file, { now: () => FIXED });
      expect((await verify.findOpenVerificationWindow(dw.run.id))!.candidateRevision).toBe(1);
      expect((await verify.listExecutionReportsForRun(dw.run.id))).toHaveLength(1);
      verify.close();
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  });

  it("a non-mutating directive whose report declares mutation is preserved AND advances with an audit event (§32/§61)", async () => {
    const world = await directiveWorld();
    const { directive, attempt } = await runningAttempt(world, { candidateEffect: "non_mutating", capabilityEnvelope: capabilityEnvelope(["repositoryRead"]) });
    const { report, window } = await world.world.store.submitExecutionReport({
      executionRunID: world.run.id,
      attemptID: attempt.id,
      report: payload(world, directive, { candidateMutation: "changed" }),
      ...AUTH,
    });
    expect(report.candidateMutation).toBe("changed");
    expect(window.candidateRevision).toBe(1);
    const events = (await world.world.store.listEvents(world.world.runID)).map((event) => event.detail.type);
    expect(events).toContain("execution.unexpected_candidate_mutation");
  });
});

// -----------------------------------------------------------------------------
// §39/§41-§44/§63/§64 — Worker port & context isolation
// -----------------------------------------------------------------------------

describe("worker context & port (§39/§41-§44/§63/§64)", () => {
  it("resolves EXACTLY the directive planRefs — unreferenced Plan Memory is absent (§42/§63)", async () => {
    const world = await directiveWorld();
    const directive = await world.world.store.issueExecutionDirective(issueInput(world));
    const context = await assembleExecutionWorkerContext(world.world.store, directive, {
      planID: world.world.runID,
      finalPlan: { id: world.world.finalPlan.id, revision: world.world.finalPlan.revision },
      finalPlanRecord: (await world.world.store.getFinalPlan(world.world.runID, world.world.finalPlan.id, 1))!,
      goal: "Build the supervised execution foundation",
      executionRunID: world.run.id,
      stage: { id: world.stage.id, title: world.stage.title, objective: world.stage.objective },
      window: { id: world.window.id, baseAcceptedState: world.window.baseAcceptedState },
      role: "executor",
      trustedCeiling: FULL_CEILING,
    });
    expect(context.resolvedPlanRefs).toHaveLength(1);
    expect(context.resolvedPlanRefs[0]).toMatchObject({ kind: "implementation_step", order: 1 });
    expect(context.finalPlanIdentity).toMatchObject({ id: world.world.finalPlan.id, revision: 1 });
    expect(context.effectiveCapabilities).toEqual(directive.capabilityEnvelope);
    // §63: no planning conversation / hidden reasoning / executor history exists in the context.
    expect(JSON.stringify(context)).not.toContain("conversation");
    // Exact resolution: the step content IS the committed FinalPlan step.
    const finalPlanRecord = (await world.world.store.getFinalPlan(world.world.runID, world.world.finalPlan.id, 1))!;
    expect(context.resolvedPlanRefs[0]!.content).toEqual(finalPlanRecord.implementationOrder[0]);
  });

  it("the common port serves both roles through ONE protocol — no second object model (§39/§64)", async () => {
    const world = await directiveWorld();
    const implementation = await world.world.store.issueExecutionDirective(issueInput(world));
    const verification = await world.world.store.issueExecutionDirective(
      issueInput(world, { draft: { ...DRAFT, kind: "verification" as const, candidateEffect: "non_mutating" as const, objective: "verify" } }),
    );
    const seen: string[] = [];
    const fakeWorker = {
      async run(input: { role: string; directive: ExecutionDirective; context: { directive: ExecutionDirective }; effectiveCapabilities: unknown }) {
        seen.push(input.role);
        return {
          directive: { id: input.context.directive.id, revision: input.context.directive.revision, hash: input.context.directive.hash },
          workerRole: input.role as never,
          result: "completed" as const,
          actionsPerformed: [],
          filesExamined: [],
          filesChanged: [],
          commandsRun: [],
          testsRun: [],
          findings: [],
          deviations: [],
          blockers: [],
          deliverables: [],
          candidateMutation: "none" as const,
          baseCandidateRevision: input.context.directive.baseCandidateRevision,
        };
      },
    };
    for (const directive of [implementation, verification]) {
      const { attempt } = await world.world.store.startExecutionAttempt({
        executionRunID: world.run.id,
        directive: { id: directive.id, revision: directive.revision },
        ...AUTH,
        ceiling: FULL_CEILING,
      });
      const role = attempt.workerRole;
      await fakeWorker.run({ role, directive, context: { directive }, effectiveCapabilities: directive.capabilityEnvelope });
      await world.world.store.markExecutionAttemptIndeterminate({ executionRunID: world.run.id, attemptID: attempt.id, ...AUTH });
    }
    expect(seen).toEqual(["executor", "verifier"]);
    const exports = await import("../src/index.js");
    for (const name of Object.getOwnPropertyNames(exports)) {
      expect(name).not.toMatch(/Verifier(Report|Store|Attempt)|ExecutorRunner|VerifierRunner/);
    }
  });
});

// -----------------------------------------------------------------------------
// §50/§51/§68 — Indeterminate facts & recovery projection
// -----------------------------------------------------------------------------

describe("indeterminate work & recovery (§50/§51/§68)", () => {
  it("indeterminate never advances candidateRevision, blocks its Directive revision forever, and forces reconciliation mode (§68; Phase 6A §42 upgrade)", async () => {
    const world = await directiveWorld();
    const { directive, attempt } = await runningAttempt(world);
    await world.world.store.markExecutionAttemptIndeterminate({ executionRunID: world.run.id, attemptID: attempt.id, ...AUTH });
    expect((await world.world.store.findOpenVerificationWindow(world.run.id))!.candidateRevision).toBe(0);
    await expect(
      world.world.store.startExecutionAttempt({
        executionRunID: world.run.id,
        directive: { id: directive.id, revision: directive.revision },
        ...AUTH,
        ceiling: FULL_CEILING,
      }),
    ).rejects.toMatchObject({ code: "attempt_already_consumed" });
    // Phase 6A §42: a NEW directive revision is no longer freely issuable —
    // only the explicit reconciliation inspection is allowed.
    await expect(
      world.world.store.issueExecutionDirective(
        issueInput(world, { draft: { ...DRAFT, directiveID: directive.id, body: `${DRAFT.body} (recovery clarification)` }, ...(await rereadCAs(world)) }),
      ),
    ).rejects.toMatchObject({ code: "reconciliation_required" });
    const context = await world.world.store.buildExecutionRecoveryContext(world.run.id, { sessionID: OWNER });
    expect(context!.reconciliationRequired).toBe(true);
    expect(context!.indeterminateAttempts).toHaveLength(1);
    expect(context!.unresolvedIndeterminateAttempts).toHaveLength(1);
    expect(context!.runningAttempt).toBeUndefined();
    expect(context!.latestDirective).toMatchObject({ id: directive.id, revision: 1 });
    void world;
  });
});

// -----------------------------------------------------------------------------
// §45/§46-§48/§69 — Persistence, load validation, backward compatibility
// -----------------------------------------------------------------------------

describe("persistence & compatibility (§45/§69)", () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "ultra-plan-worker-mig-"));
    filePath = path.join(dir, "plan.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("directives (hashes), attempts (states), and reports survive close/reopen exactly (§69)", async () => {
    const world = await durableHandoffPendingWorld(filePath);
    const dw = await directiveWorld(world);
    const { directive, attempt } = await runningAttempt(dw);
    const { report } = await dw.world.store.submitExecutionReport({
      executionRunID: dw.run.id,
      attemptID: attempt.id,
      report: payload(dw, directive, { candidateMutation: "changed" }),
      ...AUTH,
    });
    (dw.world.store as unknown as { close(): void }).close();
    const reopened = new DurablePlanStore(filePath, { now: () => FIXED });
    expect(await reopened.getExecutionDirective(directive.id, 1)).toEqual(directive);
    expect(await reopened.getExecutionAttempt(attempt.id)).toEqual({ ...attempt, state: "reported", endedAt: attempt.startedAt === report.createdAt ? attempt.startedAt : attempt.startedAt });
    expect(await reopened.getExecutionReport(report.id)).toEqual(report);
    reopened.close();
  });

  it("a pre-Phase-4 document opens with everything intact and empty protocol families (§69)", async () => {
    const world = await durableHandoffPendingWorld(filePath);
    const dw = await directiveWorld(world);
    (dw.world.store as unknown as { close(): void }).close();
    await tamper(filePath, (raw) => {
      delete raw["executionDirectives"];
      delete raw["executionAttempts"];
      delete raw["executionReports"];
      delete raw["executionAttemptByDirective"];
    });
    const migrated = new DurablePlanStore(filePath, { now: () => FIXED });
    expect((await migrated.getRun(world.runID) as PlanningRun).lifecycle).toBe("handoff_pending");
    expect(await migrated.listExecutionStagesForRun(dw.run.id)).toHaveLength(1);
    expect(await migrated.listExecutionDirectivesForRun(dw.run.id)).toEqual([]);
    expect(await migrated.listExecutionAttemptsForRun(dw.run.id)).toEqual([]);
    expect(await migrated.listExecutionReportsForRun(dw.run.id)).toEqual([]);
    migrated.close();
  });

  function docFamily(raw: Record<string, unknown>, key: string): Record<string, Record<string, unknown>> {
    return raw[key] as Record<string, Record<string, unknown>>;
  }

  it("malformed protocol state fails closed (§46-§48)", async () => {
    const pristineFile = path.join(dir, "pristine.json");
    const world = await durableHandoffPendingWorld(pristineFile);
    const dw = await directiveWorld(world);
    const { directive, attempt } = await runningAttempt(dw);
    await dw.world.store.submitExecutionReport({
      executionRunID: dw.run.id,
      attemptID: attempt.id,
      report: payload(dw, directive, { candidateMutation: "changed" }),
      ...AUTH,
    });
    (dw.world.store as unknown as { close(): void }).close();
    const reopenable = new DurablePlanStore(pristineFile, { now: () => FIXED });
    reopenable.close();
    const pristine = JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(pristineFile, "utf8"))) as Record<string, unknown>;
    const cases: readonly (readonly [string, (raw: Record<string, unknown>) => void, RegExp])[] = [
      ["directive-hash", (raw) => { docFamily(raw, "executionDirectives")["DIR-001@1"]!["hash"] = "0".repeat(64); }, /does not recompute/],
      ["directive-wrong-window", (raw) => {
        const record = docFamily(raw, "executionDirectives")["DIR-001@1"]!;
        record["windowID"] = "WIN-099";
        // Re-seal so the binding check fires (not the hash check).
        const clone = { ...(record as unknown as ExecutionDirective) };
        const { createdAt: _c, hash: _h, ...payload } = clone;
        void _c;
        void _h;
        record["hash"] = computeExecutionDirectiveHash(payload);
      }, /does not belong to the bound Stage|references a missing/],
      ["attempt-missing-directive", (raw) => { delete docFamily(raw, "executionDirectives")["DIR-001@1"]; }, /references missing Directive revision/],
      ["attempt-bad-state", (raw) => { docFamily(raw, "executionAttempts")["ATT-001"]!["state"] = "paused"; }, /invalid state/],
      ["attempt-role", (raw) => { docFamily(raw, "executionAttempts")["ATT-001"]!["workerRole"] = "architect"; }, /invalid worker role/],
      ["attempt-index", (raw) => { (raw["executionAttemptByDirective"] as Record<string, string>)[Object.keys(raw["executionAttemptByDirective"] as Record<string, string>)[0]!] = "ATT-999"; }, /not indexed under its exact Directive revision|references missing attempt/],
      ["attempt-two-running", (raw) => {
        const clone = structuredClone(docFamily(raw, "executionAttempts")["ATT-001"]!);
        clone["id"] = "ATT-002";
        clone["state"] = "running";
        delete clone["endedAt"];
        docFamily(raw, "executionAttempts")["ATT-002"] = clone;
      }, /multiple running Attempts|not indexed under its exact Directive revision/],
      ["reported-without-report", (raw) => { delete docFamily(raw, "executionReports")["RPT-001"]; }, /has no durable Report/],
      ["indeterminate-with-report", (raw) => { docFamily(raw, "executionAttempts")["ATT-001"]!["state"] = "indeterminate"; }, /carries a Report/],
      ["report-wrong-directive", (raw) => { docFamily(raw, "executionReports")["RPT-001"]!["directive"] = { id: "DIR-001", revision: 9, hash: "x" }; }, /wrong Directive revision/],
      ["report-bad-result", (raw) => { docFamily(raw, "executionReports")["RPT-001"]!["result"] = "excellent"; }, /invalid result/],
      ["report-blocked-empty", (raw) => {
        const report = docFamily(raw, "executionReports")["RPT-001"]!;
        report["result"] = "blocked";
        report["blockers"] = [];
      }, /blocked without a structured blocker/],
      ["report-provenance", (raw) => { docFamily(raw, "executionReports")["RPT-001"]!["resultingCandidateRevision"] = 5; }, /provenance impossible/],
      ["report-blocker-kind", (raw) => {
        const report = docFamily(raw, "executionReports")["RPT-001"]!;
        report["result"] = "blocked";
        report["blockers"] = [{ kind: "vibes", summary: "x" }];
      }, /invalid blocker entry/],
      ["report-duplicate", (raw) => {
        const clone = structuredClone(docFamily(raw, "executionReports")["RPT-001"]!);
        clone["id"] = "RPT-002";
        docFamily(raw, "executionReports")["RPT-002"] = clone;
      }, /duplicate Report for Attempt/],
    ];
    for (const [name, mutate, pattern] of cases) {
      const caseFile = path.join(dir, `malformed-${name}.json`);
      const raw = structuredClone(pristine) as Record<string, unknown>;
      mutate(raw);
      const { writeFile } = await import("node:fs/promises");
      await writeFile(caseFile, JSON.stringify(raw));
      let lastError: unknown;
      try {
        new DurablePlanStore(caseFile, { now: () => FIXED }).open();
      } catch (error) {
        lastError = error;
      }
      expect((lastError as Error | undefined)?.message ?? "no error thrown").toMatch(pattern);
    }
  }, 30_000);
});

// -----------------------------------------------------------------------------
// §65/§66/§67 — REAL durable concurrency: single writer
// -----------------------------------------------------------------------------

describe("durable concurrency — worker protocol (§65/§66/§67)", () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "ultra-plan-worker-conc-"));
    filePath = path.join(dir, "plan.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("two instances racing to start DIFFERENT directives yield ONE running Attempt (§65/E34)", async () => {
    const world = await durableHandoffPendingWorld(filePath);
    const dw = await directiveWorld(world);
    const first = await dw.world.store.issueExecutionDirective(issueInput(dw));
    const second = await dw.world.store.issueExecutionDirective(issueInput(dw, { draft: { ...DRAFT, directiveID: first.id, objective: "clarified for the second start" } }));
    (dw.world.store as unknown as { close(): void }).close();
    const a = new DurablePlanStore(filePath, { now: () => FIXED });
    const b = new DurablePlanStore(filePath, { now: () => FIXED });
    const input = (directive: ExecutionDirective) => ({
      executionRunID: dw.run.id,
      directive: { id: directive.id, revision: directive.revision },
      ...AUTH,
      ceiling: FULL_CEILING,
    });
    const [ra, rb] = await Promise.allSettled([a.startExecutionAttempt(input(first)), b.startExecutionAttempt(input(second))]);
    a.close();
    b.close();
    expect([ra, rb].filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const verify = new DurablePlanStore(filePath, { now: () => FIXED });
    expect(await verify.findRunningExecutionAttempt(dw.run.id)).toBeDefined();
    expect(await verify.listExecutionAttemptsForRun(dw.run.id)).toHaveLength(1);
    const startedEvents = (await verify.listEvents(world.runID)).filter((event) => event.detail.type === "execution.attempt_started");
    expect(startedEvents).toHaveLength(1);
    verify.close();
  });

  it("two instances racing to start the SAME Directive revision produce ONE Attempt (§66/E35)", async () => {
    const world = await durableHandoffPendingWorld(filePath);
    const dw = await directiveWorld(world);
    const directive = await dw.world.store.issueExecutionDirective(issueInput(dw));
    (dw.world.store as unknown as { close(): void }).close();
    const a = new DurablePlanStore(filePath, { now: () => FIXED });
    const b = new DurablePlanStore(filePath, { now: () => FIXED });
    const input = {
      executionRunID: dw.run.id,
      directive: { id: directive.id, revision: directive.revision },
      ...AUTH,
      ceiling: FULL_CEILING,
    };
    const [ra, rb] = await Promise.allSettled([a.startExecutionAttempt(input), b.startExecutionAttempt(input)]);
    a.close();
    b.close();
    expect([ra, rb].filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = [ra, rb].find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((rejected.reason as { code?: string }).code).toBe("attempt_already_consumed");
    const verify = new DurablePlanStore(filePath, { now: () => FIXED });
    const attempts = await verify.listExecutionAttemptsForRun(dw.run.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.id).toBe("ATT-001");
    verify.close();
  });

  it("two instances submitting reports to the SAME running Attempt: one Report, one completion, candidateRevision at most +1 (§67/E36)", async () => {
    const world = await durableHandoffPendingWorld(filePath);
    const dw = await directiveWorld(world);
    const { directive, attempt } = await runningAttempt(dw);
    (dw.world.store as unknown as { close(): void }).close();
    const a = new DurablePlanStore(filePath, { now: () => FIXED });
    const b = new DurablePlanStore(filePath, { now: () => FIXED });
    const [ra, rb] = await Promise.allSettled([
      a.submitExecutionReport({ executionRunID: dw.run.id, attemptID: attempt.id, report: payload(dw, directive, { result: "completed" }), ...AUTH }),
      b.submitExecutionReport({ executionRunID: dw.run.id, attemptID: attempt.id, report: payload(dw, directive, { result: "partial" }), ...AUTH }),
    ]);
    a.close();
    b.close();
    expect([ra, rb].filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const verify = new DurablePlanStore(filePath, { now: () => FIXED });
    expect(await verify.listExecutionReportsForRun(dw.run.id)).toHaveLength(1);
    expect((await verify.getExecutionAttempt(attempt.id))!.state).toBe("reported");
    // The window advanced at most +1 (only when the winner declared mutation).
    expect((await verify.findOpenVerificationWindow(dw.run.id))!.candidateRevision).toBeLessThanOrEqual(1);
    const reportedEvents = (await verify.listEvents(world.runID)).filter((event) => event.detail.type === "execution.attempt_reported");
    expect(reportedEvents).toHaveLength(1);
    verify.close();
  });
});

// -----------------------------------------------------------------------------
// §53/§54 — Scope gates
// -----------------------------------------------------------------------------

describe("scope gates (§53/§54)", () => {
  it("no model-facing worker-protocol tool exists (§53/E42)", async () => {
    const { TOOL_CONTRACTS } = await import("../src/index.js");
    expect(
      Object.keys(TOOL_CONTRACTS).filter((name) => /directive|attempt|report|worker/i.test(name)),
    ).toEqual([]);
  });

  it("no Assessment/Commit/acceptedHead/window-close/stage-complete/verifier-scheduler exists (§2/E38-E41)", async () => {
    // Phase 5 scope update: SupervisorAssessment/ExecutionCommit are now
    // REQUIRED vocabulary. Phase 6A scope update: ExecutionIssue/
    // VerificationConflict/AttemptReconciliation are now REQUIRED vocabulary —
    // the still-forbidden surfaces remain forbidden (no scheduler, no
    // ExecutionCompletionGate, no direct window-close/stage-complete APIs,
    // no acceptedHead setter).
    const exports = await import("../src/index.js");
    for (const name of Object.getOwnPropertyNames(exports)) {
      expect(name).not.toMatch(/VerificationScheduler|ExecutionCompletionGate|setAcceptedHead|closeVerificationWindow|completeExecutionStage/);
    }
    const gateWorld = await directiveWorld();
    const gateStoreShape = Object.getOwnPropertyNames(Object.getPrototypeOf(gateWorld.world.store) as Record<string, unknown>);
    expect(gateStoreShape.some((name) => /close.*window|complete.*stage|set.*acceptedhead/i.test(name) && !name.includes("seed"))).toBe(false);
    const world = await directiveWorld();
    const storeShape = Object.getOwnPropertyNames(Object.getPrototypeOf(world.world.store) as Record<string, unknown>);
    expect(storeShape.some((name) => /close.*window|complete.*stage|accept.*window|commit.*execution/i.test(name) && !name.includes("seed"))).toBe(false);
  });

  it("the v0.1 production handoff creates NONE of the execution structures (§54/E43)", async () => {
    const world = await handoffPendingWorld();
    const result = await world.controller.recoverExecutionHandoff(world.sessionID);
    expect(result.status).toBe("completed");
    expect(await world.store.listOpenExecutionRuns()).toHaveLength(0);
    const events = (await world.store.listEvents(world.runID)).map((event) => event.detail.type);
    expect(events.filter((type) => type.startsWith("execution."))).toEqual([]);
  });
});
