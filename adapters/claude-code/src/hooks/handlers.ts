/**
 * Phase Plan hook handlers (Phase 7 directive §14–§15, §36–§44).
 *
 * Each handler is a pure-ish function over a parsed hook input plus opened
 * dependencies; the hook runtime (run.ts) owns stdin/stdout/error policy.
 * Handlers NEVER write to stdout/stderr themselves and never decide exit
 * codes — they return a HookOutput.
 *
 * Layered fail-closed model:
 *   - hook layer: best-effort injection and guards (a dead/timed-out hook is
 *     invisible here — the host simply proceeds without its output);
 *   - MCP layer: every mutating handler verifies the signed HostContext and
 *     fails closed (HOST_CONTEXT_REQUIRED) when the hook never injected one.
 * So a disabled/failed hook can never CREATE authority — it can only remove
 * the ability to mutate, which is the safe direction.
 */

import { discoverAndRegisterWorkspace } from "../workspace/identity.js";
import { getWorkspaceById, type WorkspaceRecord } from "../store/repositories.js";
import { comparisonKey } from "../workspace/canonical-path.js";
import { getHeadCommitRecord } from "../store/plan-commits.js";
import type { PlanStore } from "../store/sqlite-store.js";
import type { StoreClock } from "../store/migration-runner.js";
import { createBindingService } from "../session/binding-service.js";
import { createPlanningRunService } from "../application/planning-run-service.js";
import { findAttachedActiveRun, findDetachedActiveRun, listSessionRuns } from "../session/session-lookup.js";
import { RuntimeError } from "../runtime/errors.js";
import { HookInputError } from "./parse.js";
import type {
  PermissionRequestInput,
  PreToolUseInput,
  SessionEndInput,
  SessionStartInput,
  UserPromptExpansionInput,
  UserPromptSubmitInput,
} from "./parse.js";
import {
  DRIFT_GUARD_REASON,
  EXIT_PLAN_MODE_REASON,
  allowWithPermissions,
  blockPrompt,
  contextOutput,
  denyPermissionRequest,
  denyTool,
  emptyOutput,
  askWithUpdatedInput,
  updatedInputNoDecision,
  type HookOutput,
} from "./output.js";
import {
  businessInputHashOf,
  encodeHostContextToken,
  buildHostContextEnvelope,
  logicalToolName,
  assertHostContextForTool,
  type HostContextLogicalTool,
} from "../host/host-context.js";
import { entryIntentIsCurrent, issueEntryIntent, verifyEntryIntent } from "../host/entry-intent.js";

/** Marker injected with the entry token and echoed by SKILL.md (§39 exception). */
export const PHASE_PLAN_ENTRY_MARKER = "phase-plan:entry-v1";

export interface HookHandlerDeps {
  store: PlanStore;
  secret: Buffer;
  clock: StoreClock;
}

/** §44: cwd must still sit inside the bound workspace for mutation contexts. */
function cwdInsideWorkspace(cwd: string | undefined, workspace: WorkspaceRecord): boolean {
  if (cwd === undefined || cwd.trim() === "") return false;
  const cwdKey = comparisonKey(cwd.trim());
  const rootKey = comparisonKey(workspace.canonicalRoot);
  return cwdKey === rootKey || cwdKey.startsWith(`${rootKey}\\`) || cwdKey.startsWith(`${rootKey}/`);
}

function deny(hookEventName: string, code: string, reason: string): HookOutput {
  return denyTool(hookEventName, `${code}: ${reason}`);
}

/** Tools that stay usable under host-state drift (directive §42 allowlist). */
const DRIFT_ALLOWLIST = new Set(["Read", "Glob", "Grep", "WebSearch", "WebFetch", "AskUserQuestion"]);

function isPhasePlanTool(logical: string): logical is HostContextLogicalTool {
  return logical === "start_or_resume" || logical === "get_state" || logical === "approve_proposal";
}

// ---------------------------------------------------------------------------
// SessionStart (directive §36/§37)
// ---------------------------------------------------------------------------

export async function handleSessionStart(deps: HookHandlerDeps, input: SessionStartInput): Promise<HookOutput> {
  if (input.cwd === undefined || input.cwd.trim() === "") {
    return emptyOutput();
  }
  // One-time per session start: full discovery is affordable here (never per
  // prompt — directive §40). startup never auto-attaches other sessions' runs.
  const { registration } = await discoverAndRegisterWorkspace(deps.store, input.cwd, deps.clock);
  const workspaceId = registration.workspace.workspaceId;

  if (input.source === "resume") {
    // Exact-session reattach only (frozen spec §23.4): same session id, same
    // workspace, detached ACTIVE run. clear/fork/startup never inherit.
    const detached = findDetachedActiveRun(deps.store, input.sessionId, workspaceId);
    if (detached !== null) {
      const runs = createPlanningRunService(deps.store, deps.clock);
      runs.reattachActiveRun({
        runId: detached.binding.runId,
        workspaceId,
        sessionId: input.sessionId,
      });
    }
  }

  const attached = findAttachedActiveRun(deps.store, input.sessionId);
  if (attached === null || attached.run === null) {
    return emptyOutput();
  }
  const head = getHeadCommitRecord(deps.store, attached.run.runId);
  const context = [
    "Phase Plan active:",
    `run=${attached.run.runId}`,
    `stage=${attached.run.stage}`,
    `head=${head === null ? "none" : head.resultingSnapshotId}`,
  ];
  // Amendment A1 §7: SessionStart recovers planning STATE, never the host's
  // Plan Mode. When the mode is missing the recovered run stays fail-closed
  // (UserPromptSubmit/PreToolUse guards) until /phase-plan re-entry.
  if (input.permissionMode !== "plan") {
    context.push(
      "Phase Plan run recovered.",
      "Claude Plan Mode must be restored by invoking /phase-plan.",
    );
  }
  return contextOutput("SessionStart", context.join("\n"));
}

// ---------------------------------------------------------------------------
// SessionEnd (directive §38) — advisory detach, correctness never depends on it
// ---------------------------------------------------------------------------

export function handleSessionEnd(deps: HookHandlerDeps, _input: SessionEndInput): HookOutput {
  const bindings = createBindingService(deps.store, deps.clock);
  for (const entry of listSessionRuns(deps.store, _input.sessionId)) {
    if (entry.binding.state !== "attached") continue;
    try {
      // Best-effort: generation++ so a stale token can never write later.
      bindings.detach({ runId: entry.binding.runId, sessionId: _input.sessionId });
    } catch {
      // swallow: SessionEnd is advisory; takeover fencing provides correctness
    }
  }
  return emptyOutput();
}

// ---------------------------------------------------------------------------
// UserPromptSubmit drift guard (directive §39/§40)
// ---------------------------------------------------------------------------

/** Fast: binding+run reads only — no workspace discovery on the prompt path. */
export function handleUserPromptSubmit(deps: HookHandlerDeps, input: UserPromptSubmitInput): HookOutput {
  const attached = findAttachedActiveRun(deps.store, input.sessionId);
  if (attached === null || attached.run === null) {
    return emptyOutput();
  }
  // The /phase-plan entry itself must always be able to pass (directive §39):
  // raw slash invocation, or the expanded prompt carrying the entry marker
  // (hook ordering between UserPromptExpansion and UserPromptSubmit is a host
  // detail we cannot observe; both spellings pass).
  const prompt = input.prompt.trimStart();
  if (prompt.startsWith("/phase-plan") || prompt.includes(PHASE_PLAN_ENTRY_MARKER)) {
    return emptyOutput();
  }
  if (input.permissionMode !== "plan") {
    // Known active binding + not plan → fail closed (directive §40).
    return blockPrompt(DRIFT_GUARD_REASON);
  }
  return emptyOutput();
}

// ---------------------------------------------------------------------------
// UserPromptExpansion — signed EntryIntent for the /phase-plan turn (§10/§11)
// ---------------------------------------------------------------------------

export function handleUserPromptExpansion(deps: HookHandlerDeps, input: UserPromptExpansionInput): HookOutput {
  if (input.commandName !== "phase-plan") {
    return emptyOutput();
  }
  if (input.promptId === undefined || input.promptId === "") {
    throw new HookInputError([{ field: "prompt_id", problem: "is required to bind an entry intent to its prompt" }]);
  }
  const token = issueEntryIntent(deps.secret, { sessionId: input.sessionId, promptId: input.promptId });
  const context = [
    `${PHASE_PLAN_ENTRY_MARKER} token: ${token}`,
    "Pass this token as the _entryIntent argument of the phase-plan start_or_resume tool call. Do not alter or fabricate it.",
  ].join("\n");
  return contextOutput("UserPromptExpansion", context);
}

// ---------------------------------------------------------------------------
// PreToolUse (directive §14, §29, §41, §42, §44)
// ---------------------------------------------------------------------------

export async function handlePreToolUse(deps: HookHandlerDeps, input: PreToolUseInput): Promise<HookOutput> {
  const eventName = "PreToolUse";
  const logical = logicalToolName(input.toolName);

  // §41 — ExitPlanMode can never end an active PlanningRun early (any mode).
  if (logical === "ExitPlanMode") {
    const attached = findAttachedActiveRun(deps.store, input.sessionId);
    if (attached !== null) {
      return denyTool(eventName, EXIT_PLAN_MODE_REASON);
    }
    return emptyOutput();
  }

  if (isPhasePlanTool(logical)) {
    return handlePhasePlanPreToolUse(deps, input, eventName, logical);
  }

  // §42 — host-state drift guard: active run + not plan mode → allowlist only.
  const attached = findAttachedActiveRun(deps.store, input.sessionId);
  if (attached !== null && input.permissionMode !== "plan") {
    if (DRIFT_ALLOWLIST.has(logical)) {
      return emptyOutput();
    }
    return deny(
      eventName,
      "PLAN_MODE_REQUIRED",
      `host-state drift: an active Phase Plan run requires Plan Mode; '${input.toolName}' is mutation-capable and denied. Invoke /phase-plan to restore planning mode.`,
    );
  }

  // §43 — normal Plan Mode stays governed by Claude Code; no duplication.
  return emptyOutput();
}

async function handlePhasePlanPreToolUse(
  deps: HookHandlerDeps,
  input: PreToolUseInput,
  eventName: string,
  logical: HostContextLogicalTool,
): Promise<HookOutput> {
  const toolInput = input.toolInput;

  if (logical === "start_or_resume") {
    // §14 — verify the EntryIntent BEFORE anything else.
    const rawToken = toolInput._entryIntent;
    if (typeof rawToken !== "string" || rawToken === "") {
      return deny(eventName, "ENTRY_INTENT_REQUIRED", "start_or_resume requires the signed entry token from /phase-plan; the model cannot enter Phase Plan on its own");
    }
    let intent;
    try {
      intent = verifyEntryIntent(deps.secret, rawToken);
    } catch (err) {
      return deny(eventName, "ENTRY_INTENT_INVALID", err instanceof Error ? err.message : String(err));
    }
    if (!entryIntentIsCurrent(intent, { sessionId: input.sessionId, promptId: input.promptId })) {
      return deny(eventName, "ENTRY_INTENT_INVALID", "entry intent is bound to a different session or prompt");
    }
    // Register the exact workspace the hook observes (§14) and sign it in.
    let workspaceId: string;
    try {
      if (input.cwd === undefined || input.cwd.trim() === "") {
        return deny(eventName, "WORKSPACE_UNAVAILABLE", "hook input carries no cwd; workspace cannot be discovered");
      }
      const { registration } = await discoverAndRegisterWorkspace(deps.store, input.cwd, deps.clock);
      workspaceId = registration.workspace.workspaceId;
    } catch (err) {
      return deny(eventName, "WORKSPACE_UNAVAILABLE", err instanceof Error ? err.message : String(err));
    }
    const attached = findAttachedActiveRun(deps.store, input.sessionId);
    const sameWorkspaceRun =
      attached !== null && attached.binding.workspaceId === workspaceId ? attached : null;
    const hostToken = encodeHostContextToken(
      deps.secret,
      buildHostContextEnvelope({
        sessionId: input.sessionId,
        ...(input.promptId === undefined ? {} : { promptId: input.promptId }),
        workspaceId,
        ...(sameWorkspaceRun === null
          ? {}
          : { runId: sameWorkspaceRun.binding.runId, bindingGeneration: sameWorkspaceRun.binding.generation }),
        permissionMode: input.permissionMode ?? "unknown",
        toolUseId: input.toolUseId,
        toolName: input.toolName,
        businessInputHash: businessInputHashOf(toolInput),
      }),
    );
    return askWithUpdatedInput(
      eventName,
      { ...toolInput, _entryIntent: rawToken, _hostContext: hostToken },
      "Enter Phase Plan planning mode for this session (host-mode orchestration; not a design approval).",
    );
  }

  // approve_proposal + get_state require an owned active run for mutation
  // context; reads degrade to a run-less session-scoped context.
  const attached = findAttachedActiveRun(deps.store, input.sessionId);
  if (attached === null || attached.run === null) {
    if (logical === "approve_proposal") {
      return deny(eventName, "STALE_SESSION_BINDING", "no active Phase Plan run is attached to the current session");
    }
    // get_state without a run still gets a session-scoped read context.
    return emptyOutput();
  }

  let workspace: WorkspaceRecord | null = null;
  if (input.cwd === undefined || input.cwd.trim() === "") {
    return deny(eventName, "WORKSPACE_UNAVAILABLE", "hook input carries no cwd; workspace cannot be verified");
  }
  workspace = getWorkspaceById(deps.store, attached.binding.workspaceId);
  if (workspace === null) {
    return deny(eventName, "HOST_CONTEXT_WORKSPACE_MISMATCH", "the bound workspace no longer exists in the catalog");
  }
  // §44 — cwd drift: mutation contexts are never signed outside the bound
  // workspace; reads stay available.
  if (logical === "approve_proposal" && !cwdInsideWorkspace(input.cwd, workspace)) {
    return deny(eventName, "WORKSPACE_MISMATCH", "the session has left the bound workspace; re-enter it to mutate Plan Memory");
  }
  // §29 — approve_proposal additionally requires the session to BE in Plan
  // Mode before a mutation context is signed at all.
  if (logical === "approve_proposal" && input.permissionMode !== "plan") {
    return deny(
      eventName,
      "PLAN_MODE_REQUIRED",
      `approve_proposal requires permission_mode=plan (observed '${input.permissionMode ?? "unknown"}'); invoke /phase-plan to restore planning mode`,
    );
  }

  const hostToken = encodeHostContextToken(
    deps.secret,
    buildHostContextEnvelope({
      sessionId: input.sessionId,
      ...(input.promptId === undefined ? {} : { promptId: input.promptId }),
      workspaceId: attached.binding.workspaceId,
      runId: attached.binding.runId,
      bindingGeneration: attached.binding.generation,
      permissionMode: input.permissionMode ?? "unknown",
      toolUseId: input.toolUseId,
      toolName: input.toolName,
      businessInputHash: businessInputHashOf(toolInput),
    }),
  );
  const updatedInput = { ...toolInput, _hostContext: hostToken };
  if (logical === "approve_proposal") {
    // §29 — never "allow": the mandatory human prompt must still happen.
    return askWithUpdatedInput(eventName, updatedInput, "approve_proposal requires explicit user approval.");
  }
  return updatedInputNoDecision(eventName, updatedInput);
}

// ---------------------------------------------------------------------------
// PermissionRequest (directive §15/§30)
// ---------------------------------------------------------------------------

export function handlePermissionRequest(deps: HookHandlerDeps, input: PermissionRequestInput): HookOutput {
  const logical = logicalToolName(input.toolName);

  if (logical === "start_or_resume") {
    const rawHostContext = input.toolInput._hostContext;
    if (typeof rawHostContext !== "string" || rawHostContext === "") {
      // PreToolUse updatedInput did not reach this event; the ordinary
      // permission flow proceeds unchanged (never a blind allow).
      return emptyOutput();
    }
    try {
      const envelope = assertHostContextForTool(deps.secret, rawHostContext, {
        tool: "start_or_resume",
        businessInput: input.toolInput,
      });
      if (envelope.sessionId !== input.sessionId) {
        return denyPermissionRequest("HOST_CONTEXT_INVALID: host context is bound to a different session");
      }
      if (envelope.promptId !== undefined && input.promptId !== undefined && envelope.promptId !== input.promptId) {
        return denyPermissionRequest("HOST_CONTEXT_INVALID: host context is bound to a different prompt");
      }
      const rawEntry = input.toolInput._entryIntent;
      const intent = verifyEntryIntent(deps.secret, rawEntry);
      if (!entryIntentIsCurrent(intent, { sessionId: input.sessionId, promptId: input.promptId })) {
        return denyPermissionRequest("ENTRY_INTENT_INVALID: entry intent is bound to a different session or prompt");
      }
      // §15/§16 — session-scoped Plan Mode transition: host-mode
      // orchestration backed by a verified human-origin entry intent.
      return allowWithPermissions([{ type: "setMode", mode: "plan", destination: "session" }]);
    } catch (err) {
      // Tampered/unverifiable tokens deny through the decision object —
      // exit 2 is not honored for PermissionRequest.
      const code = err instanceof RuntimeError ? err.code : "HOST_CONTEXT_INVALID";
      return denyPermissionRequest(`${code}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // §30 — the PermissionRequest hook NEVER auto-allows approve_proposal: no
  // allow response, no allow rule, no "don't ask again".
  return emptyOutput();
}
