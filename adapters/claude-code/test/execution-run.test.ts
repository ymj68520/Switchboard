/**
 * v0.2.0 E1 — ExecutionRun foundation & recoverable FinalPlan handoff
 * (E1 phase §17 focused tests T1–T14; T15 lives in store-migration-v14).
 *
 * The durable chain under test (E1 §10):
 *   Final Approval → Final PlanCommit → handoff_pending
 *     → ExecutionRun prepared (idempotent, exact FinalPlan binding)
 *     → host handoff succeeds (PostToolUse delivery finalizer)
 *     → ExecutionRun prepared → active (same transaction)
 *     → PlanningRun handoff_pending → completed
 */
import { describe, expect, it } from "vitest";

import { RuntimeError } from "../src/runtime/errors.js";
import { requireLegalExecutionRunTransition } from "../src/core/execution-run.js";
import { canonicalJson } from "../src/core/canonical-json.js";
import {
  createHandoffService,
  deriveExecutionHandoffInTx,
  parseFinalPlanCanonical,
} from "../src/application/handoff-service.js";
import { createExecutionRunService } from "../src/application/execution-run-service.js";
import { deriveRepositoryBaseline } from "../src/application/repository-baseline.js";
import {
  activateExecutionRunInTx,
  getExecutionRunBySourcePlanningRunInTx,
    listExecutionRunEventsInTx,
} from "../src/store/execution-runs.js";
import { getPlanningRunRecord } from "../src/store/planning-runs.js";
import { parsePlanningRunRow } from "../src/core/planning-run.js";
import { getFinalPlanInTx } from "../src/store/finalization.js";
import { getExecutionHandoffStateInTx } from "../src/store/execution.js";
import { callHandoff, makeApprovedFinalPlanFixture, type ApprovedFinalPlanFixture } from "./phase14-helpers.js";
import { callRequestFinalization, makeCleanValidationFixture } from "./phase13-helpers.js";
import type { PhasePlanToolContext } from "../src/mcp/tools.js";

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return err instanceof RuntimeError ? err.code : `non-runtime:${String(err)}`;
  }
  return "no-error";
}

/** The durable ExecutionRun row of the fixture run (must exist). */
function runRow(ctx: PhasePlanToolContext, f: ApprovedFinalPlanFixture) {
  // A1 — the canonical ExecutionRunID is derived at prepare time; the fixture
  // planning run holds exactly one execution world.
  const row = ctx.store.withRead((tx) => getExecutionRunBySourcePlanningRunInTx(tx, f.runId));
  if (row === null) throw new Error("fixture ExecutionRun missing");
  return row;
}

function countExecutionRuns(ctx: PhasePlanToolContext): number {
  return (ctx.store.withRead((tx) =>
    tx.prepare("SELECT COUNT(*) AS n FROM execution_runs").get(),
  ) as { n: number }).n;
}

function executionRunEventTypes(ctx: PhasePlanToolContext, runId: string): string[] {
  // A1 — resolve the fixture planning run to its single canonical world.
  const executionRunId = ctx.store.withRead((tx) => getExecutionRunBySourcePlanningRunInTx(tx, runId))?.executionRunId;
  if (executionRunId === undefined) return [];
  return ctx.store.withRead((tx) => listExecutionRunEventsInTx(tx, executionRunId)).map((e) => e.eventType);
}

describe("v0.2.0 E1 — ExecutionRun foundation (T1–T14)", () => {
  it("T1: the ExecutionRun permanently references the exact approved FinalPlan revision", async () => {
    const { f, ctx } = await makeApprovedFinalPlanFixture();
    try {
      const prepared = callHandoff(ctx, f, { toolUseId: "TU-T1-PREPARE" });
      expect(runRow(ctx, f).finalPlan).toEqual({ id: f.finalPlanId, revision: 1, hash: f.finalPlanHash });
      // Activation (host handoff success) never re-derives or rebinds the ref.
      createHandoffService(ctx.store, ctx.clock).finalizeDelivery({
        runId: f.runId,
        sessionId: f.sessionId,
        toolUseId: "TU-T1-PREPARE",
        responseHandoffId: prepared.handoff_id,
        responseHandoffHash: prepared.handoff_hash,
      });
      expect(runRow(ctx, f).finalPlan).toEqual({ id: f.finalPlanId, revision: 1, hash: f.finalPlanHash });
    } finally {
      ctx.store.close();
    }
  });

  it("T2: a new ExecutionRun is created exactly once with lifecycle prepared", async () => {
    const { f, ctx } = await makeApprovedFinalPlanFixture();
    try {
      const response = callHandoff(ctx, f, { toolUseId: "TU-T2-1" });
      expect(response.execution_run.lifecycle).toBe("prepared");
      const row = runRow(ctx, f);
      expect(row.lifecycle).toBe("prepared");
      expect(row.revision).toBe(1);
      expect(row.workspaceId).toBe(f.workspaceId);
      expect(row.planningBaseline).toBeDefined();
      expect(row.executionStartBaseline).toBeDefined();
      expect(countExecutionRuns(ctx)).toBe(1);
      expect(executionRunEventTypes(ctx, f.runId)).toEqual(["PREPARED"]);
    } finally {
      ctx.store.close();
    }
  });

  it("T3: prepared → active succeeds through the Core authority when the host handoff succeeds", async () => {
    const { f, ctx } = await makeApprovedFinalPlanFixture();
    try {
      const prepared = callHandoff(ctx, f, { toolUseId: "TU-T3-1" });
      const runBefore = getPlanningRunRecord(ctx.store, f.runId)!;
      const result = createHandoffService(ctx.store, ctx.clock).finalizeDelivery({
        runId: f.runId,
        sessionId: f.sessionId,
        toolUseId: "TU-T3-1",
        responseHandoffId: prepared.handoff_id,
        responseHandoffHash: prepared.handoff_hash,
      });
      expect(result.alreadyDelivered).toBe(false);
      expect(result.executionRun).not.toBeNull();
      expect(result.executionRun!.lifecycle).toBe("active");
      const row = runRow(ctx, f);
      expect(row.lifecycle).toBe("active");
      expect(row.revision).toBe(2);
      // The planning baseline is server-derived from the committed FinalPlan.
      const planRow = ctx.store.withRead((tx) => getFinalPlanInTx(tx, f.runId))!;
      expect(row.planningBaseline).toEqual({
        finalPlanCommitId: planRow.commitId,
        headSnapshotId: planRow.snapshotId,
      });
      // PlanningRun completed exactly one revision later, never before.
      const run = getPlanningRunRecord(ctx.store, f.runId)!;
      expect(run.lifecycle).toBe("completed");
      expect(run.revision).toBe(runBefore.revision + 1);
      expect(executionRunEventTypes(ctx, f.runId)).toEqual(["PREPARED", "ACTIVATED"]);
    } finally {
      ctx.store.close();
    }
  });

  it("T4: E1-illegal lifecycle transitions fail deterministically", async () => {
    // The pure transition authority legalizes exactly ABSENT→prepared and
    // prepared→active in this phase.
    expect(() => requireLegalExecutionRunTransition(null, "prepared")).not.toThrow();
    expect(() => requireLegalExecutionRunTransition("prepared", "active")).not.toThrow();
    for (const [from, to] of [
      ["prepared", "completed"],
      ["prepared", "replan_required"],
      ["prepared", "aborted"],
      ["active", "prepared"],
      ["active", "completed"],
      ["active", "replan_required"],
      ["active", "aborted"],
      ["completed", "active"],
      ["replan_required", "active"],
      ["aborted", "active"],
      ["completed", "aborted"],
      [null, "active"],
      [null, "completed"],
    ] as const) {
      expect(codeOf(() => requireLegalExecutionRunTransition(from, to))).toBe("INVALID_EXECUTION_LIFECYCLE");
    }
    // The store primitive is the persistence authority: activating an
    // already-active run fails closed, never force-mutates.
    const { f, ctx } = await makeApprovedFinalPlanFixture();
    try {
      const prepared = callHandoff(ctx, f, { toolUseId: "TU-T4-1" });
      createHandoffService(ctx.store, ctx.clock).finalizeDelivery({
        runId: f.runId,
        sessionId: f.sessionId,
        toolUseId: "TU-T4-1",
        responseHandoffId: prepared.handoff_id,
        responseHandoffHash: prepared.handoff_hash,
      });
      expect(runRow(ctx, f).lifecycle).toBe("active");
      const executionRunId = runRow(ctx, f).executionRunId;
      ctx.store.withWrite((tx) => {
        expect(codeOf(() => activateExecutionRunInTx(tx, executionRunId, "2026-01-01T00:00:00Z"))).toBe(
          "INVALID_EXECUTION_LIFECYCLE",
        );
        return null;
      });
      expect(runRow(ctx, f).lifecycle).toBe("active");
      expect(runRow(ctx, f).revision).toBe(2);
    } finally {
      ctx.store.close();
    }
  });

  it("T5: a handoff retry before activation resolves to the same ExecutionRun", async () => {
    const { f, ctx } = await makeApprovedFinalPlanFixture();
    try {
      const first = callHandoff(ctx, f, { toolUseId: "TU-T5-A" });
      const second = callHandoff(ctx, f, { toolUseId: "TU-T5-B" });
      expect(second.execution_run.id).toBe(first.execution_run.id);
      expect(countExecutionRuns(ctx)).toBe(1);
      // The standalone recovery operation resolves to the same row too.
      const standalone = createExecutionRunService(ctx.store, ctx.clock).prepareExecutionRunForFinalPlan({
        runId: f.runId,
        workspaceId: f.workspaceId,
      });
      expect(standalone.reused).toBe(true);
      expect(standalone.executionRun.executionRunId).toBe(first.execution_run.id);
      expect(countExecutionRuns(ctx)).toBe(1);
      expect(runRow(ctx, f).lifecycle).toBe("prepared");
    } finally {
      ctx.store.close();
    }
  });

  it("T6: a retry after activation creates and activates no second ExecutionRun", async () => {
    const { f, ctx } = await makeApprovedFinalPlanFixture();
    try {
      const prepared = callHandoff(ctx, f, { toolUseId: "TU-T6-1" });
      const service = createHandoffService(ctx.store, ctx.clock);
      const first = service.finalizeDelivery({
        runId: f.runId,
        sessionId: f.sessionId,
        toolUseId: "TU-T6-1",
        responseHandoffId: prepared.handoff_id,
        responseHandoffHash: prepared.handoff_hash,
      });
      expect(first.alreadyDelivered).toBe(false);
      const planningRevision = getPlanningRunRecord(ctx.store, f.runId)!.revision;
      const replay = service.finalizeDelivery({
        runId: f.runId,
        sessionId: f.sessionId,
        toolUseId: "TU-T6-1",
        responseHandoffId: prepared.handoff_id,
        responseHandoffHash: prepared.handoff_hash,
      });
      expect(replay.alreadyDelivered).toBe(true);
      expect(replay.executionRun!.executionRunId).toBe(first.executionRun!.executionRunId);
      expect(replay.executionRun!.lifecycle).toBe("active");
      expect(replay.runRevision).toBe(planningRevision);
      expect(getPlanningRunRecord(ctx.store, f.runId)!.revision).toBe(planningRevision);
      expect(countExecutionRuns(ctx)).toBe(1);
      expect(runRow(ctx, f).lifecycle).toBe("active");
      expect(executionRunEventTypes(ctx, f.runId)).toEqual(["PREPARED", "ACTIVATED"]);
    } finally {
      ctx.store.close();
    }
  });

  it("T7: a failed host transition leaves PlanningRun handoff_pending and ExecutionRun prepared", async () => {
    const { f, ctx } = await makeApprovedFinalPlanFixture();
    try {
      callHandoff(ctx, f, { toolUseId: "TU-T7-1" });
      const service = createHandoffService(ctx.store, ctx.clock);
      // Host transition fails: the finalizer rejects the delivery identity.
      expect(
        codeOf(() =>
          service.finalizeDelivery({
            runId: f.runId,
            sessionId: f.sessionId,
            toolUseId: "TU-T7-1",
            responseHandoffId: "xhandoff-wrong",
            responseHandoffHash: "sha256:wrong",
          }),
        ),
      ).toBe("HANDOFF_DELIVERY_INVALID");
      // The durable state is exactly the recoverable §10 failure state.
      expect(getPlanningRunRecord(ctx.store, f.runId)!.lifecycle).toBe("active");
      expect(getPlanningRunRecord(ctx.store, f.runId)!.stage).toBe("final");
      expect(runRow(ctx, f).lifecycle).toBe("prepared");
      const state = ctx.store.withRead((tx) => getExecutionHandoffStateInTx(tx, f.runId));
      expect(state?.status).toBe("prepared");
      // No replacement run was created for the failure.
      expect(countExecutionRuns(ctx)).toBe(1);
    } finally {
      ctx.store.close();
    }
  });

  it("T8: recovery after a host transition failure activates the SAME run and completes the PlanningRun", async () => {
    const { f, ctx } = await makeApprovedFinalPlanFixture();
    try {
      const prepared = callHandoff(ctx, f, { toolUseId: "TU-T8-FAIL" });
      const service = createHandoffService(ctx.store, ctx.clock);
      expect(
        codeOf(() =>
          service.finalizeDelivery({
            runId: f.runId,
            sessionId: f.sessionId,
            toolUseId: "TU-T8-FAIL",
            responseHandoffId: "xhandoff-wrong",
            responseHandoffHash: "sha256:wrong",
          }),
        ),
      ).toBe("HANDOFF_DELIVERY_INVALID");
      // Resume: the retried host handoff reuses the prepared run, then the
      // honest finalization succeeds.
      const resumed = callHandoff(ctx, f, { toolUseId: "TU-T8-RESUME" });
      expect(resumed.execution_run.id).toBe(prepared.execution_run.id);
      const result = service.finalizeDelivery({
        runId: f.runId,
        sessionId: f.sessionId,
        toolUseId: "TU-T8-RESUME",
        responseHandoffId: resumed.handoff_id,
        responseHandoffHash: resumed.handoff_hash,
      });
      expect(result.alreadyDelivered).toBe(false);
      expect(result.executionRun!.executionRunId).toBe(prepared.execution_run.id);
      expect(result.executionRun!.lifecycle).toBe("active");
      expect(getPlanningRunRecord(ctx.store, f.runId)!.lifecycle).toBe("completed");
      expect(countExecutionRuns(ctx)).toBe(1);
    } finally {
      ctx.store.close();
    }
  });

  it("T9: a crash/retry boundary after prepared persistence reuses the same run", async () => {
    const { f, ctx } = await makeApprovedFinalPlanFixture();
    try {
      const prepared = callHandoff(ctx, f, { toolUseId: "TU-T9-CRASH" });
      // "Restart": fresh service instances over the same durable store.
      const freshHandoff = createHandoffService(ctx.store, ctx.clock);
      const freshExecution = createExecutionRunService(ctx.store, ctx.clock);
      const recovered = freshExecution.prepareExecutionRunForFinalPlan({
        runId: f.runId,
        workspaceId: f.workspaceId,
        sessionId: f.sessionId,
        toolUseId: "TU-T9-RECOVER",
      });
      expect(recovered.reused).toBe(true);
      expect(recovered.executionRun.executionRunId).toBe(prepared.execution_run.id);
      expect(countExecutionRuns(ctx)).toBe(1);
      // The resumed handoff completes on the same run.
      const retry = callHandoff(ctx, f, { toolUseId: "TU-T9-RECOVER" });
      expect(retry.execution_run.id).toBe(prepared.execution_run.id);
      const result = freshHandoff.finalizeDelivery({
        runId: f.runId,
        sessionId: f.sessionId,
        toolUseId: "TU-T9-RECOVER",
        responseHandoffId: retry.handoff_id,
        responseHandoffHash: retry.handoff_hash,
      });
      expect(result.executionRun!.executionRunId).toBe(prepared.execution_run.id);
      expect(getPlanningRunRecord(ctx.store, f.runId)!.lifecycle).toBe("completed");
    } finally {
      ctx.store.close();
    }
  });

  it("T10: a crash after activation converges without creating another run", async () => {
    const { f, ctx } = await makeApprovedFinalPlanFixture();
    try {
      const prepared = callHandoff(ctx, f, { toolUseId: "TU-T10-1" });
      const service = createHandoffService(ctx.store, ctx.clock);
      service.finalizeDelivery({
        runId: f.runId,
        sessionId: f.sessionId,
        toolUseId: "TU-T10-1",
        responseHandoffId: prepared.handoff_id,
        responseHandoffHash: prepared.handoff_hash,
      });
      // Crash after the activation transaction committed, before the outer
      // workflow saw the response: the replayed finalizer converges.
      const replay = service.finalizeDelivery({
        runId: f.runId,
        sessionId: f.sessionId,
        toolUseId: "TU-T10-1",
        responseHandoffId: prepared.handoff_id,
        responseHandoffHash: prepared.handoff_hash,
      });
      expect(replay.alreadyDelivered).toBe(true);
      expect(replay.executionRun!.lifecycle).toBe("active");
      expect(getPlanningRunRecord(ctx.store, f.runId)!.lifecycle).toBe("completed");
      expect(countExecutionRuns(ctx)).toBe(1);
      expect(executionRunEventTypes(ctx, f.runId)).toEqual(["PREPARED", "ACTIVATED"]);
      // A genuinely NEW invocation after completion is refused, never rerun.
      expect(codeOf(() => callHandoff(ctx, f, { toolUseId: "TU-T10-NEW" }))).toBe("HANDOFF_ALREADY_DELIVERED");
      expect(countExecutionRuns(ctx)).toBe(1);
    } finally {
      ctx.store.close();
    }
  });

  it("T11: the PlanningRun cannot complete unless its exact ExecutionRun is durably prepared — invariant corruption fails closed", async () => {
    const { f, ctx } = await makeApprovedFinalPlanFixture();
    try {
      // Corrupt world: a prepared handoff and delivery attempt WITHOUT any
      // ExecutionRun (exactly the §13 inconsistent state; producible only by
      // corruption or a pre-E1 upgrade — never by E1 code, which prepares the
      // run in the same transaction as the handoff).
      const identity = ctx.store.withWrite((tx) => {
        const run = parsePlanningRunRow(
          tx
            .prepare(
              "SELECT run_id AS runId, workspace_id AS workspaceId, lifecycle, stage, revision, goal, "
              + "created_at AS createdAt, updated_at AS updatedAt FROM planning_runs WHERE run_id = ?",
            )
            .get(f.runId) as Record<string, unknown>,
        );
        const finalPlanRow = getFinalPlanInTx(tx, f.runId);
        if (finalPlanRow === null) throw new Error("fixture FinalPlan missing");
        const workspaceRow = tx
          .prepare("SELECT kind, canonical_root AS canonicalRoot FROM workspaces WHERE workspace_id = ?")
          .get(f.workspaceId) as { kind: string; canonicalRoot: string };
        const baseline = deriveRepositoryBaseline(workspaceRow.kind, workspaceRow.canonicalRoot);
        const derived = deriveExecutionHandoffInTx(tx, {
          runId: f.runId,
          run,
          finalPlan: parseFinalPlanCanonical(finalPlanRow.canonicalJson, f.runId),
          finalPlanId: finalPlanRow.finalPlanId,
          finalPlanRevision: finalPlanRow.revision,
          finalPlanHash: finalPlanRow.finalPlanHash,
          baseline,
        });
        const handoffId = "xhandoff_t11";
        tx.prepare(
          "INSERT INTO execution_handoffs (run_id, handoff_id, final_plan_id, final_plan_hash, canonical_json, handoff_hash, created_at) "
          + "VALUES (?, ?, ?, ?, ?, ?, '2026-01-01T00:00:00Z')",
        ).run(f.runId, handoffId, finalPlanRow.finalPlanId, finalPlanRow.finalPlanHash, canonicalJson(derived.handoff), derived.handoffHash);
        tx.prepare(
          "INSERT INTO execution_handoff_events (run_id, handoff_id, event_seq, event_type, session_id, tool_use_id, created_at) "
          + "VALUES (?, ?, 1, 'DELIVERY_ATTEMPT', ?, ?, '2026-01-01T00:00:00Z')",
        ).run(f.runId, handoffId, f.sessionId, "TU-T11");
        tx.prepare(
          "INSERT INTO execution_handoff_states (run_id, handoff_id, status, last_event_seq, updated_at) "
          + "VALUES (?, ?, 'prepared', 1, '2026-01-01T00:00:00Z')",
        ).run(f.runId, handoffId);
        return { handoffId, handoffHash: derived.handoffHash };
      });
      expect(countExecutionRuns(ctx)).toBe(0);
      // Delivery completion fails closed with the deterministic invariant.
      expect(
        codeOf(() =>
          createHandoffService(ctx.store, ctx.clock).finalizeDelivery({
            runId: f.runId,
            sessionId: f.sessionId,
            toolUseId: "TU-T11",
            responseHandoffId: identity.handoffId,
            responseHandoffHash: identity.handoffHash,
          }),
        ),
      ).toBe("EXECUTION_HANDOFF_INVARIANT");
      expect(getPlanningRunRecord(ctx.store, f.runId)!.lifecycle).toBe("active");
      expect(countExecutionRuns(ctx)).toBe(0);
      // The documented recovery: retry the handoff (prepares the run
      // idempotently from the stored handoff), then finalize.
      const retried = callHandoff(ctx, f, { toolUseId: "TU-T11-RECOVER" });
      expect(retried.execution_run.lifecycle).toBe("prepared");
      const result = createHandoffService(ctx.store, ctx.clock).finalizeDelivery({
        runId: f.runId,
        sessionId: f.sessionId,
        toolUseId: "TU-T11-RECOVER",
        responseHandoffId: retried.handoff_id,
        responseHandoffHash: retried.handoff_hash,
      });
      expect(result.executionRun!.lifecycle).toBe("active");
      expect(getPlanningRunRecord(ctx.store, f.runId)!.lifecycle).toBe("completed");
    } finally {
      ctx.store.close();
    }
  });

  it("T12: resuming through a different WorkspaceIdentity fails closed", async () => {
    const { f, ctx } = await makeApprovedFinalPlanFixture();
    try {
      callHandoff(ctx, f, { toolUseId: "TU-T12-1" });
      expect(
        codeOf(() =>
          createExecutionRunService(ctx.store, ctx.clock).prepareExecutionRunForFinalPlan({
            runId: f.runId,
            workspaceId: "W-OTHER-WORKSPACE",
          }),
        ),
      ).toBe("WORKSPACE_MISMATCH");
      // Nothing changed for the correctly-bound run.
      expect(runRow(ctx, f).workspaceId).toBe(f.workspaceId);
      expect(countExecutionRuns(ctx)).toBe(1);
    } finally {
      ctx.store.close();
    }
  });

  it("T13: preparation from a non-approved or non-final plan fails", async () => {
    // validation stage: no FinalPlan approval exists yet.
    const early = await makeCleanValidationFixture("S-T13-EARLY");
    try {
      expect(
        codeOf(() =>
          createExecutionRunService(early.ctx.store, early.ctx.clock).prepareExecutionRunForFinalPlan({
            runId: early.f.runId,
            workspaceId: early.f.workspaceId,
          }),
        ),
      ).toBe("HANDOFF_NOT_AUTHORIZED");
    } finally {
      early.ctx.store.close();
    }
    // final stage with a frozen candidate and awaiting final Proposal, but
    // the FinalPlan is NOT approved/committed yet.
    const fin = await makeCleanValidationFixture("S-T13-FIN");
    try {
      callRequestFinalization(fin.ctx, fin.f, { toolUseId: "TU-T13-FIN" });
      expect(
        codeOf(() =>
          createExecutionRunService(fin.ctx.store, fin.ctx.clock).prepareExecutionRunForFinalPlan({
            runId: fin.f.runId,
            workspaceId: fin.f.workspaceId,
          }),
        ),
      ).toBe("HANDOFF_NOT_AUTHORIZED");
      expect(countExecutionRuns(fin.ctx)).toBe(0);
    } finally {
      fin.ctx.store.close();
    }
  });

  it("T14: ExecutionRun creation and activation never mutate approved Plan Memory", async () => {
    const { f, ctx } = await makeApprovedFinalPlanFixture();
    try {
      const snapshot = () =>
        ctx.store.withRead((tx) => ({
          revisions: tx.prepare("SELECT * FROM memory_revisions ORDER BY run_id, kind, artifact_id, revision").all(),
          commits: tx.prepare("SELECT * FROM plan_commits ORDER BY run_id, commit_id").all(),
          heads: tx.prepare("SELECT * FROM plan_heads ORDER BY run_id").all(),
          finalPlans: tx.prepare("SELECT * FROM final_plans ORDER BY run_id, final_plan_id").all(),
          proposals: tx.prepare("SELECT * FROM proposals ORDER BY run_id, proposal_id").all(),
          approvals: tx.prepare("SELECT * FROM approvals ORDER BY run_id, approval_id").all(),
        }));
      const before = snapshot();
      const prepared = callHandoff(ctx, f, { toolUseId: "TU-T14-1" });
      createHandoffService(ctx.store, ctx.clock).finalizeDelivery({
        runId: f.runId,
        sessionId: f.sessionId,
        toolUseId: "TU-T14-1",
        responseHandoffId: prepared.handoff_id,
        responseHandoffHash: prepared.handoff_hash,
      });
      expect(snapshot()).toEqual(before);
    } finally {
      ctx.store.close();
    }
  });
});
