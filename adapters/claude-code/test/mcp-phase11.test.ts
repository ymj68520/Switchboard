/**
 * Phase 11 MCP surface — select_section and the production prepare_proposal
 * (§12/§21–§24/§59/§60/§62/§74). Authority stays host-signed: the model
 * supplies business fields only — run identity, revisions, hashes, and the
 * expected run revision are server-derived; the operation id derives from the
 * signed tool use.
 */

import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { executePhasePlanTool, PHASE_PLAN_TOOLS, type PhasePlanToolContext } from "../src/mcp/tools.js";
import { loadHostSecret } from "../src/host/secret.js";
import { createBlobStore } from "../src/store/blob-store.js";
import { getPlanningRunRecord } from "../src/store/planning-runs.js";
import { makePhase9Fixture, type Phase9Fixture } from "./phase9-helpers.js";
import { makeProposalFixture } from "./proposal-helpers.js";
import { makeTempPluginDataRoot, removeTempPluginDataRoot } from "./store-helpers.js";
import { hostToken } from "./context-helpers.js";
import { fixedClock } from "./store-helpers.js";

let seq = 0;

async function withPhase11(fn: (fixture: Phase9Fixture, ctx: PhasePlanToolContext, secret: Buffer) => void | Promise<void>): Promise<void> {
  const fixture = await makePhase9Fixture();
  try {
    const secret = loadHostSecret(fixture.root).key;
    const ctx: PhasePlanToolContext = {
      store: fixture.store,
      secret,
      clock: fixedClock({ ids: [] }),
      blobs: createBlobStore(path.join(fixture.root, "blobs")),
    };
    await fn(fixture, ctx, secret);
  } finally {
    fixture.close();
  }
}

function idsOf(fixture: { sessionId: string; workspaceId: string; runId: string; generation: number }) {
  return { sessionId: fixture.sessionId, workspaceId: fixture.workspaceId, runId: fixture.runId, generation: fixture.generation };
}

function call(
  ctx: PhasePlanToolContext,
  secret: Buffer,
  fixture: Phase9Fixture,
  tool: string,
  args: Record<string, unknown>,
  options: { permissionMode?: string } = {},
): Record<string, unknown> {
  const token = hostToken(secret, tool, args, idsOf(fixture), {
    toolUseId: `TU-P11-${(seq += 1)}`,
    ...(options.permissionMode !== undefined ? { permissionMode: options.permissionMode } : {}),
  });
  return executePhasePlanTool(ctx, tool, { ...args, _hostContext: token });
}

function architectureContent() {
  return {
    summary: "Single-store architecture",
    components: ["PlanStore"],
    boundaries: ["plugin data dir"],
    dataFlows: [],
    principles: [],
    unresolvedQuestionRefs: [],
    decisionRefs: [],
  };
}

/** Drive a fresh run to DETAIL via the production tools only (§76 prelude). */
function driveToDetail(ctx: PhasePlanToolContext, secret: Buffer, fixture: Phase9Fixture): void {
  const checkpointArgs = {
    proposal_type: "design_checkpoint",
    scope: { kind: "architecture" },
    title: "Arch checkpoint",
    summary: "architecture",
    changes: [
      { op: "SET_ARCHITECTURE_REVISION", target: null, content: architectureContent(), compactProjection: "ARCH-1@1" },
    ],
  };
  const checkpoint = call(ctx, secret, fixture, "prepare_proposal", checkpointArgs) as {
    proposal: { proposal_id: string; revision: number; proposal_hash: string };
  };
  const approved1 = call(ctx, secret, fixture, "approve_proposal", {
    proposal_id: checkpoint.proposal.proposal_id,
    proposal_revision: checkpoint.proposal.revision,
    proposal_hash: checkpoint.proposal.proposal_hash,
  }) as { approved: boolean };
  expect(approved1.approved).toBe(true);
  const completionArgs = {
    proposal_type: "architecture_completion",
    scope: { kind: "architecture" },
    title: "Arch completion",
    summary: "stable",
    changes: [],
  };
  const completion = call(ctx, secret, fixture, "prepare_proposal", completionArgs) as {
    proposal: { proposal_id: string; revision: number; proposal_hash: string };
  };
  const approved2 = call(ctx, secret, fixture, "approve_proposal", {
    proposal_id: completion.proposal.proposal_id,
    proposal_revision: completion.proposal.revision,
    proposal_hash: completion.proposal.proposal_hash,
  }) as { approved: boolean; new_stage: string };
  expect(approved2.new_stage).toBe("detail");
}

describe("Phase 11 MCP surface (§74)", () => {
  it("exposes exactly ten tools; select_section/prepare_proposal carry no force/status/authority fields (§74/E55)", () => {
    expect(PHASE_PLAN_TOOLS.map((tool) => tool.name)).toEqual([
      "start_or_resume",
      "get_state",
      "get_context",
      "read_memory",
      "list_observations",
      "promote_evidence",
      "revalidate_evidence",
      "select_section",
      "prepare_proposal",
      "approve_proposal",
      "submit_synthesis",
      "submit_validation",
      "request_reopen",
      "request_finalization",
      "handoff",
      "report_execution_issue",
      "takeover_run",
      "abort_run",
    ]);
    const select = PHASE_PLAN_TOOLS.find((tool) => tool.name === "select_section")!;
    expect(Object.keys(select.inputSchema.properties as Record<string, unknown>).sort()).toEqual(["_hostContext", "section_id"]);
    const prepare = PHASE_PLAN_TOOLS.find((tool) => tool.name === "prepare_proposal")!;
    const properties = Object.keys(prepare.inputSchema.properties as Record<string, unknown>).sort();
    // Phase 17 §55 fix: optional `proposal_id` revises the AWAITING proposal
    // (the frozen revise recovery; no new tool, no authority change).
    expect(properties).toEqual(["_hostContext", "changes", "proposal_id", "proposal_type", "required_evidence", "scope", "summary", "title"]);
    // E19 — no model-authoritative identity anywhere in the schema.
    // Phase 17 §55 fix: `proposal_id` is the ONE exception — it only NAMES
    // the run's awaiting proposal for the frozen revise path; the service
    // re-derives the awaiting state server-side and a non-awaiting target
    // fails closed (PROPOSAL_NOT_AWAITING_APPROVAL), so it carries no
    // authority. Everything model-authoritative stays banned.
    for (const banned of ["run_id", "workspace_id", "session_id", "binding_generation", "base_run_revision", "base_head", "proposal_hash", "force"]) {
      expect(properties).not.toContain(banned);
    }
  });

  it("prepare_proposal requires Plan Mode and rejects model-supplied authority (§59/E19)", async () => {
    await withPhase11(async (fixture, ctx, secret) => {
      const args = {
        proposal_type: "design_checkpoint",
        scope: { kind: "architecture" },
        title: "T",
        summary: "S",
        changes: [],
      };
      expect(() => call(ctx, secret, fixture, "prepare_proposal", args, { permissionMode: "default" })).toThrowError(
        expect.objectContaining({ code: "PLAN_MODE_REQUIRED" }),
      );
      expect(() =>
        call(ctx, secret, fixture, "prepare_proposal", { ...args, run_id: fixture.runId, base_run_revision: 1 }),
      ).toThrowError(expect.objectContaining({ code: "MCP_INPUT_INVALID" }));
    });
  });

  it("prepare_proposal drives Discovery → Architecture atomically, replays idempotently, and conflicts on change (E20/§60)", async () => {
    const root = makeTempPluginDataRoot("phase-plan-mcp11-");
    // A run still at DISCOVERY (no test-only stage mutation: makeProposalFixture
    // with stage=discovery leaves the run at its initial state).
    const fixture = await makeProposalFixture(root, { stage: "discovery" });
    try {
      const secret = loadHostSecret(root).key;
      const ctx: PhasePlanToolContext = {
        store: fixture.store,
        secret,
        clock: fixedClock({ ids: [] }),
        blobs: createBlobStore(path.join(root, "blobs")),
      };
      expect(getPlanningRunRecord(fixture.store, fixture.runId)?.stage).toBe("discovery");
      const args = {
        proposal_type: "design_checkpoint",
        scope: { kind: "architecture" },
        title: "First architecture checkpoint",
        summary: "the bridge",
        changes: [
          { op: "SET_ARCHITECTURE_REVISION", target: null, content: architectureContent(), compactProjection: "ARCH-1@1" },
        ],
      };
      // Force the SAME toolUseId for both calls: rebuild the token manually.
      const toolUseId = "TU-BRIDGE";
      const token = hostToken(secret, "prepare_proposal", args, idsOf(fixture), { toolUseId });
      const first = executePhasePlanTool(ctx, "prepare_proposal", { ...args, _hostContext: token }) as {
        status: string;
        proposal: { proposal_id: string; revision: number; base_run_revision: number };
      };
      expect(first.status).toBe("awaiting_approval");
      // The proposal froze against the NEW run revision (§24 bridge).
      expect(first.proposal.base_run_revision).toBe(2);
      expect(getPlanningRunRecord(fixture.store, fixture.runId)?.stage).toBe("architecture");
      // Same signed invocation replayed → the SAME proposal (§60).
      const replay = executePhasePlanTool(ctx, "prepare_proposal", { ...args, _hostContext: token }) as typeof first;
      expect(replay.proposal.proposal_id).toBe(first.proposal.proposal_id);
      // Same toolUseId, different input → IDEMPOTENCY_CONFLICT.
      expect(() =>
        executePhasePlanTool(ctx, "prepare_proposal", {
          ...args,
          title: "Different",
          _hostContext: hostToken(secret, "prepare_proposal", { ...args, title: "Different" }, idsOf(fixture), { toolUseId }),
        }),
      ).toThrowError(expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }));
    } finally {
      fixture.store.close();
      removeTempPluginDataRoot(root);
    }
  });

  it("the production path reaches Detail, selects a Section, and get_state shows the workflow view (E61/E62/§62)", async () => {
    await withPhase11(async (fixture, ctx, secret) => {
      driveToDetail(ctx, secret, fixture);
      // Dynamic Section DAG (§26): two sections; B depends on A's alias? Keep
      // it literal here — aliases are covered at the service level.
      const dagArgs = {
        proposal_type: "design_checkpoint",
        scope: { kind: "detail" },
        title: "Section DAG",
        summary: "A and B",
        changes: [
          { op: "SET_SECTION_REVISION", target: null, content: sectionRaw("Alpha", []), compactProjection: "section:alpha" },
          { op: "SET_SECTION_REVISION", target: null, content: sectionRaw("Beta", ["SEC-1"]), compactProjection: "section:beta" },
        ],
      };
      const dag = call(ctx, secret, fixture, "prepare_proposal", dagArgs) as { proposal: { proposal_id: string; revision: number; proposal_hash: string }; candidate: { section_ids: string[] } };
      expect(dag.candidate.section_ids).toEqual(["SEC-1", "SEC-2"]);
      const dagApproval = call(ctx, secret, fixture, "approve_proposal", {
        proposal_id: dag.proposal.proposal_id,
        proposal_revision: dag.proposal.revision,
        proposal_hash: dag.proposal.proposal_hash,
      }) as { approved: boolean };
      expect(dagApproval.approved).toBe(true);

      // select_section: the model supplies ONLY the section id (§12).
      const selected = call(ctx, secret, fixture, "select_section", { section_id: "SEC-1" }) as {
        status: string;
        idempotent: boolean;
        active_section: { section_id: string };
        run: { revision: number };
      };
      expect(selected).toMatchObject({ status: "ok", idempotent: false, active_section: { section_id: "SEC-1" } });
      const revisionAfterSelect = selected.run.revision;
      const again = call(ctx, secret, fixture, "select_section", { section_id: "SEC-1" }) as typeof selected;
      expect(again.idempotent).toBe(true);
      expect(again.run.revision).toBe(revisionAfterSelect);

      // get_state shows the compact workflow view (§62).
      const state = call(ctx, secret, fixture, "get_state", {}) as {
        activeSection: { section_id: string };
        sectionCounts: { open: number; completed: number; needsReview: number };
      };
      expect(state.activeSection).toEqual({ section_id: "SEC-1" });
      expect(state.sectionCounts).toEqual({ open: 2, completed: 0, needsReview: 0 });

      // Unknown section → SECTION_NOT_FOUND (§73).
      expect(() => call(ctx, secret, fixture, "select_section", { section_id: "SEC-999" })).toThrowError(
        expect.objectContaining({ code: "SECTION_NOT_FOUND" }),
      );
    });
  });
});

function sectionRaw(title: string, dependencies: string[]) {
  return {
    title,
    objective: `${title} objective`,
    design: `${title} design`,
    interfaces: [],
    invariants: [],
    failureModes: [],
    dependencies,
    decisionRefs: [],
    openQuestionRefs: [],
    impactRefs: [],
    contract: { provides: [], requires: [], invariants: [], interfaces: [], decisions: [] },
  };
}
