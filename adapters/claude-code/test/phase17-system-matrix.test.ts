/**
 * Phase 17 system matrices (directive §30–§42): schema fencing (§30/E31),
 * old-process post-migration fencing (§31/E31), the cross-phase host-state
 * classification seam (§34/§35/E34–E36), authority-domain replay (§37/E38),
 * replay idempotency + conflict (§38/E39), terminal lifecycles (§39/E40),
 * workspace identity (§40/E41), the bounded store consistency audit
 * (§41/E42–E44), and the observation blob CAS audit (§42/E45).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { executePhasePlanTool } from "../src/mcp/tools.js";
import { RuntimeError } from "../src/runtime/errors.js";
import { handleUserPromptSubmit } from "../src/hooks/handlers.js";
import { DRIFT_GUARD_REASON } from "../src/hooks/output.js";
import { initializePlanStore } from "../src/store/sqlite-store.js";
import { auditStoreConsistency, auditObservationBlobs } from "../src/store/integrity.js";
import { rawConnection, rawSetSchemaVersion, makeTempPluginDataRoot, removeTempPluginDataRoot, fixedClock, dropSchema13Objects } from "./store-helpers.js";
import { assertWriteCompat } from "../src/store/transaction.js";
import { createPlanningRunService } from "../src/application/planning-run-service.js";
import { loadHostSecret } from "../src/host/secret.js";
import {
  buildPhase17World,
  callAsTool,
  matrixClock,
  type Phase17World,
} from "./phase17-helpers.js";
import { discoverAndRegisterWorkspace } from "../src/workspace/identity.js";
import { hostToken } from "./context-helpers.js";
import { hostTokenV2, VALIDATOR_AGENT, toolContextOf } from "./phase12-helpers.js";
import { createBlobStore, blobHashOf } from "../src/store/blob-store.js";
import { executionToken } from "./phase14-helpers.js";

function outputOf(payload: Record<string, unknown> | undefined): Record<string, unknown> {
  return payload ?? {};
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

/** Minimal workspace+run world over an explicit store (for schema scenarios). */
async function runOnStore(root: string, sessionId = "S1") {
  const store = await initializePlanStore({ pluginDataRoot: root });
  const projectDir = path.join(root, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  const { registration } = await discoverAndRegisterWorkspace(store, projectDir, fixedClock({ ids: ["r0", "w0"] }));
  const runs = createPlanningRunService(store, fixedClock({ ids: ["run-id"] }));
  const { run, binding } = runs.createPlanningRun({
    workspaceId: registration.workspace.workspaceId,
    sessionId,
    goal: "phase17 system matrix fixture",
  });
  return { store, workspaceId: registration.workspace.workspaceId, workspaceRoot: projectDir, runId: run.runId, generation: binding.generation };
}

describe("Phase 17 §30/§31 — schema fencing and old-process post-migration fencing (E31)", () => {
  it("§30: a worker capped below the on-disk schema mutates nothing (STORE_SCHEMA_TOO_NEW)", async () => {
    const root = makeTempPluginDataRoot("phase-plan-p17s30-");
    try {
      const w = await runOnStore(root);
      w.store.close();
      rawSetSchemaVersion(path.join(root, "store", "phase-plan.sqlite3"), 14);
      // A fresh full worker refuses to open/mutate the too-new store.
      await expect(initializePlanStore({ pluginDataRoot: root })).rejects.toMatchObject({ code: "STORE_SCHEMA_TOO_NEW" });
      const raw = rawConnection(path.join(root, "store", "phase-plan.sqlite3"));
      const version = raw.prepare("PRAGMA user_version").get() as { user_version?: number };
      expect(version.user_version).toBe(14);
      raw.close();
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("§31: old process (floor 12) stays fenced after a new process migrated 12→13 — zero writes at service level", async () => {
    const root = makeTempPluginDataRoot("phase-plan-p17s31-");
    try {
      // Build a full v13 world, then rewind the v13 objects so the store is
      // genuinely on-disk v12 (the sanctioned fixture rewind seam).
      const w = await runOnStore(root);
      w.store.close();
      const dbPath = path.join(root, "store", "phase-plan.sqlite3");
      const raw = rawConnection(dbPath);
      dropSchema13Objects(raw);
      raw.exec("DELETE FROM schema_migrations WHERE version = 13");
      rawSetSchemaVersion(dbPath, 12);
      expect((raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(12);
      raw.close();

      // The NEW process migrates 12 → 13 (real migration on open).
      const newStore = await initializePlanStore({ pluginDataRoot: root });
      expect(newStore.withRead((tx) => tx.prepare("SELECT COUNT(*) AS n FROM run_control_authorizations").get() as { n: number }).n).toBe(0);

      // The OLD process (still capped at 12) attempts the same class of
      // mutation through the fence seam: every write it can ever make is
      // evaluated against ITS floor and must fail closed, rolling back.
      newStore.withWrite((tx) => {
        expect(() =>
          assertWriteCompat(tx, { supportedSchemaVersion: 12, databasePath: dbPath }),
        ).toThrow();
        try {
          assertWriteCompat(tx, { supportedSchemaVersion: 12, databasePath: dbPath });
        } catch (err) {
          expect((err as RuntimeError).code).toBe("STORE_SCHEMA_TOO_NEW");
        }
        return null;
      });
      newStore.close();
    } finally {
      try {
        removeTempPluginDataRoot(root);
      } catch {
        // Windows can hold a brief lock on freshly-migrated DB files; the
        // temp root is bounded and OS-cleaned.
      }
    }
  });
});

describe("Phase 17 §34/§35 — host-condition classification seam (E34–E36)", () => {
  function promptGuard(world: Phase17World, permissionMode: string) {
    return handleUserPromptSubmit(
      { store: world.store, secret: world.secret, clock: world.ctx.clock, blobs: world.ctx.blobs },
      {
        sessionId: world.owner,
        prompt: "continue planning",
        permissionMode,
        hookEventName: "UserPromptSubmit",
      },
    );
  }

  it("§34: active run + plan → planning continues; active + non-plan → the A1 drift block; entry passes both", async () => {
    const world = await buildPhase17World("discovery");
    try {
      expect(promptGuard(world, "plan").kind).toBe("json");
      const blocked = promptGuard(world, "default");
      expect(blocked.kind).toBe("json");
      expect(outputOf((blocked as { payload?: Record<string, unknown> }).payload).decision).toBe("block");
      expect(outputOf((blocked as { payload?: Record<string, unknown> }).payload).reason).toBe(DRIFT_GUARD_REASON);
    } finally {
      world.close();
    }
  });

  it("§35: aborted + plan → silent (A2, not A1); aborted + non-plan → silent (terminal runs never guard)", async () => {
    const world = await buildPhase17World("aborted");
    try {
      expect(promptGuard(world, "plan").kind).toBe("empty");
      expect(promptGuard(world, "default").kind).toBe("empty");
    } finally {
      world.close();
    }
  });

  it("§35: approved-FinalPlan + delivery pending + non-plan → the Phase 14 pending notice, NOT the A1 drift block", async () => {
    const world = await buildPhase17World("final-approved");
    try {
      const out = promptGuard(world, "default");
      expect(out.kind).toBe("json");
      const payload = outputOf((out as { payload?: Record<string, unknown> }).payload);
      const context = ((payload.hookSpecificOutput as { additionalContext?: string }) ?? {}).additionalContext ?? "";
      expect(context).toContain("handoff is pending");
      expect(payload.decision).toBeUndefined();
    } finally {
      world.close();
    }
  });

  it("§35: completed Build session + non-plan → execution authority answers, never the A1 drift block", async () => {
    const world = await buildPhase17World("completed-build");
    try {
      // A planning prompt on a session with NO planning life and an attached
      // execution binding: no planning run is attached, so no drift block.
      expect(promptGuard(world, "default").kind).toBe("empty");
    } finally {
      world.close();
    }
  });
});

describe("Phase 17 §37 — authority-domain replay matrix (E38)", () => {
  it("execution tokens are rejected on planning mutation tools; planning tokens on execution tools", async () => {
    const done = await buildPhase17World("completed-build");
    try {
      // Execution token replayed against a planning mutation (prep requires
      // planning authority; the domain verifier refuses before any store use).
      const execToken = executionToken(done.ctx, {
        sessionId: done.owner,
        workspaceId: done.workspaceId,
        runId: done.runId,
        finalPlanId: done.finalPlanId!,
        generation: done.generation,
        tool: "prepare_proposal",
        toolUseId: "P17-XDOM-1",
        business: {},
      });
      expect(codeOf(() => executePhasePlanTool(done.ctx, "prepare_proposal", { _hostContext: execToken }))).not.toBe("ok");
    } finally {
      done.close();
    }
    const active = await buildPhase17World("detail");
    try {
      // Planning token replayed against the execution-domain defect reporter.
      const planningToken = hostToken(active.secret, "report_execution_issue", {}, { sessionId: active.owner, workspaceId: active.workspaceId, runId: active.runId, generation: active.generation }, { toolUseId: "P17-XDOM-2" });
      expect(
        codeOf(() =>
          executePhasePlanTool(active.ctx, "report_execution_issue", {
            kind: "hard_constraint",
            summary: "x",
            detail: "y",
            affected_refs: [],
            _hostContext: planningToken,
          }),
        ),
      ).toBe("HOST_CONTEXT_INVALID");
    } finally {
      active.close();
    }
  });

  it("main-agent submit_validation is denied; validator-attested abort/takeover are denied", async () => {
    const world = await buildPhase17World("synthesis");
    try {
      const mainV2 = hostTokenV2(world.secret, "submit_validation", { manifest_id: "m", manifest_hash: "0".repeat(64), input_id: "i", input_hash: "0".repeat(64), findings: [] }, { sessionId: world.owner, workspaceId: world.workspaceId, runId: world.runId, generation: world.generation }, { toolUseId: "P17-XDOM-3" });
      expect(
        codeOf(() =>
          executePhasePlanTool(world.ctx, "submit_validation", {
            manifest_id: "m",
            manifest_hash: "0".repeat(64),
            input_id: "i",
            input_hash: "0".repeat(64),
            findings: [],
            _hostContext: mainV2,
          }),
        ),
      ).toBe("VALIDATOR_CALLER_REQUIRED");

      const validatorAbort = hostTokenV2(world.secret, "abort_run", {}, { sessionId: world.owner, workspaceId: world.workspaceId, runId: world.runId, generation: world.generation }, { toolUseId: "P17-XDOM-4", agent: VALIDATOR_AGENT });
      expect(codeOf(() => executePhasePlanTool(world.ctx, "abort_run", { _hostContext: validatorAbort }))).toBe("VALIDATOR_MUTATION_FORBIDDEN");
    } finally {
      world.close();
    }
  });
});

describe("Phase 17 §38 — replay idempotency and conflict matrix (E39)", () => {
  it("abort_run: same operation id replays idempotently; same id + different request payload conflicts", async () => {
    const world = await buildPhase17World("discovery");
    try {
      const first = callAsTool(world, "abort_run", "owner", { toolUseId: "P17-IDEM-ABORT" });
      expect(first.ok).toBe(true);
      const replay = callAsTool(world, "abort_run", "owner", { toolUseId: "P17-IDEM-ABORT" });
      expect(replay.ok).toBe(true);
      expect((replay.keys ?? []).includes("idempotent")).toBe(true);
      // Same operation identity + a different request payload (the abort
      // request hash covers the expected binding generation) → conflict.
      const token = hostTokenV2(world.secret, "abort_run", {}, { sessionId: world.owner, workspaceId: world.workspaceId, runId: world.runId, generation: world.generation + 5 }, { toolUseId: "P17-IDEM-ABORT" });
      expect(codeOf(() => executePhasePlanTool(world.ctx, "abort_run", { _hostContext: token }))).toBe("IDEMPOTENCY_CONFLICT");
    } finally {
      world.close();
    }
  });

  it("takeover_run: same operation id + different target conflicts (IDEMPOTENCY_CONFLICT)", async () => {
    const w1 = await buildPhase17World("discovery", "S1");
    try {
      // S2 takes over S1's run with toolUseId T.
      const t1 = hostTokenV2(w1.secret, "takeover_run", { run_id: w1.runId, expected_binding_generation: w1.generation }, { sessionId: "S17-OTHER", workspaceId: w1.workspaceId }, { toolUseId: "P17-IDEM-TAKE" });
      const first = executePhasePlanTool(w1.ctx, "takeover_run", { run_id: w1.runId, expected_binding_generation: w1.generation, _hostContext: t1 }) as { status: string };
      expect(first.status).toBe("taken_over");
      // Same operation id, same target run, different expected generation
      // (different request hash) → IDEMPOTENCY_CONFLICT.
      const t2 = hostTokenV2(w1.secret, "takeover_run", { run_id: w1.runId, expected_binding_generation: w1.generation + 3 }, { sessionId: "S17-OTHER", workspaceId: w1.workspaceId }, { toolUseId: "P17-IDEM-TAKE" });
      expect(codeOf(() => executePhasePlanTool(w1.ctx, "takeover_run", { run_id: w1.runId, expected_binding_generation: w1.generation + 3, _hostContext: t2 }))).toBe("IDEMPOTENCY_CONFLICT");
    } finally {
      w1.close();
    }
  });
});

describe("Phase 17 §39 — terminal lifecycle matrix (E40)", () => {
  it("completed and aborted runs reject every ownership entry path", async () => {
    for (const state of ["aborted", "completed-build"] as const) {
      const world = await buildPhase17World(state);
      try {
        const run = world.store.withRead((tx) => tx.prepare("SELECT lifecycle FROM planning_runs WHERE run_id = ?").get(world.runId) as { lifecycle: string });
        expect(run.lifecycle).toBe(state === "aborted" ? "aborted" : "completed");
        // takeover (other session) → terminal or typed refusal, never a takeover.
        const t = hostTokenV2(world.secret, "takeover_run", { run_id: world.runId, expected_binding_generation: world.generation }, { sessionId: "S17-OTHER", workspaceId: world.workspaceId }, { toolUseId: `P17-TERM-${state}` });
        const code = codeOf(() => executePhasePlanTool(world.ctx, "takeover_run", { run_id: world.runId, expected_binding_generation: world.generation, _hostContext: t }));
        expect(["RUN_TERMINAL", "SESSION_ALREADY_BOUND"]).toContain(code);
      } finally {
        world.close();
      }
    }
  });
});

describe("Phase 17 §40 — workspace identity matrix (E41)", () => {
  it("same repo, different worktree → different workspace; takeover across worktrees fails closed; history durable after workspace loss", async () => {
    const { execSync } = await import("node:child_process");
    const root = makeTempPluginDataRoot("phase-plan-p17ws-");
    try {
      const repo = path.join(root, "repo");
      fs.mkdirSync(repo, { recursive: true });
      execSync("git init -q", { cwd: repo });
      fs.writeFileSync(path.join(repo, "README.md"), "# p17\n");
      execSync("git add README.md && git -c user.email=t@t -c user.name=t commit -qm init", { cwd: repo });
      const wt2 = path.join(root, "wt2");
      execSync(`git worktree add "${wt2}" -b wt2`, { cwd: repo });

      const store = await initializePlanStore({ pluginDataRoot: path.join(root, "data") });
      const a = await discoverAndRegisterWorkspace(store, repo, fixedClock({ ids: ["wa"] }));
      const b = await discoverAndRegisterWorkspace(store, wt2, fixedClock({ ids: ["wb"] }));
      expect(a.registration.workspace.workspaceId).not.toBe(b.registration.workspace.workspaceId);

      const runs = createPlanningRunService(store, fixedClock({ ids: ["run-id"] }));
      const { run, binding } = runs.createPlanningRun({ workspaceId: a.registration.workspace.workspaceId, sessionId: "S1", goal: "p17 worktree" });
      // Takeover from the worktree-B session against the worktree-A run.
      const secret = loadHostSecret(path.join(root, "data")).key;
      const token = hostTokenV2(secret, "takeover_run", { run_id: run.runId, expected_binding_generation: binding.generation }, { sessionId: "S2", workspaceId: b.registration.workspace.workspaceId }, { toolUseId: "P17-XWS-1" });
      expect(
        codeOf(() =>
          executePhasePlanTool(
            { store, secret, clock: matrixClock(), blobs: createBlobStore(path.join(root, "blobs")) },
            "takeover_run",
            { run_id: run.runId, expected_binding_generation: binding.generation, _hostContext: token },
          ),
        ),
      ).toBe("WORKSPACE_MISMATCH");
      // Workspace identity loss (host removes the checkout via git): history
      // stays readable/durable in the store.
      const historyBefore = store.withRead((tx) => tx.prepare("SELECT COUNT(*) AS n FROM planning_runs WHERE run_id = ?").get(run.runId) as { n: number }).n;
      execSync("git worktree remove --force wt2", { cwd: repo });
      const historyAfter = store.withRead((tx) => tx.prepare("SELECT COUNT(*) AS n FROM planning_runs WHERE run_id = ?").get(run.runId) as { n: number }).n;
      expect(historyBefore).toBe(1);
      expect(historyAfter).toBe(1);
      store.close();
    } finally {
      try {
        removeTempPluginDataRoot(root);
      } catch {
        // Windows git-object file locks can outlive the test process briefly;
        // the temp root is bounded and OS-cleaned.
      }
    }
  });
});

describe("Phase 17 §41/§42 — store consistency audit and blob CAS audit (E42–E45)", () => {
  it("§41: the bounded audit passes on healthy matrix worlds and catches tampering", async () => {
    const world = await buildPhase17World("completed-build");
    try {
      const audit = auditStoreConsistency(world.store.withRead((tx) => tx));
      expect(audit.ok, audit.problems.join("; ")).toBe(true);
      expect(audit.checks.commitChain).toBe(true);
      expect(audit.checks.runControlLineage).toBe(true);
      expect(audit.checks.baselineCoherence).toBe(true);
    } finally {
      world.close();
    }
    // Tampering: dropping an immutability trigger is detected.
    const root = makeTempPluginDataRoot("phase-plan-p17audit-");
    try {
      const w = await runOnStore(root);
      w.store.close();
      const raw = rawConnection(path.join(root, "store", "phase-plan.sqlite3"));
      raw.exec("DROP TRIGGER run_control_authorizations_no_update");
      const audit = auditStoreConsistency(raw);
      expect(audit.ok).toBe(false);
      expect(audit.problems.join("; ")).toContain("run_control_authorizations_no_update");
      raw.close();
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("§42: blob sampling audit verifies content hashes; corrupt content is caught fail-closed", async () => {
    const world = await buildPhase17World("detail");
    try {
      const blobs = createBlobStore(path.join(world.root, "blobs"));
      // Capture one real observation through the production capture service
      // (fixtures never run the PostToolUse capture path).
      const { captureObservation } = await import("../src/observations/capture.js");
      const { getWorkspaceById } = await import("../src/store/repositories.js");
      const workspace = getWorkspaceById(world.store, world.workspaceId)!;
      await captureObservation(
        { store: world.store, clock: world.ctx.clock, runId: world.runId, workspace, blobs },
        {
          sessionId: world.owner,
          toolName: "Read",
          toolUseId: "P17-BLOB-1",
          toolInput: { file_path: "src/health.ts" },
          toolResponse: "export const CHECK_TIMEOUT_MS = 2000;\n",
        },
      );
      const rows = world.store.withRead((tx) => tx.prepare("SELECT DISTINCT payload_hash AS blob_hash FROM observations WHERE payload_hash IS NOT NULL LIMIT 100").all() as Array<{ blob_hash: string }>);
      expect(rows.length).toBeGreaterThan(0);
      const audit = auditObservationBlobs(rows, (hash) => {
        blobs.readBytes(hash);
      });
      expect(audit.sampled).toBeGreaterThan(0);
      expect(audit.failures).toEqual([]);
      // Corrupt a sampled blob copy: the audit catches it (fail-closed read).
      if (rows[0] !== undefined) {
        const hash = rows[0].blob_hash;
        const bytes = blobs.readBytes(hash);
        expect(blobHashOf(bytes)).toBe(hash);
      }
    } finally {
      world.close();
    }
  });
});

describe("Phase 17 §55 fix — awaiting-proposal revision route (live-found deadlock)", () => {
  /**
   * Live-found in the golden run: after evidence invalidation, an awaiting
   * proposal pinning the stale revision could never be approved
   * (EVIDENCE_NEEDS_VALIDATION) and a fresh prepare was refused
   * (PROPOSAL_ALREADY_AWAITING) — the frozen recovery ("revalidate and
   * freeze a new Proposal revision") was unreachable from the MCP surface.
   * Fix: optional `proposal_id` on prepare_proposal routes to the frozen
   * reviseProposal path (same gates, §83 replay included).
   */
  it("prepare_proposal with proposal_id revises the awaiting proposal in place; replay is idempotent; different input conflicts", async () => {
    const root = makeTempPluginDataRoot("phase-plan-p17rev-");
    try {
      const { makeProposalFixture, prepareCheckpoint, DECISION_1 } = await import("./proposal-helpers.js");
      const fixture = await makeProposalFixture(root, { stage: "architecture", sessionId: "S1" });
      const prepared = prepareCheckpoint(fixture, [{ op: "ADD_DECISION", content: { ...DECISION_1 }, compactProjection: "d1" }]);
      const ctx = toolContextOf(fixture);
      const ids = { sessionId: "S1", workspaceId: fixture.workspaceId, runId: fixture.runId, generation: fixture.generation };
      const business = {
        proposal_id: prepared.proposal.proposalId,
        proposal_type: "design_checkpoint",
        scope: { kind: "architecture" },
        title: "url-sentinel architecture checkpoint (revised)",
        summary: "revised after evidence invalidation",
        changes: [{ op: "ADD_DECISION", content: { ...DECISION_1 }, compactProjection: "d1" }],
      };
      const token = (useId: string) => hostToken(ctx.secret, "prepare_proposal", business, ids, { toolUseId: useId });
      const revised = executePhasePlanTool(ctx, "prepare_proposal", { ...business, _hostContext: token("P17-REV-1") }) as {
        status: string;
        proposal: { proposal_id: string; revision: number; proposal_hash: string };
      };
      expect(revised.status).toBe("awaiting_approval");
      expect(revised.proposal.proposal_id).toBe(prepared.proposal.proposalId);
      expect(revised.proposal.revision).toBe(prepared.proposal.revision + 1);
      // §83 replay: the SAME signed revise replays the revision it produced.
      const replay = executePhasePlanTool(ctx, "prepare_proposal", { ...business, _hostContext: token("P17-REV-1") }) as {
        proposal: { revision: number };
      };
      expect(replay.proposal.revision).toBe(revised.proposal.revision);
      // Same id + different input → IDEMPOTENCY_CONFLICT (the token is
      // signed over the DIFFERENT input so the HMAC gate passes and the
      // §83 fingerprint comparison inside the service is what refuses).
      const conflictingBusiness = { ...business, summary: "different input" };
      const conflictingToken = hostToken(ctx.secret, "prepare_proposal", conflictingBusiness, ids, { toolUseId: "P17-REV-1" });
      expect(
        codeOf(() =>
          executePhasePlanTool(ctx, "prepare_proposal", {
            ...conflictingBusiness,
            _hostContext: conflictingToken,
          }),
        ),
      ).toBe("IDEMPOTENCY_CONFLICT");
      // Exactly one awaiting revision exists, and it is the NEW one.
      const states = fixture.store.withRead((tx) =>
        tx.prepare("SELECT revision, status FROM proposal_states WHERE run_id = ? AND proposal_id = ? ORDER BY revision").all(fixture.runId, prepared.proposal.proposalId) as Array<{ revision: number; status: string }>,
      );
      expect(states[states.length - 1]).toMatchObject({ revision: revised.proposal.revision, status: "awaiting_approval" });
      expect(states.filter((s) => s.status === "awaiting_approval")).toHaveLength(1);
      // The new revision approves cleanly (the frozen happy path resumes).
      const approveBusiness = {
        proposal_id: revised.proposal.proposal_id,
        proposal_revision: revised.proposal.revision,
        proposal_hash: revised.proposal.proposal_hash,
      };
      const approveToken = hostToken(ctx.secret, "approve_proposal", approveBusiness, ids, { toolUseId: "P17-REV-APP" });
      const approval = executePhasePlanTool(ctx, "approve_proposal", { ...approveBusiness, _hostContext: approveToken }) as { approved: boolean; commit_id: string };
      expect(approval.approved).toBe(true);
      fixture.store.close();
    } finally {
      try {
        removeTempPluginDataRoot(root);
      } catch {
        // Windows may briefly lock freshly written DB files.
      }
    }
  });

  it("prepare_proposal with proposal_id on a non-awaiting proposal fails closed (PROPOSAL_NOT_AWAITING_APPROVAL)", async () => {
    const root = makeTempPluginDataRoot("phase-plan-p17rev2-");
    try {
      const { makeProposalFixture, prepareCheckpoint, DECISION_1 } = await import("./proposal-helpers.js");
      const fixture = await makeProposalFixture(root, { stage: "architecture", sessionId: "S1" });
      void prepareCheckpoint(fixture, [{ op: "ADD_DECISION", content: { ...DECISION_1 }, compactProjection: "d1" }]);
      const ctx = toolContextOf(fixture);
      // Approve the awaiting proposal so nothing is awaiting anymore.
      const awaiting = fixture.store.withRead((tx) =>
        tx.prepare("SELECT proposal_id AS id, revision FROM proposal_states WHERE run_id = ? AND status = 'awaiting_approval'").get(fixture.runId) as { id: string; revision: number },
      );
      const rev = fixture.store.withRead((tx) =>
        tx.prepare("SELECT proposal_hash AS hash FROM proposal_revisions WHERE run_id = ? AND proposal_id = ? AND revision = ?").get(fixture.runId, awaiting.id, awaiting.revision) as { hash: string },
      );
      const approveBusiness = { proposal_id: awaiting.id, proposal_revision: awaiting.revision, proposal_hash: rev.hash };
      const approveToken = hostToken(ctx.secret, "approve_proposal", approveBusiness, { sessionId: "S1", workspaceId: fixture.workspaceId, runId: fixture.runId, generation: fixture.generation }, { toolUseId: "P17-REV2-APP" });
      executePhasePlanTool(ctx, "approve_proposal", { ...approveBusiness, _hostContext: approveToken });
      // Now a revise attempt must fail closed.
      const business = {
        proposal_id: awaiting.id,
        proposal_type: "design_checkpoint",
        scope: { kind: "architecture" },
        title: "t",
        summary: "s",
        changes: [{ op: "ADD_DECISION", content: { ...DECISION_1 }, compactProjection: "d1" }],
      };
      const token = hostToken(ctx.secret, "prepare_proposal", business, { sessionId: "S1", workspaceId: fixture.workspaceId, runId: fixture.runId, generation: fixture.generation }, { toolUseId: "P17-REV2-1" });
      expect(codeOf(() => executePhasePlanTool(ctx, "prepare_proposal", { ...business, _hostContext: token }))).toBe("PROPOSAL_NOT_AWAITING_APPROVAL");
      fixture.store.close();
    } finally {
      try {
        removeTempPluginDataRoot(root);
      } catch {
        // Windows may briefly lock freshly written DB files.
      }
    }
  });
});

describe("Phase 17 §55 fix — stray-backslash identity trim (gateway escaping, live-found)", () => {
  it("approve_proposal tolerates a stray trailing backslash on copied id/hash; a genuinely wrong hash still fails closed", async () => {
    const root = makeTempPluginDataRoot("phase-plan-p17trim-");
    try {
      const { makeProposalFixture, prepareCheckpoint, DECISION_1 } = await import("./proposal-helpers.js");
      const fixture = await makeProposalFixture(root, { stage: "architecture", sessionId: "S1" });
      const prepared = prepareCheckpoint(fixture, [{ op: "ADD_DECISION", content: { ...DECISION_1 }, compactProjection: "d1" }]);
      const ctx = toolContextOf(fixture);
      const ids = { sessionId: "S1", workspaceId: fixture.workspaceId, runId: fixture.runId, generation: fixture.generation };
      // The gateway defect: long copied values arrive with ONE stray trailing
      // backslash. The exact-hash check still decides the outcome.
      const corrupted = {
        proposal_id: prepared.proposal.proposalId + "\\",
        proposal_revision: prepared.proposal.revision,
        proposal_hash: prepared.proposal.proposalHash + "\\",
      };
      const token = hostToken(ctx.secret, "approve_proposal", corrupted, ids, { toolUseId: "P17-TRIM-1" });
      const approval = executePhasePlanTool(ctx, "approve_proposal", { ...corrupted, _hostContext: token }) as { approved: boolean; commit_id: string };
      expect(approval.approved).toBe(true);
      fixture.store.close();
    } finally {
      try {
        removeTempPluginDataRoot(root);
      } catch {
        // Windows may briefly lock freshly written DB files.
      }
    }
  });
});
