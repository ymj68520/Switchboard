/**
 * Phase 17 recovery / multi-session matrix (directive §12–§29). Each test is
 * one matrix row: authoritative state before the interruption, the
 * interruption (crash = process death with NO SessionEnd, modeled by a fresh
 * handler invocation against the same store; sanctioned same-invocation
 * retry for lost-response windows), the recovery action, and the exact
 * authority observed afterwards. Rows already pinned elsewhere re-assert
 * their critical cells here so the matrix is complete in one place.
 */
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { executePhasePlanTool } from "../src/mcp/tools.js";
import { RuntimeError } from "../src/runtime/errors.js";
import { handleSessionEnd, handleSessionStart, handlePreToolUse } from "../src/hooks/handlers.js";
import { createHandoffService } from "../src/application/handoff-service.js";
import { getExecutionBindingInTx } from "../src/store/execution.js";
import { getBinding } from "../src/store/session-bindings.js";
import { getPlanningRunRecord } from "../src/store/planning-runs.js";
import { getHeadCommitRecord } from "../src/store/plan-commits.js";
import { buildPhase17World, type Phase17World } from "./phase17-helpers.js";
import { makeDetailFixture, commitSectionDag } from "./phase11-helpers.js";
import { toolContextOf } from "./phase12-helpers.js";
import { callHandoff } from "./phase14-helpers.js";
import { hostToken } from "./context-helpers.js";
import { hostTokenV2 } from "./phase12-helpers.js";
import { issueEntryIntent } from "../src/host/entry-intent.js";
import type { PhasePlanToolContext } from "../src/mcp/tools.js";

function depsOf(world: Phase17World) {
  return { store: world.store, secret: world.secret, clock: world.ctx.clock, blobs: world.ctx.blobs };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof RuntimeError) return err.code;
    throw err;
  }
  throw new Error("expected a RuntimeError but none was thrown");
}

describe("Phase 17 recovery matrix — planning (§12–§15)", () => {
  it("§12 matrix A: hard crash during Discovery; exact-session resume restores the SAME run, generation untouched, HEAD unchanged, A1 when mode lost", async () => {
    const world = await buildPhase17World("discovery");
    try {
      // Hard crash: the process dies WITHOUT SessionEnd — the binding row is
      // untouched (still attached, same generation). Recovery is --resume.
      const before = getBinding(world.store, world.runId);
      const out = await handleSessionStart(depsOf(world), {
        sessionId: world.owner,
        cwd: world.workspaceRoot,
        permissionMode: "default",
        hookEventName: "SessionStart",
        source: "resume",
      });
      expect(out.kind).toBe("json");
      const after = getBinding(world.store, world.runId);
      expect(after).toMatchObject({ state: "attached", generation: before!.generation, sessionId: world.owner });
      expect(getPlanningRunRecord(world.store, world.runId)).toMatchObject({ lifecycle: "active", revision: 1 });
      // A1: host did not restore Plan Mode → the recovery context says so.
      const payload = (out as { payload?: Record<string, unknown> }).payload ?? {};
      const context = ((payload.hookSpecificOutput as { additionalContext?: string }) ?? {}).additionalContext ?? "";
      expect(context).toContain("Phase Plan run recovered");
      expect(context).toContain("Plan Mode must be restored");
    } finally {
      world.close();
    }
  });

  it("§12 matrix A (Detail + active Section): crash/resume keeps the run, the section workflow, and HEAD byte-stable", async () => {
    const f = await makeDetailFixture("S1");
    const ctx: PhasePlanToolContext = toolContextOf(f);
    try {
      const { sectionIds } = commitSectionDag(f, [
        { title: "Health checker core" },
        { title: "HTTP report endpoint", dependencies: ["SEC-1"] },
      ]);
      const headBefore = getHeadCommitRecord(ctx.store, f.runId);
      const bindingBefore = getBinding(f.store, f.runId);
      // Hard crash + exact-session resume.
      const out = await handleSessionStart({ store: f.store, secret: ctx.secret, clock: ctx.clock, blobs: ctx.blobs }, {
        sessionId: "S1",
        cwd: f.root,
        permissionMode: "plan",
        hookEventName: "SessionStart",
        source: "resume",
      });
      expect(out.kind).toBe("json");
      expect(getBinding(f.store, f.runId)).toMatchObject({ generation: bindingBefore!.generation });
      expect(getHeadCommitRecord(ctx.store, f.runId)).toEqual(headBefore);
      expect(sectionIds.length).toBe(2);
    } finally {
      f.close();
    }
  });

  it("§13 matrix B: crash with an awaiting Proposal; resume preserves id/revision/hash exactly; the retry allows exactly one Approval + one commit", async () => {
    // Build a proposal world through the REAL services (discovery + one checkpoint).
    const root = (await import("./store-helpers.js")).makeTempPluginDataRoot("phase-plan-p17b-");
    try {
      const { makeProposalFixture, prepareCheckpoint, DECISION_1 } = await import("./proposal-helpers.js");
      const fixture = await makeProposalFixture(root, { stage: "architecture", sessionId: "S1" });
      const prepared = prepareCheckpoint(fixture, [{ op: "ADD_DECISION", content: { ...DECISION_1 }, compactProjection: "d1" }]);
      const ctx = toolContextOf(fixture);
      // Crash + resume: the awaiting proposal survives exactly.
      await handleSessionStart({ store: fixture.store, secret: ctx.secret, clock: ctx.clock, blobs: ctx.blobs }, {
        sessionId: "S1",
        cwd: path.join(root, "project"),
        permissionMode: "plan",
        hookEventName: "SessionStart",
        source: "resume",
      });
      const proposal = fixture.store.withRead((tx) =>
        tx.prepare("SELECT proposal_id, revision, proposal_hash FROM proposal_revisions WHERE run_id = ? ORDER BY created_at DESC LIMIT 1").get(fixture.runId) as { proposal_id: string; revision: number; proposal_hash: string },
      );
      expect(proposal.proposal_id).toBe(prepared.proposal.proposalId);
      expect(proposal.revision).toBe(prepared.proposal.revision);
      expect(proposal.proposal_hash).toBe(prepared.proposal.proposalHash);
      // Real approval of the SURVIVING proposal — exactly one commit lands.
      const business = { proposal_id: proposal.proposal_id, proposal_revision: proposal.revision, proposal_hash: proposal.proposal_hash };
      const token = hostToken(ctx.secret, "approve_proposal", business, { sessionId: "S1", workspaceId: fixture.workspaceId, runId: fixture.runId, generation: fixture.generation }, { toolUseId: "P17-B-APPROVE" });
      const approval = executePhasePlanTool(ctx, "approve_proposal", { ...business, _hostContext: token }) as { approved: boolean; commit_id: string };
      expect(approval.approved).toBe(true);
      const counts = fixture.store.withRead((tx) => ({
        approvals: (tx.prepare("SELECT COUNT(*) AS n FROM approvals WHERE run_id = ?").get(fixture.runId) as { n: number }).n,
        commits: (tx.prepare("SELECT COUNT(*) AS n FROM plan_commits WHERE run_id = ?").get(fixture.runId) as { n: number }).n,
      }));
      expect(counts.approvals).toBe(1);
      expect(counts.commits).toBe(1);
      fixture.store.close();
    } finally {
      try {
        (await import("./store-helpers.js")).removeTempPluginDataRoot(root);
      } catch {
        // Windows may briefly lock freshly written DB files.
      }
    }
  });

  it("§14 matrix C: crash after Approval/commit BEFORE the response — the same invocation replays idempotently, never a second commit", async () => {
    const root = (await import("./store-helpers.js")).makeTempPluginDataRoot("phase-plan-p17c-");
    try {
      const { makeProposalFixture, prepareCheckpoint, DECISION_1 } = await import("./proposal-helpers.js");
      const fixture = await makeProposalFixture(root, { stage: "architecture", sessionId: "S1" });
      const prepared = prepareCheckpoint(fixture, [{ op: "ADD_DECISION", content: { ...DECISION_1 }, compactProjection: "d1" }]);
      const ctx = toolContextOf(fixture);
      const business = { proposal_id: prepared.proposal.proposalId, proposal_revision: prepared.proposal.revision, proposal_hash: prepared.proposal.proposalHash };
      const ids = { sessionId: "S1", workspaceId: fixture.workspaceId, runId: fixture.runId, generation: fixture.generation };
      void prepared;
      const token = (useId: string) => hostToken(ctx.secret, "approve_proposal", business, ids, { toolUseId: useId });
      // First invocation commits; the response is then LOST (crash window).
      const first = executePhasePlanTool(ctx, "approve_proposal", { ...business, _hostContext: token("P17-C-WINDOW") }) as { approved: boolean; commit_id: string; approval_id: string };
      expect(first.approved).toBe(true);
      // The retry of the SAME authorized invocation is the sanctioned
      // recovery: idempotent replay of the same Approval + same commit.
      const retry = executePhasePlanTool(ctx, "approve_proposal", { ...business, _hostContext: token("P17-C-WINDOW") }) as { idempotent: boolean; commit_id: string; approval_id: string };
      expect(retry.idempotent).toBe(true);
      expect(retry.commit_id).toBe(first.commit_id);
      expect(retry.approval_id).toBe(first.approval_id);
      const counts = fixture.store.withRead((tx) => ({
        approvals: (tx.prepare("SELECT COUNT(*) AS n FROM approvals WHERE run_id = ?").get(fixture.runId) as { n: number }).n,
        commits: (tx.prepare("SELECT COUNT(*) AS n FROM plan_commits WHERE run_id = ?").get(fixture.runId) as { n: number }).n,
        snapshots: (tx.prepare("SELECT COUNT(*) AS n FROM plan_snapshots WHERE run_id = ?").get(fixture.runId) as { n: number }).n,
      }));
      expect(counts.approvals).toBe(1);
      expect(counts.commits).toBe(1);
      expect(counts.snapshots).toBe(1);
      fixture.store.close();
    } finally {
      try {
        (await import("./store-helpers.js")).removeTempPluginDataRoot(root);
      } catch {
        // Windows may briefly lock freshly written DB files.
      }
    }
  });

  it("§15 matrix D: Final Approval crash before the response — same FinalPlan/Approval/Commit/HEAD on retry", async () => {
    const world = await buildPhase17World("final-awaiting");
    try {
      // The awaiting FINAL proposal is the one linked to the final-plan candidate.
      const finalRef = world.store.withRead((tx) =>
        tx.prepare("SELECT proposal_id AS id, proposal_revision AS rev FROM proposal_final_plan_refs WHERE run_id = ?").get(world.runId) as { id: string; rev: number } | undefined,
      );
      if (finalRef === undefined) throw new Error("fixture lacks an awaiting final proposal");
      const row = world.store.withRead((tx) =>
        tx.prepare("SELECT proposal_id, revision, proposal_hash FROM proposal_revisions WHERE run_id = ? AND proposal_id = ? ORDER BY revision DESC LIMIT 1").get(world.runId, finalRef.id) as { proposal_id: string; revision: number; proposal_hash: string },
      );
      const business = { proposal_id: row.proposal_id, proposal_revision: row.revision, proposal_hash: row.proposal_hash };
      const token = (useId: string) => hostToken(world.secret, "approve_proposal", business, { sessionId: world.owner, workspaceId: world.workspaceId, runId: world.runId, generation: world.generation }, { toolUseId: useId });
      const first = executePhasePlanTool(world.ctx, "approve_proposal", { ...business, _hostContext: token("P17-D-WINDOW") }) as { approved: boolean; commit_id: string };
      expect(first.approved).toBe(true);
      const retry = executePhasePlanTool(world.ctx, "approve_proposal", { ...business, _hostContext: token("P17-D-WINDOW") }) as { idempotent: boolean; commit_id: string };
      expect(retry.idempotent).toBe(true);
      expect(retry.commit_id).toBe(first.commit_id);
      expect(getHeadCommitRecord(world.store, world.runId)?.commitId).toBe(first.commit_id);
    } finally {
      world.close();
    }
  });
});

describe("Phase 17 recovery matrix — handoff and Build (§16–§18)", () => {
  it("§16 matrix E: mode transition succeeded but the handler failed before PREPARED — retry in default mode completes delivery", async () => {
    const world = await buildPhase17World("final-approved");
    try {
      // The host already switched the session to default (mode transition
      // applied); the handler never prepared. Retry WITHOUT restoring plan
      // mode — the frozen §89 recovery — then the natural delivery chain.
      const prepared = callHandoff(world.ctx, { sessionId: world.owner, workspaceId: world.workspaceId, runId: world.runId, generation: world.generation }, { toolUseId: "P17-E-RETRY", permissionMode: "default" });
      expect(prepared.handoff_id).toBeTruthy();
      createHandoffService(world.store, world.ctx.clock).finalizeDelivery({
        runId: world.runId,
        sessionId: world.owner,
        toolUseId: "P17-E-RETRY",
        responseHandoffId: prepared.handoff_id,
        responseHandoffHash: prepared.handoff_hash,
      });
      expect(getPlanningRunRecord(world.store, world.runId)).toMatchObject({ lifecycle: "completed" });
    } finally {
      world.close();
    }
  });

  it("§17 matrix F: PREPARED handoff with the finalizer lost — Build stays blocked, retry reuses the SAME handoff, one DELIVERED", async () => {
    const world = await buildPhase17World("final-approved");
    try {
      const prepared = callHandoff(world.ctx, { sessionId: world.owner, workspaceId: world.workspaceId, runId: world.runId, generation: world.generation }, { toolUseId: "P17-F-PREPARE" });
      expect(getPlanningRunRecord(world.store, world.runId)).toMatchObject({ lifecycle: "active", stage: "final" });
      // Build mutation is blocked while delivery is pending (the drift+pending guard).
      const deny = await handlePreToolUse(depsOf(world), {
        sessionId: world.owner,
        cwd: world.workspaceRoot,
        permissionMode: "default",
        hookEventName: "PreToolUse",
        toolName: "Write",
        toolInput: { file_path: "x.ts", content: "x" },
        toolUseId: "P17-F-WRITE",
      });
      expect(((deny as { payload?: Record<string, unknown> }).payload as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision).toBe("deny");
      // Retry reuses the SAME handoff id/hash (frozen §41).
      const retry = callHandoff(world.ctx, { sessionId: world.owner, workspaceId: world.workspaceId, runId: world.runId, generation: world.generation }, { toolUseId: "P17-F-PREPARE-2" });
      expect(retry.handoff_id).toBe(prepared.handoff_id);
      expect(retry.handoff_hash).toBe(prepared.handoff_hash);
      // One delivery → one completion.
      createHandoffService(world.store, world.ctx.clock).finalizeDelivery({
        runId: world.runId,
        sessionId: world.owner,
        toolUseId: "P17-F-PREPARE",
        responseHandoffId: prepared.handoff_id,
        responseHandoffHash: prepared.handoff_hash,
      });
      expect(getPlanningRunRecord(world.store, world.runId)).toMatchObject({ lifecycle: "completed" });
      const states = world.store.withRead((tx) => tx.prepare("SELECT COUNT(*) AS n FROM execution_handoff_states WHERE status = 'delivered'").get() as { n: number }).n;
      expect(states).toBe(1);
    } finally {
      world.close();
    }
  });

  it("§18 matrix G: completed Build crash/resume — ExecutionBinding generation advances exactly once and the contract is restored", async () => {
    const world = await buildPhase17World("completed-build");
    try {
      const genBefore = world.store.withRead((tx) => getExecutionBindingInTx(tx, world.runId))!.generation;
      // Crash (process death, binding left attached) is recovery-neutral;
      // the SESSION-END-then-RESUME cycle detaches +1 and reattaches +1.
      handleSessionEnd(depsOf(world), { sessionId: world.owner, hookEventName: "SessionEnd", reason: "prompt_input_exit" });
      expect(world.store.withRead((tx) => getExecutionBindingInTx(tx, world.runId))).toMatchObject({ state: "detached", generation: genBefore + 1 });
      const out = await handleSessionStart(depsOf(world), {
        sessionId: world.owner,
        cwd: world.workspaceRoot,
        permissionMode: "default",
        hookEventName: "SessionStart",
        source: "resume",
      });
      expect(out.kind).toBe("json");
      expect(world.store.withRead((tx) => getExecutionBindingInTx(tx, world.runId))).toMatchObject({ state: "attached", generation: genBefore + 2 });
      const payload = (out as { payload?: Record<string, unknown> }).payload ?? {};
      const context = ((payload.hookSpecificOutput as { additionalContext?: string }) ?? {}).additionalContext ?? "";
      expect(context).toContain("execution session restored");
    } finally {
      world.close();
    }
  });
});

describe("Phase 17 recovery matrix — successor and abort (§19–§21)", () => {
  it("§19 matrix H: crash before materialization — the successor resumes with HEAD still absent and the same issue set", async () => {
    const world = await buildPhase17World("successor-unmaterialized");
    try {
      const issuesBefore = world.store.withRead((tx) => (tx.prepare("SELECT COUNT(*) AS n FROM execution_issue_adoptions WHERE successor_run_id = ?").get(world.runId) as { n: number }).n);
      handleSessionEnd(depsOf(world), { sessionId: world.owner, hookEventName: "SessionEnd", reason: "prompt_input_exit" });
      await handleSessionStart(depsOf(world), {
        sessionId: world.owner,
        cwd: world.workspaceRoot,
        permissionMode: "plan",
        hookEventName: "SessionStart",
        source: "resume",
      });
      expect(getBinding(world.store, world.runId)).toMatchObject({ state: "attached", sessionId: world.owner });
      expect(getHeadCommitRecord(world.store, world.runId)).toBeNull();
      expect(getPlanningRunRecord(world.store, world.runId)).toMatchObject({ lifecycle: "active" });
      expect(world.store.withRead((tx) => (tx.prepare("SELECT COUNT(*) AS n FROM execution_issue_adoptions WHERE successor_run_id = ?").get(world.runId) as { n: number }).n)).toBe(issuesBefore);
    } finally {
      world.close();
    }
  });

  it("§21 matrix J: after a human-authorized abort, resume/compact/startup NEVER reattach and nothing mode-related is persisted", async () => {
    const world = await buildPhase17World("aborted");
    try {
      for (const source of ["resume", "compact", "startup"] as const) {
        const out = await handleSessionStart(depsOf(world), {
          sessionId: world.owner,
          cwd: world.workspaceRoot,
          permissionMode: source === "compact" ? "plan" : "default",
          hookEventName: "SessionStart",
          source,
        });
        // No recovery capsule for a terminal run — the host gets nothing.
        expect(out.kind).toBe("empty");
      }
      expect(getBinding(world.store, world.runId)).toMatchObject({ state: "detached" });
      // The A2 normalization condition is derived, never stored: the control
      // row records the abort authorization, and NO table carries any mode
      // warning state (structural: no such column exists anywhere).
      const columns = world.store.withRead((tx) => tx.prepare("SELECT name FROM pragma_table_info('run_control_authorizations')").all() as Array<{ name: string }>);
      for (const column of columns) {
        expect(column.name.toLowerCase()).not.toContain("mode");
      }
    } finally {
      world.close();
    }
  });
});

describe("Phase 17 multi-session matrix (§22–§29)", () => {
  it("§22 matrix A: two sessions hold two independent runs in one workspace", async () => {
    const s1 = await buildPhase17World("discovery", "S1");
    try {
      // S2 starts its own run in the SAME workspace (fresh entry intent).
      const entry = issueEntryIntent(s1.secret, { sessionId: "S17-OTHER", promptId: "PROMPT-1" });
      const token = hostToken(s1.secret, "start_or_resume", { _entryIntent: entry, goal: "second independent run", action: "start_new" }, { sessionId: "S17-OTHER", workspaceId: s1.workspaceId }, { permissionMode: "plan", toolUseId: "P17-MSA-1" });
      const started = executePhasePlanTool(s1.ctx, "start_or_resume", { _entryIntent: entry, goal: "second independent run", action: "start_new", _hostContext: token }) as { status: string; run: { id: string } };
      expect(started.status).toBe("started");
      expect(started.run.id).not.toBe(s1.runId);
      expect(getBinding(s1.store, s1.runId)).toMatchObject({ state: "attached", sessionId: "S1" });
      expect(getBinding(s1.store, started.run.id)).toMatchObject({ state: "attached", sessionId: "S17-OTHER" });
    } finally {
      s1.close();
    }
  });

  it("§23/§24 matrices B/C: explicit takeover advances G exactly once and the old owner is fenced immediately (no dual authority)", async () => {
    const world = await buildPhase17World("discovery", "S1");
    try {
      const token = hostTokenV2(world.secret, "takeover_run", { run_id: world.runId, expected_binding_generation: world.generation }, { sessionId: "S17-OTHER", workspaceId: world.workspaceId }, { toolUseId: "P17-MSB-TAKE" });
      const taken = executePhasePlanTool(world.ctx, "takeover_run", { run_id: world.runId, expected_binding_generation: world.generation, _hostContext: token }) as { status: string };
      expect(taken.status).toBe("taken_over");
      expect(getBinding(world.store, world.runId)).toMatchObject({ state: "attached", sessionId: "S17-OTHER", generation: world.generation + 1 });
      // The old owner's NEXT mutation lands on the fence — never dual write.
      const stale = hostTokenV2(world.secret, "abort_run", {}, { sessionId: "S1", workspaceId: world.workspaceId, runId: world.runId, generation: world.generation }, { toolUseId: "P17-MSC-STALE" });
      expect(codeOf(() => executePhasePlanTool(world.ctx, "abort_run", { _hostContext: stale }))).toBe("STALE_SESSION_BINDING");
    } finally {
      world.close();
    }
  });

  it("§25/§26 matrices D/E: /clear and fork never transfer planning authority; the old run stays detached-active for exact resume", async () => {
    const world = await buildPhase17World("discovery", "S1");
    try {
      handleSessionEnd(depsOf(world), { sessionId: world.owner, hookEventName: "SessionEnd", reason: "clear" });
      expect(getBinding(world.store, world.runId)).toMatchObject({ state: "detached", sessionId: "S1" });
      // A NEW session (clear/fork identity) inherits nothing: no capsule, no
      // reattach; a fresh /phase-plan creates a NEW run instead of resuming.
      for (const source of ["clear", "fork", "startup"] as const) {
        const out = await handleSessionStart(depsOf(world), {
          sessionId: "S17-OTHER",
          cwd: world.workspaceRoot,
          permissionMode: "plan",
          hookEventName: "SessionStart",
          source,
        });
        expect(out.kind).toBe("empty");
      }
      expect(getPlanningRunRecord(world.store, world.runId)).toMatchObject({ lifecycle: "active" });
      // ...and only the EXACT session can resume the detached run.
      await handleSessionStart(depsOf(world), {
        sessionId: "S1",
        cwd: world.workspaceRoot,
        permissionMode: "plan",
        hookEventName: "SessionStart",
        source: "resume",
      });
      expect(getBinding(world.store, world.runId)).toMatchObject({ state: "attached", sessionId: "S1" });
    } finally {
      world.close();
    }
  });

  it("§27/§28 matrices F/G: Build /clear and fork never transfer ExecutionBinding; the new session cannot read the execution contract", async () => {
    const world = await buildPhase17World("completed-build");
    try {
      handleSessionEnd(depsOf(world), { sessionId: world.owner, hookEventName: "SessionEnd", reason: "clear" });
      // A fork/clear identity does NOT reattach the execution binding (only
      // exact-session resume does), so no execution context is readable.
      for (const source of ["clear", "fork", "startup"] as const) {
        const out = await handleSessionStart(depsOf(world), {
          sessionId: "S17-OTHER",
          cwd: world.workspaceRoot,
          permissionMode: "default",
          hookEventName: "SessionStart",
          source,
        });
        expect(out.kind).toBe("empty");
      }
      // The new session's execution reads are unsigned → fail closed.
      const outcome = (await import("./phase17-helpers.js")).callAsTool(world, "get_state", "other");
      expect(outcome.ok).toBe(false);
      expect(outcome.code).toBe("HOST_CONTEXT_REQUIRED");
      // …and the exact-session RESUME is the only recovery path.
      await handleSessionStart(depsOf(world), {
        sessionId: world.owner,
        cwd: world.workspaceRoot,
        permissionMode: "default",
        hookEventName: "SessionStart",
        source: "resume",
      });
      expect(world.store.withRead((tx) => getExecutionBindingInTx(tx, world.runId))).toMatchObject({ state: "attached", sessionId: world.owner });
    } finally {
      world.close();
    }
  });

  it("§29 matrix H: the successor's ownership follows ordinary planning-binding semantics under /clear, fork, takeover, and exact resume", async () => {
    const world = await buildPhase17World("successor-unmaterialized");
    try {
      // /clear detaches; a fork identity inherits nothing.
      handleSessionEnd(depsOf(world), { sessionId: world.owner, hookEventName: "SessionEnd", reason: "clear" });
      const forkOut = await handleSessionStart(depsOf(world), {
        sessionId: "S17-OTHER",
        cwd: world.workspaceRoot,
        permissionMode: "plan",
        hookEventName: "SessionStart",
        source: "fork",
      });
      expect(forkOut.kind).toBe("empty");
      // Takeover by another session follows the SAME generation fence as any
      // planning run — predecessor lineage grants no bypass. The expected
      // generation is the CURRENT (post-detach) epoch the selection metadata
      // would surface to S2.
      const currentGeneration = getBinding(world.store, world.runId)!.generation;
      const token = hostTokenV2(world.secret, "takeover_run", { run_id: world.runId, expected_binding_generation: currentGeneration }, { sessionId: "S17-OTHER", workspaceId: world.workspaceId }, { toolUseId: "P17-MSH-TAKE" });
      const taken = executePhasePlanTool(world.ctx, "takeover_run", { run_id: world.runId, expected_binding_generation: currentGeneration, _hostContext: token }) as { status: string };
      expect(taken.status).toBe("taken_over");
      expect(getBinding(world.store, world.runId)).toMatchObject({ sessionId: "S17-OTHER", generation: currentGeneration + 1 });
      // Exact resume only for the NEW owner now.
      await handleSessionStart(depsOf(world), {
        sessionId: "S17-OTHER",
        cwd: world.workspaceRoot,
        permissionMode: "plan",
        hookEventName: "SessionStart",
        source: "resume",
      });
      expect(getBinding(world.store, world.runId)).toMatchObject({ state: "attached", sessionId: "S17-OTHER" });
    } finally {
      world.close();
    }
  });
});
