/**
 * A1-II §61 — the dedicated integrated proof for E14-I31:
 * "same exact immutable FinalPlan → separate later ExecutionRun".
 *
 * Full production-path sequence, driven end-to-end through the REAL surfaces
 * (real planning lifecycle → Final Approval → initial handoff → E1 active →
 * real execution progress → explicit human abort_execution_run → workspace
 * mutation survives → explicit human reexecute_final_plan (the MCP tool) →
 * E2 prepared → E2 active → real v4 Directive → Worker claim → durable Report
 * → fresh verification → Assessment accept → ExecutionCommit):
 *
 *   E14-I31  same exact immutable FinalPlan F
 *            → separate later ExecutionRun E2
 *
 * E9 successor planning is NEVER used as evidence — no second PlanningRun
 * exists anywhere in this scenario.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  makeAcceptanceWorld,
  runDirectiveCycle,
  runVerificationCycle,
  acceptInput,
  acceptanceServiceOf,
  completeActiveStageFixture,
  type AcceptanceWorld,
} from "./acceptance-helpers.js";
import { hostTokenV2 } from "./phase12-helpers.js";
import { executePhasePlanTool } from "../src/mcp/tools.js";
import { getExecutionStructureInTx } from "../src/application/execution-structure-service.js";
import { getFinalPlanInTx } from "../src/store/finalization.js";
import { removeTempPluginDataRoot } from "./store-helpers.js";

function pluginDataRootOf(store: { path: string }): string {
  return path.dirname(path.dirname(store.path));
}

describe("A1-II §61 — E14-I31 integrated same-FinalPlan reexecution", () => {
  it("E14-I31: approved F → E1 active → human abort → human reexecute → E2 executes and commits independently", async () => {
    // ---- /phase-plan → real planning lifecycle → F approved/committed ----
    const world = await makeAcceptanceWorld(`I31-${randomUUID().slice(0, 6)}`);
    const ctx = world.ctx;
    try {
      // ---- real execution progress on E1 (E4/E5/E6 surfaces) ----
      const stageCommit = completeActiveStageFixture(world);
      expect(stageCommit.commitId).toBeTruthy();
      const e1 = world.executionRunId;
      const finalPlanRow = ctx.store.withRead((tx) => getFinalPlanInTx(tx, world.f.runId));
      expect(finalPlanRow).not.toBeNull();
      const finalPlan = { id: finalPlanRow!.finalPlanId, revision: finalPlanRow!.revision, hash: finalPlanRow!.finalPlanHash };

      // Pre-creation fingerprints: the initial handoff + ExecutionBinding
      // families and the completed PlanningRun.
      const handoffBefore = ctx.store.withRead(
        (tx) => tx.prepare("SELECT * FROM execution_handoffs WHERE run_id = ?").all(world.f.runId),
      );
      const handoffStatesBefore = ctx.store.withRead(
        (tx) => tx.prepare("SELECT * FROM execution_handoff_states WHERE run_id = ?").all(world.f.runId),
      );
      const bindingsBefore = ctx.store.withRead(
        (tx) => tx.prepare("SELECT * FROM execution_bindings WHERE run_id = ?").all(world.f.runId),
      );
      const planningBefore = ctx.store.withRead(
        (tx) => tx.prepare("SELECT * FROM planning_runs WHERE run_id = ?").get(world.f.runId),
      );

      // ---- a harmless workspace mutation BEFORE the abort ----
      const workspaceRoot = world.f.workspaceRoot;
      const mutationPath = path.join(workspaceRoot, `a1ii-mutation-${randomUUID().slice(0, 6)}.txt`);
      fs.writeFileSync(mutationPath, "unaccepted workspace state survives abort (no rollback)");

      // ---- explicit human abort of E1 (real MCP handler, signed dialog-grade context) ----
      const abortBusiness = { execution_run_id: e1, reason: "E14-I31 integrated scenario: human aborts E1" };
      const abortToken = hostTokenV2(ctx.secret, "abort_execution_run", abortBusiness, {
        sessionId: world.f.sessionId,
        workspaceId: world.f.workspaceId,
      }, { toolUseId: "TU-I31-ABORT" });
      const abortResult = executePhasePlanTool(ctx, "abort_execution_run", { ...abortBusiness, _hostContext: abortToken }) as {
        status: string;
        execution_run: { execution_run_id: string; lifecycle: string };
      };
      expect(abortResult.status).toBe("aborted");
      expect(abortResult.execution_run.lifecycle).toBe("aborted");
      // The workspace mutation survives — abort means STOP, never rollback.
      expect(fs.existsSync(mutationPath)).toBe(true);

      // ---- explicit human reexecute of the exact F (the A1-II MCP tool) ----
      const reexecuteBusiness = {
        source_planning_run_id: world.f.runId,
        final_plan_id: finalPlan.id,
        final_plan_revision: finalPlan.revision,
        final_plan_hash: finalPlan.hash,
        reason: "E14-I31 integrated scenario: human reexecutes the exact FinalPlan",
      };
      const reexecuteToken = hostTokenV2(ctx.secret, "reexecute_final_plan", reexecuteBusiness, {
        sessionId: world.f.sessionId,
        workspaceId: world.f.workspaceId,
      }, { toolUseId: "TU-I31-REEXEC" });
      const reexecuteResult = executePhasePlanTool(ctx, "reexecute_final_plan", { ...reexecuteBusiness, _hostContext: reexecuteToken }) as {
        status: string;
        idempotent: boolean;
        control_id: string;
        target_kind: string;
        execution_run: { execution_run_id: string; run_id: string; lifecycle: string; workspace_id: string; final_plan: { id: string; revision: number; hash: string } };
        activation: { status: string; supervisor_generation?: number };
      };
      expect(reexecuteResult.status).toBe("reexecution_created");
      expect(reexecuteResult.idempotent).toBe(false);
      expect(reexecuteResult.target_kind).toBe("final_plan_execution");
      const e2 = reexecuteResult.execution_run.execution_run_id;
      // The control flow completed activation (§31): prepared → active with a
      // generation-1 SupervisorBinding for the requesting session.
      expect(reexecuteResult.activation.status).toBe("activated");
      expect(reexecuteResult.activation.supervisor_generation).toBe(1);

      // ---- exact equality / inequality proof over DURABLE fields (§44) ----
      expect(e2).not.toBe(e1);
      expect(reexecuteResult.execution_run.run_id).toBe(world.f.runId);
      expect(reexecuteResult.execution_run.final_plan).toEqual(finalPlan);
      const e2Row = ctx.store.withRead(
        (tx) => tx.prepare("SELECT * FROM execution_runs WHERE execution_run_id = ?").get(e2) as Record<string, unknown>,
      );
      const e1Row = ctx.store.withRead(
        (tx) => tx.prepare("SELECT * FROM execution_runs WHERE execution_run_id = ?").get(e1) as Record<string, unknown>,
      );
      expect(e1Row.lifecycle).toBe("aborted"); // E1 stays aborted
      expect(e2Row.lifecycle).toBe("active");
      expect(e2Row.run_id).toBe(e1Row.run_id); // same source P (provenance)
      expect(e2Row.final_plan_id).toBe(e1Row.final_plan_id);
      expect(e2Row.final_plan_revision).toBe(e1Row.final_plan_revision);
      expect(e2Row.final_plan_hash).toBe(e1Row.final_plan_hash);
      expect(e2Row.accepted_head_commit_id).toBeNull(); // fresh acceptedHead
      // P stays completed, byte-identical; F row unchanged.
      expect(ctx.store.withRead((tx) => tx.prepare("SELECT * FROM planning_runs WHERE run_id = ?").get(world.f.runId))).toEqual(planningBefore);
      const finalPlanAfter = ctx.store.withRead((tx) => getFinalPlanInTx(tx, world.f.runId));
      expect(finalPlanAfter?.finalPlanHash).toBe(finalPlan.hash);
      expect(finalPlanAfter?.revision).toBe(finalPlan.revision);
      // Initial handoff + ExecutionBinding remain exactly once, untouched.
      expect(ctx.store.withRead((tx) => tx.prepare("SELECT * FROM execution_handoffs WHERE run_id = ?").all(world.f.runId))).toEqual(handoffBefore);
      expect(ctx.store.withRead((tx) => tx.prepare("SELECT * FROM execution_handoff_states WHERE run_id = ?").all(world.f.runId))).toEqual(handoffStatesBefore);
      expect(ctx.store.withRead((tx) => tx.prepare("SELECT * FROM execution_bindings WHERE run_id = ?").all(world.f.runId))).toEqual(bindingsBefore);
      // Exactly ONE final_plan_execution authorization, naming E2 at commit.
      const controlRows = ctx.store.withRead(
        (tx) => tx.prepare("SELECT * FROM run_control_authorizations WHERE target_kind = 'final_plan_execution'").all(),
      ) as Record<string, unknown>[];
      expect(controlRows.length).toBe(1);
      expect(controlRows[0]?.operation).toBe("reexecute_final_plan");
      expect(controlRows[0]?.resulting_execution_run_id).toBe(e2);
      // Independent Stage/Window identities (E2 structure materialized at activation).
      const structure = ctx.store.withRead((tx) => getExecutionStructureInTx(tx, e2));
      expect(structure.activeStage).not.toBeNull();
      expect(structure.openWindow?.candidateRevision).toBe(0);

      // ---- E2 actually executes: v4 Directive → Worker → Report ----
      const world2: AcceptanceWorld = {
        ...world,
        executionRunId: e2,
        activeStageId: structure.activeStage!.id,
        openWindowId: structure.openWindow!.id,
        verDirective: null,
        verSession: null,
        verReportId: null,
      };
      const implCycle = runDirectiveCycle(world2, { directiveId: "DIR-I31-E2", kind: "implementation", reportOverrides: { candidate_mutated: true } });
      expect(implCycle.directive.protocolVersion).toBe(4);
      expect(implCycle.directive.executionRunId).toBe(e2);

      // ---- fresh verification → Assessment accept → ExecutionCommit ----
      runVerificationCycle(world2);
      const accept = acceptanceServiceOf(world2).submitSupervisorAssessment(acceptInput(world2) as never) as {
        commit: { commitId: string; sequence: number; parentCommitId: string | null } | null;
      };
      expect(accept.commit).not.toBeNull();
      // Independent commit history: E2's first commit is parentless and is
      // E2's own acceptedHead — never E1's accepted progress.
      expect(accept.commit?.sequence).toBe(1);
      expect(accept.commit?.parentCommitId ?? null).toBeNull();
      expect(accept.commit?.commitId).not.toBe(stageCommit.commitId);
      const headAfter = ctx.store.withRead(
        (tx) => tx.prepare("SELECT accepted_head_commit_id AS head FROM execution_runs WHERE execution_run_id = ?").get(e2) as { head: string | null },
      );
      expect(headAfter.head).toBe(accept.commit?.commitId);
      const e1Head = ctx.store.withRead(
        (tx) => tx.prepare("SELECT accepted_head_commit_id AS head FROM execution_runs WHERE execution_run_id = ?").get(e1) as { head: string | null },
      );
      expect(e1Head.head).toBe(stageCommit.commitId); // E1 history untouched
    } finally {
      ctx.store.close();
      removeTempPluginDataRoot(pluginDataRootOf(ctx.store));
    }
  });
});
