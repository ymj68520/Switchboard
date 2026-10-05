/**
 * E12-T36..T40 — the non-owner main-session host guard (E12 §30–§33/§65):
 * while an active supervised ExecutionRun owns the workspace, a main session
 * without Supervisor authority is denied ordinary execution mutation and
 * arbitrary subagent launches; claimed ExecutionWorkers are structurally
 * unaffected (their authority is the invocation binding, never the
 * SupervisorBinding); Phase Plan reads and recovery stay available.
 */
import { describe, expect, it } from "vitest";

import { handlePreToolUse } from "../src/hooks/handlers.js";
import { makeAcceptanceWorld, type AcceptanceWorld } from "./acceptance-helpers.js";
import { freshWorkerSession } from "./execution-worker-helpers.js";
import { issueDirective } from "./execution-protocol-helpers.js";
import { effectfulEnvelope } from "./attempt-recovery-helpers.js";
import { startWorkerAttemptAndPrepareLaunchInTx } from "../src/application/worker-runtime-service.js";
import { claimWorkerInvocationInTx } from "../src/store/worker-invocations.js";
import { depsOf } from "./session-recovery-helpers.js";

async function preTool(world: AcceptanceWorld, sessionId: string, toolName: string, toolInput: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return handlePreToolUse(
    depsOf(world),
    {
      sessionId,
      cwd: world.f.workspaceRoot,
      permissionMode: "default",
      hookEventName: "PreToolUse",
      toolName,
      toolInput,
      toolUseId: `TU-${toolName}-${sessionId}`,
      ...extra,
    } as never,
  );
}

describe("E12 non-owner host guard (§30–§33)", () => {
  it("E12-T36: non-owner direct file mutation is denied", async () => {
    const world = await makeAcceptanceWorld("S1");
    for (const tool of ["Edit", "Write", "NotebookEdit"]) {
      const out = await preTool(world, "S2-NEW", tool, { file_path: "src/x.ts" });
      expect(JSON.stringify(out), tool).toContain("EXECUTION_SESSION_NOT_OWNER");
    }
  });

  it("E12-T37: non-owner shell mutation is denied", async () => {
    const world = await makeAcceptanceWorld("S1");
    for (const tool of ["Bash", "PowerShell"]) {
      const out = await preTool(world, "S2-NEW", tool, { command: "git push --force" });
      expect(JSON.stringify(out), tool).toContain("EXECUTION_SESSION_NOT_OWNER");
    }
  });

  it("E12-T38: non-owner generic repository-working subagent launch is denied (fail closed)", async () => {
    const world = await makeAcceptanceWorld("S1");
    for (const subagent of ["general-purpose", "Explore", "phase-plan:execution-worker"]) {
      const out = await preTool(world, "S2-NEW", "Agent", { subagent_type: subagent });
      expect(JSON.stringify(out), subagent).toContain("EXECUTION_SESSION_NOT_OWNER");
    }
  });

  it("E12-T39: a claimed legitimate ExecutionWorker is NOT blocked by the guard", async () => {
    const world = await makeAcceptanceWorld("S1");
    // A claimed worker under an effect-capable Directive: its authority chain
    // is WorkerInvocationBinding + Attempt + Directive capabilities.
    const directive = issueDirective(world, { directiveId: "DIR-GUARD", kind: "implementation", capabilityEnvelope: effectfulEnvelope() as never });
    const { attempt, launch } = world.ctx.store.withWrite((tx) =>
      startWorkerAttemptAndPrepareLaunchInTx(
        tx,
        {
          executionRunId: world.executionRunId,
          sessionId: world.f.sessionId,
          workspaceId: world.f.workspaceId,
          generation: world.f.generation,
          directiveId: directive.directiveId,
          directiveRevision: directive.revision,
          directiveHash: directive.hash,
          workerRole: "executor",
        },
        world.ctx.clock,
        world.ctx.clock.nowIso(),
      ),
    );
    const session = freshWorkerSession(world, "GUARD");
    world.ctx.store.withWrite((tx) =>
      claimWorkerInvocationInTx(
        tx,
        {
          attemptId: attempt.attemptId,
          launchToken: launch.launchToken,
          workerSessionId: session.sessionId,
          workerAgentId: session.agentId,
          workspaceId: world.f.workspaceId,
          executionRunId: world.executionRunId,
        },
        world.ctx.clock.nowIso(),
      ),
    );
    const out = await handlePreToolUse(
      depsOf(world),
      {
        sessionId: session.sessionId,
        cwd: world.f.workspaceRoot,
        permissionMode: "default",
        hookEventName: "PreToolUse",
        toolName: "Edit",
        toolInput: { file_path: "src/x.ts" },
        toolUseId: "TU-WORKER-EDIT",
        agentId: session.agentId,
        agentType: "phase-plan:execution-worker",
      } as never,
    );
    // The worker reached its OWN capability surface (empty allow; the envelope
    // permits repositoryWrite) — never the non-owner denial.
    expect(out.kind).toBe("empty");
  });

  it("E12-T40: Phase Plan reads, recovery, and the takeover entry stay available", async () => {
    const world = await makeAcceptanceWorld("S1");
    // Host reads pass untouched.
    for (const tool of ["Read", "Glob", "Grep"]) {
      const out = await preTool(world, "S2-NEW", tool, { file_path: "src/x.ts" });
      expect(out.kind, tool).toBe("empty");
    }
    // The takeover flow is reachable for the non-owner main session: the
    // PreToolUse signs the V2 control context and hands the decision to the
    // mandatory host dialog.
    const takeover = await preTool(world, "S2-NEW", "mcp__plugin_phase-plan_phase-plan__takeover_run", {
      run_id: world.executionRunId,
      expected_binding_generation: 1,
    });
    expect(JSON.stringify(takeover)).toContain('"permissionDecision":"ask"');
  });
});
