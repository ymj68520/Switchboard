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
    | "EXECUTION_ISSUE_AMBIGUOUS"
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
  /**
   * E9 §31 — present exactly when this successor was created through the
   * CONTROLLED RETURN from a replan_required ExecutionRun: the exact terminal
   * execution world and its ONE replan ExecutionIssue.
   */
  replan?: { predecessorExecutionRunId: string; issueId: string };
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
        // A1 §23/§28 — the entry authority is the session's attached
        // SupervisorBinding (canonical current supervision ownership). The
        // legacy ExecutionBinding is initial-handoff metadata and is NEVER
        // consulted as live authority.
        const supervision = tx
          .prepare(
            "SELECT execution_run_id AS executionRunId, workspace_id AS workspaceId, "
            + "session_id AS sessionId, state, generation FROM supervisor_bindings "
            + "WHERE session_id = ? AND state = 'attached'",
          )
          .get(input.sessionId) as
          | { executionRunId: string; workspaceId: string; sessionId: string; state: "attached" | "detached"; generation: number }
          | undefined;
        const boundRun =
          supervision !== undefined && supervision.workspaceId === input.workspaceId
            ? (tx
                .prepare("SELECT run_id AS runId, final_plan_id AS finalPlanId, lifecycle FROM execution_runs WHERE execution_run_id = ?")
                .get(supervision.executionRunId) as { runId: string; finalPlanId: string; lifecycle: string } | undefined)
            : undefined;
        let predecessorRunId: string;
        let predecessorExecutionRunId: string;
        let boundFinalPlanId: string | null = null;
        let replanProvenance: { predecessorExecutionRunId: string; issueId: string } | null = null;
        if (supervision !== undefined && boundRun !== undefined && boundRun.lifecycle !== "replan_required") {
          predecessorRunId = boundRun.runId;
          predecessorExecutionRunId = supervision.executionRunId;
          boundFinalPlanId = boundRun.finalPlanId;
        } else {
          // E9 §30–§33 — no attached Build binding: this may be the CONTROLLED
          // RETURN from a replan_required ExecutionRun (a session with a
          // pending replan ExecutionIssue). Core resolves the context — never
          // the model — and the SAME baseline/adoptions/scope machinery below
          // creates the successor PlanningRun.
          // §22/§73 — a session with NO replan heritage keeps the exact v0.1
          // STALE refusal (a vanished binding is never silently reinterpreted
          // as replan entry).
          const replan = tryResolveReplanEntryInTx(tx, input);
          if (replan === null) {
            throw successorError(
              "STALE_EXECUTION_BINDING",
              "successor creation requires the session's attached ExecutionBinding in this workspace",
            );
          }
          replanProvenance = { predecessorExecutionRunId: replan.predecessorExecutionRunId, issueId: replan.issueId };
          predecessorRunId = replan.predecessorRunId;
          predecessorExecutionRunId = replan.predecessorExecutionRunId;
        }

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
        const openIssues = listOpenExecutionIssuesInTx(tx, predecessorExecutionRunId);
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
          (boundFinalPlanId !== null && finalPlanRow.finalPlanId !== boundFinalPlanId) ||
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
            // v1 build issues carry affectedRefs; the E9 replan issue carries
            // affectedNormativeRefs — the same exact-ref vocabulary.
            affectedRefs?: ExecutionIssueAffectedRef[];
            affectedNormativeRefs?: ExecutionIssueAffectedRef[];
          };
          return {
            issueId: issue.issueId,
            issueHash: issue.issueHash,
            kind: canonical.kind,
            affectedRefs: canonical.affectedRefs ?? canonical.affectedNormativeRefs ?? [],
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
              executionRunId: predecessorExecutionRunId,
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
        // E9 — on the replan-controlled-return path the Build binding already
        // detached at handoff delivery, so a null detach is the EXPECTED
        // terminal-world state, not a failure.
        const detachedBinding = detachExecutionBindingInTx(
          tx,
          { runId: predecessorRunId, sessionId: input.sessionId },
          now,
        );
        if (detachedBinding === null && replanProvenance === null) {
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
          predecessorExecutionBinding: { state: "detached" as const, generation: detachedBinding?.generation ?? 0 },
          planningBinding: { state: "attached" as const, generation: planningBinding.generation },
          ...(replanProvenance === null ? {} : { replan: replanProvenance }),
        };
      });
    },

    /**
     * E9 §33 — replan-boundary classification for the entry flow: the
     * session's replan context (or the workspace's unique one), the pending
     * issue, and whether the successor already exists.
     */
    classifyReplanEntry(workspaceId: string, sessionId: string): {
      replanRunId: string | null;
      issueId: string | null;
      successorRunId: string | null;
      ambiguous: boolean;
    } {
      return store.withRead((tx) => {
        try {
          const resolved = resolveReplanEntryInTx(tx, { workspaceId, sessionId });
          const baseline = getPlanningRunBaselineForPredecessorInTx(tx, resolved.predecessorRunId);
          return {
            replanRunId: resolved.predecessorRunId,
            issueId: resolved.issueId,
            successorRunId: baseline?.successorRunId ?? null,
            ambiguous: false,
          };
        } catch (err) {
          if (err instanceof RuntimeError && err.code === "EXECUTION_ISSUE_AMBIGUOUS") {
            return { replanRunId: null, issueId: null, successorRunId: null, ambiguous: true };
          }
          // E9 §32 — an ADOPTED replan issue (the successor already started)
          // still resolves: converge on the existing successor.
          for (const bindingRow of tx
            .prepare("SELECT execution_run_id AS executionRunId FROM supervisor_bindings WHERE session_id = ? ORDER BY created_at, execution_run_id")
            .all(sessionId) as Array<{ executionRunId: string }>) {
            const adopted = tx
              .prepare(
                "SELECT i.issue_id AS issueId, a.successor_run_id AS successorRunId FROM execution_issues i "
                + "JOIN execution_issue_adoptions a ON a.execution_run_id = i.execution_run_id AND a.issue_id = i.issue_id "
                + "WHERE i.execution_run_id = ? AND i.kind = 'replan_required' LIMIT 1",
              )
              .get(bindingRow.executionRunId) as { issueId: string; successorRunId: string } | undefined;
            if (adopted !== undefined) {
              const provenance = tx
                .prepare("SELECT run_id AS runId FROM execution_runs WHERE execution_run_id = ?")
                .get(bindingRow.executionRunId) as { runId: string } | undefined;
              return {
                replanRunId: provenance?.runId ?? bindingRow.executionRunId,
                issueId: adopted.issueId,
                successorRunId: adopted.successorRunId,
                ambiguous: false,
              };
            }
          }
          return { replanRunId: null, issueId: null, successorRunId: null, ambiguous: false };
        }
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
        // §23 — classification rides the session's ExecutionBinding (it
        // survives the replan's supervision detach). A1 §16 — the open-issue
        // count is scoped by the canonical ExecutionRunID resolved from the
        // binding's source-planning provenance.
        const binding = tx
          .prepare(
            "SELECT run_id AS runId, workspace_id AS workspaceId FROM execution_bindings "
            + "WHERE session_id = ? AND state = 'attached'",
          )
          .get(sessionId) as { runId: string; workspaceId: string } | undefined;
        if (binding === undefined || binding.workspaceId !== workspaceId) {
          return { bound: false, openIssues: 0, successorRunId: null };
        }
        const boundExecutionRun = tx
          .prepare("SELECT execution_run_id AS executionRunId FROM execution_runs WHERE run_id = ?")
          .get(binding.runId) as { executionRunId: string } | undefined;
        const executionRunId = boundExecutionRun?.executionRunId ?? binding.runId;
        const existing = getPlanningRunBaselineForPredecessorInTx(tx, binding.runId);
        return {
          bound: true,
          openIssues: countOpenExecutionIssuesInTx(tx, executionRunId),
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

/**
 * E9 §33 — resolve the replan-controlled-return context. The session's own
 * supervisor binding (attached or detached provenance) on a replan_required
 * ExecutionRun with a pending issue proves a UNIQUE replan context; otherwise
 * the workspace's replan context must be unique — multiple pending issues are
 * never guessed (EXECUTION_ISSUE_AMBIGUOUS).
 */
function tryResolveReplanEntryInTx(
  tx: StoreTx,
  input: CreateSuccessorInput,
): { predecessorRunId: string; predecessorExecutionRunId: string; issueId: string } | null {
  try {
    return resolveReplanEntryInTx(tx, input);
  } catch (err) {
    if (err instanceof RuntimeError && err.code === "EXECUTION_ISSUE_AMBIGUOUS") {
      throw err;
    }
    return null;
  }
}

function resolveReplanEntryInTx(
  tx: StoreTx,
  input: CreateSuccessorInput,
): { predecessorRunId: string; predecessorExecutionRunId: string; issueId: string } {
  // The replan issue resolves whether OPEN or already ADOPTED: an adopted
  // issue routes re-entry into the body's SUCCESSOR_RUN_ALREADY_STARTED
  // convergence (E9 §32) instead of a misleading "no pending issue".
  for (const bindingRow of tx
    .prepare("SELECT execution_run_id AS executionRunId FROM supervisor_bindings WHERE session_id = ? ORDER BY created_at, execution_run_id")
    .all(input.sessionId) as Array<{ executionRunId: string }>) {
    const issue = tx
      .prepare("SELECT issue_id AS id FROM execution_issues WHERE execution_run_id = ? AND kind = 'replan_required' ORDER BY created_at LIMIT 1")
      .get(bindingRow.executionRunId) as { id: string } | undefined;
    if (issue === undefined) continue;
    const executionRun = tx
      .prepare("SELECT run_id AS runId, lifecycle FROM execution_runs WHERE execution_run_id = ?")
      .get(bindingRow.executionRunId) as { runId: string | null; lifecycle: string } | undefined;
    if (executionRun !== undefined && executionRun.lifecycle === "replan_required") {
      return { predecessorRunId: executionRun.runId ?? bindingRow.executionRunId, predecessorExecutionRunId: bindingRow.executionRunId, issueId: issue.id };
    }
  }
  const candidates = tx
    .prepare(
      "SELECT DISTINCT er.run_id AS runId, er.execution_run_id AS executionRunId FROM execution_runs er "
      + "JOIN execution_issues i ON i.execution_run_id = er.execution_run_id AND i.kind = 'replan_required' "
      + "WHERE er.lifecycle = 'replan_required' "
      + "AND er.workspace_id IN (SELECT workspace_id FROM execution_runs WHERE execution_run_id IN "
      + "(SELECT execution_run_id FROM supervisor_bindings WHERE session_id = ?))",
    )
    .all(input.sessionId) as Array<{ runId: string; executionRunId: string | null }>;
  if (candidates.length === 0) {
    throw successorError("EXECUTION_ISSUE_REQUIRED", "no pending replan ExecutionIssue exists for this session's workspace (E9 §30)");
  }
  if (candidates.length > 1) {
    throw successorError(
      "EXECUTION_ISSUE_AMBIGUOUS",
      "multiple pending replan ExecutionIssues exist in this workspace; disambiguate through the exact issue's entry flow (E9 §33)",
      { detail: { runs: candidates.map((c) => c.runId) } },
    );
  }
  const candidate = candidates[0]!;
  const issue = tx
    .prepare("SELECT issue_id AS id FROM execution_issues WHERE run_id = ? AND kind = 'replan_required' ORDER BY created_at LIMIT 1")
    .get(candidate.runId) as { id: string } | undefined;
  if (issue === undefined) {
    throw successorError("EXECUTION_ISSUE_REQUIRED", "the replan issue vanished during entry resolution (E9 §33)");
  }
  return { predecessorRunId: candidate.runId, predecessorExecutionRunId: candidate.executionRunId ?? "", issueId: issue.id };
}
