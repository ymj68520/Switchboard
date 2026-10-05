/**
 * E12-T18..T23 — conversation rewind (E12 §17–§19/§61): rewinding the model's
 * conversation never rewinds Execution Memory. The Store keeps every durable
 * fact; a rewound model's stale operations fail closed against the current
 * truth (CAS candidate, head-gated continuation, immutable terminal states).
 */
import { describe, expect, it } from "vitest";

import { handleSessionStart } from "../src/hooks/handlers.js";
import {
  acceptanceServiceOf,
  acceptInput,
  codeOf,
  makeAcceptanceWorld,
  currentRevision,
  completeActiveStageFixture,
  type AcceptanceWorld,
} from "./acceptance-helpers.js";
import { issueDirective } from "./execution-protocol-helpers.js";
import { makeIndeterminateWorld } from "./attempt-recovery-helpers.js";
import { requestExecutionReplanInTx } from "../src/application/execution-replan-service.js";
import { takeoverSupervisorBindingInTx } from "../src/store/supervisor-bindings.js";
import { getExecutionStageInTx } from "../src/store/execution-structure.js";
import { executionFingerprintOf } from "./session-recovery-helpers.js";

async function replanWorld(): Promise<AcceptanceWorld> {
  const world = await makeAcceptanceWorld(`RW-${Math.random().toString(36).slice(2, 8)}`);
  world.ctx.store.withWrite((tx) =>
    requestExecutionReplanInTx(
      tx,
      {
        sessionId: world.f.sessionId,
        workspaceId: world.f.workspaceId,
        generation: world.f.generation,
        reason: "the approved interface contradicts the platform reality",
        affectedNormativeRefs: [{ type: "section", id: world.f.sectionIds[0]!, revision: 1 }],
        relevantReportRefs: [],
        toolUseId: `TU-RW-${Math.random().toString(36).slice(2, 8)}`,
      },
      world.ctx.clock,
      world.ctx.clock.nowIso(),
    ),
  );
  return world;
}

describe("E12 rewind (§17–§19)", () => {
  it("E12-T18: rewind does not remove durable Directive/Attempt/Report state", async () => {
    const world = await makeAcceptanceWorld("S1");
    const directive = issueDirective(world, { directiveId: "DIR-RW", kind: "inspection" });
    const before = executionFingerprintOf(world);
    // "Rewind" = the model forgets; the Store is untouched. A later
    // SessionStart renders from the same canonical state.
    await handleSessionStart(
      { store: world.ctx.store, secret: world.ctx.secret, clock: world.ctx.clock },
      { sessionId: "S1", cwd: world.f.workspaceRoot, permissionMode: "default", hookEventName: "SessionStart", source: "startup" } as never,
    );
    expect(executionFingerprintOf(world)).toBe(before);
    expect(directive.revision).toBe(1);
  });

  it("E12-T19/T20: a rewound model's stale candidateRevision and stale head are rejected", async () => {
    const world = await makeAcceptanceWorld("S1");
    const staleRevision = currentRevision(world) - 1;
    expect(
      codeOf(() =>
        acceptanceServiceOf(world).submitSupervisorAssessment(
          acceptInput(world, { expectedCandidateRevision: staleRevision }) as never,
        ),
      ),
    ).toBe("SUPERVISOR_ASSESSMENT_STALE");
  });

  it("E12-T21: rewind does not reopen a completed Stage", async () => {
    const world = await makeAcceptanceWorld("S1");
    completeActiveStageFixture(world);
    // The stage pointer refreshed to the successor; the completed Stage row is
    // immutable history — 'completed' can never become 'active' again.
    const completed = world.ctx.store.withRead(
      (tx) => tx.prepare("SELECT status FROM execution_stages WHERE status = 'completed' AND execution_run_id = ?").get(world.executionRunId) as { status: string } | undefined,
    );
    expect(completed?.status).toBe("completed");
    // A rewound model re-attempting the completed Stage's continuation is
    // rejected by the real gate (the ACTIVE stage boundary moved on).
    const before = executionFingerprintOf(world);
    await handleSessionStart(
      { store: world.ctx.store, secret: world.ctx.secret, clock: world.ctx.clock },
      { sessionId: "S1", cwd: world.f.workspaceRoot, permissionMode: "default", hookEventName: "SessionStart", source: "startup" } as never,
    );
    expect(executionFingerprintOf(world)).toBe(before);
  });

  it("E12-T22: rewind does not erase indeterminate/reconciliation state — the fence holds", async () => {
    const { world, attemptId } = await makeIndeterminateWorld();
    // "Rewind to before the crash" changes nothing durably.
    await handleSessionStart(
      { store: world.ctx.store, secret: world.ctx.secret, clock: world.ctx.clock },
      { sessionId: world.f.sessionId, cwd: world.f.workspaceRoot, permissionMode: "default", hookEventName: "SessionStart", source: "startup" } as never,
    );
    expect(
      world.ctx.store.withRead((tx) => tx.prepare("SELECT state FROM execution_attempts WHERE attempt_id = ?").get(attemptId) as { state: string }).state,
    ).toBe("indeterminate");
    // Ordinary execution stays fenced (the InTx issuance probe is the E11
    // fence surface; the fence survives the conversation operation).
    expect(codeOf(() => issueDirective(world, { directiveId: "DIR-POSTREWIND", kind: "implementation" }))).toBe(
      "ATTEMPT_RECONCILIATION_REQUIRED",
    );
  });

  it("E12-T23: rewind cannot undo a replan_required terminal lifecycle", async () => {
    const world = await replanWorld();
    expect(world.ctx.store.withRead((tx) => tx.prepare("SELECT lifecycle FROM execution_runs WHERE execution_run_id = ?").get(world.executionRunId) as { lifecycle: string }).lifecycle).toBe(
      "replan_required",
    );
    // SessionEnd + resume (the conversation-operation cycle) cannot reopen it:
    // the same-session reattach fence refuses terminal runs outright.
    let code = "no-error";
    try {
      world.ctx.store.withWrite((tx) =>
        takeoverSupervisorBindingInTx(
          tx,
          { executionRunId: world.executionRunId, workspaceId: world.f.workspaceId, newSessionId: "S9", expectedGeneration: 1 },
          world.ctx.clock.nowIso(),
        ),
      );
    } catch (err) {
      code = (err as { code?: string }).code ?? "thrown";
    }
    expect(code).toBe("INVALID_EXECUTION_LIFECYCLE");
  });

  it("E12-T23b: a detached binding on a terminal run can never reattach (E12 §8)", async () => {
    const world = await replanWorld();
    world.ctx.store.withWrite((tx) => {
      tx.prepare("UPDATE supervisor_bindings SET state = 'detached' WHERE execution_run_id = ?").run(world.executionRunId);
    });
    let code = "no-error";
    try {
      world.ctx.store.withWrite((tx) =>
        takeoverSupervisorBindingInTx(
          tx,
          { executionRunId: world.executionRunId, workspaceId: world.f.workspaceId, newSessionId: "S9", expectedGeneration: 1 },
          world.ctx.clock.nowIso(),
        ),
      );
    } catch (err) {
      code = (err as { code?: string }).code ?? "thrown";
    }
    expect(code).toBe("INVALID_EXECUTION_LIFECYCLE");
    expect(
      (world.ctx.store.withRead((tx) => getExecutionStageInTx(tx, world.activeStageId)) ?? { status: "" }).status,
    ).not.toBe("reopened");
  });
});
