/**
 * Phase 14 — ExecutionHandoff service, delivery lifecycle, ExecutionBinding,
 * Build read authority, crash recovery, idempotency and races
 * (directive §35–§43/§49–§52/§82–§83/§90–§94/§114–§120/§133–§136).
 */
import { describe, expect, it } from "vitest";

import { RuntimeError } from "../src/runtime/errors.js";
import {
  detachExecutionBindingInTx,
  getExecutionBindingInTx,
  getExecutionHandoffInTx,
  getExecutionHandoffStateInTx,
  reattachExecutionBindingInTx,
} from "../src/store/execution.js";
import { getFinalPlanInTx } from "../src/store/finalization.js";
import { getPlanningRunRecord } from "../src/store/planning-runs.js";
import { getBinding } from "../src/store/session-bindings.js";
import { getHeadCommitRecord } from "../src/store/plan-commits.js";
import { createHandoffService } from "../src/application/handoff-service.js";
import { listObservationSummaries } from "../src/application/observation-service.js";
import { handlePostToolUse } from "../src/hooks/handlers.js";
import { makeApprovedFinalPlanFixture, callHandoff, executionToken } from "./phase14-helpers.js";
import { executePhasePlanTool, type PhasePlanToolContext } from "../src/mcp/tools.js";
import { hostToken } from "./context-helpers.js";

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof RuntimeError) return err.code;
    throw err;
  }
  throw new Error("expected a RuntimeError but none was thrown");
}

function eventsOf(ctx: PhasePlanToolContext, runId: string) {
  return ctx.store.withRead((tx) => {
    const handoff = getExecutionHandoffInTx(tx, runId);
    if (handoff === null) return { handoff: null, state: null, attempts: 0, delivered: 0, prepared: 0 };
    const rows = tx
      .prepare(
        "SELECT event_type AS t FROM execution_handoff_events WHERE run_id = ? AND handoff_id = ? ORDER BY event_seq",
      )
      .all(runId, handoff.handoffId) as Array<{ t: string }>;
    return {
      handoff,
      state: getExecutionHandoffStateInTx(tx, runId),
      attempts: rows.filter((r) => r.t === "DELIVERY_ATTEMPT").length,
      delivered: rows.filter((r) => r.t === "DELIVERED").length,
      prepared: rows.filter((r) => r.t === "PREPARED").length,
    };
  });
}

describe("handoff prepare (§22–§35/§90, E2–E11, E22–E24, E32–E34)", () => {
  it("derives the canonical handoff server-side: hard-only constraints, all contracts, all decisions, limitations, empty validationRequirements", async () => {
    const { f, ctx } = await makeApprovedFinalPlanFixture();
    const ws = ctx.store.withRead((tx) =>
      tx.prepare("SELECT canonical_root AS r, kind FROM workspaces WHERE workspace_id = ?").get(f.workspaceId) as { r: string; kind: string },
    );
    const service = createHandoffService(ctx.store, ctx.clock);
    const revisionBefore = getPlanningRunRecord(ctx.store, f.runId)!.revision;
    const result = service.prepareHandoffDelivery({
      runId: f.runId,
      workspaceId: f.workspaceId,
      workspaceRoot: ws.r,
      sessionId: f.sessionId,
      toolUseId: "TU-PREP-1",
    });
    expect(result.handoff.version).toBe(1);
    expect(result.handoff.finalPlan).toEqual({ id: f.finalPlanId, revision: 1, hash: f.finalPlanHash });
    expect(result.handoff.goal.length).toBeGreaterThan(0);
    expect(result.handoff.validationRequirements).toEqual([]);
    // Conservative decision mapping: every FinalPlan decision ref is critical (§28).
    const plan = ctx.store.withRead((tx) => JSON.parse(getFinalPlanInTx(tx, f.runId)!.canonicalJson)) as {
      decisions: Array<{ id: string; revision: number }>;
      constraints: Array<{ id: string; revision: number }>;
      sections: Array<{ sectionId: string; revision: number }>;
      limitations: unknown[];
    };
    expect(result.handoff.criticalDecisions).toEqual(plan.decisions.map((d) => ({ id: d.id, revision: d.revision })));
    expect(result.handoff.requiredContracts).toEqual(plan.sections.map((s) => ({ sectionId: s.sectionId, revision: s.revision })));
    expect(result.handoff.knownLimitations).toEqual(plan.limitations);
    for (const hard of result.handoff.hardConstraints) {
      expect(plan.constraints).toContainEqual(hard);
    }
    for (const constraint of plan.constraints) {
      const row = ctx.store.withRead((tx) =>
        tx.prepare("SELECT content_json AS c FROM memory_revisions WHERE run_id = ? AND kind = 'constraint' AND artifact_id = ? AND revision = ?")
          .get(f.runId, constraint.id, constraint.revision) as { c: string },
      );
      if ((JSON.parse(row.c) as { severity: string }).severity === "hard") {
        expect(result.handoff.hardConstraints).toContainEqual({ id: constraint.id, revision: constraint.revision });
      } else {
        expect(result.handoff.hardConstraints).not.toContainEqual({ id: constraint.id, revision: constraint.revision });
      }
    }
    // Immutable record + PREPARED + prepared state; run untouched (E2/E22/E24).
    const world = eventsOf(ctx, f.runId);
    expect(world.prepared).toBe(1);
    expect(world.attempts).toBe(1);
    expect(world.state?.status).toBe("prepared");
    const run = getPlanningRunRecord(ctx.store, f.runId)!;
    expect(run.lifecycle).toBe("active");
    expect(run.stage).toBe("final");
    expect(run.revision).toBe(revisionBefore); // prepare adds +0 (§50)
    // §51 — HEAD unchanged, no PlanCommit, no evidence/section mutation.
    expect(getHeadCommitRecord(ctx.store, f.runId)?.commitId).toBe(f.commitId);
    // Binding attached at generation 1 (E23/§20).
    const binding = getExecutionBindingInTx(ctx.store.withRead((tx) => tx), f.runId);
    expect(binding).toMatchObject({ state: "attached", generation: 1, sessionId: f.sessionId, finalPlanId: f.finalPlanId });
  });

  it("freezes the repository baseline at creation; a reuse never re-derives it (E5/§25)", async () => {
    const { f, ctx } = await makeApprovedFinalPlanFixture();
    const first = callHandoff(ctx, f, { toolUseId: "TU-BASE-1" });
    expect(first.repository_baseline.kind).toBe("directory");
    expect(first.repository_baseline.revision).toBeNull();
    const second = callHandoff(ctx, f, { toolUseId: "TU-BASE-2" });
    expect(second.handoff_id).toBe(first.handoff_id);
    expect(second.handoff_hash).toBe(first.handoff_hash);
    expect(second.repository_baseline).toEqual(first.repository_baseline);
  });

  it("reuses the exact prepared handoff for new invocations and appends a new attempt (§42/E38)", async () => {
    const { f, ctx } = await makeApprovedFinalPlanFixture();
    const a = callHandoff(ctx, f, { toolUseId: "TU-RE-1" });
    const b = callHandoff(ctx, f, { toolUseId: "TU-RE-2" });
    expect(b.handoff_id).toBe(a.handoff_id);
    expect(b.handoff_hash).toBe(a.handoff_hash);
    expect(eventsOf(ctx, f.runId).attempts).toBe(2);
    // same invocation identity does not duplicate its attempt
    callHandoff(ctx, f, { toolUseId: "TU-RE-2" });
    expect(eventsOf(ctx, f.runId).attempts).toBe(2);
  });

  it("denies handoff outside the final/approved world and for other workspaces (§34/E15)", async () => {
    const approved = await makeApprovedFinalPlanFixture();
    expect(codeOf(() => callHandoff(approved.ctx, { ...approved.f, runId: "plan_missing" }, { toolUseId: "TU-X1" }))).toBe("BINDING_NOT_FOUND");
    // A non-final run: the clean fixture itself (stage validation).
    const { makeCleanValidationFixture } = await import("./phase13-helpers.js");
    const early = await makeCleanValidationFixture("S1");
    expect(codeOf(() => callHandoff(early.ctx, early.f, { toolUseId: "TU-X2" }))).toBe("HANDOFF_NOT_AUTHORIZED");
  });

  it("denies validator/subagent initiation (§33/E16)", async () => {
    const { f, ctx } = await makeApprovedFinalPlanFixture();
    expect(codeOf(() => callHandoff(ctx, f, { toolUseId: "TU-VAL-1", agent: { agentId: "agent_v", agentType: "phase-plan:validator" } }))).toBe(
      "VALIDATOR_MUTATION_FORBIDDEN",
    );
  });
});

describe("handoff delivery finalizer (§37/§49–§52/§93, E25–E31)", () => {
  it("completes the transition exactly once: DELIVERED + completed + revision+1 + planning binding detach (E27–E30)", async () => {
    const { f, ctx } = await makeApprovedFinalPlanFixture();
    const prepared = callHandoff(ctx, f, { toolUseId: "TU-DEL-1" });
    const planningBindingBefore = getBinding(ctx.store, f.runId)!;
    expect(planningBindingBefore.state).toBe("attached");

    const service = createHandoffService(ctx.store, ctx.clock);
    const revisionBefore = getPlanningRunRecord(ctx.store, f.runId)!.revision;
    const result = service.finalizeDelivery({
      runId: f.runId,
      sessionId: f.sessionId,
      toolUseId: "TU-DEL-1",
      responseHandoffId: prepared.handoff_id,
      responseHandoffHash: prepared.handoff_hash,
    });
    expect(result.alreadyDelivered).toBe(false);

    const run = getPlanningRunRecord(ctx.store, f.runId)!;
    expect(run.lifecycle).toBe("completed");
    expect(run.stage).toBe("final");
    expect(run.revision).toBe(revisionBefore + 1); // delivery bumps +1 exactly once (§50)
    const world = eventsOf(ctx, f.runId);
    expect(world.delivered).toBe(1);
    expect(world.state?.status).toBe("delivered");
    expect(world.state?.deliveredAt).not.toBeNull();
    const planningBinding = getBinding(ctx.store, f.runId)!;
    expect(planningBinding.state).toBe("detached");
    expect(planningBinding.generation).toBe(planningBindingBefore.generation + 1);
    const execBinding = ctx.store.withRead((tx) => getExecutionBindingInTx(tx, f.runId));
    expect(execBinding).toMatchObject({ state: "attached" });
    // §51 — HEAD unchanged by delivery too.
    expect(getHeadCommitRecord(ctx.store, f.runId)?.commitId).toBe(f.commitId);
  });

  it("is idempotent: replays of the delivered state change nothing (§39/§116/E70)", async () => {
    const { f, ctx } = await makeApprovedFinalPlanFixture();
    const prepared = callHandoff(ctx, f, { toolUseId: "TU-IDEM-1" });
    const service = createHandoffService(ctx.store, ctx.clock);
    service.finalizeDelivery({
      runId: f.runId,
      sessionId: f.sessionId,
      toolUseId: "TU-IDEM-1",
      responseHandoffId: prepared.handoff_id,
      responseHandoffHash: prepared.handoff_hash,
    });
    const snapshot = {
      run: getPlanningRunRecord(ctx.store, f.runId),
      events: eventsOf(ctx, f.runId),
    };
    for (const replay of [1, 2, 3]) {
      const r = service.finalizeDelivery({
        runId: f.runId,
        sessionId: f.sessionId,
        toolUseId: "TU-IDEM-1",
        responseHandoffId: prepared.handoff_id,
        responseHandoffHash: prepared.handoff_hash,
      });
      expect(r.alreadyDelivered).toBe(true);
      void replay;
    }
    expect(getPlanningRunRecord(ctx.store, f.runId)).toEqual(snapshot.run);
    expect(eventsOf(ctx, f.runId)).toEqual(snapshot.events);
  });

  it("never trusts the response alone: wrong hash or unknown attempt is HANDOFF_DELIVERY_INVALID (§93/E26)", async () => {
    const { f, ctx } = await makeApprovedFinalPlanFixture();
    const prepared = callHandoff(ctx, f, { toolUseId: "TU-SEC-1" });
    const service = createHandoffService(ctx.store, ctx.clock);
    expect(codeOf(() =>
      service.finalizeDelivery({
        runId: f.runId,
        sessionId: f.sessionId,
        toolUseId: "TU-SEC-UNKNOWN",
        responseHandoffId: prepared.handoff_id,
        responseHandoffHash: prepared.handoff_hash,
      }),
    )).toBe("HANDOFF_DELIVERY_INVALID");
    expect(codeOf(() =>
      service.finalizeDelivery({
        runId: f.runId,
        sessionId: f.sessionId,
        toolUseId: "TU-SEC-1",
        responseHandoffId: prepared.handoff_id,
        responseHandoffHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      }),
    )).toBe("HANDOFF_DELIVERY_INVALID");
    expect(codeOf(() =>
      service.finalizeDelivery({
        runId: f.runId,
        sessionId: f.sessionId,
        toolUseId: "TU-SEC-1",
        responseHandoffId: "xhandoff_forged",
        responseHandoffHash: prepared.handoff_hash,
      }),
    )).toBe("HANDOFF_DELIVERY_INVALID");
    expect(eventsOf(ctx, f.runId).delivered).toBe(0);
    expect(getPlanningRunRecord(ctx.store, f.runId)!.lifecycle).toBe("active");
  });
});

describe("crash recovery (§40–§42/§86/§89/§114–§115, E36–E40)", () => {
  it("window A — mode switched but handler failed before PREPARED: retry derives the handoff and completes", async () => {
    const { f, ctx } = await makeApprovedFinalPlanFixture();
    // Simulate: nothing stored yet, but the session is already in default mode.
    const recovered = callHandoff(ctx, f, { toolUseId: "TU-CA-1", permissionMode: "default" });
    expect(recovered.status).toBe("ok");
    expect(eventsOf(ctx, f.runId).prepared).toBe(1);
    const service = createHandoffService(ctx.store, ctx.clock);
    service.finalizeDelivery({
      runId: f.runId,
      sessionId: f.sessionId,
      toolUseId: "TU-CA-1",
      responseHandoffId: recovered.handoff_id,
      responseHandoffHash: recovered.handoff_hash,
    });
    expect(getPlanningRunRecord(ctx.store, f.runId)!.lifecycle).toBe("completed");
  });

  it("window B — prepared but finalizer failed: Build stays blocked, retry reuses the handoff, then completes (§41/E37–E39)", async () => {
    const { f, ctx } = await makeApprovedFinalPlanFixture();
    const prepared = callHandoff(ctx, f, { toolUseId: "TU-CB-1" });
    // Finalizer "crashed" — run still active, handoff prepared, binding exists.
    expect(getPlanningRunRecord(ctx.store, f.runId)!.lifecycle).toBe("active");
    const execBinding = ctx.store.withRead((tx) => getExecutionBindingInTx(tx, f.runId));
    expect(execBinding).not.toBeNull();
    // Build read authority is NOT available before delivery (§90).
    expect(codeOf(() =>
      executePhasePlanTool(ctx, "get_state", {
        _hostContext: executionToken(ctx, {
          sessionId: f.sessionId,
          workspaceId: f.workspaceId,
          runId: f.runId,
          finalPlanId: f.finalPlanId,
          generation: execBinding!.generation,
          tool: "get_state",
        }),
      }),
    )).toBe("EXECUTION_CONTEXT_NOT_AVAILABLE");
    // Retry: same immutable handoff, new attempt, then success completes.
    const retry = callHandoff(ctx, f, { toolUseId: "TU-CB-2", permissionMode: "default" });
    expect(retry.handoff_id).toBe(prepared.handoff_id);
    expect(retry.handoff_hash).toBe(prepared.handoff_hash);
    const service = createHandoffService(ctx.store, ctx.clock);
    service.finalizeDelivery({
      runId: f.runId,
      sessionId: f.sessionId,
      toolUseId: "TU-CB-2",
      responseHandoffId: retry.handoff_id,
      responseHandoffHash: retry.handoff_hash,
    });
    expect(getPlanningRunRecord(ctx.store, f.runId)!.lifecycle).toBe("completed");
  });
});

describe("multi-process handoff race (§117/E71)", () => {
  it("two workers converge on one canonical handoff, one binding, and one delivered transition", async () => {
    const { f, ctx } = await makeApprovedFinalPlanFixture();
    const service = createHandoffService(ctx.store, ctx.clock);
    const ws = ctx.store.withRead((tx) =>
      tx.prepare("SELECT canonical_root AS r FROM workspaces WHERE workspace_id = ?").get(f.workspaceId) as { r: string },
    );
    const input = {
      runId: f.runId,
      workspaceId: f.workspaceId,
      workspaceRoot: ws.r,
      sessionId: f.sessionId,
    };
    const a = service.prepareHandoffDelivery({ ...input, toolUseId: "TU-RACE-A" });
    const b = service.prepareHandoffDelivery({ ...input, toolUseId: "TU-RACE-B" });
    expect(b.handoffId).toBe(a.handoffId);
    expect(b.handoffHash).toBe(a.handoffHash);
    expect(eventsOf(ctx, f.runId).attempts).toBe(2);
    // Competing deliveries: first wins, the loser replays idempotently at the state level.
    service.finalizeDelivery({ ...input, toolUseId: "TU-RACE-A", responseHandoffId: a.handoffId, responseHandoffHash: a.handoffHash });
    const replay = service.finalizeDelivery({ ...input, toolUseId: "TU-RACE-B", responseHandoffId: b.handoffId, responseHandoffHash: b.handoffHash });
    expect(replay.alreadyDelivered).toBe(true);
    expect(eventsOf(ctx, f.runId).delivered).toBe(1);
  });
});

describe("ExecutionBinding lifecycle (§20–§21/§79/§82, E63–E67)", () => {
  it("detach + exact-session reattach bumps the generation; another session can never attach (E64/E67)", async () => {
    const { f, ctx } = await makeApprovedFinalPlanFixture();
    const prepared = callHandoff(ctx, f, { toolUseId: "TU-BIND-1" });
    const service = createHandoffService(ctx.store, ctx.clock);
    service.finalizeDelivery({
      runId: f.runId,
      sessionId: f.sessionId,
      toolUseId: "TU-BIND-1",
      responseHandoffId: prepared.handoff_id,
      responseHandoffHash: prepared.handoff_hash,
    });
    const gen1 = ctx.store.withRead((tx) => getExecutionBindingInTx(tx, f.runId))!.generation;
    // SessionEnd-style detach (generation +1), then exact-session reattach (+1).
    ctx.store.withWrite((tx) => {
      detachExecutionBindingInTx(tx, { runId: f.runId, sessionId: f.sessionId }, ctx.clock.nowIso());
      return null;
    });
    const gen2 = ctx.store.withRead((tx) => getExecutionBindingInTx(tx, f.runId))!;
    expect(gen2.state).toBe("detached");
    expect(gen2.generation).toBe(gen1 + 1);
    ctx.store.withWrite((tx) => {
      reattachExecutionBindingInTx(tx, { runId: f.runId, sessionId: f.sessionId, workspaceId: f.workspaceId }, ctx.clock.nowIso());
      return null;
    });
    const gen3 = ctx.store.withRead((tx) => getExecutionBindingInTx(tx, f.runId))!;
    expect(gen3.state).toBe("attached");
    expect(gen3.generation).toBe(gen1 + 2);
    // Another session can never take over (§82).
    expect(codeOf(() =>
      ctx.store.withWrite((tx) =>
        reattachExecutionBindingInTx(tx, { runId: f.runId, sessionId: "OTHER-SESSION", workspaceId: f.workspaceId }, ctx.clock.nowIso()),
      ),
    )).toBe("EXECUTION_BINDING_REQUIRED");
  });
});

describe("Build read authority and memory scope (§56/§63–§67/§91, E43/E46–E54)", () => {
  async function delivered(sessionId = "S1") {
    const { f, ctx } = await makeApprovedFinalPlanFixture(sessionId);
    const prepared = callHandoff(ctx, f, { toolUseId: `${sessionId}-READ-1` });
    createHandoffService(ctx.store, ctx.clock).finalizeDelivery({
      runId: f.runId,
      sessionId: f.sessionId,
      toolUseId: `${sessionId}-READ-1`,
      responseHandoffId: prepared.handoff_id,
      responseHandoffHash: prepared.handoff_hash,
    });
    const binding = ctx.store.withRead((tx) => getExecutionBindingInTx(tx, f.runId))!;
    return { f, ctx, binding };
  }

  function execCall<T>(ctx: PhasePlanToolContext, f: { sessionId: string; workspaceId: string; runId: string; finalPlanId: string }, generation: number, tool: string, business: Record<string, unknown> = {}, toolUseId = "TU-EXEC"): T {
    return executePhasePlanTool(ctx, tool, {
      ...business,
      _hostContext: executionToken(ctx, { sessionId: f.sessionId, workspaceId: f.workspaceId, runId: f.runId, finalPlanId: f.finalPlanId, generation, tool, business, toolUseId }),
    }) as T;
  }

  it("get_state returns the compact Build view and never other session ids (§58/E46)", async () => {
    const { f, ctx, binding } = await delivered();
    const state = execCall<{ run: { lifecycle: string; stage: string }; executionHandoff: { delivered: boolean }; executionBinding: { generation: number } }>(
      ctx, f, binding.generation, "get_state",
    );
    expect(state.run).toMatchObject({ lifecycle: "completed", stage: "final" });
    expect(state.executionHandoff.delivered).toBe(true);
    expect(state.executionBinding).toEqual({ generation: binding.generation, state: "attached" });
    expect(JSON.stringify(state)).not.toContain("TU-");
  });

  it("a stale generation fences as STALE_EXECUTION_BINDING; a wrong session never reads (E43/E67)", async () => {
    const { f, ctx, binding } = await delivered();
    expect(codeOf(() => execCall(ctx, f, binding.generation + 5, "get_state"))).toBe("STALE_EXECUTION_BINDING");
    expect(codeOf(() =>
      executePhasePlanTool(ctx, "get_state", {
        _hostContext: executionToken(ctx, {
          sessionId: "OTHER-SESSION",
          workspaceId: f.workspaceId,
          runId: f.runId,
          finalPlanId: f.finalPlanId,
          generation: binding.generation,
          tool: "get_state",
        }),
      }),
    )).toBe("EXECUTION_CONTEXT_NOT_AVAILABLE");
  });

  it("read_memory is exact-ref and FinalPlan-scoped; historical refs and questions fail closed (§63–§65/E48–E50)", async () => {
    const { f, ctx, binding } = await delivered();
    const plan = ctx.store.withRead((tx) => JSON.parse(getFinalPlanInTx(tx, f.runId)!.canonicalJson)) as {
      sections: Array<{ sectionId: string; revision: number }>;
      decisions: Array<{ id: string; revision: number }>;
      constraints: Array<{ id: string; revision: number }>;
    };
    if (plan.sections.length === 0) throw new Error("fixture has no sections");
    const section = plan.sections[0]!;
    const decision = plan.decisions[0];
    const constraint = plan.constraints[0];
    // E51–E54: Build can read Architecture/Sections/Contracts/Decisions/Constraints.
    const full = execCall<{ status: string }>(ctx, f, binding.generation, "read_memory", { kind: "section", id: section.sectionId, revision: section.revision, detail: "full" });
    expect(full.status).toBe("ok");
    expect(execCall<{ status: string }>(ctx, f, binding.generation, "read_memory", { kind: "section", id: section.sectionId, revision: section.revision, detail: "contract" }).status).toBe("ok");
    if (decision) expect(execCall<{ status: string }>(ctx, f, binding.generation, "read_memory", { kind: "decision", id: decision.id, revision: decision.revision }).status).toBe("ok");
    if (constraint) expect(execCall<{ status: string }>(ctx, f, binding.generation, "read_memory", { kind: "constraint", id: constraint.id, revision: constraint.revision }).status).toBe("ok");
    // §64 — historical revision of an authorized section fails closed.
    expect(codeOf(() => execCall(ctx, f, binding.generation, "read_memory", { kind: "section", id: section.sectionId, revision: section.revision + 1 }))).toBe(
      "EXECUTION_MEMORY_REF_NOT_AUTHORIZED",
    );
    // §65 — open questions are not Build memory.
    expect(codeOf(() => execCall(ctx, f, binding.generation, "read_memory", { kind: "open_question", id: "QQ-whatever", revision: 1 }))).toBe(
      "CAPABILITY_NOT_AVAILABLE",
    );
  });

  it("get_context(detail=build) is deterministic; planning details stay closed (§59–§60/E47)", async () => {
    const { f, ctx, binding } = await delivered();
    const a = execCall<{ executionContract: string }>(ctx, f, binding.generation, "get_context", { detail: "build" }, "TU-CTX-A");
    const b = execCall<{ executionContract: string }>(ctx, f, binding.generation, "get_context", { detail: "build" }, "TU-CTX-B");
    expect(a.executionContract).toBe(b.executionContract);
    expect(a.executionContract).toContain("[Phase Plan Execution Contract v1]");
    expect(codeOf(() => execCall(ctx, f, binding.generation, "get_context", { detail: "final" }))).toBe("CAPABILITY_NOT_AVAILABLE");
    // §132 — the contract never contains host secrets, session ids, or paths.
    expect(a.executionContract.toLowerCase()).not.toContain("signature");
    expect(a.executionContract).not.toContain(f.sessionId);
    expect(a.executionContract).not.toContain("phase-plan.sqlite3");
  });
});

describe("Phase 14 boundary (§47/§48/§68/§69/§83/§98/§133, E34/E55–E59/E68/E74)", () => {
  it("no finalization rerun, no evidence mutation during handoff; observation capture stops after completion", async () => {
    const { f, ctx } = await makeApprovedFinalPlanFixture();
    const auditBefore = ctx.store.withRead((tx) =>
      tx.prepare("SELECT count(*) AS n FROM evidence_audit_snapshots").get() as { n: number },
    );
    const prepared = callHandoff(ctx, f, { toolUseId: "TU-NOGATE-1" });
    const world = eventsOf(ctx, f.runId);
    expect(world.prepared).toBe(1);
    expect(auditBefore.n).toBe(ctx.store.withRead((tx) =>
      tx.prepare("SELECT count(*) AS n FROM evidence_audit_snapshots").get() as { n: number },
    ).n);
    createHandoffService(ctx.store, ctx.clock).finalizeDelivery({
      runId: f.runId,
      sessionId: f.sessionId,
      toolUseId: "TU-NOGATE-1",
      responseHandoffId: prepared.handoff_id,
      responseHandoffHash: prepared.handoff_hash,
    });
    // §69 — PostToolUse capture no longer attaches to the completed run.
    const obsBefore = listObservationSummaries(ctx.store, f.runId, { limit: 100 }).length;
    await handlePostToolUse(
      { store: ctx.store, secret: ctx.secret, clock: ctx.clock },
      {
        sessionId: f.sessionId,
        permissionMode: "default",
        hookEventName: "PostToolUse",
        toolName: "Read",
        toolInput: { file_path: "somewhere.ts" },
        toolUseId: "call_OBSSTOP",
        toolResponse: { type: "text", text: "hello" },
      },
    );
    expect(listObservationSummaries(ctx.store, f.runId, { limit: 100 }).length).toBe(obsBefore);
  });

  it("planning mutations fail closed on the completed run (§133/E55)", async () => {
    const { f, ctx } = await makeApprovedFinalPlanFixture();
    const prepared = callHandoff(ctx, f, { toolUseId: "TU-TERM-1" });
    createHandoffService(ctx.store, ctx.clock).finalizeDelivery({
      runId: f.runId,
      sessionId: f.sessionId,
      toolUseId: "TU-TERM-1",
      responseHandoffId: prepared.handoff_id,
      responseHandoffHash: prepared.handoff_hash,
    });
    // A planning-context mutation against the completed run: no attached active
    // run exists, so the hook layer signs nothing and the MCP layer fails closed.
    const ids = { sessionId: f.sessionId, workspaceId: f.workspaceId, runId: f.runId, generation: f.generation };
    const token = hostToken(ctx.secret, "promote_evidence", {}, ids, { permissionMode: "default", toolUseId: "TU-TERM-PROMOTE" });
    // stage gates run before ownership checks; either fail-closed code is correct here
    expect(["STALE_SESSION_BINDING", "CAPABILITY_NOT_AVAILABLE"]).toContain(codeOf(() =>
      executePhasePlanTool(ctx, "promote_evidence", { _hostContext: token }),
    ));
    // New handoff invocations after delivery fail closed.
    expect(codeOf(() => callHandoff(ctx, f, { toolUseId: "TU-TERM-2" }))).toBe("HANDOFF_ALREADY_DELIVERED");
  });

  it("start_or_resume on a Build-bound session is EXECUTION_REPLAN_NOT_AVAILABLE (§83/E68)", async () => {
    const { f, ctx } = await makeApprovedFinalPlanFixture();
    const prepared = callHandoff(ctx, f, { toolUseId: "TU-REPLAN-1" });
    createHandoffService(ctx.store, ctx.clock).finalizeDelivery({
      runId: f.runId,
      sessionId: f.sessionId,
      toolUseId: "TU-REPLAN-1",
      responseHandoffId: prepared.handoff_id,
      responseHandoffHash: prepared.handoff_hash,
    });
    const ids = { sessionId: f.sessionId, workspaceId: f.workspaceId, generation: f.generation };
    const entry = "entry-intent-token";
    const token = hostToken(ctx.secret, "start_or_resume", { _entryIntent: entry, goal: "next" }, ids, { permissionMode: "default", toolUseId: "TU-REPLAN-2" });
    expect(codeOf(() =>
      executePhasePlanTool(ctx, "start_or_resume", { _entryIntent: entry, goal: "next", _hostContext: token }),
    )).toBe("EXECUTION_REPLAN_NOT_AVAILABLE");
  });

  it("handoff replay under the execution authority returns the identical handoff idempotently (§134)", async () => {
    const { f, ctx } = await makeApprovedFinalPlanFixture();
    const prepared = callHandoff(ctx, f, { toolUseId: "TU-REPLAY-1" });
    createHandoffService(ctx.store, ctx.clock).finalizeDelivery({
      runId: f.runId,
      sessionId: f.sessionId,
      toolUseId: "TU-REPLAY-1",
      responseHandoffId: prepared.handoff_id,
      responseHandoffHash: prepared.handoff_hash,
    });
    const binding = ctx.store.withRead((tx) => getExecutionBindingInTx(tx, f.runId))!;
    const token = executionToken(ctx, {
      sessionId: f.sessionId,
      workspaceId: f.workspaceId,
      runId: f.runId,
      finalPlanId: f.finalPlanId,
      generation: binding.generation,
      tool: "handoff",
      business: {},
      toolUseId: "TU-REPLAY-1",
    });
    const replayed = executePhasePlanTool(ctx, "handoff", { _hostContext: token }) as { idempotent: boolean; handoff_id: string; handoff_hash: string };
    expect(replayed.idempotent).toBe(true);
    expect(replayed.handoff_id).toBe(prepared.handoff_id);
    expect(replayed.handoff_hash).toBe(prepared.handoff_hash);
    // no extra revision bump on replay (§50/§134)
    expect(eventsOf(ctx, f.runId).delivered).toBe(1);
  });
});
