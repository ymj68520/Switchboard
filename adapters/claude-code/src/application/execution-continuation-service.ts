/**
 * Execution Continuation application service (Phase Plan v0.2.0 P1).
 *
 * Incremental Replan & Execution Continuation:
 * Allows a successor ExecutionRun (born from a replan-prompted PlanningRun and
 * approved successor FinalPlan) to safely inherit and reuse previously accepted
 * ExecutionStages, ExecutionCommits, and workspace achievements while ensuring:
 *
 *   1. Predecessor ExecutionRun and FinalPlan remain permanently immutable.
 *   2. The new ExecutionRun explicitly binds its predecessor ExecutionRun lineage.
 *   3. Reused achievements must satisfy both workspace reality (verified on disk)
 *      and dependency contracts (all prerequisite stages satisfied).
 *   4. Stages affected by the normative design amendment (needs_review in baseline
 *      scopes) or whose dependencies changed are marked pending and must be
 *      implemented and independently verified.
 *   5. No old Attempts that had side effects are automatically repeated.
 *   6. Cross-stage integration gates and final closure gates remain intact.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { StoreTx } from "../store/transaction.js";
import type { StoreClock } from "../store/migration-runner.js";
import {
  getPlanningRunBaselineForSuccessorInTx,
  listBaselineScopesInTx,
  type BaselineScopeRow,
} from "../store/successor-baselines.js";
import {
  getExecutionRunBySourcePlanningRunInTx,
} from "../store/execution-runs.js";
import {
  getExecutionStructureInTx,
  type ExecutionStructure,
} from "./execution-structure-service.js";
import {
  insertExecutionStageInTx,
  insertOpenWindowInTx,
  listExecutionStagesInTx,
} from "../store/execution-structure.js";
import {
  getExecutionCommitInTx,
  listRunCommitsInTx,
} from "../store/execution-commits.js";
import { getExecutionReportInTx } from "../store/execution-reports.js";
import { getFinalPlanInTx } from "../store/finalization.js";
import { parseFinalPlanCanonical } from "./final-plan-canonical.js";
import { activateExecutionStageInTx } from "../store/execution-structure.js";

export type StageReuseDisposition = "reusable" | "needs_reverification" | "must_reimplement";

export interface StageReuseDetermination {
  sourceStepId: string;
  predecessorStageId: string | null;
  predecessorCommitId: string | null;
  disposition: StageReuseDisposition;
  reason: string;
  workspaceVerified: boolean;
  contractVerified: boolean;
}

export interface ContinuationEvaluationResult {
  isContinuation: boolean;
  predecessorExecutionRunId: string | null;
  predecessorRunId: string | null;
  determinations: StageReuseDetermination[];
  seedAcceptedHeadCommitId: string | null;
}

/**
 * Determine stage reuse eligibility for an ExecutionRun based on its
 * predecessor PlanningRunBaseline and previous ExecutionRun artifacts.
 */
export function determineContinuationReuseInTx(
  tx: StoreTx,
  executionRunId: string,
): ContinuationEvaluationResult {
  const executionRun = tx
    .prepare("SELECT run_id AS runId, workspace_id AS workspaceId FROM execution_runs WHERE execution_run_id = ?")
    .get(executionRunId) as { runId: string; workspaceId: string } | undefined;
  if (!executionRun) {
    return {
      isContinuation: false,
      predecessorExecutionRunId: null,
      predecessorRunId: null,
      determinations: [],
      seedAcceptedHeadCommitId: null,
    };
  }

  // 1. Successor baseline check: was this PlanningRun born from a predecessor?
  const baseline = getPlanningRunBaselineForSuccessorInTx(tx, executionRun.runId);
  if (!baseline) {
    return {
      isContinuation: false,
      predecessorExecutionRunId: null,
      predecessorRunId: null,
      determinations: [],
      seedAcceptedHeadCommitId: null,
    };
  }

  // 2. Predecessor ExecutionRun check
  const predecessorExecutionRun = getExecutionRunBySourcePlanningRunInTx(tx, baseline.predecessorRunId);
  if (!predecessorExecutionRun) {
    return {
      isContinuation: false,
      predecessorExecutionRunId: null,
      predecessorRunId: baseline.predecessorRunId,
      determinations: [],
      seedAcceptedHeadCommitId: null,
    };
  }

  // 3. Retrieve workspace root for physical verification
  const wsRow = tx
    .prepare("SELECT canonical_root AS canonicalRoot FROM workspaces WHERE workspace_id = ?")
    .get(executionRun.workspaceId) as { canonicalRoot: string } | undefined;
  const workspaceRoot = wsRow?.canonicalRoot ?? "";

  // 4. Retrieve predecessor stages, commits, and baseline scopes
  const predecessorStages = listExecutionStagesInTx(tx, predecessorExecutionRun.executionRunId);
  const predecessorCommits = listRunCommitsInTx(tx, predecessorExecutionRun.executionRunId);
  const baselineScopes = listBaselineScopesInTx(tx, baseline.baselineId);
  const scopeBySection = new Map(baselineScopes.map((s: BaselineScopeRow) => [s.sectionId, s.scopeState]));

  // 5. Parse current approved FinalPlan implementation steps
  const finalPlanRow = getFinalPlanInTx(tx, executionRun.runId);
  if (!finalPlanRow) {
    return {
      isContinuation: false,
      predecessorExecutionRunId: predecessorExecutionRun.executionRunId,
      predecessorRunId: baseline.predecessorRunId,
      determinations: [],
      seedAcceptedHeadCommitId: null,
    };
  }
  const plan = parseFinalPlanCanonical(finalPlanRow.canonicalJson, executionRunId);
  const steps = plan.implementationOrder;

  const determinations: StageReuseDetermination[] = [];
  const reusedStepIds = new Set<string>();
  let latestReusedCommitId: string | null = null;
  let latestReusedCommitSeq = -1;

  for (const step of steps) {
    const predStage = predecessorStages.find((s) => s.sourceStepId === step.stepId);
    if (!predStage || predStage.status !== "completed" || !predStage.completedByCommitId) {
      determinations.push({
        sourceStepId: step.stepId,
        predecessorStageId: predStage?.id ?? null,
        predecessorCommitId: null,
        disposition: "must_reimplement",
        reason: "no completed predecessor stage exists for this step",
        workspaceVerified: false,
        contractVerified: false,
      });
      continue;
    }

    // Check baseline scopes for the supporting sections of this step
    const stepSectionIds = step.supportingRefs
      .filter((ref) => ref.kind === "section")
      .map((ref) => ref.id);
    const hasNeedsReviewSection = stepSectionIds.some((secId) => scopeBySection.get(secId) === "needs_review");
    if (hasNeedsReviewSection) {
      determinations.push({
        sourceStepId: step.stepId,
        predecessorStageId: predStage.id,
        predecessorCommitId: predStage.completedByCommitId,
        disposition: "must_reimplement",
        reason: "supporting section was marked needs_review in replan baseline",
        workspaceVerified: false,
        contractVerified: false,
      });
      continue;
    }

    // Check dependency contracts: all dependsOn steps must be reusable
    const dependenciesSatisfied = step.dependsOn.every((depId) => reusedStepIds.has(depId));
    if (!dependenciesSatisfied) {
      determinations.push({
        sourceStepId: step.stepId,
        predecessorStageId: predStage.id,
        predecessorCommitId: predStage.completedByCommitId,
        disposition: "must_reimplement",
        reason: "one or more prerequisite steps were not reusable",
        workspaceVerified: false,
        contractVerified: false,
      });
      continue;
    }

    // Check physical workspace reality: verify that files produced/changed exist
    let workspaceVerified = true;
    let workspaceReason = "";
    if (workspaceRoot !== "") {
      const commit = getExecutionCommitInTx(tx, predStage.completedByCommitId);
      if (commit) {
        for (const reportRef of commit.reportRefs) {
          const report = getExecutionReportInTx(tx, reportRef.reportId);
          if (report && report.filesChanged.length > 0) {
            for (const relFile of report.filesChanged) {
              const absFile = path.resolve(workspaceRoot, relFile);
              if (!fs.existsSync(absFile)) {
                workspaceVerified = false;
                workspaceReason = `deliverable file '${relFile}' is missing from workspace on disk`;
                break;
              }
            }
          }
          if (!workspaceVerified) break;
        }
      }
    }

    if (!workspaceVerified) {
      determinations.push({
        sourceStepId: step.stepId,
        predecessorStageId: predStage.id,
        predecessorCommitId: predStage.completedByCommitId,
        disposition: "must_reimplement",
        reason: workspaceReason,
        workspaceVerified: false,
        contractVerified: true,
      });
      continue;
    }

    // Both contract and workspace verified: stage is reusable
    reusedStepIds.add(step.stepId);
    determinations.push({
      sourceStepId: step.stepId,
      predecessorStageId: predStage.id,
      predecessorCommitId: predStage.completedByCommitId,
      disposition: "reusable",
      reason: "predecessor stage completed, contracts unchanged, and workspace verified",
      workspaceVerified: true,
      contractVerified: true,
    });

    // Track latest commit for seeding accepted head
    const predCommit = predecessorCommits.find((c) => c.commitId === predStage.completedByCommitId);
    if (predCommit && predCommit.sequence > latestReusedCommitSeq) {
      latestReusedCommitSeq = predCommit.sequence;
      latestReusedCommitId = predCommit.commitId;
    }
  }

  return {
    isContinuation: true,
    predecessorExecutionRunId: predecessorExecutionRun.executionRunId,
    predecessorRunId: baseline.predecessorRunId,
    determinations,
    seedAcceptedHeadCommitId: latestReusedCommitId,
  };
}

/**
 * Attempt to seed execution structure from a predecessor run's continuation.
 * Returns null if not a continuation run.
 */
export function tryApplyContinuationStructureInTx(
  tx: StoreTx,
  executionRunId: string,
  clock: StoreClock,
  now: string,
): ExecutionStructure | null {
  const evalResult = determineContinuationReuseInTx(tx, executionRunId);
  if (!evalResult.isContinuation || evalResult.determinations.length === 0) {
    return null;
  }

  const runRow = tx
    .prepare("SELECT run_id AS runId FROM execution_runs WHERE execution_run_id = ?")
    .get(executionRunId) as { runId: string } | undefined;
  if (!runRow) return null;

  const finalPlanRow = getFinalPlanInTx(tx, runRow.runId);
  if (!finalPlanRow) return null;
  const plan = parseFinalPlanCanonical(finalPlanRow.canonicalJson, executionRunId);
  const steps = plan.implementationOrder;

  // Map determinations by stepId
  const detByStep = new Map(evalResult.determinations.map((d) => [d.sourceStepId, d]));

  // 1. Insert all stages, marking reusable ones completed
  steps.forEach((step, index) => {
    const stageId = `stage_${clock.newId()}`;
    const det = detByStep.get(step.stepId);
    const isReusable = det?.disposition === "reusable" && det.predecessorCommitId !== null;

    insertExecutionStageInTx(
      tx,
      {
        id: stageId,
        executionRunId,
        ordinal: index + 1,
        status: "pending",
        objective: `${step.title} — ${step.description}`,
        sourceStepId: step.stepId,
        dependsOn: [...step.dependsOn],
        sourceRefs: step.supportingRefs.map((ref) => ({ kind: ref.kind, id: ref.id, revision: ref.revision })),
      },
      now,
    );

    if (isReusable) {
      // Transition pending stage to completed with predecessor commit provenance
      tx.prepare(
        "UPDATE execution_stages SET status = 'completed', completed_by_commit_id = ?, updated_at = ? WHERE id = ?",
      ).run(det.predecessorCommitId, now, stageId);
    }
  });

  // 2. If reusable stages yielded a seed accepted head, update execution_runs
  if (evalResult.seedAcceptedHeadCommitId !== null) {
    tx.prepare(
      "UPDATE execution_runs SET accepted_head_commit_id = ?, updated_at = ? WHERE execution_run_id = ?",
    ).run(evalResult.seedAcceptedHeadCommitId, now, executionRunId);
  }

  // 3. Find earliest eligible pending stage to activate
  const structureAfterInsert = getExecutionStructureInTx(tx, executionRunId);
  const completedStepIds = new Set(
    structureAfterInsert.stages
      .filter((s) => s.status === "completed" && s.sourceStepId !== null)
      .map((s) => s.sourceStepId as string),
  );

  const eligiblePending = structureAfterInsert.stages
    .filter((s) => s.status === "pending")
    .filter((s) => s.dependsOn.every((dep) => completedStepIds.has(dep)))
    .sort((a, b) => a.ordinal - b.ordinal);

  if (eligiblePending.length > 0) {
    const nextStage = eligiblePending[0]!;
    activateExecutionStageInTx(tx, nextStage.id, now);

    // Open first window for the active stage, rooted in the seed accepted head or execution_start
    insertOpenWindowInTx(
      tx,
      {
        executionRunId,
        stageId: nextStage.id,
        windowId: `win_${clock.newId()}`,
        base: evalResult.seedAcceptedHeadCommitId !== null
          ? { kind: "execution_commit", commitId: evalResult.seedAcceptedHeadCommitId }
          : { kind: "execution_start" },
      },
      now,
    );
  }

  return getExecutionStructureInTx(tx, executionRunId);
}
