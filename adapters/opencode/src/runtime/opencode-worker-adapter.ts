/**
 * OpenCode Worker runtime adapter — v0.2.0 Phase 7A (directive §13/§17/§28-§47).
 *
 * The ONLY OpenCode-aware Worker dispatch implementation. Mechanics:
 *
 * 1. FRESH ISOLATION (§17): every invocation creates a NEW child session
 *    (`session.create({parentID})`) — no Supervisor/Executor/Verifier
 *    conversation, no hidden reasoning is ever inherited. Verifiers are
 *    always fresh; executor continuity is deliberately not optimized.
 * 2. MODEL POLICY (§16): verifier-role invocations bind `verifierModel`,
 *    executor-role invocations bind `workerModel` — per-call, from the
 *    resolved policy; never a vendor name hardcoded here.
 * 3. TOOL ISOLATION (§31/§33): the per-call `tools` override projects the
 *    EFFECTIVE capability envelope onto OpenCode's repository/runtime tools
 *    (host ceiling already intersected by Core); delegation, housekeeping,
 *    and every registered Ultra Plan tool are explicitly denied. The map is
 *    host-enforced — never a prompt request.
 * 4. STRICT STRUCTURED OUTPUT (§35/§36): the COMPLETE final text must be one
 *    JSON WorkerReportPayload (single-fence normalization allowed); anything
 *    else is `indeterminate` — never regex-guessed, never fabricated as a
 *    failed Report (§37).
 * 5. IDENTITY IS HOST-SUPPLIED (§42/§43/§87): the returned payload carries
 *    the DURABLE attempt's role and the EXACT directive revision/hash and
 *    the frozen baseCandidateRevision — whatever the model wrote in those
 *    fields is overwritten before anyone sees it.
 * 6. TIMEOUT/CANCELLATION (§83): a bounded wait or an aborted response is
 *    `indeterminate` ("timeout"/"cancelled") — the Attempt state decision
 *    belongs to the orchestrator, keyed by candidateEffect (§38/§39).
 *
 * DORMANT (§71): constructed only by the internal harness/tests — no
 * production path builds it.
 */
import type { ExecutionDirective } from "../core/execution-directive.js";
import type { ExecutionAttempt } from "../core/execution-attempt.js";
import type { ExecutionCapabilityEnvelope } from "../core/execution-directive.js";
import type { ExecutionWorkerContext } from "../worker/execution-worker.js";
import type {
  ExecutionWorkerRuntime,
  WorkerIndeterminateReason,
  WorkerInvocationResult,
  ExecutionRuntimeTracer,
} from "./execution-runtime.js";
import type { ResolvedExecutionModelPolicy } from "./execution-model-policy.js";
import { modelBinding } from "./execution-model-policy.js";
import { projectWorkerToolMap } from "./capability-projection.js";
import { executionWorkerSystemPrompt, executionVerifierSystemPrompt } from "./protocol-prompts.js";
import { parseWorkerReportOutput } from "./worker-output.js";
import type { OpenCodeModelClient } from "./opencode-client.js";
import { finalTextOf } from "./opencode-client.js";

export interface OpenCodeWorkerAdapterOptions {
  client: OpenCodeModelClient;
  policy: ResolvedExecutionModelPolicy;
  /** §33 — the real host permission ceiling (intersected by Core already). */
  hostCeiling: ExecutionCapabilityEnvelope;
  /** §17 — lineage parent for fresh child sessions (the trusted host session). */
  parentSessionID?: string;
  /** §83 — bounded wait for the worker response. */
  timeoutMs?: number;
  /** §69 — minimal tracing. */
  tracer?: ExecutionRuntimeTracer;
  /** Extra host tool names (from client enumeration) denied by default. */
  extraHostToolNames?: readonly string[];
  /** Registered Ultra Plan planning tools explicitly denied for Workers. */
  registeredUltraPlanToolNames?: readonly string[];
}

const DEFAULT_WORKER_TIMEOUT_MS = 10 * 60_000;

/** The §66/§67 task message: exact Directive + frozen context + report contract, all as data. */
export function renderWorkerTaskMessage(context: ExecutionWorkerContext, role: ExecutionAttempt["workerRole"]): string {
  return [
    "DIRECTIVE (immutable — execute exactly this revision):",
    JSON.stringify({
      directive: context.directive,
      resolvedPlanRefs: context.resolvedPlanRefs,
      finalPlanIdentity: context.finalPlanIdentity,
      runIdentity: context.runIdentity,
      stage: context.stage,
      window: context.window,
      baseCandidateRevision: context.baseCandidateRevision,
      effectiveCapabilities: context.effectiveCapabilities,
      role,
      ...(context.conflictResolutionContext ? { conflictResolutionContext: context.conflictResolutionContext } : {}),
      ...(context.reconciliationContext ? { reconciliationContext: context.reconciliationContext } : {}),
    }, null, 2),
    "",
    "REPORT CONTRACT — your ENTIRE final message must be ONE JSON object with EXACTLY these fields:",
    JSON.stringify({
      directive: { id: "string (echo the directive id)", revision: "number", hash: "string (echo the directive hash)" },
      workerRole: '"executor" | "verifier" (echo your assigned role)',
      result: '"completed" | "partial" | "blocked" | "failed"',
      actionsPerformed: ["string"],
      filesExamined: ["string"],
      filesChanged: ["string"],
      commandsRun: ["string"],
      testsRun: ["string"],
      findings: ["string | {statement, acceptanceImpact: \"informational\"|\"blocking\"}"],
      deviations: [{ kind: '"path"|"symbol"|"additional_requirement"|"other"', note: "string", expected: "string?", actual: "string?" }],
      blockers: [{ kind: '"missing_context"|"ambiguous_directive"|"repository_mismatch"|"unexpected_scope"|"conflicting_requirements"|"missing_prerequisite"|"execution_environment_blocker"', summary: "string", detail: "string?", needed: "string?" }],
      deliverables: ["string"],
      candidateMutation: '"none" | "changed"',
      baseCandidateRevision: "number (echo the baseCandidateRevision above)",
    }, null, 2),
        ...(role === "verifier"
      ? ["Verifier rule: EVERY entry in findings MUST be an object {statement, acceptanceImpact: \"informational\" | \"blocking\"} - a plain-string finding is unclassified and blocks acceptance fail-closed."]
      : []),
"Rules: blocked requires >=1 blocker; only blocked reports may carry blockers. No prose outside the JSON object.",
  ].join("\n");
}

export class OpenCodeWorkerAdapter implements ExecutionWorkerRuntime {
  constructor(private readonly options: OpenCodeWorkerAdapterOptions) {}

  async invokeWorker(input: {
    attempt: ExecutionAttempt;
    directive: ExecutionDirective;
    context: ExecutionWorkerContext;
    effectiveCapabilities: ExecutionCapabilityEnvelope;
  }): Promise<WorkerInvocationResult> {
    const started = Date.now();
    const role = input.attempt.workerRole; // DURABLE role — never the model's claim (§42)
    const model = role === "verifier" ? this.options.policy.verifierModel : this.options.policy.workerModel;
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS;
    const { tools } = projectWorkerToolMap(
      input.effectiveCapabilities,
      this.options.extraHostToolNames,
      this.options.registeredUltraPlanToolNames,
    );
    const ref = `${input.directive.id}@${input.directive.revision}`;
    this.options.tracer?.record({
      kind: "worker_invocation_started",
      modelRole: role,
      executionRunID: input.attempt.executionRunID,
      attemptID: input.attempt.id,
      directiveRef: ref,
      projection: Object.entries(tools).filter(([, enabled]) => enabled).map(([name]) => name),
      at: started,
    });

    // §17 — fresh isolated context: a NEW child session per invocation.
    let workerSessionID: string | undefined;
    try {
      const created = await this.options.client.session.create({
        body: {
          ...(this.options.parentSessionID ? { parentID: this.options.parentSessionID } : {}),
          title: `ultra-plan worker ${ref}`,
        },
      });
      if (!created.data?.id) {
        return this.indeterminate("host_lost_result", "the host could not create a worker session", input, started, undefined);
      }
      workerSessionID = created.data.id;
    } catch (error) {
      return this.indeterminate("host_lost_result", `worker session creation failed: ${error instanceof Error ? error.message : String(error)}`, input, started, undefined);
    }

    const body = {
      parts: [{ type: "text" as const, text: renderWorkerTaskMessage(input.context, role) }],
      ...(modelBinding(model) ? { model: modelBinding(model) } : {}),
      system: role === "verifier" ? executionVerifierSystemPrompt() : executionWorkerSystemPrompt(),
      tools,
    };
    let response: Awaited<ReturnType<OpenCodeModelClient["session"]["prompt"]>>;
    try {
      response = await Promise.race([
        this.options.client.session.prompt({ path: { id: workerSessionID }, body }),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("worker invocation timed out")), timeoutMs);
        }),
      ]);
    } catch (error) {
      const reason: WorkerIndeterminateReason = error instanceof Error && error.message.includes("timed out") ? "timeout" : "host_lost_result";
      return this.indeterminate(reason, error instanceof Error ? error.message : String(error), input, started, workerSessionID);
    }
    const data = response.data;
    if (response.error || !data) {
      return this.indeterminate("host_lost_result", "the host returned no assistant response", input, started, workerSessionID);
    }
    const messageError = data.info.error;
    if (messageError) {
      const reason: WorkerIndeterminateReason = messageError.name === "MessageAbortedError" ? "cancelled" : "host_lost_result";
      return this.indeterminate(reason, messageError.name ?? "unknown model error", input, started, workerSessionID);
    }
    const text = finalTextOf(data);
    if (text.trim().length === 0) {
      return this.indeterminate("missing_response", "the worker produced no final output", input, started, workerSessionID);
    }
    // §35/§36 — strict parse of the COMPLETE final output. Any deviation is
    // an indeterminate runtime fact, never a fabricated report (§37).
    let payload;
    try {
      payload = parseWorkerReportOutput(text);
    } catch (error) {
      return this.indeterminate(
        "invalid_output",
        error instanceof Error ? error.message : String(error),
        input,
        started,
        workerSessionID,
      );
    }
    // §42/§43/§87 — identity is host-supplied: durable role, exact directive
    // ref, frozen base revision. The model's versions of these fields are
    // overwritten unconditionally.
    const reported = {
      ...payload,
      workerRole: role,
      directive: { id: input.directive.id, revision: input.directive.revision, hash: input.directive.hash },
      baseCandidateRevision: input.context.baseCandidateRevision,
    };
    const duration = Date.now() - started;
    this.options.tracer?.record({
      kind: "worker_invocation_completed",
      modelRole: role,
      executionRunID: input.attempt.executionRunID,
      attemptID: input.attempt.id,
      directiveRef: ref,
      sessionID: workerSessionID,
      durationMs: duration,
      result: reported.result,
      at: Date.now(),
    });
    return { kind: "reported", payload: reported, workerSessionID };
  }

  private indeterminate(
    reason: WorkerIndeterminateReason,
    detail: string,
    input: { attempt: ExecutionAttempt; directive: ExecutionDirective },
    started: number,
    workerSessionID: string | undefined,
  ): WorkerInvocationResult {
    this.options.tracer?.record({
      kind: "worker_invocation_failed",
      modelRole: input.attempt.workerRole,
      executionRunID: input.attempt.executionRunID,
      attemptID: input.attempt.id,
      directiveRef: `${input.directive.id}@${input.directive.revision}`,
      sessionID: workerSessionID,
      durationMs: Date.now() - started,
      result: reason,
      at: Date.now(),
    });
    return { kind: "indeterminate", reason, detail, workerSessionID };
  }
}
