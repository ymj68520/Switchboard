/**
 * Phase 14 test helpers: drive a fixture all the way to an approved FinalPlan
 * (the Phase 14 entry seam), then exercise the handoff/Build-read surfaces
 * through the real MCP handlers with signed tokens.
 */
import { executePhasePlanTool, type PhasePlanToolContext } from "../src/mcp/tools.js";
import { businessInputHashOf } from "../src/host/host-context.js";
import {
  buildExecutionHostContextEnvelope,
  encodeExecutionHostContextToken,
} from "../src/host/execution-context.js";
import { getFinalPlanInTx } from "../src/store/finalization.js";
import { hostToken } from "./context-helpers.js";
import { hostTokenV2 } from "./phase12-helpers.js";
import {
  callApprove,
  callRequestFinalization,
  makeCleanValidationFixture,
  type CleanValidationFixture,
} from "./phase13-helpers.js";

export interface ApprovedFinalPlanFixture extends CleanValidationFixture {
  finalPlanId: string;
  finalPlanHash: string;
  commitId: string;
  workspaceRoot: string;
}

/** A fixture whose run sits at lifecycle=active / stage=final with an approved FinalPlan. */
export async function makeApprovedFinalPlanFixture(
  sessionId = "S1",
): Promise<{ f: ApprovedFinalPlanFixture; ctx: PhasePlanToolContext }> {
  const { f, ctx } = await makeCleanValidationFixture(sessionId);
  const fin = callRequestFinalization(ctx, f, { toolUseId: `${sessionId}-FIN` });
  const approval = callApprove(ctx, f, {
    proposal_id: fin.final_proposal.proposal_id,
    revision: fin.final_proposal.revision,
    proposal_hash: fin.final_proposal.proposal_hash,
  }, { toolUseId: `${sessionId}-APP` });
  const row = ctx.store.withRead((tx) => getFinalPlanInTx(tx, f.runId));
  if (row === null) throw new Error("fixture failed to reach an approved FinalPlan");
  const { getWorkspaceById } = await import("../src/store/repositories.js");
  const workspace = getWorkspaceById(ctx.store, f.workspaceId);
  if (workspace === null) throw new Error("fixture workspace missing");
  return {
    f: {
      ...f,
      finalPlanId: row.finalPlanId,
      finalPlanHash: row.finalPlanHash,
      commitId: approval.commit_id,
      workspaceRoot: workspace.canonicalRoot,
    },
    ctx,
  };
}

/** handoff through the real MCP handler with a signed main-session V2 token. */
export function callHandoff(
  ctx: PhasePlanToolContext,
  f: { sessionId: string; workspaceId: string; runId: string; generation: number },
  options: { toolUseId?: string; permissionMode?: string; agent?: { agentId?: string; agentType?: string } } = {},
) {
  const ids = { sessionId: f.sessionId, workspaceId: f.workspaceId, runId: f.runId, generation: f.generation };
  const token = hostTokenV2(ctx.secret, "handoff", {}, ids, {
    permissionMode: options.permissionMode ?? "plan",
    toolUseId: options.toolUseId ?? "TU-HANDOFF-1",
    ...(options.agent === undefined ? {} : { agent: options.agent }),
  });
  return executePhasePlanTool(ctx, "handoff", { _hostContext: token }) as {
    status: string;
    idempotent?: boolean;
    handoff_id: string;
    handoff_hash: string;
    final_plan: { id: string; hash: string };
    repository_baseline: { kind: string; revision: string | null };
    execution_contract: string;
  };
}

/** Sign an EXECUTION authority token for Build read-side calls (§53–§56). */
export function executionToken(
  ctx: PhasePlanToolContext,
  input: {
    sessionId: string;
    workspaceId: string;
    runId: string;
    finalPlanId: string;
    generation: number;
    tool: string;
    toolUseId?: string;
    business?: Record<string, unknown>;
    permissionMode?: string;
  },
): string {
  const business = input.business ?? {};
  const envelope = buildExecutionHostContextEnvelope({
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    runId: input.runId,
    finalPlanId: input.finalPlanId,
    executionBindingGeneration: input.generation,
    permissionMode: input.permissionMode ?? "default",
    toolUseId: input.toolUseId ?? "TU-EXEC-1",
    toolName: `mcp__plugin_phase-plan_phase-plan__${input.tool}`,
    businessInputHash: businessInputHashOf(business),
  });
  return encodeExecutionHostContextToken(ctx.secret, envelope);
}

export { executePhasePlanTool, hostToken, hostTokenV2 };
