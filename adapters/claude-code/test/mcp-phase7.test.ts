/**
 * Phase 7 MCP surface: tools/list metadata (E27/E37/E38), start_or_resume
 * Cases A–E (E12–E15), get_state (E36), and the Formal Approval bridge into
 * the Phase 6 engine (E28–E35, E55–E59, E26, E45).
 */

import { describe, expect, it } from "vitest";

import {
  executePhasePlanTool,
  PHASE_PLAN_TOOLS,
  REQUIRES_USER_INTERACTION_META,
  type PhasePlanToolContext,
} from "../src/mcp/tools.js";
import { loadHostSecret } from "../src/host/secret.js";
import {
  buildHostContextEnvelope,
  businessInputHashOf,
  encodeHostContextToken,
  logicalToolName,
} from "../src/host/host-context.js";
import { issueEntryIntent } from "../src/host/entry-intent.js";
import { createBindingService } from "../src/session/binding-service.js";
import { discoverAndRegisterWorkspace } from "../src/workspace/identity.js";
import { initializePlanStore } from "../src/store/sqlite-store.js";
import {
  closeFixture,
  makeProposalFixture,
  prepareCheckpoint,
  CONSTRAINT_1,
  type ProposalFixture,
} from "./proposal-helpers.js";
import { fixedClock, makeTempPluginDataRoot, rawConnection, removeTempPluginDataRoot, storePathsFor } from "./store-helpers.js";

interface ToolHarness extends ProposalFixture {
  fixture: ProposalFixture;
  ctx: PhasePlanToolContext;
  secret: Buffer;
  root: string;
  close(): void;
}

async function makeToolHarness(): Promise<ToolHarness> {
  const root = makeTempPluginDataRoot("phase-plan-mcp7-");
  const fixture = await makeProposalFixture(root);
  const secret = loadHostSecret(root).key;
  return {
    fixture,
    ...fixture,
    secret,
    root,
    ctx: { store: fixture.store, secret, clock: fixedClock({ ids: ["x1"] }) },
    close: () => {
      closeFixture(fixture);
      removeTempPluginDataRoot(root);
    },
  };
}

function hostToken(
  h: ToolHarness,
  logical: string,
  businessInput: Record<string, unknown>,
  overrides: {
    permissionMode?: string;
    toolUseId?: string;
    secret?: Buffer;
    promptId?: string;
    sessionId?: string;
    runId?: string | null;
    bindingGeneration?: number | null;
    workspaceId?: string;
  } = {},
): string {
  const toolName = `mcp__plugin_phase-plan_phase-plan__${logical}`;
  return encodeHostContextToken(
    overrides.secret ?? h.secret,
    buildHostContextEnvelope({
      sessionId: overrides.sessionId ?? h.sessionId,
      promptId: overrides.promptId === undefined ? "PROMPT-1" : overrides.promptId,
      workspaceId: overrides.workspaceId ?? h.workspaceId,
      ...(overrides.runId === null ? {} : { runId: overrides.runId ?? h.runId }),
      ...(overrides.bindingGeneration === null ? {} : { bindingGeneration: overrides.bindingGeneration ?? h.generation }),
      permissionMode: overrides.permissionMode ?? "plan",
      toolUseId: overrides.toolUseId ?? "TU-1",
      toolName,
      businessInputHash: businessInputHashOf(businessInput),
    }),
  );
}

describe("tools/list metadata (E27/E37/E38)", () => {
  it("exposes exactly the three Phase 7 tools; approve_proposal carries real boolean requiresUserInteraction", () => {
    expect(PHASE_PLAN_TOOLS.map((tool) => tool.name)).toEqual(["start_or_resume", "get_state", "approve_proposal"]);
    const approve = PHASE_PLAN_TOOLS.find((tool) => tool.name === "approve_proposal")!;
    expect(approve._meta).toBe(REQUIRES_USER_INTERACTION_META);
    expect(approve._meta!["anthropic/requiresUserInteraction"]).toBe(true);
    expect(typeof approve._meta!["anthropic/requiresUserInteraction"]).toBe("boolean");
    // business schema only: exact id/revision/hash + reserved host field (E28)
    expect(approve.inputSchema.additionalProperties).toBe(false);
    expect(Object.keys(approve.inputSchema.properties as Record<string, unknown>).sort()).toEqual(
      ["_hostContext", "proposal_hash", "proposal_id", "proposal_revision"],
    );
    // no prepare_proposal or other committed-mutation surface (E37)
    expect(PHASE_PLAN_TOOLS.some((tool) => tool.name.includes("prepare"))).toBe(false);
  });
});

describe("start_or_resume (E12/E13/E14/E15/E62/E63)", () => {
  it("Case A: exact attached session returns the existing run without creating a new one", async () => {
    const h = await makeToolHarness();
    try {
      const before = h.ctx.store.withRead((tx) => tx.prepare("SELECT count(*) AS n FROM planning_runs").get());
      const result = executePhasePlanTool(h.ctx, "start_or_resume", {
        _entryIntent: issueEntryIntent(h.secret, { sessionId: h.sessionId, promptId: "PROMPT-1" }),
        _hostContext: hostToken(h, "start_or_resume", {}),
      });
      expect(result).toMatchObject({ status: "resumed", started: false, reattached: false });
      expect((result.run as { id: string }).id).toBe(h.runId);
      expect(h.ctx.store.withRead((tx) => tx.prepare("SELECT count(*) AS n FROM planning_runs").get())).toEqual(before);
    } finally {
      h.close();
    }
  });

  it("Case B: detached exact-session run reattaches with generation+1 (E13)", async () => {
    const h = await makeToolHarness();
    try {
      const bindings = createBindingService(h.ctx.store, fixedClock());
      const detached = bindings.detach({ runId: h.runId, sessionId: h.sessionId });
      const result = executePhasePlanTool(h.ctx, "start_or_resume", {
        _entryIntent: issueEntryIntent(h.secret, { sessionId: h.sessionId, promptId: "PROMPT-1" }),
        _hostContext: hostToken(h, "start_or_resume", {}, { bindingGeneration: null }),
      });
      expect(result).toMatchObject({ status: "resumed", reattached: true });
      expect((result.binding as { generation: number }).generation).toBe(detached.generation + 1);
    } finally {
      h.close();
    }
  });

  it("Case C: fresh workspace + goal → new run atomically (E12)", async () => {
    const root = makeTempPluginDataRoot("phase-plan-mcp7-new-");
    try {
      const store = await initializePlanStore({ pluginDataRoot: root });
      const projectDir = `${root}/project`;
      await import("node:fs").then((fs) => fs.mkdirSync(projectDir, { recursive: true }));
      const { registration } = await discoverAndRegisterWorkspace(store, projectDir, fixedClock({ ids: ["r", "w"] }));
      const secret = loadHostSecret(root).key;
      const ctx: PhasePlanToolContext = { store, secret, clock: fixedClock({ ids: ["run1", "b1"] }) };
      const business = { goal: "new plan" };
      const result = executePhasePlanTool(ctx, "start_or_resume", {
        ...business,
        _entryIntent: issueEntryIntent(secret, { sessionId: "S9", promptId: "P9" }),
        _hostContext: encodeHostContextToken(
          secret,
          buildHostContextEnvelope({
            sessionId: "S9",
            promptId: "P9",
            workspaceId: registration.workspace.workspaceId,
            permissionMode: "plan",
            toolUseId: "TU-C",
            toolName: "mcp__phase-plan__start_or_resume",
            businessInputHash: businessInputHashOf(business),
          }),
        ),
      });
      expect(result).toMatchObject({ status: "started", started: true });
      expect((result.binding as { generation: number }).generation).toBe(1);
      store.close();
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("Case D: other sessions' active runs → structured selection without leaking session ids (E14/E15)", async () => {
    const h = await makeToolHarness();
    try {
      const result = executePhasePlanTool(h.ctx, "start_or_resume", {
        _entryIntent: issueEntryIntent(h.secret, { sessionId: "S-NEW", promptId: "PROMPT-1" }),
        _hostContext: hostToken(h, "start_or_resume", {}, { sessionId: "S-NEW" }),
      });
      expect(result.status).toBe("selection_required");
      expect(result.code).toBe("RUN_SELECTION_REQUIRED");
      expect(result.takeover_required).toBe(true);
      const runs = result.runs as Array<Record<string, unknown>>;
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ run_id: h.runId, stage: "architecture" });
      expect(JSON.stringify(runs)).not.toContain("S1");
      // TAKEOVER_REQUIRED is the designated future path, never an auto-attach
    } finally {
      h.close();
    }
  });

  it("Case E: action=start_new creates a second run while other sessions' runs stay active", async () => {
    const h = await makeToolHarness();
    try {
      const result = executePhasePlanTool(h.ctx, "start_or_resume", {
        action: "start_new",
        goal: "parallel plan",
        _entryIntent: issueEntryIntent(h.secret, { sessionId: "S-NEW", promptId: "PROMPT-1" }),
        _hostContext: hostToken(h, "start_or_resume", { action: "start_new", goal: "parallel plan" }, { sessionId: "S-NEW" }),
      });
      expect(result).toMatchObject({ status: "started", started: true });
      const active = h.ctx.store.withRead((tx) =>
        tx.prepare("SELECT count(*) AS n FROM planning_runs WHERE lifecycle = 'active'").get(),
      );
      expect(active).toEqual({ n: 2 });
    } finally {
      h.close();
    }
  });

  it("start_new without a goal, missing context, or a wrong entry intent fails with stable codes", async () => {
    const h = await makeToolHarness();
    try {
      expect(() =>
        executePhasePlanTool(h.ctx, "start_or_resume", {
          _entryIntent: issueEntryIntent(h.secret, { sessionId: "S-NEW", promptId: "PROMPT-1" }),
          _hostContext: hostToken(h, "start_or_resume", { action: "start_new" }, { sessionId: "S-NEW" }),
          action: "start_new",
        }),
      ).toThrowError(expect.objectContaining({ code: "INVALID_RUN_GOAL" }));

      expect(() =>
        executePhasePlanTool(h.ctx, "start_or_resume", {
          _entryIntent: issueEntryIntent(h.secret, { sessionId: h.sessionId, promptId: "PROMPT-1" }),
        }),
      ).toThrowError(expect.objectContaining({ code: "HOST_CONTEXT_REQUIRED" }));

      // E62: model calls without a valid token (hook disabled scenario can't even get here without context)
      expect(() =>
        executePhasePlanTool(h.ctx, "start_or_resume", {
          _hostContext: hostToken(h, "start_or_resume", {}),
        }),
      ).toThrowError(expect.objectContaining({ code: "ENTRY_INTENT_REQUIRED" }));

      // E63: token bound to another prompt
      expect(() =>
        executePhasePlanTool(h.ctx, "start_or_resume", {
          _entryIntent: issueEntryIntent(h.secret, { sessionId: h.sessionId, promptId: "OTHER-PROMPT" }),
          _hostContext: hostToken(h, "start_or_resume", {}),
        }),
      ).toThrowError(expect.objectContaining({ code: "ENTRY_INTENT_INVALID" }));

      // unknown business field
      expect(() =>
        executePhasePlanTool(h.ctx, "start_or_resume", {
          _entryIntent: issueEntryIntent(h.secret, { sessionId: h.sessionId, promptId: "PROMPT-1" }),
          _hostContext: hostToken(h, "start_or_resume", { evil: true }),
          evil: true,
        }),
      ).toThrowError(expect.objectContaining({ code: "MCP_INPUT_INVALID" }));

      // context signed for a ghost workspace
      expect(() =>
        executePhasePlanTool(h.ctx, "start_or_resume", {
          _entryIntent: issueEntryIntent(h.secret, { sessionId: h.sessionId, promptId: "PROMPT-1" }),
          _hostContext: hostToken(h, "start_or_resume", {}, { workspaceId: "WORKSPACE-GHOST" }),
        }),
      ).toThrowError(expect.objectContaining({ code: "HOST_CONTEXT_WORKSPACE_MISMATCH" }));
    } finally {
      h.close();
    }
  });
});

describe("get_state (E36)", () => {
  it("returns the §50 shape with the awaiting proposal summary; read-only", async () => {
    const h = await makeToolHarness();
    try {
      const empty = executePhasePlanTool(h.ctx, "get_state", { _hostContext: hostToken(h, "get_state", {}, { runId: null }) });
      // session S1 owns an active run → run reported even before any proposal
      expect((empty.run as { id: string }).id).toBe(h.runId);
      expect(empty.awaitingProposal).toBeUndefined();
      expect(empty.head).toBeUndefined();

      const prepared = prepareCheckpoint(h.fixture, [{ op: "ADD_CONSTRAINT", content: CONSTRAINT_1, compactProjection: "CONST-1" }]);
      const state = executePhasePlanTool(h.ctx, "get_state", { _hostContext: hostToken(h, "get_state", {}) });
      expect(state.head).toBeUndefined();
      expect(state.awaitingProposal).toMatchObject({
        id: prepared.proposal.proposalId,
        revision: prepared.proposal.revision,
        hash: prepared.proposal.proposalHash,
        type: "design_checkpoint",
        title: "Checkpoint",
      });
      // no mutation happened
      expect(h.ctx.store.withRead((tx) => tx.prepare("SELECT count(*) AS n FROM plan_commits").get())).toEqual({ n: 0 });
    } finally {
      h.close();
    }
  });

  it("empty state when the session owns nothing", async () => {
    const h = await makeToolHarness();
    try {
      const state = executePhasePlanTool(h.ctx, "get_state", {
        _hostContext: hostToken(h, "get_state", {}, { sessionId: "NOBODY" }),
      });
      expect(state).toEqual({});
    } finally {
      h.close();
    }
  });
});

describe("approve_proposal → Phase 6 engine (E28–E35, E55–E59)", () => {
  it("Allow-equivalent path: one UserApprovalAuthorization, one commit, HEAD pair updated (E31)", async () => {
    const h = await makeToolHarness();
    try {
      const prepared = prepareCheckpoint(h.fixture, [{ op: "ADD_CONSTRAINT", content: CONSTRAINT_1, compactProjection: "CONST-1" }]);
      const business = {
        proposal_id: prepared.proposal.proposalId,
        proposal_revision: prepared.proposal.revision,
        proposal_hash: prepared.proposal.proposalHash,
      };
      const result = executePhasePlanTool(h.ctx, "approve_proposal", {
        ...business,
        _hostContext: hostToken(h, "approve_proposal", business, { toolUseId: "TU-ALLOW" }),
      });
      expect(result).toMatchObject({
        approved: true,
        idempotent: false,
        new_run_revision: h.runRevision,
        new_stage: "architecture",
      });
      expect(typeof result.approval_id).toBe("string");
      expect(typeof result.commit_id).toBe("string");
      expect(typeof result.snapshot_id).toBe("string");
      // authorizationRequestId derived from the signed toolUseId (E32)
      const approval = h.ctx.store.withRead((tx) =>
        tx.prepare("SELECT authorization_request_id FROM approvals").get(),
      ) as { authorization_request_id: string };
      expect(approval.authorization_request_id).toBe("mcp-approve:TU-ALLOW");
      // HEAD now carries a commit
      const head = h.ctx.store.withRead((tx) =>
        tx.prepare("SELECT head_commit_id FROM plan_heads WHERE run_id = ?").get(h.runId),
      ) as { head_commit_id: string | null };
      expect(head.head_commit_id).toBe(result.commit_id);
    } finally {
      h.close();
    }
  });

  it("same authorized invocation replays idempotently (E35)", async () => {
    const h = await makeToolHarness();
    try {
      const prepared = prepareCheckpoint(h.fixture, [{ op: "ADD_CONSTRAINT", content: CONSTRAINT_1, compactProjection: "CONST-1" }]);
      const business = {
        proposal_id: prepared.proposal.proposalId,
        proposal_revision: prepared.proposal.revision,
        proposal_hash: prepared.proposal.proposalHash,
      };
      const first = executePhasePlanTool(h.ctx, "approve_proposal", {
        ...business,
        _hostContext: hostToken(h, "approve_proposal", business, { toolUseId: "TU-RETRY" }),
      });
      const second = executePhasePlanTool(h.ctx, "approve_proposal", {
        ...business,
        _hostContext: hostToken(h, "approve_proposal", business, { toolUseId: "TU-RETRY" }),
      });
      expect(second.approved).toBe(true);
      expect(second.idempotent).toBe(true);
      expect(second.commit_id).toBe(first.commit_id);
      expect(second.approval_id).toBe(first.approval_id);
      expect(h.ctx.store.withRead((tx) => tx.prepare("SELECT count(*) AS n FROM plan_commits").get())).toEqual({ n: 1 });
    } finally {
      h.close();
    }
  });

  it("E55: hook disabled → HOST_CONTEXT_REQUIRED even when the MCP env session id looks right", async () => {
    const h = await makeToolHarness();
    try {
      const prepared = prepareCheckpoint(h.fixture, [{ op: "ADD_CONSTRAINT", content: CONSTRAINT_1, compactProjection: "CONST-1" }]);
      expect(() =>
        executePhasePlanTool(h.ctx, "approve_proposal", {
          proposal_id: prepared.proposal.proposalId,
          proposal_revision: prepared.proposal.revision,
          proposal_hash: prepared.proposal.proposalHash,
        }),
      ).toThrowError(expect.objectContaining({ code: "HOST_CONTEXT_REQUIRED" }));
      // and nothing was committed
      expect(h.ctx.store.withRead((tx) => tx.prepare("SELECT count(*) AS n FROM plan_commits").get())).toEqual({ n: 0 });
    } finally {
      h.close();
    }
  });

  it("E56: forged HostContext never falls back to environment authority", async () => {
    const h = await makeToolHarness();
    try {
      const otherRoot = makeTempPluginDataRoot("phase-plan-mcp7-forge-");
      try {
        const business = { proposal_id: "P", proposal_revision: 1, proposal_hash: "sha256:x" };
        expect(() =>
          executePhasePlanTool(h.ctx, "approve_proposal", {
            ...business,
            _hostContext: hostToken({ ...h, secret: loadHostSecret(otherRoot).key } as ToolHarness, "approve_proposal", business),
          }),
        ).toThrowError(expect.objectContaining({ code: "HOST_CONTEXT_INVALID" }));
      } finally {
        removeTempPluginDataRoot(otherRoot);
      }
    } finally {
      h.close();
    }
  });

  it("E57: correctly-signed stale binding still fails STALE_SESSION_BINDING (HMAC ≠ DB fencing)", async () => {
    const h = await makeToolHarness();
    try {
      const prepared = prepareCheckpoint(h.fixture, [{ op: "ADD_CONSTRAINT", content: CONSTRAINT_1, compactProjection: "CONST-1" }]);
      const business = {
        proposal_id: prepared.proposal.proposalId,
        proposal_revision: prepared.proposal.revision,
        proposal_hash: prepared.proposal.proposalHash,
      };
      // signed while generation was G — then ownership moves on (takeover)
      const staleToken = hostToken(h, "approve_proposal", business, { toolUseId: "TU-STALE" });
      const bindings = createBindingService(h.ctx.store, fixedClock());
      bindings.takeover({
        runId: h.runId,
        newSessionId: "S2-TAKEOVER",
        workspaceId: h.workspaceId,
        expectedGeneration: h.generation,
      });
      expect(() =>
        executePhasePlanTool(h.ctx, "approve_proposal", { ...business, _hostContext: staleToken }),
      ).toThrowError(expect.objectContaining({ code: "STALE_SESSION_BINDING" }));
    } finally {
      h.close();
    }
  });

  it("E58: start_or_resume context replayed at approve_proposal fails HOST_CONTEXT_TOOL_MISMATCH", async () => {
    const h = await makeToolHarness();
    try {
      const business = { proposal_id: "P", proposal_revision: 1, proposal_hash: "sha256:x" };
      expect(() =>
        executePhasePlanTool(h.ctx, "approve_proposal", {
          ...business,
          _hostContext: hostToken(h, "start_or_resume", business),
        }),
      ).toThrowError(expect.objectContaining({ code: "HOST_CONTEXT_TOOL_MISMATCH" }));
    } finally {
      h.close();
    }
  });

  it("E59: business input tampered after signing fails BEFORE the Phase 6 hash check", async () => {
    const h = await makeToolHarness();
    try {
      const prepared = prepareCheckpoint(h.fixture, [{ op: "ADD_CONSTRAINT", content: CONSTRAINT_1, compactProjection: "CONST-1" }]);
      const signed = {
        proposal_id: prepared.proposal.proposalId,
        proposal_revision: prepared.proposal.revision,
        proposal_hash: "sha256:signed-value",
      };
      try {
        executePhasePlanTool(h.ctx, "approve_proposal", {
          ...signed,
          proposal_hash: "sha256:tampered",
          _hostContext: hostToken(h, "approve_proposal", signed),
        });
        expect.unreachable("tampered input must fail");
      } catch (err) {
        expect((err as { code: string }).code).toBe("HOST_CONTEXT_INPUT_MISMATCH");
        expect((err as { code: string }).code).not.toBe("PROPOSAL_HASH_MISMATCH");
      }
    } finally {
      h.close();
    }
  });

  it("E29: model-supplied authority fields are rejected, never honored", async () => {
    const h = await makeToolHarness();
    try {
      for (const injection of [
        { authorizationRequestId: "AUTH-FORGED" },
        { sessionId: "S-EVIL" },
        { workspaceId: "W-EVIL" },
        { runId: "R-EVIL" },
        { generation: 99 },
        { approved: true },
        { actor: "user" },
        { force: true },
      ]) {
        expect(() =>
          executePhasePlanTool(h.ctx, "approve_proposal", {
            proposal_id: "P",
            proposal_revision: 1,
            proposal_hash: "sha256:x",
            _hostContext: hostToken(h, "approve_proposal", { proposal_id: "P", proposal_revision: 1, proposal_hash: "sha256:x" }),
            ...injection,
          }),
        ).toThrowError(expect.objectContaining({ code: "MCP_INPUT_INVALID" }));
      }
    } finally {
      h.close();
    }
  });

  it("signed observation of a non-plan mode cannot drive Formal Approval (PLAN_MODE_REQUIRED)", async () => {
    const h = await makeToolHarness();
    try {
      const business = { proposal_id: "P", proposal_revision: 1, proposal_hash: "sha256:x" };
      expect(() =>
        executePhasePlanTool(h.ctx, "approve_proposal", {
          ...business,
          _hostContext: hostToken(h, "approve_proposal", business, { permissionMode: "default" }),
        }),
      ).toThrowError(expect.objectContaining({ code: "PLAN_MODE_REQUIRED" }));
    } finally {
      h.close();
    }
  });
});

describe("schema v5 stays frozen through the whole Phase 7 flow (E45)", () => {
  it("entry + approve leave PRAGMA user_version == 5", async () => {
    const h = await makeToolHarness();
    try {
      executePhasePlanTool(h.ctx, "start_or_resume", {
        _entryIntent: issueEntryIntent(h.secret, { sessionId: h.sessionId, promptId: "PROMPT-1" }),
        _hostContext: hostToken(h, "start_or_resume", {}),
      });
      const prepared = prepareCheckpoint(h.fixture, [{ op: "ADD_CONSTRAINT", content: CONSTRAINT_1, compactProjection: "CONST-1" }]);
      const business = {
        proposal_id: prepared.proposal.proposalId,
        proposal_revision: prepared.proposal.revision,
        proposal_hash: prepared.proposal.proposalHash,
      };
      executePhasePlanTool(h.ctx, "approve_proposal", {
        ...business,
        _hostContext: hostToken(h, "approve_proposal", business),
      });
      const raw = rawConnection(storePathsFor(h.root).databasePath);
      try {
        const row = raw.prepare("PRAGMA user_version").get() as Record<string, unknown>;
        expect(Object.values(row)[0]).toBe(5);
      } finally {
        raw.close();
      }
    } finally {
      h.close();
    }
  });
});

describe("tool naming contract", () => {
  it("plugin-scoped MCP tool names resolve to the logical names the handlers serve", () => {
    expect(logicalToolName("mcp__plugin_phase-plan_phase-plan__approve_proposal")).toBe("approve_proposal");
    expect(logicalToolName("mcp__phase-plan__start_or_resume")).toBe("start_or_resume");
    expect(logicalToolName("ExitPlanMode")).toBe("ExitPlanMode");
  });
});
