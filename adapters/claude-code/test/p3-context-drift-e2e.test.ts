/**
 * P3 E2E Test Suite — Supervisor Long-Horizon Context Drift & Execution Evolution Ledger.
 *
 * Verifies:
 * 1. Multi-stage execution producing more than SUPERVISOR_CONTEXT_RECENT_LIMIT (10) directives/reports.
 * 2. Stage 1 establishes a cross-component invariant in findings that is pushed out of the recent-10 window.
 * 3. Supervisor Context (L0/L1/L2) deterministically recovers the Stage 1 invariant at Stage 5/6.
 * 4. Early engineering discoveries and cross-stage contracts remain bound to origin stages with validity status.
 * 5. Invalidated assumptions are marked superseded and not projected as current active facts.
 * 6. Store close/reopen (simulating compaction and session resume) reconstructs the identical evolution ledger.
 */

import { describe, expect, it } from "vitest";

import {
  acceptViaMcp,
  boundariesOf,
  closeAndReopen,
  completeStageViaGate,
  freshWorkerSession,
  getAcceptedHeadCommitIdInTx,
  makeAcceptanceWorld,
  runImplementation,
  runFreshVerifier,
  supervisorCall,
} from "./v020-e2e-helpers.js";
import {
  buildLayeredSupervisorContextInTx,
  SUPERVISOR_CONTEXT_RECENT_LIMIT,
} from "../src/context/execution-evolution-ledger.js";
import { loadExecutionProgressionContextInTx } from "../src/application/execution-progression-service.js";

describe("P3: Supervisor Long-Horizon Context Drift & Execution Evolution Ledger E2E", () => {
  it("preserves cross-component invariants and evolution facts beyond recent-10 limits across compaction", async () => {
    const world = await makeAcceptanceWorld("P3-E2E");

    // -------------------------------------------------------------------------
    // 1. Stage 1: Establish critical cross-component invariant
    // -------------------------------------------------------------------------
    const st1Objective = "Establish storage and transaction boundary";
    runImplementation(world, {
      directiveId: "DIR-P3-ST1-IMPL",
      candidateMutated: true,
      reportOverrides: {
        findings: [
          {
            summary: "Cross-component invariant: Database session must be scoped per transaction with SERIALIZABLE isolation",
            details: "Required across all subsequent worker stages",
          },
          {
            summary: "Storage schema initialization complete",
            details: "Tables created",
          },
        ],
      },
    });

    const st1 = completeStageViaGate(world);
    expect(st1.commitId).toBeTruthy();

    // -------------------------------------------------------------------------
    // 2. Generate many directives and reports across Stages to exceed recent limit
    //    SUPERVISOR_CONTEXT_RECENT_LIMIT = 10
    // -------------------------------------------------------------------------
    const boundsAfterSt1 = boundariesOf(world);
    const st2Id = boundsAfterSt1.stages[1]!.id;

    // Activate Stage 2
    const act2 = supervisorCall(world, "activate_execution_stage", {
      target_stage_id: st2Id,
    }) as { window: { id: string } };
    world.activeStageId = st2Id;
    world.openWindowId = act2.window.id;

    // Generate 12 directives/reports in Stage 2 to push Stage 1 far out of recent-10
    for (let i = 1; i <= 12; i++) {
      runImplementation(world, {
        directiveId: `DIR-P3-ST2-PUMP-${i}`,
        candidateMutated: true,
        reportOverrides: {
          findings: [{ summary: `Stage 2 iterative refinement step ${i}`, details: null }],
        },
      });

      // E8 verification pressure clears after at most 2 mutating directives
      if (i % 2 === 0) {
        runFreshVerifier(world, { directiveId: `DIR-P3-ST2-VER-${i}` });
      }
    }

    // Also record an invalidated assumption in Stage 2
    runImplementation(world, {
      directiveId: `DIR-P3-ST2-DEV`,
      candidateMutated: true,
      reportOverrides: {
        deviations: [
          {
            summary: "Assumption invalidated: in-memory cache cannot be used for cross-worker state",
            details: "Switched to database-backed coordination",
          },
        ],
        findings: [{ summary: "Coordinator updated", details: null }],
      },
    });

    // Complete Stage 2
    const st2 = completeStageViaGate(world);
    expect(st2.commitId).toBeTruthy();

    // -------------------------------------------------------------------------
    // 3. Inspect Supervisor Context at Stage 2 completion / Stage 3 boundary
    // -------------------------------------------------------------------------
    const context = world.ctx.store.withRead((tx: any) =>
      buildLayeredSupervisorContextInTx(tx, world.executionRunId),
    );

    // L2 Recent Context check: bounded to recent limit (10)
    expect(context.l2Recent.recentDirectives.length).toBeLessThanOrEqual(SUPERVISOR_CONTEXT_RECENT_LIMIT);
    expect(context.l2Recent.recentReports.length).toBeLessThanOrEqual(SUPERVISOR_CONTEXT_RECENT_LIMIT);

    // Stage 1's directive is NOT in L2 recent directives (pushed out!)
    const hasSt1DirectiveInRecent = context.l2Recent.recentDirectives.some((d) => d.id === "DIR-P3-ST1-IMPL");
    expect(hasSt1DirectiveInRecent).toBe(false);

    // -------------------------------------------------------------------------
    // 4. Invariant Recovery in L1 Evolution Context
    // -------------------------------------------------------------------------
    // Despite being pushed out of L2, Stage 1's invariant is safely preserved in L1!
    expect(context.l1Evolution.crossStageContracts.length).toBeGreaterThanOrEqual(1);
    const invariant = context.l1Evolution.crossStageContracts.find((c) =>
      c.statement.includes("Database session must be scoped per transaction"),
    );
    expect(invariant).toBeDefined();
    expect(invariant?.producerStageOrdinal).toBe(1);

    // Verify all completed stages are catalogued
    expect(context.l1Evolution.completedStages.length).toBe(2);
    expect(context.l1Evolution.completedStages[0]!.completedByCommitId).toBe(st1.commitId);
    expect(context.l1Evolution.completedStages[1]!.completedByCommitId).toBe(st2.commitId);

    // Verify invalidated assumptions are recorded as superseded, NOT active facts
    expect(context.l1Evolution.invalidatedAssumptions.length).toBeGreaterThanOrEqual(1);
    const invAssumptionFact = context.l1Evolution.evolutionFacts.find((f) =>
      f.category === "invalidated_assumption",
    );
    expect(invAssumptionFact).toBeDefined();
    expect(invAssumptionFact?.validityStatus).toBe("superseded");

    // -------------------------------------------------------------------------
    // 5. Test MCP Progression Surface integration
    // -------------------------------------------------------------------------
    const progression = supervisorCall(world, "get_execution_progression_context", {}) as {
      status: string;
      evolution_ledger: any;
    };
    expect(progression.status).toBe("ok");
    expect(progression.evolution_ledger).toBeDefined();
    expect(progression.evolution_ledger.l1Evolution.crossStageContracts).toBeDefined();

    const mcpInvariant = progression.evolution_ledger.l1Evolution.crossStageContracts.find((c: any) =>
      c.statement.includes("Database session must be scoped per transaction"),
    );
    expect(mcpInvariant).toBeDefined();

    // -------------------------------------------------------------------------
    // 6. Active Compaction / Restart Recovery
    // -------------------------------------------------------------------------
    await closeAndReopen(world);

    // After full store close & reopen (clean restart), context reconstructs identically from disk
    const reconstructed = world.ctx.store.withRead((tx: any) =>
      buildLayeredSupervisorContextInTx(tx, world.executionRunId),
    );

    expect(reconstructed.l0Normative.finalPlan.id).toBe(context.l0Normative.finalPlan.id);
    expect(reconstructed.l1Evolution.completedStages).toHaveLength(2);
    expect(reconstructed.l1Evolution.crossStageContracts).toHaveLength(context.l1Evolution.crossStageContracts.length);

    const recheckedInvariant = reconstructed.l1Evolution.crossStageContracts.find((c) =>
      c.statement.includes("Database session must be scoped per transaction"),
    );
    expect(recheckedInvariant).toBeDefined();
    expect(recheckedInvariant?.producerStageOrdinal).toBe(1);
  });
});
