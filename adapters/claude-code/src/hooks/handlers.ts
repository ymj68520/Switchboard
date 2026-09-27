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
import * as path from "node:path";
import type { PlanStore } from "../store/sqlite-store.js";
import type { StoreClock } from "../store/migration-runner.js";
import { createBlobStore, type BlobStore } from "../store/blob-store.js";
import { createBindingService } from "../session/binding-service.js";
import { createPlanningRunService } from "../application/planning-run-service.js";
import { findAttachedActiveRun, findDetachedActiveRun, listSessionRuns } from "../session/session-lookup.js";
import { captureObservation } from "../observations/capture.js";
import { observationClassForTool } from "../observations/classify.js";
import type { ObservationCaptureEvent } from "../observations/types.js";
import { toRuntimeError } from "../runtime/errors.js";
import { RuntimeError } from "../runtime/errors.js";
import { HookInputError } from "./parse.js";
import type {
  PermissionRequestInput,
  PostToolUseInput,
  PreToolUseInput,
  SessionEndInput,
  SessionStartInput,
  UserPromptExpansionInput,
  UserPromptSubmitInput,
} from "./parse.js";
import {
  DRIFT_GUARD_REASON,
  EXIT_PLAN_MODE_REASON,
  HANDOFF_PENDING_EXIT_PLAN_MODE_REASON,
  HANDOFF_PENDING_EXECUTION_GUARD_REASON,
  allowWithPermissions,
  blockPrompt,
  contextOutput,
  denyPermissionRequest,
  denyTool,
  emptyOutput,
  askWithUpdatedInput,
  updatedInputNoDecision,
  allowWithUpdatedInput,
  type HookOutput,
} from "./output.js";
import {
  businessInputHashOf,
  encodeHostContextToken,
  encodeHostContextTokenV2,
  buildHostContextEnvelope,
  buildHostContextEnvelopeV2,
  logicalToolName,
  assertHostContextForTool,
  type HostContextLogicalTool,
} from "../host/host-context.js";
import { entryIntentIsCurrent, issueEntryIntent, verifyEntryIntent } from "../host/entry-intent.js";
import {
  buildExecutionHostContextEnvelope,
  encodeExecutionHostContextToken,
} from "../host/execution-context.js";
import { createHandoffService, isHandoffPendingInTx } from "../application/handoff-service.js";
import { renderExecutionContract, type ExecutionHandoffV1 } from "../core/execution-handoff.js";
import {
  findAttachedExecutionBindingForSessionInTx,
  findDeliveredHandoffForSessionToolUseInTx,
  findRunIdByDeliveryIdentityInTx,
  getExecutionBindingInTx,
  getExecutionHandoffInTx,
  getExecutionHandoffStateInTx,
  listExecutionBindingsForSessionInTx,
  reattachExecutionBindingInTx,
  detachExecutionBindingInTx,
} from "../store/execution.js";
import { getFinalPlanInTx } from "../store/finalization.js";
import { parsePlanningRunRow } from "../core/planning-run.js";
import { createStoreContextSource } from "../application/context-read-model.js";
import { assembleContext } from "../context/assembler.js";
import { deriveContextEpochFromSource } from "../context/epoch.js";
import { buildRecoveryCapsule } from "../context/capsule.js";

/** Marker injected with the entry token and echoed by SKILL.md (§39 exception). */
export const PHASE_PLAN_ENTRY_MARKER = "phase-plan:entry-v1";

export interface HookHandlerDeps {
  store: PlanStore;
  secret: Buffer;
  clock: StoreClock;
  /** Optional override of the content-addressed blob store (tests). */
  blobs?: BlobStore;
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
  return (
    logical === "start_or_resume" ||
    logical === "get_state" ||
    logical === "get_context" ||
    logical === "read_memory" ||
    logical === "list_observations" ||
    logical === "promote_evidence" ||
    logical === "revalidate_evidence" ||
    logical === "select_section" ||
    logical === "prepare_proposal" ||
    logical === "approve_proposal" ||
    logical === "submit_synthesis" ||
    logical === "submit_validation" ||
    logical === "request_reopen" ||
    logical === "request_finalization" ||
    logical === "handoff"
  );
}

/**
 * Phase 12 §6–§7 / Phase 13 — the capability family signed with V2 envelopes
 * (optional agent attestation). request_finalization joins so the validator
 * can be denied by attestation (§26/E4); everything else keeps byte-identical
 * V1 contexts.
 */
const V2_ATTESTED_TOOLS = new Set<HostContextLogicalTool>([
  "submit_synthesis",
  "submit_validation",
  "request_reopen",
  "request_finalization",
  // Phase 14 §33 — handoff is main-session only; the attested agent fields
  // let the MCP handler deny subagent initiation (VALIDATOR_MUTATION_FORBIDDEN).
  "handoff",
]);

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

  // Phase 14 §79 — Build recovery: an exact-session detached ExecutionBinding
  // reattaches on resume (generation +1); clear/fork/startup never inherit
  // because a new session id owns no binding rows (§80/§81).
  const execBindings = deps.store.withRead((tx) => listExecutionBindingsForSessionInTx(tx, input.sessionId));
  if (input.source === "resume") {
    for (const binding of execBindings) {
      if (binding.state === "detached" && binding.workspaceId === workspaceId) {
        try {
          deps.store.withWrite((tx) =>
            reattachExecutionBindingInTx(
              tx,
              { runId: binding.runId, sessionId: input.sessionId, workspaceId },
              deps.clock.nowIso(),
            ),
          );
        } catch {
          // advisory; the read-authority revalidation provides correctness
        }
      }
    }
  }
  // §77 — a delivered handoff with an attached binding injects the immutable
  // Execution Contract as the Build recovery capsule (startup/resume/compact).
  const executionRecovery = deps.store.withRead((tx) => {
    for (const binding of execBindings) {
      const attached = getExecutionBindingInTx(tx, binding.runId);
      if (attached === null || attached.state !== "attached" || attached.sessionId !== input.sessionId) continue;
      const handoff = getExecutionHandoffInTx(tx, binding.runId);
      const state = getExecutionHandoffStateInTx(tx, binding.runId);
      if (handoff !== null && state?.status === "delivered") {
        return {
          runId: binding.runId,
          handoff: JSON.parse(handoff.canonicalJson) as ExecutionHandoffV1,
          handoffId: handoff.handoffId,
          handoffHash: handoff.handoffHash,
        };
      }
    }
    return null;
  });
  if (executionRecovery !== null) {
    const contract = renderExecutionContract(executionRecovery.handoff, {
      handoffId: executionRecovery.handoffId,
      handoffHash: executionRecovery.handoffHash,
    });
    return contextOutput("SessionStart", `Phase Plan execution session restored:\n\n${contract}`);
  }

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
  // Phase 8 (§29): the minimal Phase 7 marker is upgraded to the full
  // deterministic Recovery Capsule — startup, resume, and compact sources all
  // land here whenever the session owns an attached active run. The capsule
  // is rebuilt from HEAD + run state alone; a Claude compact summary is
  // conversation context and never an input (§31).
  const context: string[] = ["Phase Plan active:"];
  try {
    const phaseContext = assembleContext(createStoreContextSource(deps.store), attached.run.runId);
    context.push(buildRecoveryCapsule(phaseContext).text);
  } catch (err) {
    // §47 — SessionStart cannot block the host, so a capsule failure is
    // fail-VISIBLE: the marker tells the model/user not to continue on stale
    // context. (Store-level breakage additionally fails the later
    // UserPromptSubmit/PreToolUse guards closed.)
    const code = err instanceof RuntimeError ? err.code : "INTERNAL_ERROR";
    context.push(
      "Phase Plan recovery capsule could not be built (CONTEXT_RECOVERY_FAILED).",
      `error=${code}: ${err instanceof Error ? err.message : String(err)}`,
      "Do not continue planning on stale context; invoke /phase-plan.",
    );
  }
  // Phase 14 §85 — handoff-pending recovery. When the approved FinalPlan is
  // waiting for delivery this is NOT A1 planning drift (§44/§86): the run is
  // not restored to Plan Mode; the handoff completes in whatever mode the
  // session is in.
  const pendingRun = attached.run;
  const pending = deps.store.withRead((tx) => isHandoffPendingInTx(tx, pendingRun));
  if (pending) {
    context.push(
      "Final Plan is approved.",
      "Execution handoff is pending.",
      "Complete phase_plan.handoff before using Build tools.",
    );
    const prepared = deps.store.withRead((tx) => {
      const handoff = getExecutionHandoffInTx(tx, pendingRun.runId);
      const state = handoff === null ? null : getExecutionHandoffStateInTx(tx, pendingRun.runId);
      return handoff !== null && state?.status === "prepared"
        ? { id: handoff.handoffId, hash: handoff.handoffHash }
        : null;
    });
    if (prepared !== null) {
      context.push(`Prepared handoff: ${prepared.id} (${prepared.hash}).`);
    }
    if (input.permissionMode !== "plan") {
      context.push("Handoff can be retried directly in the current mode; Plan Mode restoration is not required.");
    }
    return contextOutput("SessionStart", context.join("\n\n"));
  }
  // Amendment A1 §7: SessionStart recovers planning STATE, never the host's
  // Plan Mode. When the mode is missing the recovered run stays fail-closed
  // (UserPromptSubmit/PreToolUse guards) until /phase-plan re-entry.
  if (input.permissionMode !== "plan") {
    context.push(
      "Phase Plan run recovered.",
      "Claude Plan Mode must be restored by invoking /phase-plan.",
    );
  }
  return contextOutput("SessionStart", context.join("\n\n"));
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
  // Phase 14 §79 — the ExecutionBinding detaches too (generation +1) so every
  // outstanding signed execution context fences; exact-session resume
  // reattaches it (SessionStart). Best-effort like the planning detach.
  const execBindings = deps.store.withRead((tx) => listExecutionBindingsForSessionInTx(tx, _input.sessionId));
  for (const binding of execBindings) {
    if (binding.state !== "attached") continue;
    try {
      deps.store.withWrite((tx) =>
        detachExecutionBindingInTx(tx, { runId: binding.runId, sessionId: _input.sessionId }, deps.clock.nowIso()),
      );
    } catch {
      // swallow: SessionEnd is advisory; generation fencing provides correctness
    }
  }
  return emptyOutput();
}

// ---------------------------------------------------------------------------
// PostToolUse (Phase 9 §9/§11–§13/§59/§60) — Observation capture
// ---------------------------------------------------------------------------

/** Canonical blob root derived from the canonical store layout (`<root>/blobs`). */
function blobsForDeps(deps: HookHandlerDeps): BlobStore {
  if (deps.blobs !== undefined) return deps.blobs;
  // store.path is the canonical `<pluginDataRoot>/store/phase-plan.sqlite3`.
  const pluginDataRoot = path.dirname(path.dirname(deps.store.path));
  return createBlobStore(path.join(pluginDataRoot, "blobs"));
}

/**
 * Capture the delivered tool result as an Observation. Host facts are
 * authoritative for WHAT was observed; run/workspace attribution is
 * re-resolved through the SessionBinding Store (never from any input id,
 * §11). Capture requires an attributable active run (§12) plus an
 * evidence-capable tool class (§7) — never merely permission_mode=plan (§13).
 *
 * Failure semantics (§60): capture NEVER breaks the tool flow — exit 0 —
 * and a failed capture of an attributable evidence-capable result is
 * fail-VISIBLE via additionalContext, marking that result unpromotable.
 * Successful captures write nothing to stdout (protocol-clean).
 */
export async function handlePostToolUse(deps: HookHandlerDeps, input: PostToolUseInput): Promise<HookOutput> {
  // Phase 14 §37 — the handoff delivery acknowledgement boundary: only a
  // matching exact delivery attempt can complete the transition (§93).
  if (logicalToolName(input.toolName) === "handoff") {
    return handleHandoffDeliveryPostToolUse(deps, input);
  }
  if (observationClassForTool(input.toolName) === null) {
    return emptyOutput(); // §8: unknown tools are never guessed; debug-only skip
  }
  const attached = findAttachedActiveRun(deps.store, input.sessionId);
  if (attached === null || attached.run === null) {
    return emptyOutput(); // §12: Phase Plan is not a global tool logger
  }
  const workspace = getWorkspaceById(deps.store, attached.binding.workspaceId);
  if (workspace === null) {
    return emptyOutput(); // attribution impossible — skip, never guess
  }
  if (input.cwd !== undefined && input.cwd.trim() !== "" && !cwdInsideWorkspace(input.cwd, workspace)) {
    return emptyOutput(); // tool executed outside the planning workspace
  }

  const event: ObservationCaptureEvent = {
    sessionId: input.sessionId,
    toolName: input.toolName,
    toolUseId: input.toolUseId,
    toolInput: input.toolInput,
    toolResponse: input.toolResponse,
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
  };
  try {
    await captureObservation(
      {
        store: deps.store,
        clock: deps.clock,
        runId: attached.run.runId,
        workspace,
        blobs: blobsForDeps(deps),
      },
      event,
    );
    return emptyOutput();
  } catch (err) {
    // The tool ALREADY executed; only the provenance capture failed (§60).
    const error = toRuntimeError(err, "OBSERVATION_CAPTURE_FAILED");
    return contextOutput(
      "PostToolUse",
      [
        `Phase Plan observation capture failed (${error.code}).`,
        `error=${error.code}: ${error.message}`,
        "This tool result was not recorded as a Phase Plan Observation and cannot be promoted as Evidence. If a design decision depends on this fact, observe it again.",
      ].join("\n"),
    );
  }
}

// ---------------------------------------------------------------------------
// PostToolUse handoff finalizer (Phase 14 §36–§39/§93)
// ---------------------------------------------------------------------------

/** Parse the MCP tool_response envelope into the delivered handoff identity. */
function parseHandoffToolResponse(toolResponse: unknown): { handoffId: string; handoffHash: string } | null {
  let payload: unknown = toolResponse;
  if (typeof payload === "object" && payload !== null && Array.isArray((payload as { content?: unknown }).content)) {
    const first = (payload as { content: Array<{ type?: string; text?: string }> }).content[0];
    if (first === undefined || typeof first.text !== "string") return null;
    try {
      payload = JSON.parse(first.text);
    } catch {
      return null;
    }
  }
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;
  if (record.ok !== true) return null; // denied/failed handoff: nothing to deliver
  if (typeof record.handoff_id !== "string" || typeof record.handoff_hash !== "string") return null;
  return { handoffId: record.handoff_id, handoffHash: record.handoff_hash };
}

/**
 * §37 — the trusted delivery finalizer. The MCP return alone proves nothing
 * about what the host did; this hook validates the exact delivery attempt,
 * the stored handoff identity, and only then records DELIVERED + run
 * completion in one transaction (§39: idempotent; §93: never trusts the
 * response alone).
 */
function handleHandoffDeliveryPostToolUse(deps: HookHandlerDeps, input: PostToolUseInput): HookOutput {
  const response = parseHandoffToolResponse(input.toolResponse);
  if (response === null) {
    return emptyOutput(); // the tool did not deliver (denied/error) — nothing to finalize
  }
  try {
    // Never nest store reads: the session lookup opens its own read txn.
    const attached = findAttachedActiveRun(deps.store, input.sessionId);
    const runId = attached !== null && attached.run !== null
      ? attached.run.runId
      : deps.store.withRead((tx) =>
          // Crash-recovery replays: the planning binding may already be detached.
          findRunIdByDeliveryIdentityInTx(tx, { sessionId: input.sessionId, toolUseId: input.toolUseId }),
        );
    if (runId === null) {
      return contextOutput(
        "PostToolUse",
        [
          "Phase Plan handoff delivery could not be attributed to a PlanningRun (HANDOFF_DELIVERY_INVALID).",
          "Invoke phase_plan.handoff again to complete the transition.",
        ].join("\n"),
      );
    }
    createHandoffService(deps.store, deps.clock).finalizeDelivery({
      runId,
      sessionId: input.sessionId,
      toolUseId: input.toolUseId,
      responseHandoffId: response.handoffId,
      responseHandoffHash: response.handoffHash,
    });
    // §38 — short deterministic completion context; the canonical contract
    // was already returned by the MCP tool response (never re-rendered here).
    return contextOutput(
      "PostToolUse",
      [
        "Phase Plan execution handoff delivered.",
        "PlanningRun is completed.",
        "Build under the immutable ExecutionHandoff contract.",
        "Plan Memory is read-only.",
      ].join("\n"),
    );
  } catch (err) {
    const code = err instanceof RuntimeError ? err.code : "INTERNAL_ERROR";
    return contextOutput(
      "PostToolUse",
      [
        `Phase Plan handoff delivery completion failed (${code}).`,
        `error=${code}: ${err instanceof Error ? err.message : String(err)}`,
        "The handoff tool returned, but durable delivery is not recorded. Invoke phase_plan.handoff again to complete the transition.",
      ].join("\n"),
    );
  }
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
  // Phase 14 §44 — handoff-pending is NOT A1 planning drift: planning already
  // ended with the approved FinalPlan. The turn proceeds with a short
  // deterministic notice; execution tools stay guarded until delivery (§45).
  const planningRun = attached.run;
  const pending = deps.store.withRead((tx) => isHandoffPendingInTx(tx, planningRun));
  if (pending) {
    const lines = [
      "Final Plan is approved and execution handoff is pending.",
      "Complete phase_plan.handoff before using execution tools.",
    ];
    if (input.permissionMode !== "plan") {
      return contextOutput("UserPromptSubmit", lines.join("\n"));
    }
    const epoch = deriveContextEpochFromSource(createStoreContextSource(deps.store), planningRun.runId);
    return contextOutput(
      "UserPromptSubmit",
      [
        ...(epoch === null ? [] : [`Phase Plan context epoch: ${epoch}`, "Use phase_plan.get_context if context appears stale."]),
        ...lines,
      ].join("\n"),
    );
  }
  if (input.permissionMode !== "plan") {
    // Known active binding + not plan → fail closed (directive §40).
    return blockPrompt(DRIFT_GUARD_REASON);
  }
  // Phase 8 (§34) — normal-turn delta foundation: inject only the short
  // deterministic epoch marker, never the full capsule (startup/resume/
  // compact carry the capsule). The epoch is a stale-context hint, never a
  // correctness fence (§6/§35): guards below still protect every mutation.
  // A store failure here propagates and the hook runtime fails closed.
  const epoch = deriveContextEpochFromSource(createStoreContextSource(deps.store), attached.run.runId);
  if (epoch === null) {
    return emptyOutput();
  }
  return contextOutput(
    "UserPromptSubmit",
    `Phase Plan context epoch: ${epoch}\nUse phase_plan.get_context if context appears stale.`,
  );
}

// ---------------------------------------------------------------------------
// UserPromptExpansion — signed EntryIntent for the /phase-plan turn (§10/§11)
// ---------------------------------------------------------------------------

export function handleUserPromptExpansion(deps: HookHandlerDeps, input: UserPromptExpansionInput): HookOutput {
  // The host expands plugin skills to their namespaced command form
  // ("/phase-plan" → "phase-plan:phase-plan"); accept both spellings.
  if (input.commandName !== "phase-plan" && input.commandName !== "phase-plan:phase-plan") {
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
    if (attached !== null && attached.run !== null) {
      // Phase 14 §10 — while the FinalPlan is approved but undelivered the
      // reason names the deterministic handoff; after completion the guard
      // naturally no longer applies (the run is terminal).
      const pending = deps.store.withRead((tx) => isHandoffPendingInTx(tx, attached.run));
      return denyTool(eventName, pending ? HANDOFF_PENDING_EXIT_PLAN_MODE_REASON : EXIT_PLAN_MODE_REASON);
    }
    return emptyOutput();
  }

  if (isPhasePlanTool(logical)) {
    return handlePhasePlanPreToolUse(deps, input, eventName, logical);
  }

  // §42 — host-state drift guard: active run + not plan mode → allowlist only.
  const attached = findAttachedActiveRun(deps.store, input.sessionId);
  if (attached !== null && attached.run !== null && input.permissionMode !== "plan") {
    if (DRIFT_ALLOWLIST.has(logical)) {
      return emptyOutput();
    }
    // Phase 14 §45 — while handoff is pending this is not A1: execution must
    // not begin before durable handoff delivery. `phase_plan.handoff` itself
    // is a phase-plan tool handled above and stays reachable (§87/§89).
    // ToolSearch is the host's read-only tool-discovery mechanism — the model
    // needs it to address phase_plan.handoff at all; it is not an execution tool.
    const pending = deps.store.withRead((tx) => isHandoffPendingInTx(tx, attached.run));
    if (pending) {
      if (logical === "ToolSearch") {
        return emptyOutput();
      }
      return deny(eventName, "HANDOFF_DELIVERY_PENDING", HANDOFF_PENDING_EXECUTION_GUARD_REASON);
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

  // approve_proposal, promote_evidence, revalidate_evidence, select_section,
  // prepare_proposal, submit_synthesis, submit_validation, request_reopen,
  // request_finalization, and handoff require an owned active run for their
  // write contexts; reads (get_state/get_context/read_memory/list_observations)
  // degrade to a run-less outcome: nothing is signed, so the MCP layer fails
  // closed and never reaches a workspace-wide run selection (Phase 8 §40/§41 —
  // no auto-takeover).
  const attached = findAttachedActiveRun(deps.store, input.sessionId);
  if (attached === null || attached.run === null) {
    // Phase 14 §56/§57 — Build read-side authority: when the run is completed
    // with a delivered handoff and this session holds the attached
    // ExecutionBinding, reads are signed with an EXECUTION HostContext
    // (domain-separated; the planning verifier can never accept it).
    if (logical === "get_state" || logical === "get_context" || logical === "read_memory") {
      const executionBinding = deps.store.withRead((tx) => {
        const binding = findAttachedExecutionBindingForSessionInTx(tx, input.sessionId);
        if (binding === null || binding.workspaceId === "") return null;
        const handoff = getExecutionHandoffInTx(tx, binding.runId);
        const state = handoff === null ? null : getExecutionHandoffStateInTx(tx, binding.runId);
        if (handoff === null || state?.status !== "delivered") return null;
        return binding;
      });
      if (executionBinding !== null) {
        const execToken = encodeExecutionHostContextToken(
          deps.secret,
          buildExecutionHostContextEnvelope({
            sessionId: input.sessionId,
            ...(input.promptId === undefined ? {} : { promptId: input.promptId }),
            workspaceId: executionBinding.workspaceId,
            runId: executionBinding.runId,
            finalPlanId: executionBinding.finalPlanId,
            executionBindingGeneration: executionBinding.generation,
            permissionMode: input.permissionMode ?? "unknown",
            toolUseId: input.toolUseId,
            toolName: input.toolName,
            businessInputHash: businessInputHashOf(toolInput),
          }),
        );
        // The signed binding revalidation IS the permission decision: this
        // read is authorized under the execution contract (§56), so grant it
        // outright instead of leaving it to the host's mode classifier.
        return allowWithUpdatedInput(
          eventName,
          { ...toolInput, _hostContext: execToken },
          "Build read authorized under the delivered ExecutionHandoff (attached ExecutionBinding, exact generation).",
        );
      }
      return emptyOutput();
    }
    if (logical === "handoff") {
      // Phase 14 §134 — the exact delivered invocation identity replays
      // idempotently after completion: re-sign an EXECUTION authority context
      // (never a planning one — the planning binding is detached by then).
      const replay = deps.store.withRead((tx) =>
        findDeliveredHandoffForSessionToolUseInTx(tx, { sessionId: input.sessionId, toolUseId: input.toolUseId }),
      );
      if (replay !== null) {
        const execToken = encodeExecutionHostContextToken(
          deps.secret,
          buildExecutionHostContextEnvelope({
            sessionId: input.sessionId,
            ...(input.promptId === undefined ? {} : { promptId: input.promptId }),
            workspaceId: replay.workspaceId,
            runId: replay.runId,
            finalPlanId: replay.finalPlanId,
            executionBindingGeneration: replay.generation,
            permissionMode: input.permissionMode ?? "unknown",
            toolUseId: input.toolUseId,
            toolName: input.toolName,
            businessInputHash: businessInputHashOf(toolInput),
          }),
        );
        return updatedInputNoDecision(eventName, { ...toolInput, _hostContext: execToken });
      }
      return deny(eventName, "STALE_SESSION_BINDING", "no active Phase Plan run is attached to the current session");
    }
    if (
      logical === "approve_proposal" ||
      logical === "promote_evidence" ||
      logical === "revalidate_evidence" ||
      logical === "select_section" ||
      logical === "prepare_proposal" ||
      logical === "submit_synthesis" ||
      logical === "submit_validation" ||
      logical === "request_reopen" ||
      logical === "request_finalization"
    ) {
      return deny(eventName, "STALE_SESSION_BINDING", "no active Phase Plan run is attached to the current session");
    }
    // get_state/get_context/read_memory without a run: no read context is
    // signed (fail closed; the tool call then surfaces HOST_CONTEXT_REQUIRED).
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
  const isMutationTool =
    logical === "approve_proposal" ||
    logical === "promote_evidence" ||
    logical === "revalidate_evidence" ||
    logical === "select_section" ||
    logical === "prepare_proposal" ||
    logical === "submit_synthesis" ||
    logical === "submit_validation" ||
    logical === "request_reopen" ||
    logical === "request_finalization" ||
    logical === "handoff";
  if (isMutationTool && !cwdInsideWorkspace(input.cwd, workspace)) {
    return deny(eventName, "WORKSPACE_MISMATCH", "the session has left the bound workspace; re-enter it to mutate Plan Memory");
  }
  // §29 — approve_proposal, prepare_proposal, and submit_synthesis require the
  // session to BE in Plan Mode before a mutation context is signed at all
  // (§59). Read tools (§39), evidence writes (§45), and validator submissions
  // (§52 — no approval is involved) deliberately do NOT require plan mode.
  if ((logical === "approve_proposal" || logical === "prepare_proposal" || logical === "submit_synthesis") && input.permissionMode !== "plan") {
    return deny(
      eventName,
      "PLAN_MODE_REQUIRED",
      `${logical} requires permission_mode=plan (observed '${input.permissionMode ?? "unknown"}'); invoke /phase-plan to restore planning mode`,
    );
  }

  // Phase 12 §6–§7 — V2 envelopes for the validator/synthesis/reopen family
  // fold in the host's subagent identity fields when present (probe: they
  // appear ONLY on subagent calls; a main-session call attests itself by
  // their absence). Everything else keeps the byte-identical V1 envelope.
  const agent =
    input.agentId === undefined && input.agentType === undefined
      ? undefined
      : {
          ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
          ...(input.agentType === undefined ? {} : { agentType: input.agentType }),
        };
  const hostToken =
    V2_ATTESTED_TOOLS.has(logical)
      ? encodeHostContextTokenV2(
          deps.secret,
          buildHostContextEnvelopeV2({
            sessionId: input.sessionId,
            ...(input.promptId === undefined ? {} : { promptId: input.promptId }),
            workspaceId: attached.binding.workspaceId,
            runId: attached.binding.runId,
            bindingGeneration: attached.binding.generation,
            permissionMode: input.permissionMode ?? "unknown",
            toolUseId: input.toolUseId,
            toolName: input.toolName,
            businessInputHash: businessInputHashOf(toolInput),
            ...(agent === undefined ? {} : { agent }),
          }),
        )
      : encodeHostContextToken(
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
  if (logical === "handoff") {
    // Phase 14 §87/§88/§89 — the eligibility gate happens BEFORE any host
    // mode change (§7): only the derived handoffPending state may proceed.
    const handoffRun = attached.run;
    const eligibility = deps.store.withRead((tx) => {
      const pending = isHandoffPendingInTx(tx, handoffRun);
      if (pending) return { pending: true, delivered: false };
      const state = handoffRun === null ? null : getExecutionHandoffStateInTx(tx, handoffRun.runId);
      return { pending: false, delivered: state?.status === "delivered" };
    });
    if (!eligibility.pending) {
      return deny(
        eventName,
        eligibility.delivered ? "HANDOFF_ALREADY_DELIVERED" : "HANDOFF_NOT_AUTHORIZED",
        eligibility.delivered
          ? "the execution handoff was already delivered; the PlanningRun is completed"
          : "handoff requires an approved FinalPlan and the final stage with delivery still pending",
      );
    }
    if (input.permissionMode === "plan") {
      // §88 — the normal path: PermissionRequest performs the session-scoped
      // setMode(default) transition; this "ask" is host-mode orchestration,
      // never a design approval (§6 — no extra human dialog exists).
      return askWithUpdatedInput(
        eventName,
        updatedInput,
        "Deliver the execution handoff: transitions this session to execution mode under the approved Final Plan (host-mode orchestration; not a design approval).",
      );
    }
    // §89 — recovery: the session is already in default/manual mode (a crash
    // after setMode); retry directly — never default → plan → default.
    return updatedInputNoDecision(eventName, updatedInput);
  }
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

  if (logical === "handoff") {
    // Phase 14 §7/§88 — the PermissionRequest gate re-verifies the FULL
    // eligibility from the Store BEFORE returning setMode(default, session);
    // the host must never switch modes and then discover an invalid FinalPlan.
    const rawHostContext = input.toolInput._hostContext;
    if (typeof rawHostContext !== "string" || rawHostContext === "") {
      return emptyOutput();
    }
    try {
      const envelope = assertHostContextForTool(deps.secret, rawHostContext, {
        tool: "handoff",
        businessInput: input.toolInput,
      });
      if (envelope.sessionId !== input.sessionId) {
        return denyPermissionRequest("HOST_CONTEXT_INVALID: host context is bound to a different session");
      }
      if (envelope.promptId !== undefined && input.promptId !== undefined && envelope.promptId !== input.promptId) {
        return denyPermissionRequest("HOST_CONTEXT_INVALID: host context is bound to a different prompt");
      }
      if (envelope.runId === undefined) {
        return denyPermissionRequest("HANDOFF_NOT_AUTHORIZED: host context carries no run binding");
      }
      const eligible = deps.store.withRead((tx) => {
        const runRow = tx
          .prepare(
            "SELECT run_id AS runId, workspace_id AS workspaceId, lifecycle, stage, revision, goal, "
            + "created_at AS createdAt, updated_at AS updatedAt FROM planning_runs WHERE run_id = ?",
          )
          .get(envelope.runId) as Record<string, unknown> | undefined;
        if (runRow === undefined) return false;
        const run = parsePlanningRunRow(runRow);
        if (run.workspaceId !== envelope.workspaceId) return false;
        if (run.lifecycle !== "active" || run.stage !== "final") return false;
        const finalPlan = getFinalPlanInTx(tx, run.runId);
        if (finalPlan === null) return false;
        const handoff = getExecutionHandoffInTx(tx, run.runId);
        if (handoff === null) return true;
        const state = getExecutionHandoffStateInTx(tx, run.runId);
        return state?.status !== "delivered";
      });
      if (!eligible) {
        return denyPermissionRequest(
          "HANDOFF_NOT_AUTHORIZED: the current run is not an active run at stage final with an approved, undelivered FinalPlan",
        );
      }
      // §6/§88 — the session-scoped execution-mode transition (mirrors the
      // Phase 7 Plan Mode entry; never a user/project/local settings write, §8).
      return allowWithPermissions([{ type: "setMode", mode: "default", destination: "session" }]);
    } catch (err) {
      const code = err instanceof RuntimeError ? err.code : "HOST_CONTEXT_INVALID";
      return denyPermissionRequest(`${code}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // §30 — the PermissionRequest hook NEVER auto-allows approve_proposal: no
  // allow response, no allow rule, no "don't ask again".
  return emptyOutput();
}
