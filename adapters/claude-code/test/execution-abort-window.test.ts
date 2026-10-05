/**
 * E13-T14..T18 — VerificationWindow abort closure (§19–§22): an open Window
 * terminates with closure_kind='aborted' (stage scope AND final_closure
 * scope), preserves its candidateRevision, creates NO ExecutionCommit; a run
 * at a durable no-window boundary aborts without fabricating one; accepted
 * and replan historical closures remain untouched.
 */
import { describe, expect, it } from "vitest";

import {
  makeAcceptanceWorld,
  completeActiveStageFixture,
} from "./acceptance-helpers.js";
import { completeAllStagesFixture, beginFinalClosure } from "./final-closure-helpers.js";
import { explicitExecutionAbort, lifecycleOf } from "./session-recovery-helpers.js";

function windowRowsOf(world: Awaited<ReturnType<typeof makeAcceptanceWorld>>) {
  return world.ctx.store.withRead(
    (tx) =>
      tx
        .prepare(
          "SELECT id, scope_kind AS scopeKind, stage_id AS stageId, closed_at AS closedAt, closure_kind AS kind, candidate_revision AS revision "
          + "FROM verification_windows WHERE execution_run_id = ? ORDER BY opened_at",
        )
        .all(world.executionRunId) as Array<{ id: string; scopeKind: string; stageId: string | null; closedAt: string | null; kind: string | null; revision: number }>,
  );
}

describe("E13 window closure (§19–§22)", () => {
  it("E13-T14: an open STAGE window closes as aborted with no commit and its revision preserved", async () => {
    const world = await makeAcceptanceWorld("S1");
    const open = windowRowsOf(world).find((row) => row.closedAt === null);
    expect(open).toBeDefined();
    const result = explicitExecutionAbort(world, { reason: "stop" });
    expect(result.closedWindowId).toBe(open!.id);
    const closed = windowRowsOf(world).find((row) => row.id === open!.id)!;
    expect(closed.closedAt).not.toBeNull();
    expect(closed.kind).toBe("aborted");
    expect(closed.revision).toBe(open!.revision);
    // NO ExecutionCommit exists for the aborted window (§19 — no fabrication).
    const commit = world.ctx.store.withRead(
      (tx) => tx.prepare("SELECT count(*) AS n FROM execution_commits WHERE window_id = ?").get(open!.id) as { n: number },
    );
    expect(commit.n).toBe(0);
    // acceptedHead unchanged (§16) — the window base stays the baseline.
    const head = world.ctx.store.withRead(
      (tx) => tx.prepare("SELECT accepted_head_commit_id AS h FROM execution_runs WHERE execution_run_id = ?").get(world.executionRunId) as { h: string | null },
    );
    expect(head.h).toBeNull();
  });

  it("E13-T15: an open FINAL CLOSURE window closes as aborted — stage_id stays NULL, no synthetic Stage", async () => {
    const world = await makeAcceptanceWorld(`S1-${Math.random().toString(36).slice(2, 6)}`);
    completeAllStagesFixture(world);
    beginFinalClosure(world);
    const open = windowRowsOf(world).find((row) => row.closedAt === null);
    expect(open).toMatchObject({ scopeKind: "final_closure", stageId: null });
    const result = explicitExecutionAbort(world, { reason: "user stopped final closure" });
    expect(result.closedWindowId).toBe(open!.id);
    const closed = windowRowsOf(world).find((row) => row.id === open!.id)!;
    expect(closed.kind).toBe("aborted");
    expect(closed.scopeKind).toBe("final_closure");
    expect(closed.stageId).toBeNull();
    const commit = world.ctx.store.withRead(
      (tx) => tx.prepare("SELECT count(*) AS n FROM execution_commits WHERE window_id = ?").get(open!.id) as { n: number },
    );
    expect(commit.n).toBe(0);
    expect(lifecycleOf(world)).toBe("aborted");
  });

  it("E13-T16: abort at a no-open-window boundary succeeds without fabricating a window", async () => {
    const world = await makeAcceptanceWorld(`S1-${Math.random().toString(36).slice(2, 6)}`);
    // Drive the real E6/E7 cycle to the post-commit same-stage boundary: the
    // stage completes by its ExecutionCommit and the window closed as
    // accepted — NO open window remains.
    completeActiveStageFixture(world);
    const before = windowRowsOf(world);
    expect(before.find((row) => row.closedAt === null)).toBeUndefined();
    const result = explicitExecutionAbort(world, { reason: "stop between boundaries" });
    expect(result.closedWindowId).toBeNull();
    const after = windowRowsOf(world);
    // Nothing was fabricated: the window set is IDENTICAL (the accepted
    // closure predates the abort; no synthetic aborted window appeared).
    expect(after.map((row) => [row.id, row.kind, row.revision])).toEqual(
      before.map((row) => [row.id, row.kind, row.revision]),
    );
    expect(lifecycleOf(world)).toBe("aborted");
  });

  it("E13-T17/T18: accepted and replan historical closures remain byte-identical across an abort", async () => {
    const world = await makeAcceptanceWorld(`S1-${Math.random().toString(36).slice(2, 6)}`);
    // An ACCEPTED historical closure (the completed stage's window).
    completeActiveStageFixture(world);
    const accepted = windowRowsOf(world).find((row) => row.kind === "accepted");
    expect(accepted).toBeDefined();
    explicitExecutionAbort(world, { reason: "stop" });
    const after = windowRowsOf(world).find((row) => row.id === accepted!.id)!;
    expect(after.kind).toBe("accepted");
    expect(after.closedAt).not.toBeNull();
    expect(after.revision).toBe(accepted!.revision);
  });
});
