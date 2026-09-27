/**
 * Phase 13 §26–§29/§72/§73/§87/§98 — request_finalization end-to-end over the
 * real store, real MCP handlers, and signed host tokens: pass freezes
 * [audit + candidate + final Proposal + validation→final + one revision bump]
 * atomically; any deny writes nothing; retries replay; concurrent losers see
 * FINALIZATION_ALREADY_PREPARED; the validator is denied; the tool input
 * carries zero business fields.
 */
import { afterEach, describe, expect, it } from "vitest";

import { getPlanningRunRecord } from "../src/store/planning-runs.js";
import { getHeadCommitRecord } from "../src/store/plan-commits.js";
import { getAwaitingProposalRecord } from "../src/store/proposals.js";
import { RuntimeError } from "../src/runtime/errors.js";
import { PHASE_PLAN_TOOLS } from "../src/mcp/tools.js";
import {
  callRequestFinalization,
  callSubmitSynthesis,
  makeCleanValidationFixture,
  makeSynthesisFixture,
  minimalManifest,
  type CleanValidationFixture,
} from "./phase13-helpers.js";
import type { PhasePlanToolContext } from "../src/mcp/tools.js";

const CLEAN_FIXTURES: Array<{ f: CleanValidationFixture; ctx: PhasePlanToolContext }> = [];

async function cleanFixture(sessionId = "S1") {
  const made = await makeCleanValidationFixture(sessionId);
  CLEAN_FIXTURES.push(made);
  return made;
}

afterEach(async () => {
  for (let i = CLEAN_FIXTURES.length - 1; i >= 0; i -= 1) {
    const made = CLEAN_FIXTURES.splice(i, 1)[0];
    if (made !== undefined) {
      await made.f.close();
    }
  }
});

describe("request_finalization (§26–§29/§98)", () => {
  it("pass creates the pre-approval audit, the candidate, and the final proposal; stage validation→final; run revision +1 exactly once; HEAD unchanged", async () => {
    const { f, ctx } = await cleanFixture();
    const headBefore = getHeadCommitRecord(ctx.store, f.runId);
    const runBefore = getPlanningRunRecord(ctx.store, f.runId)!;

    const result = callRequestFinalization(ctx, f, { toolUseId: "TU-FIN-A" });

    expect(result.status).toBe("ok");
    expect(result.idempotent).toBe(false);
    expect(result.candidate.candidate_id).toMatch(/^fpc_/);
    expect(result.candidate.candidate_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.candidate.candidate_seq).toBe(1);
    expect(result.evidence_audit.audit_id).toMatch(/^evaud_/);
    expect(result.final_proposal.proposal_id).toMatch(/^PROP-/);
    expect(result.final_proposal.revision).toBe(1);
    expect(result.stage).toBe("final");
    expect(result.run_revision).toBe(runBefore.revision + 1);

    const runAfter = getPlanningRunRecord(ctx.store, f.runId)!;
    expect(runAfter.stage).toBe("final");
    expect(runAfter.revision).toBe(runBefore.revision + 1);
    const headAfter = getHeadCommitRecord(ctx.store, f.runId);
    expect(headAfter?.commitId).toBe(headBefore?.commitId);
    expect(headAfter?.resultingSnapshotId).toBe(headBefore?.resultingSnapshotId);

    const awaiting = getAwaitingProposalRecord(ctx.store, f.runId);
    expect(awaiting?.proposalId).toBe(result.final_proposal.proposal_id);
    expect(awaiting?.type).toBe("final_plan");
  });

  it("the frozen candidate is entirely server-derived (§31/§E23): exact chain identity inside the canonical payload", async () => {
    const { f, ctx } = await cleanFixture();
    const result = callRequestFinalization(ctx, f);
    ctx.store.withRead((tx) => {
      const row = tx
        .prepare("SELECT canonical_json AS canonicalJson FROM final_plan_candidates WHERE run_id = ? AND candidate_id = ?")
        .get(f.runId, result.candidate.candidate_id) as { canonicalJson: string };
      const canonical = JSON.parse(row.canonicalJson) as Record<string, unknown>;
      expect(canonical).toMatchObject({
        version: 1,
        runId: f.runId,
        synthesisInput: { inputId: f.inputId, inputHash: f.inputHash },
        synthesisManifest: { manifestId: f.manifestId, manifestHash: f.manifestHash },
        semanticValidation: { reportId: f.reportId },
      });
      expect(Array.isArray(canonical.sections)).toBe(true);
      expect(Array.isArray(canonical.evidenceScope)).toBe(true);
      // §40 — the frozen final proposal carries zero design changes.
      const proposalRow = tx
        .prepare("SELECT changes_json AS changesJson FROM proposal_revisions WHERE run_id = ? AND proposal_id = ?")
        .get(f.runId, result.final_proposal.proposal_id) as { changesJson: string };
      expect(JSON.parse(proposalRow.changesJson)).toEqual([]);
      return null;
    });
  });

  it("failure changes nothing: a dirty world gets a structured FINALIZATION_DENIED and no candidate/proposal/stage (§29/E29)", async () => {
    const base = await makeSynthesisFixture("S1");
    try {
      const { toolContextOf } = await import("./phase12-helpers.js");
      const ctx = toolContextOf(base);
      try {
        // Stage synthesis with NO validation report — the gate must deny.
        const manifest = minimalManifest(base);
        callSubmitSynthesis(ctx, base, manifest, { toolUseId: "NEG-SYN" });
        const runBefore = getPlanningRunRecord(ctx.store, base.runId)!;
        const err = (() => {
          try {
            callRequestFinalization(ctx, base, { toolUseId: "NEG-FIN" });
            return null;
          } catch (e) {
            return e;
          }
        })();
        expect(err).toBeInstanceOf(RuntimeError);
        const denied = err as RuntimeError;
        expect(denied.code).toBe("FINALIZATION_DENIED");
        const reasons = (denied.detail as { reasons: Array<{ code: string }> }).reasons;
        expect(reasons.map((r) => r.code)).toContain("SEMANTIC_VALIDATION_MISSING");

        const runAfter = getPlanningRunRecord(ctx.store, base.runId)!;
        expect(runAfter.stage).toBe(runBefore.stage);
        expect(runAfter.revision).toBe(runBefore.revision);
        ctx.store.withRead((tx) => {
          const candidates = tx
            .prepare("SELECT COUNT(*) AS n FROM final_plan_candidates WHERE run_id = ?")
            .get(base.runId) as { n: number };
          const audits = tx
            .prepare("SELECT COUNT(*) AS n FROM evidence_audit_snapshots WHERE run_id = ?")
            .get(base.runId) as { n: number };
          expect(candidates.n).toBe(0);
          expect(audits.n).toBe(0);
          return null;
        });
      } finally {
        await base.close();
      }
    } catch (err) {
      // fixture cleanup is idempotent; nothing else to do
      throw err;
    }
  });

  it("same-invocation retry is idempotent and replays the same candidate/proposal identity (§72/E66)", async () => {
    const { f, ctx } = await cleanFixture();
    const first = callRequestFinalization(ctx, f, { toolUseId: "TU-FIN-R" });
    const replay = callRequestFinalization(ctx, f, { toolUseId: "TU-FIN-R" });
    expect(replay.idempotent).toBe(true);
    expect(replay.candidate.candidate_id).toBe(first.candidate.candidate_id);
    expect(replay.candidate.candidate_hash).toBe(first.candidate.candidate_hash);
    expect(replay.final_proposal.proposal_id).toBe(first.final_proposal.proposal_id);
    expect(replay.final_proposal.proposal_hash).toBe(first.final_proposal.proposal_hash);
    // Run revision did NOT move again.
    expect(getPlanningRunRecord(ctx.store, f.runId)!.revision).toBe(first.run_revision);
  });

  it("a DIFFERENT concurrent request loses with FINALIZATION_ALREADY_PREPARED (§73/E68)", async () => {
    const { f, ctx } = await cleanFixture();
    const winner = callRequestFinalization(ctx, f, { toolUseId: "TU-FIN-W1" });
    expect(winner.status).toBe("ok");
    try {
      callRequestFinalization(ctx, f, { toolUseId: "TU-FIN-W2" });
      expect.unreachable("loser must be denied");
    } catch (err) {
      expect(err).toBeInstanceOf(RuntimeError);
      expect((err as RuntimeError).code).toBe("FINALIZATION_ALREADY_PREPARED");
      expect((err as RuntimeError).detail).toMatchObject({ candidateId: winner.candidate.candidate_id });
    }
    // Exactly one candidate and one final proposal exist.
    ctx.store.withRead((tx) => {
      const candidates = tx.prepare("SELECT COUNT(*) AS n FROM final_plan_candidates WHERE run_id = ?").get(f.runId) as { n: number };
      const proposals = tx.prepare("SELECT COUNT(*) AS n FROM proposal_final_plan_refs WHERE run_id = ?").get(f.runId) as { n: number };
      expect(candidates.n).toBe(1);
      expect(proposals.n).toBe(1);
      return null;
    });
  });

  it("the attested validator is denied (§26/E4)", async () => {
    const { f, ctx } = await cleanFixture();
    try {
      callRequestFinalization(ctx, f, {
        toolUseId: "TU-FIN-V",
        agent: { agentId: "agent_v", agentType: "phase-plan:validator" },
      });
      expect.unreachable("validator must be denied");
    } catch (err) {
      expect(err).toBeInstanceOf(RuntimeError);
      expect((err as RuntimeError).code).toBe("VALIDATOR_MUTATION_FORBIDDEN");
    }
    // Nothing was frozen.
    ctx.store.withRead((tx) => {
      expect((tx.prepare("SELECT COUNT(*) AS n FROM final_plan_candidates WHERE run_id = ?").get(f.runId) as { n: number }).n).toBe(0);
      return null;
    });
  });

  it("the tool input surface carries ZERO business fields — no bypass flags exist to reject (§27/E3)", async () => {
    const tool = PHASE_PLAN_TOOLS.find((entry) => entry.name === "request_finalization")!;
    expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false, required: ["_hostContext"] });
    expect(Object.keys(tool.inputSchema.properties as Record<string, unknown>).sort()).toEqual(["_hostContext"]);
  });

  it("request_finalization is the 14th tool (§87)", () => {
    expect(PHASE_PLAN_TOOLS).toHaveLength(15);
  });

  it("the model can never prepare a final_plan proposal (§38/§97/E30)", async () => {
    const base = await makeSynthesisFixture("S1");
    try {
      const { toolContextOf } = await import("./phase12-helpers.js");
      const ctx = toolContextOf(base);
      // prepare_proposal's schema enum already excludes final_plan; the
      // service refuses it independently (defense in depth).
      const tool = PHASE_PLAN_TOOLS.find((entry) => entry.name === "prepare_proposal")!;
      const types = (tool.inputSchema.properties as Record<string, { enum?: string[] }>).proposal_type!.enum!;
      expect(types).not.toContain("final_plan");
      const { createProposalService } = await import("../src/application/proposal-service.js");
      const service = createProposalService(ctx.store, ctx.clock);
      expect(() =>
        service.prepareProposal({
          runId: base.runId,
          workspaceId: base.workspaceId,
          sessionId: base.sessionId,
          bindingGeneration: base.generation,
          expectedRunRevision: base.runRevision,
          type: "final_plan" as never,
          scope: { kind: "architecture" },
          title: "model-authored final",
          summary: "should be impossible",
          changes: [],
          requiredEvidence: [],
          prepareRequestId: "prepare:evil",
        }),
      ).toThrowError(expect.objectContaining({ code: "PROPOSAL_TYPE_UNAVAILABLE" }));
    } finally {
      await base.close();
    }
  });
});