/**
 * SupervisorBinding application service (v0.2.0 architecture spec §43,
 * E2 §4–§21).
 *
 * Authority model (E2 §21): the Claude adapter/session expresses lifecycle
 * intent (SessionEnd detach, resume reattach); Application/Core validates
 * authority (workspace, session identity, generation); the Store persists the
 * canonical transition. There is deliberately NO model-facing operation
 * equivalent to set_supervisor_session / set_binding_generation / force_attach
 * — generation belongs to Core.
 *
 * The service also loads the canonical facts for the deterministic Execution
 * Recovery Context projection (E2 §17): the projection is rendered from Store
 * truth every time and is never written back (E2 §17/§14 — capsule is a
 * reasoning aid, the Store wins).
 */

import type { SupervisorBinding } from "../core/supervisor-binding.js";
import type { ExecutionRun } from "../core/execution-run.js";
import type { ExecutionProtocolProjection, AcceptedStateProjection, ProgressionProjection, VerificationPolicyProjection, AttemptRecoveryProjection } from "../context/execution-recovery.js";
import { loadVerificationPolicyStateInTx } from "./verification-policy-service.js";
import { getExecutionAbortRecordInTx } from "../store/execution-aborts.js";
import { listBlockingConflictsInTx } from "./verification-conflict-service.js";
import { RuntimeError } from "../runtime/errors.js";
import { getExecutionRunInTx } from "../store/execution-runs.js";
import { getExecutionCommitInTx, getAcceptedHeadCommitIdInTx, getCompletionCommitIdInTx, listRunCommitsInTx } from "../store/execution-commits.js";
import { listRunAssessmentsInTx } from "../store/supervisor-assessments.js";
import { getExecutionStructureInTx } from "./execution-structure-service.js";
import { deriveProgressionState } from "./execution-progression-service.js";
import { listRunDirectivesInTx } from "../store/execution-directives.js";
import { getAttemptForDirectiveInTx, getRunningAttemptInTx, listRunAttemptsInTx } from "../store/execution-attempts.js";
import { getReportForAttemptInTx } from "../store/execution-reports.js";
import { classifyAttemptRecoveryInTx, listUnresolvedIndeterminateInTx } from "./attempt-recovery-service.js";
import { getWorkerInvocationInTx } from "../store/worker-invocations.js";
import {
  detachSupervisorBindingInTx,
  findAttachedSupervisorBindingForSessionInTx,
  getSupervisorBindingInTx,
  listSupervisorBindingEventsInTx,
  reattachSupervisorBindingInTx,
  requireCurrentSupervisorAuthorityInTx,
} from "../store/supervisor-bindings.js";
import type { StoreClock } from "../store/migration-runner.js";
import type { PlanStore } from "../store/sqlite-store.js";
import type { StoreTx } from "../store/transaction.js";

export interface SupervisorAuthorityInput {
  executionRunId: string;
  workspaceId: string;
  /** The signed HostContext session — never model-supplied authority. */
  sessionId: string;
  /** The caller's known supervision fencing generation. */
  generation: number;
}

export function createSupervisorBindingService(store: PlanStore, clock: StoreClock) {
  return {
    /**
     * Same-session reattach (E2 §7/§13/§18): exact session + workspace,
     * generation unchanged. Different sessions fail closed (STALE) — resume
     * is never silently converted into takeover.
     */
    reattachSupervisor(input: {
      executionRunId: string;
      workspaceId: string;
      sessionId: string;
    }): SupervisorBinding {
      return store.withWrite((tx) =>
        reattachSupervisorBindingInTx(
          tx,
          { executionRunId: input.executionRunId, workspaceId: input.workspaceId, sessionId: input.sessionId },
          clock.nowIso(),
        ),
      );
    },

    /**
     * Best-effort detach for SessionEnd (E2 §8/§12-T12): state → detached,
     * generation unchanged, ExecutionRun untouched. Idempotent; correctness
     * never depends on it firing.
     */
    detachSupervisor(input: { executionRunId: string; sessionId: string }): SupervisorBinding | null {
      return store.withWrite((tx) =>
        detachSupervisorBindingInTx(tx, { executionRunId: input.executionRunId, sessionId: input.sessionId }, clock.nowIso()),
      );
    },

    /**
     * The authoritative writable-supervision check (E2 §20) — standalone read
     * form for surfaces that do not already hold a transaction; in-transaction
     * callers use requireCurrentSupervisorAuthorityInTx directly.
     */
    requireSupervisorAuthority(input: SupervisorAuthorityInput): { binding: SupervisorBinding } {
      return store.withRead((tx) => requireCurrentSupervisorAuthorityInTx(tx, input));
    },

    /**
     * Ownership view for projections (get_state / recovery capsule): how the
     * given session relates to the binding, without leaking other sessions'
     * identities beyond ownership class.
     */
    supervisorOwnershipViewInTx(
      tx: StoreTx,
      input: { executionRunId: string; sessionId: string },
    ): {
      binding: { state: SupervisorBinding["state"]; generation: number } | null;
      ownership: "current-session" | "other-session" | "none";
    } {
      const binding = getSupervisorBindingInTx(tx, input.executionRunId);
      if (binding === null) {
        return { binding: null, ownership: "none" };
      }
      return {
        binding: { state: binding.state, generation: binding.generation },
        ownership: binding.sessionId === input.sessionId ? "current-session" : "other-session",
      };
    },

    /**
     * Canonical facts for the Execution Recovery Context (E2 §17, E3 §24).
     * Loaded from the Store inside one read transaction; the renderer is
     * pure. Structure is included when it exists — never bootstrapped here
     * (loading is read-only; bootstrap is a separate authoritative operation).
     */
    loadExecutionRecoveryFactsInTx(
      tx: StoreTx,
      input: { executionRunId: string; sessionId: string },
    ): {
      executionRun: ExecutionRun;
      binding: { state: SupervisorBinding["state"]; generation: number } | null;
      ownership: "current-session" | "other-session" | "none";
      events: Array<{ eventType: string; createdAt: string }>;
      structure: {
        stages: Array<{ id: string; ordinal: number; status: string; objective: string; sourceStepId: string | null }>;
        activeStage: { id: string; ordinal: number; objective: string } | null;
        openWindow: { id: string; scopeKind: "stage" | "final_closure"; candidateRevision: number } | null;
      } | null;
      /** E4 §38 — compact protocol projection; null when no Directive was issued. */
      protocol: ExecutionProtocolProjection | null;
      /** E6 §53 — canonical accepted-progress projection. */
      acceptedState: AcceptedStateProjection;
      /** E7 §26/§27 — canonical progression boundary; null when not materialized. */
      progression: ProgressionProjection | null;
      /** E8 §44 — compact derived verification policy/conflict state. */
      verificationPolicy: VerificationPolicyProjection | null;
      /** E11 §45 — compact per-Attempt recovery projection. */
      attemptRecovery: AttemptRecoveryProjection | null;
      /**
       * E13 §53 — the durable abort provenance when the run is aborted (the
       * human-authorized control fact). Null for every other lifecycle.
       */
      abort: {
        reason: string;
        requestedBySessionId: string;
        controlId: string;
        createdAt: string;
      } | null;
    } {
      const executionRun = getExecutionRunInTx(tx, input.executionRunId);
      if (executionRun === null) {
        throw new RuntimeError("SUPERVISOR_BINDING_REQUIRED", `no ExecutionRun exists for '${input.executionRunId}'`);
      }
      const binding = getSupervisorBindingInTx(tx, input.executionRunId);
      const events = listSupervisorBindingEventsInTx(tx, input.executionRunId).map((event) => ({
        eventType: event.eventType,
        createdAt: event.createdAt,
      }));
      const structureRows = getExecutionStructureInTx(tx, input.executionRunId);
      // E6 §53 — canonical accepted-progress facts (head, latest assessment,
      // latest commit). Compact projection only; the Store keeps the history.
      const headCommitId = getAcceptedHeadCommitIdInTx(tx, input.executionRunId);
      const headCommit = headCommitId === null ? null : getExecutionCommitInTx(tx, headCommitId);
      const latestAssessment = listRunAssessmentsInTx(tx, input.executionRunId)[0] ?? null;
      const latestCommit = listRunCommitsInTx(tx, input.executionRunId).at(-1) ?? null;
      // E7 §26/§27 — the passive progression boundary (derived, never acted
      // on by recovery).
      // E9 — the progression boundary is an ACTIVE-run concept: a terminal
      // run (replan_required) legitimately holds an active Stage with no open
      // Window and possibly no head (E9 §20 — Stage state is not fabricated),
      // which the active-run classifier would read as corruption.
      const progression =
        structureRows.stages.length === 0 || executionRun.lifecycle !== "active"
          ? null
          : deriveProgressionState(structureRows.stages, structureRows.openWindow, headCommitId);
      // E8 §44 — derived verification pressure + the one blocking conflict.
      const policyState = loadVerificationPolicyStateInTx(tx, input.executionRunId);
      const blockingConflicts = listBlockingConflictsInTx(tx, input.executionRunId);
      const verificationPolicy: VerificationPolicyProjection | null =
        policyState === null
          ? null
          : {
              required: policyState.verificationRequired,
              reason: policyState.reason,
              span: policyState.unverifiedMutationSpan,
              maxUnverifiedMutations: policyState.maxUnverifiedMutations,
              latestVerifiedRevision: policyState.latestVerifiedRevision,
              conflict:
                blockingConflicts.length === 0
                  ? null
                  : {
                      conflictId: blockingConflicts[0]!.conflictId,
                      status: blockingConflicts[0]!.status,
                      candidateRevision: blockingConflicts[0]!.candidateRevision,
                    },
            };
      // E11 §45 — the compact per-Attempt recovery projection (running or
      // indeterminate Attempts only; reported work needs no attention).
      const attemptRecovery: AttemptRecoveryProjection = {
        attempts: listRunAttemptsInTx(tx, input.executionRunId)
          .filter((attempt) => attempt.state !== "reported")
          .map((attempt) => classifyAttemptRecoveryInTx(tx, attempt))
          .map((fact) => ({
            attemptId: fact.attemptId,
            directiveId: fact.directiveId,
            directiveRevision: fact.directiveRevision,
            workerRole: fact.workerRole,
            logicalState: fact.logicalState,
            runtimeState: fact.runtimeState,
            reconciliation: fact.reconciliation,
            unclaimedRetryAvailable: fact.unclaimedRetryAvailable,
          })),
        unresolvedIndeterminateAttemptIds: listUnresolvedIndeterminateInTx(tx, input.executionRunId).map(
          (attempt) => attempt.attemptId,
        ),
        executionFenced:
          structureRows.openWindow !== null
          && listUnresolvedIndeterminateInTx(tx, input.executionRunId, {
            windowId: structureRows.openWindow.id,
          }).length > 0,
      };
      return {
        executionRun,
        binding: binding === null ? null : { state: binding.state, generation: binding.generation },
        ownership:
          binding === null
            ? "none"
            : binding.sessionId === input.sessionId
              ? "current-session"
              : "other-session",
        events,
      structure:
        structureRows.stages.length === 0
          ? null
          : {
              stages: structureRows.stages.map((stage) => ({
                id: stage.id,
                ordinal: stage.ordinal,
                status: stage.status,
                objective: stage.objective,
                sourceStepId: stage.sourceStepId,
              })),
              activeStage:
                structureRows.activeStage === null
                  ? null
                  : {
                      id: structureRows.activeStage.id,
                      ordinal: structureRows.activeStage.ordinal,
                      objective: structureRows.activeStage.objective,
                    },
              openWindow:
                structureRows.openWindow === null
                  ? null
                  : {
                      id: structureRows.openWindow.id,
                      scopeKind: structureRows.openWindow.scopeKind,
                      candidateRevision: structureRows.openWindow.candidateRevision,
                    },
              },
        protocol: loadExecutionProtocolProjectionInTx(tx, input.executionRunId),
        acceptedState: {
          acceptedHead:
            headCommit === null
              ? null
              : { commitId: headCommit.commitId, sequence: headCommit.sequence },
          completionCommitId: getCompletionCommitIdInTx(tx, input.executionRunId),
          latestAssessment:
            latestAssessment === null
              ? null
              : {
                  assessmentId: latestAssessment.assessmentId,
                  candidateRevision: latestAssessment.candidateRevision,
                  disposition: latestAssessment.disposition,
                },
          latestCommit:
            latestCommit === null
              ? null
              : {
                  commitId: latestCommit.commitId,
                  sequence: latestCommit.sequence,
                  parentCommitId: latestCommit.parentCommitId,
                  stageId: latestCommit.stageId,
                  windowId: latestCommit.windowId,
                  candidateRevision: latestCommit.candidateRevision,
                },
        },
        progression,
        verificationPolicy,
        attemptRecovery,
        // E13 §53 — the durable abort provenance (audit ONLY; never accepted
        // progress, never a reason to guess the workspace state).
        abort:
          executionRun.lifecycle === "aborted"
            ? (() => {
                const record = getExecutionAbortRecordInTx(tx, input.executionRunId);
                return record === null
                  ? null
                  : {
                      reason: record.reason,
                      requestedBySessionId: record.requestedBySessionId,
                      controlId: record.controlId,
                      createdAt: record.createdAt,
                    };
              })()
            : null,
      };
    },
  };
}

/** Attached-supervision lookup used by hook-layer recovery (read-side). */
export function findAttachedSupervisorBindingForSession(
  store: PlanStore,
  sessionId: string,
): SupervisorBinding | null {
  return store.withRead((tx) => findAttachedSupervisorBindingForSessionInTx(tx, sessionId));
}

/**
 * E4 §38 — compact Directive/Attempt/Report projection from canonical Store
 * truth, inside the caller's read transaction. The latest Directive (newest
 * issued), the relevant Attempt (the run's single running Attempt, else the
 * latest Directive's attempt), and that Attempt's Report summary. Never full
 * bodies or histories — the Store remains authority.
 */
export function loadExecutionProtocolProjectionInTx(
  tx: StoreTx,
  executionRunId: string,
): ExecutionProtocolProjection | null {
  const directives = listRunDirectivesInTx(tx, executionRunId);
  if (directives.length === 0) {
    return null;
  }
  const latest = directives[0]!;
  const running = getRunningAttemptInTx(tx, executionRunId);
  const attempt = running ?? getAttemptForDirectiveInTx(tx, latest.directiveId, latest.revision);
  if (attempt === null) {
    return {
      latestDirective: {
        directiveId: latest.directiveId,
        revision: latest.revision,
        hash: latest.hash,
        kind: latest.kind,
        baseCandidateRevision: latest.baseCandidateRevision,
      },
      attempt: null,
      latestReport: null,
    };
  }
  const report = getReportForAttemptInTx(tx, attempt.attemptId);
  // E5 §49 — host-runtime correlation state only; never launch-token secrets
  // or worker conversation. A running attempt with NO binding renders as
  // legacy-unbound (pre-E5) or not-yet-launched — no identity is fabricated.
  const invocation = getWorkerInvocationInTx(tx, attempt.attemptId);
  const workerRuntime =
    invocation === null
      ? "unbound (legacy or not yet launched)"
      : invocation.state === "prepared"
        ? "unclaimed"
        : invocation.state;
  return {
    latestDirective: {
      directiveId: latest.directiveId,
      revision: latest.revision,
      hash: latest.hash,
      kind: latest.kind,
      baseCandidateRevision: latest.baseCandidateRevision,
    },
    attempt: { attemptId: attempt.attemptId, workerRole: attempt.workerRole, state: attempt.state, workerRuntime },
    latestReport:
      report === null
        ? null
        : {
            result: report.result,
            candidateMutated: report.candidateMutated,
            blockerCount: report.blockers.length,
            blockerKinds: report.blockers.map((blocker) => blocker.kind),
          },
  };
}
