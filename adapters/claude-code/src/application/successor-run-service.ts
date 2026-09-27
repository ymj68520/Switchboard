/**
 * Successor PlanningRun creation service (Phase 15 §22–§43/§70–§77).
 *
 * The ONE production path from a defect-discovering Build session back into
 * planning: explicit /phase-plan intent (verified by the caller) over an
 * attached ExecutionBinding with at least one open ExecutionIssue creates a
 * NEW PlanningRun against the immutable predecessor FinalPlan baseline.
 *
 * The whole creation is ONE store transaction (§38):
 *   validate execution authority → validate the open issue set → derive the
 *   affected scope (Core-derived, §32–§34) → create the successor run →
 *   freeze the immutable PlanningRunBaseline (§26) → bind the exact issue set
 *   (§31) → record per-Section scope (§55) → append the DB-fenced adoptions
 *   (§17/§74) → attach the successor planning SessionBinding (generation 1,
 *   §40) → detach the predecessor ExecutionBinding (generation +1, §39).
 *
 * Absolute boundaries (§25/§42/§43): the predecessor run is NEVER reactivated
 * (completed → completed forever), its FinalPlan/HEAD/handoff are NEVER
 * rewritten, and NO fake Proposal/Approval/PlanCommit/snapshot/HEAD is ever
 * fabricated — the successor starts with NO local Plan Memory at all; the
 * baseline materializes only inside the first authorized successor PlanCommit
 * (§51).
 */

import { canonicalJson } from "../core/canonical-json.js";
import {
  deriveAffectedScope,
  type DerivedAffectedScope,
} from "../core/execution-issue.js";
import type { ExecutionIssueAffectedRef, ExecutionIssueKind } from "../core/execution-issue.js";
import {
  baselineIssueSetHash,
  planningRunBaselineHash,
  type BaselineIssueEntry,
  type PlanningRunBaselineV1,
} from "../core/successor-baseline.js";
import { parsePlanningRunRow, type PlanningRun } from "../core/planning-run.js";
import { parseFinalPlanCanonical, deriveRepositoryBaseline } from "./handoff-service.js";
import { sectionDependenciesInTx } from "./section-workflow-service.js";
import { RuntimeError } from "../runtime/errors.js";
import {
  countOpenExecutionIssuesInTx,
  insertExecutionIssueAdoptionInTx,
  listOpenExecutionIssuesInTx,
} from "../store/execution-issues.js";
import { getExecutionHandoffInTx, getExecutionHandoffStateInTx, detachExecutionBindingInTx } from "../store/execution.js";
import { getFinalPlanInTx } from "../store/finalization.js";
import { insertPlanningRunBaselineInTx, getPlanningRunBaselineForPredecessorInTx, listBaselineScopesInTx, type BaselineScopeRow } from "../store/successor-baselines.js";
import { insertAttachedBindingInTx } from "../store/session-bindings.js";
import type { PlanStore } from "../store/sqlite-store.js";
import type { StoreClock } from "../store/migration-runner.js";
import type { StoreTx } from "../store/transaction.js";

function successorError(
  code:
    | "EXECUTION_ISSUE_REQUIRED"
    | "SUCCESSOR_RUN_ALREADY_STARTED"
    | "HANDOFF_NOT_AUTHORIZED"
    | "STALE_EXECUTION_BINDING",
  message: string,
  detail?: Record<string, unknown>,
): RuntimeError {
  return new RuntimeError(code, message, { detail });
}

export interface CreateSuccessorInput {
  workspaceId: string;
  sessionId: string;
}

export interface SuccessorCreationResult {
  status: "started_successor";
  successorRun: PlanningRun;
  initialStage: "architecture" | "detail";
  baseline: {
    baselineId: string;
    baselineHash: string;
    issueSetHash: string;
    predecessorRunId: string;
    finalPlanId: string;
    finalPlanHash: string;
    executionHandoffId: string;
    repositoryAtReplanStart: { kind: "git" | "directory"; revision: string | null };
  };
  adoptedIssues: Array<{ issueId: string; issueHash: string; kind: ExecutionIssueKind; affectedRefs: ExecutionIssueAffectedRef[] }>;
  affectedScope: DerivedAffectedScope;
  predecessorExecutionBinding: { state: "detached"; generation: number };
  planningBinding: { state: "attached"; generation: number };
}

/** A FinalPlan decision's declared scope string, read from committed content. */
function decisionScopeInTx(tx: StoreTx, runId: string, id: string, revision: number): string | null {
  const row = tx
    .prepare(
      "SELECT content_json AS contentJson FROM memory_revisions "
      + "WHERE run_id = ? AND kind = 'decision' AND artifact_id = ? AND revision = ?",
    )
    .get(runId, id, revision) as { contentJson: string } | undefined;
  if (row === undefined) return null;
  try {
    const content = JSON.parse(row.contentJson) as { scope?: unknown };
    return typeof content.scope === "string" ? content.scope : null;
  } catch {
    return null;
  }
}

export function createSuccessorRunService(store: PlanStore, clock: StoreClock) {
  return {
    /**
     * §22–§43 — the successor creation transaction. The caller must already
     * have verified the fresh signed EntryIntent (§24); this layer validates
     * the execution world and the open issue set inside the write
     * transaction, so two racing /phase-plan entries resolve to exactly one
     * successor (§73) and every issue is adopted exactly once (§74).
     */
    createSuccessor(input: CreateSuccessorInput): SuccessorCreationResult {
      return store.withWrite((tx) => {
        // §22 — the entry authority is the attached ExecutionBinding of the
        // exact session; without it this is not a Build-bound session.
        const binding = tx
          .prepare(
            "SELECT run_id AS runId, workspace_id AS workspaceId, final_plan_id AS finalPlanId, "
            + "session_id AS sessionId, state, generation FROM execution_bindings "
            + "WHERE session_id = ? AND state = 'attached'",
          )
          .get(input.sessionId) as
          | { runId: string; workspaceId: string; finalPlanId: string; sessionId: string; state: "attached" | "detached"; generation: number }
          | undefined;
        if (binding === undefined || binding.workspaceId !== input.workspaceId) {
          throw successorError(
            "STALE_EXECUTION_BINDING",
            "successor creation requires the session's attached ExecutionBinding in this workspace",
          );
        }
        const predecessorRunId = binding.runId;

        const runRow = tx
          .prepare(
            "SELECT run_id AS runId, workspace_id AS workspaceId, lifecycle, stage, revision, goal, "
            + "created_at AS createdAt, updated_at AS updatedAt FROM planning_runs WHERE run_id = ?",
          )
          .get(predecessorRunId) as Record<string, unknown> | undefined;
        if (runRow === undefined) {
          throw successorError("HANDOFF_NOT_AUTHORIZED", `predecessor run '${predecessorRunId}' no longer exists`);
        }
        const predecessor = parsePlanningRunRow(runRow);
        // §25 — the predecessor is terminal history and stays that way; a
        // non-completed execution world is not a successor baseline.
        if (predecessor.lifecycle !== "completed") {
          throw successorError(
            "HANDOFF_NOT_AUTHORIZED",
            `the execution binding's run '${predecessorRunId}' is ${predecessor.lifecycle}, not a completed planning world`,
          );
        }

        // §83 — the race loser names the existing successor, never a silent
        // second creation: if the open set is gone, an adoption table row
        // proves the successor already started.
        const openIssues = listOpenExecutionIssuesInTx(tx, predecessorRunId);
        if (openIssues.length === 0) {
          const existing = getPlanningRunBaselineForPredecessorInTx(tx, predecessorRunId);
          if (existing !== null) {
            throw successorError(
              "SUCCESSOR_RUN_ALREADY_STARTED",
              `a successor PlanningRun already exists for predecessor '${predecessorRunId}'`,
              { detail: { successorRunId: existing.successorRunId, baselineId: existing.baselineId } },
            );
          }
          throw successorError(
            "EXECUTION_ISSUE_REQUIRED",
            "a Build-bound session needs at least one open ExecutionIssue before /phase-plan can create a successor run",
          );
        }

        const finalPlanRow = getFinalPlanInTx(tx, predecessorRunId);
        const handoffRow = getExecutionHandoffInTx(tx, predecessorRunId);
        const handoffState = getExecutionHandoffStateInTx(tx, predecessorRunId);
        if (
          finalPlanRow === null ||
          finalPlanRow.finalPlanId !== binding.finalPlanId ||
          handoffRow === null ||
          handoffState?.status !== "delivered"
        ) {
          throw successorError(
            "HANDOFF_NOT_AUTHORIZED",
            "successor creation requires the delivered handoff and approved FinalPlan of the execution binding",
          );
        }
        const plan = parseFinalPlanCanonical(finalPlanRow.canonicalJson, predecessorRunId);

        // §30 — the baseline adopts ALL currently-open issues, deterministically
        // ordered; the model never picks issue ids.
        const sortedIssues = [...openIssues].sort((a, b) => a.issueId.localeCompare(b.issueId));
        const entries: BaselineIssueEntry[] = sortedIssues.map((issue) => {
          const canonical = JSON.parse(issue.canonicalJson) as {
            kind: ExecutionIssueKind;
            affectedRefs: ExecutionIssueAffectedRef[];
          };
          return {
            issueId: issue.issueId,
            issueHash: issue.issueHash,
            kind: canonical.kind,
            affectedRefs: canonical.affectedRefs,
          };
        });
        const issueSetHash = baselineIssueSetHash(entries);

        // §32–§34 — Core-derived scope; no NLP over summary/detail, ever.
        const affectedScope = deriveAffectedScope(plan, entries, {
          sectionDependencies: (sectionId) => {
            const section = plan.sections.find((candidate) => candidate.sectionId === sectionId);
            return section === undefined ? [] : sectionDependenciesInTx(tx, predecessorRunId, sectionId, section.revision);
          },
          decisionScope: (id, revision) => decisionScopeInTx(tx, predecessorRunId, id, revision),
        });

        // §24/§62 — the repository reality at replan start, captured
        // server-side; the predecessor's handoff baseline is never rewritten.
        const workspaceRow = tx
          .prepare("SELECT kind, canonical_root AS canonicalRoot FROM workspaces WHERE workspace_id = ?")
          .get(input.workspaceId) as { kind: string; canonicalRoot: string } | undefined;
        if (workspaceRow === undefined) {
          throw successorError("HANDOFF_NOT_AUTHORIZED", `workspace '${input.workspaceId}' is not registered`);
        }
        const repositoryAtReplanStart = deriveRepositoryBaseline(workspaceRow.kind, workspaceRow.canonicalRoot);

        // §25/§36 — a NEW run id, never the predecessor's; initial stage is
        // architecture | detail only (a successor never passes through
        // discovery); the goal is inherited from the baseline design intent.
        const successorRunId = `plan_${clock.newId()}`;
        const now = clock.nowIso();
        tx.prepare(
          "INSERT INTO planning_runs (run_id, workspace_id, lifecycle, stage, revision, goal, created_at, updated_at) "
          + "VALUES (?, ?, 'active', ?, 1, ?, ?, ?)",
        ).run(successorRunId, input.workspaceId, affectedScope.initialStage, predecessor.goal, now, now);
        const successorRun = parsePlanningRunRow(
          tx
            .prepare(
              "SELECT run_id AS runId, workspace_id AS workspaceId, lifecycle, stage, revision, goal, "
              + "created_at AS createdAt, updated_at AS updatedAt FROM planning_runs WHERE run_id = ?",
            )
            .get(successorRunId) as Record<string, unknown>,
        );

        // §26 — the immutable baseline, one per successor run.
        const baselinePayload: PlanningRunBaselineV1 = {
          version: 1,
          successorRunId,
          predecessorRunId,
          finalPlanId: finalPlanRow.finalPlanId,
          finalPlanHash: finalPlanRow.finalPlanHash,
          finalSnapshotId: finalPlanRow.snapshotId,
          finalCommitId: finalPlanRow.commitId,
          executionHandoffId: handoffRow.handoffId,
          executionHandoffHash: handoffRow.handoffHash,
          issueSetHash,
          repositoryAtReplanStart,
        };
        const baselineId = `sbase_${clock.newId()}`;
        const baselineHash = planningRunBaselineHash(baselinePayload);
        // §31 — exact issue bindings; §55 — per-Section scope with the exact
        // origin MemoryRef of the predecessor design.
        const issueBindings = entries.map((entry, index) => ({
          baselineId,
          issueId: entry.issueId,
          position: index + 1,
        }));
        const scopeRows: BaselineScopeRow[] = plan.sections.map((section) => ({
          baselineId,
          sectionId: section.sectionId,
          scopeState: affectedScope.needsReviewSections.includes(section.sectionId) ? "needs_review" : "inherited_completed",
          originRunId: predecessorRunId,
          originSectionId: section.sectionId,
          originRevision: section.revision,
        }));
        // §17/§74 — append-only adoptions FIRST (planning_run_baseline_issues
        // FK-references the adoption row); UNIQUE(issue_id) is the DB fence.
        entries.forEach((entry, index) => {
          insertExecutionIssueAdoptionInTx(
            tx,
            {
              issueId: entry.issueId,
              runId: predecessorRunId,
              successorRunId,
              baselineId,
              position: index + 1,
            },
            now,
          );
        });
        insertPlanningRunBaselineInTx(
          tx,
          {
            baselineId,
            successorRunId,
            predecessorRunId,
            finalPlanId: baselinePayload.finalPlanId,
            finalPlanHash: baselinePayload.finalPlanHash,
            finalSnapshotId: baselinePayload.finalSnapshotId,
            finalCommitId: baselinePayload.finalCommitId,
            executionHandoffId: baselinePayload.executionHandoffId,
            executionHandoffHash: baselinePayload.executionHandoffHash,
            issueSetHash,
            repositoryKind: repositoryAtReplanStart.kind,
            repositoryRevision: repositoryAtReplanStart.revision,
            canonicalJson: canonicalJson(baselinePayload),
            baselineHash,
          },
          issueBindings,
          scopeRows,
          now,
        );

        // §40 — the successor planning SessionBinding: attached, generation
        // exactly 1, same session, same workspace. From here the full Phase 7
        // fencing applies to every successor mutation.
        const planningBinding = insertAttachedBindingInTx(
          tx,
          { runId: successorRunId, workspaceId: input.workspaceId, sessionId: input.sessionId },
          now,
        );

        // §39 — the predecessor ExecutionBinding detaches (+1): every
        // outstanding signed execution context fences as STALE immediately.
        const detachedBinding = detachExecutionBindingInTx(
          tx,
          { runId: predecessorRunId, sessionId: input.sessionId },
          now,
        );
        if (detachedBinding === null) {
          throw successorError(
            "STALE_EXECUTION_BINDING",
            "the execution binding vanished during successor creation",
          );
        }

        return {
          status: "started_successor" as const,
          successorRun,
          initialStage: affectedScope.initialStage,
          baseline: {
            baselineId,
            baselineHash,
            issueSetHash,
            predecessorRunId,
            finalPlanId: baselinePayload.finalPlanId,
            finalPlanHash: baselinePayload.finalPlanHash,
            executionHandoffId: baselinePayload.executionHandoffId,
            repositoryAtReplanStart,
          },
          adoptedIssues: entries.map((entry) => ({
            issueId: entry.issueId,
            issueHash: entry.issueHash,
            kind: entry.kind,
            affectedRefs: entry.affectedRefs,
          })),
          affectedScope,
          predecessorExecutionBinding: { state: "detached" as const, generation: detachedBinding.generation },
          planningBinding: { state: "attached" as const, generation: planningBinding.generation },
        };
      });
    },

    /**
     * §23 — a Build-bound session without an open issue can NEVER silently
     * create an issue-driven successor (the caller surfaces
     * EXECUTION_ISSUE_REQUIRED); §73 — a raced second entry names the
     * existing successor. Read-side classification for the MCP handler.
     */
    classifySuccessorEntry(workspaceId: string, sessionId: string): {
      bound: boolean;
      openIssues: number;
      successorRunId: string | null;
    } {
      return store.withRead((tx) => {
        const binding = tx
          .prepare(
            "SELECT run_id AS runId, workspace_id AS workspaceId FROM execution_bindings "
            + "WHERE session_id = ? AND state = 'attached'",
          )
          .get(sessionId) as { runId: string; workspaceId: string } | undefined;
        if (binding === undefined || binding.workspaceId !== workspaceId) {
          return { bound: false, openIssues: 0, successorRunId: null };
        }
        const existing = getPlanningRunBaselineForPredecessorInTx(tx, binding.runId);
        return {
          bound: true,
          openIssues: countOpenExecutionIssuesInTx(tx, binding.runId),
          successorRunId: existing?.successorRunId ?? null,
        };
      });
    },

    /** §56 — effective per-Section state merge helper (store-side read). */
    baselineScopesForSuccessor(successorRunId: string): BaselineScopeRow[] {
      return store.withRead((tx) => {
        const baseline = getPlanningRunBaselineForPredecessorInTx(tx, successorRunId);
        if (baseline === null) return [];
        return listBaselineScopesInTx(tx, baseline.baselineId);
      });
    },
  };
}

export type SuccessorRunService = ReturnType<typeof createSuccessorRunService>;
