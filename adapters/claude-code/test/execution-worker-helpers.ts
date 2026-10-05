/**
 * Shared fixtures for the v0.2.0 E5 ExecutionWorker runtime focused tests.
 *
 * A "worker world" is the full E1→E4 baseline plus one issued Directive, one
 * started Attempt, and one prepared launch package (one-time token in hand).
 */
import {
  createExecutionDirectiveService,
  type IssueExecutionDirectiveInput,
} from "../src/application/execution-directive-service.js";
import {
  startWorkerAttemptAndPrepareLaunchInTx,
  type PreparedWorkerLaunch,
} from "../src/application/worker-runtime-service.js";
import { buildWorkerHostContextEnvelope, encodeWorkerHostContextToken } from "../src/host/worker-context.js";
import { businessInputHashOf } from "../src/host/host-context.js";
import { executePhasePlanTool } from "../src/mcp/tools.js";
import {
  directiveInput,
  makeActiveExecutionWorld,
  type E4World,
} from "./execution-protocol-helpers.js";
import type { ExecutionDirective } from "../src/core/execution-directive.js";

export interface WorkerWorld extends E4World {
  directive: ExecutionDirective;
  attempt: { attemptId: string; workerRole: "executor" | "verifier"; state: string };
  launch: PreparedWorkerLaunch;
}

/** E4 world + issued Directive + started Attempt + prepared launch. */
export async function makeWorkerWorld(
  sessionId = "S1",
  overrides: Partial<IssueExecutionDirectiveInput> = {},
): Promise<WorkerWorld> {
  const base = await makeActiveExecutionWorld(sessionId);
  const service = createExecutionDirectiveService(base.ctx.store, base.ctx.clock);
  const input = directiveInput(base, { directiveId: "DIR-W", ...overrides });
  const directive = service.issueExecutionDirective(input);
  const { attempt, launch } = base.ctx.store.withWrite((tx) =>
    startWorkerAttemptAndPrepareLaunchInTx(
      tx,
      {
        executionRunId: base.executionRunId,
        sessionId: base.f.sessionId,
        workspaceId: base.f.workspaceId,
        generation: base.f.generation,
        directiveId: directive.directiveId,
        directiveRevision: directive.revision,
        directiveHash: directive.hash,
        workerRole: input.kind === "verification" ? "verifier" : "executor",
      },
      base.ctx.clock,
      base.ctx.clock.nowIso(),
    ),
  );
  return { ...base, directive, attempt, launch };
}

export interface WorkerSession {
  sessionId: string;
  agentId: string;
  workspaceId: string;
}

/** A fresh ExecutionWorker subagent identity (each spawn is a fresh session). */
export function freshWorkerSession(world: Pick<WorkerWorld, "f">, name = "W1"): WorkerSession {
  return {
    sessionId: `worker-session-${name}`,
    agentId: `agent-${name}`,
    workspaceId: world.f.workspaceId,
  };
}

/** Sign a worker host-context token exactly as the PreToolUse hook would. */
export function workerToken(
  ctx: WorkerWorld["ctx"],
  session: WorkerSession,
  tool: string,
  business: Record<string, unknown> = {},
  toolUseId = "TU-WORKER",
): string {
  return encodeWorkerHostContextToken(
    ctx.secret,
    buildWorkerHostContextEnvelope({
      sessionId: session.sessionId,
      workspaceId: session.workspaceId,
      agent: { agentId: session.agentId, agentType: "phase-plan:execution-worker" },
      permissionMode: "default",
      toolUseId,
      toolName: `mcp__plugin_phase-plan_phase-plan__${tool}`,
      businessInputHash: businessInputHashOf(business),
    }),
  );
}

/** Drive a worker MCP tool call through the real dispatcher. */
export function callWorkerTool(
  world: Pick<WorkerWorld, "ctx">,
  session: WorkerSession,
  tool: string,
  business: Record<string, unknown> = {},
): Record<string, unknown> {
  return executePhasePlanTool(world.ctx, tool, {
    ...business,
    _hostContext: workerToken(world.ctx, session, tool, business),
  }) as Record<string, unknown>;
}

export function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as { code?: string }).code ?? "no-error";
  }
  return "no-error";
}

export type { PreparedWorkerLaunch };
