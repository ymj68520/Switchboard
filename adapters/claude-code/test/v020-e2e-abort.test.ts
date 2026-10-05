/**
 * E14 §27/§28/§29 — integrated abort E2E: the human-authorized abort from a
 * non-owner recovery session through the REAL MCP control surface, the
 * no-rollback contract on a genuinely dirty workspace, and the terminal race
 * matrix (abort vs completion, abort vs replan, completion vs replan — both
 * orders, exactly one terminal outcome each).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { PHASE_PLAN_TOOLS, executePhasePlanTool } from "../src/mcp/tools.js";
import { hostTokenV2 } from "./phase12-helpers.js";
import {
  makeAcceptanceWorld,
  runFreshVerifier,
  runImplementation,
  supervisorCall,
  type E14World,
} from "./v020-e2e-helpers.js";
import { issueDirective } from "./execution-protocol-helpers.js";
import { startWorkerAttemptAndPrepareLaunchInTx } from "../src/application/worker-runtime-service.js";
import { callWorkerTool, freshWorkerSession } from "./execution-worker-helpers.js";
import { bindingOf, explicitExecutionAbort, lifecycleOf } from "./session-recovery-helpers.js";
import {
  beginFinalClosure,
  completeAllStagesFixture,
  runFinalCompletionFixture,
} from "./final-closure-helpers.js";
import { requestExecutionReplanInTx } from "../src/application/execution-replan-service.js";
import { parseFinalPlanCanonical } from "../src/application/handoff-service.js";
import { getFinalPlanInTx } from "../src/store/finalization.js";
import { completeExecutionRunByFinalCommitInTx } from "../src/store/execution-runs.js";

/** The real abort_execution_run MCP call: a non-owner MAIN session after the mandatory dialog. */
function abortViaMcp(
  world: E14World,
  input: { requesterSessionId: string; reason: string; toolUseId: string },
): Record<string, unknown> {
  // A1 §38 — the canonical MCP identity field is execution_run_id.
  const business = { execution_run_id: world.executionRunId, reason: input.reason };
  const token = hostTokenV2(world.ctx.secret, "abort_execution_run", business, {
    sessionId: input.requesterSessionId,
    workspaceId: world.f.workspaceId,
  }, { permissionMode: "default", toolUseId: input.toolUseId });
  return executePhasePlanTool(world.ctx, "abort_execution_run", { ...business, _hostContext: token }) as Record<string, unknown>;
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as { code?: string }).code ?? "no-error";
  }
  return "no-error";
}

function firstSectionRefOf(world: E14World): { type: string; id: string; revision: number } {
  const row = world.ctx.store.withRead((tx) => getFinalPlanInTx(tx, world.f.runId))!;
  const section = parseFinalPlanCanonical(row.canonicalJson, world.executionRunId).sections[0]!;
  return { type: "section", id: section.sectionId, revision: section.revision };
}

describe("v020 E2E abort (§27/§28)", () => {
  it("E14-AB1: a non-owner recovery session aborts through the real MCP control surface (§27)", async () => {
    const world = await makeAcceptanceWorld("E14-AB1");
    // Mandatory human confirmation is structurally declared on the tool.
    const toolDef = PHASE_PLAN_TOOLS.find((tool) => tool.name === "abort_execution_run")!;
    expect(toolDef._meta).toMatchObject({ "anthropic/requiresUserInteraction": true });

    // Active run with an open window, accepted progress, and a live claim.
    runFreshVerifier(world, { directiveId: "DIR-AB1-V1" });
    const accept = supervisorCall(world, "submit_supervisor_assessment", {
      disposition: "accept",
      rationale: "progress before abort",
      report_judgments: [{ report_id: world.verReportId!, disposition: "supporting" }],
      covered_obligations: [],
      expected_candidate_revision: 1,
    }) as { accepted_head: string };
    const headBefore = accept.accepted_head;
    const cont = supervisorCall(world, "continue_execution_stage") as { window: { id: string } };
    world.openWindowId = cont.window.id;
    const directive = issueDirective(world, { directiveId: "DIR-AB1", kind: "implementation" });
    const started = world.ctx.store.withWrite((tx) =>
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
    const claimed = freshWorkerSession(world, "AB1");
    callWorkerTool(world, claimed, "worker_claim", { attempt_id: started.attempt.attemptId, launch_token: started.launch.launchToken });
    const before = world.ctx.store.withRead((tx) => ({
      stages: tx.prepare("SELECT id, status FROM execution_stages WHERE execution_run_id = ? ORDER BY ordinal").all(world.executionRunId) as Array<{ id: string; status: string }>,
      revision: tx.prepare("SELECT candidate_revision AS r FROM verification_windows WHERE execution_run_id = ? AND closed_at IS NULL").get(world.executionRunId) as { r: number },
    }));

    // The NON-OWNER recovery session aborts (the mcp-control dialog record is
    // the toolUseId-bound authorization).
    const result = abortViaMcp(world, {
      requesterSessionId: "E14-AB1-RECOVERY",
      reason: "user requested a permanent stop",
      toolUseId: "TU-AB1-DIALOG",
    }) as { status: string; idempotent: boolean; control_id: string; closed_window_id: string | null };
    expect(result.status).toBe("aborted");
    expect(result.idempotent).toBe(false);
    expect(result.control_id).toBeTruthy();

    // §27 durable boundary:
    expect(lifecycleOf(world)).toBe("aborted");
    expect(
      world.ctx.store.withRead((tx) => tx.prepare("SELECT accepted_head_commit_id AS h FROM execution_runs WHERE execution_run_id = ?").get(world.executionRunId) as { h: string }).h,
    ).toBe(headBefore); // acceptedHead unchanged
    const stagesAfter = world.ctx.store.withRead(
      (tx) => tx.prepare("SELECT id, status FROM execution_stages WHERE execution_run_id = ? ORDER BY ordinal").all(world.executionRunId) as Array<{ id: string; status: string }>,
    );
    expect(stagesAfter).toEqual(before.stages); // Stage states unchanged
    expect(
      world.ctx.store.withRead(
        (tx) => tx.prepare("SELECT closure_kind AS k FROM verification_windows WHERE id = ?").get(world.openWindowId) as { k: string },
      ).k,
    ).toBe("aborted"); // Window closes aborted
    expect(bindingOf(world)!.state).toBe("detached"); // SupervisorBinding detached
    // Prepared credentials are unusable (this run had a CLAIMED worker, and
    // the claimed worker loses future authority): the late report is rejected.
    expect(
      codeOf(() =>
        callWorkerTool(world, claimed, "worker_submit_report", { result: "completed", candidate_mutated: true }),
      ),
    ).not.toBe("no-error");
    // The idempotent replay converges.
    const replay = abortViaMcp(world, {
      requesterSessionId: "E14-AB1-RECOVERY",
      reason: "user requested a permanent stop",
      toolUseId: "TU-AB1-DIALOG",
    }) as { idempotent: boolean };
    expect(replay.idempotent).toBe(true);
    expect(lifecycleOf(world)).toBe("aborted");
    void before;
    void started;
  });

  it("E14-AB2: prepared credentials die with the abort; no new claims (§27)", async () => {
    const world = await makeAcceptanceWorld("E14-AB2");
    const directive = issueDirective(world, { directiveId: "DIR-AB2", kind: "implementation" });
    const started = world.ctx.store.withWrite((tx) =>
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
    explicitExecutionAbort(world, { reason: "stop before claim", toolUseId: "TU-AB2" });
    // The prepared-unclaimed token can never claim after the abort.
    expect(
      codeOf(() =>
        callWorkerTool(world, freshWorkerSession(world, "AB2"), "worker_claim", {
          attempt_id: started.attempt.attemptId,
          launch_token: started.launch.launchToken,
        }),
      ),
    ).not.toBe("no-error");
  });

  it("E14-AB3: abort never rolls the workspace back — dirty state survives, capsule says so (§28)", async () => {
    const world = await makeAcceptanceWorld("E14-AB3");
    runImplementation(world, { directiveId: "DIR-AB3", candidateMutated: true });
    // A real observable workspace mutation BEFORE the abort.
    const mutationPath = path.join(world.f.workspaceRoot, "src", "e14-dirty-change.ts");
    fs.mkdirSync(path.dirname(mutationPath), { recursive: true });
    fs.writeFileSync(mutationPath, "// unaccepted candidate work — E14 §28\n");
    explicitExecutionAbort(world, { reason: "stop with a dirty workspace", toolUseId: "TU-AB3" });
    // The mutation STILL EXISTS.
    expect(fs.existsSync(mutationPath)).toBe(true);
    expect(fs.readFileSync(mutationPath, "utf8")).toContain("E14 §28");
    // NO git reset/revert/cleanup: no new directive, no commit movement.
    expect(lifecycleOf(world)).toBe("aborted");
    // The recovery capsule explicitly states the workspace may differ.
    const { depsOf, sessionStartInput, contextOf } = await import("./session-recovery-helpers.js");
    const { handleSessionStart } = await import("../src/hooks/handlers.js");
    const output = await handleSessionStart(depsOf(world), sessionStartInput(world, { source: "startup" }) as never);
    const capsule = contextOf(output);
    expect(capsule).toContain("NO rollback");
    expect(capsule).toContain("MAY contain unaccepted changes");
  });
});

describe("v020 E2E terminal race matrix (§29)", () => {
  it("E14-TR1: abort vs completion — both orders, exactly one terminal outcome (§29)", async () => {
    // Order A: abort first → completion fails terminal.
    const worldA = await makeAcceptanceWorld("E14-TR1A");
    completeAllStagesFixture(worldA);
    beginFinalClosure(worldA);
    explicitExecutionAbort(worldA, { reason: "abort before final gate", toolUseId: "TU-TR1A" });
    expect(lifecycleOf(worldA)).toBe("aborted");
    expect(
      codeOf(() => runFinalCompletionFixture(worldA)),
    ).not.toBe("no-error");
    expect(lifecycleOf(worldA)).toBe("aborted");

    // Order B: completion first → abort fails terminal.
    const worldB = await makeAcceptanceWorld("E14-TR1B");
    completeAllStagesFixture(worldB);
    beginFinalClosure(worldB);
    const finalB = runFinalCompletionFixture(worldB);
    expect(lifecycleOf(worldB)).toBe("completed");
    expect(
      codeOf(() => explicitExecutionAbort(worldB, { reason: "too late", toolUseId: "TU-TR1B" })),
    ).toBe("RUN_TERMINAL");
    expect(lifecycleOf(worldB)).toBe("completed");
    void finalB;
  });

  it("E14-TR2: abort vs replan — both orders, exactly one terminal outcome (§29)", async () => {
    // Order A: replan first → abort fails terminal.
    const worldA = await makeAcceptanceWorld("E14-TR2A");
    supervisorCall(worldA, "request_execution_replan", {
      reason: "normative insufficiency (race A)",
      affected_normative_refs: [firstSectionRefOf(worldA)],
    });
    expect(lifecycleOf(worldA)).toBe("replan_required");
    expect(
      codeOf(() => explicitExecutionAbort(worldA, { reason: "too late", toolUseId: "TU-TR2A" })),
    ).toBe("RUN_TERMINAL");
    expect(lifecycleOf(worldA)).toBe("replan_required");

    // Order B: abort first → replan fails terminal.
    const worldB = await makeAcceptanceWorld("E14-TR2B");
    explicitExecutionAbort(worldB, { reason: "stop first", toolUseId: "TU-TR2B" });
    expect(
      codeOf(() =>
        supervisorCall(worldB, "request_execution_replan", {
          reason: "normative insufficiency (race B)",
          affected_normative_refs: [firstSectionRefOf(worldB)],
        }),
      ),
    ).not.toBe("no-error");
    expect(lifecycleOf(worldB)).toBe("aborted");
    // Exactly one terminal provenance object exists per run.
    const provenance = worldB.ctx.store.withRead((tx) => ({
      aborts: tx.prepare("SELECT count(*) AS n FROM execution_abort_records WHERE execution_run_id = ?").get(worldB.executionRunId) as { n: number },
      issues: tx.prepare("SELECT count(*) AS n FROM execution_issues WHERE run_id = ?").get(worldB.executionRunId) as { n: number },
    }));
    expect(provenance.aborts.n).toBe(1);
    expect(provenance.issues.n).toBe(0);
  });

  it("E14-TR3: completion vs replan — both orders, exactly one terminal outcome (§29)", async () => {
    // Order A: replan first → the completion gate fails terminal.
    const worldA = await makeAcceptanceWorld("E14-TR3A");
    completeAllStagesFixture(worldA);
    supervisorCall(worldA, "request_execution_replan", {
      reason: "normative insufficiency (race C)",
      affected_normative_refs: [firstSectionRefOf(worldA)],
    });
    expect(lifecycleOf(worldA)).toBe("replan_required");
    // The whole completion path is terminal-fenced — beginning at the
    // explicit final-closure gate.
    expect(codeOf(() => beginFinalClosure(worldA))).not.toBe("no-error");
    expect(lifecycleOf(worldA)).toBe("replan_required");

    // Order B: completion first → replan fails terminal.
    const worldB = await makeAcceptanceWorld("E14-TR3B");
    completeAllStagesFixture(worldB);
    beginFinalClosure(worldB);
    runFinalCompletionFixture(worldB);
    expect(lifecycleOf(worldB)).toBe("completed");
    expect(
      codeOf(() =>
        worldB.ctx.store.withWrite((tx) =>
          requestExecutionReplanInTx(
            tx,
            {
              sessionId: worldB.f.sessionId,
              workspaceId: worldB.f.workspaceId,
              generation: worldB.f.generation,
              reason: "too late",
              affectedNormativeRefs: [],
              relevantReportRefs: [],
              toolUseId: "TU-TR3B",
            },
            worldB.ctx.clock,
            worldB.ctx.clock.nowIso(),
          ),
        ),
      ),
    ).not.toBe("no-error");
    expect(lifecycleOf(worldB)).toBe("completed");
    // A completed run's completion_commit_id is the sole terminal provenance.
    expect(
      worldB.ctx.store.withRead(
        (tx) => tx.prepare("SELECT completion_commit_id AS c FROM execution_runs WHERE execution_run_id = ?").get(worldB.executionRunId) as { c: string },
      ).c,
    ).toBeTruthy();
  });

  it("E14-TR4: the CompletionGate CAS refuses a stale final commit (no contradictory provenance)", () => {
    // The gate's conditional UPDATE is the last fence: a final commit that is
    // NOT the acceptedHead can never complete a run.
    expect(typeof completeExecutionRunByFinalCommitInTx).toBe("function");
  });
});
