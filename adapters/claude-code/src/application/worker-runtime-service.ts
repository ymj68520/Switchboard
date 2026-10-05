/**
 * ExecutionWorker runtime application service (v0.2.0 E5 §8–§17/§24/§33/§35).
 *
 * Authority model: the current fenced Supervisor starts real Worker execution
 * (launch preparation); a fresh native Claude ExecutionWorker subagent CLAIMS
 * its exact Attempt with a one-time Core-generated launch token; the claimed
 * worker then loads its exact assignment and submits exactly one structured
 * ExecutionReport through the E4 protocol authority. All transitions are
 * Core-owned; the worker session identity comes from the signed host context,
 * never from model arguments (E5 §33).
 *
 * Worker authority is ATTEMPT-SCOPED (E5 §34): the claim/report path never
 * consults the SupervisorBinding — a Supervisor detach mid-execution never
 * cancels a claimed Worker, and a Supervisor session can never impersonate a
 * Worker. The one-time launch token binds exact Attempt/Directive revision +
 * hash/role at preparation time and is stored only as a sha256 hash (E5
 * §9/§46); the workspace fence is re-derived from the bound run at claim and
 * at every worker operation.
 *
 * Durable-before-success (E5 §39): submitWorkerReportAndFinishInTx persists
 * the Report, transitions the Attempt to reported, advances the candidate
 * revision when factually mutated, and marks the invocation finished in ONE
 * transaction — the worker invocation is a success only after that commit.
 */

import { randomBytes } from "node:crypto";

import type { ExecutionDirective } from "../core/execution-directive.js";
import type { DirectivePlanRef } from "../core/execution-directive.js";
import type { ExecutionAttempt } from "../core/execution-attempt.js";
import type { WorkerInvocationBinding } from "../core/worker-invocation.js";
import type { MemoryRef } from "../core/memory-refs.js";
import { isMemoryArtifactKind } from "../core/memory-refs.js";
import { RuntimeError } from "../runtime/errors.js";
import { getExecutionAttemptInTx, markAttemptIndeterminateInTx } from "../store/execution-attempts.js";
import { getExecutionDirectiveInTx } from "../store/execution-directives.js";
import { getExecutionRunInTx } from "../store/execution-runs.js";
import { readMemoryRevisionRecord } from "../store/plan-memory.js";
import { getReportForAttemptInTx } from "../store/execution-reports.js";
import { getVerificationConflictInTx } from "../store/verification-conflicts.js";
import { blindedConflictContext, type BlindedConflictContext } from "../core/verification-conflict.js";
import { getEvidenceRevisionRecord } from "../store/evidence.js";
import {
  claimWorkerInvocationInTx as claimInTx,
  finishWorkerInvocationInTx,
  getOwnInvocationForSessionInTx,
  getWorkerInvocationInTx,
  hashLaunchToken,
  insertPreparedWorkerInvocationInTx,
} from "../store/worker-invocations.js";
import { submitExecutionReportInTx, type SubmissionResult, type SubmitExecutionReportInput } from "./execution-report-service.js";
import { startExecutionAttemptInTx, type StartExecutionAttemptInput } from "./execution-attempt-service.js";
import type { StoreClock } from "../store/migration-runner.js";
import type { PlanStore } from "../store/sqlite-store.js";
import type { StoreTx } from "../store/transaction.js";

function workerRuntimeError(
  code:
    | "WORKER_LAUNCH_INVALID"
    | "WORKER_CLAIM_TOKEN_INVALID"
    | "WORKER_ATTEMPT_ALREADY_CLAIMED"
    | "WORKER_SESSION_MISMATCH"
    | "WORKER_AUTHORITY_REQUIRED"
    | "WORKER_INVOCATION_FINISHED"
    | "ATTEMPT_NOT_RUNNING"
    | "ATTEMPT_ALREADY_REPORTED"
    | "DIRECTIVE_NOT_CURRENT"
    | "CAPABILITY_ENFORCEMENT_UNAVAILABLE"
    | "INVALID_EXECUTION_LIFECYCLE",
  message: string,
  detail?: Record<string, unknown>,
): RuntimeError {
  return new RuntimeError(code, message, { detail, recoverable: false });
}

/** Core-generated unguessable one-time launch token (E5 §9). */
export function newLaunchToken(): string {
  return `wlt_${randomBytes(32).toString("base64url")}`;
}

/**
 * E5 §24/§25 — the honest enforceability gate. repositoryRead,
 * repositoryWrite, commandExecution, and networkAccess map to distinct Host
 * tool categories and are enforced by the Worker-aware PreToolUse hook. The
 * five semantic categories (networkAccess / dependencyMutation / gitCommit /
 * gitPush / externalServiceMutation) are only enforceable when the shell
 * channel is CLOSED: a wide-open commandExecution=true shell cannot reliably
 * classify obfuscated network/dependency/git-mutating commands, and a
 * substring classifier would be a permissive security fiction (E5 §25).
 * Such combinations refuse to launch — never advisory weakening.
 */
export function requireEnforceableCapabilityEnvelope(
  envelope: ExecutionDirective["capabilityEnvelope"],
): void {
  if (!envelope.commandExecution) {
    return;
  }
  const unenforceable = (
    [
      "networkAccess",
      "dependencyMutation",
      "gitCommit",
      "gitPush",
      "externalServiceMutation",
    ] as const
  ).filter((capability) => !envelope[capability]);
  if (unenforceable.length > 0) {
    throw workerRuntimeError(
      "CAPABILITY_ENFORCEMENT_UNAVAILABLE",
      "the Claude adapter cannot reliably enforce restrictions of "
        + `${unenforceable.join(", ")} while commandExecution is enabled (an open shell cannot be conservatively classified); `
        + "issue a Directive with commandExecution=false or grant the capability",
      { detail: { unenforceable } },
    );
  }
}

export interface PreparedWorkerLaunch {
  attemptId: string;
  executionRunId: string;
  workerRole: "executor" | "verifier";
  directive: { id: string; revision: number; hash: string };
  /** The plaintext launch token — returned ONCE, never persisted. */
  launchToken: string;
  /** The native subagent type the Supervisor must launch (E5 §43). */
  workerAgentType: string;
}

/**
 * Prepare the worker launch for an already-running Attempt (E5 §9): one
 * prepared invocation binding + one one-time token. Idempotent for the SAME
 * prepared ticket (host transport retry, E5 §11); claimed/finished attempts
 * never relaunch. The Supervisor authority fence is the CALLER's
 * responsibility (start_worker_attempt performs it).
 */
export function prepareWorkerLaunchInTx(
  tx: StoreTx,
  input: { attemptId: string },
  now: string,
): PreparedWorkerLaunch {
  const attempt = getExecutionAttemptInTx(tx, input.attemptId);
  if (attempt === null) {
    throw workerRuntimeError("WORKER_LAUNCH_INVALID", `no ExecutionAttempt exists for '${input.attemptId}'`, {
      attemptId: input.attemptId,
    });
  }
  if (attempt.state !== "running") {
    throw workerRuntimeError(
      "WORKER_LAUNCH_INVALID",
      `attempt '${input.attemptId}' is ${attempt.state}; only a running attempt can be launched`,
      { attemptId: input.attemptId, state: attempt.state },
    );
  }
  const directive = getExecutionDirectiveInTx(tx, attempt.directiveId, attempt.directiveRevision);
  if (directive === null || directive.hash !== attempt.directiveHash) {
    throw workerRuntimeError("DIRECTIVE_NOT_CURRENT", `attempt '${input.attemptId}' binds a missing Directive revision`, {
      attemptId: input.attemptId,
    });
  }
  const run = getExecutionRunInTx(tx, directive.executionRunId);
  if (run === null || run.lifecycle !== "active") {
    throw workerRuntimeError("WORKER_LAUNCH_INVALID", `attempt run '${directive.executionRunId}' is missing or not active`, {
      attemptId: input.attemptId,
    });
  }
  requireEnforceableCapabilityEnvelope(directive.capabilityEnvelope);
  const launchToken = newLaunchToken();
  insertPreparedWorkerInvocationInTx(
    tx,
    {
      attemptId: attempt.attemptId,
      executionRunId: directive.executionRunId,
      workerRole: attempt.workerRole,
      launchTokenHash: hashLaunchToken(launchToken),
      directiveId: attempt.directiveId,
      directiveRevision: attempt.directiveRevision,
      directiveHash: attempt.directiveHash,
    },
    now,
  );
  return {
    attemptId: attempt.attemptId,
    executionRunId: directive.executionRunId,
    workerRole: attempt.workerRole,
    directive: { id: attempt.directiveId, revision: attempt.directiveRevision, hash: attempt.directiveHash },
    launchToken,
    workerAgentType: "phase-plan:execution-worker",
  };
}

export interface WorkerAuthorityFacts {
  invocation: WorkerInvocationBinding;
  attempt: ExecutionAttempt;
  directive: ExecutionDirective;
  runWorkspaceId: string;
}

/**
 * The E5 §33 authority chain for worker operations: current worker session →
 * claimed WorkerInvocationBinding → exact running Attempt → Directive → run
 * workspace. Fails closed when anything is missing or foreign.
 */
export function requireWorkerAuthorityInTx(
  tx: StoreTx,
  input: { workerSessionId: string; workspaceId: string; attemptId?: string },
): WorkerAuthorityFacts {
  const invocation =
    input.attemptId === undefined
      ? getOwnInvocationForSessionInTx(tx, input.workerSessionId)
      : ((): WorkerInvocationBinding | null => {
          const binding = getWorkerInvocationInTx(tx, input.attemptId);
          return binding !== null && binding.workerSessionId === input.workerSessionId ? binding : null;
        })();
  if (invocation === null) {
    throw workerRuntimeError(
      "WORKER_AUTHORITY_REQUIRED",
      "no claimed worker invocation exists for the current worker session",
      { workerSessionId: input.workerSessionId },
    );
  }
  if (invocation.state !== "claimed") {
    throw workerRuntimeError("WORKER_INVOCATION_FINISHED", `the invocation for '${invocation.attemptId}' is ${invocation.state}`, {
      attemptId: invocation.attemptId,
    });
  }
  const attempt = getExecutionAttemptInTx(tx, invocation.attemptId);
  if (attempt === null || attempt.executionRunId !== invocation.executionRunId || attempt.workerRole !== invocation.workerRole) {
    throw workerRuntimeError("WORKER_AUTHORITY_REQUIRED", `the invocation for '${invocation.attemptId}' binds a missing attempt`, {
      attemptId: invocation.attemptId,
    });
  }
  if (attempt.state !== "running") {
    throw workerRuntimeError("ATTEMPT_NOT_RUNNING", `attempt '${attempt.attemptId}' is ${attempt.state}`, {
      attemptId: attempt.attemptId,
      state: attempt.state,
    });
  }
  const directive = getExecutionDirectiveInTx(tx, attempt.directiveId, attempt.directiveRevision);
  if (directive === null || directive.hash !== attempt.directiveHash) {
    throw workerRuntimeError("DIRECTIVE_NOT_CURRENT", `attempt '${attempt.attemptId}' binds a missing Directive revision`, {
      attemptId: attempt.attemptId,
    });
  }
  // Workspace fence (E5-T5): the invocation belongs to the run's workspace.
  const run = getExecutionRunInTx(tx, invocation.executionRunId);
  if (run === null || run.workspaceId !== input.workspaceId) {
    throw workerRuntimeError("WORKER_SESSION_MISMATCH", "the invocation belongs to a different WorkspaceIdentity", {
      expected: run?.workspaceId ?? null,
      detected: input.workspaceId,
    });
  }
  // E13 §27/§28 — Run lifecycle participates in EVERY worker authority path
  // (assignment, report submission, and the host-tool capability guard all
  // route through here): a terminal ExecutionRun revokes all FUTURE worker
  // authority even though the Attempt row intentionally remains `running`
  // (E13 §24 — historical state, no authority). A claimed Worker therefore
  // loses its Phase Plan-authorized repository/runtime tool surface at the
  // abort boundary exactly like an unclaimed one.
  if (run.lifecycle !== "active") {
    throw workerRuntimeError(
      "INVALID_EXECUTION_LIFECYCLE",
      `execution run '${invocation.executionRunId}' is ${run.lifecycle}; worker authority requires an active run (E13 §28)`,
      { attemptId: invocation.attemptId, executionRunId: invocation.executionRunId, lifecycle: run.lifecycle },
    );
  }
  return { invocation, attempt, directive, runWorkspaceId: run.workspaceId };
}

/**
 * Claim a prepared invocation (E5 §10/§11): the store gate verifies attempt
 * running + binding prepared + one-time token + session-not-yet-bound, then
 * atomically binds the authoritative worker session and consumes the token.
 * The workspace fence is re-derived from the bound run — a foreign
 * WorkspaceIdentity can never keep a claim.
 */
export function claimWorkerAttemptInTx(
  tx: StoreTx,
  input: { attemptId: string; launchToken: string; workerSessionId: string; workerAgentId: string; workspaceId: string },
  now: string,
): WorkerAuthorityFacts {
  const prepared = getWorkerInvocationInTx(tx, input.attemptId);
  if (prepared === null) {
    throw workerRuntimeError("WORKER_CLAIM_TOKEN_INVALID", `no worker invocation exists for attempt '${input.attemptId}'`, {
      attemptId: input.attemptId,
    });
  }
  // E8 §33 — a conflict resolver must be FRESH: its worker session differs
  // from every worker session behind the conflict's source Reports. Enforced
  // at claim time where authoritative session identities exist; independence
  // that cannot be proven fails closed BEFORE the token is consumed.
  const attempt = getExecutionAttemptInTx(tx, input.attemptId);
  const claimDirective =
    attempt === null ? null : getExecutionDirectiveInTx(tx, attempt.directiveId, attempt.directiveRevision);
  if (claimDirective !== null && claimDirective.verificationPolicy?.verificationPurpose === "conflict_resolution") {
    const conflict = getVerificationConflictInTx(tx, claimDirective.verificationPolicy.verificationConflictId ?? "");
    if (conflict !== null) {
      const sourceSessions = new Set<string>();
      for (const claim of conflict.claims) {
        for (const reportId of claim.sourceReportIds) {
          const sourceAttemptId = tx
            .prepare("SELECT attempt_id AS id FROM execution_reports WHERE report_id = ?")
            .get(reportId) as { id: string | null } | undefined;
          if (sourceAttemptId?.id === null || sourceAttemptId?.id === undefined) continue;
          const sourceInvocation = getWorkerInvocationInTx(tx, sourceAttemptId.id);
          if (sourceInvocation?.workerSessionId !== null && sourceInvocation?.workerSessionId !== undefined) {
            sourceSessions.add(sourceInvocation.workerSessionId);
          }
        }
      }
      if (sourceSessions.has(input.workerSessionId)) {
        throw workerRuntimeError(
          "WORKER_SESSION_MISMATCH",
          `conflict resolver for '${conflict.conflictId}' must use a fresh worker session distinct from all source-report sessions (E8 §33)`,
          { conflictId: conflict.conflictId, workerSessionId: input.workerSessionId },
        );
      }
    }
  }
  claimInTx(
    tx,
    {
      attemptId: input.attemptId,
      launchToken: input.launchToken,
      workerSessionId: input.workerSessionId,
      workerAgentId: input.workerAgentId,
      executionRunId: prepared.executionRunId,
      workspaceId: input.workspaceId,
    },
    now,
  );
  return requireWorkerAuthorityInTx(tx, {
    workerSessionId: input.workerSessionId,
    workspaceId: input.workspaceId,
    attemptId: input.attemptId,
  });
}

export interface ResolvedPlanArtifact {
  ref: DirectivePlanRef;
  content: unknown;
}

/**
 * E5 §13 — resolve EXACTLY the Directive's planRefs to their approved
 * revisions. No "latest", no closure expansion, no convenience extras. An
 * unresolvable referenced artifact fails the assignment closed (E5-T10) —
 * issuance should have caught it, but context construction stays defensive.
 */
export function resolveDirectivePlanContext(
  store: PlanStore,
  sourcePlanningRunId: string,
  planRefs: DirectivePlanRef[],
): ResolvedPlanArtifact[] {
  return planRefs.map((ref) => {
    if (isMemoryArtifactKind(ref.kind)) {
      const memoryRef: MemoryRef = { runId: sourcePlanningRunId, kind: ref.kind, id: ref.id, revision: ref.revision };
      const view = readMemoryRevisionRecord(store, memoryRef);
      if (view === null) {
        throw workerRuntimeError(
          "DIRECTIVE_NOT_CURRENT",
          `referenced approved plan artifact ${ref.kind} '${ref.id}'@${ref.revision} cannot be resolved`,
          { kind: ref.kind, id: ref.id, revision: ref.revision },
        );
      }
      return {
        ref,
        content: {
          content: view.content,
          compactProjection: view.compactProjection,
          ...(view.contractJson === null ? {} : { contract: JSON.parse(view.contractJson) }),
        },
      };
    }
    if (ref.kind === "evidence") {
      const evidence = getEvidenceRevisionRecord(store, sourcePlanningRunId, ref.id, ref.revision);
      if (evidence === null) {
        throw workerRuntimeError(
          "DIRECTIVE_NOT_CURRENT",
          `referenced approved evidence '${ref.id}'@${ref.revision} cannot be resolved`,
          { id: ref.id, revision: ref.revision },
        );
      }
      return { ref, content: evidence };
    }
    throw workerRuntimeError(
      "DIRECTIVE_NOT_CURRENT",
      `plan ref kind '${ref.kind}' has no exact approved-revision resolver`,
      { kind: ref.kind },
    );
  });
}

export interface WorkerAssignment {
  workerRole: "executor" | "verifier";
  attempt: { attemptId: string; state: string };
  /** E8 §6 — the directive's protocol version and verification policy. */
  verificationPolicy: ExecutionDirective["verificationPolicy"];
  /**
   * E8 §32 — for a conflict resolver: the NEUTRAL structured conflict context
   * (fact + claim variants + revision). Deliberately EXCLUDES source worker
   * session ids, roles, raw reports, and hidden reasoning.
   */
  conflictContext: BlindedConflictContext | null;
  directive: {
    directiveId: string;
    revision: number;
    hash: string;
    kind: string;
    objective: string;
    baseCandidateRevision: number;
    acceptedBase: ExecutionDirective["acceptedBase"];
    expectedExecutionScope: ExecutionDirective["expectedExecutionScope"];
    capabilityEnvelope: ExecutionDirective["capabilityEnvelope"];
    invariants: ExecutionDirective["invariants"];
    requiredActions: ExecutionDirective["requiredActions"];
    forbiddenActions: ExecutionDirective["forbiddenActions"];
    validationRequirements: ExecutionDirective["validationRequirements"];
    deliverables: ExecutionDirective["deliverables"];
    stopConditions: ExecutionDirective["stopConditions"];
    reportContract: ExecutionDirective["reportContract"];
    body: string;
  };
  /** EXACTLY the resolved Directive.planRefs (E5 §12/§13) — nothing else. */
  planContext: ResolvedPlanArtifact[];
  execution: {
    executionRunId: string;
    workspaceId: string;
    /** E10 §57 — the explicit execution scope; a final-closure assignment omits the Stage. */
    scopeKind: "stage" | "final_closure";
    stageId: string | null;
    windowId: string;
    baseCandidateRevision: number;
  };
}

/**
 * E5 §12 — the exact assignment package (read-only). Deliberately EXCLUDED:
 * full Plan Memory, raw Supervisor reasoning, main-session conversation,
 * unreferenced planning artifacts, and — for verifiers — any previous
 * Executor report or conversation (E5 §14/§32). Verifier independence is
 * structural: the package is derived from the VerificationDirective alone.
 */
export function loadWorkerAssignment(
  store: PlanStore,
  input: { workerSessionId: string; workspaceId: string },
): WorkerAssignment {
  const facts = store.withRead((tx) =>
    requireWorkerAuthorityInTx(tx, { workerSessionId: input.workerSessionId, workspaceId: input.workspaceId }),
  );
  const run = store.withRead((tx) => getExecutionRunInTx(tx, facts.invocation.executionRunId));
  if (run === null) {
    throw workerRuntimeError("WORKER_AUTHORITY_REQUIRED", `the run '${facts.invocation.executionRunId}' is missing`, {
      executionRunId: facts.invocation.executionRunId,
    });
  }
  // Memory artifacts are PlanningRun-scoped normative objects (A1 §34): the
  // directive's source-planning provenance is the lookup identity here.
  const planContext = resolveDirectivePlanContext(store, facts.directive.runId, facts.directive.planRefs);
  const directive = facts.directive;
  // E8 §32 — the resolver sees the neutral conflict context only; source
  // Report refs stay internal provenance in the Store.
  const conflictContext =
    directive.verificationPolicy?.verificationPurpose === "conflict_resolution"
      ? (() => {
          const conflictId = directive.verificationPolicy?.verificationConflictId ?? "";
          const conflict = store.withRead((tx) => getVerificationConflictInTx(tx, conflictId));
          return conflict === null ? null : blindedConflictContext(conflict);
        })()
      : null;
  return {
    workerRole: facts.attempt.workerRole,
    attempt: { attemptId: facts.attempt.attemptId, state: facts.attempt.state },
    verificationPolicy: directive.verificationPolicy,
    conflictContext,
    directive: {
      directiveId: directive.directiveId,
      revision: directive.revision,
      hash: directive.hash,
      kind: directive.kind,
      objective: directive.objective,
      baseCandidateRevision: directive.baseCandidateRevision,
      acceptedBase: directive.acceptedBase,
      expectedExecutionScope: directive.expectedExecutionScope,
      capabilityEnvelope: directive.capabilityEnvelope,
      invariants: directive.invariants,
      requiredActions: directive.requiredActions,
      forbiddenActions: directive.forbiddenActions,
      validationRequirements: directive.validationRequirements,
      deliverables: directive.deliverables,
      stopConditions: directive.stopConditions,
      reportContract: directive.reportContract,
      body: directive.body,
    },
    planContext,
    execution: {
      executionRunId: run.executionRunId,
      workspaceId: run.workspaceId,
      scopeKind: directive.scopeKind,
      stageId: directive.stageId,
      windowId: directive.windowId,
      baseCandidateRevision: directive.baseCandidateRevision,
    },
  };
}

export interface WorkerReportSubmission extends SubmissionResult {
  invocation: WorkerInvocationBinding;
}

/**
 * E5 §17/§35/§39 — the claimed worker's single report submission: the E4
 * protocol authority persists the Report, moves the Attempt to reported,
 * advances the candidate when factually mutated, and finishes the invocation
 * binding — all in the caller's ONE transaction. Identity is derived from the
 * claimed binding (never model-supplied); redundant ids are not accepted as
 * input at all.
 */
export function submitWorkerReportAndFinishInTx(
  tx: StoreTx,
  input: { workerSessionId: string; workspaceId: string; clock: StoreClock; now: string } & Omit<SubmitExecutionReportInput, "attemptId">,
): WorkerReportSubmission {
  const { clock, now, ...payload } = input;
  const { invocation } = requireWorkerAuthorityInTx(tx, {
    workerSessionId: payload.workerSessionId,
    workspaceId: payload.workspaceId,
  });
  const submission = submitExecutionReportInTx(
    tx,
    { ...payload, attemptId: invocation.attemptId },
    clock,
    now,
  );
  const finished = finishWorkerInvocationInTx(
    tx,
    { attemptId: invocation.attemptId, workerSessionId: payload.workerSessionId },
    now,
  );
  return { ...submission, invocation: finished };
}

export interface WorkerAttemptLaunch {
  attempt: ExecutionAttempt;
  launch: PreparedWorkerLaunch;
}

/**
 * E5 §36 — the explicit runtime-reconciliation path for an AUTHORITATIVE
 * worker stop: the claimed invocation + a still-running attempt with no
 * durable report converge deterministically to Attempt=indeterminate +
 * invocation=finished. No report, no replay, no rollback. When the host
 * cannot prove termination (E5 §37), this is NEVER called: the attempt
 * simply stays running and the recovery projection shows "runtime
 * resolution pending".
 */
export function resolveUnreportedWorkerExitInTx(
  tx: StoreTx,
  input: { attemptId: string },
  now: string,
): { attempt: ExecutionAttempt; invocation: WorkerInvocationBinding } {
  // A durable report means the worker exited NORMALLY — reconciliation never
  // downgrades a reported attempt to indeterminate, whatever its state.
  const report = getReportForAttemptInTx(tx, input.attemptId);
  if (report !== null) {
    throw workerRuntimeError(
      "ATTEMPT_ALREADY_REPORTED",
      `attempt '${input.attemptId}' already has a durable report; a reported worker exit is normal completion`,
      { attemptId: input.attemptId },
    );
  }
  const attempt = getExecutionAttemptInTx(tx, input.attemptId);
  if (attempt === null || attempt.state !== "running") {
    throw workerRuntimeError(
      "ATTEMPT_NOT_RUNNING",
      `attempt '${input.attemptId}' is ${attempt?.state ?? "missing"}; nothing to resolve`,
      { attemptId: input.attemptId },
    );
  }
  const binding = getWorkerInvocationInTx(tx, input.attemptId);
  if (binding === null || binding.state !== "claimed") {
    throw workerRuntimeError(
      "WORKER_LAUNCH_INVALID",
      `attempt '${input.attemptId}' has no claimed invocation; only a claimed worker exit can resolve this way`,
      { attemptId: input.attemptId },
    );
  }
  const indeterminate = markAttemptIndeterminateInTx(tx, input.attemptId, now);
  const finished = finishWorkerInvocationInTx(
    tx,
    { attemptId: input.attemptId, workerSessionId: binding.workerSessionId as string },
    now,
  );
  return { attempt: indeterminate, invocation: finished };
}

/**
 * The supervisor-facing launch (E5 §9/§42): start the exact Attempt under the
 * caller's already-verified Supervisor authority, then prepare the one-time
 * worker launch package. One transaction — a started attempt is always
 * launchable or the whole step rolls back.
 */
export function startWorkerAttemptAndPrepareLaunchInTx(
  tx: StoreTx,
  input: StartExecutionAttemptInput,
  clock: StoreClock,
  now: string,
): WorkerAttemptLaunch {
  const { attempt } = startExecutionAttemptInTx(tx, input, clock, now);
  const launch = prepareWorkerLaunchInTx(tx, { attemptId: attempt.attemptId }, clock.nowIso());
  return { attempt, launch };
}
