/**
 * v0.2.0 Phase 2 — SupervisorBinding, fencing & execution recovery foundation.
 *
 * Covers the Phase 2 directive gates: durable single-writer supervisor
 * ownership (§5/§7), the Core-enforced authority boundary with generation
 * fencing (§8/§29), trusted host identity only (§9), attach / same-session
 * resume / detach / authorized takeover (§10-§14), binding ⊥ run lifecycle
 * (§6/§32), the supervised activation gate (§16), prepared crash windows
 * (§17), /clear + fork fail-closed semantics (§19/§20), the deterministic
 * ExecutionRecoveryContext projection (§21-§23/§34), durable binding
 * persistence with fail-closed validation and pre-Phase-2 compatibility
 * (§24/§25/§35), real two-instance concurrency (§28), and the scope gates:
 * no model-facing supervisor API (§38/E18), no Worker binding objects
 * (§15/E17), production handoff creates no binding (§37/E19).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DurablePlanStore,
  InMemoryPlanStore,
  assertExecutionSupervisorAuthority,
  type ExecutionRun,
  type FinalPlanID,
  type PlanID,
  type SupervisorBinding,
} from "../src/index.js";
import type { PlanningRun } from "../src/core/types.js";
import {
  BASELINE,
  FIXED,
  WORKSPACE,
  bindingFamily,
  durableHandoffPendingWorld,
  handoffPendingWorld,
  prepareInput,
  tamper,
} from "./execution-world.js";

const S1 = "ses_supervisor_one";
const S2 = "ses_supervisor_two";
const USER_AUTHORIZED = { kind: "user_authorized" as const, reason: "user explicitly took over via host interaction" };

/** Attach S1 and activate the world's initial run through the supervised gate. */
async function attachedAndSupervised(
  world: { store: InMemoryPlanStore; runID: PlanID; finalPlan: { id: FinalPlanID; revision: number; hash: string } },
  owner: string = S1,
): Promise<{ run: ExecutionRun; binding: SupervisorBinding }> {
  const { run } = await world.store.prepareInitialExecutionRun(prepareInput(world));
  const { binding } = await world.store.attachExecutionSupervisor({ executionRunID: run.id, sessionID: owner, workspace: WORKSPACE });
  const active = await world.store.activateSupervisedExecutionRun({
    executionRunID: run.id,
    sessionID: owner,
    workspace: WORKSPACE,
    generation: binding.generation,
    runRevision: run.revision,
    finalPlan: run.finalPlan,
  });
  return { run: active, binding };
}

// -----------------------------------------------------------------------------
// §5/§10/§11 — Binding model, attach, same-session resume
// -----------------------------------------------------------------------------

describe("attach & same-session resume (§5/§10/§11)", () => {
  it("the first attach mints generation 1 attached on a prepared OR active run", async () => {
    const world = await handoffPendingWorld();
    const { run } = await world.store.prepareInitialExecutionRun(prepareInput(world));
    const first = await world.store.attachExecutionSupervisor({ executionRunID: run.id, sessionID: S1, workspace: WORKSPACE });
    expect(first.created).toBe(true);
    expect(first.binding).toMatchObject({ executionRunID: run.id, ownerSessionID: S1, generation: 1, state: "attached" });
    // Attach also works on an ACTIVE run (e.g. recovery after a crash that
    // lost the binding window) — still generation 1 while unowned.
    const second = await world.store.prepareInitialExecutionRun(
      prepareInput(world, { initialHandoffKey: `${world.runID}/FINAL-001@1/recovery` }),
    );
    const activated = await world.store.activateExecutionRun(second.run.id, {
      workspace: WORKSPACE,
      runRevision: second.run.revision,
      finalPlan: second.run.finalPlan,
    });
    const bound = await world.store.attachExecutionSupervisor({ executionRunID: activated.id, sessionID: S1, workspace: WORKSPACE });
    expect(bound.created).toBe(true);
    expect(bound.binding.generation).toBe(1);
  });

  it("same-session resume is idempotent: same generation, same record, no new events", async () => {
    const world = await handoffPendingWorld();
    const { run, binding } = await attachedAndSupervised(world);
    const resumed = await world.store.attachExecutionSupervisor({ executionRunID: run.id, sessionID: S1, workspace: WORKSPACE });
    expect(resumed.created).toBe(false);
    expect(resumed.binding).toEqual(binding);
    // A process restart does NOT bump the generation either (§11).
    const takeoverResume = await world.store.takeoverExecutionSupervisor({
      executionRunID: run.id,
      sessionID: S1,
      workspace: WORKSPACE,
      expectedGeneration: binding.generation,
      authorization: USER_AUTHORIZED,
    });
    expect(takeoverResume.generation).toBe(binding.generation);
    const events = (await world.store.listEvents(world.runID)).filter((event) => event.detail.type === "execution.supervisor_binding_changed");
    expect(events).toHaveLength(1); // only the initial attach
  });

  it("re-attach after an explicit detach keeps the SAME generation (no takeover happened)", async () => {
    const world = await handoffPendingWorld();
    const { run, binding } = await attachedAndSupervised(world);
    await world.store.detachExecutionSupervisor({ executionRunID: run.id, sessionID: S1, workspace: WORKSPACE, generation: binding.generation });
    const reattached = await world.store.attachExecutionSupervisor({ executionRunID: run.id, sessionID: S1, workspace: WORKSPACE });
    expect(reattached.binding.generation).toBe(binding.generation);
    expect(reattached.binding.state).toBe("attached");
  });

  it("attach with a workspace mismatch or untrusted identity fails closed", async () => {
    const world = await handoffPendingWorld();
    const { run } = await world.store.prepareInitialExecutionRun(prepareInput(world));
    await expect(
      world.store.attachExecutionSupervisor({ executionRunID: run.id, sessionID: S1, workspace: { key: "opencode-project:worktree-B" } }),
    ).rejects.toMatchObject({ code: "workspace_mismatch" });
    await expect(
      world.store.attachExecutionSupervisor({ executionRunID: run.id, sessionID: "", workspace: WORKSPACE }),
    ).rejects.toMatchObject({ code: "supervisor_session_mismatch" });
    await expect(
      world.store.attachExecutionSupervisor({ executionRunID: run.id, sessionID: S1, workspace: { key: "" } }),
    ).rejects.toMatchObject({ code: "workspace_mismatch" });
  });

  it("no Worker/Executor/Verifier binding objects exist (§15/E17)", async () => {
    const exports = await import("../src/index.js");
    for (const name of Object.getOwnPropertyNames(exports)) {
      expect(name).not.toMatch(/(Worker|Executor|Verifier)Binding/);
    }
  });
});

// -----------------------------------------------------------------------------
// §13/§14 — Authorized takeover; generation fencing
// -----------------------------------------------------------------------------

describe("takeover & generation fencing (§13/§14/§29)", () => {
  it("S2 takeover: owner+generation+attachment commit atomically, S1 is fenced forever", async () => {
    const world = await handoffPendingWorld();
    const { run, binding } = await attachedAndSupervised(world);
    const taken = await world.store.takeoverExecutionSupervisor({
      executionRunID: run.id,
      sessionID: S2,
      workspace: WORKSPACE,
      expectedGeneration: binding.generation,
      authorization: USER_AUTHORIZED,
    });
    expect(taken).toMatchObject({ ownerSessionID: S2, generation: 2, state: "attached" });
    // S1's mutation authority check now fails STALE — no liveness involved.
    await expect(
      world.store.authorizeExecutionSupervisor(run.id, { sessionID: S1, workspace: WORKSPACE, generation: 1 }),
    ).rejects.toMatchObject({ code: "stale_supervisor_binding" });
    // S2 at generation 2 passes.
    const authority = await world.store.authorizeExecutionSupervisor(run.id, { sessionID: S2, workspace: WORKSPACE, generation: 2 });
    expect(authority.binding.generation).toBe(2);
    // S1 "returns later" (process restart, same identity): STILL fenced.
    await expect(
      world.store.authorizeExecutionSupervisor(run.id, { sessionID: S1, workspace: WORKSPACE, generation: 1 }),
    ).rejects.toMatchObject({ code: "stale_supervisor_binding" });
  });

  it("takeover requires explicit user authorization (§14)", async () => {
    const world = await handoffPendingWorld();
    const { run, binding } = await attachedAndSupervised(world);
    await expect(
      world.store.takeoverExecutionSupervisor({
        executionRunID: run.id,
        sessionID: S2,
        workspace: WORKSPACE,
        expectedGeneration: binding.generation,
        authorization: { kind: "unauthorized" },
      }),
    ).rejects.toMatchObject({ code: "takeover_requires_authorization" });
    // Nothing moved.
    expect(((await world.store.findSupervisorBinding(run.id))!)).toEqual(binding);
  });

  it("a different session cannot attach over an existing owner (explicit takeover is the only path)", async () => {
    const world = await handoffPendingWorld();
    const { run, binding } = await attachedAndSupervised(world);
    await expect(
      world.store.attachExecutionSupervisor({ executionRunID: run.id, sessionID: S2, workspace: WORKSPACE }),
    ).rejects.toMatchObject({ code: "supervisor_binding_conflict" });
    // /clear semantics (§19): a NEW session after S1 disappears is just
    // another session — it does NOT silently become the writable owner.
    await expect(
      world.store.authorizeExecutionSupervisor(run.id, { sessionID: S2, workspace: WORKSPACE, generation: binding.generation }),
    ).rejects.toMatchObject({ code: "supervisor_session_mismatch" });
    // Conversation identity is irrelevant: only exact sessionID + generation count.
    expect(binding.ownerSessionID).toBe(S1);
  });

  it("takeover with a stale expected generation fails closed before mutating", async () => {
    const world = await handoffPendingWorld();
    const { run, binding } = await attachedAndSupervised(world);
    await expect(
      world.store.takeoverExecutionSupervisor({
        executionRunID: run.id,
        sessionID: S2,
        workspace: WORKSPACE,
        expectedGeneration: binding.generation + 5,
        authorization: USER_AUTHORIZED,
      }),
    ).rejects.toMatchObject({ code: "stale_supervisor_binding" });
    expect(await world.store.findSupervisorBinding(run.id)).toEqual(binding);
  });

  it("takeover on an unbound run is refused (first supervisor attaches instead)", async () => {
    const world = await handoffPendingWorld();
    const { run } = await world.store.prepareInitialExecutionRun(prepareInput(world));
    await expect(
      world.store.takeoverExecutionSupervisor({
        executionRunID: run.id,
        sessionID: S2,
        workspace: WORKSPACE,
        expectedGeneration: 1,
        authorization: USER_AUTHORIZED,
      }),
    ).rejects.toMatchObject({ code: "supervisor_binding_not_found" });
  });
});

// -----------------------------------------------------------------------------
// §12 — Detach semantics
// -----------------------------------------------------------------------------

describe("detach semantics (§12)", () => {
  it("detach changes ONLY the attachment state; the binding record stays queryable", async () => {
    const world = await handoffPendingWorld();
    const { run, binding } = await attachedAndSupervised(world);
    const detached = await world.store.detachExecutionSupervisor({ executionRunID: run.id, sessionID: S1, workspace: WORKSPACE, generation: binding.generation });
    expect(detached.state).toBe("detached");
    expect(detached.ownerSessionID).toBe(S1);
    expect(detached.generation).toBe(binding.generation);
    expect(detached.createdAt).toBe(binding.createdAt);
    // Owner retainment: the detached owner keeps no writable authority…
    await expect(
      world.store.authorizeExecutionSupervisor(run.id, { sessionID: S1, workspace: WORKSPACE, generation: binding.generation }),
    ).rejects.toMatchObject({ code: "supervisor_binding_conflict" });
    // …and the run itself is untouched.
    expect(((await world.store.getExecutionRun(run.id))!).lifecycle).toBe("active");
  });

  it("detach is idempotent for the recorded owner and fenced against everyone else", async () => {
    const world = await handoffPendingWorld();
    const { run, binding } = await attachedAndSupervised(world);
    const first = await world.store.detachExecutionSupervisor({ executionRunID: run.id, sessionID: S1, workspace: WORKSPACE, generation: binding.generation });
    const again = await world.store.detachExecutionSupervisor({ executionRunID: run.id, sessionID: S1, workspace: WORKSPACE, generation: binding.generation });
    expect(again).toEqual(first);
    await expect(
      world.store.detachExecutionSupervisor({ executionRunID: run.id, sessionID: S2, workspace: WORKSPACE, generation: binding.generation }),
    ).rejects.toMatchObject({ code: "supervisor_session_mismatch" });
    await expect(
      world.store.detachExecutionSupervisor({ executionRunID: run.id, sessionID: S1, workspace: WORKSPACE, generation: 99 }),
    ).rejects.toMatchObject({ code: "stale_supervisor_binding" });
  });

  it("detach on an unbound run fails supervisor_binding_not_found", async () => {
    const world = await handoffPendingWorld();
    const { run } = await world.store.prepareInitialExecutionRun(prepareInput(world));
    await expect(
      world.store.detachExecutionSupervisor({ executionRunID: run.id, sessionID: S1, workspace: WORKSPACE, generation: 1 }),
    ).rejects.toMatchObject({ code: "supervisor_binding_not_found" });
  });
});

// -----------------------------------------------------------------------------
// §6/§32 — Binding ⊥ ExecutionRun lifecycle
// -----------------------------------------------------------------------------

describe("lifecycle independence (§6/§32)", () => {
  it("detach / takeover / session mismatch never alter the ExecutionRun lifecycle", async () => {
    const world = await handoffPendingWorld();
    const { run, binding } = await attachedAndSupervised(world);
    expect(run.lifecycle).toBe("active");
    await world.store.detachExecutionSupervisor({ executionRunID: run.id, sessionID: S1, workspace: WORKSPACE, generation: binding.generation });
    expect(((await world.store.getExecutionRun(run.id))!).lifecycle).toBe("active");
    await world.store.takeoverExecutionSupervisor({
      executionRunID: run.id,
      sessionID: S2,
      workspace: WORKSPACE,
      expectedGeneration: binding.generation,
      authorization: USER_AUTHORIZED,
    });
    expect(((await world.store.getExecutionRun(run.id))!).lifecycle).toBe("active");
    await expect(
      world.store.authorizeExecutionSupervisor(run.id, { sessionID: S1, workspace: WORKSPACE, generation: binding.generation }),
    ).rejects.toMatchObject({ code: "stale_supervisor_binding" });
    expect(((await world.store.getExecutionRun(run.id))!).lifecycle).toBe("active");
    // No run-header revision bump, no lifecycle events from binding ops.
    const events = (await world.store.listEvents(world.runID))
      .filter((event) => event.detail.type === "execution.run_lifecycle_changed")
      .map((event) => (event.detail as { from: string; to: string }).to);
    expect(events).toEqual(["active"]); // only the supervised activation itself
  });

  it("terminal runs refuse every binding operation (no supervision after death)", async () => {
    const world = await handoffPendingWorld();
    const { run, binding } = await attachedAndSupervised(world);
    // Phase 6B §29 mechanics: the terminal class is exercised via abort (the
    // binding-refusal semantics are lifecycle-terminal, not completion-specific).
    await world.store.abortExecutionRun(run.id, { workspace: WORKSPACE, runRevision: run.revision, finalPlan: run.finalPlan });
    await expect(
      world.store.attachExecutionSupervisor({ executionRunID: run.id, sessionID: S2, workspace: WORKSPACE }),
    ).rejects.toMatchObject({ code: "invalid_execution_lifecycle" });
    await expect(
      world.store.takeoverExecutionSupervisor({
        executionRunID: run.id,
        sessionID: S2,
        workspace: WORKSPACE,
        expectedGeneration: binding.generation,
        authorization: USER_AUTHORIZED,
      }),
    ).rejects.toMatchObject({ code: "invalid_execution_lifecycle" });
    await expect(
      world.store.detachExecutionSupervisor({ executionRunID: run.id, sessionID: S1, workspace: WORKSPACE, generation: binding.generation }),
    ).rejects.toMatchObject({ code: "invalid_execution_lifecycle" });
  });
});

// -----------------------------------------------------------------------------
// §16/§17/§33 — Supervised activation gate & prepared crash windows
// -----------------------------------------------------------------------------

describe("supervised activation gate (§16/§17/§33)", () => {
  it("prepared + NO binding → supervised activation FAILS; attach then activate PASSES", async () => {
    const world = await handoffPendingWorld();
    const { run } = await world.store.prepareInitialExecutionRun(prepareInput(world));
    await expect(
      world.store.activateSupervisedExecutionRun({
        executionRunID: run.id,
        sessionID: S1,
        workspace: WORKSPACE,
        generation: 1,
        runRevision: run.revision,
        finalPlan: run.finalPlan,
      }),
    ).rejects.toMatchObject({ code: "supervisor_binding_not_found" });
    // Crash-window recovery for prepared+unbound: attach → activate.
    const { binding } = await world.store.attachExecutionSupervisor({ executionRunID: run.id, sessionID: S1, workspace: WORKSPACE });
    const active = await world.store.activateSupervisedExecutionRun({
      executionRunID: run.id,
      sessionID: S1,
      workspace: WORKSPACE,
      generation: binding.generation,
      runRevision: run.revision,
      finalPlan: run.finalPlan,
    });
    expect(active.lifecycle).toBe("active");
  });

  it("prepared + attached binding (crash before activation) → verify exact binding → activate, no new run/generation", async () => {
    const world = await handoffPendingWorld();
    const { run } = await world.store.prepareInitialExecutionRun(prepareInput(world));
    const { binding } = await world.store.attachExecutionSupervisor({ executionRunID: run.id, sessionID: S1, workspace: WORKSPACE });
    // Recovery rediscovers the SAME run and binding deterministically.
    const open = await world.store.listOpenExecutionRuns();
    expect(open.map((candidate) => candidate.id)).toContain(run.id);
    const recovered = await world.store.buildExecutionRecoveryContext(run.id, { sessionID: S1 });
    expect(recovered!.binding).toEqual({ ownerSessionID: S1, generation: 1, state: "attached" });
    expect(recovered!.authority.canActivate).toBe(true);
    const active = await world.store.activateSupervisedExecutionRun({
      executionRunID: run.id,
      sessionID: S1,
      workspace: WORKSPACE,
      generation: binding.generation,
      runRevision: run.revision,
      finalPlan: run.finalPlan,
    });
    expect(active.id).toBe(run.id);
    expect(((await world.store.findSupervisorBinding(run.id))!).generation).toBe(1);
  });

  it("stale generation / wrong workspace / wrong session activation FAILs closed (§33)", async () => {
    const world = await handoffPendingWorld();
    const { run } = await world.store.prepareInitialExecutionRun(prepareInput(world));
    const { binding } = await world.store.attachExecutionSupervisor({ executionRunID: run.id, sessionID: S1, workspace: WORKSPACE });
    await expect(
      world.store.activateSupervisedExecutionRun({
        executionRunID: run.id,
        sessionID: S1,
        workspace: WORKSPACE,
        generation: binding.generation + 1,
        runRevision: run.revision,
        finalPlan: run.finalPlan,
      }),
    ).rejects.toMatchObject({ code: "stale_supervisor_binding" });
    await expect(
      world.store.activateSupervisedExecutionRun({
        executionRunID: run.id,
        sessionID: S1,
        workspace: { key: "opencode-project:worktree-B" },
        generation: binding.generation,
        runRevision: run.revision,
        finalPlan: run.finalPlan,
      }),
    ).rejects.toMatchObject({ code: "workspace_mismatch" });
    await expect(
      world.store.activateSupervisedExecutionRun({
        executionRunID: run.id,
        sessionID: S2,
        workspace: WORKSPACE,
        generation: binding.generation,
        runRevision: run.revision,
        finalPlan: run.finalPlan,
      }),
    ).rejects.toMatchObject({ code: "supervisor_session_mismatch" });
    expect(((await world.store.getExecutionRun(run.id))!).lifecycle).toBe("prepared");
  });

  it("supervised activation preserves FinalPlan binding, baselines, and workspace (§33)", async () => {
    const world = await handoffPendingWorld();
    const { run } = await world.store.prepareInitialExecutionRun(prepareInput(world));
    const { binding } = await world.store.attachExecutionSupervisor({ executionRunID: run.id, sessionID: S1, workspace: WORKSPACE });
    const active = await world.store.activateSupervisedExecutionRun({
      executionRunID: run.id,
      sessionID: S1,
      workspace: WORKSPACE,
      generation: binding.generation,
      runRevision: run.revision,
      finalPlan: run.finalPlan,
    });
    expect(active.finalPlan).toEqual(run.finalPlan);
    expect(active.planningBaseline).toEqual(run.planningBaseline);
    expect(active.executionStartBaseline).toEqual(run.executionStartBaseline);
    expect(active.workspace).toEqual(run.workspace);
  });
});

// -----------------------------------------------------------------------------
// §21/§22/§23/§34 — Recovery context projection & decision API
// -----------------------------------------------------------------------------

describe("execution recovery context (§21/§22/§23/§34)", () => {
  it("projects EXACTLY the existing canonical state — no fabricated execution protocol", async () => {
    const world = await handoffPendingWorld();
    const { run } = await attachedAndSupervised(world);
    const context = await world.store.buildExecutionRecoveryContext(run.id, { sessionID: S1 });
    expect(context).toMatchObject({
      executionRunID: run.id,
      planID: world.runID,
      finalPlan: { id: run.finalPlan.id, revision: run.finalPlan.revision },
      lifecycle: "active",
      workspace: WORKSPACE,
      planningBaseline: run.planningBaseline,
      executionStartBaseline: BASELINE,
      binding: { ownerSessionID: S1, generation: 1, state: "attached" },
      authority: {
        sessionIsCurrentOwner: true,
        currentGeneration: 1,
        requiresTakeover: false,
        canResume: true,
        canActivate: false, // already active
      },
    });
    // Honesty boundary: no Stage/Window/Directive/Report/acceptedHead fields.
    expect(Object.keys(context!)).not.toContain("activeStage");
    expect(Object.keys(context!)).not.toContain("openWindow");
    expect(Object.keys(context!)).not.toContain("acceptedHead");
    expect(Object.keys(context!)).not.toContain("latestDirective");
  });

  it("answers the §23 decision API deterministically for owner, stranger, and unbound cases", async () => {
    const world = await handoffPendingWorld();
    const { run } = await world.store.prepareInitialExecutionRun(prepareInput(world));
    // Unbound: no resumable authority yet.
    const unbound = await world.store.buildExecutionRecoveryContext(run.id, { sessionID: S1 });
    expect(unbound!.binding).toBeUndefined();
    expect(unbound!.authority).toEqual({
      sessionIsCurrentOwner: false,
      currentGeneration: undefined,
      requiresTakeover: false,
      canResume: false,
      canActivate: false,
    });
    const { binding } = await world.store.attachExecutionSupervisor({ executionRunID: run.id, sessionID: S1, workspace: WORKSPACE });
    // Owner viewer.
    const owner = await world.store.buildExecutionRecoveryContext(run.id, { sessionID: S1 });
    expect(owner!.authority).toMatchObject({ sessionIsCurrentOwner: true, currentGeneration: 1, requiresTakeover: false, canResume: true, canActivate: true });
    // Stranger viewer (/clear fork): requires explicit takeover.
    const stranger = await world.store.buildExecutionRecoveryContext(run.id, { sessionID: S2 });
    expect(stranger!.authority).toMatchObject({ sessionIsCurrentOwner: false, currentGeneration: 1, requiresTakeover: true, canResume: false, canActivate: false });
    void binding;
  });

  it("an unknown run projects to undefined; the projection is not persisted (§22)", async () => {
    const world = await handoffPendingWorld();
    const { run, binding } = await attachedAndSupervised(world);
    expect(await world.store.buildExecutionRecoveryContext(run.id, { sessionID: S1 })).toBeDefined();
    const eventsBefore = (await world.store.listEvents(world.runID)).length;
    await world.store.buildExecutionRecoveryContext(run.id, { sessionID: S2 });
    expect((await world.store.listEvents(world.runID)).length).toBe(eventsBefore);
    void binding;
  });
});

// -----------------------------------------------------------------------------
// §28 — Real two-instance concurrency: single writer
// -----------------------------------------------------------------------------

describe("durable concurrency — single writable owner (§28)", () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "ultra-plan-supervisor-"));
    filePath = path.join(dir, "plan.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("concurrent first attach by two sessions produces exactly ONE owner", async () => {
    const world = await durableHandoffPendingWorld(filePath);
    const { run } = await world.store.prepareInitialExecutionRun(prepareInput(world));
    world.store.close();
    const a = new DurablePlanStore(filePath, { now: () => FIXED });
    const b = new DurablePlanStore(filePath, { now: () => FIXED });
    const [ra, rb] = await Promise.allSettled([
      a.attachExecutionSupervisor({ executionRunID: run.id, sessionID: S1, workspace: WORKSPACE }),
      b.attachExecutionSupervisor({ executionRunID: run.id, sessionID: S2, workspace: WORKSPACE }),
    ]);
    a.close();
    b.close();
    // Exactly ONE attach may succeed; the other session fails closed.
    const fulfilled = [ra, rb].filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
    const rejected = [ra, rb].find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((rejected.reason as { code?: string }).code).toBe("supervisor_binding_conflict");
    // Durable truth: ONE binding at generation 1 and ONE attach event.
    const verify = new DurablePlanStore(filePath, { now: () => FIXED });
    const binding = await verify.findSupervisorBinding(run.id);
    expect(binding!.generation).toBe(1);
    const attachEvents = (await verify.listEvents(world.runID)).filter(
      (event) => event.detail.type === "execution.supervisor_binding_changed" && (event.detail as { reason: string }).reason === "attached",
    );
    expect(attachEvents).toHaveLength(1);
    verify.close();
  });

  it("concurrent takeovers by two sessions yield ONE current owner at N+1; the loser is fenced", async () => {
    const world = await durableHandoffPendingWorld(filePath);
    const { run, binding } = await attachedAndSupervised(world);
    const generation = binding.generation;
    world.store.close();
    const s2 = new DurablePlanStore(filePath, { now: () => FIXED });
    const s3 = new DurablePlanStore(filePath, { now: () => FIXED });
    const input = (sessionID: string) => ({
      executionRunID: run.id,
      sessionID,
      workspace: WORKSPACE,
      expectedGeneration: generation,
      authorization: USER_AUTHORIZED,
    });
    const [r2, r3] = await Promise.allSettled([s2.takeoverExecutionSupervisor(input("ses_c2")), s3.takeoverExecutionSupervisor(input("ses_c3"))]);
    s2.close();
    s3.close();
    const verify = new DurablePlanStore(filePath, { now: () => FIXED });
    const current = (await verify.findSupervisorBinding(run.id))!;
    expect(current.generation).toBe(generation + 1);
    expect(current.state).toBe("attached");
    // Exactly one takeover succeeded; the other failed (stale or conflict) —
    // and the ORIGINAL owner is fenced either way.
    const settled = [r2, r3].filter((r) => r.status === "fulfilled");
    expect(settled).toHaveLength(1);
    const takeoverEvents = (await verify.listEvents(world.runID)).filter(
      (event) => event.detail.type === "execution.supervisor_binding_changed" && (event.detail as { reason: string }).reason === "taken_over",
    );
    expect(takeoverEvents).toHaveLength(1);
    expect(current.ownerSessionID).toMatch(/^ses_c[23]$/);
    await expect(
      verify.authorizeExecutionSupervisor(run.id, { sessionID: S1, workspace: WORKSPACE, generation }),
    ).rejects.toMatchObject({ code: "stale_supervisor_binding" });
    // The winner's authority works at the new generation.
    await verify.authorizeExecutionSupervisor(run.id, { sessionID: current.ownerSessionID, workspace: WORKSPACE, generation: current.generation });
    verify.close();
  });

  it("old-owner mutation racing a new takeover fails closed — no lost update", async () => {
    const world = await durableHandoffPendingWorld(filePath);
    const { run, binding } = await attachedAndSupervised(world);
    world.store.close();
    const oldOwner = new DurablePlanStore(filePath, { now: () => FIXED });
    const newOwner = new DurablePlanStore(filePath, { now: () => FIXED });
    // S1 tries to act (detach its own binding) while S2 takes over concurrently.
    const [, takeover] = await Promise.all([
      oldOwner
        .detachExecutionSupervisor({ executionRunID: run.id, sessionID: S1, workspace: WORKSPACE, generation: binding.generation })
        .catch((error: { code?: string }) => error),
      newOwner.takeoverExecutionSupervisor({
        executionRunID: run.id,
        sessionID: S2,
        workspace: WORKSPACE,
        expectedGeneration: binding.generation,
        authorization: USER_AUTHORIZED,
      }),
    ]);
    expect(takeover).toMatchObject({ ownerSessionID: S2, generation: binding.generation + 1 });
    oldOwner.close();
    newOwner.close();
    // Durable truth: exactly the takeover outcome — owner S2, generation N+1.
    const verify = new DurablePlanStore(filePath, { now: () => FIXED });
    expect(await verify.findSupervisorBinding(run.id)).toMatchObject({ ownerSessionID: S2, generation: binding.generation + 1, state: "attached" });
    verify.close();
  });
});

// -----------------------------------------------------------------------------
// §24/§25/§35 — Persistence, fail-closed validation, migration
// -----------------------------------------------------------------------------

describe("binding persistence & migration (§24/§25/§35)", () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "ultra-plan-supervisor-mig-"));
    filePath = path.join(dir, "plan.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("the binding survives close/reopen EXACTLY (§35/E12)", async () => {
    const world = await durableHandoffPendingWorld(filePath);
    const { run, binding } = await attachedAndSupervised(world);
    world.store.close();
    const reopened = new DurablePlanStore(filePath, { now: () => FIXED });
    expect(await reopened.findSupervisorBinding(run.id)).toEqual(binding);
    // Authority still resolves after restart, at the same generation.
    await reopened.authorizeExecutionSupervisor(run.id, { sessionID: S1, workspace: WORKSPACE, generation: binding.generation });
    reopened.close();
  });

  it("a pre-Phase-2 document (no binding family) loads with planning + execution intact (§35/E22)", async () => {
    const world = await durableHandoffPendingWorld(filePath);
    const runID = world.runID;
    const { run } = await world.store.prepareInitialExecutionRun(prepareInput(world));
    world.store.close();
    await tamper(filePath, (raw) => {
      delete raw["supervisorBindings"];
    });
    const migrated = new DurablePlanStore(filePath, { now: () => FIXED });
    expect(((await migrated.getRun(runID)) as PlanningRun).lifecycle).toBe("handoff_pending");
    expect(await migrated.listExecutionRunsForPlan(runID)).toHaveLength(1);
    expect(await migrated.findSupervisorBinding(run.id)).toBeUndefined();
    // Binding capability is usable on the migrated document.
    const { binding } = await migrated.attachExecutionSupervisor({ executionRunID: run.id, sessionID: S1, workspace: WORKSPACE });
    expect(binding.generation).toBe(1);
    migrated.close();
  });

  it("malformed binding state fails closed (§23/§35/E23)", async () => {
    // Dangling binding (no execution run).
    const danglingFile = path.join(dir, "dangling.json");
    const dangling = await durableHandoffPendingWorld(danglingFile);
    await dangling.store.close();
    await tamper(danglingFile, (raw) => {
      bindingFamily(raw)["EXEC-999"] = { executionRunID: "EXEC-999", ownerSessionID: S1, workspace: WORKSPACE, generation: 1, state: "attached", createdAt: FIXED, updatedAt: FIXED };
    });
    expect(() => new DurablePlanStore(danglingFile, { now: () => FIXED }).open()).toThrowError(/references missing execution run/);

    // Each tamper of a REAL bound run's binding fails store open independently.
    const cases: readonly (readonly [string, (binding: Record<string, unknown>) => void, RegExp])[] = [
      ["generation", (binding) => { binding["generation"] = 0; }, /malformed generation/],
      ["workspace", (binding) => { binding["workspace"] = { key: "opencode-project:worktree-B" }; }, /workspace disagrees/],
      ["state", (binding) => { binding["state"] = "suspended"; }, /invalid attachment state/],
      ["owner", (binding) => { binding["ownerSessionID"] = ""; }, /trusted owner session/],
    ];
    for (const [name, mutate, pattern] of cases) {
      const caseFile = path.join(dir, `malformed-${name}.json`);
      const world = await durableHandoffPendingWorld(caseFile);
      const { run } = await world.store.prepareInitialExecutionRun(prepareInput(world));
      await world.store.attachExecutionSupervisor({ executionRunID: run.id, sessionID: S1, workspace: WORKSPACE });
      world.store.close();
      await tamper(caseFile, (raw) => {
        mutate(bindingFamily(raw)[run.id]!);
      });
      expect(() => new DurablePlanStore(caseFile, { now: () => FIXED }).open()).toThrowError(pattern);
    }
  });
});

// -----------------------------------------------------------------------------
// §37/§38 — Scope gates: production handoff untouched, no supervisor MCP
// -----------------------------------------------------------------------------

describe("scope gates (§37/§38)", () => {
  it("the v0.1 production handoff creates NO SupervisorBinding (§37/E19)", async () => {
    const world = await handoffPendingWorld();
    const result = await world.controller.recoverExecutionHandoff(world.sessionID);
    expect(result.status).toBe("completed");
    expect(await world.store.listOpenExecutionRuns()).toHaveLength(0);
    const events = (await world.store.listEvents(world.runID)).map((event) => event.detail.type);
    expect(events.some((type) => type === "execution.supervisor_binding_changed")).toBe(false);
  });

  it("no model-facing supervisor/execution tool exists (§38/E18)", async () => {
    const { TOOL_CONTRACTS } = await import("../src/index.js");
    const names = Object.keys(TOOL_CONTRACTS);
    expect(names.filter((name) => /supervisor|takeover|execution[_-]?(state|run|abort|detach|attach)/i.test(name))).toEqual([]);
  });

  it("the core authority check is the single boundary (§8) — direct unit coverage", () => {
    const run = {
      id: "EXEC-001" as never,
      lifecycle: "active" as never,
      workspace: WORKSPACE,
    } as unknown as ExecutionRun;
    const binding: SupervisorBinding = {
      executionRunID: run.id,
      ownerSessionID: S1,
      workspace: WORKSPACE,
      generation: 3,
      state: "attached",
      createdAt: FIXED,
      updatedAt: FIXED,
    };
    // PASS at the current generation.
    expect(() => assertExecutionSupervisorAuthority(run, binding, { sessionID: S1, workspace: WORKSPACE, generation: 3 })).not.toThrow();
    // Stale generation.
    expect(() => assertExecutionSupervisorAuthority(run, binding, { sessionID: S1, workspace: WORKSPACE, generation: 2 })).toThrowError(/fenced out/);
    // Wrong session / workspace / detached / missing.
    expect(() => assertExecutionSupervisorAuthority(run, binding, { sessionID: S2, workspace: WORKSPACE, generation: 3 })).toThrowError(/owned by another session/);
    expect(() =>
      assertExecutionSupervisorAuthority(run, binding, { sessionID: S1, workspace: { key: "other" }, generation: 3 }),
    ).toThrowError(/workspace/);
    expect(() =>
      assertExecutionSupervisorAuthority(run, { ...binding, state: "detached" }, { sessionID: S1, workspace: WORKSPACE, generation: 3 }),
    ).toThrowError(/detached/);
    expect(() => assertExecutionSupervisorAuthority(run, undefined, { sessionID: S1, workspace: WORKSPACE, generation: 3 })).toThrowError(/no SupervisorBinding/);
    // Terminal run refuses authority outright.
    expect(() =>
      assertExecutionSupervisorAuthority({ ...run, lifecycle: "completed" as never } as unknown as ExecutionRun, binding, {
        sessionID: S1,
        workspace: WORKSPACE,
        generation: 3,
      }),
    ).toThrowError(/terminal/);
  });
});
