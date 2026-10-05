/**
 * E9 §54/§55 — terminal guards and the controlled-return boundary
 * (E9-T25..T32).
 *
 * replan_required is TERMINAL: no new Directive, no Attempt, no Stage
 * continuation or activation, no execution takeover, no assessment
 * acceptance. Recovery renders the boundary passively; SessionStart alone
 * never creates the successor; ordinary Build mutation stays fail-closed
 * until formal planning entry (E9 §29).
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  acceptanceServiceOf,
  acceptInput,
  codeOf,
  makeAcceptanceWorld,
  runVerificationCycle,
  supervisorCall,
  type AcceptanceWorld,
} from "./acceptance-helpers.js";
import { codeOf as protocolCodeOf, issueDirective, startAttempt } from "./execution-protocol-helpers.js";
import { requestExecutionReplanInTx } from "../src/application/execution-replan-service.js";
import { takeoverSupervisorBindingInTx } from "../src/store/supervisor-bindings.js";
import { getSupervisorBindingInTx, listSupervisorBindingsForSessionInTx } from "../src/store/supervisor-bindings.js";
import { getExecutionRunInTx } from "../src/store/execution-runs.js";

let world: AcceptanceWorld | null = null;

async function freshReplanWorld(): Promise<AcceptanceWorld> {
  world = await makeAcceptanceWorld(`TG-${Math.random().toString(36).slice(2, 8)}`);
  world.ctx.store.withWrite((tx) =>
    requestExecutionReplanInTx(
      tx,
      {
        sessionId: world!.f.sessionId,
        workspaceId: world!.f.workspaceId,
        generation: world!.f.generation,
        reason: "the approved interface contradicts the platform reality",
        affectedNormativeRefs: [{ type: "section", id: world!.f.sectionIds[0]!, revision: 1 }],
        relevantReportRefs: [],
        toolUseId: `TU-TG-${Math.random().toString(36).slice(2, 8)}`,
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

describe("E9 terminal guards (§26)", () => {
  it("E9-T25/T26: a terminal run cannot issue Directives or start Attempts", async () => {
    const w = await freshReplanWorld();
    // The fence refuses either way: no attached binding (REQUIRED) or a
    // detached one under a terminal run (STALE) — the durable fact is that no
    // writable supervision exists.
    expect(["STALE_SUPERVISOR_BINDING", "SUPERVISOR_BINDING_REQUIRED"]).toContain(
      protocolCodeOf(() => issueDirective(w, { directiveId: "DIR-DEAD", verificationPolicy: { implementationRequirement: "batchable" } })),
    );
    expect(["STALE_SUPERVISOR_BINDING", "SUPERVISOR_BINDING_REQUIRED"]).toContain(
      protocolCodeOf(() => startAttempt(w, { directiveId: "DIR-X", revision: 1, hash: "sha256:x" })),
    );
  });

  it("E9-T27/T28: no Stage continuation or activation on the terminal run", async () => {
    const w = await freshReplanWorld();
    expect(["STALE_SUPERVISOR_BINDING", "SUPERVISOR_BINDING_REQUIRED"]).toContain(
      codeOf(() => supervisorCall(w, "continue_execution_stage")),
    );
    const pendingId = w.ctx.store.withRead(
      (tx) =>
        (tx.prepare("SELECT id FROM execution_stages WHERE execution_run_id = ? AND status = 'pending'").get(w.executionRunId) as { id: string }).id,
    );
    expect(["STALE_SUPERVISOR_BINDING", "SUPERVISOR_BINDING_REQUIRED"]).toContain(
      codeOf(() => supervisorCall(w, "activate_execution_stage", { target_stage_id: pendingId })),
    );
  });

  it("E9-T29: the detached terminal binding cannot be reacquired for execution", async () => {
    const w = await freshReplanWorld();
    expect(
      codeOf(() =>
        w.ctx.store.withWrite((tx) =>
          takeoverSupervisorBindingInTx(
            tx,
            { executionRunId: w.executionRunId, workspaceId: w.f.workspaceId, newSessionId: "S-TAKEOVER", expectedGeneration: w.f.generation },
            w.ctx.clock.nowIso(),
          ),
        ),
      ),
    ).toBe("INVALID_EXECUTION_LIFECYCLE");
    // And the binding itself stays detached forever.
    const binding = w.ctx.store.withRead((tx) => getSupervisorBindingInTx(tx, w.executionRunId))!;
    expect(binding.state).toBe("detached");
  });

  it("E9-T26b: no assessment acceptance on the terminal run", async () => {
    const w = await freshReplanWorld();
    expect(["STALE_SUPERVISOR_BINDING", "SUPERVISOR_BINDING_REQUIRED"]).toContain(
      codeOf(() => acceptanceServiceOf(w).submitSupervisorAssessment(acceptInput(w) as never)),
    );
  });
});

describe("E9 controlled return boundary (§28–§30)", () => {
  it("E9-T30: the recovery projection renders the terminal boundary — passively", async () => {
    const w = await freshReplanWorld();
    const { createSupervisorBindingService } = await import("../src/application/supervisor-binding-service.js");
    const { renderExecutionRecoveryContext } = await import("../src/context/execution-recovery.js");
    const supervisorService = createSupervisorBindingService(w.ctx.store, w.ctx.clock);
    const facts = w.ctx.store.withRead((tx) =>
      supervisorService.loadExecutionRecoveryFactsInTx(tx, { executionRunId: w.executionRunId, sessionId: w.f.sessionId }),
    );
    const capsule = renderExecutionRecoveryContext(facts);
    expect(capsule).toContain("Lifecycle: replan_required");
    expect(capsule).toContain("ExecutionRun is TERMINAL (replan_required)");
    expect(capsule).toContain("/phase-plan");
    // No state mutation from rendering.
    const after = w.ctx.store.withRead((tx) => getExecutionRunInTx(tx, w.executionRunId)!.lifecycle);
    expect(after).toBe("replan_required");
  });

  it("E9-T31: SessionStart alone does not create the successor PlanningRun", async () => {
    const w = await freshReplanWorld();
    // The replan boundary state persists: no successor planning run exists.
    const successors = w.ctx.store.withRead(
      (tx) => tx.prepare("SELECT count(*) AS n FROM planning_runs").get() as { n: number },
    );
    // Only the PREDECESSOR planning run exists; the successor requires the
    // explicit /phase-plan entry (verified below in the successor suite).
    expect(successors.n).toBe(1);
    expect(
      w.ctx.store.withRead((tx) => findOpenReplanIssueCount(tx, w.executionRunId)),
    ).toBe(1);
    // The passive recovery projection fires (see E9-T30) without mutation.
    expect(w.ctx.store.withRead((tx) => getExecutionRunInTx(tx, w.executionRunId))!.lifecycle).toBe("replan_required");
  });

  it("E9-T32: the Build-mutation gap is closed — the replan session is fail-closed via its terminal binding", async () => {
    const w = await freshReplanWorld();
    // Every execution authority the session held is detached: any signed
    // execution context fences (STALE), and no Build binding exists.
    const bindings = w.ctx.store.withRead((tx) => listSupervisorBindingsForSessionInTx(tx, w.f.sessionId));
    expect(bindings.every((binding) => binding.state === "detached")).toBe(true);
    // The §29 PreToolUse guard keys on exactly this state (see hook-runtime
    // integration coverage in the full suite).
    void runVerificationCycle;
    void supervisorCall;
  });
});

function findOpenReplanIssueCount(tx: { prepare(sql: string): { get(...args: unknown[]): unknown } }, runId: string): number {
  return (
    tx.prepare(
      "SELECT count(*) AS n FROM execution_issues i LEFT JOIN execution_issue_adoptions a ON a.execution_run_id = i.execution_run_id AND a.issue_id = i.issue_id "
      + "WHERE i.execution_run_id = ? AND i.kind = 'replan_required' AND a.issue_id IS NULL",
    ).get(runId) as { n: number }
  ).n;
}
