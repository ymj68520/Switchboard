/**
 * E13-T36..T43 — the abort race matrix (§44–§48): claim/report/takeover/
 * replan/completion each serialize against the abort through the same
 * SQLite write transaction — whichever commits first wins, and the loser is
 * refused by a lifecycle gate. No duplicate workers, no resurrection, no
 * both-terminal outcomes.
 */
import { describe, expect, it } from "vitest";

import { executePhasePlanTool } from "../src/mcp/tools.js";
import { takeoverSupervisorBindingInTx } from "../src/store/supervisor-bindings.js";
import { completeExecutionRunByFinalCommitInTx } from "../src/store/execution-runs.js";
import { requestExecutionReplanInTx } from "../src/application/execution-replan-service.js";
import {
  makeAcceptanceWorld,
  codeOf,
  takeoverTo,
} from "./acceptance-helpers.js";
import { callWorkerTool } from "./execution-worker-helpers.js";
import { freshWorkerSession } from "./execution-worker-helpers.js";
import { issueDirective } from "./execution-protocol-helpers.js";
import { startWorkerAttemptAndPrepareLaunchInTx } from "../src/application/worker-runtime-service.js";
import { completeAllStagesFixture, beginFinalClosure, runFinalClosureCycle, runFinalCompletionFixture } from "./final-closure-helpers.js";
import { explicitExecutionAbort, lifecycleOf, bindingOf } from "./session-recovery-helpers.js";
import type { AcceptanceWorld } from "./acceptance-helpers.js";

function codeOfSync(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as { code?: string }).code ?? "no-error";
  }
  return "no-error";
}

function prepareLaunch(world: AcceptanceWorld, directiveId: string): { attemptId: string; launchToken: string } {
  const directive = issueDirective(world, { directiveId, kind: "implementation" });
  const { attempt, launch } = world.ctx.store.withWrite((tx) =>
    startWorkerAttemptAndPrepareLaunchInTx(
      tx,
      {
        executionRunId: world.executionRunId,
        sessionId: world.f.sessionId,
        workspaceId: world.f.workspaceId,
        generation: world.f.generation,
        directiveId: directive.directiveId,
        directiveRevision: directive.revision,
        directiveHash: directive.hash,
        workerRole: "executor",
      },
      world.ctx.clock,
      world.ctx.clock.nowIso(),
    ),
  );
  return { attemptId: attempt.attemptId, launchToken: launch.launchToken };
}

describe("E13 claim/report races (§47/§48)", () => {
  it("E13-T36: claim first → the claimed Worker is subsequently fenced by the abort", async () => {
    const world = await makeAcceptanceWorld("S1");
    const { attemptId, launchToken } = prepareLaunch(world, "DIR-E13-R36");
    const session = freshWorkerSession(world, "R36");
    callWorkerTool(world, session, "worker_claim", { attempt_id: attemptId, launch_token: launchToken });
    explicitExecutionAbort(world, { reason: "stop" });
    // The claimed worker's future authority is gone.
    expect(codeOfSync(() => callWorkerTool(world, session, "worker_get_assignment", {}))).toBe("INVALID_EXECUTION_LIFECYCLE");
    // No duplicate worker: the invocation stays claimed by the SAME session.
    const invocation = world.ctx.store.withRead(
      (tx) => tx.prepare("SELECT state, worker_session_id AS s FROM execution_worker_invocations WHERE attempt_id = ?").get(attemptId) as { state: string; s: string },
    );
    expect(invocation).toMatchObject({ state: "claimed", s: session.sessionId });
  });

  it("E13-T37: abort first → the prepared credential is invalid and the claim is rejected", async () => {
    const world = await makeAcceptanceWorld("S1");
    const { attemptId, launchToken } = prepareLaunch(world, "DIR-E13-R37");
    explicitExecutionAbort(world, { reason: "stop" });
    expect(
      codeOfSync(() =>
        callWorkerTool(world, freshWorkerSession(world, "R37"), "worker_claim", { attempt_id: attemptId, launch_token: launchToken }),
      ),
    ).toBe("WORKER_CLAIM_TOKEN_INVALID");
  });

  it("E13-T38: report first → durable; then abort preserves it (§30/§48)", async () => {
    const world = await makeAcceptanceWorld("S1");
    const { attemptId, launchToken } = prepareLaunch(world, "DIR-E13-R38");
    const session = freshWorkerSession(world, "R38");
    callWorkerTool(world, session, "worker_claim", { attempt_id: attemptId, launch_token: launchToken });
    const ack = callWorkerTool(world, session, "worker_submit_report", {
      result: "completed",
      candidate_mutated: true,
      files_changed: ["src/race.ts"],
      actions_performed: [],
      files_examined: [],
      commands_run: [],
      findings: [],
      deviations: [],
      blockers: [],
      deliverables: [],
    }) as { report_id: string };
    explicitExecutionAbort(world, { reason: "stop after report" });
    const report = world.ctx.store.withRead(
      (tx) => tx.prepare("SELECT report_id AS id FROM execution_reports WHERE report_id = ?").get(ack.report_id) as { id: string },
    );
    expect(report.id).toBe(ack.report_id);
    expect(lifecycleOf(world)).toBe("aborted");
  });
});

describe("E13 takeover race (§46)", () => {
  it("E13-T39: takeover first → the new owner is detached by the abort", async () => {
    const world = await makeAcceptanceWorld("S1");
    const generation = takeoverTo(world, "S2-NEW");
    expect(bindingOf(world)).toMatchObject({ state: "attached", generation, sessionId: "S2-NEW" });
    explicitExecutionAbort(world, { reason: "stop after takeover" });
    // The new owner detaches; the generation is PRESERVED (§34 — no bump).
    expect(bindingOf(world)).toMatchObject({ state: "detached", generation, sessionId: "S2-NEW" });
    expect(lifecycleOf(world)).toBe("aborted");
  });

  it("E13-T40: abort first → takeover fails terminal; no authority resurrection", async () => {
    const world = await makeAcceptanceWorld("S1");
    explicitExecutionAbort(world, { reason: "stop" });
    expect(
      codeOf(() =>
        world.ctx.store.withWrite((tx) =>
          takeoverSupervisorBindingInTx(
            tx,
            { executionRunId: world.executionRunId, workspaceId: world.f.workspaceId, newSessionId: "S3", expectedGeneration: 1 },
            world.ctx.clock.nowIso(),
          ),
        ),
      ),
    ).not.toBe("no-error");
    expect(bindingOf(world)).toMatchObject({ state: "detached", generation: 1, sessionId: "S1" });
  });
});

describe("E13 replan race (§44)", () => {
  it("E13-T41: replan first → the run is replan_required and the abort is rejected", async () => {
    const world = await makeAcceptanceWorld(`S1-${Math.random().toString(36).slice(2, 6)}`);
    // A real open ExecutionIssue via the supervisor surface, then the E9
    // replan service — the real terminal race serialization.
    const { getFinalPlanInTx } = await import("../src/store/finalization.js");
    const { parseFinalPlanCanonical } = await import("../src/application/handoff-service.js");
    const planRow = world.ctx.store.withRead((tx) => getFinalPlanInTx(tx, world.f.runId));
    if (planRow === null) throw new Error("no FinalPlan in race world");
    const plan = parseFinalPlanCanonical(planRow.canonicalJson, world.executionRunId);
    const section = plan.sections[0]!;
    const issueInput = {
      kind: "section_contract",
      summary: "cannot be implemented as approved",
      detail: "the approved contract requires an interface the platform does not expose.",
      affected_refs: [{ type: "section", id: section.sectionId, revision: section.revision }],
    };
    const { executionToken } = await import("./phase14-helpers.js");
    const token = executionToken(world.ctx, {
      sessionId: world.f.sessionId,
      workspaceId: world.f.workspaceId,
      runId: world.executionRunId,
      finalPlanId: world.f.finalPlanId,
      generation: world.f.generation,
      tool: "report_execution_issue",
      business: issueInput,
    });
    executePhasePlanTool(world.ctx, "report_execution_issue", { ...issueInput, _hostContext: token });
    world.ctx.store.withWrite((tx) =>
      requestExecutionReplanInTx(
        tx,
        {
          sessionId: world.f.sessionId,
          workspaceId: world.f.workspaceId,
          generation: world.f.generation,
          reason: "approved semantics cannot be implemented (race fixture)",
          affectedNormativeRefs: [{ type: "section", id: section.sectionId, revision: section.revision }],
          relevantReportRefs: [],
          toolUseId: "TU-E13-R41-REPLAN",
        },
        world.ctx.clock,
        world.ctx.clock.nowIso(),
      ),
    );
    expect(lifecycleOf(world)).toBe("replan_required");
    expect(codeOf(() => explicitExecutionAbort(world, { reason: "too late", toolUseId: "TU-E13-R41" }))).toBe("RUN_TERMINAL");
    expect(lifecycleOf(world)).toBe("replan_required");
  });

  it("E13-T42: abort first → the replan is rejected and NO ExecutionIssue transition happens", async () => {
    const world = await makeAcceptanceWorld(`S1-${Math.random().toString(36).slice(2, 6)}`);
    explicitExecutionAbort(world, { reason: "stop" });
    expect(
      codeOf(() =>
        world.ctx.store.withWrite((tx) =>
          requestExecutionReplanInTx(
            tx,
            {
              sessionId: world.f.sessionId,
              workspaceId: world.f.workspaceId,
              generation: world.f.generation,
              reason: "replan an aborted run (must fail)",
              affectedNormativeRefs: [],
              relevantReportRefs: [],
              toolUseId: "TU-E13-R42-REPLAN",
            },
            world.ctx.clock,
            world.ctx.clock.nowIso(),
          ),
        ),
      ),
    ).not.toBe("no-error");
    expect(lifecycleOf(world)).toBe("aborted");
    // No replan ExecutionIssue was created for the aborted run.
    const issues = world.ctx.store.withRead(
      (tx) => tx.prepare("SELECT count(*) AS n FROM execution_issues WHERE execution_run_id = ?").get(world.executionRunId) as { n: number },
    );
    expect(issues.n).toBe(0);
  });
});

describe("E13 completion race (§45)", () => {
  it("E13-T43: completion first → completed; the abort is rejected", async () => {
    const world = await makeAcceptanceWorld(`S1-${Math.random().toString(36).slice(2, 6)}`);
    // Drive the real E7/E10 chain: complete the only stage, begin + finish
    // final closure, then the completion gate fires inside the final accept.
    completeAllStagesFixture(world);
    beginFinalClosure(world);
    runFinalCompletionFixture(world);
    expect(lifecycleOf(world)).toBe("completed");
    expect(codeOf(() => explicitExecutionAbort(world, { reason: "too late", toolUseId: "TU-E13-R43" }))).toBe("RUN_TERMINAL");
    expect(lifecycleOf(world)).toBe("completed");
  });

  it("E13-T43b: abort first → the CompletionGate cannot commit; completion_commit_id stays NULL", async () => {
    const world = await makeAcceptanceWorld(`S1-${Math.random().toString(36).slice(2, 6)}`);
    completeAllStagesFixture(world);
    beginFinalClosure(world);
    // Run ONE final-closure cycle (a real final commit exists as head), then
    // abort BEFORE the completion gate consumes it.
    runFinalClosureCycle(world, { directiveId: "DIR-E13-FC3", kind: "implementation", candidateMutated: true });
    const head = world.ctx.store.withRead(
      (tx) => tx.prepare("SELECT accepted_head_commit_id AS h FROM execution_runs WHERE execution_run_id = ?").get(world.executionRunId) as { h: string | null },
    );
    explicitExecutionAbort(world, { reason: "stop before completion" });
    expect(
      codeOf(() =>
        world.ctx.store.withWrite((tx) =>
          completeExecutionRunByFinalCommitInTx(tx, { executionRunId: world.executionRunId, finalCommitId: head.h as string }, world.ctx.clock.nowIso()),
        ),
      ),
    ).toBe("EXECUTION_COMPLETION_GATE_FAILED");
    expect(lifecycleOf(world)).toBe("aborted");
    const completion = world.ctx.store.withRead(
      (tx) => tx.prepare("SELECT completion_commit_id AS c FROM execution_runs WHERE execution_run_id = ?").get(world.executionRunId) as { c: string | null },
    );
    expect(completion.c).toBeNull();
  });
});
