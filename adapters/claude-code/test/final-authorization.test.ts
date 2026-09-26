/**
 * Phase 13 §46–§52/§65–§71/§75–§77/§99–§102 — Formal Final Approval through
 * the real commit engine: the post-authorization FinalizationGate rerun, the
 * zero-design-change Final PlanCommit, the immutable FinalPlan, reopen races,
 * post-authorization source drift, and evidence replacement.
 */
import * as fs from "node:fs";
import * as nodePath from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { getPlanningRunRecord } from "../src/store/planning-runs.js";
import { RuntimeError } from "../src/runtime/errors.js";
import { getFinalPlanCandidateInTx, listFinalPlanCandidateRefsInTx } from "../src/store/finalization.js";
import {
  callApprove,
  callRequestFinalization,
  makeCleanValidationFixture,
  makeEvidenceSynthesisFixture,
} from "./phase13-helpers.js";
import type { PhasePlanToolContext } from "../src/mcp/tools.js";

const CLEAN_FIXTURES: Array<{ f: Awaited<ReturnType<typeof makeCleanValidationFixture>>["f"]; ctx: PhasePlanToolContext }> = [];

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

describe("Formal Final Approval (§46–§52/§99)", () => {
  it("approves the exact frozen final proposal: rerun gate passes, one Approval + one zero-design-change PlanCommit + one FinalPlan, HEAD advances once, run revision unchanged (§50/§51/§52/§84)", async () => {
    const { f, ctx } = await cleanFixture();
    const fin = callRequestFinalization(ctx, f, { toolUseId: "AUTH-FIN" });
    const runAfterFinalization = getPlanningRunRecord(ctx.store, f.runId)!;
    const headBefore = ctx.store.withRead((tx) =>
      tx.prepare("SELECT head_snapshot_id AS s, head_commit_id AS c FROM plan_heads WHERE run_id = ?").get(f.runId) as { s: string; c: string },
    );

    const countsBefore = ctx.store.withRead((tx) => ({
      approvals: (tx.prepare("SELECT COUNT(*) AS n FROM approvals WHERE run_id = ?").get(f.runId) as { n: number }).n,
      commits: (tx.prepare("SELECT COUNT(*) AS n FROM plan_commits WHERE run_id = ?").get(f.runId) as { n: number }).n,
    }));

    const approval = callApprove(ctx, f, fin.final_proposal, { toolUseId: "AUTH-APP" });

    expect(approval.approved).toBe(true);
    expect(approval.idempotent).toBe(false);
    // Run revision is NOT bumped by the authorization (§52/§84).
    expect(approval.new_run_revision).toBe(runAfterFinalization.revision);
    expect(approval.new_stage).toBe("final");
    // HEAD advanced exactly once through the Final PlanCommit (§47/§51).
    const headAfter = ctx.store.withRead((tx) =>
      tx.prepare("SELECT head_snapshot_id AS s, head_commit_id AS c FROM plan_heads WHERE run_id = ?").get(f.runId) as { s: string; c: string },
    );
    expect(headAfter.c).toBe(approval.commit_id);
    expect(headAfter.c).not.toBe(headBefore.c);

    ctx.store.withRead((tx) => {
      // Exactly ONE Approval and ONE PlanCommit were written by this pass
      // (the fixture's design commits predate the final authorization).
      const approvals = tx.prepare("SELECT COUNT(*) AS n FROM approvals WHERE run_id = ?").get(f.runId) as { n: number };
      const commits = tx.prepare("SELECT COUNT(*) AS n FROM plan_commits WHERE run_id = ?").get(f.runId) as { n: number };
      expect(approvals.n).toBe(countsBefore.approvals + 1);
      expect(commits.n).toBe(countsBefore.commits + 1);
      // The zero-design-change snapshot: same members as the candidate base HEAD, new id (§51).
      const finalPlan = tx.prepare("SELECT * FROM final_plans WHERE run_id = ?").get(f.runId) as Record<string, unknown>;
      expect(finalPlan).toBeDefined();
      expect(finalPlan.final_plan_id).toMatch(/^fplan_/);
      expect(finalPlan.revision).toBe(1);
      expect(finalPlan.candidate_id).toBe(fin.candidate.candidate_id);
      expect(finalPlan.proposal_id).toBe(fin.final_proposal.proposal_id);
      expect(finalPlan.approval_id).toBe(approval.approval_id);
      expect(finalPlan.commit_id).toBe(approval.commit_id);
      expect(finalPlan.snapshot_id).toBe(approval.snapshot_id);
      const memberCount = (snapshotId: string): number =>
        (tx.prepare("SELECT COUNT(*) AS n FROM snapshot_members WHERE snapshot_id = ?").get(snapshotId) as { n: number }).n;
      expect(memberCount(finalPlan.snapshot_id as string)).toBe(memberCount(headBefore.s));
      // The commit-time audit is referenced, never the pre-approval one (§34/E50).
      expect(finalPlan.audit_id).toMatch(/^evaud_/);
      expect(finalPlan.audit_id).not.toBe(fin.evidence_audit.audit_id);
      // The final proposal is approved and no longer awaiting (§50).
      const status = tx
        .prepare("SELECT status FROM proposal_states WHERE run_id = ? AND proposal_id = ?")
        .get(f.runId, fin.final_proposal.proposal_id) as { status: string };
      expect(status.status).toBe("approved");
      return null;
    });
    // The commit-time audit exists and is bound to the candidate (§34).
    ctx.store.withRead((tx) => {
      const audit = tx
        .prepare("SELECT purpose, candidate_id AS candidateId FROM evidence_audit_snapshots WHERE run_id = ? AND audit_id = ?")
        .get(f.runId, (tx.prepare("SELECT audit_id AS id FROM final_plans WHERE run_id = ?").get(f.runId) as { id: string }).id) as { purpose: string; candidateId: string | null };
      expect(audit.purpose).toBe("commit_time");
      expect(audit.candidateId).toBe(fin.candidate.candidate_id);
      return null;
    });
  });

  it("authorization replay is idempotent via the Phase 6 seam (§74/E67)", async () => {
    const { f, ctx } = await cleanFixture();
    const fin = callRequestFinalization(ctx, f, { toolUseId: "IDEM-FIN" });
    const first = callApprove(ctx, f, fin.final_proposal, { toolUseId: "IDEM-APP" });
    const replay = callApprove(ctx, f, fin.final_proposal, { toolUseId: "IDEM-APP" });
    expect(replay.idempotent).toBe(true);
    expect(replay.commit_id).toBe(first.commit_id);
    // Exactly one FinalPlan remains.
    ctx.store.withRead((tx) => {
      expect((tx.prepare("SELECT COUNT(*) AS n FROM final_plans WHERE run_id = ?").get(f.runId) as { n: number }).n).toBe(1);
      return null;
    });
  });
});

describe("post-authorization gate rerun (§3/§48/§69/§100)", () => {
  it("a source drift AFTER candidate creation denies the authorization: no Approval/Commit/FinalPlan, HEAD unchanged, proposal still awaiting (§69/E39–E41)", async () => {
    // Evidence-driven world: one critical fingerprint evidence in scope.
    const base = await makeEvidenceSynthesisFixture("S1");
    try {
      const { toolContextOf, callSubmitSynthesis, callSubmitValidation } = await import("./phase12-helpers.js");
      const ctx = toolContextOf(base);
      const manifest = (await import("./phase12-helpers.js")).minimalManifest(base);
      const synthesis = callSubmitSynthesis(ctx, base, manifest, { toolUseId: "DRIFT-SYN" });
      const cleanFindings = [
        { kind: "clean" as const, summary: "faithful", detail: "no gaps", subjectRefs: [], supportingRefs: [] },
      ];
      callSubmitValidation(
        ctx,
        base,
        { manifest_id: synthesis.manifest_id, manifest_hash: synthesis.manifest_hash, findings: cleanFindings },
        { toolUseId: "DRIFT-VAL", agent: { agentId: "agent_v", agentType: "phase-plan:validator" } },
      );
      const fin = callRequestFinalization(ctx, base, { toolUseId: "DRIFT-FIN" });
      expect(fin.stage).toBe("final");

      // THE DRIFT: the fingerprinted source file changes after the freeze.
      const workspace = (await import("../src/store/repositories.js")).getWorkspaceById(ctx.store, base.workspaceId)!;
      const sourcePath = nodePath.join(workspace.canonicalRoot, "src", "syn-ev.txt");
      fs.writeFileSync(sourcePath, "// drifted content — the frozen evidence no longer holds\n");

      const headBefore = ctx.store.withRead((tx) =>
        tx.prepare("SELECT head_snapshot_id AS s, head_commit_id AS c FROM plan_heads WHERE run_id = ?").get(base.runId) as { s: string; c: string },
      );
      const countsBeforeDenial = ctx.store.withRead((tx) => ({
        approvals: (tx.prepare("SELECT COUNT(*) AS n FROM approvals WHERE run_id = ?").get(base.runId) as { n: number }).n,
        commits: (tx.prepare("SELECT COUNT(*) AS n FROM plan_commits WHERE run_id = ?").get(base.runId) as { n: number }).n,
      }));
      expect(() => callApprove(ctx, base, fin.final_proposal, { toolUseId: "DRIFT-APP" })).toThrowError(
        expect.objectContaining({ code: "FINALIZATION_DENIED" }),
      );

      const headAfter = ctx.store.withRead((tx) =>
        tx.prepare("SELECT head_snapshot_id AS s, head_commit_id AS c FROM plan_heads WHERE run_id = ?").get(base.runId) as { s: string; c: string },
      );
      expect(headAfter.c).toBe(headBefore.c);
      ctx.store.withRead((tx) => {
        expect((tx.prepare("SELECT COUNT(*) AS n FROM approvals WHERE run_id = ?").get(base.runId) as { n: number }).n).toBe(countsBeforeDenial.approvals);
        expect((tx.prepare("SELECT COUNT(*) AS n FROM plan_commits WHERE run_id = ?").get(base.runId) as { n: number }).n).toBe(countsBeforeDenial.commits);
        expect((tx.prepare("SELECT COUNT(*) AS n FROM final_plans WHERE run_id = ?").get(base.runId) as { n: number }).n).toBe(0);
        const status = tx
          .prepare("SELECT status FROM proposal_states WHERE run_id = ? AND proposal_id = ?")
          .get(base.runId, fin.final_proposal.proposal_id) as { status: string };
        expect(status.status).toBe("awaiting_approval");
        return null;
      });
      // §49/§11 — the discovered source change persisted as a system fact
      // even though the authorization was denied.
      ctx.store.withRead((tx) => {
        const event = tx
          .prepare(
            "SELECT COUNT(*) AS n FROM evidence_validation_events WHERE run_id = ? AND event_type = 'SOURCE_CHANGED' AND reason_code = 'revalidation_check_changed'",
          )
          .get(base.runId) as { n: number };
        expect(event.n).toBeGreaterThan(0);
        return null;
      });
    } finally {
      await base.close();
    }
  });

  it("restoring the exact source lets a NEW formal Allow pass through the same candidate (§70)", async () => {
    const base = await makeEvidenceSynthesisFixture("S1");
    try {
      const helpers = await import("./phase12-helpers.js");
      const { toolContextOf, callSubmitSynthesis, callSubmitValidation, minimalManifest } = helpers;
      const ctx = toolContextOf(base);
      const synthesis = callSubmitSynthesis(ctx, base, minimalManifest(base), { toolUseId: "REST-SYN" });
      const cleanFindings = [{ kind: "clean" as const, summary: "faithful", detail: "no gaps", subjectRefs: [], supportingRefs: [] }];
      callSubmitValidation(
        ctx,
        base,
        { manifest_id: synthesis.manifest_id, manifest_hash: synthesis.manifest_hash, findings: cleanFindings },
        { toolUseId: "REST-VAL", agent: { agentId: "agent_v", agentType: "phase-plan:validator" } },
      );
      const fin = callRequestFinalization(ctx, base, { toolUseId: "REST-FIN" });

      const workspace = (await import("../src/store/repositories.js")).getWorkspaceById(ctx.store, base.workspaceId)!;
      const sourcePath = nodePath.join(workspace.canonicalRoot, "src", "syn-ev.txt");
      const drifted = fs.readFileSync(sourcePath, "utf8");
      fs.writeFileSync(sourcePath, "// drifted\n");
      expect(() => callApprove(ctx, base, fin.final_proposal, { toolUseId: "REST-APP-1" })).toThrowError(
        expect.objectContaining({ code: "FINALIZATION_DENIED" }),
      );
      // Exact original content restored: the deterministic fingerprint can
      // revalidate fresh; the SAME candidate passes a new formal Allow.
      fs.writeFileSync(sourcePath, drifted);
      const approval = callApprove(ctx, base, fin.final_proposal, { toolUseId: "REST-APP-2" });
      expect(approval.approved).toBe(true);
      ctx.store.withRead((tx) => {
        expect((tx.prepare("SELECT COUNT(*) AS n FROM final_plans WHERE run_id = ?").get(base.runId) as { n: number }).n).toBe(1);
        return null;
      });
    } finally {
      await base.close();
    }
  });
});

describe("request_reopen from final (§65–§67/§101)", () => {
  it("reopen while the final Proposal awaits: supersedes it, preserves the candidate, returns to detail, marks sections needs_review, bumps revision once (§66/§101)", async () => {
    const { f, ctx } = await cleanFixture();
    const fin = callRequestFinalization(ctx, f, { toolUseId: "REO-FIN" });
    const runBefore = getPlanningRunRecord(ctx.store, f.runId)!;
    const { callRequestReopen } = await import("./phase12-helpers.js");
    const headBeforeReopen = ctx.store.withRead((tx) =>
      tx.prepare("SELECT head_commit_id AS c FROM plan_heads WHERE run_id = ?").get(f.runId) as { c: string | null },
    );
    const reopen = callRequestReopen(ctx, f, { target: "detail", reason: "design flaw discovered after finalization" }, { toolUseId: "REO-REO" });
    expect(reopen.stage).toBe("detail");
    expect(reopen.run_revision).toBe(runBefore.revision + 1);
    expect(reopen.sections_needing_review.length).toBeGreaterThan(0);
    // HEAD untouched by the reopen (§85).
    const headAfterReopen = ctx.store.withRead((tx) =>
      tx.prepare("SELECT head_commit_id AS c FROM plan_heads WHERE run_id = ?").get(f.runId) as { c: string | null },
    );
    expect(headAfterReopen.c).toBe(headBeforeReopen.c);
    ctx.store.withRead((tx) => {
      // The final proposal is superseded, NOT approved or deleted (§66).
      const status = tx
        .prepare("SELECT status FROM proposal_states WHERE run_id = ? AND proposal_id = ?")
        .get(f.runId, fin.final_proposal.proposal_id) as { status: string };
      expect(status.status).toBe("superseded");
      // Candidate + audit history preserved (immutable, §66/§101).
      const candidate = getFinalPlanCandidateInTx(tx, f.runId, fin.candidate.candidate_id);
      expect(candidate?.candidateHash).toBe(fin.candidate.candidate_hash);
      const refs = listFinalPlanCandidateRefsInTx(tx, f.runId, fin.candidate.candidate_id);
      expect(refs.length).toBeGreaterThan(0);
      return null;
    });
  });

  it("reopen is FORBIDDEN once the FinalPlan is approved (§67/§61/§75)", async () => {
    const { f, ctx } = await cleanFixture();
    const fin = callRequestFinalization(ctx, f, { toolUseId: "APR-FIN" });
    callApprove(ctx, f, fin.final_proposal, { toolUseId: "APR-APP" });
    const { callRequestReopen } = await import("./phase12-helpers.js");
    expect(() =>
      callRequestReopen(ctx, f, { target: "detail", reason: "too late" }, { toolUseId: "APR-REO" }),
    ).toThrowError(expect.objectContaining({ code: "FINAL_PLAN_ALREADY_APPROVED" }));
  });

  it("approve-vs-reopen race: whoever wins, no contradictory state exists (§75/§102)", async () => {
    const { f, ctx } = await cleanFixture();
    const fin = callRequestFinalization(ctx, f, { toolUseId: "RACE-FIN" });
    // The reopen moves first: the approval must fail closed.
    const { callRequestReopen } = await import("./phase12-helpers.js");
    callRequestReopen(ctx, f, { target: "detail", reason: "race: reopen wins" }, { toolUseId: "RACE-REO" });
    const raceCounts = ctx.store.withRead((tx) => ({
      approvals: (tx.prepare("SELECT COUNT(*) AS n FROM approvals WHERE run_id = ?").get(f.runId) as { n: number }).n,
    }));
    // Phase 6 §41 precedence: the revision fence answers before the state
    // fence; either fail-closed code satisfies §75 — never an approval.
    try {
      callApprove(ctx, f, fin.final_proposal, { toolUseId: "RACE-APP" });
      expect.unreachable("stale approval must fail closed");
    } catch (err) {
      expect(["STALE_RUN_REVISION", "PROPOSAL_SUPERSEDED"]).toContain((err as RuntimeError).code);
    }
    ctx.store.withRead((tx) => {
      expect((tx.prepare("SELECT COUNT(*) AS n FROM approvals WHERE run_id = ?").get(f.runId) as { n: number }).n).toBe(raceCounts.approvals);
      expect((tx.prepare("SELECT COUNT(*) AS n FROM final_plans WHERE run_id = ?").get(f.runId) as { n: number }).n).toBe(0);
      return null;
    });
  });
});

describe("legacy + candidate-boundary semantics (§71/§77)", () => {
  it("evidence replacement after the freeze keeps the candidate bound to the OLD revision — the authorization fails (§71)", async () => {
    const base = await makeEvidenceSynthesisFixture("S1");
    try {
      const helpers = await import("./phase12-helpers.js");
      const { toolContextOf, callSubmitSynthesis, callSubmitValidation, minimalManifest } = helpers;
      const ctx = toolContextOf(base);
      const synthesis = callSubmitSynthesis(ctx, base, minimalManifest(base), { toolUseId: "REPL-SYN" });
      const cleanFindings = [{ kind: "clean" as const, summary: "faithful", detail: "no gaps", subjectRefs: [], supportingRefs: [] }];
      callSubmitValidation(
        ctx,
        base,
        { manifest_id: synthesis.manifest_id, manifest_hash: synthesis.manifest_hash, findings: cleanFindings },
        { toolUseId: "REPL-VAL", agent: { agentId: "agent_v", agentType: "phase-plan:validator" } },
      );
      const fin = callRequestFinalization(ctx, base, { toolUseId: "REPL-FIN" });
      // Candidate froze the OLD evidence revision.
      ctx.store.withRead((tx) => {
        const refs = listFinalPlanCandidateRefsInTx(tx, base.runId, fin.candidate.candidate_id).filter((ref) => ref.family === "evidence");
        expect(refs.length).toBeGreaterThan(0);
        return null;
      });
      // Drift the source so the OLD revision goes needs_validation, then
      // approve — the gate rerun must deny: the candidate still binds EV@1.
      const workspace = (await import("../src/store/repositories.js")).getWorkspaceById(ctx.store, base.workspaceId)!;
      fs.writeFileSync(nodePath.join(workspace.canonicalRoot, "src", "syn-ev.txt"), "// replaced content\n");
      expect(() => callApprove(ctx, base, fin.final_proposal, { toolUseId: "REPL-APP" })).toThrowError(
        expect.objectContaining({ code: "FINALIZATION_DENIED" }),
      );
      ctx.store.withRead((tx) => {
        expect((tx.prepare("SELECT COUNT(*) AS n FROM final_plans WHERE run_id = ?").get(base.runId) as { n: number }).n).toBe(0);
        return null;
      });
    } finally {
      await base.close();
    }
  });

  it("a final_plan proposal WITHOUT a candidate binding fails closed with FINAL_PLAN_CANDIDATE_REQUIRED (§77/E-legacy)", async () => {
    const { f, ctx } = await cleanFixture();
    const orphanId = "PROP-LEGACY-ORPHAN";
    // Construct the §77 shape directly: a legal awaiting final_plan proposal
    // that has NO proposal_final_plan_refs binding (as a migrated schema-9
    // run would present). The v10 immutability triggers make it impossible to
    // STRIP a binding from a real finalization — a deliberate guarantee.
    const run = getPlanningRunRecord(ctx.store, f.runId)!;
    const head = ctx.store.withRead((tx) =>
      tx.prepare("SELECT head_snapshot_id AS s, head_commit_id AS c FROM plan_heads WHERE run_id = ?").get(f.runId) as { s: string; c: string | null },
    );
    const { buildFinalPlanProposalCanonical, canonicalProposalHash } = await import("../src/core/proposal-canonical.js");
    const { canonicalJson } = await import("../src/core/canonical-json.js");
    const canonical = buildFinalPlanProposalCanonical({
      runId: f.runId,
      proposalId: orphanId,
      proposalRevision: 1,
      type: "final_plan",
      scope: { kind: "architecture" },
      baseRunRevision: run.revision,
      baseHeadSnapshotId: head.s,
      baseHeadCommitId: head.c,
      title: "Final plan",
      summary: "legacy orphan",
      changes: [],
      dependencies: [],
      impact: { affected: [], notes: [] },
      requiredEvidence: [],
      finalPlanCandidate: { candidateId: "fpc_orphan", candidateHash: "sha256:" + "0".repeat(64) },
    });
    ctx.store.withWrite((tx) => {
      tx.prepare("INSERT INTO proposals (run_id, proposal_id, created_at) VALUES (?, ?, ?)").run(f.runId, orphanId, new Date().toISOString());
      tx.prepare(
        "INSERT INTO proposal_revisions (run_id, proposal_id, revision, proposal_type, scope_json, title, summary, changes_json, dependencies_json, impact_json, base_run_revision, base_head_snapshot_id, base_head_commit_id, canonical_json, proposal_hash, created_at) "
        + "VALUES (?, ?, 1, 'final_plan', ?, 'Final plan', 'legacy orphan', '[]', '[]', ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        f.runId,
        orphanId,
        JSON.stringify({ kind: "architecture" }),
        JSON.stringify({ affected: [], notes: [] }),
        run.revision,
        head.s,
        head.c,
        canonicalJson(canonical),
        canonicalProposalHash(canonical),
        new Date().toISOString(),
      );
      tx.prepare("INSERT INTO proposal_states (run_id, proposal_id, revision, status, created_at, updated_at) VALUES (?, ?, 1, 'awaiting_approval', ?, ?)").run(
        f.runId,
        orphanId,
        new Date().toISOString(),
        new Date().toISOString(),
      );
      return null;
    });
    const { createPlanCommitEngine } = await import("../src/application/plan-commit-engine.js");
    const engine = createPlanCommitEngine(ctx.store, {
      nowIso: () => new Date().toISOString(),
      newId: (() => {
        let i = 0;
        return () => `leg-${(i += 1)}`;
      })(),
    });
    const legacyCounts = ctx.store.withRead((tx) => ({
      approvals: (tx.prepare("SELECT COUNT(*) AS n FROM approvals WHERE run_id = ?").get(f.runId) as { n: number }).n,
    }));
    expect(() =>
      engine.commitAuthorizedProposal({
        runId: f.runId,
        workspaceId: f.workspaceId,
        sessionId: f.sessionId,
        bindingGeneration: f.generation,
        authorization: {
          authorizationRequestId: "legacy-auth-1",
          proposalId: orphanId,
          proposalRevision: 1,
          proposalHash: canonicalProposalHash(canonical),
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "FINAL_PLAN_CANDIDATE_REQUIRED" }));
    // Nothing was written by the denied authorization.
    ctx.store.withRead((tx) => {
      expect((tx.prepare("SELECT COUNT(*) AS n FROM approvals WHERE run_id = ?").get(f.runId) as { n: number }).n).toBe(legacyCounts.approvals);
      return null;
    });
  });
});
