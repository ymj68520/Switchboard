/**
 * E6 §65/§66 — later commits, window boundaries, and recovery bootstrap
 * (E6-T32..T39).
 *
 * After the first commit the accepted state moves forward only through the
 * gate: successor windows root in the exact head, directives bind that base,
 * the chain stays linear, no successor window auto-opens, recovery keeps the
 * post-commit boundary, and genesis bootstrap still works pre-first-commit.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  acceptInput,
  acceptanceServiceOf,
  codeOf,
  currentRevision,
  makeAcceptanceWorld,
  openSuccessorWindow,
  runDirectiveCycle,
  runVerificationCycle,
  type AcceptanceWorld,
} from "./acceptance-helpers.js";
import { issueDirective } from "./execution-protocol-helpers.js";
import { ensureExecutionStructureInTx } from "../src/application/execution-structure-service.js";
import { getExecutionRunBySourcePlanningRunInTx } from "../src/store/execution-runs.js";
import { getAcceptedHeadCommitIdInTx, listRunCommitsInTx } from "../src/store/execution-commits.js";
import { makeApprovedFinalPlanFixture, callHandoff } from "./phase14-helpers.js";
import { initializePlanStore } from "../src/store/sqlite-store.js";

let world: AcceptanceWorld | null = null;

async function freshWorld(): Promise<AcceptanceWorld> {
  world = await makeAcceptanceWorld(`WB-${Math.random().toString(36).slice(2, 8)}`);
  return world;
}

afterEach(() => {
  world?.ctx.store.close();
  world = null;
});

describe("E6 window base + post-commit boundary", () => {
  it("E6-T32: a directive in the successor window binds acceptedBase = execution_commit / EC-001", async () => {
    const w = await freshWorld();
    runVerificationCycle(w);
    const { commit } = acceptanceServiceOf(w).submitSupervisorAssessment(acceptInput(w) as never)!;
    openSuccessorWindow(w);
    // Default issuance in a successor window binds the window's commit base.
    const defaulted = issueDirective(w, { directiveId: "DIR-B1", kind: "implementation" });
    expect(defaulted.acceptedBase).toEqual({ kind: "execution_commit", executionCommitId: commit!.commitId });
    // Explicit supply must equal the window base exactly…
    const explicit = issueDirective(w, {
      directiveId: "DIR-B2",
      kind: "inspection",
      acceptedBase: { kind: "execution_commit", executionCommitId: commit!.commitId },
    });
    expect(explicit.acceptedBase.kind).toBe("execution_commit");
    // …a foreign commit id is refused.
    expect(
      codeOf(() =>
        issueDirective(w, {
          directiveId: "DIR-B3",
          kind: "inspection",
          acceptedBase: { kind: "execution_commit", executionCommitId: "ec_foreign" },
        }),
      ),
    ).toBe("ACCEPTED_BASE_INVALID");
  });

  it("E6-T33: the second commit chains parent/sequence/head", async () => {
    const w = await freshWorld();
    runVerificationCycle(w);
    const service = acceptanceServiceOf(w);
    const first = service.submitSupervisorAssessment(acceptInput(w) as never);
    openSuccessorWindow(w);
    runDirectiveCycle(w, { directiveId: "DIR-I3", kind: "implementation", reportOverrides: { candidate_mutated: true } });
    runVerificationCycle(w);
    const second = service.submitSupervisorAssessment(acceptInput(w) as never);
    expect(second.commit?.sequence).toBe(2);
    expect(second.commit?.parentCommitId).toBe(first.commit?.commitId);
    expect(second.acceptedHeadCommitId).toBe(second.commit?.commitId);
    const chain = w.ctx.store.withRead((tx) => listRunCommitsInTx(tx, w.executionRunId));
    expect(chain.map((c) => c.sequence)).toEqual([1, 2]);
    expect(w.ctx.store.withRead((tx) => getAcceptedHeadCommitIdInTx(tx, w.executionRunId))).toBe(second.commit?.commitId);
  });

  it("E6-T34: the chain stays linear — every parent is the previous head", async () => {
    const w = await freshWorld();
    const service = acceptanceServiceOf(w);
    runVerificationCycle(w);
    const first = service.submitSupervisorAssessment(acceptInput(w) as never);
    openSuccessorWindow(w);
    runDirectiveCycle(w, { directiveId: "DIR-I3", kind: "implementation", reportOverrides: { candidate_mutated: true } });
    runVerificationCycle(w);
    const second = service.submitSupervisorAssessment(acceptInput(w) as never);
    // The DDL fence: one commit per (run, sequence).
    const uniqueIndexes = w.ctx.store.withRead(
      (tx) => tx.prepare("PRAGMA index_list('execution_commits')").all() as Array<{ name: string; unique: number }>,
    );
    const uniqueColumnSets = uniqueIndexes
      .filter((index) => index.unique === 1)
      .map((index) =>
        (
          w.ctx.store.withRead(
            (tx) => tx.prepare(`PRAGMA index_info('${index.name}')`).all() as Array<{ name: string }>,
          ) as Array<{ name: string }>
        )
          .map((column) => column.name)
          .sort()
          .join(","),
      );
    // A1 — the commit sequence is unique per canonical ExecutionRunID.
    expect(uniqueColumnSets).toContain("execution_run_id,sequence");
    // And the gate derivation: parent == previous head, no branch, no merge.
    expect(second.commit?.parentCommitId).toBe(first.commit?.commitId);
  });

  it("E6-T35: the commit closes exactly the accepted window", async () => {
    const w = await freshWorld();
    runVerificationCycle(w);
    const firstWindowId = w.openWindowId;
    acceptanceServiceOf(w).submitSupervisorAssessment(acceptInput(w) as never);
    openSuccessorWindow(w);
    const secondWindowId = w.openWindowId;
    runDirectiveCycle(w, { directiveId: "DIR-I3", kind: "implementation", reportOverrides: { candidate_mutated: true } });
    runVerificationCycle(w);
    acceptanceServiceOf(w).submitSupervisorAssessment(acceptInput(w) as never);
    const windows = w.ctx.store.withRead(
      (tx) =>
        tx.prepare("SELECT id, closed_at FROM verification_windows WHERE execution_run_id = ? ORDER BY opened_at").all(w.executionRunId) as Array<{
          id: string;
          closed_at: string | null;
        }>,
    );
    expect(windows.map((row) => row.id)).toEqual([firstWindowId, secondWindowId]);
    expect(windows.every((row) => row.closed_at !== null)).toBe(true);
  });

  it("E6-T36: no successor window opens automatically inside the commit", async () => {
    const w = await freshWorld();
    runVerificationCycle(w);
    acceptanceServiceOf(w).submitSupervisorAssessment(acceptInput(w) as never);
    const open = w.ctx.store.withRead(
      (tx) => tx.prepare("SELECT count(*) AS n FROM verification_windows WHERE execution_run_id = ? AND closed_at IS NULL").get(w.executionRunId) as { n: number },
    );
    expect(open.n).toBe(0);
  });

  it("E6-T37: recovery does not auto-open a window after a commit", async () => {
    const w = await freshWorld();
    runVerificationCycle(w);
    const { commit } = acceptanceServiceOf(w).submitSupervisorAssessment(acceptInput(w) as never)!;
    // The SessionStart/bootstrap path runs — and must not create a window.
    const structure = w.ctx.store.withWrite((tx) =>
      ensureExecutionStructureInTx(tx, w.executionRunId, w.ctx.clock, w.ctx.clock.nowIso()),
    );
    expect(structure.activeStage?.id).toBe(w.activeStageId);
    expect(structure.openWindow).toBeNull();
    expect(w.ctx.store.withRead((tx) => getAcceptedHeadCommitIdInTx(tx, w.executionRunId))).toBe(commit!.commitId);
    const windowCount = w.ctx.store.withRead(
      (tx) => tx.prepare("SELECT count(*) AS n FROM verification_windows WHERE execution_run_id = ?").get(w.executionRunId) as { n: number },
    );
    expect(windowCount.n).toBe(1); // only the closed accepted window
  });

  it("E6-T38: genesis recovery still bootstraps a pre-first-commit run", async () => {
    // An active ExecutionRun with NO structure at all (simulated legacy
    // activation): the genesis bootstrap creates stages + the first window.
    const { f, ctx } = await makeApprovedFinalPlanFixture(`WB-GEN-${Math.random().toString(36).slice(2, 8)}`);
    callHandoff(ctx, f, { toolUseId: "WB-GEN-DELIVER" });
    const store = await initializePlanStore({ pluginDataRoot: ctx.store.path.split("store")[0]!.slice(0, -1) });
    void store;
    // A1 — the canonical world is keyed by the ExecutionRunID prepared at
    // handoff time.
    const executionRunId = ctx.store.withRead(
      (tx) => getExecutionRunBySourcePlanningRunInTx(tx, f.runId),
    )!.executionRunId;
    ctx.store.withWrite((tx) => {
      // Activate the prepared run WITHOUT delivering structure (E1 lifecycle
      // move only — the exact state E3 recovery is designed to converge).
      tx.prepare("UPDATE execution_runs SET lifecycle = 'active', revision = revision + 1 WHERE execution_run_id = ?").run(executionRunId);
    });
    const structure = ctx.store.withWrite((tx) =>
      ensureExecutionStructureInTx(tx, executionRunId, ctx.clock, ctx.clock.nowIso()),
    );
    expect(structure.activeStage).not.toBeNull();
    expect(structure.openWindow).not.toBeNull();
    expect(structure.openWindow?.candidateRevision).toBe(0);
    expect(structure.openWindow?.baseKind).toBe("execution_start");
    // Idempotent: a second recovery run changes nothing.
    const again = ctx.store.withWrite((tx) => ensureExecutionStructureInTx(tx, executionRunId, ctx.clock, ctx.clock.nowIso()));
    expect(again.openWindow?.id).toBe(structure.openWindow?.id);
    ctx.store.close();
  });

  it("E6-T39: each successor window starts its own candidateRevision at 0", async () => {
    const w = await freshWorld();
    runVerificationCycle(w);
    acceptanceServiceOf(w).submitSupervisorAssessment(acceptInput(w) as never);
    expect(currentRevision(w)).toBe(-1); // no open window
    openSuccessorWindow(w);
    expect(currentRevision(w)).toBe(0);
    // The closed window's revision is retained forever; the new window's is
    // independent of it.
    const revisions = w.ctx.store.withRead(
      (tx) =>
        tx.prepare("SELECT id, candidate_revision AS revision, closed_at FROM verification_windows WHERE execution_run_id = ? ORDER BY opened_at").all(w.executionRunId) as Array<{
          id: string;
          revision: number;
          closed_at: string | null;
        }>,
    );
    expect(revisions[0]?.revision).toBe(1);
    expect(revisions[0]?.closed_at).not.toBeNull();
    expect(revisions[1]?.revision).toBe(0);
    expect(revisions[1]?.closed_at).toBeNull();
  });
});
