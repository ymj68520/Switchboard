/**
 * Execution Recovery Context renderer (v0.2.0 architecture spec §46,
 * E2 §17, E4 §38).
 *
 * PURE projection: a deterministic, compact recovery capsule for an active
 * ExecutionRun, rendered from canonical Store facts that the caller loaded in
 * one read transaction. Like every Markdown projection it is NEVER canonical
 * authority, never written back into the Store, and never parsed back — when
 * a capsule conflicts with stored objects, the Store wins (spec §46).
 *
 * E2 scope: binding ownership only. E3 extended it with the canonical
 * Stage/Window state. E4 extends it further with compact Directive/Attempt/
 * Report protocol state (E4 §38): the latest Directive revision (id@revision,
 * kind, hash, baseCandidateRevision), the relevant Attempt, and the latest
 * Report summary — NOT full directive bodies or report histories.
 *
 * A running Attempt is rendered as durable protocol state with runtime
 * resolution pending (E4 §39): SessionStart never marks it indeterminate,
 * retries it, or creates a second Attempt — E5's Worker runtime owns liveness.
 */

import type { ExecutionRun } from "../core/execution-run.js";
import type { SupervisorBinding } from "../core/supervisor-binding.js";
import type {
  ExecutionSessionRelation,
  ExecutionSessionStartOutcome,
} from "../application/execution-session-recovery.js";

export type SupervisorOwnership = "current-session" | "other-session" | "none";

export interface ExecutionStructureProjection {
  stages: Array<{ id: string; ordinal: number; status: string; objective: string; sourceStepId: string | null }>;
  activeStage: { id: string; ordinal: number; objective: string } | null;
  /** E10 — the open window's scope: a stage window or the final-closure window. */
  openWindow: { id: string; scopeKind: "stage" | "final_closure"; candidateRevision: number } | null;
}

/**
 * E4 §38 / E5 §49 — compact protocol projection; bodies/histories and launch
 * secrets are never injected. `workerRuntime` is the host-runtime correlation
 * state of the attempt's invocation binding: "unbound" (no binding — pre-E5
 * legacy or not yet launched), "unclaimed", "claimed", or "finished".
 */
export interface ExecutionProtocolProjection {
  latestDirective: {
    directiveId: string;
    revision: number;
    hash: string;
    kind: string;
    baseCandidateRevision: number;
  } | null;
  attempt: { attemptId: string; workerRole: string; state: string; workerRuntime: string | null } | null;
  latestReport: {
    result: string;
    candidateMutated: boolean;
    blockerCount: number;
    blockerKinds: string[];
  } | null;
}

/**
 * E6 §53 — the accepted-progress projection: the exact current acceptedHead
 * (or the execution-start baseline before the first commit), the latest
 * SupervisorAssessment, and the latest ExecutionCommit. Historical commit
 * contents are NOT injected by default — the Store remains authoritative and
 * queryable.
 */
export interface AcceptedStateProjection {
  acceptedHead: { commitId: string; sequence: number } | null;
  latestAssessment: {
    assessmentId: string;
    candidateRevision: number;
    disposition: string;
  } | null;
  latestCommit: {
    commitId: string;
    sequence: number;
    parentCommitId: string | null;
    /** E10 — null for the final-closure ExecutionCommit (scope final_closure). */
    stageId: string | null;
    windowId: string;
    candidateRevision: number;
  } | null;
  /**
   * E10 §43 — present exactly when the run is completed: the same Commit as
   * acceptedHead (completion_commit_id provenance).
   */
  completionCommitId?: string | null;
}

/**
 * E7 §26/§27 — the progression projection: the exact §19 boundary the run sits
 * at and the eligible pending Stages (explicit dependsOn derivation). Recovery
 * is PASSIVE: it names the boundary and the eligible Stages but never opens a
 * window, never activates a Stage, and never decides continuation (E7 §21/§26).
 */
export interface ProgressionProjection {
  boundary: "active_candidate" | "post_commit_same_stage" | "between_stages" | "all_stages_completed";
  eligibleStageIds: string[];
}

/**
 * E11 §45 — compact per-Attempt recovery projection for every nonterminal
 * Attempt needing attention. Reconstructed solely from the Store: logical
 * state, runtime state, and the reconciliation state. No launch secrets, no
 * hidden Worker context (E11 §45/§47).
 */
export interface AttemptRecoveryProjection {
  attempts: Array<{
    attemptId: string;
    directiveId: string;
    directiveRevision: number;
    workerRole: string;
    logicalState: "running" | "indeterminate";
    runtimeState: "prepared-unclaimed" | "claimed" | "reported-but-runtime-not-finished" | "authoritative-stop" | "liveness-unknown";
    reconciliation: "not-required" | "required" | "in-progress" | "resolved-no-effect" | "resolved-no-effect-by-capability" | "resolved-candidate-changed";
    unclaimedRetryAvailable: boolean;
  }>;
  unresolvedIndeterminateAttemptIds: string[];
  executionFenced: boolean;
}

/**
 * E8 §44 — compact DERIVED verification state: the pressure projection and at
 * most the one blocking conflict summary. Never full conflict history, never
 * worker identities; the Store stays authoritative.
 */
export interface VerificationPolicyProjection {
  required: boolean;
  reason: string | null;
  span: number;
  maxUnverifiedMutations: number;
  latestVerifiedRevision: number;
  conflict: { conflictId: string; status: string; candidateRevision: number } | null;
}

export interface ExecutionRecoveryFacts {
  executionRun: ExecutionRun;
  binding: { state: SupervisorBinding["state"]; generation: number } | null;
  ownership: SupervisorOwnership;
  /** E3 §24 — canonical Stage/Window state; null when not yet materialized. */
  structure: ExecutionStructureProjection | null;
  /** E4 §38 — canonical Directive/Attempt/Report state; null when none issued. */
  protocol?: ExecutionProtocolProjection | null;
  /** E6 §53 — canonical accepted-progress state. */
  acceptedState?: AcceptedStateProjection;
  /** E7 §26/§27 — canonical progression boundary; null when not materialized. */
  progression?: ProgressionProjection | null;
  /** E8 §44 — compact derived verification-policy/conflict state. */
  verificationPolicy?: VerificationPolicyProjection | null;
  /** E11 §45 — compact per-Attempt recovery projection. */
  attemptRecovery?: AttemptRecoveryProjection | null;
  /**
   * E13 §53 — the durable abort provenance when the run is aborted (the
   * human-authorized control fact). Present ONLY for aborted runs; audit
   * provenance, never accepted progress.
   */
  abort?: {
    reason: string;
    requestedBySessionId: string;
    controlId: string;
    createdAt: string;
  } | null;
  /**
   * E12 §50/§53 — the SessionStart classification annotation (relation +
   * outcome). Present ONLY on the SessionStart recovery surface; the
   * annotation is rendering provenance, never authority (E12 §4/§54).
   */
  sessionStart?: {
    outcome: ExecutionSessionStartOutcome;
    relation: ExecutionSessionRelation;
    ambiguousRunIds?: string[];
  } | null;
}

/**
 * Render the deterministic Execution Recovery Context. Same canonical Store
 * state always renders an equivalent capsule (E2-T13); nothing here can mutate
 * canonical state (E2-T14 — the function is pure and its output is text).
 */
export function renderExecutionRecoveryContext(facts: ExecutionRecoveryFacts): string {
  const run = facts.executionRun;
  const lines: string[] = [];
  lines.push("Execution Recovery Context");
  lines.push("");
  // A1 §52 — both identities render unambiguously.
  lines.push(`PlanningRun source: ${run.runId}`);
  lines.push(`FinalPlan: ${run.finalPlan.id} (${run.finalPlan.hash})`);
  lines.push(`ExecutionRun: ${run.executionRunId}`);
  lines.push(`Lifecycle: ${run.lifecycle}`);
  lines.push(
    run.executionStartBaseline.kind === "git"
      ? `Execution-start baseline: git @ ${run.executionStartBaseline.revision}`
      : "Execution-start baseline: directory workspace (no revision)",
  );
  lines.push(`Planning baseline: commit ${run.planningBaseline.finalPlanCommitId}, snapshot ${run.planningBaseline.headSnapshotId}`);
  // E9 §28 — the terminal replan boundary renders passively: the old run is
  // terminal, the issue is the exact snapshot, and the next action is formal
  // planning entry. Recovery never creates the successor.
  if (run.lifecycle === "replan_required") {
    lines.push(
      "ExecutionRun is TERMINAL (replan_required): it can never resume. Invoke /phase-plan — a NEW PlanningRun is created from the old immutable FinalPlan baseline. Ordinary Build mutation stays paused (E9 §29).",
    );
  }
  // E10 §50 — the completed run renders its terminal provenance passively and
  // performs zero mutations: completion_commit_id == acceptedHead.
  if (run.lifecycle === "completed") {
    const finalCommit = facts.acceptedState?.completionCommitId ?? facts.acceptedState?.acceptedHead?.commitId ?? null;
    lines.push(
      `ExecutionRun is COMPLETE (completed): execution protocol complete. Final ExecutionCommit: ${finalCommit ?? "unknown"}. The run can never resume; a later reexecution of the same FinalPlan is a separate explicit decision.`,
    );
  }
  // E13 §53 — the aborted run renders its durable human-authorization
  // provenance passively and performs zero mutations. The workspace
  // divergence is stated EXPLICITLY (E13 §29/§53): the workspace may contain
  // unaccepted changes; no rollback was performed; the accepted head remains
  // the last authoritative accepted state.
  if (run.lifecycle === "aborted") {
    const head = facts.acceptedState?.acceptedHead ?? null;
    lines.push(
      "ExecutionRun is TERMINAL (aborted): a human-authorized abort stopped the execution protocol permanently. It can never resume, complete, or replan.",
    );
    if (facts.abort != null) {
      lines.push(
        `Abort provenance: reason "${facts.abort.reason}" — requested by session ${facts.abort.requestedBySessionId}, human-authorized control record ${facts.abort.controlId}, at ${facts.abort.createdAt}.`,
      );
    }
    lines.push(
      `Workspace: MAY contain unaccepted changes beyond the accepted head (${head === null ? "execution_start / none" : `EC ${head.commitId}`}); abort performs NO rollback — any cleanup is a separate explicit decision.`,
    );
  }
  lines.push("");
  lines.push("Supervisor binding:");
  if (facts.binding === null) {
    lines.push("  ownership: none (unbound; explicit takeover required for writable supervision)");
  } else {
    lines.push(`  state: ${facts.binding.state}`);
    lines.push(`  generation: ${facts.binding.generation}`);
    if (facts.ownership === "current-session") {
      lines.push("  ownership: current-session");
    } else if (facts.ownership === "other-session") {
      lines.push("  ownership: other-session (writable supervision requires explicit takeover)");
    } else {
      lines.push("  ownership: none");
    }
  }
  // E12 §53 — the session relation annotation and the deterministic ownership
  // class, rendered only on the classification-aware SessionStart surface.
  const sessionStart = facts.sessionStart ?? null;
  if (sessionStart !== null) {
    lines.push(`  session relation: ${sessionStart.relation} (host SessionStart source; annotation, never authority)`);
    if (sessionStart.outcome === "same_owner_detached_resume") {
      lines.push(
        `  ownership class: detached same-session resumable — auto-reattach happens only on an actual resume relation (observed: ${sessionStart.relation})`,
      );
    }
    // E12C amendment §4 — the /clear boundary never leaves writable authority:
    // the capsule names the converged non-owner state explicitly.
    if (sessionStart.outcome === "cleared_detached") {
      lines.push(
        "  ownership class: cleared — /clear detached this session's writable ownership at the boundary; this context is a non-owner until explicit reacquisition",
      );
    }
    // E12C amendment §9 — a fork context never inherits; the original owner is
    // untouched regardless of any session-id reuse.
    if (sessionStart.outcome === "fork_non_inheriting") {
      lines.push(
        "  ownership class: fork — a forked conversation never inherits ownership; the original owner's binding was not mutated",
      );
    }
  }
  lines.push("");
  // E3 §24 — canonical Stage/Window state from the Store; explicit
  // "not implemented" markers for later-phase subsystems, never fake values.
  lines.push("Execution structure:");
  if (facts.structure === null) {
    lines.push("  not yet materialized for this run.");
  } else {
    lines.push(`  stages: ${facts.structure.stages.length}`);
    for (const stage of facts.structure.stages) {
      lines.push(
        `    - ${stage.id} (ordinal ${stage.ordinal}, ${stage.status})${stage.sourceStepId === null ? "" : ` [plan step ${stage.sourceStepId}]`}: ${stage.objective}`,
      );
    }
    if (facts.structure.activeStage === null) {
      lines.push("  active stage: none");
    } else {
      lines.push(
        `  active stage: ${facts.structure.activeStage.id} (ordinal ${facts.structure.activeStage.ordinal})`,
      );
    }
    if (facts.structure.openWindow === null) {
      lines.push(
        facts.acceptedState !== undefined && facts.acceptedState.acceptedHead !== null
          ? "  open window: none (post-commit acceptance boundary — the Stage's continuation is a later decision, E6 §33/§34)"
          : "  open window: none",
      );
    } else if (facts.structure.openWindow.scopeKind === "final_closure") {
      // E10 §48 — the final-closure window restores AS ITSELF: never
      // downgraded to the all_stages_completed boundary, never recreated.
      lines.push(
        `  FINAL EXECUTION CLOSURE IN PROGRESS: window ${facts.structure.openWindow.id} / candidateRevision=${facts.structure.openWindow.candidateRevision} (run-level final closure; no Stage — continue the final window protocol)`,
      );
    } else {
      lines.push(
        `  open window: ${facts.structure.openWindow.id} / candidateRevision=${facts.structure.openWindow.candidateRevision}`,
      );
    }
    // E7 §26/§27 — the passive progression boundary. Rendered only for the
    // non-trivial boundaries so pre-E7 capsules stay byte-identical; recovery
    // names the state, it never acts on it (E7 §21/§26).
    const progression = facts.progression ?? null;
    if (progression !== null && progression.boundary === "post_commit_same_stage") {
      lines.push(
        "  progression boundary: post-commit same-stage — continue_execution_stage opens the next window when you decide to continue",
      );
    } else if (progression !== null && progression.boundary === "between_stages") {
      lines.push(
        `  progression boundary: between stages — eligible next stages: [${progression.eligibleStageIds.join(", ")}] — supervisor action required (activate one explicitly; no auto-activation)`,
      );
    } else if (progression !== null && progression.boundary === "all_stages_completed") {
      lines.push(
        "  progression boundary: all stages completed — explicitly begin final execution closure (begin_execution_final_closure) when ready; the boundary never auto-starts it (E10 §10)",
      );
    }
    // E8 §44 — compact derived verification pressure + the one blocking
    // conflict, if any. Passive: recovery names the state, it never resolves
    // or declares anything.
    const policy = facts.verificationPolicy ?? null;
    if (policy !== null) {
      lines.push(
        `  verification policy: ${policy.required ? `required (reason=${policy.reason})` : "not required"} — span ${policy.span}/${policy.maxUnverifiedMutations}, latest normal verified revision ${policy.latestVerifiedRevision}`,
      );
      if (policy.conflict !== null) {
        lines.push(
          `  verification conflict: ${policy.conflict.conflictId} (${policy.conflict.status}) at candidateRevision=${policy.conflict.candidateRevision}`,
        );
      } else {
        lines.push("  verification conflict: none");
      }
    }
    // E11 §45 — the compact per-Attempt recovery projection. Passive: recovery
    // names the state; the Supervisor acts explicitly through the recovery
    // operations (E11 §48 — SessionStart never replays or resolves anything).
    const recovery = facts.attemptRecovery ?? null;
    if (recovery !== null && recovery.attempts.length > 0) {
      lines.push("  attempt recovery:");
      for (const attempt of recovery.attempts) {
        lines.push(
          `    - attempt ${attempt.attemptId} (directive ${attempt.directiveId}@${attempt.directiveRevision}, ${attempt.workerRole}): `
            + `state=${attempt.logicalState}, runtime=${attempt.runtimeState}, reconciliation=${attempt.reconciliation}`
            + (attempt.unclaimedRetryAvailable ? " [unclaimed retry available]" : ""),
        );
      }
      if (recovery.executionFenced) {
        lines.push(
          `    ordinary execution is FENCED: unresolved indeterminate attempt(s) [${recovery.unresolvedIndeterminateAttemptIds.join(", ")}] — reconcile explicitly (E11 §13)`,
        );
      }
    }
  }
  lines.push("");
  // E4 §38 — compact protocol state from the Store. Never full directive
  // bodies or report histories: the projection stays a reasoning aid.
  lines.push("Execution protocol:");
  const protocol = facts.protocol ?? null;
  if (protocol === null || protocol.latestDirective === null) {
    lines.push("  latest directive: none issued");
  } else {
      const directive = protocol.latestDirective;
      lines.push(
        `  latest directive: ${directive.directiveId}@${directive.revision} (${directive.kind}, ${directive.hash}, baseCandidateRevision=${directive.baseCandidateRevision})`,
      );
      if (protocol.attempt === null) {
        lines.push("  attempt: none");
      } else {
        const terminalRun = run.lifecycle !== "active";
        lines.push(
          `  attempt: ${protocol.attempt.attemptId} (${protocol.attempt.workerRole}, ${protocol.attempt.state})${
            protocol.attempt.state === "running" && !terminalRun ? " — runtime resolution pending" : ""
          }${
            protocol.attempt.state === "running" && terminalRun
              ? " (historical — the terminal Run lifecycle overrides protocol liveness; NO authority remains, E13 §24)"
              : ""
          }`,
        );
      lines.push(`  worker runtime: ${protocol.attempt.workerRuntime ?? "none"}`);
      if (protocol.latestReport === null) {
        lines.push("  latest report: none");
      } else {
        const report = protocol.latestReport;
        const blockerSummary =
          report.blockerCount === 0 ? "" : ` [${report.blockerKinds.join(", ")}]`;
        lines.push(
          `  latest report: result=${report.result}, candidateMutated=${report.candidateMutated}, blockers=${report.blockerCount}${blockerSummary}`,
        );
      }
    }
  }
  lines.push("");
  // E6 §53 — canonical accepted-progress state. Before the first commit the
  // accepted base is the execution-start baseline (no fabricated EC-000); only
  // ExecutionCommit advances the head. A report never creates accepted
  // progress. Historical commit/assessment contents stay in the Store.
  const accepted = facts.acceptedState ?? null;
  lines.push("Execution progress:");
  if (accepted === null) {
    lines.push("  accepted head: not projected for this capsule.");
  } else if (accepted.acceptedHead === null) {
    lines.push("  accepted head: execution_start (no accepted commits yet)");
  } else {
    lines.push(`  accepted head: ${accepted.acceptedHead.commitId} (sequence ${accepted.acceptedHead.sequence})`);
  }
  if (accepted?.latestCommit === null || accepted?.latestCommit === undefined) {
    lines.push("  latest commit: none");
  } else {
    const commit = accepted.latestCommit;
    lines.push(
      `  latest commit: ${commit.commitId} (sequence ${commit.sequence}, parent ${commit.parentCommitId ?? "execution_start"}, ${commit.stageId === null ? "final_closure (no stage)" : `stage ${commit.stageId}`}, window ${commit.windowId}, candidateRevision=${commit.candidateRevision})`,
    );
  }
  if (accepted?.latestAssessment === null || accepted?.latestAssessment === undefined) {
    lines.push("  latest assessment: none");
  } else {
    const assessment = accepted.latestAssessment;
    lines.push(
      `  latest assessment: ${assessment.assessmentId} (candidateRevision=${assessment.candidateRevision}, disposition=${assessment.disposition})`,
    );
  }
  lines.push("A report never creates accepted progress; only a Core-gated ExecutionCommit does (E6 §1).");
  // E12 §53 — the deterministic next-legal-action line, derived from the same
  // canonical facts (fence/recovery first, then ownership, then lifecycle).
  if (sessionStart !== null) {
    lines.push(`Next legal action: ${nextLegalActionOf(facts, sessionStart)}`);
  }
  lines.push("This context is a projection of the Phase Plan Store; the Store is authoritative.");
  return lines.join("\n");
}

/**
 * E12 §53 — the single deterministic next action for the classified session.
 * Pure derivation from canonical facts + the SessionStart classification; a
 * projection only (the Store and the gates decide what actually succeeds).
 */
function nextLegalActionOf(
  facts: ExecutionRecoveryFacts,
  sessionStart: NonNullable<ExecutionRecoveryFacts["sessionStart"]>,
): string {
  if (sessionStart.outcome === "ambiguous_active_runs") {
    return `select the exact ExecutionRun and take over explicitly (phase_plan.takeover_run with the exact run_id; candidates: ${(sessionStart.ambiguousRunIds ?? []).join(", ")}) — no implicit selection (E12 §29)`;
  }
  // E12C amendment §9 — fork contexts never inherit; ownership moves only via
  // the explicit authorized takeover, and the original owner stays intact.
  if (sessionStart.outcome === "fork_non_inheriting") {
    return "this fork context has no writable authority and never inherits it — explicit user-authorized takeover (phase_plan.takeover_run) is the only path to ownership; the original owner is unaffected (E12C)";
  }
  if (facts.executionRun.lifecycle === "replan_required") {
    return "invoke /phase-plan — the run is terminal (replan_required); execution takeover is unavailable (E12 §27)";
  }
  if (facts.executionRun.lifecycle === "completed") {
    return "none — the run is terminal (completed); readable history only (E12 §27)";
  }
  // E13 §53/§54 — an aborted run has NO next execution action; recovery is
  // read-only history and the same FinalPlan may later start a NEW,
  // separately authorized run.
  if (facts.executionRun.lifecycle === "aborted") {
    return "none for this Run — it is terminal (aborted); recovery is read-only history. The same FinalPlan may later start a NEW, separately authorized ExecutionRun (E13 §52)";
  }
  const unresolved = facts.attemptRecovery?.unresolvedIndeterminateAttemptIds ?? [];
  if (unresolved.length > 0) {
    return `reconcile the unresolved indeterminate attempt(s) [${unresolved.join(", ")}] (issue_attempt_reconciliation / resolve_indeterminate_attempt); ordinary execution stays fenced (E11)`;
  }
  const retryable = (facts.attemptRecovery?.attempts ?? []).some(
    (attempt) => attempt.runtimeState === "prepared-unclaimed" && attempt.unclaimedRetryAvailable,
  );
  if (retryable) {
    return "retry_unclaimed_worker_launch for the prepared-unclaimed attempt (E11/E12 §37)";
  }
  const liveWorker = (facts.attemptRecovery?.attempts ?? []).some(
    (attempt) => attempt.runtimeState === "claimed" || attempt.runtimeState === "liveness-unknown",
  );
  if (liveWorker) {
    return "wait for runtime resolution — a claimed Worker's liveness is unresolved; same E11 rules apply (E12 §45)";
  }
  if (facts.ownership === "current-session" && facts.binding?.state === "attached") {
    return "continue supervision";
  }
  // E12C amendment §4/§6 — after a /clear boundary the converged detached state
  // is never automatically resumable in-context: reacquisition is the explicit
  // authorized takeover (generation +1) here, or a later genuine resume.
  if (sessionStart.outcome === "cleared_detached") {
    return "this context was created by /clear: ownership was detached at the boundary and never returns automatically — reacquire via explicit user-authorized takeover (phase_plan.takeover_run), or via a later genuine resume (SessionStart source=resume)";
  }
  if (facts.ownership === "current-session" && facts.binding?.state === "detached") {
    return sessionStart.relation === "resume"
      ? "reattached — continue supervision"
      : "supervision is detached for this exact session; resume the session or take over explicitly (phase_plan.takeover_run)";
  }
  return "explicit user-authorized takeover (phase_plan.takeover_run) — this session has no writable supervision authority (E12 §24)";
}

/**
 * The read-only notice injected for a session that faces an active ExecutionRun
 * it does not own (E2 §18: different session / unbound run). Authority is
 * never transferred by this text — writable supervision requires the explicit
 * takeover flow.
 *
 * E12 §53 — with the SessionStart classification present the notice also names
 * the host-provable session relation and the deterministic next action.
 */
export function renderExecutionRecoveryNotice(
  facts: ExecutionRecoveryFacts,
  takeoverRunId: string,
  sessionStart?: { outcome: ExecutionSessionStartOutcome; relation: ExecutionSessionRelation } | null,
): string {
  const lines: string[] = [];
  lines.push("Phase Plan execution is in progress in this workspace.");
  lines.push("");
  lines.push(`PlanningRun source: ${facts.executionRun.runId}`);
  lines.push(`ExecutionRun: ${facts.executionRun.executionRunId}`);
  lines.push(`Lifecycle: ${facts.executionRun.lifecycle}`);
  if (facts.binding === null) {
    lines.push("Supervisor binding: none (no owner recorded; explicit takeover required).");
  } else {
    lines.push(
      `Supervisor binding: ${facts.binding.state}, generation ${facts.binding.generation}, owned by another session.`,
    );
  }
  if (sessionStart !== undefined && sessionStart !== null) {
    lines.push(`Session relation: ${sessionStart.relation} (host SessionStart source; annotation, never authority).`);
  }
  lines.push("This session has NO writable supervision authority.");
  lines.push(
    `Writable ownership requires the explicit user-authorized takeover flow (phase_plan.takeover_run with run_id ${takeoverRunId}).`,
  );
  return lines.join("\n");
}

/**
 * E12 §29 — the deterministic ambiguity notice: several active ExecutionRuns
 * are visible in this workspace and this session holds no exact binding that
 * disambiguates its own run. Recovery NEVER picks one; the user selects the
 * exact target and authorizes the takeover explicitly.
 */
export function renderExecutionAmbiguityNotice(ambiguousRunIds: string[]): string {
  return [
    "Phase Plan execution recovery is AMBIGUOUS in this workspace (EXECUTION_RUN_AMBIGUOUS).",
    "",
    `Active ExecutionRun candidates: ${ambiguousRunIds.join(", ")}`,
    "This session holds no exact supervision binding that names its own run.",
    "Recovery does NOT pick one implicitly. Ask the user which run is the real target, then call",
    "phase_plan.takeover_run with that exact run_id and its expected supervision generation",
    "(takeover requires explicit user authorization). Reads stay available; nothing was mutated.",
  ].join("\n");
}
