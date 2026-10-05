/**
 * Stage-completion obligation domain (v0.2.0 E7 §4–§9/§33–§35).
 *
 * PURE core: the deterministic identity of "the objective represented by this
 * exact Stage is satisfied", the Stage-completion validation requirement, and
 * the CoveredObligation constructor. No SQLite, no host, no MCP.
 *
 * A Stage becomes completed only when an ACCEPTED ExecutionCommit carries the
 * exact `stage_objective` obligation for that Stage (E7 §4/§7). The obligation
 * is semantic provenance asserted by the Supervisor and validated by Core for
 * exact identity — Core never natural-language-evaluates whether the objective
 * is actually true (E7 §6); that judgment lives in the SupervisorAssessment
 * under the existing trust model.
 *
 * The identity is derived ONLY from immutable Stage semantics (E7 §5): run id,
 * stage id, source step, objective, source plan refs, explicit dependsOn.
 * Mutable execution state (status, timestamps, current Window, acceptedHead)
 * is never hashed, so the identity cannot go stale as execution progresses.
 */

import { createHash } from "node:crypto";

import { canonicalJson } from "./canonical-json.js";
import type { ExecutionStage } from "./execution-stage.js";
import type { CoveredObligation } from "./supervisor-assessment.js";
import type { ValidationRequirement } from "./execution-directive.js";

/** E7 §9 — the deterministic Stage-completion validation requirement name. */
export const STAGE_COMPLETION_REQUIREMENT = "verify_stage_completion";

/** The immutable Stage semantics the obligation identity is derived from. */
export type StageObjectiveSemantics = Pick<
  ExecutionStage,
  "executionRunId" | "id" | "sourceStepId" | "objective" | "sourceRefs" | "dependsOn"
>;

/** sha256 over the canonical immutable Stage semantics (E7 §5). */
export function stageObjectiveHash(stage: StageObjectiveSemantics): string {
  return `sha256:${createHash("sha256")
    .update(
      canonicalJson({
        kind: "stage_objective",
        executionRunId: stage.executionRunId,
        stageId: stage.id,
        sourceStepId: stage.sourceStepId,
        objective: stage.objective,
        sourceRefs: stage.sourceRefs,
        dependsOn: stage.dependsOn,
      }),
      "utf8",
    )
    .digest("hex")}`;
}

/**
 * E7 §5 — the exact durable Stage-completion obligation. Every obligation
 * carries the same shape contract as the E6 obligations: identity fields plus
 * a contentHash over the canonical identity content.
 */
export function stageObjectiveObligation(stage: StageObjectiveSemantics): CoveredObligation {
  const objectiveHash = stageObjectiveHash(stage);
  return {
    source: "stage_objective",
    stageId: stage.id,
    objectiveHash,
    contentHash: `sha256:${createHash("sha256")
      .update(
        canonicalJson({ kind: "stage_objective", stageId: stage.id, objectiveHash }),
        "utf8",
      )
      .digest("hex")}`,
  };
}

export function isStageObjectiveObligation(obligation: CoveredObligation): boolean {
  return obligation.source === "stage_objective";
}

/** E7 §9 — the exact requirement a Stage-completing verifier must carry. */
export interface StageCompletionValidationRequirement {
  requirement: string;
  /** The objectiveHash — the deterministic encoded Stage identity (E7 §9). */
  detail: string;
}

export function deriveStageCompletionValidationRequirement(
  stage: StageObjectiveSemantics,
): StageCompletionValidationRequirement {
  return { requirement: STAGE_COMPLETION_REQUIREMENT, detail: stageObjectiveHash(stage) };
}

/**
 * E7 §8/§9 — a Directive covers Stage-completion verification exactly when its
 * immutable validationRequirements contain the derived requirement verbatim
 * (exact requirement name AND exact encoded identity). No natural-language
 * matching, no "tests passed" generic coverage.
 */
export function directiveCarriesStageCompletionVerification(
  directive: Pick<ExecutionStageDirectiveShape, "validationRequirements">,
  stage: StageObjectiveSemantics,
): boolean {
  const required = deriveStageCompletionValidationRequirement(stage);
  return directive.validationRequirements.some(
    (candidate) => candidate.requirement === required.requirement && candidate.detail === required.detail,
  );
}

/** Structural subset of ExecutionDirective the matcher needs (keeps core PURE). */
export interface ExecutionStageDirectiveShape {
  validationRequirements: ValidationRequirement[];
}
