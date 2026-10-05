/**
 * OpenCode Supervisor runtime adapter — v0.2.0 Phase 7A (directive §12/§18-§26/§48/§53/§63-§65).
 *
 * The ONLY OpenCode-aware Supervisor implementation. ONE control turn:
 *
 * 1. AUTHORITY BIND (§48): the trusted session must own the binding at the
 *    presented generation — otherwise `fencing_failure` BEFORE any model call.
 * 2. TERMINAL SHORT-CIRCUITS (§93/§94): replan_required/completed outcomes
 *    are returned WITHOUT invoking the model.
 * 3. DETERMINISTIC CONTEXT (§18/§19): the compact projection is rebuilt from
 *    the Store every turn — the model conversation carries no authority
 *    (§68); each turn runs in a FRESH child session.
 * 4. TOOL ISOLATION (§21): the per-call `tools` override mechanically denies
 *    EVERY OpenCode repository/runtime tool for the whole turn. The
 *    Supervisor's execution operations are NOT host tools — they travel
 *    through the strict JSON final-response contract below, so there is
 *    nothing repository-shaped to enable. Model policy (§15): the turn binds
 *    `supervisorModel` (frontier tier), never the Build model.
 * 5. TURN LOOP (§25): zero or more READ operations, then AT MOST ONE
 *    authoritative mutation. A mutation ends the turn immediately; a
 *    further mutation attempt in the same turn is refused by the tool
 *    surface (`supervisor_turn_already_mutated`). The loop is bounded.
 * 6. STRICT CONTRACT (§36/§53/§62): each model response must be either
 *    `{"tool": "<operation>", "args": {...}}` or a plain note. Outcomes map
 *    onto the closed vocabulary; domain errors cross as structured data —
 *    stale CAS codes map to `stale_context` (§63: end turn, reload, fresh
 *    turn) and fencing codes to `fencing_failure` (§64: never an
 *    auto-takeover, never a retry with a bumped generation).
 * 7. FAIL-CLOSED (§55): a model/runtime failure mutates NO business state —
 *    `blocked_runtime` with the reason; the durable Store wins (§56).
 *
 * DORMANT (§71): constructed only by the internal harness/tests.
 */
import type { PlanStore } from "../memory/store.js";
import { assembleExecutionSupervisorContext, renderExecutionSupervisorContext } from "../core/execution-supervisor-context.js";
import type {
  ExecutionSupervisorRuntime,
  ExecutionSupervisorTurnInput,
  ExecutionSupervisorTurnResult,
  ExecutionRuntimeTracer,
} from "./execution-runtime.js";
import type { ResolvedExecutionModelPolicy } from "./execution-model-policy.js";
import { modelBinding } from "./execution-model-policy.js";
import { projectSupervisorToolMap } from "./capability-projection.js";
import { ExecutionSupervisorToolSurface } from "./supervisor-tools.js";
import type { ExecutionCapabilityCeiling } from "../core/execution-directive.js";
import { EXECUTION_SUPERVISOR_SYSTEM_PROMPT } from "./protocol-prompts.js";
import type { OpenCodeModelClient } from "./opencode-client.js";
import { finalTextOf } from "./opencode-client.js";

export interface OpenCodeSupervisorAdapterOptions {
  client: OpenCodeModelClient;
  store: PlanStore;
  policy: ResolvedExecutionModelPolicy;
  /** §24/§33 — the TRUSTED host/user capability ceiling, injected per call. */
  trustedCeiling: ExecutionCapabilityCeiling;
  /** §17 — lineage parent (the trusted host session) for the per-turn child session. */
  parentSessionID?: string;
  /** Bounded wait per model round (§55). */
  timeoutMs?: number;
  /** Bounded number of read rounds before the turn ends awaiting the Supervisor (§25). */
  maxReadRounds?: number;
  /** §69 — minimal tracing. */
  tracer?: ExecutionRuntimeTracer;
  /** Extra host tool names (from client enumeration) denied for the whole turn. */
  extraHostToolNames?: readonly string[];
  /** Registered Ultra Plan planning tools explicitly denied for the Supervisor. */
  registeredUltraPlanToolNames?: readonly string[];
}

const DEFAULT_SUPERVISOR_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_MAX_READ_ROUNDS = 8;

/** The strict final-response contract: one tool call — or a note. */
interface ToolCallMessage {
  tool: string;
  args: Record<string, unknown>;
}

function parseModelResponse(text: string): { kind: "tool_call"; call: ToolCallMessage } | { kind: "note"; text: string } | { kind: "invalid"; reason: string } {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) {
    return { kind: "note", text: trimmed };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { kind: "invalid", reason: "the response looks like JSON but is not a single complete object" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "invalid", reason: "the response must be a JSON object" };
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length === 2 && keys[0] === "args" && keys[1] === "tool") {
    if (typeof record["tool"] !== "string") return { kind: "invalid", reason: '"tool" must be a string' };
    const args = record["args"];
    if (typeof args !== "object" || args === null || Array.isArray(args)) return { kind: "invalid", reason: '"args" must be an object' };
    return { kind: "tool_call", call: { tool: record["tool"], args: args as Record<string, unknown> } };
  }
  return { kind: "invalid", reason: `the response must be exactly {"tool", "args"}; got keys ${keys.join(", ")}` };
}

export class OpenCodeSupervisorAdapter implements ExecutionSupervisorRuntime {
  constructor(private readonly options: OpenCodeSupervisorAdapterOptions) {}

  async runExecutionSupervisorTurn(input: ExecutionSupervisorTurnInput): Promise<ExecutionSupervisorTurnResult> {
    const started = Date.now();
    const { store } = this.options;
    const run = await store.getExecutionRun(input.executionRunID);
    if (!run) {
      return { outcome: "blocked_runtime", reason: `ExecutionRun ${input.executionRunID} does not exist`, code: "execution_run_not_found" };
    }

    // §93/§94 — terminal outcomes without ANY model invocation.
    if (run.lifecycle === "replan_required") return { outcome: "replan_required" };
    if (run.lifecycle === "completed") return { outcome: "completed", completionID: run.completionRecord };
    if (run.lifecycle === "aborted") return { outcome: "blocked_runtime", reason: "the run is aborted" };

    // §48 — bind authority BEFORE the model: the trusted session must own the
    // binding at the presented generation (workspace equality included).
    const binding = await store.findSupervisorBinding(run.id);
    if (!binding) {
      return { outcome: "fencing_failure", code: "supervisor_binding_not_found", message: "the run has no SupervisorBinding" };
    }
    if (binding.ownerSessionID !== input.trustedAuthority.sessionID) {
      return { outcome: "fencing_failure", code: "supervisor_session_mismatch", message: "the trusted session does not own the binding (§58 — an explicit human takeover is required)" };
    }
    if (binding.generation !== input.trustedAuthority.generation) {
      return { outcome: "fencing_failure", code: "stale_supervisor_binding", message: "the presented generation is stale; writable control ends (§64 — never an auto-takeover)" };
    }

    // §18/§19 — deterministic context, rebuilt from the Store.
    const recovery = (await store.buildExecutionRecoveryContext(run.id, { sessionID: input.trustedAuthority.sessionID }))!;
    const planningRun = await store.getRun(run.planID);
    const finalPlan = await store.getCurrentFinalPlan(run.planID);
    if (!finalPlan || finalPlan.id !== run.finalPlan.id || finalPlan.revision !== run.finalPlan.revision) {
      return { outcome: "blocked_runtime", reason: "the bound FinalPlan no longer resolves", code: "final_plan_binding_mismatch" };
    }
    const [directives, reports, assessments, commits, stages] = await Promise.all([
      store.listExecutionDirectivesForRun(run.id),
      store.listExecutionReportsForRun(run.id),
      store.listSupervisorAssessmentsForRun(run.id),
      store.listExecutionCommitsForRun(run.id),
      store.listExecutionStagesForRun(run.id),
    ]);
    // §88 — live Stage/Window CAS baselines from the same snapshot, so the
    // model never guesses revision numbers in its CAS-protected calls.
    const openStage = run.activeStage ? await store.getExecutionStage(run.activeStage) : undefined;
    const openWindow = run.openWindow ? await store.getVerificationWindow(run.openWindow) : undefined;
    const context = assembleExecutionSupervisorContext({
      recovery,
      runRevision: run.revision,
      cas: {
        ...(openStage ? { stageID: openStage.id, stageRevision: openStage.revision } : {}),
        ...(openWindow
          ? { windowID: openWindow.id, windowRevision: openWindow.revision, candidateRevision: openWindow.candidateRevision }
          : {}),
      },
      stages,
      finalPlanIdentity: {
        id: finalPlan.id,
        revision: finalPlan.revision,
        hash: run.finalPlanHash,
        goal: planningRun?.goal?.statement ?? "",
      },
      directives,
      reports,
      assessments,
      commits,
    });

    // §21 — mechanical repository-tool isolation for the WHOLE turn.
    const tools = projectSupervisorToolMap(this.options.extraHostToolNames ?? []);
    for (const name of this.options.registeredUltraPlanToolNames ?? []) tools[name] = false;

    const surface = new ExecutionSupervisorToolSurface({ store, trustedCeiling: this.options.trustedCeiling });
    surface.bindRun(run.id);
    const system = EXECUTION_SUPERVISOR_SYSTEM_PROMPT;
    const model = modelBinding(this.options.policy.supervisorModel);
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_SUPERVISOR_TIMEOUT_MS;
    const maxRounds = this.options.maxReadRounds ?? DEFAULT_MAX_READ_ROUNDS;
    this.options.tracer?.record({
      kind: "supervisor_invocation_started",
      modelRole: "supervisor",
      executionRunID: run.id,
      sessionID: input.trustedAuthority.sessionID,
      at: started,
    });

    let childSessionID: string | undefined;
    try {
      const created = await this.options.client.session.create({
        body: {
          // Phase 7B §14: the child-session lineage parent is the TRUSTED user
          // session (from the injected authority) unless the construction options
          // pin one; the child session itself never owns authority.
          parentID: this.options.parentSessionID ?? input.trustedAuthority.sessionID,
          title: `ultra-plan supervisor turn ${run.id}`,
        },
      });
      childSessionID = created.data?.id;
      if (!childSessionID) {
        return { outcome: "blocked_runtime", reason: "the host could not create a supervisor session" };
      }
    } catch (error) {
      return { outcome: "blocked_runtime", reason: `supervisor session creation failed: ${error instanceof Error ? error.message : String(error)}` };
    }

    const ask = async (text: string): Promise<{ ok: true; text: string } | { ok: false; reason: string }> => {
      try {
        const response = await Promise.race([
          this.options.client.session.prompt({
            path: { id: childSessionID! },
            body: {
              parts: [{ type: "text", text }],
              ...(model ? { model } : {}),
              system,
              tools,
            },
          }),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("supervisor invocation timed out")), timeoutMs)),
        ]);
        if (response.error || !response.data) return { ok: false, reason: "the host returned no assistant response" };
        if (response.data.info.error) return { ok: false, reason: `model error: ${response.data.info.error.name ?? "unknown"}` };
        return { ok: true, text: finalTextOf(response.data) };
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
    };

    // §25 — the bounded turn loop: reads, then at most one mutation.
    let message = [
      "SUPERVISOR CONTEXT (deterministic projection of the durable Store — your only state):",
      renderExecutionSupervisorContext(context),
      "",
      "Decide your next step and answer in the exact contract format.",
    ].join("\n");
    for (let round = 0; round <= maxRounds; round++) {
      const answer = await ask(message);
      if (!answer.ok) {
        this.options.tracer?.record({ kind: "supervisor_invocation_failed", modelRole: "supervisor", executionRunID: run.id, sessionID: input.trustedAuthority.sessionID, durationMs: Date.now() - started, result: answer.reason, at: Date.now() });
        return { outcome: "blocked_runtime", reason: answer.reason };
      }
      const parsed = parseModelResponse(answer.text);
      if (parsed.kind === "invalid") {
        return { outcome: "blocked_runtime", reason: `invalid supervisor payload: ${parsed.reason}` };
      }
      if (parsed.kind === "note") {
        this.traceCompleted(run.id, input.trustedAuthority.sessionID, started, "awaiting_supervisor");
        return { outcome: "awaiting_supervisor", note: parsed.text };
      }
      const call = parsed.call;
      const tool = surface.tools.find((entry) => entry.name === call.tool);
      if (!tool) {
        return { outcome: "blocked_runtime", reason: `unknown execution operation "${call.tool}"`, code: "unknown_execution_tool" };
      }
      const outcome = await surface.execute(call.tool, call.args, input.trustedAuthority);
      if (!outcome.ok) {
        const error = outcome.error!;
        if (error.code === "supervisor_turn_already_mutated") {
          // §25 — the turn already mutated; more work must wait for a fresh turn.
          this.traceCompleted(run.id, input.trustedAuthority.sessionID, started, "state_mutated");
          return { outcome: "state_mutated", mutation: "supervisor_turn_already_mutated", detail: { note: error.message } };
        }
        if (error.code === "stale_supervisor_binding" || error.code === "supervisor_session_mismatch" || error.code === "workspace_mismatch") {
          return { outcome: "fencing_failure", code: error.code, message: error.message };
        }
        if (error.retryable) {
          // §63 — stale CAS: end the turn; a fresh turn reloads canonical state.
          return { outcome: "stale_context", code: error.code, message: error.message };
        }
        return { outcome: "blocked_runtime", reason: error.message, code: error.code };
      }
      if (tool.readonly) {
        // The read result feeds the SAME turn's next round (§25: reads are free).
        message = [
          `RESULT of ${call.tool}:`,
          JSON.stringify(outcome.result ?? null),
          "",
          "Continue in the exact contract format (another read, one mutation, or a note).",
        ].join("\n");
        continue;
      }
      // §25/§26 — the ONE authoritative mutation: map and END the turn.
      this.traceCompleted(run.id, input.trustedAuthority.sessionID, started, call.tool);
      if (call.tool === "execution_issue_directive") {
        const directive = (outcome.result as { directive: { id: string; revision: number; hash: string; kind: string } }).directive;
        return { outcome: "directive_issued", directive };
      }
      if (call.tool === "execution_transition_replan") return { outcome: "replan_required" };
      if (call.tool === "execution_complete_run") {
        return { outcome: "completed", completionID: (outcome.result as { completion: { id: string } }).completion.id };
      }
      return { outcome: "state_mutated", mutation: call.tool, detail: { result: outcome.result ?? null } };
    }
    // Bounded: too many read rounds — end the turn awaiting the Supervisor.
    this.traceCompleted(run.id, input.trustedAuthority.sessionID, started, "awaiting_supervisor");
    return { outcome: "awaiting_supervisor", note: "read-round budget exhausted; the turn ended without a mutation" };
  }

  private traceCompleted(executionRunID: string, sessionID: string, started: number, result: string): void {
    this.options.tracer?.record({
      kind: "supervisor_invocation_completed",
      modelRole: "supervisor",
      executionRunID,
      sessionID,
      durationMs: Date.now() - started,
      result,
      at: Date.now(),
    });
  }
}
