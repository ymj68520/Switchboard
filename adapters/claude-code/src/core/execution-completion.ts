/**
 * Execution-run-completion obligation domain (v0.2.0 E10 §21–§26).
 *
 * PURE core: the deterministic identity of "this exact ExecutionRun's
 * execution is complete as a whole", the run-completion validation
 * requirement, and the CoveredObligation constructor. No SQLite, no host, no
 * MCP.
 *
 * Final closure deliberately does NOT reuse the Stage vocabulary (E10 §21):
 * `verify_stage_completion` / `stage_objective` remain ordinary Stage
 * concepts. The Final ExecutionCommit instead carries the EXACT
 * `execution_run_completion` obligation, whose identity is derived by Core
 * from immutable facts only (E10 §24): the ExecutionRun id, the exact bound
 * FinalPlan, the final-closure Window's base acceptedHead (the head the final
 * closure closes over), and the deterministic hash of the completed Stage
 * set. The Supervisor never invents this identity — it copies what Core
 * exposed in the final-closure context, and Core re-derives and compares it
 * at the final accept gate (E10 §32).
 *
 * The completed Stage-set hash (E10 §23) covers every non-superseded ordinary
 * Stage in canonical (ordinal) order with its exact accepted provenance:
 * stageId, source step, objectiveHash (the E7 immutable-semantics hash), and
 * completedByCommitId. Timestamps, sessions, windows, and candidate revisions
 * are never hashed, so the identity cannot go stale while the final window is
 * open.
 */

import { createHash } from "node:crypto";

import { canonicalJson } from "./canonical-json.js";
import { stageObjectiveHash, type StageObjectiveSemantics } from "./stage-completion.js";
import type { CoveredObligation } from "./supervisor-assessment.js";
import type { ValidationRequirement } from "./execution-directive.js";

/** E10 §25 — the deterministic run-completion validation requirement name. */
export const EXECUTION_RUN_COMPLETION_REQUIREMENT = "verify_execution_completion";

/** One completed Stage's immutable provenance the set hash is derived from. */
export type CompletedStageProvenance = StageObjectiveSemantics & {
  /** The exact accepted ExecutionCommit that completed this Stage (E7 §12). */
  completedByCommitId: string;
};

/** The immutable facts the run-completion obligation identity is derived from. */
export interface ExecutionCompletionSemantics {
  executionRunId: string;
  /** The EXACT FinalPlan the run is permanently bound to. */
  finalPlanRef: { id: string; revision: number; hash: string };
  /**
   * The final-closure Window's base acceptedHead — the exact accepted Commit
   * the final closure closes over (E10 §9: candidateRevision 0 is rooted
   * there; E10 §24: the obligation binds it).
   */
  baseAcceptedHeadCommitId: string;
  /** Every non-superseded ordinary Stage, canonical (ordinal) order. */
  completedStages: CompletedStageProvenance[];
}

/**
 * E10 §23 — the deterministic completed Stage-set hash: canonical ordinal
 * order, each Stage's id + source step + immutable objectiveHash + accepted
 * provenance commit. Nothing mutable (timestamps, sessions, windows,
 * revisions) is hashed.
 */
export function completedStageSetHash(completedStages: CompletedStageProvenance[]): string {
  return `sha256:${createHash("sha256")
    .update(
      canonicalJson({
        kind: "completed_stage_set",
        stages: completedStages.map((stage) => ({
          stageId: stage.id,
          sourceStepId: stage.sourceStepId,
          objectiveHash: stageObjectiveHash(stage),
          completedByCommitId: stage.completedByCommitId,
        })),
      }),
      "utf8",
    )
    .digest("hex")}`;
}

/**
 * E10 §24 — the exact durable run-completion obligation. The contentHash
 * binds at least the ExecutionRun id, the exact FinalPlan id/revision/hash,
 * the final-closure base acceptedHead, and the completed Stage-set hash —
 * all Core-derived; the Supervisor copies the identity, never invents it.
 */
export function executionRunCompletionObligation(
  semantics: ExecutionCompletionSemantics,
): CoveredObligation & {
  source: "execution_run_completion";
  executionRunId: string;
  finalPlanHash: string;
  baseAcceptedHeadCommitId: string;
  completedStageSetHash: string;
} {
  const stageSetHash = completedStageSetHash(semantics.completedStages);
  const contentHash = `sha256:${createHash("sha256")
    .update(
      canonicalJson({
        kind: "execution_run_completion",
        executionRunId: semantics.executionRunId,
        finalPlanId: semantics.finalPlanRef.id,
        finalPlanRevision: semantics.finalPlanRef.revision,
        finalPlanHash: semantics.finalPlanRef.hash,
        baseAcceptedHeadCommitId: semantics.baseAcceptedHeadCommitId,
        completedStageSetHash: stageSetHash,
      }),
      "utf8",
    )
    .digest("hex")}`;
  return {
    source: "execution_run_completion",
    executionRunId: semantics.executionRunId,
    finalPlanHash: semantics.finalPlanRef.hash,
    baseAcceptedHeadCommitId: semantics.baseAcceptedHeadCommitId,
    completedStageSetHash: stageSetHash,
    contentHash,
  };
}

export function isExecutionRunCompletionObligation(obligation: CoveredObligation): boolean {
  return obligation.source === "execution_run_completion";
}

/** E10 §25 — the exact requirement the final-completion verifier must carry. */
export interface ExecutionCompletionValidationRequirement {
  requirement: string;
  /** The obligation contentHash — the deterministic encoded completion identity. */
  detail: string;
}

export function deriveExecutionCompletionValidationRequirement(
  semantics: ExecutionCompletionSemantics,
): ExecutionCompletionValidationRequirement {
  return {
    requirement: EXECUTION_RUN_COMPLETION_REQUIREMENT,
    detail: executionRunCompletionObligation(semantics).contentHash,
  };
}

/**
 * E10 §26 — a Directive covers run-completion verification exactly when its
 * immutable validationRequirements contain the derived requirement verbatim
 * (exact requirement name AND exact encoded identity). A generic normal
 * verifier is insufficient for final completion.
 */
export function directiveCarriesExecutionCompletionVerification(
  directive: Pick<{ validationRequirements: ValidationRequirement[] }, "validationRequirements">,
  semantics: ExecutionCompletionSemantics,
): boolean {
  const required = deriveExecutionCompletionValidationRequirement(semantics);
  return directive.validationRequirements.some(
    (candidate) => candidate.requirement === required.requirement && candidate.detail === required.detail,
  );
}
