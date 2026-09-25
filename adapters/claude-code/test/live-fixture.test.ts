/**
 * Live-host fixture seam (Phase 7 live validation only).
 *
 * Prepares a legitimate awaiting_approval Proposal on the CURRENT active run
 * of the host-managed store, using the same application services the runtime
 * itself uses. It never fabricates authorization: it only exercises the
 * domain's own prepare path. The test is inert unless PHASE_PLAN_LIVE_STORE
 * points at the live plugin data root, so the normal suite skips it.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { createPlanCommitEngine } from "../src/application/plan-commit-engine.js";
import { createProposalService } from "../src/application/proposal-service.js";
import { createPlanningRunService } from "../src/application/planning-run-service.js";
import { initializePlanStore, type PlanStore } from "../src/store/sqlite-store.js";
import { systemStoreClock } from "../src/store/clock.js";

const liveRoot = process.env.PHASE_PLAN_LIVE_STORE;
const tag = process.env.PHASE_PLAN_LIVE_FIXTURE_TAG ?? "1";
const d = liveRoot === undefined ? describe.skip : describe;

d("live fixture (guarded by PHASE_PLAN_LIVE_STORE)", () => {
  it("prepares one awaiting_approval proposal on the current active run", async () => {
    expect(liveRoot).toBeDefined();
    expect(fs.existsSync(path.join(liveRoot!, "store", "phase-plan.sqlite3"))).toBe(true);

    const clock = systemStoreClock();
    const store: PlanStore = await initializePlanStore({ pluginDataRoot: liveRoot! });
    try {
      const current = store.withRead((tx) =>
        tx
          .prepare(
            `SELECT b.session_id AS sessionId, b.run_id AS runId, b.generation AS generation,
                    r.workspace_id AS workspaceId, r.stage AS stage, r.revision AS revision
             FROM session_bindings b JOIN planning_runs r ON r.run_id = b.run_id
             WHERE b.state = 'attached' AND r.lifecycle = 'active'
             ORDER BY b.updated_at DESC LIMIT 1`,
          )
          .get(),
      ) as
        | { sessionId: string; runId: string; generation: number; workspaceId: string; stage: string; revision: number }
        | undefined;
      expect(current).toBeDefined();

      const runs = createPlanningRunService(store, clock);
      let revision = current!.revision;
      if (current!.stage === "discovery") {
        const transitioned = runs.transitionRun({
          runId: current!.runId,
          workspaceId: current!.workspaceId,
          sessionId: current!.sessionId,
          bindingGeneration: current!.generation,
          expectedRevision: revision,
          event: "DISCOVERY_COMPLETE",
        });
        revision = transitioned.revision;
      }

      const proposals = createProposalService(store, clock);
      const prepared = proposals.prepareProposal({
        runId: current!.runId,
        workspaceId: current!.workspaceId,
        sessionId: current!.sessionId,
        bindingGeneration: current!.generation,
        expectedRunRevision: revision,
        type: "design_checkpoint",
        scope: { kind: "architecture" },
        title: `Live-host validation checkpoint ${tag}`,
        summary: "Awaiting proposal prepared outside the host for live Formal Approval validation.",
        changes: [
          {
            op: "ADD_DECISION",
            content: {
              title: `Live validation decision ${tag}`,
              statement: "Decision content prepared by the live-host validation fixture.",
              rationale: "exercise the formal approval bridge end to end",
              alternatives: ["no-op"],
              consequences: ["one approval, one commit, one snapshot when allowed"],
              scope: "validation",
              supportingRefs: [],
            },
            compactProjection: `live-validation-${tag}`,
          },
        ],
      });

      createPlanCommitEngine(store, clock);
      console.log(
        `LIVE_FIXTURE ${JSON.stringify({
          runId: current!.runId,
          proposalId: prepared.proposal.proposalId,
          proposalRevision: prepared.proposal.revision,
          proposalHash: prepared.proposal.proposalHash,
        })}`,
      );
      expect(prepared.proposal.proposalId).toBeTruthy();
    } finally {
      store.close();
    }
  });
});
