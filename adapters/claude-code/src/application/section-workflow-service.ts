/**
 * Section workflow application service (Phase 11 §4–§15/§32–§44/§48).
 *
 * Owns the operational workflow layer over the immutable Section revisions:
 * durable active-Section selection, and the in-tx transition helpers the
 * PlanCommit engine and the Evidence bridge reuse. Workflow state is NEVER
 * Plan Memory: transitions write events + materialized state only — they
 * never create a Snapshot or move HEAD unless they run inside a PlanCommit
 * (completion/reopen proposals, §65).
 *
 * select_section authority model (§12): HostContext + current run — the
 * model supplies only a section id, never run/workspace/binding/revision.
 * Selection at stage detail mutates the frozen conceptual PlanningRun state
 * (§14): the run revision moves exactly once per scope change, which gives
 * every awaiting proposal correct baseRunRevision fencing for free.
 */

import type { MemoryRef } from "../core/memory-refs.js";
import {
  isSectionWorkflowTransitionAllowed,
  sectionWorkflowEventTarget,
  type SectionWorkflowEventType,
} from "../core/section-workflow.js";
import type { ProposalScope } from "../core/proposal.js";
import { RuntimeError } from "../runtime/errors.js";
import { runStateError } from "../store/planning-runs.js";
import { getHeadPairInTx } from "../store/plan-commits.js";
import { getSnapshotRefsInTx } from "../store/plan-memory.js";
import { assertWritableBindingInTx } from "../store/session-bindings.js";
import {
  appendSectionWorkflowEventInTx,
  clearActiveSectionInTx,
  getActiveSectionInTx,
  getSectionWorkflowStateInTx,
  listSectionWorkflowStatesInTx,
  setActiveSectionInTx,
  type SectionCompletionProvenance,
  type SectionWorkflowStateView,
} from "../store/section-workflow.js";
import type { PlanStore } from "../store/sqlite-store.js";
import type { StoreClock } from "../store/migration-runner.js";
import type { StoreTx } from "../store/transaction.js";
import { parsePlanningRunRow, type PlanningRun } from "../core/planning-run.js";

const SELECT_RUN =
  "SELECT run_id AS runId, workspace_id AS workspaceId, lifecycle, stage, revision, goal, created_at AS createdAt, updated_at AS updatedAt FROM planning_runs";

export function sectionWorkflowError(
  code:
    | "SECTION_NOT_FOUND"
    | "SECTION_WORKFLOW_INVALID"
    | "SECTION_NOT_ACTIVE"
    | "SECTION_ALREADY_COMPLETED"
    | "SECTION_NEEDS_REVIEW"
    | "SECTION_DEPENDENCY_INCOMPLETE"
    | "SECTION_WORKFLOW_INCOMPLETE"
    | "ACTIVE_PROPOSAL_SCOPE_CONFLICT",
  message: string,
  detail?: Record<string, unknown>,
): RuntimeError {
  return new RuntimeError(code, message, { detail });
}

export interface SelectSectionInput {
  runId: string;
  workspaceId: string;
  sessionId: string;
  bindingGeneration: number;
  expectedRunRevision: number;
  sectionId: string;
}

export interface SelectSectionResult {
  run: PlanningRun;
  /** The Section now active (same as the input on success). */
  activeSectionId: string;
  /** True when the same Section was already active (idempotent, §14). */
  idempotent: boolean;
}

export function createSectionWorkflowService(store: PlanStore, clock: StoreClock) {
  return {
    /**
     * Durable active-Section selection (§10/§12–§15). Fences: run exists →
     * workspace exact → writable binding → lifecycle active → expected run
     * revision → stage detail → Section exists in current HEAD → awaiting-
     * proposal scope compat (§13). Re-selecting the active Section is
     * idempotent and leaves the run revision alone (§14).
     */
    selectSection(input: SelectSectionInput): SelectSectionResult {
      return store.withWrite((tx) => {
        const row = tx.prepare(`${SELECT_RUN} WHERE run_id = ?`).get(input.runId) as
          | Record<string, unknown>
          | undefined;
        if (row === undefined) {
          throw runStateError("RUN_NOT_FOUND", `no PlanningRun exists for '${input.runId}'`, { runId: input.runId });
        }
        const run = parsePlanningRunRow(row);
        if (run.workspaceId !== input.workspaceId) {
          throw new RuntimeError("WORKSPACE_MISMATCH", `PlanningRun '${run.runId}' belongs to a different workspace`, {
            detail: { expected: run.workspaceId, detected: input.workspaceId },
          });
        }
        assertWritableBindingInTx(tx, {
          runId: input.runId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          generation: input.bindingGeneration,
        });
        if (run.lifecycle !== "active") {
          throw runStateError("RUN_TERMINAL", `PlanningRun '${run.runId}' is ${run.lifecycle} and can no longer mutate`, {
            runId: run.runId,
            lifecycle: run.lifecycle,
          });
        }
        if (run.revision !== input.expectedRunRevision) {
          throw runStateError(
            "STALE_RUN_REVISION",
            `stale run revision ${input.expectedRunRevision} for '${run.runId}'; current is ${run.revision}`,
            { runId: input.runId, expected: input.expectedRunRevision, detected: run.revision },
          );
        }
        if (run.stage !== "detail") {
          throw sectionWorkflowError(
            "SECTION_WORKFLOW_INVALID",
            `select_section requires stage detail (run '${run.runId}' is at ${run.stage})`,
            { runId: run.runId, stage: run.stage },
          );
        }
        // §11 — the exact Section identity must exist in the CURRENT HEAD
        // snapshot; the active-work row stores the id only, never content.
        const head = getHeadPairInTx(tx, input.runId);
        const headRefs: MemoryRef[] = head === null ? [] : (getSnapshotRefsInTx(tx, head.headSnapshotId) ?? []);
        const sectionRef = headRefs.find((ref) => ref.kind === "section" && ref.id === input.sectionId);
        if (sectionRef === undefined) {
          throw sectionWorkflowError(
            "SECTION_NOT_FOUND",
            `section '${input.sectionId}' does not exist in the current HEAD snapshot`,
            { runId: input.runId, sectionId: input.sectionId },
          );
        }
        // §13 — an awaiting Proposal fences selection: only its own Section
        // scope may stay selected; anything else is a scope conflict.
        const awaiting = tx
          .prepare(
            "SELECT scope_json AS scopeJson FROM proposal_states ps JOIN proposal_revisions pr "
            + "ON pr.run_id = ps.run_id AND pr.proposal_id = ps.proposal_id AND pr.revision = ps.revision "
            + "WHERE ps.run_id = ? AND ps.status = 'awaiting_approval' LIMIT 1",
          )
          .get(input.runId) as { scopeJson: string } | undefined;
        if (awaiting !== undefined) {
          const scope = JSON.parse(awaiting.scopeJson) as ProposalScope;
          const sameScope = scope.kind === "section" && scope.sectionId === input.sectionId;
          if (!sameScope) {
            throw sectionWorkflowError(
              "ACTIVE_PROPOSAL_SCOPE_CONFLICT",
              `an awaiting proposal scoped to '${scope.kind === "section" ? scope.sectionId : scope.kind}' blocks selecting section '${input.sectionId}'; resolve the proposal first`,
              { runId: input.runId, awaitingScope: scope, requestedSectionId: input.sectionId },
            );
          }
        }
        // §14 — same-Section re-selection is idempotent (no revision bump).
        const current = getActiveSectionInTx(tx, input.runId);
        if (current === input.sectionId) {
          return { run, activeSectionId: input.sectionId, idempotent: true };
        }
        const now = clock.nowIso();
        setActiveSectionInTx(tx, input.runId, input.sectionId, now);
        // §14 — activeWork is frozen conceptual PlanningRun state: one
        // authoritative run mutation, revision +1 exactly once.
        const result = tx
          .prepare("UPDATE planning_runs SET revision = revision + 1, updated_at = ? WHERE run_id = ? AND revision = ?")
          .run(now, input.runId, run.revision) as { changes?: number };
        if ((result.changes ?? 0) !== 1) {
          throw runStateError("STALE_RUN_REVISION", "run revision changed during selection", {
            runId: input.runId,
            expected: run.revision,
          });
        }
        // Provenance note: audit_events keeps its frozen five-type CHECK
        // (§74 spirit + Phase 9/10 precedent). The authoritative selection
        // facts live in planning_active_work and the bumped run revision.
        return {
          run: { ...run, revision: run.revision + 1, updatedAt: now },
          activeSectionId: input.sectionId,
          idempotent: false,
        };
      });
    },
  };
}

// ---------------------------------------------------------------------------
// In-transaction helpers shared with the PlanCommit engine and the Evidence
// review bridge. These run INSIDE an open store transaction and never open
// their own.
// ---------------------------------------------------------------------------

/**
 * Register a freshly committed Section identity as workflow-open (§28). The
 * PlanCommit engine calls this in the SAME transaction that creates the
 * identity — Plan Memory and workflow state are never split across
 * transactions.
 */
export function registerSectionWorkflowInTx(
  tx: StoreTx,
  input: { runId: string; sectionId: string; reasonCode: string; detail?: Record<string, unknown>; requestId?: string | null },
  clock: StoreClock,
): void {
  appendSectionWorkflowEventInTx(
    tx,
    {
      runId: input.runId,
      sectionId: input.sectionId,
      eventType: "REGISTERED",
      toState: "open",
      reasonCode: input.reasonCode,
      detail: input.detail ?? {},
      eventId: `sev-${clock.newId()}`,
      ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
      createdAt: clock.nowIso(),
    },
  );
}

/**
 * One workflow transition with full legality checking (§7): the event must be
 * legal from the materialized state, and COMPLETED requires the full
 * completion provenance (§5) while review transitions RETAIN the existing
 * provenance (§6) and REOPENED clears it (§41).
 */
export function transitionSectionWorkflowInTx(
  tx: StoreTx,
  input: {
    runId: string;
    sectionId: string;
    eventType: Exclude<SectionWorkflowEventType, "REGISTERED">;
    reasonCode: string;
    detail?: Record<string, unknown>;
    requestId?: string | null;
    /** Required for COMPLETED; ignored otherwise (provenance carried/cleared by rule). */
    completion?: SectionCompletionProvenance;
  },
  clock: StoreClock,
): SectionWorkflowStateView {
  const current = getSectionWorkflowStateInTx(tx, input.runId, input.sectionId);
  const from = current?.status ?? null;
  if (!isSectionWorkflowTransitionAllowed(input.eventType, from)) {
    throw sectionWorkflowError(
      "SECTION_WORKFLOW_INVALID",
      `${input.eventType} is not legal from workflow state ${String(from)} (section '${input.sectionId}')`,
      { runId: input.runId, sectionId: input.sectionId, eventType: input.eventType, from },
    );
  }
  const to = sectionWorkflowEventTarget(input.eventType);
  const completion =
    input.eventType === "COMPLETED"
      ? input.completion
      : input.eventType === "REOPENED"
        ? undefined
        : // needs_review retains the exact prior completion provenance (§6).
          current && current.status === "completed"
            ? {
                completedRevision: current.completedRevision as number,
                completedProposalId: current.completedProposalId as string,
                completedProposalRevision: current.completedProposalRevision as number,
                completionCommitId: current.completionCommitId as string,
              }
            : undefined;
  return appendSectionWorkflowEventInTx(
    tx,
    {
      runId: input.runId,
      sectionId: input.sectionId,
      eventType: input.eventType,
      fromState: from,
      toState: to,
      reasonCode: input.reasonCode,
      detail: input.detail ?? {},
      eventId: `sev-${clock.newId()}`,
      ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
      ...(completion ?? {}),
      createdAt: clock.nowIso(),
    },
  );
}

/**
 * Downstream completed Sections of the given origins, via the SECTION DAG of
 * one exact ref world (usually the resulting HEAD snapshot). Deterministic
 * BFS over dependency identities (§42: recursive, same-run, same tx).
 */
export function listDownstreamSectionClosure(
  headSectionRefs: MemoryRef[],
  readDependencies: (sectionId: string) => string[],
  origins: string[],
): string[] {
  const dependents = new Map<string, string[]>();
  for (const ref of headSectionRefs) {
    if (ref.kind !== "section") continue;
    for (const dependency of readDependencies(ref.id)) {
      const list = dependents.get(dependency);
      if (list === undefined) {
        dependents.set(dependency, [ref.id]);
      } else if (!list.includes(ref.id)) {
        list.push(ref.id);
      }
    }
  }
  const visited = new Set<string>(origins);
  const queue = [...origins];
  const closure: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const dependent of [...(dependents.get(current) ?? [])].sort()) {
      if (visited.has(dependent)) continue;
      visited.add(dependent);
      closure.push(dependent);
      queue.push(dependent);
    }
  }
  return closure.sort();
}

/** Read a section revision's dependency ids from committed memory. */
export function sectionDependenciesInTx(tx: StoreTx, runId: string, sectionId: string, revision: number): string[] {
  const row = tx
    .prepare(
      "SELECT content_json AS contentJson FROM memory_revisions WHERE run_id = ? AND kind = 'section' AND artifact_id = ? AND revision = ?",
    )
    .get(runId, sectionId, revision) as { contentJson: string } | undefined;
  if (row === undefined) return [];
  const content = JSON.parse(row.contentJson) as { dependencies?: string[] };
  return Array.isArray(content.dependencies) ? [...content.dependencies] : [];
}

/**
 * §42 — dependency invalidation: after the given sections were (re)opened,
 * every COMPLETED downstream Section transitions to needs_review with
 * DEPENDENCY_REVIEW_REQUIRED, keeping its exact prior completion provenance
 * (§6). Immutable Section revisions are untouched. `exclude` covers Sections
 * whose fate the same commit already decided (e.g. completed in this same
 * proposal); needs_review sections stay needs_review (§42), and there is no
 * automatic restoration later (§43).
 */
export function propagateDependencyReviewInTx(
  tx: StoreTx,
  input: {
    runId: string;
    headSectionRefs: MemoryRef[];
    reopenedIds: string[];
    exclude?: string[];
    requestId?: string | null;
  },
  clock: StoreClock,
): string[] {
  const affected: string[] = [];
  if (input.reopenedIds.length === 0) return affected;
  const exclude = new Set([...(input.exclude ?? []), ...input.reopenedIds]);
  const downstream = listDownstreamSectionClosure(
    input.headSectionRefs,
    (sectionId) => {
      const ref = input.headSectionRefs.find((candidate) => candidate.kind === "section" && candidate.id === sectionId);
      return ref === undefined ? [] : sectionDependenciesInTx(tx, input.runId, sectionId, ref.revision);
    },
    input.reopenedIds,
  );
  for (const sectionId of downstream) {
    if (exclude.has(sectionId)) continue;
    const state = getSectionWorkflowStateInTx(tx, input.runId, sectionId);
    if (state === null || state.status !== "completed") continue;
    transitionSectionWorkflowInTx(
      tx,
      {
        runId: input.runId,
        sectionId,
        eventType: "DEPENDENCY_REVIEW_REQUIRED",
        reasonCode: "upstream_section_reopened",
        detail: { reopened: [...input.reopenedIds].sort() },
        ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
      },
      clock,
    );
    affected.push(sectionId);
  }
  return affected.sort();
}

/**
 * §35 — whether the run's CURRENT HEAD constitutes a complete Detail phase:
 * at least one Section, every Section completed at its exact HEAD revision,
 * and no Section in needs_review. The caller performs the DETAIL_COMPLETE
 * transition in the same transaction when this returns true.
 */
export function evaluateDetailCompletionInTx(tx: StoreTx, runId: string, headSectionRefs: MemoryRef[]): {
  ready: boolean;
  sections: SectionWorkflowStateView[];
  blockers: string[];
} {
  const states = listSectionWorkflowStatesInTx(tx, runId);
  const byId = new Map(states.map((state) => [state.sectionId, state]));
  const headSections = headSectionRefs.filter((ref) => ref.kind === "section");
  if (headSections.length === 0) {
    return { ready: false, sections: states, blockers: ["no sections exist in the current HEAD snapshot"] };
  }
  const blockers: string[] = [];
  for (const ref of headSections) {
    const state = byId.get(ref.id);
    if (state === undefined) {
      blockers.push(`section '${ref.id}' has no workflow state`);
      continue;
    }
    if (state.status === "needs_review") {
      blockers.push(`section '${ref.id}' is needs_review`);
      continue;
    }
    if (state.status !== "completed" || state.completedRevision !== ref.revision) {
      blockers.push(`section '${ref.id}' is ${state.status} at ${String(state.completedRevision)}, HEAD is @${ref.revision}`);
    }
  }
  return { ready: blockers.length === 0, sections: states, blockers };
}

/**
 * §36/§40(E38) — the DETAIL_COMPLETE guard: an empty Section set can never
 * transition Detail → Synthesis.
 */
export function assertDetailCompletionAllowedInTx(tx: StoreTx, runId: string, headSectionRefs: MemoryRef[]): void {
  const evaluation = evaluateDetailCompletionInTx(tx, runId, headSectionRefs);
  if (!evaluation.ready) {
    throw sectionWorkflowError(
      "SECTION_WORKFLOW_INCOMPLETE",
      `Detail cannot complete: ${evaluation.blockers.join("; ")}`,
      { runId, blockers: evaluation.blockers },
    );
  }
}

/**
 * §34/§35 — clear the active Section after its completion and bump the run
 * revision EXACTLY ONCE together with an optional stage transition. Runs
 * inside the PlanCommit transaction.
 */
export function clearActiveSectionAfterCompletionInTx(
  tx: StoreTx,
  input: { runId: string; expectedRevision: number; nextStage?: PlanningRun["stage"] },
  clock: StoreClock,
): { revision: number; stage: PlanningRun["stage"] } {
  const active = getActiveSectionInTx(tx, input.runId);
  if (active !== null) {
    clearActiveSectionInTx(tx, input.runId);
  }
  const now = clock.nowIso();
  const sets = ["revision = revision + 1", "updated_at = ?"];
  const params: unknown[] = [now];
  if (input.nextStage !== undefined) {
    sets.push("stage = ?");
    params.push(input.nextStage);
  }
  params.push(input.runId, input.expectedRevision);
  const result = tx
    .prepare(`UPDATE planning_runs SET ${sets.join(", ")} WHERE run_id = ? AND revision = ?`)
    .run(...params) as { changes?: number };
  if ((result.changes ?? 0) !== 1) {
    throw runStateError("STALE_RUN_REVISION", "run revision changed during the workflow mutation", {
      runId: input.runId,
      expected: input.expectedRevision,
    });
  }
  return {
    revision: input.expectedRevision + 1,
    stage: input.nextStage ?? parsePlanningRunRow(
      tx.prepare(`${SELECT_RUN} WHERE run_id = ?`).get(input.runId) as Record<string, unknown>,
    ).stage,
  };
}

/**
 * §45–§48 — the Evidence → Section review bridge. Given the exact Evidence
 * revisions whose authoritative basis REALLY changed (SOURCE_CHANGED,
 * REPLACED, INVALIDATED, or a propagated real UPSTREAM_CHANGED — never a
 * FILE_CHANGED_HINT, §46), every completed Section whose completion
 * Proposal required exactly that Evidence revision transitions to
 * needs_review (EVIDENCE_REVIEW_REQUIRED), then completed downstream
 * Sections follow recursively. Provenance is exact (§47): only the
 * completion Proposal's requiredEvidence refs match — claims are never
 * scanned and conversation is never consulted. Supporting/informational
 * Evidence never triggers review.
 */
export function propagateEvidenceSectionReviewInTx(
  tx: StoreTx,
  input: {
    runId: string;
    headSectionRefs: MemoryRef[];
    affectedEvidence: Array<{ evidenceId: string; revision: number }>;
    requestId?: string | null;
  },
  clock: StoreClock,
): { directlyAffected: string[]; downstreamAffected: string[] } {
  if (input.affectedEvidence.length === 0) return { directlyAffected: [], downstreamAffected: [] };
  const directlyAffected: string[] = [];
  for (const evidence of input.affectedEvidence) {
    const rows = tx
      .prepare(
        "SELECT s.section_id AS sectionId FROM section_workflow_states s "
        + "JOIN proposal_evidence_refs r ON r.run_id = s.run_id "
        + "AND r.proposal_id = s.completed_proposal_id AND r.proposal_revision = s.completed_proposal_revision "
        + "JOIN evidence_revisions e ON e.run_id = r.run_id AND e.evidence_id = r.evidence_id AND e.revision = r.evidence_revision "
        + "WHERE s.run_id = ? AND s.status = 'completed' "
        + "AND r.evidence_id = ? AND r.evidence_revision = ? AND e.criticality = 'critical'",
      )
      .all(input.runId, evidence.evidenceId, evidence.revision) as Array<{ sectionId: string }>;
    for (const row of rows.map((entry) => entry.sectionId).sort()) {
      const state = getSectionWorkflowStateInTx(tx, input.runId, row);
      if (state === null || state.status !== "completed") continue;
      transitionSectionWorkflowInTx(
        tx,
        {
          runId: input.runId,
          sectionId: row,
          eventType: "EVIDENCE_REVIEW_REQUIRED",
          reasonCode: "critical_evidence_basis_changed",
          detail: { evidenceId: evidence.evidenceId, evidenceRevision: evidence.revision },
          ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
        },
        clock,
      );
      directlyAffected.push(row);
    }
  }
  // §48 — completed downstream Sections follow, recursively.
  const downstreamAffected = propagateDependencyReviewInTx(
    tx,
    {
      runId: input.runId,
      headSectionRefs: input.headSectionRefs,
      reopenedIds: directlyAffected,
      requestId: input.requestId,
    },
    clock,
  );
  return { directlyAffected: directlyAffected.sort(), downstreamAffected };
}
