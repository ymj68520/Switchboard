/**
 * E13-T1..T6/T44..T47 — human authorization IS the abort authority.
 *
 * The model can never produce active → aborted merely by calling the MCP
 * tool: the PreToolUse hook ASKS (never allows), the mandatory host dialog
 * decides, and the durable `mcp-control:<toolUseId>` run-control record is
 * the only thing the abort service trusts (the SAME mechanism as takeover_run
 * — E13 §4). Abort is a control-plane exception (§6): no supervisor binding
 * or generation is required; workers can never request it (§7); a user
 * rejection means the tool never runs (§11).
 */
import { describe, expect, it } from "vitest";

import { handlePreToolUse } from "../src/hooks/handlers.js";
import { executePhasePlanTool } from "../src/mcp/tools.js";
import { codeOf, makeAcceptanceWorld, supervisorCall } from "./acceptance-helpers.js";
import { freshWorkerSession } from "./execution-worker-helpers.js";
import { directiveProbeBusiness } from "./session-recovery-helpers.js";
import {
  bindingOf,
  depsOf,
  executionFingerprintOf,
  explicitExecutionAbort,
  lifecycleOf,
} from "./session-recovery-helpers.js";

function codeOfSync(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as { code?: string }).code ?? "no-error";
  }
  return "no-error";
}

describe("E13 human authorization (§4/§7/§9/§10/§11)", () => {
  it("E13-T1: the model alone cannot abort — the hook ASKS and unsigned calls fail closed", async () => {
    const world = await makeAcceptanceWorld("S1");
    // (a) A direct MCP call without a signed host context fails closed —
    // there is no host dialog, so there is no authorization.
    expect(codeOfSync(() => executePhasePlanTool(world.ctx, "abort_execution_run", { run_id: world.executionRunId, reason: "model-only" }))).toBe(
      "HOST_CONTEXT_REQUIRED",
    );
    // (b) Even with the signed envelope the PreToolUse hook never allows:
    // the mandatory dialog decides (E13 §4).
    const out = await handlePreToolUse(
      depsOf(world),
      {
        sessionId: "S1",
        cwd: world.f.workspaceRoot,
        permissionMode: "default",
        hookEventName: "PreToolUse",
        toolName: "mcp__plugin_phase-plan_phase-plan__abort_execution_run",
        toolInput: { run_id: world.executionRunId, reason: "please stop" },
        toolUseId: "TU-E13-T1",
      } as never,
    );
    const payload = JSON.stringify(out);
    expect(payload).toContain('"permissionDecision":"ask"');
    expect(payload).not.toContain('"permissionDecision":"allow"');
    // Nothing was mutated: the run is still active.
    expect(lifecycleOf(world)).toBe("active");
  });

  it("E13-T2: a user rejection is zero Store mutation — no abort record, no event, binding unchanged", async () => {
    const world = await makeAcceptanceWorld("S1");
    const before = executionFingerprintOf(world);
    // Rejection = the tool call never executes; the only observable hook
    // outcome is the ask decision. The Store must be identical either way.
    const out = await handlePreToolUse(
      depsOf(world),
      {
        sessionId: "S1",
        cwd: world.f.workspaceRoot,
        permissionMode: "default",
        hookEventName: "PreToolUse",
        toolName: "mcp__plugin_phase-plan_phase-plan__abort_execution_run",
        toolInput: { run_id: world.executionRunId, reason: "rejected request" },
        toolUseId: "TU-E13-T2",
      } as never,
    );
    expect(JSON.stringify(out)).toContain('"permissionDecision":"ask"');
    expect(executionFingerprintOf(world)).toBe(before);
    const events = world.ctx.store.withRead(
      (tx) => tx.prepare("SELECT count(*) AS n FROM execution_run_events WHERE execution_run_id = ? AND event_type = 'ABORTED'").get(world.executionRunId) as { n: number },
    );
    expect(events.n).toBe(0);
    const records = world.ctx.store.withRead(
      (tx) => tx.prepare("SELECT count(*) AS n FROM execution_abort_records").get() as { n: number },
    );
    expect(records.n).toBe(0);
  });

  it("E13-T3: valid user approval aborts the EXACT authorized run", async () => {
    const world = await makeAcceptanceWorld("S1");
    const result = explicitExecutionAbort(world, { reason: "user says stop" });
    expect(result.executionRun.lifecycle).toBe("aborted");
    expect(result.idempotent).toBe(false);
    expect(lifecycleOf(world)).toBe("aborted");
    // The durable authorization record exists and is bound to this run.
    // A1 §49 — the authorization record is canonically scoped by the
    // ExecutionRunID; run_id keeps the planning provenance.
    const control = world.ctx.store.withRead(
      (tx) => tx.prepare("SELECT execution_run_id AS runId, run_id AS planningRunId, operation FROM run_control_authorizations WHERE control_id = ?").get(result.controlId) as { runId: string; planningRunId: string; operation: string },
    );
    expect(control).toMatchObject({ runId: world.executionRunId, planningRunId: world.f.runId, operation: "abort" });
  });

  it("E13-T4: an authorization can never serve a different run — the hash pins the exact target", async () => {
    const { runControlRequestHash } = await import("../src/store/run-control.js");
    const { createExecutionAbortService } = await import("../src/application/execution-abort-service.js");
    const world = await makeAcceptanceWorld("S1");
    // A second active run in the same workspace — created AFTER run A's
    // abort (A1 §28: one non-terminal world per workspace at any moment).
    const { cloneActiveRunInTx } = await import("./session-recovery-helpers.js");
    // Abort run A through operation TU-A (a fresh, real dialog record).
    const first = explicitExecutionAbort(world, { reason: "abort A", toolUseId: "TU-E13-T4-A" });
    cloneActiveRunInTx(world, "plan-e13-B");
    expect(first.executionRun.lifecycle).toBe("aborted");
    // The SAME operation id replaying with a hash that names run B is
    // refused: human approval of one run never authorizes another (E13 §9).
    expect(
      codeOfSync(() =>
        createExecutionAbortService(world.ctx.store, world.ctx.clock).abortExecutionRun({
          executionRunId: "plan-e13-B-EXEC",
          workspaceId: world.f.workspaceId,
          requesterSessionId: "S1",
          reason: "replay against another run",
          authorization: {
            authorizationRequestId: "mcp-control:TU-E13-T4-A",
            operationId: "abort-execution:TU-E13-T4-A",
            requestHash: runControlRequestHash({ operation: "abort", targetKind: "execution_run", executionRunId: "plan-e13-B-EXEC", workspaceId: world.f.workspaceId, expectedBindingGeneration: 1 }),
          },
        }),
      ),
    ).toBe("IDEMPOTENCY_CONFLICT");
    expect(lifecycleOf(world, "plan-e13-B-EXEC")).toBe("active");
  });

  it("E13-T5: replay converges on the same durable terminal result — never a second abort fact", async () => {
    const world = await makeAcceptanceWorld("S1");
    const first = explicitExecutionAbort(world, { reason: "stop", toolUseId: "TU-E13-T5" });
    const retry = explicitExecutionAbort(world, { reason: "stop", toolUseId: "TU-E13-T5" });
    expect(retry.idempotent).toBe(true);
    expect(retry.controlId).toBe(first.controlId);
    expect(retry.executionRun.lifecycle).toBe("aborted");
    const records = world.ctx.store.withRead(
      (tx) => tx.prepare("SELECT count(*) AS n FROM execution_abort_records WHERE execution_run_id = ?").get(world.executionRunId) as { n: number },
    );
    expect(records.n).toBe(1);
  });

  it("E13-T6: an ExecutionWorker can never request or perform the abort", async () => {
    const world = await makeAcceptanceWorld("S1");
    const worker = freshWorkerSession(world, "W1");
    // The MCP control surface denies worker attestations (E13 §7): the
    // PreToolUse branch signs the worker's agent fields into the V2 envelope
    // exactly as the hook would, and assertMainSessionControl denies any
    // attested subagent context at the control surface.
    const { encodeHostContextTokenV2, buildHostContextEnvelopeV2, businessInputHashOf } = await import(
      "../src/host/host-context.js"
    );
    const business = { run_id: world.executionRunId, reason: "worker trying to stop the run" };
    const workerEnvelopeToken = encodeHostContextTokenV2(world.ctx.secret, buildHostContextEnvelopeV2({
      sessionId: worker.sessionId,
      workspaceId: world.f.workspaceId,
      permissionMode: "default",
      toolUseId: "TU-E13-T6",
      toolName: "mcp__plugin_phase-plan_phase-plan__abort_execution_run",
      businessInputHash: businessInputHashOf(business),
      agent: { agentId: worker.agentId, agentType: "phase-plan:execution-worker" },
    }));
    expect(
      codeOfSync(() =>
        executePhasePlanTool(world.ctx, "abort_execution_run", { ...business, _hostContext: workerEnvelopeToken }),
      ),
    ).toBe("VALIDATOR_MUTATION_FORBIDDEN");
    expect(lifecycleOf(world)).toBe("active");
  });
});

describe("E13 non-owner control (§35/§36/§73)", () => {
  it("E13-T44: a non-owner session cannot ordinary-mutate the run", async () => {
    const world = await makeAcceptanceWorld("S1");
    // The non-owner host guard denies direct repo mutation (E12 §30).
    const out = await handlePreToolUse(
      depsOf(world),
      {
        sessionId: "S2-RECOVERY",
        cwd: world.f.workspaceRoot,
        permissionMode: "default",
        hookEventName: "PreToolUse",
        toolName: "Write",
        toolInput: { file_path: "src/x.ts" },
        toolUseId: "TU-E13-T44",
      } as never,
    );
    expect(JSON.stringify(out)).toContain("EXECUTION_SESSION_NOT_OWNER");
    // And supervisor mutations fail the authority check.
    expect(codeOf(() => supervisorCall(world, "issue_execution_directive", directiveProbeBusiness(world) as never, "S2-RECOVERY"))).toBe(
      "STALE_SUPERVISOR_BINDING",
    );
  });

  it("E13-T45: the SAME non-owner session reaches the human abort dialog", async () => {
    const world = await makeAcceptanceWorld("S1");
    const out = await handlePreToolUse(
      depsOf(world),
      {
        sessionId: "S2-RECOVERY",
        cwd: world.f.workspaceRoot,
        permissionMode: "default",
        hookEventName: "PreToolUse",
        toolName: "mcp__plugin_phase-plan_phase-plan__abort_execution_run",
        toolInput: { run_id: world.executionRunId, reason: "owner is gone" },
        toolUseId: "TU-E13-T45",
      } as never,
    );
    expect(JSON.stringify(out)).toContain('"permissionDecision":"ask"');
  });

  it("E13-T46: without approval there is no abort — an unsigned recovery-session call fails closed", async () => {
    const world = await makeAcceptanceWorld("S1");
    // A model-supplied call with no signed host context (no dialog happened)
    // never reaches the Store.
    const tokenless = codeOfSync(() =>
      executePhasePlanTool(world.ctx, "abort_execution_run", { run_id: world.executionRunId, reason: "no dialog" }),
    );
    expect(tokenless).toBe("HOST_CONTEXT_REQUIRED");
    expect(lifecycleOf(world)).toBe("active");
    expect(bindingOf(world)).toMatchObject({ state: "attached", generation: 1 });
  });

  it("E13-T47: with approval the exact run aborts from the non-owner session — human control ≠ supervisor authority", async () => {
    const world = await makeAcceptanceWorld("S1");
    const result = explicitExecutionAbort(world, { requesterSessionId: "S2-RECOVERY", reason: "owner gone, user stopped it" });
    expect(result.executionRun.lifecycle).toBe("aborted");
    const record = world.ctx.store.withRead(
      (tx) => tx.prepare("SELECT requested_by_session_id AS s FROM execution_abort_records WHERE execution_run_id = ?").get(world.executionRunId) as { s: string },
    );
    expect(record.s).toBe("S2-RECOVERY");
    // The non-owner still has NO supervisor mutation authority afterwards —
    // the run is terminal and every mutation surface is closed.
    expect(codeOf(() => supervisorCall(world, "issue_execution_directive", directiveProbeBusiness(world) as never, "S2-RECOVERY"))).toBe(
      "SUPERVISOR_BINDING_REQUIRED",
    );
  });

  it("E13-T36b: a stale former supervisor may request the abort (§36)", async () => {
    const world = await makeAcceptanceWorld("S1");
    // Detach S1 (its SessionEnd) — the fenced former owner can no longer
    // mutate, but the human-authorized abort request still works.
    const { handleSessionEnd } = await import("../src/hooks/handlers.js");
    handleSessionEnd(depsOf(world), { sessionId: "S1", hookEventName: "SessionEnd", reason: "prompt_input_exit" } as never);
    expect(codeOf(() => supervisorCall(world, "issue_execution_directive", directiveProbeBusiness(world) as never, "S1"))).toBe(
      "SUPERVISOR_BINDING_REQUIRED",
    );
    const result = explicitExecutionAbort(world, { requesterSessionId: "S1", reason: "former owner, user approved" });
    expect(result.executionRun.lifecycle).toBe("aborted");
  });
});
