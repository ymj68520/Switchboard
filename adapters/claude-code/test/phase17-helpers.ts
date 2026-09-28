/**
 * Phase 17 shared matrix helpers: one uniform world handle per lifecycle
 * state (directive §36's states), built through the REAL fixture chains
 * (never raw store mutation), plus a uniform signed-caller used by the
 * capability / system / recovery matrix tests.
 *
 * Caller identity and token family mirror what the production PreToolUse
 * hook would sign for that caller/state: planning V1/V2, the execution
 * domain, or NO context at all when the hook would sign nothing (the MCP
 * layer then fails closed HOST_CONTEXT_REQUIRED). Mutation cells that must
 * not mutate pass stale/dummy probes explicitly from the tests.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { executePhasePlanTool, PHASE_PLAN_TOOLS, type PhasePlanToolContext } from "../src/mcp/tools.js";
import { RuntimeError } from "../src/runtime/errors.js";
import { issueEntryIntent } from "../src/host/entry-intent.js";
import { createHandoffService, parseFinalPlanCanonical } from "../src/application/handoff-service.js";
import { createPlanningRunService } from "../src/application/planning-run-service.js";
import { createRunControlService } from "../src/application/run-control-service.js";
import { runControlRequestHash } from "../src/store/run-control.js";
import { getExecutionBindingInTx } from "../src/store/execution.js";
import { getBinding } from "../src/store/session-bindings.js";
import { getFinalPlanInTx } from "../src/store/finalization.js";
import { discoverAndRegisterWorkspace } from "../src/workspace/identity.js";
import { initializePlanStore, type PlanStore } from "../src/store/sqlite-store.js";
import type { StoreClock } from "../src/store/migration-runner.js";
import { loadHostSecret } from "../src/host/secret.js";
import { createBlobStore } from "../src/store/blob-store.js";
import { fixedClock, makeTempPluginDataRoot, removeTempPluginDataRoot } from "./store-helpers.js";
import { hostToken } from "./context-helpers.js";
import { hostTokenV2, makeSynthesisFixture, toolContextOf } from "./phase12-helpers.js";
import { makeDetailFixture, type DetailFixture } from "./phase11-helpers.js";
import { makeCleanValidationFixture, callRequestFinalization } from "./phase13-helpers.js";
import { makeApprovedFinalPlanFixture, callHandoff, executionToken } from "./phase14-helpers.js";

export const PHASE17_TOOLS = PHASE_PLAN_TOOLS.map((t) => t.name);

export type Phase17State =
  | "discovery"
  | "detail"
  | "synthesis"
  | "validation"
  | "final-awaiting"
  | "final-approved"
  | "handoff-pending"
  | "completed-build"
  | "completed-no-execution"
  | "aborted"
  | "successor-unmaterialized";

export interface Phase17World {
  state: Phase17State;
  root: string;
  store: PlanStore;
  ctx: PhasePlanToolContext;
  secret: Buffer;
  workspaceId: string;
  workspaceRoot: string;
  runId: string;
  /** The session that owns the current binding. */
  owner: string;
  /** Generation of the owner's CURRENT binding (planning or execution). */
  generation: number;
  bindingKind: "planning" | "execution" | "none";
  lifecycle: "active" | "completed" | "aborted";
  /** For successor worlds: the predecessor run id. */
  predecessorRunId?: string;
  /** Delivered worlds carry the FinalPlan id (execution authority input). */
  finalPlanId?: string;
  close(): void;
}

let clockSeq = 0;
export function matrixClock(): StoreClock {
  let i = 0;
  return {
    nowIso: () => new Date(Date.now() + (i += 1)).toISOString(),
    newId: () => `p17-${(clockSeq += 1)}`,
  };
}

function ctxOver(store: PlanStore, root: string): { ctx: PhasePlanToolContext; secret: Buffer } {
  const secret = loadHostSecret(root).key;
  return {
    secret,
    ctx: { store, secret, clock: matrixClock(), blobs: createBlobStore(path.join(root, "blobs")) },
  };
}

async function discoveryWorld(owner: string): Promise<Phase17World> {
  const root = makeTempPluginDataRoot("phase-plan-p17-");
  const store = await initializePlanStore({ pluginDataRoot: root });
  const projectDir = path.join(root, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  const { registration } = await discoverAndRegisterWorkspace(store, projectDir, fixedClock({ ids: ["r0", "w0"] }));
  const workspaceId = registration.workspace.workspaceId;
  const runs = createPlanningRunService(store, fixedClock({ ids: ["run-id"] }));
  const { run, binding } = runs.createPlanningRun({ workspaceId, sessionId: owner, goal: "phase17 matrix fixture" });
  const { ctx, secret } = ctxOver(store, root);
  return {
    state: "discovery",
    root,
    store,
    ctx,
    secret,
    workspaceId,
    workspaceRoot: projectDir,
    runId: run.runId,
    owner,
    generation: binding.generation,
    bindingKind: "planning",
    lifecycle: "active",
    close: () => {
      store.close();
      removeTempPluginDataRoot(root);
    },
  };
}

function planningFixtureWorld(
  state: Phase17State,
  f: DetailFixture,
): Phase17World {
  const ctx = toolContextOf(f);
  const secret = ctx.secret;
  const binding = getBinding(f.store, f.runId);
  return {
    state,
    root: f.root,
    store: f.store,
    ctx,
    secret,
    workspaceId: f.workspaceId,
    workspaceRoot: f.root,
    runId: f.runId,
    owner: f.sessionId,
    generation: binding?.generation ?? f.generation,
    bindingKind: "planning",
    lifecycle: "active",
    close: () => f.close(),
  };
}

async function completedWorld(owner: string): Promise<Phase17World> {
  const { f, ctx } = await makeApprovedFinalPlanFixture(owner);
  const prepared = callHandoff(ctx, f, { toolUseId: `${owner}-P17-DELIVER` });
  createHandoffService(ctx.store, ctx.clock).finalizeDelivery({
    runId: f.runId,
    sessionId: owner,
    toolUseId: `${owner}-P17-DELIVER`,
    responseHandoffId: prepared.handoff_id,
    responseHandoffHash: prepared.handoff_hash,
  });
  const exec = ctx.store.withRead((tx) => getExecutionBindingInTx(tx, f.runId));
  if (exec === null || exec.state !== "attached") throw new Error("fixture failed to reach a delivered handoff");
  return {
    state: "completed-build",
    root: f.root,
    store: f.store,
    ctx,
    secret: ctx.secret,
    workspaceId: f.workspaceId,
    workspaceRoot: f.workspaceRoot,
    runId: f.runId,
    owner,
    generation: exec.generation,
    bindingKind: "execution",
    lifecycle: "completed",
    finalPlanId: f.finalPlanId,
    close: () => f.close(),
  };
}

export async function buildPhase17World(state: Phase17State, owner = "S1"): Promise<Phase17World> {
  switch (state) {
    case "discovery":
      return discoveryWorld(owner);
    case "aborted": {
      const world = await discoveryWorld(owner);
      createRunControlService(world.store, matrixClock()).abortRun({
        workspaceId: world.workspaceId,
        callerSessionId: owner,
        bindingGeneration: world.generation,
        reason: "phase17 matrix: abort state",
        authorization: {
          authorizationRequestId: "mcp-control:P17-ABORT",
          operationId: "abort:P17-ABORT",
          requestHash: runControlRequestHash({
            operation: "abort",
            runId: world.runId,
            workspaceId: world.workspaceId,
            expectedBindingGeneration: world.generation,
          }),
        },
      });
      const binding = world.store.withRead(
        (tx) =>
          tx.prepare("SELECT state, generation FROM session_bindings WHERE run_id = ?").get(world.runId) as {
            state: string;
            generation: number;
          },
      );
      return { ...world, generation: binding.generation, bindingKind: "none", lifecycle: "aborted", state: "aborted" };
    }
    case "detail":
      return planningFixtureWorld("detail", await makeDetailFixture(owner));
    case "synthesis":
      return planningFixtureWorld("synthesis", await makeSynthesisFixture(owner));
    case "validation": {
      const { f } = await makeCleanValidationFixture(owner);
      return planningFixtureWorld("validation", f);
    }
    case "final-awaiting": {
      const { f, ctx } = await makeCleanValidationFixture(owner);
      callRequestFinalization(ctx, f, { toolUseId: "P17-FIN" });
      return planningFixtureWorld("final-awaiting", f);
    }
    case "final-approved":
    case "handoff-pending": {
      // Frozen Phase 14 semantics: an approved FinalPlan with delivery
      // pending IS the derived handoff-pending state — one durable state,
      // two row labels in the §36 matrix.
      const { f } = await makeApprovedFinalPlanFixture(owner);
      return { ...planningFixtureWorld(state, f), workspaceRoot: f.workspaceRoot };
    }
    case "completed-build":
    case "completed-no-execution":
      return completedWorld(owner);
    case "successor-unmaterialized": {
      const done = await completedWorld(owner);
      // Real Phase 15 chain: report an open issue against the delivered
      // contract, then a fresh /phase-plan creates the unmaterialized
      // successor owned by the same session (normal planning binding).
      const row = done.store.withRead((tx) => getFinalPlanInTx(tx, done.runId));
      if (row === null) throw new Error("no FinalPlan in delivered world");
      const plan = parseFinalPlanCanonical(row.canonicalJson, done.runId);
      const section = plan.sections[0]!;
      const issueInput = {
        kind: "section_contract",
        summary: "phase17 matrix: contract cannot be satisfied",
        detail: "the approved contract requires an interface the platform does not expose.",
        affected_refs: [{ type: "section", id: section.sectionId, revision: section.revision }],
      };
      const issueToken = executionToken(done.ctx, {
        sessionId: done.owner,
        workspaceId: done.workspaceId,
        runId: done.runId,
        finalPlanId: done.finalPlanId!,
        generation: done.generation,
        tool: "report_execution_issue",
        toolUseId: "P17-ISSUE-1",
        business: issueInput as unknown as Record<string, unknown>,
      });
      executePhasePlanTool(done.ctx, "report_execution_issue", { ...issueInput, _hostContext: issueToken });
      const entry = issueEntryIntent(done.secret, { sessionId: done.owner, promptId: "PROMPT-1" });
      const token = hostToken(
        done.secret,
        "start_or_resume",
        { _entryIntent: entry },
        { sessionId: done.owner, workspaceId: done.workspaceId },
        { permissionMode: "default", toolUseId: "P17-ENTRY" },
      );
      const started = executePhasePlanTool(done.ctx, "start_or_resume", { _entryIntent: entry, _hostContext: token }) as {
        status: string;
        run: { id: string };
      };
      if (started.status !== "started_successor") throw new Error(`expected started_successor, got ${started.status}`);
      const successorBinding = getBinding(done.store, started.run.id);
      return {
        ...done,
        state: "successor-unmaterialized",
        runId: started.run.id,
        generation: successorBinding?.generation ?? 1,
        bindingKind: "planning",
        lifecycle: "active",
        predecessorRunId: done.runId,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Uniform signed caller
// ---------------------------------------------------------------------------

export type Caller = "owner" | "other";

export interface CallOutcome {
  ok: boolean;
  code?: string;
  keys?: string[];
}

const PLANNING_V2_TOOLS = new Set([
  "request_reopen",
  "request_finalization",
  "handoff",
  "takeover_run",
  "abort_run",
]);
/** Tools whose real caller is the validator subagent (V2 + agent attestation). */
const VALIDATOR_TOOLS = new Set(["submit_validation"]);
/** Tools that carry execution-domain authority once a handoff is delivered. */
const EXECUTION_AUTHORITY_TOOLS = new Set(["get_state", "get_context", "read_memory", "report_execution_issue"]);

export interface CallOptions {
  toolUseId?: string;
  business?: Record<string, unknown>;
  permissionMode?: string;
  /** Force no _hostContext (models the hook signing nothing for this caller). */
  unsigned?: boolean;
  /** Sign a validator agent attestation into a planning V2 token. */
  validator?: boolean;
}

/**
 * Invoke one tool through the REAL MCP dispatcher as `caller`. The signed
 * context mirrors the production hook: the owner's CURRENT binding (never a
 * stale one — stale probes are passed explicitly via `business` by tests
 * that need them), the execution domain for delivered-handoff reads, and no
 * context at all when this caller owns nothing signable.
 */
export function callAsTool(
  world: Phase17World,
  tool: string,
  caller: Caller,
  options: CallOptions = {},
): CallOutcome {
  const sessionId = caller === "owner" ? world.owner : "S17-OTHER";
  const toolUseId = options.toolUseId ?? `P17-${tool}-${caller}`;
  const permissionMode = options.permissionMode ?? "plan";

  const ownerOwnsPlanning = caller === "owner" && world.bindingKind === "planning" && world.lifecycle === "active";
  const ownerOwnsExecution =
    caller === "owner" && world.bindingKind === "execution" && world.lifecycle === "completed";
  const executionAuthority = ownerOwnsExecution && EXECUTION_AUTHORITY_TOOLS.has(tool);

  let business: Record<string, unknown> = { ...options.business };
  if (tool === "takeover_run" && options.business === undefined) {
    business = { run_id: world.runId, expected_binding_generation: world.generation };
  }
  if (tool === "start_or_resume" && options.business === undefined) {
    const entry = issueEntryIntent(world.secret, { sessionId, promptId: "PROMPT-1" });
    business = { _entryIntent: entry, goal: "phase17 matrix probe goal" };
  }

  const ids = {
    sessionId,
    workspaceId: world.workspaceId,
    ...(ownerOwnsPlanning ? { runId: world.runId, generation: world.generation } : {}),
  };

  let token: string | null = null;
  if (!options.unsigned) {
    if (executionAuthority) {
      token = executionToken(world.ctx, {
        sessionId,
        workspaceId: world.workspaceId,
        runId: world.runId,
        finalPlanId: world.finalPlanId ?? "fp_missing",
        generation: world.generation,
        tool,
        toolUseId,
        business,
        permissionMode: "default",
      });
    } else if (ownerOwnsPlanning || tool === "start_or_resume" || tool === "takeover_run") {
      token =
        PLANNING_V2_TOOLS.has(tool) || VALIDATOR_TOOLS.has(tool) || options.validator
          ? hostTokenV2(world.secret, tool, business, ids, {
              permissionMode,
              toolUseId,
              ...(VALIDATOR_TOOLS.has(tool) || options.validator
                ? { agent: { agentId: "agent_p17", agentType: "phase-plan:validator" } }
                : {}),
            })
          : hostToken(world.secret, tool, business, ids, { permissionMode, toolUseId });
    }
    // else: the hook would sign nothing for this caller — call unsigned and
    // let the MCP layer fail closed (HOST_CONTEXT_REQUIRED).
  }

  try {
    const payload = executePhasePlanTool(world.ctx, tool, {
      ...business,
      ...(token === null ? {} : { _hostContext: token }),
    }) as Record<string, unknown>;
    return { ok: true, keys: Object.keys(payload) };
  } catch (err) {
    if (err instanceof RuntimeError) return { ok: false, code: err.code };
    return { ok: false, code: `RAW:${(err as Error)?.constructor?.name ?? typeof err}` };
  }
}

export { hostTokenV2, executePhasePlanTool, matrixClock as p17Clock };
export type { DetailFixture };
