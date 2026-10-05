/**
 * ExecutionDirective application service (v0.2.0 E4 §5–§15, §40–§41).
 *
 * Authority model: the Supervisor session expresses issuance INTENT (the
 * directive content); Application/Core validates the FULL authority context
 * (E4 §6) and derives the server-owned fields; the Store persists the immutable
 * revision. Core verification, fail closed:
 *
 *   current Supervisor authority      (E2 fence: session/workspace/generation)
 *   ExecutionRun.lifecycle == active
 *   FinalPlan ref == the run's EXACT permanent binding
 *   Stage == the run's current active Stage
 *   Window == the run's current open Window
 *   baseCandidateRevision == the Window's current candidateRevision
 *   acceptedBase == execution_start resolving exactly to the run's persisted
 *                   executionStartBaseline (E4 §5), or — since E6 §36 —
 *                   execution_commit resolving exactly to the Window's frozen
 *                   accepted-base commit (successor Windows only). Historical
 *                   E4 Directives are never rewritten (E6 §37).
 *   planRefs == exact approved refs provable from the bound FinalPlan
 *   capabilityEnvelope == complete, explicit (no hidden kind defaults)
 *
 * Any stale binding refuses issuance (E4 §6) — a Directive is never issued in
 * the hope that Attempt startup catches staleness later.
 *
 * E4 §40: this is NOT a model-facing MCP tool. Future Supervisor APIs wrap
 * these primitives; there is deliberately no updateDirective/set_directive_hash
 * surface anywhere.
 */

import {
  executionDirectiveHash,
  parseCapabilityEnvelope,
  parseReportContract,
  validateDirectivePolicyLegality,
  type AcceptedExecutionBase,
  type DirectivePlanRef,
  type DirectiveReportContract,
  type DirectiveVerificationPolicy,
  type ExecutionCapabilityEnvelope,
  type ExecutionDirective,
  type ExecutionDirectiveKind,
} from "../core/execution-directive.js";
import { parseFinalPlanCanonical } from "./final-plan-canonical.js";
import { requireVerificationPressureClearInTx } from "./verification-policy-service.js";
import { RuntimeError } from "../runtime/errors.js";
import { getExecutionRunInTx } from "../store/execution-runs.js";
import { getFinalPlanInTx } from "../store/finalization.js";
import { requireActiveStageInTx, requireOpenWindowInTx } from "../store/execution-structure.js";
import { requireNoUnresolvedIndeterminateFenceInTx } from "./recovery-fence.js";
import { requireCurrentSupervisorAuthorityInTx } from "../store/supervisor-bindings.js";
import {
  insertExecutionDirectiveInTx,
  insertProtocolEventInTx,
  listDirectiveRevisionsInTx,
  listRunDirectivesInTx,
  getExecutionDirectiveInTx,
} from "../store/execution-directives.js";
import { bindConflictResolverInTx, getVerificationConflictInTx } from "../store/verification-conflicts.js";
import type { RepositoryBaseline } from "../core/execution-handoff.js";
import type { StoreClock } from "../store/migration-runner.js";
import type { PlanStore } from "../store/sqlite-store.js";
import type { StoreTx } from "../store/transaction.js";

function directiveError(
  code:
    | "DIRECTIVE_NOT_CURRENT"
    | "DIRECTIVE_HASH_MISMATCH"
    | "DIRECTIVE_REVISION_CONFLICT"
    | "DIRECTIVE_ALREADY_ATTEMPTED"
    // A1-I closure §3 — the logical lineage is owned by its issuing run.
    | "DIRECTIVE_LINEAGE_FOREIGN_RUN"
    | "ACCEPTED_BASE_INVALID"
    | "PLAN_REF_INVALID"
    | "STALE_CANDIDATE_REVISION"
    // v0.2.0 E8 — versioned verification policy.
    | "VERIFICATION_POLICY_INVALID"
    | "VERIFICATION_REQUIREMENT_DOWNGRADE"
    | "VERIFICATION_CONFLICT_INVALID"
    | "VERIFICATION_CONFLICT_STALE",
  message: string,
  detail?: Record<string, unknown>,
): RuntimeError {
  return new RuntimeError(code, message, { detail, recoverable: false });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sameBaseline(a: RepositoryBaseline, b: unknown): boolean {
  if (!isPlainObject(b) || a.kind !== b.kind) return false;
  if (a.kind === "git") return b.revision === a.revision;
  return true;
}

/**
 * The strongest exact approved-reference validator available (E4 §12): a ref
 * is valid when it matches EXACTLY one approved ref recorded in the bound
 * FinalPlan canonical (architecture / section / decision / constraint /
 * evidence). Kinds the FinalPlan canonical cannot prove (questions, bundle
 * contracts, unversioned or "latest" refs) are rejected — approval is never
 * invented.
 */
export function requirePlanRefsUnderFinalPlan(planRefs: DirectivePlanRef[], plan: ReturnType<typeof parseFinalPlanCanonical>): void {
  const approved = new Set<string>();
  if (plan.architecture !== null) {
    approved.add(`architecture|${plan.architecture.id}|${plan.architecture.revision}`);
  }
  for (const section of plan.sections) {
    approved.add(`section|${section.sectionId}|${section.revision}`);
  }
  for (const item of [...plan.decisions, ...plan.constraints]) {
    approved.add(`${item.kind}|${item.id}|${item.revision}`);
  }
  for (const ref of planRefs) {
    if (
      !isPlainObject(ref)
      || typeof ref.kind !== "string"
      || typeof ref.id !== "string"
      || typeof ref.revision !== "number"
      || !Number.isInteger(ref.revision)
      || ref.revision < 1
    ) {
      throw directiveError("PLAN_REF_INVALID", "directive planRef is not an exact {kind, id, revision} reference", {
        ref,
      });
    }
    if (!approved.has(`${ref.kind}|${ref.id}|${ref.revision}`)) {
      throw directiveError(
        "PLAN_REF_INVALID",
        `plan ref ${ref.kind}|${ref.id}@${ref.revision} is not an exact approved reference of the bound FinalPlan`,
        { kind: ref.kind, id: ref.id, revision: ref.revision },
      );
    }
  }
}

export interface IssueExecutionDirectiveInput {
  /**
   * E11 §11 — INTERNAL: the reconciliation-issuance path creates the binding
   * atomically with the Directive, so the §13 fence would refuse its own
   * workflow. Never set by model-facing issuance.
   */
  skipRecoveryFence?: boolean;
  executionRunId: string;
  /** Signed HostContext session — never model-supplied authority. */
  sessionId: string;
  workspaceId: string;
  /** The caller's known supervision fencing generation. */
  generation: number;
  /** Logical Directive id; generated when omitted. */
  directiveId?: string;
  /** Exact revision; defaults to the next revision of the logical Directive. */
  revision?: number;
  kind: ExecutionDirectiveKind;
  /**
   * E10 §5/§16 — the execution scope. STAGE scope: the Stage the Directive
   * targets (must be the run's CURRENT active Stage). FINAL-CLOSURE scope:
   * omit stageId and set scopeKind = "final_closure" (run-level; the Window
   * must be the open Final Closure Window). The two forms are exclusive —
   * one logical Directive can never switch scope across revisions (E10 §19).
   */
  stageId?: string;
  scopeKind?: "final_closure";
  /** The VerificationWindow the Directive targets — must be the CURRENT open Window. */
  windowId: string;
  objective: string;
  body: string;
  /** Optional; must equal the run's permanent FinalPlan binding when supplied. */
  finalPlanRef?: { id: string; revision: number; hash: string };
  /** Optional; must equal the current Window candidateRevision when supplied. */
  baseCandidateRevision?: number;
  /** Optional; only execution_start is legal in E4 (E4 §5). */
  acceptedBase?: AcceptedExecutionBase;
  planRefs?: DirectivePlanRef[];
  expectedExecutionScope?: {
    files?: string[];
    symbols?: string[];
    callPaths?: string[];
    tests?: string[];
  };
  capabilityEnvelope: ExecutionCapabilityEnvelope;
  invariants?: Array<{ statement: string }>;
  requiredActions?: Array<{ action: string; detail: string | null }>;
  forbiddenActions?: Array<{ action: string; detail: string | null }>;
  validationRequirements?: Array<{ requirement: string; detail: string | null }>;
  deliverables?: Array<{ name: string; detail: string | null }>;
  stopConditions?: Array<{ condition: string; detail: string | null }>;
  reportContract: DirectiveReportContract;
  /**
   * E8 §6 — the v2 structured verification policy. Every newly issued
   * Directive is protocol v2 (E8 §7); the frozen kind-legality matrix is
   * enforced, and the policy is part of the v2 canonical hash.
   */
  verificationPolicy?: DirectiveVerificationPolicy;
}

/**
 * The authoritative issuance core (E4 §6). Runs inside the caller's write
 * transaction; every check fails closed BEFORE any row is written.
 */
export function issueExecutionDirectiveInTx(
  tx: StoreTx,
  input: IssueExecutionDirectiveInput,
  clock: StoreClock,
  now: string,
): ExecutionDirective {
  requireCurrentSupervisorAuthorityInTx(tx, {
    executionRunId: input.executionRunId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    generation: input.generation,
  });
  const run = getExecutionRunInTx(tx, input.executionRunId);
  if (run === null) {
    throw directiveError("DIRECTIVE_NOT_CURRENT", `no ExecutionRun exists for '${input.executionRunId}'`, {
      executionRunId: input.executionRunId,
    });
  }
  const finalPlanRef = input.finalPlanRef ?? run.finalPlan;
  if (
    finalPlanRef.id !== run.finalPlan.id
    || finalPlanRef.revision !== run.finalPlan.revision
    || finalPlanRef.hash !== run.finalPlan.hash
  ) {
    throw new RuntimeError(
      "EXECUTION_RUN_FINALPLAN_MISMATCH",
      `directive would bind FinalPlan ${finalPlanRef.id}@${finalPlanRef.revision}; the ExecutionRun is permanently bound to ${run.finalPlan.id}@${run.finalPlan.revision}`,
      { detail: { expected: run.finalPlan, detected: finalPlanRef }, recoverable: false },
    );
  }
  // E10 §5/§6/§16 — resolve the explicit execution scope. Exactly one form is
  // legal: a stage id (stage scope) or scopeKind = "final_closure" with no
  // stage id. Core enforces the scope/window/stage authority triangle here —
  // a final-closure Directive can only ever bind the open Final Closure
  // Window, and a stage Directive only the active Stage's open Window.
  const finalClosure = input.stageId === undefined && input.scopeKind === "final_closure";
  if (!finalClosure && (input.stageId === undefined || input.scopeKind !== undefined)) {
    throw new RuntimeError(
      "EXECUTION_SCOPE_INVALID",
      "directive scope must be exactly one of: stageId (stage scope) or scopeKind='final_closure' without a stageId (E10 §5)",
      { detail: { stageId: input.stageId ?? null, scopeKind: input.scopeKind ?? null }, recoverable: false },
    );
  }
  const stage = finalClosure ? null : requireActiveStageInTx(tx, input.executionRunId, input.stageId);
  const window = requireOpenWindowInTx(tx, input.executionRunId, input.windowId);
  if (finalClosure) {
    if (window.scopeKind !== "final_closure") {
      throw new RuntimeError(
        "EXECUTION_SCOPE_INVALID",
        `window '${window.id}' is a ${window.scopeKind} window; a final-closure Directive binds only the open Final Closure Window (E10 §16)`,
        { detail: { windowId: window.id, scopeKind: window.scopeKind }, recoverable: false },
      );
    }
  } else if (window.scopeKind !== "stage" || window.stageId !== input.stageId) {
    throw new RuntimeError(
      "EXECUTION_SCOPE_INVALID",
      `window '${window.id}' does not belong to stage '${input.stageId}'; a stage Directive binds only its active Stage's open Window (E10 §16)`,
      { detail: { windowId: window.id, stageId: input.stageId ?? null, windowStageId: window.stageId }, recoverable: false },
    );
  }
  const baseCandidateRevision = input.baseCandidateRevision ?? window.candidateRevision;
  if (baseCandidateRevision !== window.candidateRevision) {
    throw directiveError(
      "STALE_CANDIDATE_REVISION",
      `directive base candidate revision ${baseCandidateRevision} is stale; the open window is at ${window.candidateRevision}`,
      { expected: window.candidateRevision, detected: baseCandidateRevision },
    );
  }
  let acceptedBase: AcceptedExecutionBase;
  if (input.acceptedBase === undefined) {
    // E6 §36 — a Directive in a post-commit successor Window defaults to the
    // Window's FROZEN execution_commit base (never the run baseline, never a
    // dynamically-moving "latest head").
    acceptedBase =
      window.baseKind === "execution_commit" && window.baseCommitId !== null
        ? { kind: "execution_commit", executionCommitId: window.baseCommitId }
        : { kind: "execution_start", baseline: run.executionStartBaseline as unknown as Record<string, unknown> };
  } else if (
    input.acceptedBase.kind === "execution_start"
    && sameBaseline(run.executionStartBaseline, input.acceptedBase.baseline)
  ) {
    acceptedBase = input.acceptedBase;
  } else if (input.acceptedBase.kind === "execution_commit") {
    // E6 §36 — a Directive issued in a post-commit successor Window binds the
    // Window's FROZEN accepted base, never "latest head dynamically": the
    // supplied commit id must equal the Window's durable base commit, which by
    // construction was the acceptedHead at window creation.
    const windowRow = tx
      .prepare("SELECT base_kind AS baseKind, base_commit_id AS baseCommitId FROM verification_windows WHERE id = ?")
      .get(window.id) as { baseKind: string; baseCommitId: string | null } | undefined;
    if (
      windowRow === undefined
      || windowRow.baseKind !== "execution_commit"
      || windowRow.baseCommitId === null
      || input.acceptedBase.executionCommitId !== windowRow.baseCommitId
    ) {
      throw directiveError(
        "ACCEPTED_BASE_INVALID",
        `directive accepted base '${input.acceptedBase.executionCommitId}' does not resolve to window '${window.id}' execution_commit base`,
        { windowId: window.id, detected: input.acceptedBase.executionCommitId },
      );
    }
    acceptedBase = input.acceptedBase;
  } else {
    throw directiveError(
      "ACCEPTED_BASE_INVALID",
      "the supplied accepted base does not resolve exactly to the ExecutionRun's persisted executionStartBaseline",
      { detected: input.acceptedBase.kind },
    );
  }
  const planRefs = input.planRefs ?? [];
  if (planRefs.length > 0) {
    // A1 §16 — the approved FinalPlan is planning-scoped; resolve it through
    // the execution run's source-planning provenance.
    const planningRunId = getExecutionRunInTx(tx, input.executionRunId)?.runId ?? input.executionRunId;
    const finalPlanRow = getFinalPlanInTx(tx, planningRunId);
    if (finalPlanRow === null) {
      throw directiveError("DIRECTIVE_NOT_CURRENT", `no approved FinalPlan exists for run '${input.executionRunId}'`, {
        executionRunId: input.executionRunId,
      });
    }
    requirePlanRefsUnderFinalPlan(planRefs, parseFinalPlanCanonical(finalPlanRow.canonicalJson, input.executionRunId));
  }
  const capabilityEnvelope = parseCapabilityEnvelope(input.capabilityEnvelope);
  const reportContract = parseReportContract(input.reportContract);
  if (typeof input.objective !== "string" || input.objective === "") {
    throw directiveError("DIRECTIVE_REVISION_CONFLICT", "directive objective must be a non-empty string", {});
  }
  // E8 §6/§7/§8 + E10 §17/§20 — every NEW Directive is protocol v3 (explicit
  // scope; the structured verification policy and its frozen legality matrix
  // carry forward unchanged). Revision rules across the logical Directive's
  // history: batchable → immediate is allowed, immediate → batchable is a
  // forbidden downgrade, and a v1 → v2/v3 revision must adopt `immediate` (the
  // conservative upgrade — a legacy policy that never existed is never
  // invented).
  const directiveId = input.directiveId ?? `dir_${clock.newId()}`;
  const priorRevisions = listDirectiveRevisionsInTx(tx, directiveId);
  // A1-I closure §3 — Directive lineage is owned by the ExecutionRun that
  // holds every prior revision. A revision submitted under a different
  // executionRunId is a foreign-lineage move and fails closed even when every
  // run-local gate (supervisor generation, Stage, Window, candidate revision)
  // is independently legal: one logical directive_id can never grow revisions
  // in a second execution world.
  const foreignLineage = priorRevisions.find((revision) => revision.executionRunId !== input.executionRunId);
  if (foreignLineage !== undefined) {
    throw directiveError(
      "DIRECTIVE_LINEAGE_FOREIGN_RUN",
      `directive '${directiveId}' lineage belongs to ExecutionRun '${foreignLineage.executionRunId}'; it cannot be revised under '${input.executionRunId}' (A1-I §3)`,
      {
        directiveId,
        lineageExecutionRunId: foreignLineage.executionRunId,
        detectedExecutionRunId: input.executionRunId,
      },
    );
  }
  const rawPolicy = input.verificationPolicy ?? null;
  const normalizedPolicy: DirectiveVerificationPolicy | null =
    rawPolicy === null || Object.keys(rawPolicy).length === 0 ? null : rawPolicy;
  if (input.kind === "implementation" && normalizedPolicy !== null && priorRevisions.length > 0) {
    const last = priorRevisions[priorRevisions.length - 1]!;
    if (last.protocolVersion >= 2) {
      if (
        last.verificationPolicy?.implementationRequirement === "immediate"
        && normalizedPolicy.implementationRequirement === "batchable"
      ) {
        throw directiveError(
          "VERIFICATION_REQUIREMENT_DOWNGRADE",
          `directive '${directiveId}' revision ${last.revision} required immediate verification; a later revision may not downgrade it to batchable (E8 §8)`,
          { directiveId, priorRevision: last.revision, priorRequirement: "immediate", detected: "batchable" },
        );
      }
    } else if (normalizedPolicy.implementationRequirement !== "immediate") {
      throw directiveError(
        "VERIFICATION_POLICY_INVALID",
        `a v2/v3 revision of legacy v1 implementation directive '${directiveId}' must conservatively adopt implementationRequirement=immediate (E8 §8)`,
        { directiveId, priorProtocolVersion: 1, detected: normalizedPolicy.implementationRequirement ?? null },
      );
    }
  }
  const legalityProblems = validateDirectivePolicyLegality(input.kind, input.kind === "inspection" ? null : normalizedPolicy);
  if (legalityProblems.length > 0) {
    throw directiveError(
      "VERIFICATION_POLICY_INVALID",
      `directive verification policy violates the frozen kind-legality matrix: ${legalityProblems.join(", ")} (E8 §6)`,
      { kind: input.kind, problems: legalityProblems },
    );
  }
  // E8 §31 — a conflict-resolution resolver binds THE one exact open conflict:
  // same run/window/revision, status open, no resolver yet (the atomic bind
  // below makes a second resolver impossible).
  let resolutionConflictId: string | null = null;
  if (input.kind === "verification" && normalizedPolicy?.verificationPurpose === "conflict_resolution") {
    resolutionConflictId = normalizedPolicy.verificationConflictId ?? null;
    const conflict = resolutionConflictId === null ? null : getVerificationConflictInTx(tx, resolutionConflictId);
    if (conflict === null) {
      throw directiveError("VERIFICATION_CONFLICT_INVALID", `no verification conflict exists for '${resolutionConflictId}'`, {
        conflictId: resolutionConflictId,
      });
    }
    if (conflict.executionRunId !== input.executionRunId || conflict.windowId !== window.id || conflict.candidateRevision !== window.candidateRevision) {
      throw directiveError(
        "VERIFICATION_CONFLICT_STALE",
        `conflict '${conflict.conflictId}' binds window '${conflict.windowId}'@${conflict.candidateRevision}; the current candidate is '${window.id}'@${window.candidateRevision} (E8 §31/§39)`,
        { conflictId: conflict.conflictId, windowId: conflict.windowId, candidateRevision: conflict.candidateRevision },
      );
    }
  }
  // E8 §21 — implementation issuance is refused while verification is due.
  // Inspection and verification (normal or conflict-resolution) are never
  // blocked by pressure.
  if (input.kind === "implementation") {
    requireVerificationPressureClearInTx(tx, input.executionRunId);
  }
  // E11 §13 — the recovery fence: ordinary issuance (implementation,
  // inspection, and verification alike) is refused while an unresolved
  // indeterminate Attempt sits in the current open window. Revisions of the
  // bound reconciliation Directive pass (the recovery workflow proceeds).
  if (input.skipRecoveryFence !== true) {
    requireNoUnresolvedIndeterminateFenceInTx(tx, input.executionRunId, directiveId);
  }
  const revision = input.revision ?? (priorRevisions.length === 0 ? 1 : (priorRevisions[priorRevisions.length - 1]?.revision ?? 0) + 1);
  const scope = input.expectedExecutionScope ?? {};
  const candidate: Omit<ExecutionDirective, "hash" | "issuedAt"> = {
    directiveId,
    revision,
    executionRunId: input.executionRunId,
    // A1 §16 — the source PlanningRunID rides as immutable provenance.
    runId: run === null ? input.executionRunId : run.runId,
    // A1 §20 — after the A1-I activation EVERY newly issued Directive is
    // protocol v4, canonically binding the exact ExecutionRunID (authority)
    // and the sourcePlanningRunId (provenance); v1/v2/v3 rows are frozen
    // history and are never re-hashed.
    protocolVersion: 4,
    verificationPolicy: normalizedPolicy,
    finalPlanRef,
    scopeKind: finalClosure ? "final_closure" : "stage",
    stageId: finalClosure ? null : (stage as NonNullable<typeof stage>).id,
    windowId: window.id,
    kind: input.kind,
    baseCandidateRevision,
    acceptedBase,
    objective: input.objective,
    planRefs,
    expectedExecutionScope: {
      files: scope.files ?? [],
      symbols: scope.symbols ?? [],
      callPaths: scope.callPaths ?? [],
      tests: scope.tests ?? [],
    },
    capabilityEnvelope,
    invariants: input.invariants ?? [],
    requiredActions: input.requiredActions ?? [],
    forbiddenActions: input.forbiddenActions ?? [],
    validationRequirements: input.validationRequirements ?? [],
    deliverables: input.deliverables ?? [],
    stopConditions: input.stopConditions ?? [],
    reportContract,
    body: input.body,
  };
  const directive: ExecutionDirective = {
    ...candidate,
    hash: executionDirectiveHash(candidate),
    issuedAt: now,
  };
  insertExecutionDirectiveInTx(tx, directive);
  // E8 §31 — atomically bind THE one resolver: this races nothing under the
  // write lock, and the conditional UPDATE refuses a second resolver even if
  // one was bound between validation and here.
  if (resolutionConflictId !== null) {
    bindConflictResolverInTx(
      tx,
      { conflictId: resolutionConflictId, directiveId: directive.directiveId, directiveRevision: directive.revision },
      now,
    );
  }
  insertProtocolEventInTx(
    tx,
    { executionRunId: input.executionRunId, eventType: "DIRECTIVE_ISSUED", directiveId, directiveRevision: revision },
    now,
  );
  return directive;
}

export function createExecutionDirectiveService(store: PlanStore, clock: StoreClock) {
  return {
    /** Authoritative issuance (E4 §6) — future Supervisor APIs wrap this primitive. */
    issueExecutionDirective(input: IssueExecutionDirectiveInput): ExecutionDirective {
      return store.withWrite((tx) => issueExecutionDirectiveInTx(tx, input, clock, clock.nowIso()));
    },

    getDirective(input: { directiveId: string; revision: number }): ExecutionDirective | null {
      return store.withRead((tx) => getExecutionDirectiveInTx(tx, input.directiveId, input.revision));
    },

    /** Full revision history of one logical Directive, oldest first (E4-T5). */
    listDirectiveRevisions(input: { directiveId: string }): ExecutionDirective[] {
      return store.withRead((tx) => listDirectiveRevisionsInTx(tx, input.directiveId));
    },

    listRunDirectives(input: { executionRunId: string }): ExecutionDirective[] {
      return store.withRead((tx) => listRunDirectivesInTx(tx, input.executionRunId));
    },
  };
}
