/**
 * ExecutionWorker — v0.2.0 Phase 4 (provider-neutral worker port).
 *
 * ONE common abstraction for BOTH worker roles (directive 39): executor and
 * verifier are ROLES of this single protocol — there is deliberately no
 * ExecutorRunner/VerifierRunner split and no second report object model.
 * There is deliberately NO concrete OpenCode dispatch adapter yet (directive
 * 40): the production Supervisor runtime does not exist, so the port exists
 * for the protocol and tests only — never invoked automatically, never
 * wired into the production handoff.
 *
 * WORKER CONTEXT (directive 41-43): deterministic, assembled from exact
 * records only — the exact Directive, the resolved content of EXACTLY the
 * Directive's planRefs (never the whole Plan Memory, never "latest"), the
 * compact FinalPlan normative identity, run/stage/window identities, the
 * copied base accepted state, and the ALREADY-COMPUTED effective capability
 * envelope. The Worker never self-declares capabilities, and worker role
 * never grants any. No Executor conversation or hidden reasoning exists
 * anywhere in the domain model, so verifier-role invocations are isolated
 * from executor reasoning BY CONSTRUCTION. There is no mid-attempt
 * Supervisor RPC: the context is frozen at Attempt start, and missing
 * context is reported through result=blocked — never a widened read.
 */
import type { Constraint, Decision, FinalPlan, SectionRevision } from "../core/types.js";
import type { ImplementationStep } from "../synthesis/types.js";
import type {
  ExecutionCapabilityEnvelope,
  ExecutionDirective,
} from "../core/execution-directive.js";
import type { AcceptedStateRef } from "../core/verification-window.js";
import type { WorkerRole } from "../core/execution-attempt.js";
import type { WorkerReportPayload } from "./report-payload.js";

/** One exact planRef resolved to its exact committed content (never "latest"). */
export type ResolvedExecutionPlanRef =
  | { kind: "final_plan"; content: FinalPlan }
  | { kind: "section_revision"; ref: { id: string; revision: number }; content: SectionRevision }
  | { kind: "decision"; ref: { id: string; revision: number }; content: Decision }
  | { kind: "constraint"; id: string; content: Constraint }
  | { kind: "implementation_step"; order: number; content: ImplementationStep };

/**
 * Phase 6A §31 — the conflict resolver's BLINDED dispute context: the neutral
 * resolution question and the two disputed claims ONLY. There is deliberately
 * no "Executor said…"/"Verifier #1 said…" — no worker identities, no source
 * sessions, no hidden reasoning — so the resolver judges facts, not speakers.
 */
export interface ConflictResolutionContext {
  conflictID: string;
  resolutionQuestion: string;
  claimA: string;
  claimB: string;
}

/**
 * Phase 6A §46 — the reconciliation inspection context: exactly the
 * uncertainty being resolved (target Attempts, their Directives and candidate
 * effects), the known revision, and the accepted-state anchor. No hidden
 * reasoning from the interrupted work.
 */
export interface ReconciliationInspectionContext {
  objective: string;
  knownCandidateRevision: number;
  baseAcceptedState: AcceptedStateRef;
  targets: {
    attemptID: string;
    directive: { id: string; revision: number; hash: string };
    candidateEffect: string;
    startedAt: string;
  }[];
}

/** The deterministic Worker invocation context — frozen at Attempt start. */
export interface ExecutionWorkerContext {
  directive: ExecutionDirective;
  /** EXACTLY the Directive's planRefs, resolved to exact committed records. */
  resolvedPlanRefs: ResolvedExecutionPlanRef[];
  /** Compact normative identity of the bound FinalPlan (+ the approved goal). */
  finalPlanIdentity: { id: string; revision: number; hash: string; goal: string };
  runIdentity: { executionRunID: string };
  stage: { id: string; title: string; objective: string };
  window: { id: string; baseAcceptedState: AcceptedStateRef };
  baseCandidateRevision: number;
  /** Already computed: trusted ceilings intersection with the Directive envelope. */
  effectiveCapabilities: ExecutionCapabilityEnvelope;
  role: WorkerRole;
  /** Phase 6A §31 — present exactly when the Directive is a conflict resolver. */
  conflictResolutionContext?: ConflictResolutionContext;
  /** Phase 6A §46 — present exactly when the Directive is a reconciliation inspection. */
  reconciliationContext?: ReconciliationInspectionContext;
}

/**
 * THE provider-neutral worker port. `run` receives the frozen context with
 * precomputed effective capabilities and returns a WorkerReportPayload that
 * the control plane turns into a durable unified ExecutionReport through
 * the submission transaction. Implementations MUST NOT consult any
 * authority state themselves — everything needed is in the context.
 */
export interface ExecutionWorker {
  run(input: {
    role: WorkerRole;
    directive: ExecutionDirective;
    context: ExecutionWorkerContext;
    effectiveCapabilities: ExecutionCapabilityEnvelope;
  }): Promise<WorkerReportPayload>;
}
