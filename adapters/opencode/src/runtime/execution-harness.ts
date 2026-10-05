/**
 * Dormant supervised-execution harness — v0.2.0 Phase 7A (directive §48/§71/§72).
 *
 * The INTERNAL entry for integration tests and internal tooling: given a
 * PREPARED ExecutionRun it binds the Supervisor (explicitly — never an
 * auto-takeover of a foreign binding, §58), activates the run, and runs the
 * mechanical supervised loop to a terminal/stop outcome. This is NOT a user
 * production command: nothing in the plugin, the /ultra-plan command path,
 * or the v0.1 handoff constructs or invokes it (§71 — dormant registration).
 *
 * The runtime ports are provider-neutral: tests inject fakes (§73), the
 * OpenCode adapters construct the real thing (§74 — no live LLM needed).
 */
import type { PlanStore } from "../memory/store.js";
import type { ExecutionCapabilityCeiling } from "../core/execution-directive.js";
import type { WorkspaceIdentity } from "../core/execution-run.js";
import type {
  ExecutionRuntimeTracer,
  ExecutionSupervisorRuntime,
  ExecutionWorkerRuntime,
  WorkerLivenessProbe,
} from "./execution-runtime.js";
import type { ResolvedExecutionModelPolicy } from "./execution-model-policy.js";
import { ExecutionOrchestrator } from "./execution-orchestrator.js";
import type { DispatchIssuedDirectiveResult, SupervisedLoopResult } from "./execution-orchestrator.js";

export interface ExecutionHarnessDeps {
  store: PlanStore;
  supervisor: ExecutionSupervisorRuntime;
  worker: ExecutionWorkerRuntime;
  policy: ResolvedExecutionModelPolicy;
  /** §24/§33 — the TRUSTED host/user ceiling (never model-supplied). */
  trustedCeiling: ExecutionCapabilityCeiling;
  /** The trusted workspace identity of this harness instance. */
  workspace: WorkspaceIdentity;
  tracer?: ExecutionRuntimeTracer;
  livenessProbe?: WorkerLivenessProbe;
}

export interface RunDormantSupervisedExecutionInput {
  executionRunID: string;
  /** The trusted authoritative session (injected by the harness caller). */
  sessionID: string;
  generation?: number;
  maxSteps?: number;
}

export type DormantSupervisedExecutionResult =
  | { phase: "loop"; result: SupervisedLoopResult; dispatches: DispatchIssuedDirectiveResult[] }
  | { phase: "takeover_required"; ownerSessionID: string }
  | { phase: "not_recoverable" };

/**
 * Bind → activate → loop. Explicit entry only; every mutation still goes
 * through the frozen Core transactions (authority, CAS, gates included).
 */
export async function runDormantSupervisedExecution(
  deps: ExecutionHarnessDeps,
  input: RunDormantSupervisedExecutionInput,
): Promise<DormantSupervisedExecutionResult> {
  const store = deps.store;
  const run = await store.getExecutionRun(input.executionRunID as never);
  if (!run) return { phase: "not_recoverable" };
  if (run.lifecycle === "replan_required" || run.lifecycle === "completed" || run.lifecycle === "aborted") {
    return { phase: "not_recoverable" };
  }
  const generation = input.generation ?? 1;
  const binding = await store.findSupervisorBinding(run.id);
  if (binding && binding.ownerSessionID !== input.sessionID) {
    // §58 — a foreign binding is NEVER auto-taken over.
    return { phase: "takeover_required", ownerSessionID: binding.ownerSessionID };
  }
  if (!binding) {
    await store.attachExecutionSupervisor({ executionRunID: run.id, sessionID: input.sessionID, workspace: deps.workspace });
  }
  const live = (await store.getExecutionRun(run.id))!;
  if (live.lifecycle === "prepared") {
    await store.activateSupervisedExecutionRun({
      executionRunID: run.id,
      sessionID: input.sessionID,
      workspace: deps.workspace,
      generation,
      runRevision: live.revision,
      finalPlan: live.finalPlan,
    });
  }
  const orchestrator = new ExecutionOrchestrator({
    store,
    supervisor: deps.supervisor,
    worker: deps.worker,
    policy: deps.policy,
    trustedCeiling: deps.trustedCeiling,
    workspace: deps.workspace,
    ...(deps.tracer ? { tracer: deps.tracer } : {}),
    ...(deps.livenessProbe ? { livenessProbe: deps.livenessProbe } : {}),
  });
  const dispatches: DispatchIssuedDirectiveResult[] = [];
  const result = await orchestrator.runSupervisedLoop({
    executionRunID: input.executionRunID,
    sessionID: input.sessionID,
    generation,
    ...(input.maxSteps !== undefined ? { maxSteps: input.maxSteps } : {}),
    onDispatch: (dispatch) => dispatches.push(dispatch),
  });
  return { phase: "loop", result, dispatches };
}
