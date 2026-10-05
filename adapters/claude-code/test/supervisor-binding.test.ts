/**
 * v0.2.0 E2 — SupervisorBinding ownership, fencing & recovery foundation
 * (E2 §24 focused tests T1–T14, T16–T18, T20; T15 lives in store-migration-v15).
 *
 * The fundamental invariant under test: one active ExecutionRun has at most
 * one writable Supervisor session owner; session lifecycle stays orthogonal
 * to ExecutionRun lifecycle; generation fencing is authoritative.
 */
import { describe, expect, it } from "vitest";

import { RuntimeError } from "../src/runtime/errors.js";
import {
  getSupervisorBindingInTx,
  listSupervisorBindingsForSessionInTx,
  listSupervisorBindingEventsInTx,
} from "../src/store/supervisor-bindings.js";
import { getPlanningRunRecord } from "../src/store/planning-runs.js";
import { createSupervisorBindingService } from "../src/application/supervisor-binding-service.js";
import { createRunControlService } from "../src/application/run-control-service.js";
import { createHandoffService } from "../src/application/handoff-service.js";
import { renderExecutionRecoveryContext, renderExecutionRecoveryNotice } from "../src/context/execution-recovery.js";
import { callHandoff, makeApprovedFinalPlanFixture, type ApprovedFinalPlanFixture } from "./phase14-helpers.js";
import { handleSessionEnd, handleSessionStart } from "../src/hooks/handlers.js";
import type { PhasePlanToolContext } from "../src/mcp/tools.js";
import type { PlanStore } from "../src/store/sqlite-store.js";
import type { StoreClock } from "../src/store/migration-runner.js";

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof RuntimeError) return err.code;
    throw err;
  }
  return "no-error";
}

function depsOf(ctx: PhasePlanToolContext): { store: PlanStore; secret: Buffer; clock: StoreClock } {
  return { store: ctx.store, secret: ctx.secret, clock: ctx.clock };
}

function outputOf(output: Awaited<ReturnType<typeof handleSessionStart>>): string {
  return output.kind === "json" ? String((output.payload as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext ?? "") : "";
}

function bindingOf(ctx: PhasePlanToolContext, runId: string) {
  const row = ctx.store.withRead((tx) => getSupervisorBindingInTx(tx, runId));
  if (row === null) throw new Error("fixture SupervisorBinding missing");
  return row;
}

/** Full E1 chain: approved FinalPlan → handoff → activation. Owner S1, generation 1. */
async function makeActiveExecutionWorld(sessionId = "S1") {
  const { f, ctx } = await makeApprovedFinalPlanFixture(sessionId);
  const prepared = callHandoff(ctx, f, { toolUseId: `${sessionId}-DELIVER` });
  const result = createHandoffService(ctx.store, ctx.clock).finalizeDelivery({
    runId: f.runId,
    sessionId: f.sessionId,
    toolUseId: `${sessionId}-DELIVER`,
    responseHandoffId: prepared.handoff_id,
    responseHandoffHash: prepared.handoff_hash,
  });
  if (result.executionRun === null) throw new Error("fixture activation failed");
  return { f, ctx, executionRunId: result.executionRun.executionRunId };
}

function supervisorServiceOf(ctx: PhasePlanToolContext) {
  return createSupervisorBindingService(ctx.store, ctx.clock);
}

function takeoverOf(w: World, callerSessionId: string, expectedGeneration: number) {
  return createRunControlService(w.ctx.store, w.ctx.clock).takeoverRun({
    runId: w.f.runId,
    workspaceId: w.f.workspaceId,
    callerSessionId,
    expectedBindingGeneration: expectedGeneration,
    authorization: {
      authorizationRequestId: `mcp-control:TU-${callerSessionId}`,
      operationId: `takeover:TU-${callerSessionId}`,
      requestHash: `hash-${callerSessionId}-${expectedGeneration}`,
    },
  });
}

interface World {
  f: ApprovedFinalPlanFixture;
  ctx: PhasePlanToolContext;
  executionRunId: string;
}

describe("v0.2.0 E2 — SupervisorBinding ownership, fencing & recovery (T1–T20)", () => {
  it("T1: activation establishes the initial attached SupervisorBinding (generation 1, current session)", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      const binding = bindingOf(w.ctx, w.executionRunId);
      expect(binding.state).toBe("attached");
      expect(binding.generation).toBe(1);
      expect(binding.sessionId).toBe(w.f.sessionId);
      expect(binding.workspaceId).toBe(w.f.workspaceId);
      // Run is active; planning run completed by the E1 chain.
      expect(getPlanningRunRecord(w.ctx.store, w.f.runId)!.lifecycle).toBe("completed");
      const events = w.ctx.store.withRead((tx) => listSupervisorBindingEventsInTx(tx, w.executionRunId));
      expect(events.map((e) => e.eventType)).toEqual(["ATTACHED"]);
    } finally {
      w.ctx.store.close();
    }
  });

  it("T2: detaching the binding leaves the ExecutionRun active (ownership ⊥ lifecycle)", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      supervisorServiceOf(w.ctx).detachSupervisor({ executionRunId: w.executionRunId, sessionId: w.f.sessionId });
      expect(bindingOf(w.ctx, w.executionRunId).state).toBe("detached");
      // E2-I12 — the durable execution authority is untouched by detachment.
      const run = w.ctx.store.withRead((tx) => {
        const row = tx.prepare("SELECT lifecycle FROM execution_runs WHERE run_id = ?").get(w.f.runId) as { lifecycle: string };
        return row.lifecycle;
      });
      expect(run).toBe("active");
      // Same generation after detach (reattachment is not takeover).
      expect(bindingOf(w.ctx, w.executionRunId).generation).toBe(1);
    } finally {
      w.ctx.store.close();
    }
  });

  it("T3: same-session resume reattaches WITHOUT a generation change", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      supervisorServiceOf(w.ctx).detachSupervisor({ executionRunId: w.executionRunId, sessionId: w.f.sessionId });
      const reattached = supervisorServiceOf(w.ctx).reattachSupervisor({
        executionRunId: w.executionRunId,
        workspaceId: w.f.workspaceId,
        sessionId: w.f.sessionId,
      });
      expect(reattached.state).toBe("attached");
      expect(reattached.generation).toBe(1);
      const events = w.ctx.store.withRead((tx) => listSupervisorBindingEventsInTx(tx, w.executionRunId));
      expect(events.map((e) => e.eventType)).toEqual(["ATTACHED", "DETACHED", "ATTACHED"]);
    } finally {
      w.ctx.store.close();
    }
  });

  it("T4/T9/T10: a different session never gains implicit writable authority", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      // Reattach from S2 is rejected (never silently converted into takeover).
      expect(
        codeOf(() =>
          supervisorServiceOf(w.ctx).reattachSupervisor({
            executionRunId: w.executionRunId,
            workspaceId: w.f.workspaceId,
            sessionId: "S2-fork-or-clear",
          }),
        ),
      ).toBe("STALE_SUPERVISOR_BINDING");
      // Writable authority check from S2 fails closed, generation untouched.
      expect(
        codeOf(() =>
          supervisorServiceOf(w.ctx).requireSupervisorAuthority({
            executionRunId: w.executionRunId,
            workspaceId: w.f.workspaceId,
            sessionId: "S2-fork-or-clear",
            generation: 1,
          }),
        ),
      ).toBe("STALE_SUPERVISOR_BINDING");
      const binding = bindingOf(w.ctx, w.executionRunId);
      expect(binding.sessionId).toBe(w.f.sessionId);
      expect(binding.generation).toBe(1);
      expect(binding.state).toBe("attached");
      // No binding rows were created for the new session.
      expect(w.ctx.store.withRead((tx) => listSupervisorBindingsForSessionInTx(tx, "S2-fork-or-clear"))).toEqual([]);
    } finally {
      w.ctx.store.close();
    }
  });

  it("T5: explicit authorized different-session takeover increments the generation", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      const result = takeoverOf(w, "S2", 1);
      expect(result.idempotent).toBe(false);
      expect(result.supervisor).toBeDefined();
      expect(result.supervisor!.generation).toBe(2);
      expect(result.supervisor!.state).toBe("attached");
      const binding = bindingOf(w.ctx, w.executionRunId);
      expect(binding.sessionId).toBe("S2");
      expect(binding.generation).toBe(2);
      // The completed PlanningRun row is untouched by the ownership move.
      expect(getPlanningRunRecord(w.ctx.store, w.f.runId)!.lifecycle).toBe("completed");
      const events = w.ctx.store.withRead((tx) => listSupervisorBindingEventsInTx(tx, w.executionRunId));
      expect(events.map((e) => e.eventType)).toEqual(["ATTACHED", "TAKEOVER"]);
    } finally {
      w.ctx.store.close();
    }
  });

  it("T6: the previous owner is fenced immediately after takeover", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      takeoverOf(w, "S2", 1);
      // S1 with its stale generation 1 fails the authority check deterministically.
      expect(
        codeOf(() =>
          supervisorServiceOf(w.ctx).requireSupervisorAuthority({
            executionRunId: w.executionRunId,
            workspaceId: w.f.workspaceId,
            sessionId: w.f.sessionId,
            generation: 1,
          }),
        ),
      ).toBe("STALE_SUPERVISOR_BINDING");
      // S2 with the CURRENT generation holds writable authority.
      const authority = supervisorServiceOf(w.ctx).requireSupervisorAuthority({
        executionRunId: w.executionRunId,
        workspaceId: w.f.workspaceId,
        sessionId: "S2",
        generation: 2,
      });
      expect(authority.binding.generation).toBe(2);
    } finally {
      w.ctx.store.close();
    }
  });

  it("T7: even the reconnected previous owner stays fenced on its old generation", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      supervisorServiceOf(w.ctx).detachSupervisor({ executionRunId: w.executionRunId, sessionId: w.f.sessionId });
      takeoverOf(w, "S2", 1);
      // S1 "reconnects" (same old session id, old generation 1, detached row):
      // no authority, no reattach — matching session history is not authority.
      expect(
        codeOf(() =>
          supervisorServiceOf(w.ctx).requireSupervisorAuthority({
            executionRunId: w.executionRunId,
            workspaceId: w.f.workspaceId,
            sessionId: w.f.sessionId,
            generation: 1,
          }),
        ),
      ).toBe("STALE_SUPERVISOR_BINDING");
      expect(
        codeOf(() =>
          supervisorServiceOf(w.ctx).reattachSupervisor({
            executionRunId: w.executionRunId,
            workspaceId: w.f.workspaceId,
            sessionId: w.f.sessionId,
          }),
        ),
      ).toBe("STALE_SUPERVISOR_BINDING");
      expect(bindingOf(w.ctx, w.executionRunId).sessionId).toBe("S2");
    } finally {
      w.ctx.store.close();
    }
  });

  it("T8: reattach and takeover from another WorkspaceIdentity fail closed", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      supervisorServiceOf(w.ctx).detachSupervisor({ executionRunId: w.executionRunId, sessionId: w.f.sessionId });
      expect(
        codeOf(() =>
          supervisorServiceOf(w.ctx).reattachSupervisor({
            executionRunId: w.executionRunId,
            workspaceId: "W-OTHER-WORKTREE",
            sessionId: w.f.sessionId,
          }),
        ),
      ).toBe("WORKSPACE_MISMATCH");
      expect(
        codeOf(() =>
          createRunControlService(w.ctx.store, w.ctx.clock).takeoverRun({
            runId: w.f.runId,
            workspaceId: "W-OTHER-WORKTREE",
            callerSessionId: "S2",
            expectedBindingGeneration: 1,
            authorization: {
              authorizationRequestId: "mcp-control:TU-S2-WS",
              operationId: "takeover:TU-S2-WS",
              requestHash: "hash-s2-ws",
            },
          }),
        ),
      ).toBe("WORKSPACE_MISMATCH");
      // The binding never moved.
      expect(bindingOf(w.ctx, w.executionRunId).sessionId).toBe(w.f.sessionId);
      expect(bindingOf(w.ctx, w.executionRunId).generation).toBe(1);
    } finally {
      w.ctx.store.close();
    }
  });

  it("T11: compaction (same session, compact source) preserves ownership and generation", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      const out = await handleSessionStart(depsOf(w.ctx), {
        sessionId: w.f.sessionId,
        cwd: w.f.workspaceRoot,
        source: "compact",
        hookEventName: "SessionStart",
      });
      const text = outputOf(out);
      expect(text).toContain("Execution Recovery Context");
      expect(text).toContain("ownership: current-session");
      const binding = bindingOf(w.ctx, w.executionRunId);
      expect(binding.state).toBe("attached");
      expect(binding.generation).toBe(1);
      expect(binding.sessionId).toBe(w.f.sessionId);
      // No duplicate binding was created.
      expect(w.ctx.store.withRead((tx) => tx.prepare("SELECT COUNT(*) AS n FROM supervisor_bindings").get())).toEqual({ n: 1 });
    } finally {
      w.ctx.store.close();
    }
  });

  it("T12: SessionEnd detaches best-effort; the run stays active and takeover still supersedes", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      handleSessionEnd(depsOf(w.ctx), { sessionId: w.f.sessionId, hookEventName: "SessionEnd", reason: "prompt_input_exit" });
      expect(bindingOf(w.ctx, w.executionRunId).state).toBe("detached");
      expect(bindingOf(w.ctx, w.executionRunId).generation).toBe(1);
      expect(
        w.ctx.store.withRead((tx) => {
          const row = tx.prepare("SELECT lifecycle FROM execution_runs WHERE run_id = ?").get(w.f.runId) as { lifecycle: string };
          return row.lifecycle;
        }),
      ).toBe("active");
      // Even if SessionEnd had NOT fired, takeover + fencing supersedes.
      const result = takeoverOf(w, "S2", 1);
      expect(result.supervisor!.generation).toBe(2);
      // And a later same-session resume by S2 reattaches at generation 2.
      const reattached = supervisorServiceOf(w.ctx).reattachSupervisor({
        executionRunId: w.executionRunId,
        workspaceId: w.f.workspaceId,
        sessionId: "S2",
      });
      expect(reattached.generation).toBe(2);
    } finally {
      w.ctx.store.close();
    }
  });

  it("T13/T14: the Execution Recovery Context is deterministic and purely a projection", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      const facts = w.ctx.store.withRead((tx) =>
        supervisorServiceOf(w.ctx).loadExecutionRecoveryFactsInTx(tx, {
          executionRunId: w.executionRunId,
          sessionId: w.f.sessionId,
        }),
      );
      const first = renderExecutionRecoveryContext(facts);
      const second = renderExecutionRecoveryContext(facts);
      expect(first).toBe(second);
      expect(first).toContain(`ExecutionRun: ${w.executionRunId}`);
      expect(first).toContain(`FinalPlan: ${w.f.finalPlanId}`);
      expect(first).toContain("generation: 1");
      // E3 extension: the capsule now carries canonical Stage/Window state.
      expect(first).toContain("Execution structure:");
      expect(first).toContain("accepted head: execution_start (no accepted commits yet)");
      // Rendering the capsule (and re-reading facts) mutates nothing.
      const snapshot = () =>
        w.ctx.store.withRead((tx) => ({
          runs: tx.prepare("SELECT * FROM execution_runs").all(),
          bindings: tx.prepare("SELECT * FROM supervisor_bindings").all(),
          events: tx.prepare("SELECT * FROM supervisor_binding_events").all(),
          finalPlans: tx.prepare("SELECT * FROM final_plans").all(),
        }));
      const before = snapshot();
      renderExecutionRecoveryContext(facts);
      renderExecutionRecoveryNotice(facts, w.executionRunId);
      expect(snapshot()).toEqual(before);
    } finally {
      w.ctx.store.close();
    }
  });

  it("T16: a fresh post-v15 handoff creates the initial binding through the full MCP flow", async () => {
    const w = await makeActiveExecutionWorld("S-FRESH");
    try {
      const binding = bindingOf(w.ctx, w.executionRunId);
      expect(binding.generation).toBe(1);
      expect(binding.state).toBe("attached");
      expect(binding.sessionId).toBe("S-FRESH");
      // The Build state view surfaces the durable supervision ownership.
      const supervisor = w.ctx.store.withRead((tx) => getSupervisorBindingInTx(tx, w.executionRunId));
      expect(supervisor).not.toBeNull();
    } finally {
      w.ctx.store.close();
    }
  });

  it("T17: persistence converges to one canonical owner — never two writable owners", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      // The current owner taking over again is refused (resume, not takeover).
      expect(codeOf(() => takeoverOf(w, w.f.sessionId, 1))).toBe("TAKEOVER_NOT_REQUIRED");
      // Exactly one canonical row per run.
      expect(
        w.ctx.store.withRead((tx) => tx.prepare("SELECT COUNT(*) AS n FROM supervisor_bindings WHERE execution_run_id = ?").get(w.executionRunId) as { n: number }).n,
      ).toBe(1);
      // The DDL itself: a second binding row for the SAME run is impossible
      // (PRIMARY KEY(execution_run_id) — the 0..1 writable-owner law is not model behavior).
      expect(
        w.ctx.store.withRead((tx) => {
          try {
            tx.prepare(
              "INSERT INTO supervisor_bindings (execution_run_id, workspace_id, session_id, state, generation, created_at, updated_at) "
              + "VALUES (?, ?, 'S9', 'attached', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            ).run(w.executionRunId, w.f.workspaceId);
            return "inserted";
          } catch {
            return "rejected";
          }
        }),
      ).toBe("rejected");
      // Takeover converges: S2 takes the single seat, S1 is fenced, still one row.
      takeoverOf(w, "S2", 1);
      expect(bindingOf(w.ctx, w.executionRunId).sessionId).toBe("S2");
      expect(bindingOf(w.ctx, w.executionRunId).generation).toBe(2);
      expect(
        w.ctx.store.withRead((tx) => tx.prepare("SELECT COUNT(*) AS n FROM supervisor_bindings").get() as { n: number }).n,
      ).toBe(1);
    } finally {
      w.ctx.store.close();
    }
  });

  it("T18: generations are monotonic across repeated authorized takeovers (1 → 2 → 3)", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      const g1 = takeoverOf(w, "S2", 1);
      expect(g1.supervisor!.generation).toBe(2);
      const g2 = takeoverOf(w, "S3", 2);
      expect(g2.supervisor!.generation).toBe(3);
      expect(bindingOf(w.ctx, w.executionRunId).sessionId).toBe("S3");
      // Stale expectations fail closed; no generation is ever reused.
      expect(codeOf(() => takeoverOf(w, "S4", 1))).toBe("STALE_SUPERVISOR_BINDING");
      expect(codeOf(() => takeoverOf(w, "S4", 2))).toBe("STALE_SUPERVISOR_BINDING");
      expect(bindingOf(w.ctx, w.executionRunId).generation).toBe(3);
      const events = w.ctx.store.withRead((tx) => listSupervisorBindingEventsInTx(tx, w.executionRunId));
      expect(events.map((e) => e.eventType)).toEqual(["ATTACHED", "TAKEOVER", "TAKEOVER"]);
    } finally {
      w.ctx.store.close();
    }
  });

  it("T20: no E3 execution subsystem tables exist in the E2 schema", async () => {
    const w = await makeActiveExecutionWorld();
    try {
      const tables = w.ctx.store.withRead(
        (tx) => tx.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>,
      ).map((r) => r.name);
      for (const forbidden of [
        // execution_stages/verification_windows arrived in E3 and are legal here.
        // execution_directives/attempts/reports arrived in E4 and are legal here.
        // supervisor_assessments/execution_commits arrived in E6 and are legal here.
        "execution_observations",
        "verification_results",
      ]) {
        expect(tables).not.toContain(forbidden);
      }
    } finally {
      w.ctx.store.close();
    }
  });
});
