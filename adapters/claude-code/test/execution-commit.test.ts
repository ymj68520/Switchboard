/**
 * E6 §62/§63/§64 — Attempt gates + first commit + immutability tests
 * (E6-T22..T28).
 *
 * The ExecutionCommit is created ONLY inside the acceptance gate: no fake
 * genesis row, at most one commit per Window, immutable rows, and no
 * model-facing commit/acceptedHead surface.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  acceptInput,
  acceptanceServiceOf,
  codeOf,
  makeAcceptanceWorld,
  messageOf,
  runVerificationCycle,
  type AcceptanceWorld,
} from "./acceptance-helpers.js";
import { issueDirective } from "./execution-protocol-helpers.js";
import { PHASE_PLAN_TOOLS, executePhasePlanTool } from "../src/mcp/tools.js";
import { markAttemptIndeterminateInTx } from "../src/store/execution-attempts.js";
import { startWorkerAttemptAndPrepareLaunchInTx } from "../src/application/worker-runtime-service.js";

let world: AcceptanceWorld | null = null;

async function freshWorld(): Promise<AcceptanceWorld> {
  world = await makeAcceptanceWorld(`EC-${Math.random().toString(36).slice(2, 8)}`);
  return world;
}

afterEach(() => {
  world?.ctx.store.close();
  world = null;
});

describe("E6 attempt gates + first commit", () => {
  it("E6-T22: a running attempt blocks acceptance", async () => {
    const w = await freshWorld();
    runVerificationCycle(w);
    // One more directive whose attempt is started but not yet reported.
    const extra = issueDirective(w, { directiveId: "DIR-RUN", kind: "inspection" });
    w.ctx.store.withWrite((tx) =>
      startWorkerAttemptAndPrepareLaunchInTx(
        tx,
        {
          executionRunId: w.executionRunId,
          sessionId: w.f.sessionId,
          workspaceId: w.f.workspaceId,
          generation: w.f.generation,
          directiveId: extra.directiveId,
          directiveRevision: extra.revision,
          directiveHash: extra.hash,
          workerRole: "executor",
        },
        w.ctx.clock,
        w.ctx.clock.nowIso(),
      ),
    );
    const service = acceptanceServiceOf(w);
    expect(codeOf(() => service.submitSupervisorAssessment(acceptInput(w) as never))).toBe(
      "ACCEPTANCE_ATTEMPT_RUNNING",
    );
  });

  it("E6-T23: an unresolved indeterminate attempt blocks acceptance", async () => {
    const w = await freshWorld();
    runVerificationCycle(w);
    // One attempt resolved as indeterminate (crash reconciliation).
    const extra = issueDirective(w, { directiveId: "DIR-IND", kind: "inspection" });
    const { attempt } = w.ctx.store.withWrite((tx) =>
      startWorkerAttemptAndPrepareLaunchInTx(
        tx,
        {
          executionRunId: w.executionRunId,
          sessionId: w.f.sessionId,
          workspaceId: w.f.workspaceId,
          generation: w.f.generation,
          directiveId: extra.directiveId,
          directiveRevision: extra.revision,
          directiveHash: extra.hash,
          workerRole: "executor",
        },
        w.ctx.clock,
        w.ctx.clock.nowIso(),
      ),
    );
    w.ctx.store.withWrite((tx) => markAttemptIndeterminateInTx(tx, attempt.attemptId, w.ctx.clock.nowIso()));
    const service = acceptanceServiceOf(w);
    expect(codeOf(() => service.submitSupervisorAssessment(acceptInput(w) as never))).toBe(
      "ACCEPTANCE_INDETERMINATE_WORK",
    );
  });

  it("E6-T24: the first accept atomically produces the genesis commit", async () => {
    const w = await freshWorld();
    runVerificationCycle(w);
    const service = acceptanceServiceOf(w);
    const result = service.submitSupervisorAssessment(acceptInput(w) as never);
    expect(result.commit).not.toBeNull();
    expect(result.commit?.sequence).toBe(1);
    expect(result.commit?.parentCommitId).toBeNull();
    expect(result.commit?.stageId).toBe(w.activeStageId);
    expect(result.commit?.windowId).toBe(w.openWindowId);
    expect(result.commit?.candidateRevision).toBe(1);
    const state = w.ctx.store.withRead(
      (tx) =>
        ({
          head: tx.prepare("SELECT accepted_head_commit_id AS head FROM execution_runs WHERE execution_run_id = ?").get(w.executionRunId),
          window: tx.prepare("SELECT closed_at FROM verification_windows WHERE id = ?").get(w.openWindowId),
          stage: tx.prepare("SELECT status FROM execution_stages WHERE id = ?").get(w.activeStageId),
          commits: tx.prepare("SELECT count(*) AS n FROM execution_commits").get(),
        }) as { head: { head: string }; window: { closed_at: string | null }; stage: { status: string }; commits: { n: number } },
    );
    expect(state.head.head).toBe(result.commit?.commitId);
    expect(state.window.closed_at).not.toBeNull();
    expect(state.stage.status).toBe("active");
    expect(state.commits.n).toBe(1);
  });

  it("E6-T25: no fake EC-000 genesis commit exists", async () => {
    const w = await freshWorld();
    const before = w.ctx.store.withRead(
      (tx) =>
        tx
          .prepare("SELECT count(*) AS n FROM execution_commits WHERE sequence < 1 OR parent_commit_id IS NOT NULL AND sequence = 1")
          .get() as { n: number },
    );
    expect(before.n).toBe(0);
    runVerificationCycle(w);
    acceptanceServiceOf(w).submitSupervisorAssessment(acceptInput(w) as never);
    // After the first real commit: exactly one row, sequence 1, no EC-000.
    const rows = w.ctx.store.withRead(
      (tx) =>
        tx.prepare("SELECT commit_id AS id, sequence, parent_commit_id AS parent FROM execution_commits ORDER BY sequence").all() as Array<{
          id: string;
          sequence: number;
          parent: string | null;
        }>,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sequence).toBe(1);
    expect(rows[0]?.parent).toBeNull();
    expect(rows[0]?.id).not.toBe("EC-000");
  });

  it("E6-T26: commits are immutable — update and delete are rejected by DDL", async () => {
    const w = await freshWorld();
    runVerificationCycle(w);
    const { commit } = acceptanceServiceOf(w).submitSupervisorAssessment(acceptInput(w) as never);
    expect(commit).not.toBeNull();
    expect(
      messageOf(() =>
        w.ctx.store.withWrite((tx) => {
          tx.prepare("UPDATE execution_commits SET parent_commit_id = 'ec_fake' WHERE commit_id = ?").run(commit!.commitId);
        }),
      ),
    ).toContain("immutable");
    expect(
      messageOf(() =>
        w.ctx.store.withWrite((tx) => {
          tx.prepare("DELETE FROM execution_commits WHERE commit_id = ?").run(commit!.commitId);
        }),
      ),
    ).toContain("immutable");
  });

  it("E6-T27: one commit per window — a recommitted window is impossible", async () => {
    const w = await freshWorld();
    runVerificationCycle(w);
    const service = acceptanceServiceOf(w);
    const first = service.submitSupervisorAssessment(acceptInput(w) as never);
    expect(first.commit).not.toBeNull();
    // The window is closed, so a second accept cannot even address it.
    expect(codeOf(() => service.submitSupervisorAssessment(acceptInput(w) as never))).toBe(
      "VERIFICATION_WINDOW_REQUIRED",
    );
    // And the DDL fence is live: a unique index over window_id.
    const indexes = w.ctx.store.withRead(
      (tx) => tx.prepare("PRAGMA index_list('execution_commits')").all() as Array<{ name: string; unique: number }>,
    );
    const uniqueColumns = indexes
      .filter((index) => index.unique === 1)
      .map((index) =>
        (w.ctx.store.withRead(
          (tx) => tx.prepare(`PRAGMA index_info('${index.name}')`).all() as Array<{ name: string }>,
        ) as Array<{ name: string }>).map((column) => column.name).sort().join(","),
      );
    expect(uniqueColumns).toContain("window_id");
  });

  it("E6-T28: no model-facing commit / acceptedHead / window-close surface exists", async () => {
    const w = await freshWorld();
    const names = PHASE_PLAN_TOOLS.map((tool) => tool.name);
    for (const forbidden of [
      "create_execution_commit",
      "set_accepted_head",
      "close_verification_window",
      "set_assessment_disposition",
      "mark_stage_completed",
    ]) {
      expect(names).not.toContain(forbidden);
      expect(codeOf(() => executePhasePlanTool(w.ctx, forbidden, {}))).toBe("MCP_INPUT_INVALID");
    }
  });
});
