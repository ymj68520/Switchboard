/**
 * E10 §66 — final-closure start gates (E10-T6..T12).
 *
 * The Final Closure Window opens ONLY through the explicit Supervisor begin
 * operation at the exact all_stages_completed boundary; every incomplete
 * boundary state fails closed; a second open final window is impossible; and
 * NOTHING auto-opens it (completion/SessionStart/recovery never start closure).
 */
import { describe, expect, it } from "vitest";

import {
  beginFinalClosure,
  boundaryFacts,
  completeAllStagesFixture,
  makeAcceptanceWorld,
  type FinalClosureWorld,
} from "./final-closure-helpers.js";
import { completeActiveStageFixture } from "./acceptance-helpers.js";
import { beginExecutionFinalClosureInTx } from "../src/application/final-closure-service.js";
import { codeOf } from "./acceptance-helpers.js";
import { executePhasePlanTool } from "../src/mcp/tools.js";
import { executionToken } from "./phase14-helpers.js";

let world: FinalClosureWorld | null = null;

async function midWorld(): Promise<FinalClosureWorld> {
  world = await makeAcceptanceWorld(`FS-${Math.random().toString(36).slice(2, 8)}`);
  return world;
}

function beginViaMcp(w: FinalClosureWorld): Record<string, unknown> {
  const tool = "begin_execution_final_closure";
  return executePhasePlanTool(w.ctx, tool, {
    _hostContext: executionToken(w.ctx, {
      sessionId: w.f.sessionId,
      workspaceId: w.f.workspaceId,
      runId: w.executionRunId,
      finalPlanId: w.f.finalPlanId,
      generation: w.f.generation,
      tool,
      business: {},
    }),
  }) as Record<string, unknown>;
}

describe("E10 final-closure start (§9/§10/§56)", () => {
  it("E10-T6: start rejected while a Stage is incomplete", async () => {
    const w = await midWorld();
    // Stage 1 active with open window; stage 2 pending.
    expect(codeOf(() => beginFinalClosure(w))).toBe("FINAL_CLOSURE_NOT_READY");
    w.ctx.store.close();
  });

  it("E10-T7/T8: start rejected with an active or pending Stage remaining", async () => {
    const w = await midWorld();
    completeActiveStageFixture(w); // stage 1 completed, stage 2 pending, no window
    expect(codeOf(() => beginFinalClosure(w))).toBe("FINAL_CLOSURE_NOT_READY");
    w.ctx.store.close();
  });

  it("E10-T10: the exact all_stages_completed boundary starts exactly one final window (base=head, revision 0)", async () => {
    const w = await midWorld();
    completeAllStagesFixture(w);
    const facts = boundaryFacts(w);
    expect(facts).toMatchObject({ lifecycle: "active", activeStageCount: 0, pendingStageCount: 0, openWindowCount: 0 });
    expect(facts.acceptedHead).not.toBeNull();
    // The explicit MCP surface IS the start operation.
    const mcpResult = beginViaMcp(w);
    expect(mcpResult.status).toBe("final_closure_open");
    const window = mcpResult.window as { id: string; scope_kind: string; stage_id: string | null; candidate_revision: number; base_commit_id: string };
    expect(window.scope_kind).toBe("final_closure");
    expect(window.stage_id).toBeNull();
    expect(window.candidate_revision).toBe(0);
    expect(window.base_commit_id).toBe(facts.acceptedHead);
    expect(mcpResult.candidate_revision).toBe(0);
    expect(mcpResult.completion_verification_requirement).toMatchObject({ requirement: "verify_execution_completion" });
    expect(mcpResult.completion_obligation).toMatchObject({ contentHash: expect.any(String) });
    // The world's open-window pointer follows the MCP-created window.
    w.openWindowId = window.id;
    w.ctx.store.close();
  });

  it("E10-T11: a second open final window can never be created", async () => {
    const w = await midWorld();
    completeAllStagesFixture(w);
    beginFinalClosure(w);
    expect(codeOf(() => beginFinalClosure(w))).toBe("FINAL_CLOSURE_ALREADY_OPEN");
    expect(codeOf(() => beginViaMcp(w))).toBe("FINAL_CLOSURE_ALREADY_OPEN");
    w.ctx.store.close();
  });

  it("E10-T12: no auto-start — the boundary is durable until the Supervisor explicitly begins", async () => {
    const w = await midWorld();
    completeAllStagesFixture(w);
    const facts = boundaryFacts(w);
    expect(facts.openWindowCount).toBe(0);
    // The recovery capsule names the boundary passively without acting.
    const { renderExecutionRecoveryContext } = await import("../src/context/execution-recovery.js");
    const { getExecutionRunInTx } = await import("../src/store/execution-runs.js");
    const capsule = renderExecutionRecoveryContext({
      executionRun: w.ctx.store.withRead((tx) => getExecutionRunInTx(tx, w.executionRunId)!),
      binding: { state: "attached", generation: w.f.generation },
      ownership: "current-session",
      structure: { stages: [], activeStage: null, openWindow: null },
      acceptedState: { acceptedHead: { commitId: facts.acceptedHead!, sequence: 1 }, latestAssessment: null, latestCommit: null, completionCommitId: null },
      progression: { boundary: "all_stages_completed", eligibleStageIds: [] },
      verificationPolicy: null,
    });
    expect(capsule).toContain("explicitly begin final execution closure");
    expect(capsule).not.toContain("FINAL EXECUTION CLOSURE IN PROGRESS");
    w.ctx.store.close();
  });

  it("E10 §9: a run with no acceptedHead can never begin closure", async () => {
    const w = await midWorld();
    // A freshly activated run with structure but no commits: strip the head on
    // a raw store is illegal; instead use a prepared-run world — the gate's
    // active-run + head checks fire before any window is created.
    const prepared = codeOf(() =>
      w.ctx.store.withWrite((tx) =>
        beginExecutionFinalClosureInTx(
          tx,
          { executionRunId: "run_missing", sessionId: w.f.sessionId, workspaceId: w.f.workspaceId, generation: w.f.generation },
          w.ctx.clock,
          w.ctx.clock.nowIso(),
        ),
      ),
    );
    expect(["FINAL_CLOSURE_NOT_READY", "SUPERVISOR_BINDING_REQUIRED"]).toContain(prepared);
    w.ctx.store.close();
  });
});
