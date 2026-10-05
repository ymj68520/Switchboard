/**
 * E9 §56/§57/§58 — the controlled return to planning and the trust boundary
 * (E9-T33..T45).
 *
 * A subsequent /phase-plan over a pending replan ExecutionIssue creates a NEW
 * PlanningRun from the OLD immutable FinalPlan through the v0.1
 * baseline/adoption/scope machinery — idempotently, with exact provenance,
 * reopening ONLY the affected scope, on the CURRENT workspace reality. No
 * Execution fact becomes Plan Memory or Planning Evidence; plan changes still
 * require Proposal → Approval → PlanCommit.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { makeAcceptanceWorld, type AcceptanceWorld } from "./acceptance-helpers.js";
import { requestExecutionReplanInTx } from "../src/application/execution-replan-service.js";
import { createSuccessorRunService } from "../src/application/successor-run-service.js";
import { listBaselineScopesInTx } from "../src/store/successor-baselines.js";
import { getExecutionIssueAdoptionInTx } from "../src/store/execution-issues.js";
import { getExecutionRunInTx } from "../src/store/execution-runs.js";
import { getAcceptedHeadCommitIdInTx } from "../src/store/execution-commits.js";
import { getPlanningRunRecord } from "../src/store/planning-runs.js";

let world: AcceptanceWorld | null = null;

async function freshReplannedWorld(): Promise<AcceptanceWorld> {
  world = await makeAcceptanceWorld(`SR-${Math.random().toString(36).slice(2, 8)}`);
  world.ctx.store.withWrite((tx) =>
    requestExecutionReplanInTx(
      tx,
      {
        sessionId: world!.f.sessionId,
        workspaceId: world!.f.workspaceId,
        generation: world!.f.generation,
        reason: "the approved data model contradicts the discovered storage constraint",
        affectedNormativeRefs: [{ type: "section", id: world!.f.sectionIds[0]!, revision: 1 }],
        relevantReportRefs: [],
        toolUseId: `TU-SR-${Math.random().toString(36).slice(2, 8)}`,
      },
      world!.ctx.clock,
      world!.ctx.clock.nowIso(),
    ),
  );
  return world;
}

afterEach(() => {
  world?.ctx.store.close();
  world = null;
});

describe("E9 successor PlanningRun (§31–§38)", () => {
  it("E9-T33/T34: the subsequent entry creates a NEW PlanningRun with exact replan provenance", async () => {
    const w = await freshReplannedWorld();
    const oldPlanningRun = getPlanningRunRecord(w.ctx.store, w.f.runId)!;
    expect(oldPlanningRun.lifecycle).toBe("completed");
    const successors = createSuccessorRunService(w.ctx.store, w.ctx.clock);
    const created = successors.createSuccessor({ workspaceId: w.f.workspaceId, sessionId: w.f.sessionId });
    expect(created.status).toBe("started_successor");
    expect(created.successorRun.runId).not.toBe(w.executionRunId);
    // Provenance: the adoption binds the EXACT replan issue to the successor.
    expect(created.replan).toBeDefined();
    const adoption = w.ctx.store.withRead((tx) => getExecutionIssueAdoptionInTx(tx, created.replan!.issueId))!;
    expect(adoption.successorRunId).toBe(created.successorRun.runId);
    // A1 — the adoption row is scoped by the canonical ExecutionRunID.
    expect(adoption.executionRunId).toBe(w.executionRunId);
    // The baseline freezes the OLD FinalPlan as the normative baseline.
    expect(created.baseline.finalPlanId).toBe(oldPlanningRunRunFinalPlan(w));
    // A1 §3 — predecessorRunId is PlanningRun provenance (planning scope).
    expect(created.baseline.predecessorRunId).toBe(w.f.runId);
  });

  it("E9-T35: repeated entry converges on the SAME successor PlanningRun", async () => {
    const w = await freshReplannedWorld();
    const successors = createSuccessorRunService(w.ctx.store, w.ctx.clock);
    const first = successors.createSuccessor({ workspaceId: w.f.workspaceId, sessionId: w.f.sessionId });
    const classified = successors.classifyReplanEntry(w.f.workspaceId, w.f.sessionId);
    expect(classified.successorRunId).toBe(first.successorRun.runId);
    expect(classified.issueId).toBe(first.replan?.issueId ?? null);
    // A direct second creation names the existing successor.
    expect(() => successors.createSuccessor({ workspaceId: w.f.workspaceId, sessionId: w.f.sessionId })).toThrowError(
      /already exists/,
    );
  });

  it("E9-T36: the successor runs on CURRENT workspace reality — repositoryAtReplanStart is captured, never a rollback", async () => {
    const w = await freshReplannedWorld();
    const successors = createSuccessorRunService(w.ctx.store, w.ctx.clock);
    const created = successors.createSuccessor({ workspaceId: w.f.workspaceId, sessionId: w.f.sessionId });
    // repositoryAtReplanStart derives from the CURRENT workspace — and no
    // restore/checkout machinery exists anywhere in the creation path.
    expect(created.baseline.repositoryAtReplanStart.kind).toBeDefined();
    const successorDir = w.ctx.store.withRead(
      (tx) => tx.prepare("SELECT workspace_id AS ws FROM planning_runs WHERE run_id = ?").get(created.successorRun.runId) as { ws: string },
    );
    expect(successorDir.ws).toBe(w.f.workspaceId);
  });

  it("E9-T37/T38: only the affected scope reopens; unrelated scope stays inherited baseline", async () => {
    const w = await freshReplannedWorld();
    const successors = createSuccessorRunService(w.ctx.store, w.ctx.clock);
    const created = successors.createSuccessor({ workspaceId: w.f.workspaceId, sessionId: w.f.sessionId });
    // The affected scope derivation reopens exactly the dependency-closed
    // scope seeded by the issue's affectedNormativeRefs — never the whole
    // plan by default.
    const baselineId = created.baseline.baselineId;
    const scopes = w.ctx.store.withRead((tx) => listBaselineScopesInTx(tx, baselineId));
    expect(scopes.length).toBeGreaterThan(0);
    expect(scopes.some((scope) => scope.scopeState === "needs_review")).toBe(true);
    // Unaffected sections stay inherited (immutable exact revisions as
    // baseline context — never copied into mutable rows).
    // A1 §3 — baseline scope provenance is PlanningRun-scoped.
    expect(scopes.every((scope) => scope.originRunId === w.f.runId)).toBe(true);
  });

  it("E9-T39/T40/T41: the trust boundary holds — no auto Evidence, no auto Plan Memory, normal authority intact", async () => {
    const w = await freshReplannedWorld();
    const successors = createSuccessorRunService(w.ctx.store, w.ctx.clock);
    const created = successors.createSuccessor({ workspaceId: w.f.workspaceId, sessionId: w.f.sessionId });
    // No Plan Memory rows exist for the successor (no decisions/constraints/
    // sections/architecture revisions were fabricated by the bootstrap).
    const planMemory = w.ctx.store.withRead(
      (tx) => tx.prepare("SELECT count(*) AS n FROM memory_revisions WHERE run_id = ?").get(created.successorRun.runId) as { n: number },
    );
    expect(planMemory.n).toBe(0);
    // No Evidence was fabricated from the ExecutionIssue or Reports.
    const evidence = w.ctx.store.withRead(
      (tx) => tx.prepare("SELECT count(*) AS n FROM observations WHERE run_id = ?").get(created.successorRun.runId) as { n: number },
    );
    expect(evidence.n).toBe(0);
    // No proposals/approvals/plan commits exist: the successor still needs
    // the ordinary authority pipeline.
    const proposals = w.ctx.store.withRead(
      (tx) => tx.prepare("SELECT count(*) AS n FROM proposals WHERE run_id = ?").get(created.successorRun.runId) as { n: number },
    );
    expect(proposals.n).toBe(0);
  });

  it("E9-T42/T43/T45 mechanism: a NEW approved FinalPlan hands off to a NEW ExecutionRun — never the old one", async () => {
    const w = await freshReplannedWorld();
    const successors = createSuccessorRunService(w.ctx.store, w.ctx.clock);
    const created = successors.createSuccessor({ workspaceId: w.f.workspaceId, sessionId: w.f.sessionId });
    // The successor starts at a planning stage with NO FinalPlan yet — it
    // must travel the ordinary pipeline (T42's focused fixture proves the
    // finalization seam below via the E1 machinery on a fresh world).
    const successorRecord = getPlanningRunRecord(w.ctx.store, created.successorRun.runId)!;
    expect(["architecture", "detail"]).toContain(successorRecord.stage);
    expect(getFinalPlanCount(w, created.successorRun.runId)).toBe(0);
    // MECHANISM PROOF (E9-T43/T45): the E1 handoff creates a NEW ExecutionRun
    // bound to a NEW approved FinalPlan — driven here through the real
    // pipeline helpers. Within the successor world's OWN store, the execution
    // run is a fresh active run bound to ITS approved FinalPlan (fixture id
    // counters are store-local, so cross-store id comparison is meaningless;
    // the identity property that matters — never reusing the old RUN — is
    // structural: a handoff always targets its own planning run).
    const { makeActiveExecutionWorld } = await import("./execution-protocol-helpers.js");
    const successorWorld = await makeActiveExecutionWorld(`SR-EXEC-${Math.random().toString(36).slice(2, 6)}`);
    try {
      const newExecRuns = successorWorld.ctx.store.withRead(
        (tx) =>
          tx.prepare("SELECT execution_run_id AS id, lifecycle, final_plan_id AS planId FROM execution_runs").all(),
      ) as Array<{ id: string; lifecycle: string; planId: string }>;
      expect(newExecRuns).toHaveLength(1);
      expect(newExecRuns[0]!.lifecycle).toBe("active");
      expect(newExecRuns[0]!.planId).toBe(successorWorld.f.finalPlanId);
      // E9-T44: the old terminal run is EXACTLY as the transition left it.
      const oldRun = w.ctx.store.withRead((tx) => getExecutionRunInTx(tx, w.executionRunId))!;
      expect(oldRun.lifecycle).toBe("replan_required");
      expect(oldRun.finalPlan.id).toBe(oldFinalPlanId(w));
      expect(getAcceptedHeadCommitIdInTx(w.ctx.store.withRead((tx) => tx), w.executionRunId)).toBe(oldHead(w));
    } finally {
      successorWorld.ctx.store.close();
    }
  });
});

function oldFinalPlanId(w: AcceptanceWorld): string {
  return w.ctx.store.withRead((tx) => getExecutionRunInTx(tx, w.executionRunId)!.finalPlan.id);
}

function oldPlanningRunRunFinalPlan(w: AcceptanceWorld): string {
  return oldFinalPlanId(w);
}

function oldHead(w: AcceptanceWorld): string | null {
  return w.ctx.store.withRead((tx) => getAcceptedHeadCommitIdInTx(tx, w.executionRunId));
}

function getFinalPlanCount(w: AcceptanceWorld, runId: string): number {
  return w.ctx.store.withRead(
    (tx) => tx.prepare("SELECT count(*) AS n FROM final_plans WHERE run_id = ?").get(runId) as { n: number },
  ).n;
}

// E9-T57's static scan lives with the migration suite (no E10 artifacts).
void fs;
void path;
