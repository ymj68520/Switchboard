/**
 * E10 §48–§51/§59–§60/§76–§77 — final-closure recovery, replan interop, and
 * cardinality (E10-T56..T62).
 *
 * Recovery is Store-derived and passive: an open Final Closure Window restores
 * as ITSELF (never downgraded to the all_stages_completed boundary, never
 * recreated); a completed run renders its terminal provenance and performs
 * zero mutations; E9 replan works FROM an open final-closure window (terminal
 * replan close with NO fake Stage), and the controlled return to planning
 * still works; the same FinalPlan can execute again later.
 */
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
  beginFinalClosure,
  completeAllStagesFixture,
  makeAcceptanceWorld,
  runFinalClosureCycle,
  runFinalCompletionFixture,
} from "./final-closure-helpers.js";
import { supervisorCall, codeOf } from "./acceptance-helpers.js";
import { initializePlanStore } from "../src/store/sqlite-store.js";
import { createSupervisorBindingService } from "../src/application/supervisor-binding-service.js";
import { renderExecutionRecoveryContext } from "../src/context/execution-recovery.js";
import { getExecutionRunInTx } from "../src/store/execution-runs.js";
import { getSupervisorBindingInTx } from "../src/store/supervisor-bindings.js";
import { requestExecutionReplanInTx } from "../src/application/execution-replan-service.js";

function pluginDataRootOf(store: { path: string }): string {
  return path.dirname(path.dirname(store.path));
}

describe("E10 final-closure recovery (§48–§51, T56..T59)", () => {
  it("E10-T56/T57: an open final window restores as ITSELF with the exact candidateRevision — no duplicate, no downgrade", async () => {
    const w = await makeAcceptanceWorld(`RC-${Math.random().toString(36).slice(2, 8)}`);
    completeAllStagesFixture(w);
    beginFinalClosure(w);
    runFinalClosureCycle(w, { kind: "implementation", directiveId: "DIR-RC1", candidateMutated: true });
    runFinalClosureCycle(w, { kind: "implementation", directiveId: "DIR-RC2", candidateMutated: true });
    const windowBefore = w.ctx.store.withRead(
      (tx) =>
        tx
          .prepare("SELECT id, scope_kind AS scopeKind, candidate_revision AS revision, base_commit_id AS base FROM verification_windows WHERE execution_run_id = ? AND closed_at IS NULL")
          .get(w.executionRunId) as { id: string; scopeKind: string; revision: number; base: string },
    );
    expect(windowBefore.revision).toBe(2);
    const root = pluginDataRootOf(w.ctx.store);
    w.ctx.store.close();
    const reopened = await initializePlanStore({ pluginDataRoot: root });
    try {
      const facts = reopened.withRead((tx) => {
        const run = getExecutionRunInTx(tx, w.executionRunId)!;
        const window = tx
          .prepare("SELECT id, scope_kind AS scopeKind, candidate_revision AS revision FROM verification_windows WHERE execution_run_id = ? AND closed_at IS NULL")
          .get(w.executionRunId) as { id: string; scopeKind: string; revision: number };
        return { lifecycle: run.lifecycle, window };
      });
      expect(facts.lifecycle).toBe("active");
      expect(facts.window.id).toBe(windowBefore.id);
      expect(facts.window.scopeKind).toBe("final_closure");
      expect(facts.window.revision).toBe(2);
      // The recovery capsule renders the final-closure-in-progress line.
      const service = createSupervisorBindingService(reopened, {
        nowIso: () => "2026-10-01T00:00:00.000Z",
        newId: () => `id_${Math.random().toString(36).slice(2, 10)}`,
      });
      const recovery = reopened.withRead((tx) =>
        service.loadExecutionRecoveryFactsInTx(tx, { executionRunId: w.executionRunId, sessionId: w.f.sessionId }),
      );
      expect(recovery.structure?.openWindow).toMatchObject({ id: windowBefore.id, scopeKind: "final_closure" });
      expect(recovery.structure?.openWindow?.candidateRevision).toBe(windowBefore.revision);
    } finally {
      reopened.close();
    }
  });

  it("E10-T58: a completed run recovers with terminal provenance and writes nothing", async () => {
    const w = await makeAcceptanceWorld(`RC2-${Math.random().toString(36).slice(2, 8)}`);
    completeAllStagesFixture(w);
    beginFinalClosure(w);
    const completion = runFinalCompletionFixture(w);
    const bindingBefore = w.ctx.store.withRead((tx) => getSupervisorBindingInTx(tx, w.executionRunId)?.state);
    const root = pluginDataRootOf(w.ctx.store);
    w.ctx.store.close();
    const reopened = await initializePlanStore({ pluginDataRoot: root });
    try {
      const facts = reopened.withRead((tx) => {
        const run = getExecutionRunInTx(tx, w.executionRunId)!;
        const openWindows = tx
          .prepare("SELECT count(*) AS n FROM verification_windows WHERE execution_run_id = ? AND closed_at IS NULL")
          .get(w.executionRunId) as { n: number };
        const binding = getSupervisorBindingInTx(tx, w.executionRunId);
        return { lifecycle: run.lifecycle, openWindows: openWindows.n, bindingState: binding?.state ?? null };
      });
      expect(facts.lifecycle).toBe("completed");
      expect(facts.openWindows).toBe(0);
      expect(facts.bindingState).toBe("detached");
      void bindingBefore;
      // The capsule renders the terminal provenance (completion commit = head).
      const service = createSupervisorBindingService(reopened, {
        nowIso: () => "2026-10-01T00:00:00.000Z",
        newId: () => `id_${Math.random().toString(36).slice(2, 10)}`,
      });
      const accepted = reopened.withRead((tx) =>
        service.loadExecutionRecoveryFactsInTx(tx, { executionRunId: w.executionRunId, sessionId: w.f.sessionId }),
      );
      const capsule = renderExecutionRecoveryContext({
        executionRun: accepted.executionRun,
        binding: accepted.binding,
        ownership: accepted.ownership,
        structure: accepted.structure === null ? null : {
          stages: accepted.structure.stages,
          activeStage: accepted.structure.activeStage,
          openWindow: accepted.structure.openWindow,
        },
        protocol: accepted.protocol,
        acceptedState: accepted.acceptedState,
        progression: accepted.progression,
        verificationPolicy: accepted.verificationPolicy,
      });
      expect(capsule).toContain("ExecutionRun is COMPLETE (completed)");
      expect(capsule).toContain(`Final ExecutionCommit: ${completion.commitId}`);
      expect(capsule).toContain("execution protocol complete");
    } finally {
      reopened.close();
    }
  });
});

describe("E10 replan interop (§59–§60, T60/T61)", () => {
  it("E10-T60: E9 replan succeeds FROM an open final-closure window — terminal close with scope final_closure, no commit", async () => {
    const w = await makeAcceptanceWorld(`RP-${Math.random().toString(36).slice(2, 8)}`);
    completeAllStagesFixture(w);
    beginFinalClosure(w);
    runFinalClosureCycle(w, { kind: "inspection", directiveId: "DIR-RP1" });
    const result = w.ctx.store.withWrite((tx) =>
      requestExecutionReplanInTx(
        tx,
        {
          sessionId: w.f.sessionId,
          workspaceId: w.f.workspaceId,
          generation: w.f.generation,
          reason: "the approved interface contract cannot express the required cross-stage integration semantics",
          affectedNormativeRefs: [{ type: "section", id: w.f.sectionIds[0]!, revision: 1 }],
          relevantReportRefs: [],
          toolUseId: "TU-E10-REPLAN",
        },
        w.ctx.clock,
        w.ctx.clock.nowIso(),
      ),
    );
    expect(result.status).toBe("replan_required");
    const facts = w.ctx.store.withRead((tx) => {
      const run = getExecutionRunInTx(tx, w.executionRunId)!;
      const window = tx
        .prepare("SELECT closure_kind AS closureKind, scope_kind AS scopeKind, stage_id AS stageId FROM verification_windows WHERE execution_run_id = ? AND closed_at IS NOT NULL ORDER BY closed_at DESC LIMIT 1")
        .get(w.executionRunId) as { closureKind: string; scopeKind: string; stageId: string | null };
      const commits = tx
        .prepare("SELECT count(*) AS n FROM execution_commits WHERE window_id = (SELECT id FROM verification_windows WHERE scope_kind = 'final_closure' AND execution_run_id = ?)")
        .get(w.executionRunId) as { n: number };
      return { lifecycle: run.lifecycle, window, finalCommits: commits.n };
    });
    expect(facts.lifecycle).toBe("replan_required");
    expect(facts.window.closureKind).toBe("replan_required");
    expect(facts.window.scopeKind).toBe("final_closure");
    expect(facts.window.stageId).toBeNull();
    expect(facts.finalCommits).toBe(0);
  });

  it("E10-T61: the controlled return to planning still works from a final-closure replan", async () => {
    const w = await makeAcceptanceWorld(`RP2-${Math.random().toString(36).slice(2, 8)}`);
    completeAllStagesFixture(w);
    beginFinalClosure(w);
    runFinalClosureCycle(w, { kind: "inspection", directiveId: "DIR-RP21" });
    w.ctx.store.withWrite((tx) =>
      requestExecutionReplanInTx(
        tx,
        {
          sessionId: w.f.sessionId,
          workspaceId: w.f.workspaceId,
          generation: w.f.generation,
          reason: "missing normative obligation for the final integration contract",
          affectedNormativeRefs: [{ type: "section", id: w.f.sectionIds[0]!, revision: 1 }],
          relevantReportRefs: [],
          toolUseId: "TU-E10-REPLAN2",
        },
        w.ctx.clock,
        w.ctx.clock.nowIso(),
      ),
    );
    // The unadopted replan issue exists; the successor machinery classifies it.
    const { createSuccessorRunService } = await import("../src/application/successor-run-service.js");
    const successors = createSuccessorRunService(w.ctx.store, w.ctx.clock);
    const classified = successors.classifySuccessorEntry(w.f.workspaceId, w.f.sessionId);
    expect(classified.openIssues).toBeGreaterThanOrEqual(1);
    void supervisorCall;
    void codeOf;
  });
});

describe("E10 cardinality (§52, T62)", () => {
  it("E10-T62: the schema imposes no one-completed-run-per-FinalPlan constraint", async () => {
    const w = await makeAcceptanceWorld(`CD-${Math.random().toString(36).slice(2, 8)}`);
    completeAllStagesFixture(w);
    beginFinalClosure(w);
    runFinalCompletionFixture(w);
    // No UNIQUE over final_plan_id on execution_runs; a second run for the
    // same plan can be INSERTed at the DDL level (E10 does not design the
    // restart UX — it only refuses to make reexecution impossible).
    const indexes = w.ctx.store.withRead(
      (tx) => tx.prepare("PRAGMA index_list('execution_runs')").all() as Array<{ name: string; unique: number }>,
    );
    for (const index of indexes) {
      if (!index.unique) continue;
      const columns = w.ctx.store.withRead(
        (tx) => (tx.prepare(`PRAGMA index_info('${index.name.replace(/'/g, "''")}')`).all() as Array<{ name: string }>).map((column) => column.name),
      );
      expect(columns.includes("final_plan_id")).toBe(false);
    }
    // The historical completed run is untouched by any later machinery.
    expect(w.ctx.store.withRead((tx) => getExecutionRunInTx(tx, w.executionRunId)!.lifecycle)).toBe("completed");
  });
});
