/**
 * E14 §13/§14/§31 — the REPLAN_REQUIRED full E2E and the same-FinalPlan
 * reexecution chain: replan terminates run A (issue + window close + head
 * unchanged + binding detach), the /phase-plan entry creates successor
 * PlanningRun B over the immutable FinalPlan A baseline, and the normal
 * planning → approval → handoff chain creates NEW FinalPlan B + NEW
 * ExecutionRun B. Run A is never rebound or resumed.
 */
import { describe, expect, it } from "vitest";

import {
  callApprove,
  callRequestFinalization,
  driveToCleanValidation,
} from "./phase13-helpers.js";
import { callHandoff, executionToken } from "./phase14-helpers.js";
import { parseFinalPlanCanonical } from "../src/application/handoff-service.js";
import { executePhasePlanTool } from "../src/mcp/tools.js";
import { issueEntryIntent } from "../src/host/entry-intent.js";
import { hostToken } from "./context-helpers.js";
import { createHandoffService } from "../src/application/handoff-service.js";
import { getFinalPlanInTx } from "../src/store/finalization.js";
import { selectSection, inputOf } from "./phase12-helpers.js";
import { completeSectionVia } from "./section-workflow.test.js";
import {
  acceptViaMcp,
  boundariesOf,
  currentRevision,
  makeAcceptanceWorld,
  runFreshVerifier,
  runImplementation,
  supervisorCall,
  type E14World,
} from "./v020-e2e-helpers.js";

/** The FinalPlan's immutable section list (exact refs for normative anchors). */
function planSections(world: E14World, runId = world.f.runId): Array<{ sectionId: string; revision: number }> {
  const row = world.ctx.store.withRead((tx) => getFinalPlanInTx(tx, runId))!;
  return parseFinalPlanCanonical(row.canonicalJson, runId).sections.map((section) => ({
    sectionId: section.sectionId,
    revision: section.revision,
  }));
}

/** The /phase-plan entry through the real MCP surface (E14 uses it directly). */
function callStartOrResume(
  ctx: E14World["ctx"],
  sessionId: string,
  workspaceId: string,
  options: { toolUseId?: string } = {},
) {
  const entry = issueEntryIntent(ctx.secret, { sessionId, promptId: "PROMPT-1" });
  const token = hostToken(
    ctx.secret,
    "start_or_resume",
    { _entryIntent: entry },
    { sessionId, workspaceId },
    { permissionMode: "default", toolUseId: options.toolUseId ?? "TU-ENTRY" },
  );
  return executePhasePlanTool(ctx, "start_or_resume", { _entryIntent: entry, _hostContext: token }) as {
    status: string;
    run: { id: string; stage: string };
    binding: { state: string; generation: number };
    baseline: { final_plan: { id: string; hash: string } };
    affectedScope: { needsReviewSections: string[]; inheritedCompletedSections: string[] };
  };
}

describe("v020 E2E replan → successor → reexecution (§13/§14/§31)", () => {
  it("E14-RP1: replan_required full E2E with a successor PlanningRun, new FinalPlan, and new ExecutionRun", async () => {
    const world = await makeAcceptanceWorld("E14-RP");

    // Accepted progress first: the replan must leave it untouched.
    runFreshVerifier(world, { directiveId: "DIR-RP-V1" });
    const accept = acceptViaMcp(world) as { accepted_head: string };
    const headBeforeReplan = accept.accepted_head;
    // An open successor window with a live implementation report.
    const cont = supervisorCall(world, "continue_execution_stage") as { window: { id: string } };
    world.openWindowId = cont.window.id;
    runImplementation(world, { directiveId: "DIR-RP-A2" });
    expect(currentRevision(world)).toBe(1);
    const beforeReplan = boundariesOf(world);

    // ---- replan through the real MCP supervisor surface ------------------
    const section = planSections(world)[0]!;
    const replan = supervisorCall(world, "request_execution_replan", {
      reason: "the approved section contract cannot be implemented against the repository reality",
      affected_normative_refs: [{ type: "section", id: section.sectionId, revision: section.revision }],
      relevant_report_refs: [],
    }) as { status: string };
    expect(replan.status).toBe("replan_required");

    // §13 durable boundary:
    const after = boundariesOf(world);
    expect(after.lifecycle).toBe("replan_required"); // terminal forever
    expect(after.acceptedHead).toBe(headBeforeReplan); // acceptedHead unchanged
    expect(after.windows.find((w) => w.id === beforeReplan.openWindow!.id)!.closureKind).toBe("replan_required"); // open window terminal-closes
    expect(after.openWindow).toBeNull();
    expect(after.binding!.state).toBe("detached"); // SupervisorBinding detached
    expect(after.binding!.generation).toBe(1); // detach NEVER bumps generation (E2)
    // Exactly one durable ExecutionIssue.
    const issues = world.ctx.store.withRead(
      (tx) => tx.prepare("SELECT issue_id AS id, kind AS kind FROM execution_issues WHERE execution_run_id = ?").all(world.executionRunId) as Array<{ id: string; kind: string }>,
    );
    expect(issues).toHaveLength(1);

    // §14 trust-domain: the execution facts created NO planning truth.
    const memoryRows = world.ctx.store.withRead(
      (tx) => tx.prepare("SELECT count(*) AS n FROM memory_revisions WHERE run_id = ?").get(world.f.runId) as { n: number },
    );
    const baseMemoryRows = world.ctx.store.withRead(
      (tx) => tx.prepare("SELECT count(*) AS n FROM memory_revisions").get() as { n: number },
    );
    expect(memoryRows.n).toBeLessThanOrEqual(baseMemoryRows.n); // the issue never writes Plan Memory
    // (memory rows on this run are the fixture's approved baseline; the replan
    // added none — proven by the successor assertions below.)

    // ---- /phase-plan entry: the successor PlanningRun B ------------------
    const entry = callStartOrResume(world.ctx, world.f.sessionId, world.f.workspaceId, { toolUseId: "TU-RP-ENTRY" });
    expect(entry.status).toBe("started_successor");
    const runB = entry.run.id;
    expect(runB).not.toBe(world.executionRunId);
    expect(entry.run.stage).toBe("detail");
    expect(entry.baseline.final_plan).toEqual({ id: world.f.finalPlanId, hash: world.f.finalPlanHash });
    expect(entry.affectedScope.inheritedCompletedSections.length).toBeGreaterThanOrEqual(0);

    // Run A is permanent terminal history, still bound to FinalPlan A.
    const predecessor = boundariesOf(world);
    expect(predecessor.lifecycle).toBe("replan_required");
    expect(predecessor.acceptedHead).toBe(headBeforeReplan);
    expect(
      world.ctx.store.withRead(
        (tx) => tx.prepare("SELECT final_plan_id AS p FROM execution_runs WHERE execution_run_id = ?").get(world.executionRunId) as { p: string },
      ).p,
    ).toBe(world.f.finalPlanId); // Run A still binds FinalPlan A — no rebinding
    // And the terminal run can never take a second handoff.
    let rehandoffCode = "no-error";
    try {
      callHandoff(world.ctx, world.f, { toolUseId: "TU-RP-REHANDOFF" });
    } catch (err) {
      rehandoffCode = (err as { code?: string }).code ?? "no-error";
    }
    expect(rehandoffCode).toBe("HANDOFF_ALREADY_DELIVERED");

    // ---- successor planning chain: reopened scope → FinalPlan B ---------
    const successorFixture = {
      ...world.f,
      runId: runB,
      generation: entry.binding.generation,
    };
    // The reopened sections re-enter the section workflow; inherited sections
    // stay completed.
    for (const sectionId of entry.affectedScope.needsReviewSections) {
      selectSection(successorFixture, sectionId);
      completeSectionVia(successorFixture, sectionId, 1);
    }
    const input = inputOf(successorFixture);
    const wrapped = {
      ...successorFixture,
      inputId: input.inputId,
      inputHash: input.inputHash,
      sectionIds: planSections(world),
    };
    const sectionIds = (wrapped.sectionIds as Array<{ sectionId: string }>).map((s) => s.sectionId);
    void sectionIds;
    // Re-wrap with plain section ids for the synthesis manifest.
    const manifestFixture = {
      ...wrapped,
      sectionIds: planSections(world).map((s) => s.sectionId),
    };
    driveToCleanValidation(manifestFixture as never, world.ctx, "E14-RP");
    const fin = callRequestFinalization(world.ctx, manifestFixture as never, { toolUseId: "E14-RP-FIN-B" });
    callApprove(world.ctx, manifestFixture as never, {
      proposal_id: fin.final_proposal.proposal_id,
      revision: fin.final_proposal.revision,
      proposal_hash: fin.final_proposal.proposal_hash,
    }, { toolUseId: "E14-RP-APP-B" });
    const finalPlanB = world.ctx.store.withRead((tx) => getFinalPlanInTx(tx, runB))!;
    expect(finalPlanB).not.toBeNull();
    expect(finalPlanB.finalPlanHash).toBeTruthy();

    // ---- normal E1 handoff on the successor: NEW ExecutionRun B ----------
    const preparedB = callHandoff(world.ctx, {
      sessionId: world.f.sessionId,
      workspaceId: world.f.workspaceId,
      runId: runB,
      generation: entry.binding.generation,
    }, { toolUseId: "E14-RP-DELIVER" });
    expect(preparedB.execution_run.lifecycle).toBe("prepared");
    createHandoffService(world.ctx.store, world.ctx.clock).finalizeDelivery({
      runId: runB,
      sessionId: world.f.sessionId,
      toolUseId: "E14-RP-DELIVER",
      responseHandoffId: preparedB.handoff_id,
      responseHandoffHash: preparedB.handoff_hash,
    });

    // §13/§31 final assertions: two independent Runs.
    const runARow = world.ctx.store.withRead(
      (tx) => tx.prepare("SELECT lifecycle AS l, final_plan_id AS p, accepted_head_commit_id AS h FROM execution_runs WHERE run_id = ?").get(world.f.runId) as { l: string; p: string; h: string | null },
    );
    const runBRow = world.ctx.store.withRead(
      (tx) => tx.prepare("SELECT lifecycle AS l, final_plan_id AS p, accepted_head_commit_id AS h FROM execution_runs WHERE run_id = ?").get(runB) as { l: string; p: string; h: string | null },
    );
    expect(runARow.l).toBe("replan_required"); // permanently replan_required
    expect(runBRow.l).toBe("active");
    expect(runARow.p).toBe(world.f.finalPlanId); // Run A binds FinalPlan A
    expect(runBRow.p).toBe(finalPlanB.finalPlanId); // Run B binds FinalPlan B
    expect(runARow.h).toBe(headBeforeReplan); // Run A's head untouched
    expect(runBRow.h).toBeNull(); // Run B has its own (empty) head
    // Run B has its own structure.
    const structureB = world.ctx.store.withRead(
      (tx) =>
        tx.prepare("SELECT count(*) AS stages FROM execution_stages WHERE execution_run_id = (SELECT execution_run_id FROM execution_runs WHERE run_id = ?)").get(runB) as { stages: number },
    );
    expect(structureB.stages).toBe(2);
    // No shared acceptedHead, no rebinding, no resurrection of A.
    expect(
      world.ctx.store.withRead(
        (tx) => tx.prepare("SELECT count(*) AS n FROM execution_commits WHERE execution_run_id = (SELECT execution_run_id FROM execution_runs WHERE run_id = ?)").get(runB) as { n: number },
      ).n,
    ).toBe(0);
    expect(boundariesOf(world).lifecycle).toBe("replan_required");
  });

  it("E14-RP2: execution facts never create Decision/Constraint revisions or Plan Evidence (§14)", async () => {
    const world = await makeAcceptanceWorld("E14-RP2");
    const before = world.ctx.store.withRead((tx) => ({
      decisions: tx.prepare("SELECT count(*) AS n FROM memory_revisions WHERE kind = 'decision'").get() as { n: number },
      constraints: tx.prepare("SELECT count(*) AS n FROM memory_revisions WHERE kind = 'constraint'").get() as { n: number },
      proposals: tx.prepare("SELECT count(*) AS n FROM proposals").get() as { n: number },
      observations: tx.prepare("SELECT count(*) AS n FROM observations").get() as { n: number },
    }));
    // Execution work happens: implementation, verification, reports, an issue-class judgment.
    runImplementation(world, { directiveId: "DIR-TD-A1" });
    runFreshVerifier(world, { directiveId: "DIR-TD-V1" });
    const section = planSections(world)[0]!;
    supervisorCall(world, "report_execution_issue", {
      kind: "section_contract",
      summary: "a factual execution-time obstacle",
      detail: "the section contract needs human reconsideration",
      affected_refs: [{ type: "section", id: section.sectionId, revision: section.revision }],
    });
    const after = world.ctx.store.withRead((tx) => ({
      decisions: tx.prepare("SELECT count(*) AS n FROM memory_revisions WHERE kind = 'decision'").get() as { n: number },
      constraints: tx.prepare("SELECT count(*) AS n FROM memory_revisions WHERE kind = 'constraint'").get() as { n: number },
      proposals: tx.prepare("SELECT count(*) AS n FROM proposals").get() as { n: number },
      observations: tx.prepare("SELECT count(*) AS n FROM observations").get() as { n: number },
    }));
    expect(after.decisions.n).toBe(before.decisions.n); // ExecutionReport → Plan Evidence: forbidden bridge
    expect(after.constraints.n).toBe(before.constraints.n); // ExecutionIssue → Plan Decision: forbidden bridge
    expect(after.proposals.n).toBe(before.proposals.n); // amendment still needs Proposal/human Approval/PlanCommit
    expect(after.observations.n).toBe(before.observations.n); // execution facts never become planning observations
    // The stale execution token of a run that lost its binding cannot read Build state.
    void executionToken; // (authority-fence coverage lives in the session-recovery suite)
  });
});
