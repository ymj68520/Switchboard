/**
 * Phase 7 MCP tool surface (Phase 7 directive §12–§13, §24–§28, §48–§52).
 *
 * Exactly three tools — the intentionally minimal Phase 7 set:
 *   start_or_resume  (entry, requires a signed EntryIntent from /phase-plan)
 *   get_state        (read-only, session-scoped)
 *   approve_proposal (the Formal Approval bridge into the Phase 6 engine,
 *                     marked anthropic/requiresUserInteraction=true)
 *
 * Authority model: every handler verifies the hook-signed HostContext first
 * (signature → tool binding → business-input hash). The MCP process's own
 * environment — including CLAUDE_CODE_SESSION_ID — is NEVER authority
 * (directive §19/§26). Tool visibility is not authority: stage/lifecycle/
 * binding/HEAD/proposal state is revalidated by the application services and
 * the Phase 6 engine on every call.
 */

import { getWorkspaceById } from "../store/repositories.js";
import { getAwaitingProposalRecord } from "../store/proposals.js";
import { getHeadCommitRecord } from "../store/plan-commits.js";
import { listPlanningRunsForWorkspaceRecord } from "../store/planning-runs.js";
import type { PlanStore } from "../store/sqlite-store.js";
import type { StoreClock } from "../store/migration-runner.js";
import type { PlanningRun } from "../core/planning-run.js";
import type { BindingSnapshot } from "../store/session-bindings.js";
import { createBindingService } from "../session/binding-service.js";
import { createPlanningRunService } from "../application/planning-run-service.js";
import { createPlanCommitEngine } from "../application/plan-commit-engine.js";
import { findAttachedActiveRun, findDetachedActiveRun, listSessionRuns } from "../session/session-lookup.js";
import { RuntimeError } from "../runtime/errors.js";
import { assertHostContextForTool } from "../host/host-context.js";
import { entryIntentIsCurrent, verifyEntryIntent } from "../host/entry-intent.js";

export interface PhasePlanToolContext {
  store: PlanStore;
  secret: Buffer;
  clock: StoreClock;
}

export interface PhasePlanToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Reserved host metadata (directive §28): real JSON boolean true. */
  _meta?: Record<string, unknown>;
}

export const REQUIRES_USER_INTERACTION_META = { "anthropic/requiresUserInteraction": true } as const;

export const PHASE_PLAN_TOOLS: readonly PhasePlanToolDefinition[] = [
  {
    name: "start_or_resume",
    description:
      "Enter Phase Plan: start a new planning run or resume the current session's active run. "
      + "Requires the signed _entryIntent token injected by the /phase-plan skill invocation; "
      + "the token cannot be fabricated. Returns started/resumed/selection_required state.",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string", description: "Planning goal; required when starting a new run." },
        action: { type: "string", enum: ["auto", "start_new"], description: "Defaults to auto." },
        _entryIntent: { type: "string", description: "Signed entry token from the /phase-plan expansion (do not modify)." },
        _hostContext: { type: "string", description: "Signed host context injected by the PreToolUse hook (do not modify)." },
      },
      required: ["_entryIntent"],
      additionalProperties: false,
    },
  },
  {
    name: "get_state",
    description:
      "Read the current session's Phase Plan state: run, binding, HEAD commit/snapshot pair, and the awaiting proposal summary. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        _hostContext: { type: "string", description: "Signed host context injected by the PreToolUse hook (do not modify)." },
      },
      required: ["_hostContext"],
      additionalProperties: false,
    },
  },
  {
    name: "approve_proposal",
    description:
      "Formally approve the run's awaiting proposal with EXACT id/revision/hash and commit it as an immutable PlanCommit. "
      + "This tool always requires explicit human approval and cannot be pre-authorized.",
    inputSchema: {
      type: "object",
      properties: {
        proposal_id: { type: "string" },
        proposal_revision: { type: "integer", minimum: 1 },
        proposal_hash: { type: "string" },
        _hostContext: { type: "string", description: "Signed host context injected by the PreToolUse hook (do not modify)." },
      },
      required: ["proposal_id", "proposal_revision", "proposal_hash", "_hostContext"],
      additionalProperties: false,
    },
    _meta: REQUIRES_USER_INTERACTION_META,
  },
];

function inputInvalid(message: string, cause?: string): RuntimeError {
  return new RuntimeError("MCP_INPUT_INVALID", message, cause === undefined ? {} : { cause });
}

function domainError(code: RuntimeError["code"], message: string): RuntimeError {
  return new RuntimeError(code, message);
}

/**
 * Strict business-schema enforcement (directive §27/§29): only the declared
 * business fields plus reserved host fields may be present. A model-supplied
 * session/workspace/generation/actor/authorizationRequestId/approved/force
 * field is REJECTED, never silently stripped.
 */
function assertExactBusinessFields(args: Record<string, unknown>, allowed: readonly string[]): void {
  const reserved = new Set(["_hostContext", "_entryIntent"]);
  const offending = Object.keys(args).filter((key) => !allowed.includes(key) && !reserved.has(key));
  if (offending.length > 0) {
    throw inputInvalid(
      `approve_proposal/start_or_resume business input accepts only [${allowed.join(", ")}]; rejected fields: ${offending.join(", ")}`,
      "model-supplied authority fields (session/workspace/generation/actor/authorizationRequestId/approved/force) are never accepted",
    );
  }
}

function requireHostContext(args: Record<string, unknown>): string {
  const token = args._hostContext;
  if (typeof token !== "string" || token === "") {
    throw domainError(
      "HOST_CONTEXT_REQUIRED",
      "no signed host context was injected for this call; the PreToolUse hook is required (model-supplied context is never authority)",
    );
  }
  return token;
}

function verifyEntryIntentCurrent(secret: Buffer, rawToken: unknown, current: { sessionId: string; promptId?: string }): void {
  if (typeof rawToken !== "string" || rawToken === "") {
    throw domainError("ENTRY_INTENT_REQUIRED", "start_or_resume requires the signed entry token from the /phase-plan skill invocation");
  }
  const intent = verifyEntryIntent(secret, rawToken);
  if (!entryIntentIsCurrent(intent, current)) {
    throw domainError("ENTRY_INTENT_INVALID", "entry intent is bound to a different session or prompt");
  }
}

function runView(run: PlanningRun): Record<string, unknown> {
  return { id: run.runId, lifecycle: run.lifecycle, stage: run.stage, revision: run.revision, goal: run.goal };
}

function bindingView(binding: BindingSnapshot): Record<string, unknown> {
  return { generation: binding.generation, state: binding.state };
}

/** §25: selectable run metadata — never other sessions' session ids. */
function selectableRunView(run: PlanningRun): Record<string, unknown> {
  return { run_id: run.runId, stage: run.stage, revision: run.revision, lifecycle: run.lifecycle, created_at: run.createdAt };
}

// ---------------------------------------------------------------------------
// start_or_resume (directive §24 Case A–E, §25)
// ---------------------------------------------------------------------------

export function handleStartOrResume(ctx: PhasePlanToolContext, rawArgs: Record<string, unknown>): Record<string, unknown> {
  assertExactBusinessFields(rawArgs, ["goal", "action", "_entryIntent"]);
  const args = rawArgs;
  const token = requireHostContext(args);
  const envelope = assertHostContextForTool(ctx.secret, token, { tool: "start_or_resume", businessInput: args });

  const workspace = getWorkspaceById(ctx.store, envelope.workspaceId);
  if (workspace === null) {
    throw domainError("HOST_CONTEXT_WORKSPACE_MISMATCH", `host context workspace '${envelope.workspaceId}' is not in the catalog`);
  }
  verifyEntryIntentCurrent(ctx.secret, args._entryIntent, { sessionId: envelope.sessionId, promptId: envelope.promptId });

  const action = args.action === undefined ? "auto" : args.action;
  if (action !== "auto" && action !== "start_new") {
    throw inputInvalid(`action must be "auto" or "start_new", received ${JSON.stringify(args.action)}`);
  }
  const goal = args.goal;
  if (goal !== undefined && (typeof goal !== "string" || goal.trim() === "")) {
    throw inputInvalid("goal must be a non-empty string when present");
  }

  const runs = createPlanningRunService(ctx.store, ctx.clock);
  const bindings = createBindingService(ctx.store, ctx.clock);

  // Case A — exact session attached to an active run in this workspace.
  const attached = findAttachedActiveRun(ctx.store, envelope.sessionId);
  if (attached !== null && attached.run !== null) {
    if (attached.binding.workspaceId !== envelope.workspaceId) {
      throw domainError(
        "WORKSPACE_MISMATCH",
        "the current session owns an active run bound to a different workspace; return to that workspace or take over explicitly",
      );
    }
    return { status: "resumed", started: false, reattached: false, run: runView(attached.run), binding: bindingView(attached.binding) };
  }

  // Case B — exact session has a detached active run in this workspace.
  const detached = findDetachedActiveRun(ctx.store, envelope.sessionId, envelope.workspaceId);
  if (detached !== null && detached.run !== null) {
    const reattached = bindings.reattach({
      runId: detached.binding.runId,
      workspaceId: envelope.workspaceId,
      sessionId: envelope.sessionId,
    });
    return {
      status: "resumed",
      started: false,
      reattached: true,
      run: runView(detached.run),
      binding: bindingView(reattached),
    };
  }

  const activeRuns = listPlanningRunsForWorkspaceRecord(ctx.store, envelope.workspaceId, { lifecycle: "active" });
  const ownRunIds = new Set(listSessionRuns(ctx.store, envelope.sessionId).map((entry) => entry.binding.runId));
  const otherSessionRuns = activeRuns.filter((run) => !ownRunIds.has(run.runId));

  // Case E — explicit start_new is allowed while the session owns nothing.
  if (action === "start_new") {
    return createNewRun(ctx, envelope.sessionId, envelope.workspaceId, runs, goal === undefined ? undefined : goal);
  }

  // Case D — auto never guesses among other sessions' runs.
  if (otherSessionRuns.length > 0) {
    return {
      status: "selection_required",
      code: "RUN_SELECTION_REQUIRED",
      runs: otherSessionRuns.map(selectableRunView),
      takeover_required: true,
      message:
        "This workspace has active planning runs owned by other sessions. Phase Plan never attaches to them automatically; "
        + "takeover is a separate human-authorized operation (TAKEOVER_REQUIRED), or pass action=start_new with a goal to begin a new run.",
    };
  }

  // Case C — nothing relevant active: create a new run (goal required).
  return createNewRun(ctx, envelope.sessionId, envelope.workspaceId, runs, goal === undefined ? undefined : goal);
}

function createNewRun(
  ctx: PhasePlanToolContext,
  sessionId: string,
  workspaceId: string,
  runs: ReturnType<typeof createPlanningRunService>,
  goal: string | undefined,
): Record<string, unknown> {
  if (typeof goal !== "string" || goal.trim() === "") {
    throw domainError("INVALID_RUN_GOAL", "starting a new planning run requires a non-empty goal");
  }
  const created = runs.createPlanningRun({ workspaceId, sessionId, goal });
  return { status: "started", started: true, run: runView(created.run), binding: bindingView(created.binding) };
}

// ---------------------------------------------------------------------------
// get_state (directive §26/§50) — read-only, current session+workspace scoped
// ---------------------------------------------------------------------------

export function handleGetState(ctx: PhasePlanToolContext, rawArgs: Record<string, unknown>): Record<string, unknown> {
  assertExactBusinessFields(rawArgs, []);
  const token = requireHostContext(rawArgs);
  const envelope = assertHostContextForTool(ctx.secret, token, { tool: "get_state", businessInput: rawArgs });

  const entries = listSessionRuns(ctx.store, envelope.sessionId).filter(
    (entry) => entry.binding.workspaceId === envelope.workspaceId,
  );
  const preferred =
    entries.find((entry) => entry.binding.state === "attached" && entry.run?.lifecycle === "active") ??
    entries.find((entry) => entry.run?.lifecycle === "active") ??
    null;
  if (preferred === null || preferred.run === null) {
    return {};
  }
  const head = getHeadCommitRecord(ctx.store, preferred.run.runId);
  const awaiting = getAwaitingProposalRecord(ctx.store, preferred.run.runId);
  return {
    run: {
      id: preferred.run.runId,
      lifecycle: preferred.run.lifecycle,
      stage: preferred.run.stage,
      revision: preferred.run.revision,
    },
    binding: {
      generation: preferred.binding.generation,
      state: preferred.binding.state,
    },
    ...(head === null
      ? {}
      : { head: { snapshotId: head.resultingSnapshotId, commitId: head.commitId } }),
    ...(awaiting === null
      ? {}
      : {
          awaitingProposal: {
            id: awaiting.proposalId,
            revision: awaiting.revision,
            hash: awaiting.proposalHash,
            type: awaiting.type,
            title: awaiting.title,
          },
        }),
  };
}

// ---------------------------------------------------------------------------
// approve_proposal (directive §27–§32) — the Formal Approval bridge
// ---------------------------------------------------------------------------

export function handleApproveProposal(ctx: PhasePlanToolContext, rawArgs: Record<string, unknown>): Record<string, unknown> {
  // §27/§29 — exact business schema; model-supplied authority fields rejected.
  assertExactBusinessFields(rawArgs, ["proposal_id", "proposal_revision", "proposal_hash"]);
  const args = rawArgs;
  const token = requireHostContext(args);
  const envelope = assertHostContextForTool(ctx.secret, token, { tool: "approve_proposal", businessInput: args });

  if (typeof args.proposal_id !== "string" || args.proposal_id === "") {
    throw inputInvalid("proposal_id must be a non-empty string");
  }
  if (typeof args.proposal_revision !== "number" || !Number.isInteger(args.proposal_revision) || args.proposal_revision < 1) {
    throw inputInvalid("proposal_revision must be a positive integer");
  }
  if (typeof args.proposal_hash !== "string" || args.proposal_hash === "") {
    throw inputInvalid("proposal_hash must be a non-empty string");
  }

  // Plan Mode is the host-owned planning boundary: a signed context observed
  // outside plan mode can never drive the Formal Approval (§29).
  if (envelope.permissionMode !== "plan") {
    throw domainError("PLAN_MODE_REQUIRED", `approve_proposal requires permission_mode=plan (observed '${envelope.permissionMode}')`);
  }
  // Signed observation (§23) — the engine revalidates both against the Store.
  if (envelope.runId === undefined || envelope.bindingGeneration === undefined) {
    throw domainError("STALE_SESSION_BINDING", "no active Phase Plan run is attached to the current session");
  }

  // §31/§32 — the authorization request id derives from the SIGNED
  // HostContext.toolUseId, never from tool input.
  const engine = createPlanCommitEngine(ctx.store, ctx.clock);
  const result = engine.commitAuthorizedProposal({
    runId: envelope.runId,
    workspaceId: envelope.workspaceId,
    sessionId: envelope.sessionId,
    bindingGeneration: envelope.bindingGeneration,
    authorization: {
      authorizationRequestId: `mcp-approve:${envelope.toolUseId}`,
      proposalId: args.proposal_id,
      proposalRevision: args.proposal_revision,
      proposalHash: args.proposal_hash,
    },
  });
  return {
    approved: true,
    approval_id: result.approvalId,
    commit_id: result.commitId,
    snapshot_id: result.snapshotId,
    idempotent: result.idempotent,
    new_run_revision: result.runRevision,
    new_stage: result.stage,
  };
}

// ---------------------------------------------------------------------------

export function executePhasePlanTool(ctx: PhasePlanToolContext, name: string, rawArgs: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case "start_or_resume":
      return handleStartOrResume(ctx, rawArgs);
    case "get_state":
      return handleGetState(ctx, rawArgs);
    case "approve_proposal":
      return handleApproveProposal(ctx, rawArgs);
    default:
      throw new RuntimeError("MCP_INPUT_INVALID", `unknown tool '${name}'`);
  }
}
