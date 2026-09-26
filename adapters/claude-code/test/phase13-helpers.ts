/**
 * Phase 13 test helpers: drive a Phase 12 synthesis fixture through a clean
 * validation into the finalization world, and call the finalization/final
 * approval tools through the real MCP handlers with signed host tokens.
 */
import { executePhasePlanTool, type PhasePlanToolContext } from "../src/mcp/tools.js";
import { hostToken } from "./context-helpers.js";
import { hostTokenV2 } from "./phase12-helpers.js";
import {
  callSubmitSynthesis,
  callSubmitValidation,
  inputOf,
  makeEvidenceSynthesisFixture,
  makeSynthesisFixture,
  minimalManifest,
  type EvidenceSynthesisFixture,
  type SynthesisFixture,
} from "./phase12-helpers.js";
import type { DetailFixture } from "./phase11-helpers.js";

export type { EvidenceSynthesisFixture, SynthesisFixture };

const CLEAN_FINDINGS = [
  {
    kind: "clean" as const,
    summary: "The manifest is a faithful derivation of the frozen input.",
    detail: "No unsupported facts, contradictions, or derivation gaps found.",
    subjectRefs: [],
    supportingRefs: [],
  },
];

/** Submit the minimal manifest and the [clean] validation report. */
export function driveToCleanValidation(f: SynthesisFixture, ctx: PhasePlanToolContext, sessionId = "TU"): void {
  const manifest = minimalManifest(f);
  const synthesis = callSubmitSynthesis(ctx, f, manifest, { toolUseId: `${sessionId}-SYN` });
  if (synthesis.status !== "ok") throw new Error(`synthesis failed: ${JSON.stringify(synthesis)}`);
  const validation = callSubmitValidation(
    ctx,
    f,
    { manifest_id: synthesis.manifest_id, manifest_hash: synthesis.manifest_hash, findings: CLEAN_FINDINGS },
    { toolUseId: `${sessionId}-VAL`, agent: { agentId: "agent_v", agentType: "phase-plan:validator" } },
  );
  if (!validation.is_clean) throw new Error("fixture validation was not clean");
}

/** A SynthesisFixture driven to a clean validation (stage final NOT yet set). */
export interface CleanValidationFixture extends SynthesisFixture {
  manifestId: string;
  manifestHash: string;
  reportId: string;
}

export async function makeCleanValidationFixture(
  sessionId = "S1",
): Promise<{ f: CleanValidationFixture; ctx: PhasePlanToolContext }> {
  const base = await makeSynthesisFixture(sessionId);
  const { toolContextOf } = await import("./phase12-helpers.js");
  const ctx = toolContextOf(base);
  const manifest = minimalManifest(base);
  const synthesis = callSubmitSynthesis(ctx, base, manifest, { toolUseId: "FIX-SYN" });
  const validation = callSubmitValidation(
    ctx,
    base,
    { manifest_id: synthesis.manifest_id, manifest_hash: synthesis.manifest_hash, findings: CLEAN_FINDINGS },
    { toolUseId: "FIX-VAL", agent: { agentId: "agent_v", agentType: "phase-plan:validator" } },
  );
  return {
    f: {
      ...base,
      manifestId: synthesis.manifest_id,
      manifestHash: synthesis.manifest_hash,
      reportId: validation.report_id,
    },
    ctx,
  };
}

/** request_finalization through the MCP handler with a signed main-session V2 token. */
export function callRequestFinalization(
  ctx: PhasePlanToolContext,
  f: SynthesisFixture,
  options: { toolUseId?: string; agent?: { agentId?: string; agentType?: string }; extra?: Record<string, unknown> } = {},
) {
  const ids = { sessionId: f.sessionId, workspaceId: f.workspaceId, runId: f.runId, generation: f.generation };
  const token = hostTokenV2(ctx.secret, "request_finalization", {}, ids, {
    permissionMode: "plan",
    toolUseId: options.toolUseId ?? "TU-FIN-1",
    ...(options.agent === undefined ? {} : { agent: options.agent }),
  });
  return executePhasePlanTool(ctx, "request_finalization", {
    ...(options.extra ?? {}),
    _hostContext: token,
  }) as {
    status: string;
    idempotent: boolean;
    candidate: { candidate_id: string; candidate_seq: number; candidate_hash: string };
    evidence_audit: { audit_id: string; audit_hash: string };
    final_proposal: { proposal_id: string; revision: number; proposal_hash: string };
    stage: string;
    run_revision: number;
  };
}

/** approve_proposal through the MCP handler with a signed main-session V1 token. */
export function callApprove(
  ctx: PhasePlanToolContext,
  f: DetailFixture,
  proposal: { proposal_id: string; revision: number; proposal_hash: string },
  options: { toolUseId?: string } = {},
) {
  const ids = { sessionId: f.sessionId, workspaceId: f.workspaceId, runId: f.runId, generation: f.generation };
  const business = {
    proposal_id: proposal.proposal_id,
    proposal_revision: proposal.revision,
    proposal_hash: proposal.proposal_hash,
  };
  const token = hostToken(ctx.secret, "approve_proposal", business, ids, {
    permissionMode: "plan",
    toolUseId: options.toolUseId ?? "TU-APP-1",
  });
  return executePhasePlanTool(ctx, "approve_proposal", { ...business, _hostContext: token }) as {
    approved: boolean;
    approval_id: string;
    commit_id: string;
    snapshot_id: string;
    idempotent: boolean;
    new_run_revision: number | null;
    new_stage: string | null;
  };
}

export { inputOf, makeEvidenceSynthesisFixture, makeSynthesisFixture, minimalManifest, callSubmitSynthesis, callSubmitValidation };
