/**
 * Execution runtime ports — v0.2.0 Phase 7A (directive §11-§13/§53/§69).
 *
 * The provider-neutral boundary between the Ultra Plan core and a HOST model
 * runtime. Two ports, mirroring the frozen trust split:
 *
 * - `ExecutionSupervisorRuntime` — READ + REASON + DIRECT + JUDGE. Receives
 *   trusted host authority injected by the adapter (never model-supplied),
 *   deterministically rebuilds the Supervisor context from durable Store
 *   state, invokes the configured Supervisor model with an execution-only
 *   tool surface, and maps the turn onto the closed outcome vocabulary
 *   below. It owns NO repository tools — no file read/edit, no shell, no
 *   git, no network (§21).
 * - `ExecutionWorkerRuntime` — repository/runtime ACTIONS. Invokes ONE
 *   fresh, isolated execution-tier Worker for ONE exact immutable Directive,
 *   collects a STRICT structured WorkerReportPayload, and never fabricates
 *   one: a missing/invalid/timeout result is reported as `indeterminate`
 *   (§37-§39), never as a guessed failed Report.
 *
 * Core never depends on OpenCode APIs; the OpenCode adapters live beside
 * these ports and are DORMANT — no production path constructs them (§71).
 */
import type { ExecutionDirective, ExecutionCapabilityEnvelope } from "../core/execution-directive.js";
import type { ExecutionAttempt } from "../core/execution-attempt.js";
import type { WorkspaceIdentity } from "../core/execution-run.js";
import type { ExecutionRunID } from "../core/ids.js";
import type { WorkerReportPayload } from "../worker/report-payload.js";
import type { ExecutionWorkerContext } from "../worker/execution-worker.js";

// ---------------------------------------------------------------------------
// §53 — the closed Supervisor-turn outcome vocabulary. The orchestrator
// branches on these values ONLY — never on free-text model output.
// ---------------------------------------------------------------------------

export const EXECUTION_SUPERVISOR_TURN_OUTCOMES = [
  /** The turn issued an ExecutionDirective — the turn ends; the host dispatches the Worker. */
  "directive_issued",
  /** The turn performed exactly one other durable structural mutation; context must be rebuilt. */
  "state_mutated",
  /** Read-only turn: the Supervisor reasoned and chose to wait. */
  "awaiting_supervisor",
  /** The turn's mutation hit a stale CAS (run/stage/window revision, candidateRevision) — refresh and retry with fresh context. */
  "stale_context",
  /** The caller's authority was fenced out (binding/session/workspace) — writable control ends; never an auto-takeover. */
  "fencing_failure",
  /** The run is (or just became) terminal replan_required. */
  "replan_required",
  /** The run is completed (CompletionGate recorded). */
  "completed",
  /** Runtime/model failure or invalid tool payload — NO business mutation happened. */
  "blocked_runtime",
] as const;

export type ExecutionSupervisorTurnOutcome = (typeof EXECUTION_SUPERVISOR_TURN_OUTCOMES)[number];

/** Trusted host identity — ALWAYS injected by the adapter, never the model payload (§24). */
export interface TrustedExecutionAuthority {
  sessionID: string;
  workspace: WorkspaceIdentity;
  /** The caller's known binding generation (fencing). */
  generation: number;
}

export interface ExecutionSupervisorTurnInput {
  executionRunID: ExecutionRunID;
  trustedAuthority: TrustedExecutionAuthority;
}

export interface IssuedDirectiveRef {
  id: string;
  revision: number;
  hash: string;
  kind: string;
}

export type ExecutionSupervisorTurnResult =
  | { outcome: "directive_issued"; directive: IssuedDirectiveRef }
  | { outcome: "state_mutated"; mutation: string; detail?: Record<string, unknown> }
  | { outcome: "awaiting_supervisor"; note?: string }
  | { outcome: "stale_context"; code: string; message: string }
  | { outcome: "fencing_failure"; code: string; message: string }
  | { outcome: "replan_required" }
  | { outcome: "completed"; completionID?: string }
  | { outcome: "blocked_runtime"; reason: string; code?: string };

/**
 * The Supervisor model-runner port. An implementation owns the model/tool
 * loop for ONE control turn: it presents the protocol prompt + the
 * deterministic context projection + the execution-only tool surface, and
 * enforces the §25 discipline (zero or more reads, AT MOST ONE authoritative
 * mutation — the turn ends after it).
 */
export interface ExecutionSupervisorRuntime {
  runExecutionSupervisorTurn(input: ExecutionSupervisorTurnInput): Promise<ExecutionSupervisorTurnResult>;
}

// ---------------------------------------------------------------------------
// §13/§35-§43 — the Worker invocation port. Strict structured output only.
// ---------------------------------------------------------------------------

/** Why a Worker invocation produced NO usable Report (§37). Never "failed". */
export const WORKER_INDETERMINATE_REASONS = [
  "missing_response",
  "invalid_output",
  "timeout",
  "cancelled",
  "host_lost_result",
  "liveness_unprovable",
] as const;

export type WorkerIndeterminateReason = (typeof WORKER_INDETERMINATE_REASONS)[number];

export type WorkerInvocationResult =
  /** A strictly-validated payload; identity fields below were host-supplied. */
  | { kind: "reported"; payload: WorkerReportPayload; workerSessionID?: string }
  /** No usable Report exists — the Attempt becomes (or stays) indeterminate. */
  | { kind: "indeterminate"; reason: WorkerIndeterminateReason; detail?: string; workerSessionID?: string };

export interface ExecutionWorkerInvocationInput {
  attempt: ExecutionAttempt;
  directive: ExecutionDirective;
  /** The frozen Phase 4 context (directive §41-§43) — already assembled. */
  context: ExecutionWorkerContext;
  /** Already intersected with the host ceiling. */
  effectiveCapabilities: ExecutionCapabilityEnvelope;
}

/**
 * The Worker model-runner port. Implementations MUST create a FRESH, isolated
 * inference context per invocation (§17 — verifiers especially), expose only
 * the capability-projected OpenCode repository/runtime tools, and return a
 * strictly-validated payload or an indeterminate fact — never prose parsing.
 */
export interface ExecutionWorkerRuntime {
  invokeWorker(input: ExecutionWorkerInvocationInput): Promise<WorkerInvocationResult>;
}

/** §61 — a host process-registry probe. Return true ONLY when the invocation is provably still alive. */
export type WorkerLivenessProbe = (attempt: ExecutionAttempt) => Promise<boolean>;

// ---------------------------------------------------------------------------
// §69 — minimal runtime tracing. Metadata + refs + durations ONLY; final
// output CONTENT and hidden chain-of-thought are never recorded.
// ---------------------------------------------------------------------------

export const EXECUTION_RUNTIME_TRACE_KINDS = [
  "supervisor_invocation_started",
  "supervisor_invocation_completed",
  "supervisor_invocation_failed",
  "worker_invocation_started",
  "worker_invocation_completed",
  "worker_invocation_failed",
] as const;

export type ExecutionRuntimeTraceKind = (typeof EXECUTION_RUNTIME_TRACE_KINDS)[number];

export interface ExecutionRuntimeTraceEvent {
  kind: ExecutionRuntimeTraceKind;
  /** "supervisor" | "executor" | "verifier" | "conflict_resolver" | "reconciliation" */
  modelRole: string;
  executionRunID?: string;
  attemptID?: string;
  directiveRef?: string;
  sessionID?: string;
  /** Tool/capability projection summary (names only). */
  projection?: string[];
  durationMs?: number;
  /** Outcome label or indeterminate reason — never output content. */
  result?: string;
  at: number;
}

export interface ExecutionRuntimeTracer {
  record(event: ExecutionRuntimeTraceEvent): void;
}

/** In-memory tracer (tests / dormant harness). Never logs output content. */
export class InMemoryExecutionRuntimeTracer implements ExecutionRuntimeTracer {
  readonly events: ExecutionRuntimeTraceEvent[] = [];

  record(event: ExecutionRuntimeTraceEvent): void {
    this.events.push(event);
  }
}
