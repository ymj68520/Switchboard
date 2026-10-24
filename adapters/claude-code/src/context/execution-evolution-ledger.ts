/**
 * Execution Evolution Ledger projection (Phase Plan v0.2.0 P3).
 *
 * Prevents long-horizon supervisor reasoning drift across multi-stage runs by
 * structuring context into three explicit, non-drifting layers:
 *
 *   L0: Normative Context
 *       Authoritative invariants, goals, decisions, constraints, and section contracts
 *       derived directly from the immutable approved FinalPlan.
 *
 *   L1: Execution Evolution Context
 *       Durable engineering facts derived from accepted ExecutionCommits and their
 *       verified reports: completed stages, cross-stage contracts, engineering
 *       discoveries, unresolved risks, and superseded assumptions with validity status.
 *
 *   L2: Recent Working Context
 *       Bounded recency window over the current window's active directives,
 *       worker attempts, latest reports, and assessments.
 *
 * Invariant: Compaction or session restart reconstructs L0/L1/L2 deterministically
 * from the Store without relying on conversational summaries.
 */

import { getFinalPlanInTx } from "../store/finalization.js";
import { parseFinalPlanCanonical } from "../application/final-plan-canonical.js";
import { getExecutionRunInTx } from "../store/execution-runs.js";
import {
  listExecutionStagesInTx,
  getOpenWindowInTx,
} from "../store/execution-structure.js";
import {
  listRunCommitsInTx,
  getExecutionCommitInTx,
  getAcceptedHeadCommitIdInTx,
} from "../store/execution-commits.js";
import { getExecutionReportInTx, listRunReportsInTx } from "../store/execution-reports.js";
import type { ExecutionReport } from "../core/execution-report.js";
import { listRunDirectivesInTx } from "../store/execution-directives.js";
import { listRunAttemptsInTx } from "../store/execution-attempts.js";
import { listRunAssessmentsInTx } from "../store/supervisor-assessments.js";
import type { StoreTx } from "../store/transaction.js";

export interface L0NormativeContext {
  runGoal: string;
  finalPlan: { id: string; revision: number; hash: string };
  hardConstraints: Array<{ id: string; revision: number; statement: string }>;
  architectureInvariants: Array<{ statement: string; sourceRef?: string }>;
  sectionContracts: Array<{
    sectionId: string;
    revision: number;
    title: string;
    interfaceExports: string[];
    dependencies: string[];
  }>;
}

export type EvolutionFactCategory =
  | "accepted_implementation"
  | "engineering_discovery"
  | "unresolved_risk"
  | "cross_stage_contract"
  | "verification_limitation"
  | "invalidated_assumption";

export interface EvolutionFact {
  factId: string;
  sourceKind: "execution_commit" | "execution_report";
  sourceId: string;
  stageOrdinal: number;
  stageId: string;
  category: EvolutionFactCategory;
  statement: string;
  scope: string;
  validityStatus: "active" | "superseded" | "resolved";
  createdAt: string;
}

export interface L1ExecutionEvolutionContext {
  completedStages: Array<{
    id: string;
    ordinal: number;
    objective: string;
    completedByCommitId: string;
    commitSequence: number;
  }>;
  evolutionFacts: EvolutionFact[];
  crossStageContracts: Array<{
    producerStageId: string;
    producerStageOrdinal: number;
    statement: string;
  }>;
  unresolvedRisks: Array<{
    sourceStageId: string;
    statement: string;
  }>;
  invalidatedAssumptions: Array<{
    sourceStageId: string;
    statement: string;
  }>;
}

export interface L2RecentWorkingContext {
  window: {
    id: string;
    scopeKind: string;
    candidateRevision: number;
    baseKind: string;
    baseCommitId: string | null;
  } | null;
  recentDirectives: Array<{
    id: string;
    revision: number;
    kind: string;
    objective: string;
  }>;
  recentAttempts: Array<{
    id: string;
    directiveId: string;
    state: string;
    workerRole: string;
  }>;
  recentReports: Array<{
    id: string;
    attemptId: string;
    result: string;
    candidateMutated: boolean;
    blockersCount: number;
  }>;
  recentAssessments: Array<{
    id: string;
    disposition: string;
    candidateRevision: number;
  }>;
}

export interface LayeredSupervisorContext {
  executionRunId: string;
  activeStageId: string | null;
  acceptedHeadCommitId: string | null;
  l0Normative: L0NormativeContext;
  l1Evolution: L1ExecutionEvolutionContext;
  l2Recent: L2RecentWorkingContext;
}

export const SUPERVISOR_CONTEXT_RECENT_LIMIT = 10;

/**
 * Deterministically assemble the three-layer Supervisor Context from canonical Store facts.
 */
export function buildLayeredSupervisorContextInTx(
  tx: StoreTx,
  executionRunId: string,
  options: { activeStageId?: string; recentLimit?: number } = {},
): LayeredSupervisorContext {
  const run = getExecutionRunInTx(tx, executionRunId);
  if (!run) {
    throw new Error(`cannot build supervisor context: ExecutionRun '${executionRunId}' not found`);
  }

  const limit = options.recentLimit ?? SUPERVISOR_CONTEXT_RECENT_LIMIT;
  const stages = listExecutionStagesInTx(tx, executionRunId);
  const activeStage = stages.find((s) => s.status === "active") ?? null;
  const currentStageId = options.activeStageId ?? activeStage?.id ?? null;
  const acceptedHeadCommitId = getAcceptedHeadCommitIdInTx(tx, executionRunId);

  // -------------------------------------------------------------------------
  // L0: Normative Context
  // -------------------------------------------------------------------------
  const planRunRow = tx.prepare("SELECT goal FROM planning_runs WHERE run_id = ?").get(run.runId) as { goal: string } | undefined;
  const runGoal = planRunRow?.goal ?? "";

  const finalPlanRow = getFinalPlanInTx(tx, run.runId);
  let l0Normative: L0NormativeContext;
  if (finalPlanRow) {
    const plan = parseFinalPlanCanonical(finalPlanRow.canonicalJson, executionRunId);

    const hardConstraints = plan.constraints.map((c) => {
      const stmtRow = tx
        .prepare("SELECT content_json FROM memory_revisions WHERE run_id = ? AND id = ? AND revision = ?")
        .get(run.runId, c.id, c.revision) as { content_json: string } | undefined;
      let statement = `constraint:${c.id}@${c.revision}`;
      if (stmtRow) {
        try {
          statement = JSON.parse(stmtRow.content_json)?.statement ?? statement;
        } catch {
          // ignore
        }
      }
      return { id: c.id, revision: c.revision, statement };
    });

    const architectureInvariants = plan.limitations.map((l) => ({
      statement: l.statement,
      sourceRef: "plan.limitations",
    }));

    const sectionContracts = plan.sections.map((s) => {
      const step = plan.implementationOrder.find((st) => st.supportingRefs.some((ref) => ref.id === s.sectionId));
      return {
        sectionId: s.sectionId,
        revision: s.revision,
        title: step?.title ?? s.sectionId,
        interfaceExports: [],
        dependencies: step?.dependsOn ?? [],
      };
    });

    l0Normative = {
      runGoal,
      finalPlan: {
        id: finalPlanRow.finalPlanId,
        revision: finalPlanRow.revision,
        hash: finalPlanRow.finalPlanHash,
      },
      hardConstraints,
      architectureInvariants,
      sectionContracts,
    };
  } else {
    l0Normative = {
      runGoal,
      finalPlan: { id: run.finalPlan.id, revision: run.finalPlan.revision, hash: run.finalPlan.hash },
      hardConstraints: [],
      architectureInvariants: [],
      sectionContracts: [],
    };
  }

  // -------------------------------------------------------------------------
  // L1: Execution Evolution Context (from all accepted ExecutionCommits)
  // -------------------------------------------------------------------------
  const allCommits = listRunCommitsInTx(tx, executionRunId);
  const completedStages = stages
    .filter((s) => s.status === "completed" && s.completedByCommitId !== null)
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((s) => {
      const commit = allCommits.find((c) => c.commitId === s.completedByCommitId);
      return {
        id: s.id,
        ordinal: s.ordinal,
        objective: s.objective,
        completedByCommitId: s.completedByCommitId!,
        commitSequence: commit?.sequence ?? 0,
      };
    });

  const evolutionFacts: EvolutionFact[] = [];
  const crossStageContracts: Array<{ producerStageId: string; producerStageOrdinal: number; statement: string }> = [];
  const unresolvedRisks: Array<{ sourceStageId: string; statement: string }> = [];
  const invalidatedAssumptions: Array<{ sourceStageId: string; statement: string }> = [];

  for (const completed of completedStages) {
    const commit = getExecutionCommitInTx(tx, completed.completedByCommitId);
    if (!commit) continue;

    // Record accepted commit fact
    evolutionFacts.push({
      factId: `fact_${commit.commitId}`,
      sourceKind: "execution_commit",
      sourceId: commit.commitId,
      stageOrdinal: completed.ordinal,
      stageId: completed.id,
      category: "accepted_implementation",
      statement: `Stage ${completed.ordinal} accepted: ${completed.objective}`,
      scope: completed.id,
      validityStatus: "active",
      createdAt: commit.createdAt,
    });

    // Inspect reports linked to this commit
    for (const rRef of commit.reportRefs) {
      const report = getExecutionReportInTx(tx, rRef.reportId);
      if (!report) continue;

      // Extract engineering findings
      for (const finding of report.findings) {
        let category: EvolutionFactCategory = "accepted_implementation";
        const text = finding.summary.toLowerCase();

        if (text.includes("invariant") || text.includes("contract") || text.includes("export") || text.includes("interface")) {
          category = "cross_stage_contract";
          crossStageContracts.push({
            producerStageId: completed.id,
            producerStageOrdinal: completed.ordinal,
            statement: finding.summary,
          });
        } else if (text.includes("risk") || text.includes("warning") || text.includes("gap")) {
          category = "unresolved_risk";
          unresolvedRisks.push({
            sourceStageId: completed.id,
            statement: finding.summary,
          });
        } else if (text.includes("limitation") || text.includes("caveat") || text.includes("boundary")) {
          category = "verification_limitation";
        } else {
          category = "engineering_discovery";
        }

        evolutionFacts.push({
          factId: `fact_${report.reportId}_${evolutionFacts.length}`,
          sourceKind: "execution_report",
          sourceId: report.reportId,
          stageOrdinal: completed.ordinal,
          stageId: completed.id,
          category,
          statement: finding.summary + (finding.details ? ` (${finding.details})` : ""),
          scope: "cross_stage",
          validityStatus: "active",
          createdAt: report.createdAt,
        });
      }

      // Extract deviations as invalidated assumptions
      for (const dev of report.deviations) {
        invalidatedAssumptions.push({
          sourceStageId: completed.id,
          statement: dev.summary,
        });
        evolutionFacts.push({
          factId: `dev_${report.reportId}_${evolutionFacts.length}`,
          sourceKind: "execution_report",
          sourceId: report.reportId,
          stageOrdinal: completed.ordinal,
          stageId: completed.id,
          category: "invalidated_assumption",
          statement: dev.summary + (dev.details ? ` (${dev.details})` : ""),
          scope: completed.id,
          validityStatus: "superseded",
          createdAt: report.createdAt,
        });
      }
    }
  }

  const l1Evolution: L1ExecutionEvolutionContext = {
    completedStages,
    evolutionFacts,
    crossStageContracts,
    unresolvedRisks,
    invalidatedAssumptions,
  };

  // -------------------------------------------------------------------------
  // L2: Recent Working Context (bounded recency for active window)
  // -------------------------------------------------------------------------
  const openWindow = getOpenWindowInTx(tx, executionRunId);
  const allDirectives = listRunDirectivesInTx(tx, executionRunId);
  const allAttempts = listRunAttemptsInTx(tx, executionRunId);
  const allReports = listRunReportsInTx(tx, executionRunId);
  const allAssessments = listRunAssessmentsInTx(tx, executionRunId);

  const recentDirectives = [...allDirectives]
    .sort((a, b) => b.issuedAt.localeCompare(a.issuedAt))
    .slice(0, limit);

  const recentAttempts = [...allAttempts]
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, limit);

  const recentReports = [...allReports]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);

  const recentAssessments = [...allAssessments]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);

  const l2Recent: L2RecentWorkingContext = {
    window: openWindow === null ? null : {
      id: openWindow.id,
      scopeKind: openWindow.scopeKind,
      candidateRevision: openWindow.candidateRevision,
      baseKind: openWindow.baseKind,
      baseCommitId: openWindow.baseCommitId,
    },
    recentDirectives: recentDirectives.map((d) => ({
      id: d.directiveId,
      revision: d.revision,
      kind: d.kind,
      objective: d.objective,
    })),
    recentAttempts: recentAttempts.map((a) => ({
      id: a.attemptId,
      directiveId: a.directiveId,
      state: a.state,
      workerRole: a.workerRole,
    })),
    recentReports: recentReports.map((r: ExecutionReport) => ({
      id: r.reportId,
      attemptId: r.attemptId,
      result: r.result,
      candidateMutated: r.candidateMutated,
      blockersCount: r.blockers.length,
    })),
    recentAssessments: recentAssessments.map((a) => ({
      id: a.assessmentId,
      disposition: a.disposition,
      candidateRevision: a.candidateRevision,
    })),
  };

  return {
    executionRunId,
    activeStageId: currentStageId,
    acceptedHeadCommitId,
    l0Normative,
    l1Evolution,
    l2Recent,
  };
}
