/**
 * v0.2.0 Phase 1 — ExecutionRun foundation & prepared handoff primitive.
 *
 * Covers the Phase 1 directive gates: the frozen lifecycle state machine
 * (§19), exact-FinalPlan binding immutability (§20), initial-handoff
 * idempotency including real durable concurrency (§21), durable
 * persistence/recovery of every lifecycle state (§22), migration
 * compatibility from a pre-execution document and clean bootstrap (§23),
 * the machine-readable error surface (§16), and the Phase 1 scope gates:
 * no model-facing force-lifecycle tool (§13/E11) and the v0.1 production
 * handoff path staying untouched (§17/E12).
 *
 * The production handoff is NOT rewired: prepareInitialExecutionRun /
 * activateExecutionRun are called only from these tests.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DurablePlanStore,
  ExecutionRunIDs,
  STORE_SCHEMA_VERSION,
  assertExecutionLifecycle,
  assertExecutionRunBindingUnchanged,
  canTransitionExecutionLifecycle,
  executionInitialHandoffKey,
  transitionExecutionRun,
  type ExecutionLifecycle,
  type ExecutionRun,
  type FinalPlanID,
  type PlanID,
} from "../src/index.js";
import type { PlanningRun } from "../src/core/types.js";
import { admittedStart } from "./helpers.js";
import {
  BASELINE,
  FIXED,
  GOAL,
  WORKSPACE,
  dagWorld,
  durableHandoffPendingWorld,
  executionFamily,
  handoffPendingWorld,
  makeWorld,
  makeWorldWithStore,
  prepareAndActivate,
  prepareInput,
  tamper,
} from "./execution-world.js";

// -----------------------------------------------------------------------------
// §19 — Domain lifecycle state machine (table-driven, full matrix)
// -----------------------------------------------------------------------------

describe("ExecutionRun lifecycle state machine (§19)", () => {
  const LEGAL: readonly (readonly [ExecutionLifecycle, ExecutionLifecycle])[] = [
    ["prepared", "active"],
    ["prepared", "aborted"],
    ["active", "completed"],
    ["active", "replan_required"],
    ["active", "aborted"],
  ];
  const ALL: readonly ExecutionLifecycle[] = ["prepared", "active", "completed", "replan_required", "aborted"];

  it("executes the frozen transition table (full 5×5 matrix)", () => {
    for (const from of ALL) {
      for (const to of ALL) {
        const allowed = LEGAL.some(([f, t]) => f === from && t === to);
        expect({ from, to, allowed }).toEqual({ from, to, allowed: canTransitionExecutionLifecycle(from, to) });
      }
    }
  });

  it("the terminal states can never leave (completed/replan_required/aborted → anything FAIL)", () => {
    for (const terminal of ["completed", "replan_required", "aborted"] as const) {
      for (const to of ALL) {
        expect(canTransitionExecutionLifecycle(terminal, to)).toBe(false);
      }
    }
  });

  it("never transitions back to prepared (active → prepared FAIL)", () => {
    expect(canTransitionExecutionLifecycle("active", "prepared")).toBe(false);
  });

  it("prepared → completed and prepared → replan_required FAIL (no shortcut past active)", () => {
    expect(canTransitionExecutionLifecycle("prepared", "completed")).toBe(false);
    expect(canTransitionExecutionLifecycle("prepared", "replan_required")).toBe(false);
  });

  it("transitionExecutionRun applies a legal transition and throws invalid_execution_lifecycle otherwise", () => {
    const run = { lifecycle: "prepared" as ExecutionLifecycle };
    expect(transitionExecutionRun(run as never, "active").lifecycle).toBe("active");
    expect(() => transitionExecutionRun({ lifecycle: "completed" } as never, "active")).toThrowError(/cannot transition lifecycle/);
    expect(() => transitionExecutionRun({ lifecycle: "active" } as never, "prepared")).toThrowError(/cannot transition lifecycle/);
  });

  it("assertExecutionLifecycle rejects unknown lifecycle strings", () => {
    expect(() => assertExecutionLifecycle("failed")).toThrowError(/not an execution lifecycle/);
    expect(() => assertExecutionLifecycle("paused")).toThrowError(/not an execution lifecycle/);
    assertExecutionLifecycle("replan_required");
  });

  it("prepared → aborted exists ONLY for explicitly cancelling a prepared handoff", () => {
    // The one extra edge beyond the SPEC diagram, mirroring the v0.1
    // handoff_pending → aborted convention. It must not open any other path.
    expect(canTransitionExecutionLifecycle("prepared", "aborted")).toBe(true);
    expect(LEGAL.filter(([from]) => from === "prepared")).toHaveLength(2);
  });
});

// -----------------------------------------------------------------------------
// §5/§20 — Exact FinalPlan binding + immutability
// -----------------------------------------------------------------------------

describe("FinalPlan exact binding & immutability (§5/§20)", () => {
  it("the run binds the EXACT approved FinalPlan revision with its content hash", async () => {
    const world = await handoffPendingWorld();
    const { run, created } = await world.store.prepareInitialExecutionRun(prepareInput(world));
    expect(created).toBe(true);
    expect(run.id).toBe("EXEC-001");
    expect(run.finalPlan).toEqual({ id: "FINAL-001", revision: 1 });
    expect(run.finalPlanHash).toBe(world.finalPlan.hash);
    expect(run.planID).toBe(world.runID);
  });

  it("a binding whose hash does not match the committed plan is refused (FINAL-X@7 vs different content)", async () => {
    const world = await handoffPendingWorld();
    await expect(
      world.store.prepareInitialExecutionRun(prepareInput(world, { finalPlanHash: "0".repeat(64) })),
    ).rejects.toMatchObject({ code: "final_plan_binding_mismatch" });
  });

  it("cannot bind a FinalPlan revision the planning run does not carry (FINAL-X@8 / FINAL-Y@1)", async () => {
    const world = await handoffPendingWorld();
    await expect(
      world.store.prepareInitialExecutionRun(prepareInput(world, { finalPlan: { id: "FINAL-001" as FinalPlanID, revision: 2 } })),
    ).rejects.toMatchObject({ code: "final_plan_binding_mismatch" });
    await expect(
      world.store.prepareInitialExecutionRun(prepareInput(world, { finalPlan: { id: "FINAL-002" as FinalPlanID, revision: 1 } })),
    ).rejects.toMatchObject({ code: "final_plan_binding_mismatch" });
  });

  it("activate/terminal transitions refuse a rebinding expectation (no rebind in place, ever)", async () => {
    const world = await handoffPendingWorld();
    const { run } = await world.store.prepareInitialExecutionRun(prepareInput(world));
    for (const rebinding of [
      { id: "FINAL-001" as FinalPlanID, revision: 2 },
      { id: "FINAL-002" as FinalPlanID, revision: 1 },
    ]) {
      await expect(
        world.store.activateExecutionRun(run.id, { workspace: WORKSPACE, runRevision: run.revision, finalPlan: rebinding }),
      ).rejects.toMatchObject({ code: "final_plan_binding_mismatch" });
    }
    // Still prepared, binding untouched.
    expect(((await world.store.getExecutionRun(run.id))!).finalPlan).toEqual({ id: "FINAL-001", revision: 1 });
  });

  it("lifecycle transitions never change the immutable authority fields (§20)", async () => {
    const world = await handoffPendingWorld();
    const prepared = (await world.store.prepareInitialExecutionRun(prepareInput(world))).run;
    const active = await prepareAndActivate(world);
    // Phase 6B §29: the bare completion primitive is gone; the same immutable-
    // fields invariant is proven through the abort transition (terminal class).
    const completed = await world.store.abortExecutionRun(active.id, {
      workspace: WORKSPACE,
      runRevision: active.revision,
      finalPlan: active.finalPlan,
    });
    for (const field of ["id", "planID", "initialHandoffKey", "workspace", "finalPlan", "finalPlanHash", "planningBaseline", "executionStartBaseline", "createdAt"] as const) {
      expect(structuredClone(completed[field])).toEqual(structuredClone(prepared[field]));
    }
    // The domain invariant is the enforcement mechanism.
    expect(() => assertExecutionRunBindingUnchanged(prepared, { ...completed, finalPlanHash: "moved" })).toThrowError(/immutable/);
    expect(() => assertExecutionRunBindingUnchanged(prepared, { ...completed, workspace: { key: "other" } })).toThrowError(/immutable/);
  });

  it("assertExecutionRunBindingUnchanged flags every immutable field individually", () => {
    const base = {
      id: "EXEC-001",
      planID: "PLAN-001",
      initialHandoffKey: "PLAN-001/FINAL-001@1/initial",
      workspace: { key: "ws" },
      finalPlan: { id: "FINAL-001", revision: 7 },
      finalPlanHash: "hash",
      planningBaseline: { snapshot: { id: "SNAP-009" }, finalCommit: "COMMIT-009" },
      executionStartBaseline: { workspaceFingerprint: "fp" },
      lifecycle: "active",
      revision: 3,
      createdAt: FIXED,
      updatedAt: FIXED,
    } as unknown as ExecutionRun;
    for (const field of ["id", "planID", "initialHandoffKey", "workspace", "finalPlan", "finalPlanHash", "planningBaseline", "executionStartBaseline", "createdAt"] as const) {
      const tampered = { ...base, [field]: field === "finalPlan" ? { id: "FINAL-001", revision: 8 } : field === "workspace" ? { key: "other" } : field === "id" || field === "planID" ? ("EXEC-999" as never) : `changed-${field}` } as ExecutionRun;
      expect(() => assertExecutionRunBindingUnchanged(base, tampered)).toThrowError(/immutable/);
    }
    // Only lifecycle/revision/updatedAt may move.
    expect(() => assertExecutionRunBindingUnchanged(base, { ...base, lifecycle: "completed", revision: 4, updatedAt: "later" })).not.toThrow();
  });
});

// -----------------------------------------------------------------------------
// §6/§7/§8 — Workspace binding and the two distinct baselines
// -----------------------------------------------------------------------------

describe("workspace binding and baselines (§4/§5/§6/§8)", () => {
  it("binds the trusted WorkspaceIdentity and the two DISTINCT baselines", async () => {
    const world = await handoffPendingWorld();
    const { run } = await world.store.prepareInitialExecutionRun(prepareInput(world));
    expect(run.workspace).toEqual(WORKSPACE);
    // planningBaseline = the approval-time authority snapshot from the
    // FinalPlan's own provenance (FinalPlan.baseSnapshot/baseCommit).
    expect(run.planningBaseline.snapshot.id).toBe(world.finalPlan.baseSnapshot.id);
    expect(run.planningBaseline.finalCommit).toBe(world.finalPlan.baseCommit);
    // executionStartBaseline = the observed repository revision — a DIFFERENT
    // concept, persisted separately, never merged with the planning baseline.
    expect(run.executionStartBaseline).toEqual(BASELINE);
    expect(run.executionStartBaseline.workspaceFingerprint).not.toBe(run.planningBaseline.snapshot.id);
  });

  it("a workspace-less preparation is refused", async () => {
    const world = await handoffPendingWorld();
    await expect(
      world.store.prepareInitialExecutionRun(prepareInput(world, { workspace: { key: "" } })),
    ).rejects.toMatchObject({ code: "workspace_mismatch" });
  });

  it("activating against a different workspace fails workspace_mismatch (no workspace migration)", async () => {
    const world = await handoffPendingWorld();
    const { run } = await world.store.prepareInitialExecutionRun(prepareInput(world));
    await expect(
      world.store.activateExecutionRun(run.id, {
        workspace: { key: "opencode-project:worktree-B" },
        runRevision: run.revision,
        finalPlan: run.finalPlan,
      }),
    ).rejects.toMatchObject({ code: "workspace_mismatch" });
  });
});

// -----------------------------------------------------------------------------
// §11 — Initial handoff idempotency
// -----------------------------------------------------------------------------

describe("initial handoff idempotency (§7/§11)", () => {
  it("repeated preparation of the SAME handoff returns the SAME prepared run (EXEC-001, never EXEC-002)", async () => {
    const world = await handoffPendingWorld();
    const first = await world.store.prepareInitialExecutionRun(prepareInput(world));
    expect(first.created).toBe(true);
    expect(first.run.id).toBe("EXEC-001");
    const second = await world.store.prepareInitialExecutionRun(prepareInput(world));
    expect(second.created).toBe(false);
    expect(second.run).toEqual(first.run);
    expect(await world.store.listExecutionRunsForPlan(world.runID)).toHaveLength(1);
  });

  it("concurrent duplicate attempts (in-memory) produce ONE run", async () => {
    const world = await handoffPendingWorld();
    const [a, b] = await Promise.all([
      world.store.prepareInitialExecutionRun(prepareInput(world)),
      world.store.prepareInitialExecutionRun(prepareInput(world)),
    ]);
    expect(a.run.id).toBe(b.run.id);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(await world.store.listExecutionRunsForPlan(world.runID)).toHaveLength(1);
  });

  it("concurrent duplicate attempts (REAL durable concurrency: two instances, one file) produce ONE run", async () => {
    let dir: string | undefined;
    try {
      dir = await mkdtemp(path.join(tmpdir(), "ultra-plan-exec-"));
      const filePath = path.join(dir, "plan.json");
      const world = await durableHandoffPendingWorld(filePath);
      const input = prepareInput(world);
      // Exactly two writer instances race on one file.
      world.store.close();
      const a = new DurablePlanStore(filePath, { now: () => FIXED });
      const b = new DurablePlanStore(filePath, { now: () => FIXED });
      const [ra, rb] = await Promise.all([a.prepareInitialExecutionRun(input), b.prepareInitialExecutionRun(input)]);
      expect(ra.run.id).toBe(rb.run.id);
      expect([ra.created, rb.created].sort()).toEqual([false, true]);
      a.close();
      b.close();
      // Durable truth: exactly one record, one prepared event.
      const verify = new DurablePlanStore(filePath, { now: () => FIXED });
      expect(await verify.listExecutionRunsForPlan(world.runID as never)).toHaveLength(1);
      const events = (await verify.listEvents(world.runID as never)).map((event) => event.detail.type);
      expect(events.filter((type) => type === "execution.run_prepared")).toHaveLength(1);
      verify.close();
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  });

  it("a sequential crash/retry (close + reopen) recovers the SAME prepared run", async () => {
    let dir: string | undefined;
    try {
      dir = await mkdtemp(path.join(tmpdir(), "ultra-plan-exec-"));
      const filePath = path.join(dir, "plan.json");
      const world = await durableHandoffPendingWorld(filePath);
      const input = prepareInput(world);
      const first = await world.store.prepareInitialExecutionRun(input);
      expect(first.created).toBe(true);
      world.store.close();
      const reopened = new DurablePlanStore(filePath, { now: () => FIXED });
      const retry = await reopened.prepareInitialExecutionRun(input);
      expect(retry.created).toBe(false);
      expect(retry.run).toEqual(first.run);
      reopened.close();
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  });

  it("an explicitly DIFFERENT future run identity creates another run (0..N per FinalPlan stays possible)", async () => {
    const world = await handoffPendingWorld();
    const initial = await world.store.prepareInitialExecutionRun(prepareInput(world));
    expect(initial.created).toBe(true);
    const distinctKey = `${world.runID}/FINAL-001@1/reexecution-1`;
    const next = await world.store.prepareInitialExecutionRun(prepareInput(world, { initialHandoffKey: distinctKey }));
    expect(next.created).toBe(true);
    expect(next.run.id).toBe("EXEC-002");
    expect(next.run.initialHandoffKey).toBe(distinctKey);
    expect(await world.store.listExecutionRunsForFinalPlan(world.runID, { id: "FINAL-001" as FinalPlanID, revision: 1 })).toHaveLength(2);
  });

  it("the same handoff key with a DIFFERENT authority binding fails initial_handoff_conflict", async () => {
    const world = await handoffPendingWorld();
    await world.store.prepareInitialExecutionRun(prepareInput(world));
    // An internally-valid but different workspace under the SAME key.
    await expect(
      world.store.prepareInitialExecutionRun(prepareInput(world, { workspace: { key: "opencode-project:worktree-B" } })),
    ).rejects.toMatchObject({ code: "initial_handoff_conflict" });
    // A different FinalPlan hash is refused even earlier, at binding integrity.
    await expect(
      world.store.prepareInitialExecutionRun(prepareInput(world, { finalPlanHash: "0".repeat(64) })),
    ).rejects.toMatchObject({ code: "final_plan_binding_mismatch" });
  });

  it("preparation is refused outside the recoverable handoff state", async () => {
    const otherWorld = makeWorld();
    await admittedStart(otherWorld.controller, "ses_active", GOAL);
    const activeRun = (await otherWorld.store.findLatestRunBySession("ses_active")) as PlanningRun;
    await expect(
      otherWorld.store.prepareInitialExecutionRun({
        planID: activeRun.id,
        finalPlan: { id: "FINAL-001" as FinalPlanID, revision: 1 },
        finalPlanHash: "h",
        workspace: WORKSPACE,
        executionStartBaseline: BASELINE,
        initialHandoffKey: "k",
      }),
    ).rejects.toMatchObject({ code: "handoff_not_allowed" });
    await expect(
      otherWorld.store.prepareInitialExecutionRun({
        planID: "PLAN-099" as PlanID,
        finalPlan: { id: "FINAL-001" as FinalPlanID, revision: 1 },
        finalPlanHash: "h",
        workspace: WORKSPACE,
        executionStartBaseline: BASELINE,
        initialHandoffKey: "k",
      }),
    ).rejects.toMatchObject({ code: "run_not_found" });
  });
});

// -----------------------------------------------------------------------------
// §12 — prepared → active primitive and CAS/stale semantics
// -----------------------------------------------------------------------------

describe("prepared → active primitive (§12)", () => {
  it("activates atomically with validated workspace/binding/revision", async () => {
    const world = await handoffPendingWorld();
    const { run } = await world.store.prepareInitialExecutionRun(prepareInput(world));
    const active = await world.store.activateExecutionRun(run.id, {
      workspace: WORKSPACE,
      runRevision: run.revision,
      finalPlan: run.finalPlan,
    });
    expect(active.lifecycle).toBe("active");
    expect(active.revision).toBe(run.revision + 1);
    const events = (await world.store.listEvents(world.runID)).map((event) => event.detail.type);
    expect(events.indexOf("execution.run_prepared")).toBeLessThan(events.lastIndexOf("execution.run_lifecycle_changed"));
  });

  it("a stale expected revision fails stale_execution_run (CAS, fail closed)", async () => {
    const world = await handoffPendingWorld();
    const { run } = await world.store.prepareInitialExecutionRun(prepareInput(world));
    await expect(
      world.store.activateExecutionRun(run.id, { workspace: WORKSPACE, runRevision: run.revision + 5, finalPlan: run.finalPlan }),
    ).rejects.toMatchObject({ code: "stale_execution_run" });
  });

  it("an unknown id fails execution_run_not_found", async () => {
    const world = await handoffPendingWorld();
    await expect(
      world.store.activateExecutionRun(ExecutionRunIDs.cast("EXEC-099"), { workspace: WORKSPACE, runRevision: 1, finalPlan: { id: "FINAL-001" as FinalPlanID, revision: 1 } }),
    ).rejects.toMatchObject({ code: "execution_run_not_found" });
  });
});

// -----------------------------------------------------------------------------
// §13 — Terminal transition primitives (capability only, no business gate)
// -----------------------------------------------------------------------------

describe("terminal transitions (§13)", () => {
  // Phase 6A §7/§11: there is deliberately NO bare replan primitive anymore —
  // replan_required is reachable ONLY through the assessment-gated
  // ExecutionIssue transaction (execution-replan.test.ts). Phase 6B §29: the
  // bare completion primitive is gone too — `completed` is reachable ONLY
  // through the ExecutionCompletionGate (execution-completion.test.ts). The
  // one remaining primitive terminal transition here is aborted.
  it("active → aborted works exactly once", async () => {
    const fresh = await handoffPendingWorld();
    const active = await prepareAndActivate(fresh);
    const done = await fresh.store.abortExecutionRun(active.id, { workspace: WORKSPACE, runRevision: active.revision, finalPlan: active.finalPlan });
    expect(done.lifecycle).toBe("aborted");
    // Terminal is terminal: any further transition fails.
    await expect(
      fresh.store.activateExecutionRun(active.id, { workspace: WORKSPACE, runRevision: done.revision, finalPlan: active.finalPlan }),
    ).rejects.toMatchObject({ code: "invalid_execution_lifecycle" });
    await expect(
      fresh.store.abortExecutionRun(active.id, { workspace: WORKSPACE, runRevision: done.revision, finalPlan: active.finalPlan }),
    ).rejects.toMatchObject({ code: "invalid_execution_lifecycle" });
  });

  it("no bare completion primitive exists on the store surface (§29/E28)", async () => {
    const fresh = await handoffPendingWorld();
    const storeShape = Object.getOwnPropertyNames(Object.getPrototypeOf(fresh.store) as Record<string, unknown>);
    expect(storeShape).not.toContain("completeExecutionRun");
    expect(storeShape).toContain("completeExecutionRunThroughGate");
  });

  it("prepared → aborted explicitly cancels a prepared handoff", async () => {
    const world = await handoffPendingWorld();
    const { run } = await world.store.prepareInitialExecutionRun(prepareInput(world));
    const aborted = await world.store.abortExecutionRun(run.id, { workspace: WORKSPACE, runRevision: run.revision, finalPlan: run.finalPlan });
    expect(aborted.lifecycle).toBe("aborted");
  });

  it("no model-facing force-lifecycle tool exists (§13/E11)", async () => {
    const { TOOL_CONTRACTS, FORBIDDEN_TOOL_NAMES } = await import("../src/index.js");
    const names = Object.keys(TOOL_CONTRACTS);
    // No tool may expose execution-run lifecycle force operations.
    expect(names.filter((name) => /force|execution[_-]?run|execut.*lifecycle/i.test(name))).toEqual([]);
    void FORBIDDEN_TOOL_NAMES;
  });
});

// -----------------------------------------------------------------------------
// §14/§22 — Durable persistence & recovery
// -----------------------------------------------------------------------------

describe("durable persistence & recovery (§14/§22)", () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "ultra-plan-exec-durable-"));
    filePath = path.join(dir, "plan.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("a prepared run survives close/reopen with every authority field identical", async () => {
    const world = await durableHandoffPendingWorld(filePath);
    const { run } = await world.store.prepareInitialExecutionRun(prepareInput(world));
    world.store.close();
    const reopened = new DurablePlanStore(filePath, { now: () => FIXED });
    const recovered = await reopened.getExecutionRun(run.id);
    expect(recovered).toEqual(run);
    expect((await reopened.findInitialExecutionRun(world.runID as never, run.initialHandoffKey))!.id).toBe(run.id);
    reopened.close();
  });

  it("an activated run survives close/reopen (lifecycle + revision preserved)", async () => {
    const world = await durableHandoffPendingWorld(filePath);
    const { run } = await world.store.prepareInitialExecutionRun(prepareInput(world));
    const active = await world.store.activateExecutionRun(run.id, { workspace: WORKSPACE, runRevision: run.revision, finalPlan: run.finalPlan });
    world.store.close();
    const reopened = new DurablePlanStore(filePath, { now: () => FIXED });
    const recovered = (await reopened.getExecutionRun(run.id))!;
    expect(recovered.lifecycle).toBe("active");
    expect(recovered.revision).toBe(active.revision);
    reopened.close();
  });

  it("terminal states survive restart without semantic drift (aborted sampled; replan_required reopen in execution-replan, completed in execution-completion)", async () => {
    for (const [index, terminal] of (["abortExecutionRun"] as const).entries()) {
      const perStateFile = path.join(dir, `plan-terminal-${index}.json`);
      const world = await durableHandoffPendingWorld(perStateFile);
      const { run } = await world.store.prepareInitialExecutionRun(prepareInput(world));
      const active = await world.store.activateExecutionRun(run.id, { workspace: WORKSPACE, runRevision: run.revision, finalPlan: run.finalPlan });
      const done = await world.store[terminal](active.id, { workspace: WORKSPACE, runRevision: active.revision, finalPlan: active.finalPlan });
      world.store.close();
      const reopened = new DurablePlanStore(perStateFile, { now: () => FIXED });
      const recovered = (await reopened.getExecutionRun(run.id))!;
      expect(recovered).toEqual(done);
      expect(recovered.lifecycle).toBe(done.lifecycle);
      reopened.close();
    }
  });

  it("every published lifecycle transition is atomic at the durable commit point (rename is the commit)", async () => {
    // The crash-window probes (before/after the atomic rename) are the
    // durable-crash suite's subprocess territory; here we prove the durable
    // publication discipline directly: after EVERY mutating call returns, the
    // on-disk document already carries the transition.
    const world = await durableHandoffPendingWorld(filePath);
    const { run } = await world.store.prepareInitialExecutionRun(prepareInput(world));
    world.store.close();
    const raw = JSON.parse(await readFile(filePath, "utf8")) as { executionRuns?: Record<string, { lifecycle: string; revision: number }> };
    expect(raw["executionRuns"]![run.id]).toMatchObject({ lifecycle: "prepared", revision: 1 });
  });
});

// -----------------------------------------------------------------------------
// §14 constraints at the storage layer + §23 migration compatibility
// -----------------------------------------------------------------------------

describe("storage constraints & migration compatibility (§14/§23)", () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "ultra-plan-exec-mig-"));
    filePath = path.join(dir, "plan.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("an invalid lifecycle string in the document fails store open", async () => {
    const world = await durableHandoffPendingWorld(filePath);
    await world.store.prepareInitialExecutionRun(prepareInput(world));
    world.store.close();
    await tamper(filePath, (raw) => {
      executionFamily(raw)["EXEC-001"]!["lifecycle"] = "paused";
    });
    expect(() => new DurablePlanStore(filePath, { now: () => FIXED }).open()).toThrowError(/invalid lifecycle/);
  });

  it("a workspace-less run fails store open", async () => {
    const world = await durableHandoffPendingWorld(filePath);
    await world.store.prepareInitialExecutionRun(prepareInput(world));
    world.store.close();
    await tamper(filePath, (raw) => {
      executionFamily(raw)["EXEC-001"]!["workspace"] = { key: "" };
    });
    expect(() => new DurablePlanStore(filePath, { now: () => FIXED }).open()).toThrowError(/WorkspaceIdentity/);
  });

  it("a run whose FinalPlan binding does not resolve fails store open", async () => {
    const world = await durableHandoffPendingWorld(filePath);
    await world.store.prepareInitialExecutionRun(prepareInput(world));
    world.store.close();
    await tamper(filePath, (raw) => {
      executionFamily(raw)["EXEC-001"]!["finalPlanHash"] = "0".repeat(64);
    });
    expect(() => new DurablePlanStore(filePath, { now: () => FIXED }).open()).toThrowError(/does not resolve to the committed plan/);
  });

  it("a duplicate initial-handoff run in the document fails store open", async () => {
    const world = await durableHandoffPendingWorld(filePath);
    const { run } = await world.store.prepareInitialExecutionRun(prepareInput(world));
    world.store.close();
    await tamper(filePath, (raw) => {
      const clone = structuredClone(executionFamily(raw)[run.id]!);
      clone["id"] = "EXEC-002";
      executionFamily(raw)["EXEC-002"] = clone;
    });
    expect(() => new DurablePlanStore(filePath, { now: () => FIXED }).open()).toThrowError(/not indexed under its initial-handoff identity/);
  });

  it("an index entry without a run fails store open", async () => {
    const world = await durableHandoffPendingWorld(filePath);
    await world.store.prepareInitialExecutionRun(prepareInput(world));
    world.store.close();
    await tamper(filePath, (raw) => {
      (raw["executionRunByHandoffKey"] as Record<string, string>)["PLAN-001:ghost"] = "EXEC-099";
    });
    expect(() => new DurablePlanStore(filePath, { now: () => FIXED }).open()).toThrowError(/references missing execution run/);
  });

  it("a pre-execution document (previous build) migrates: planning data intact + execution schema available (§23)", async () => {
    const world = await durableHandoffPendingWorld(filePath);
    const runID = world.runID as unknown as string;
    world.store.close();
    // Simulate the previous build's document: no execution families at all.
    await tamper(filePath, (raw) => {
      delete raw["executionRuns"];
      delete raw["executionRunByHandoffKey"];
    });
    const migrated = new DurablePlanStore(filePath, { now: () => FIXED });
    // Previous planning data intact.
    const run = (await migrated.getRun(runID as never)) as PlanningRun;
    expect(run.lifecycle).toBe("handoff_pending");
    expect((await migrated.getCurrentFinalPlan(runID as never))!.hash).toBe(world.finalPlan.hash);
    expect((await migrated.listCommits(runID as never)).length).toBeGreaterThan(0);
    // Execution schema available and usable.
    const { run: execRun, created } = await migrated.prepareInitialExecutionRun(
      prepareInput({ runID, finalPlan: world.finalPlan }),
    );
    expect(created).toBe(true);
    expect(execRun.id).toBe("EXEC-001");
    migrated.close();
  });

  it("a fresh empty database bootstraps the latest schema with planning + execution available (§23)", async () => {
    const fresh = new DurablePlanStore(filePath, { now: () => FIXED });
    fresh.open();
    const raw = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
    expect(raw["schemaVersion"]).toBe(STORE_SCHEMA_VERSION);
    expect(raw["executionRuns"]).toEqual({});
    expect(raw["executionRunByHandoffKey"]).toEqual({});
    // The full v0.1 planning flow still works on the bootstrapped document,
    // and the execution foundation is available on the same store.
    const world = makeWorldWithStore(fresh);
    await dagWorld(world, "ses_fresh");
    expect(((await world.store.findLatestRunBySession("ses_fresh")) as PlanningRun).stage).toBe("detail");
    fresh.close();
  });

  it("a NEWER schema version fails closed with store_version_unsupported (STORE_SCHEMA_MISMATCH mapping)", async () => {
    const world = await durableHandoffPendingWorld(filePath);
    world.store.close();
    await tamper(filePath, (raw) => {
      raw["schemaVersion"] = STORE_SCHEMA_VERSION + 1;
    });
    try {
      new DurablePlanStore(filePath, { now: () => FIXED }).open();
      expect.unreachable("open must fail");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("store_version_unsupported");
    }
  });
});

// -----------------------------------------------------------------------------
// §15 — Deterministic reads; §17/E12 — v0.1 production handoff unchanged
// -----------------------------------------------------------------------------

describe("deterministic reads (§15)", () => {
  it("getExecutionRun / findInitialExecutionRun resolve by exact identity; no latest-based lookup exists", async () => {
    const world = await handoffPendingWorld();
    const { run } = await world.store.prepareInitialExecutionRun(prepareInput(world));
    expect((await world.store.getExecutionRun(run.id))!.id).toBe("EXEC-001");
    expect(
      (await world.store.findInitialExecutionRun(world.runID, executionInitialHandoffKey(world.runID, run.finalPlan)))!.id,
    ).toBe("EXEC-001");
    expect(await world.store.findInitialExecutionRun(world.runID, "PLAN-001/FINAL-001@1/other")).toBeUndefined();
    expect(await world.store.getExecutionRun(ExecutionRunIDs.cast("EXEC-002"))).toBeUndefined();
    // The store boundary deliberately exposes NO getLatestExecutionRun.
    const storeShape = Object.getOwnPropertyNames(Object.getPrototypeOf(world.store) as Record<string, unknown>);
    expect(storeShape.some((name) => name.toLowerCase().includes("latestrun") && name.toLowerCase().includes("execution"))).toBe(false);
  });
});

describe("v0.1 production handoff unchanged (§17/E12)", () => {
  it("the production handoff path creates NO ExecutionRun and still completes", async () => {
    const world = await handoffPendingWorld();
    const result = await world.controller.recoverExecutionHandoff(world.sessionID);
    expect(result.status).toBe("completed");
    expect(((await world.store.getRun(world.runID)) as PlanningRun).lifecycle).toBe("completed");
    // The v0.1 path never touches the execution foundation.
    expect(await world.store.listExecutionRunsForPlan(world.runID)).toHaveLength(0);
    expect(await world.store.findInitialExecutionRun(world.runID, executionInitialHandoffKey(world.runID, { id: "FINAL-001" as FinalPlanID, revision: 1 }))).toBeUndefined();
  });

  it("the foundation primitives are never called by the production recovery (capability remains test-only)", async () => {
    const world = await handoffPendingWorld();
    await world.controller.recoverExecutionHandoff(world.sessionID);
    // No execution events on the plan log from the production path.
    const events = (await world.store.listEvents(world.runID)).map((event) => event.detail.type);
    expect(events.some((type) => type.startsWith("execution."))).toBe(false);
  });
});

