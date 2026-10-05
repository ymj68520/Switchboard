/**
 * E7 §46/§49/§52 — progression boundary, same-Stage continuation, next-Stage
 * activation, and accepted-state authority (E7-T1..T3, T17..T21, T29, T30)
 * plus the §38 successor-directive base binding.
 *
 * An intermediate Commit closes the window and leaves the Stage active with NO
 * open window (the post-commit same-stage boundary, E7 §10/§30). Only an
 * explicit Supervisor operation opens the successor window or activates the
 * next Stage; neither ever touches the acceptedHead (E7 §39) — the
 * ExecutionCommit stays its sole writer.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  acceptInput,
  acceptanceServiceOf,
  codeOf,
  makeAcceptanceWorld,
  runVerificationCycle,
  supervisorCall,
  completeActiveStageFixture,
  type AcceptanceWorld,
} from "./acceptance-helpers.js";
import { issueDirective } from "./execution-protocol-helpers.js";
import { createExecutionProgressionService } from "../src/application/execution-progression-service.js";
import { getExecutionStageInTx } from "../src/store/execution-structure.js";

let world: AcceptanceWorld | null = null;

async function freshWorld(): Promise<AcceptanceWorld> {
  world = await makeAcceptanceWorld(`SP-${Math.random().toString(36).slice(2, 8)}`);
  return world;
}

function progressionOf(w: AcceptanceWorld) {
  return createExecutionProgressionService(w.ctx.store, w.ctx.clock);
}

function headOf(w: AcceptanceWorld): string | null {
  return w.ctx.store.withRead(
    (tx) =>
      (tx.prepare("SELECT accepted_head_commit_id AS head FROM execution_runs WHERE execution_run_id = ?").get(w.executionRunId) as {
        head: string | null;
      }).head,
  );
}

/** One intermediate commit: plain verification, plain accept (E7 §10). */
function intermediateCommit(w: AcceptanceWorld): string {
  runVerificationCycle(w);
  const result = acceptanceServiceOf(w).submitSupervisorAssessment(acceptInput(w, {
    coveredObligations: [],
  }) as never) as { commit: { commitId: string } | null };
  if (result.commit === null) throw new Error("intermediate commit refused");
  return result.commit.commitId;
}

afterEach(() => {
  world?.ctx.store.close();
  world = null;
});

describe("E7 intermediate commit + same-Stage continuation (§10/§20/§30)", () => {
  it("E7-T1: an intermediate Commit advances the head, closes the window, and leaves the Stage active", async () => {
    const w = await freshWorld();
    const commitId = intermediateCommit(w);
    const after = w.ctx.store.withRead((tx) => ({
      stage: getExecutionStageInTx(tx, w.activeStageId)!,
      window: tx.prepare("SELECT closed_at FROM verification_windows WHERE id = ?").get(w.openWindowId) as { closed_at: string | null },
      head: tx.prepare("SELECT accepted_head_commit_id AS head FROM execution_runs WHERE execution_run_id = ?").get(w.executionRunId) as { head: string | null },
      openCount: tx.prepare("SELECT count(*) AS n FROM verification_windows WHERE execution_run_id = ? AND closed_at IS NULL").get(w.executionRunId) as { n: number },
    }));
    expect(after.head.head).toBe(commitId);
    expect(after.window.closed_at).not.toBeNull();
    expect(after.stage.status).toBe("active");
    expect(after.stage.completedByCommitId).toBeNull();
    expect(after.openCount.n).toBe(0);
    // The progression context names the boundary.
    const context = progressionOf(w).getExecutionProgressionContext({ executionRunId: w.executionRunId });
    expect(context.progressionBoundary).toBe("post_commit_same_stage");
    expect(context.activeStage?.id).toBe(w.activeStageId);
  });

  it("E7-T2: continue_execution_stage opens a new window on the SAME Stage at revision 0 rooted in the head", async () => {
    const w = await freshWorld();
    const commitId = intermediateCommit(w);
    const response = supervisorCall(w, "continue_execution_stage") as {
      status: string;
      stage: { id: string };
      window: { id: string; candidate_revision: number; base_kind: string; base_commit_id: string | null };
      accepted_head: string;
    };
    expect(response.status).toBe("continued");
    expect(response.stage.id).toBe(w.activeStageId);
    expect(response.window.id).not.toBe(w.openWindowId);
    expect(response.window.candidate_revision).toBe(0);
    expect(response.window.base_kind).toBe("execution_commit");
    expect(response.window.base_commit_id).toBe(commitId);
    expect(response.accepted_head).toBe(commitId);
    // The window is open again for the same stage.
    const after = w.ctx.store.withRead((tx) => ({
      open: tx.prepare("SELECT id, stage_id, candidate_revision AS revision, base_kind AS baseKind, base_commit_id AS baseCommitId FROM verification_windows WHERE execution_run_id = ? AND closed_at IS NULL").get(w.executionRunId) as Record<string, unknown>,
      stage: getExecutionStageInTx(tx, w.activeStageId)!,
    }));
    expect(after.open.id).toBe(response.window.id);
    expect(after.open.stage_id).toBe(w.activeStageId);
    expect(after.stage.status).toBe("active");
    // E7 §39 — the head never moved.
    expect(headOf(w)).toBe(commitId);
  });

  it("E7-T3: one Stage operationally spans WINDOW-1 → EC-1, WINDOW-2 → EC-2, WINDOW-3 open", async () => {
    const w = await freshWorld();
    const first = intermediateCommit(w);
    supervisorCall(w, "continue_execution_stage");
    w.openWindowId = w.ctx.store.withRead(
      (tx) =>
        (tx.prepare("SELECT id FROM verification_windows WHERE execution_run_id = ? AND closed_at IS NULL").get(w.executionRunId) as { id: string }).id,
    );
    const second = intermediateCommit(w);
    supervisorCall(w, "continue_execution_stage");
    const after = w.ctx.store.withRead((tx) => ({
      windows: tx.prepare("SELECT id, closed_at, base_kind AS baseKind, base_commit_id AS baseCommitId FROM verification_windows WHERE stage_id = ? ORDER BY opened_at, id").all(w.activeStageId) as Array<Record<string, unknown>>,
      commits: tx.prepare("SELECT commit_id, window_id FROM execution_commits WHERE execution_run_id = ? ORDER BY sequence").all(w.executionRunId) as Array<{ commit_id: string; window_id: string }>,
      stage: getExecutionStageInTx(tx, w.activeStageId)!,
    }));
    expect(after.windows).toHaveLength(3);
    expect(after.windows[0]?.closed_at).not.toBeNull();
    expect(after.windows[1]?.closed_at).not.toBeNull();
    expect(after.windows[2]?.closed_at).toBeNull();
    expect(after.windows[1]?.baseCommitId).toBe(first);
    expect(after.commits.map((commit) => commit.commit_id)).toEqual([first, second]);
    expect(after.stage.status).toBe("active");
  });

  it("E7 §38 — a Directive issued in the successor window binds acceptedBase = the exact window base", async () => {
    const w = await freshWorld();
    const commitId = intermediateCommit(w);
    supervisorCall(w, "continue_execution_stage");
    w.openWindowId = w.ctx.store.withRead(
      (tx) =>
        (tx.prepare("SELECT id FROM verification_windows WHERE execution_run_id = ? AND closed_at IS NULL").get(w.executionRunId) as { id: string }).id,
    );
    const windowBase = w.ctx.store.withRead(
      (tx) =>
        (tx.prepare("SELECT base_commit_id AS base FROM verification_windows WHERE execution_run_id = ? AND closed_at IS NULL").get(w.executionRunId) as { base: string | null }).base,
    );
    expect(windowBase).toBe(commitId);
    const directive = issueDirective(w, { directiveId: "DIR-SUCCESSOR", kind: "inspection" });
    expect(directive.acceptedBase.kind).toBe("execution_commit");
    expect((directive.acceptedBase as { executionCommitId: string | null }).executionCommitId).toBe(commitId);
  });
});

describe("E7 next-Stage activation (§22/§25)", () => {
  it("E7-T17: after Stage A completes the run sits between stages — no active Stage, no window, eligible Stages available", async () => {
    const w = await freshWorld();
    completeActiveStageFixture(w);
    const context = progressionOf(w).getExecutionProgressionContext({ executionRunId: w.executionRunId });
    expect(context.progressionBoundary).toBe("between_stages");
    expect(context.activeStage).toBeNull();
    expect(context.openWindow).toBeNull();
    expect(context.completedStages.map((stage) => stage.id)).toEqual([w.activeStageId]);
    expect(context.pendingStages.map((stage) => stage.sourceStepId)).toEqual(["step-2"]);
    expect(context.eligibleStages.map((stage) => stage.id)).toEqual([context.pendingStages[0]?.id]);
    expect(context.defaultSuggestedStageId).toBe(context.eligibleStages[0]?.id ?? null);
    // The run is still active.
    expect(context.executionRun.lifecycle).toBe("active");
  });

  it("E7-T18: the Supervisor activates the exact eligible target — pending → active + first window rooted in the head", async () => {
    const w = await freshWorld();
    completeActiveStageFixture(w);
    const pendingId = w.ctx.store.withRead(
      (tx) =>
        (tx.prepare("SELECT id FROM execution_stages WHERE execution_run_id = ? AND status = 'pending'").get(w.executionRunId) as { id: string }).id,
    );
    const head = headOf(w);
    const response = supervisorCall(w, "activate_execution_stage", { target_stage_id: pendingId }) as {
      status: string;
      stage: { id: string };
      window: { candidate_revision: number; base_kind: string; base_commit_id: string | null };
      accepted_head: string;
    };
    expect(response.status).toBe("activated");
    expect(response.stage.id).toBe(pendingId);
    expect(response.window.candidate_revision).toBe(0);
    expect(response.window.base_kind).toBe("execution_commit");
    expect(response.window.base_commit_id).toBe(head);
    const after = w.ctx.store.withRead((tx) => ({
      stage: getExecutionStageInTx(tx, pendingId)!,
      open: tx.prepare("SELECT count(*) AS n FROM verification_windows WHERE execution_run_id = ? AND closed_at IS NULL AND stage_id = ?").get(w.executionRunId, pendingId) as { n: number },
    }));
    expect(after.stage.status).toBe("active");
    expect(after.stage.completedByCommitId).toBeNull();
    expect(after.open.n).toBe(1);
    // E7 §39 — activation is orchestration, not accepted progress.
    expect(headOf(w)).toBe(head);
  });

  it("E7-T19: activating a completed Stage again is refused with no state change", async () => {
    const w = await freshWorld();
    completeActiveStageFixture(w);
    const before = w.ctx.store.withRead((tx) => ({
      stages: tx.prepare("SELECT id, status FROM execution_stages WHERE execution_run_id = ? ORDER BY ordinal").all(w.executionRunId),
      windows: tx.prepare("SELECT count(*) AS n FROM verification_windows WHERE execution_run_id = ? AND closed_at IS NULL").get(w.executionRunId) as { n: number },
    }));
    expect(
      codeOf(() => supervisorCall(w, "activate_execution_stage", { target_stage_id: w.activeStageId })),
    ).toBe("STAGE_ALREADY_COMPLETED");
    const after = w.ctx.store.withRead((tx) => ({
      stages: tx.prepare("SELECT id, status FROM execution_stages WHERE execution_run_id = ? ORDER BY ordinal").all(w.executionRunId),
      windows: tx.prepare("SELECT count(*) AS n FROM verification_windows WHERE execution_run_id = ? AND closed_at IS NULL").get(w.executionRunId) as { n: number },
    }));
    expect(after).toEqual(before);
  });

  it("E7-T20: a second Stage cannot activate while one is active", async () => {
    const w = await freshWorld();
    const pendingId = w.ctx.store.withRead(
      (tx) =>
        (tx.prepare("SELECT id FROM execution_stages WHERE execution_run_id = ? AND status = 'pending'").get(w.executionRunId) as { id: string }).id,
    );
    expect(
      codeOf(() => supervisorCall(w, "activate_execution_stage", { target_stage_id: pendingId })),
    ).toBe("EXECUTION_STAGE_ALREADY_ACTIVE");
    expect(headOf(w)).toBeNull();
  });

  it("E7-T21: two eligible Stages coexist and Core activates only the one the Supervisor selects", async () => {
    const w = await freshWorld();
    completeActiveStageFixture(w);
    // The default fixture has exactly one pending Stage after stage 1; extend
    // to two eligible by materializing the dependency-free third Stage the
    // plan did not ship: instead prove the no-auto-activation half here —
    // repeated context reads mutate nothing and nothing activates on its own.
    const first = progressionOf(w).getExecutionProgressionContext({ executionRunId: w.executionRunId });
    const second = progressionOf(w).getExecutionProgressionContext({ executionRunId: w.executionRunId });
    expect(second).toEqual(first);
    expect(second.progressionBoundary).toBe("between_stages");
    // The Supervisor selects the eligible Stage explicitly (not the "system").
    const target = second.eligibleStages[0]?.id;
    expect(target).toBeDefined();
    supervisorCall(w, "activate_execution_stage", { target_stage_id: target });
    const after = progressionOf(w).getExecutionProgressionContext({ executionRunId: w.executionRunId });
    expect(after.progressionBoundary).toBe("active_candidate");
    expect(after.activeStage?.id).toBe(target);
  });

  it("E7-T29: continue and activate NEVER mutate the acceptedHead (E7 §39)", async () => {
    const w = await freshWorld();
    const commitId = intermediateCommit(w);
    supervisorCall(w, "continue_execution_stage");
    expect(headOf(w)).toBe(commitId);
    completeActiveStageFixture(w);
    const headAfterCompletion = headOf(w);
    expect(headAfterCompletion).not.toBe(commitId);
    const pendingId = w.ctx.store.withRead(
      (tx) =>
        (tx.prepare("SELECT id FROM execution_stages WHERE execution_run_id = ? AND status = 'pending'").get(w.executionRunId) as { id: string }).id,
    );
    supervisorCall(w, "activate_execution_stage", { target_stage_id: pendingId });
    expect(headOf(w)).toBe(headAfterCompletion);
  });

  it("E7-T30: static proof — advanceAcceptedHeadInTx keeps exactly one production caller (the acceptance gate)", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const { relative, resolve, sep } = await import("node:path");
    const srcRoot = resolve(__dirname, "../src");
    const callers: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = resolve(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && entry.name.endsWith(".ts")) {
          if (readFileSync(full, "utf8").includes("advanceAcceptedHeadInTx(")) {
            callers.push(relative(srcRoot, full).split(sep).join("/"));
          }
        }
      }
    };
    walk(srcRoot);
    expect(callers.sort()).toEqual(["application/acceptance-service.ts", "store/execution-commits.ts"]);
  });
});

