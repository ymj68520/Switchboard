/**
 * E14 §5/§6/§7 — the ONE canonical happy-path E2E over the frozen v0.2.0
 * exit gate, driven entirely through real authority boundaries: the real
 * planning chain (MCP), the real E1 handoff (MCP prepare + the trusted
 * delivery finalizer), the real worker claim/report MCP surface with signed
 * worker tokens, the real supervisor assessment/progression MCP surface with
 * signed execution tokens, and the real domain transactions those handlers
 * run. Every durable boundary is asserted, not just final status.
 */
import { describe, expect, it } from "vitest";

import {
  callHandoff,
  makeApprovedFinalPlanFixture,
} from "./phase14-helpers.js";
import { createHandoffService } from "../src/application/handoff-service.js";
import {
  acceptViaMcp,
  boundariesOf,
  completeRunViaGate,
  completeStageViaGate,
  currentRevision,
  makeAcceptanceWorld,
  runFreshVerifier,
  runImplementation,
  supervisorCall,
} from "./v020-e2e-helpers.js";

describe("v020 E2E happy path (§5/§6/§7)", () => {
  it("E14-HP1: planning → handoff → 2 stages → batched implementation → verification → commits → final closure → completed", async () => {
    // ---- v0.1 planning lifecycle through the real MCP chain -------------
    const base = await makeApprovedFinalPlanFixture("E14-HP");
    const ctx = base.ctx;
    const f = base.f;

    // ---- handoff_pending boundary: FinalPlan approved, no ExecutionRun ---
    const beforeHandoff = ctx.store.withRead((tx) => ({
      planning: tx.prepare("SELECT lifecycle AS l FROM planning_runs WHERE run_id = ?").get(f.runId) as { l: string },
      executionRuns: tx.prepare("SELECT count(*) AS n FROM execution_runs").get() as { n: number },
      handoffs: tx.prepare("SELECT count(*) AS n FROM execution_handoffs WHERE run_id = ?").get(f.runId) as { n: number },
    }));
    // handoff_pending is the durable state: active PlanningRun + approved
    // FinalPlan + no delivery yet (§56 rows 1–4).
    expect(beforeHandoff.planning.l).toBe("active");
    expect(beforeHandoff.executionRuns.n).toBe(0);
    expect(beforeHandoff.handoffs.n).toBe(0);

    // ---- ExecutionRun created exactly once as prepared -------------------
    const prepared = callHandoff(ctx, f, { toolUseId: "E14-HP-DELIVER" });
    expect(prepared.execution_run.lifecycle).toBe("prepared");
    const afterPrepare = ctx.store.withRead((tx) => ({
      runs: tx.prepare("SELECT count(*) AS n FROM execution_runs WHERE run_id = ?").get(f.runId) as { n: number },
      planning: tx.prepare("SELECT lifecycle AS l FROM planning_runs WHERE run_id = ?").get(f.runId) as { l: string },
    }));
    expect(afterPrepare.runs.n).toBe(1); // exactly once
    expect(afterPrepare.planning.l).toBe("active"); // PlanningRun completes only AFTER durable activation

    // ---- activation: run active + planning completed in ONE tx ----------
    const delivery = createHandoffService(ctx.store, ctx.clock).finalizeDelivery({
      runId: f.runId,
      sessionId: f.sessionId,
      toolUseId: "E14-HP-DELIVER",
      responseHandoffId: prepared.handoff_id,
      responseHandoffHash: prepared.handoff_hash,
    });
    expect(delivery.executionRun).not.toBeNull();
    const world = {
      f,
      ctx,
      // A1 §16 — the canonical ExecutionRunID from the delivery result.
      executionRunId: delivery.executionRun!.executionRunId,
      activeStageId: "",
      openWindowId: "",
      implDirective: undefined as never,
      execSession: undefined as never,
      implReportId: "",
      verDirective: null,
      verSession: null,
      verReportId: null,
    };
    const b0 = boundariesOf(world);
    expect(b0.lifecycle).toBe("active");
    expect(b0.planningLifecycle).toBe("completed");
    // Genesis structure: TWO stages from the approved implementation order,
    // stage 1 active, one open genesis window at rev0.
    expect(b0.stages).toHaveLength(2);
    expect(b0.stages[0]!.status).toBe("active");
    expect(b0.stages[1]!.status).toBe("pending");
    expect(b0.windows).toHaveLength(1);
    expect(b0.windows[0]!.closureKind).toBeNull();
    expect(b0.windows[0]!.rev).toBe(0);
    expect(b0.activeStage).toBe(b0.stages[0]!.id);
    world.openWindowId = b0.windows[0]!.id;
    world.activeStageId = b0.stages[0]!.id;
    expect(b0.binding!.state).toBe("attached");
    expect(b0.binding!.generation).toBe(1);

    // ---- batched implementation in the SAME window (§7) ------------------
    const implA = runImplementation(world, { directiveId: "DIR-HP-A" });
    expect(implA.reportId).toBeTruthy();
    expect(currentRevision(world)).toBe(1);
    expect(boundariesOf(world).acceptedHead).toBeNull(); // a report NEVER advances the head
    expect(boundariesOf(world).openWindow!.id).toBe(world.openWindowId); // same window
    expect(boundariesOf(world).attempts.filter((a) => a.state === "running")).toHaveLength(0); // attempt finished with its report

    const implB = runImplementation(world, { directiveId: "DIR-HP-B" });
    expect(implB.directiveId).not.toBe(implA.directiveId);
    expect(currentRevision(world)).toBe(2);
    const b2 = boundariesOf(world);
    expect(b2.openWindow!.id).toBe(world.openWindowId); // still the SAME window (batching)
    expect(b2.windows).toHaveLength(1);
    expect(b2.acceptedHead).toBeNull();
    // No verifier inserted between A and B: both directives are implementation.
    expect(b2.directives).toHaveLength(2);

    // ---- fresh normal VerificationDirective at rev2 ----------------------
    const verifierA = runFreshVerifier(world, { directiveId: "DIR-HP-V1" });
    expect(verifierA.sessionId.startsWith("worker-session-V-")).toBe(true); // fresh worker session
    expect(currentRevision(world)).toBe(2); // non-mutating
    expect(boundariesOf(world).acceptedHead).toBeNull(); // a verification report NEVER advances the head

    // ---- SupervisorAssessment accept → EC-1, head advances, window closes
    const accept1 = acceptViaMcp(world) as { status: string; accepted_head: string; commit: { id: string } };
    expect(accept1.status).toBe("accepted");
    const ec1 = accept1.commit.id;
    const b3 = boundariesOf(world);
    expect(b3.acceptedHead).toBe(ec1);
    expect(b3.commits).toHaveLength(1);
    expect(b3.windows[0]!.closureKind).toBe("accepted");
    expect(b3.openWindow).toBeNull(); // no automatic successor window (E6 §33)

    // ---- same Stage continues through another Window / Commit ------------
    const cont = supervisorCall(world, "continue_execution_stage") as {
      status: string;
      window: { id: string; candidate_revision: number };
      accepted_head: string;
    };
    expect(cont.status).toBe("continued");
    const window2 = cont.window.id;
    expect(window2).not.toBe(world.openWindowId);
    expect(cont.accepted_head).toBe(ec1); // successor window base = exact acceptedHead
    world.openWindowId = window2;

    runImplementation(world, { directiveId: "DIR-HP-C" });
    expect(currentRevision(world)).toBe(1);
    runFreshVerifier(world, { directiveId: "DIR-HP-V2" });
    const accept2 = acceptViaMcp(world) as { commit: { id: string } };
    const ec2 = accept2.commit.id;
    expect(ec2).not.toBe(ec1);
    const b5 = boundariesOf(world);
    expect(b5.acceptedHead).toBe(ec2);
    expect(b5.stages[0]!.status).toBe("active"); // Stage completion never occurs before the accepted Stage-completion obligation
    expect(b5.stages[0]!.completedBy).toBeNull();

    // ---- Stage-completing verification + Commit (in a successor window) --
    const cont2 = supervisorCall(world, "continue_execution_stage") as { status: string; window: { id: string } };
    expect(cont2.status).toBe("continued");
    world.openWindowId = cont2.window.id;
    const stage1 = completeStageViaGate(world);
    expect(stage1.stageId).toBe(b0.stages[0]!.id);
    const ec3 = stage1.commitId;
    const b6 = boundariesOf(world);
    expect(b6.acceptedHead).toBe(ec3);
    expect(b6.stages[0]!.status).toBe("completed");
    expect(b6.stages[0]!.completedBy).toBe(ec3);
    expect(b6.openWindow).toBeNull();
    expect(b6.lifecycle).toBe("active"); // stage completion alone never completes the run

    // ---- next eligible Stage activation (dependency-gated) ---------------
    const activation = supervisorCall(world, "activate_execution_stage", {
      target_stage_id: b0.stages[1]!.id,
    }) as { status: string; stage: { id: string }; window: { id: string; candidate_revision: number }; accepted_head: string };
    expect(activation.status).toBe("activated");
    expect(activation.stage.id).toBe(b0.stages[1]!.id);
    expect(activation.accepted_head).toBe(ec3); // acceptedHead never moves on activation
    world.activeStageId = b0.stages[1]!.id;
    world.openWindowId = activation.window.id;

    runImplementation(world, { directiveId: "DIR-HP-D" });
    runFreshVerifier(world, { directiveId: "DIR-HP-V3" });
    const accept3 = acceptViaMcp(world) as { commit: { id: string } };
    const ec4 = accept3.commit.id;
    void ec4;
    const cont4 = supervisorCall(world, "continue_execution_stage") as { status: string; window: { id: string } };
    expect(cont4.status).toBe("continued");
    world.openWindowId = cont4.window.id;
    const stage2 = completeStageViaGate(world);
    const ec5 = stage2.commitId;
    const b8 = boundariesOf(world);
    expect(b8.stages.map((s) => s.status)).toEqual(["completed", "completed"]);
    expect(b8.openWindow).toBeNull();
    expect(b8.lifecycle).toBe("active"); // all Stages completed ≠ run completed (E10 explicit gate)
    expect(b8.acceptedHead).toBe(ec5);

    // ---- explicit begin_final_closure + Final Closure Window -------------
    const begin = supervisorCall(world, "begin_execution_final_closure") as {
      status: string;
      window: { id: string; candidate_revision: number };
    };
    expect(begin.status).toBe("final_closure_open");
    world.openWindowId = begin.window.id;
    const b9 = boundariesOf(world);
    expect(b9.openWindow!.scopeKind).toBe("final_closure");
    expect(b9.openWindow!.candidateRevision).toBe(0);

    // ---- fresh final verifier + final SupervisorAssessment accept --------
    const finalGate = completeRunViaGate(world);
    const ec6 = finalGate.commitId;
    const b10 = boundariesOf(world);
    expect(b10.lifecycle).toBe("completed");
    expect(b10.acceptedHead).toBe(ec6);
    expect(b10.completionCommitId).toBe(ec6); // completed run: head == completion provenance == final commit
    expect(ec6).not.toBe(ec5); // Final Commit distinct from the last Stage Commit
    expect(b10.commits.filter((c) => c.commitId === ec6)[0]!.windowScope).toBe("final_closure");
    expect(b10.binding!.state).toBe("detached"); // SupervisorBinding detached after completion
    expect(b10.openWindow).toBeNull();
    expect(b10.stages.every((s) => s.status === "completed")).toBe(true);
    // Durable sequence sanity: 6 commits, 6 windows, 10 directives.
    expect(b10.commits).toHaveLength(6);
    expect(b10.windows).toHaveLength(6);
    expect(b10.directives).toHaveLength(10);

    // ---- the completed Run can never resume ------------------------------
    let lateCode = "no-error";
    try {
      acceptViaMcp(world, { rationale: "post-completion probe", expectedCandidateRevision: 0 });
    } catch (err) {
      lateCode = (err as { code?: string }).code ?? "no-error";
    }
    expect(lateCode).not.toBe("no-error"); // rejected — no writable authority on a terminal run
    expect(boundariesOf(world).lifecycle).toBe("completed");
    expect(boundariesOf(world).acceptedHead).toBe(ec6); // still exactly the final commit
  });

  it("E14-HP2: the acceptedHead moves ONLY at ExecutionCommit boundaries (§6)", async () => {
    const world = await makeAcceptanceWorld("E14-HP2");
    // Baseline: the fixture's implementation report is durable, head still null.
    expect(boundariesOf(world).reportCount).toBe(1);
    expect(boundariesOf(world).acceptedHead).toBeNull();
    // A non-accept assessment persists judgment ONLY — head unchanged.
    runFreshVerifier(world, { directiveId: "DIR-HP2-V1" });
    const rework = acceptViaMcp(world, {
      disposition: "rework",
      rationale: "implementation defect found by the verifier",
    }) as { status: string };
    expect(rework.status).toBe("recorded");
    expect(boundariesOf(world).acceptedHead).toBeNull();
    // A second mutating report also leaves the head untouched.
    runImplementation(world, { directiveId: "DIR-HP2-A2" });
    expect(boundariesOf(world).acceptedHead).toBeNull();
    // Only the accept → ExecutionCommit advances it.
    runFreshVerifier(world, { directiveId: "DIR-HP2-V2" });
    const accept = acceptViaMcp(world) as { accepted_head: string };
    expect(boundariesOf(world).acceptedHead).toBe(accept.accepted_head);
  });
});
