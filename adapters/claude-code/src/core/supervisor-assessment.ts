/**
 * SupervisorAssessment domain shape (v0.2.0 architecture spec, E6 §4–§11/§16).
 *
 * PURE core: vocabulary, canonical shapes, row validation, obligation
 * provenance identity. No SQLite, no host, no MCP.
 *
 * A SupervisorAssessment is the Supervisor's IMMUTABLE semantic judgment over
 * one exact VerificationWindow + candidateRevision (E6 §4). It is append-only
 * execution memory: a changed judgment is a NEW row; multiple non-accept
 * assessments may coexist for the same window + revision, and an old
 * assessment automatically becomes stale for acceptance once the candidate
 * revision moves (E6 §5/§7/§40).
 *
 * Dispositions (E6 §4): all five frozen values are representable now; ONLY
 * `accept` may enter the ExecutionCommit gate. The others are durable semantic
 * judgments that never by themselves mutate candidateRevision, close a window,
 * advance acceptedHead, issue a Directive, launch a Worker, or transition the
 * run (E6 §20).
 *
 * ReportJudgment (E6 §10): the structured anti-omission classification of the
 * CURRENT-candidate Reports. Negative results (blocked/failed/partial) may
 * never be classified `supporting` — only `blocking` or `superseded` (E6 §11).
 *
 * CoveredObligation (E6 §16): structured acceptance PROVENANCE. The repository
 * audit found no stable IDs on Directive.validationRequirements (plain
 * {requirement, detail} content), so obligations carry a deterministic local
 * identity: the exact directive revision + list index + a sha256 over the
 * canonical requirement content. Obligations never complete a Stage (E6 §16).
 */

import { createHash } from "node:crypto";

import { canonicalJson } from "./canonical-json.js";
import { RuntimeError } from "../runtime/errors.js";
import type { DirectivePlanRef, ExecutionDirective, ValidationRequirement } from "./execution-directive.js";
import type { ExecutionReport } from "./execution-report.js";

export const SUPERVISOR_ASSESSMENT_DISPOSITIONS = [
  "accept",
  "rework",
  "need_more_verification",
  "blocked",
  "request_replan",
] as const;

export type SupervisorAssessmentDisposition = (typeof SUPERVISOR_ASSESSMENT_DISPOSITIONS)[number];

export function isSupervisorAssessmentDisposition(value: string): value is SupervisorAssessmentDisposition {
  return (SUPERVISOR_ASSESSMENT_DISPOSITIONS as readonly string[]).includes(value);
}

export const REPORT_JUDGMENT_DISPOSITIONS = [
  "supporting",
  "informational",
  "superseded",
  "blocking",
] as const;

export type ReportJudgmentDisposition = (typeof REPORT_JUDGMENT_DISPOSITIONS)[number];

export function isReportJudgmentDisposition(value: string): value is ReportJudgmentDisposition {
  return (REPORT_JUDGMENT_DISPOSITIONS as readonly string[]).includes(value);
}

/**
 * E6 §11 — report results that may NEVER carry a `supporting` judgment: a
 * blocked/failed/partial report is adverse evidence and must be classified
 * `blocking` or `superseded` (with a valid later current-candidate superseder).
 */
export const NEGATIVE_REPORT_RESULTS: readonly ExecutionReport["result"][] = ["blocked", "failed", "partial"];

export function isNegativeReportResult(result: string): boolean {
  return NEGATIVE_REPORT_RESULTS.includes(result as ExecutionReport["result"]);
}

/** E6 §16 / E7 §5 / E10 §22 — structured acceptance provenance over existing content only. */
export interface CoveredObligation {
  source: "directive_validation_requirement" | "plan_ref" | "stage_objective" | "execution_run_completion";
  /** For directive_validation_requirement: the exact immutable revision. */
  directiveId?: string;
  directiveRevision?: number;
  /**
   * Stable index within the directive's validationRequirements list — the
   * deterministic local identity the repository audit chose (the audited
   * requirements carry no stable IDs). Present only for
   * directive_validation_requirement obligations.
   */
  index?: number;
  /** For plan_ref: the exact approved reference the obligation rests on. */
  ref?: DirectivePlanRef;
  /**
   * E7 §5 — for stage_objective: the exact Stage whose satisfaction the
   * accepted candidate asserts, and the deterministic hash over that Stage's
   * immutable semantics (core/stage-completion.ts).
   */
  stageId?: string;
  objectiveHash?: string;
  /**
   * E10 §22 — for execution_run_completion: the deterministic run-completion
   * identity (core/execution-completion.ts) — the run, the FinalPlan, the
   * final-closure base head, and the completed Stage-set hash.
   */
  executionRunId?: string;
  finalPlanHash?: string;
  baseAcceptedHeadCommitId?: string;
  completedStageSetHash?: string;
  /** sha256 over the canonical obligation content — the content identity. */
  contentHash: string;
}

export interface ReportJudgment {
  reportId: string;
  disposition: ReportJudgmentDisposition;
  /** Required (and validated) exactly when disposition is `superseded`. */
  supersededByReportId?: string;
  /** Required non-empty exactly when disposition is `superseded`. */
  rationale?: string;
}

export interface SupervisorAssessment {
  assessmentId: string;
  executionRunId: string;
  /**
   * E10 §31 — the assessment's explicit scope. Stage-scoped assessments carry
   * the exact Stage; final-closure assessments carry null (never a fake Stage).
   */
  stageId: string | null;
  windowId: string;
  /** The EXACT window candidate revision this judgment binds (E6 §7). */
  candidateRevision: number;
  disposition: SupervisorAssessmentDisposition;
  /** The signed supervisor session + fencing generation at submission (E6 §6). */
  supervisorSessionId: string;
  supervisorGeneration: number;
  /** Exact approved plan refs the assessment rests on (E6 §8/§19 input). */
  planRefs: DirectivePlanRef[];
  coveredObligations: CoveredObligation[];
  /** Non-empty audit provenance; never parsed by Core (E6 §45). */
  rationale: string;
  createdAt: string;
}

function obligationContentHash(content: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(content), "utf8").digest("hex")}`;
}

/**
 * E6 §16 — the deterministic local obligation identity for one Directive
 * validation requirement: exact directive revision + list index + content
 * hash. No normative obligation is invented beyond the persisted requirement.
 */
export function validationRequirementObligation(
  directive: Pick<ExecutionDirective, "directiveId" | "revision">,
  requirement: ValidationRequirement,
  index: number,
): CoveredObligation {
  return {
    source: "directive_validation_requirement",
    directiveId: directive.directiveId,
    directiveRevision: directive.revision,
    index,
    contentHash: obligationContentHash({
      kind: "directive_validation_requirement",
      requirement: requirement.requirement,
      detail: requirement.detail ?? null,
    }),
  };
}

/** E6 §16 — obligation provenance for an approved plan ref. */
export function planRefObligation(ref: DirectivePlanRef): CoveredObligation {
  return {
    source: "plan_ref",
    ref,
    contentHash: obligationContentHash({
      kind: "plan_ref",
      ref,
    }),
  };
}

/** Validate model-supplied obligation input against the canonical shape. */
export function parseCoveredObligation(raw: unknown): CoveredObligation {
  if (typeof raw !== "object" || raw === null) {
    throw new RuntimeError("ASSESSMENT_REPORT_INVALID", "covered obligation is not an object", { recoverable: false });
  }
  const record = raw as Record<string, unknown>;
  const problems: string[] = [];
  if (
    record.source !== "directive_validation_requirement"
    && record.source !== "plan_ref"
    && record.source !== "stage_objective"
    && record.source !== "execution_run_completion"
  ) {
    problems.push("source");
  }
  if (typeof record.contentHash !== "string" || record.contentHash === "") {
    problems.push("contentHash");
  }
  if (record.source === "directive_validation_requirement") {
    if (typeof record.directiveId !== "string" || record.directiveId === "") problems.push("directiveId");
    if (typeof record.directiveRevision !== "number" || !Number.isInteger(record.directiveRevision) || record.directiveRevision < 1) {
      problems.push("directiveRevision");
    }
    if (typeof record.index !== "number" || !Number.isInteger(record.index) || record.index < 0) {
      problems.push("index");
    }
  }
  if (record.source === "plan_ref") {
    const ref = record.ref as Record<string, unknown> | undefined;
    if (
      typeof ref !== "object"
      || ref === null
      || typeof ref.kind !== "string"
      || typeof ref.id !== "string"
      || typeof ref.revision !== "number"
      || !Number.isInteger(ref.revision)
      || ref.revision < 1
    ) {
      problems.push("ref");
    }
  }
  // E7 §5 — a stage_objective claim carries the exact Stage id and a
  // sha256-shaped objective hash; Core re-derives the identity at the gate.
  if (record.source === "stage_objective") {
    if (typeof record.stageId !== "string" || record.stageId === "") problems.push("stageId");
    if (typeof record.objectiveHash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(record.objectiveHash)) {
      problems.push("objectiveHash");
    }
  }
  // E10 §22/§24 — an execution_run_completion claim carries the Core-derived
  // identity fields; Core re-derives and compares the exact contentHash at the
  // final accept gate (E10 §32).
  if (record.source === "execution_run_completion") {
    if (typeof record.executionRunId !== "string" || record.executionRunId === "") problems.push("executionRunId");
    if (typeof record.finalPlanHash !== "string" || record.finalPlanHash === "") problems.push("finalPlanHash");
    if (typeof record.baseAcceptedHeadCommitId !== "string" || record.baseAcceptedHeadCommitId === "") {
      problems.push("baseAcceptedHeadCommitId");
    }
    if (typeof record.completedStageSetHash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(record.completedStageSetHash)) {
      problems.push("completedStageSetHash");
    }
  }
  if (problems.length > 0) {
    throw new RuntimeError(
      "ASSESSMENT_REPORT_INVALID",
      `covered obligation is malformed: ${problems.join(", ")}`,
      { detail: { problems }, recoverable: false },
    );
  }
  if (record.source === "stage_objective") {
    return {
      source: "stage_objective",
      stageId: record.stageId as string,
      objectiveHash: record.objectiveHash as string,
      contentHash: record.contentHash as string,
    };
  }
  if (record.source === "execution_run_completion") {
    return {
      source: "execution_run_completion",
      executionRunId: record.executionRunId as string,
      finalPlanHash: record.finalPlanHash as string,
      baseAcceptedHeadCommitId: record.baseAcceptedHeadCommitId as string,
      completedStageSetHash: record.completedStageSetHash as string,
      contentHash: record.contentHash as string,
    };
  }
  return record.source === "directive_validation_requirement"
    ? {
        source: "directive_validation_requirement",
        directiveId: record.directiveId as string,
        directiveRevision: record.directiveRevision as number,
        index: record.index as number,
        contentHash: record.contentHash as string,
      }
    : {
        source: "plan_ref",
        ref: record.ref as DirectivePlanRef,
        contentHash: record.contentHash as string,
      };
}

/** Validate one model-supplied report judgment against the canonical shape. */
export function parseReportJudgmentInput(raw: unknown): ReportJudgment {
  if (typeof raw !== "object" || raw === null) {
    throw new RuntimeError("ASSESSMENT_REPORT_INVALID", "report judgment is not an object", { recoverable: false });
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.reportId !== "string" || record.reportId === "") {
    throw new RuntimeError("ASSESSMENT_REPORT_INVALID", "report judgment reportId must be a non-empty string", {
      recoverable: false,
    });
  }
  if (typeof record.disposition !== "string" || !isReportJudgmentDisposition(record.disposition)) {
    throw new RuntimeError(
      "ASSESSMENT_REPORT_INVALID",
      `report judgment disposition must be one of: ${REPORT_JUDGMENT_DISPOSITIONS.join(", ")}`,
      { detail: { reportId: record.reportId }, recoverable: false },
    );
  }
  if (record.disposition === "superseded") {
    if (typeof record.supersededByReportId !== "string" || record.supersededByReportId === "") {
      throw new RuntimeError(
        "ASSESSMENT_REPORT_INVALID",
        "a superseded judgment must name its superseding report",
        { detail: { reportId: record.reportId }, recoverable: false },
      );
    }
    if (typeof record.rationale !== "string" || record.rationale.trim() === "") {
      throw new RuntimeError(
        "ASSESSMENT_REPORT_INVALID",
        "a superseded judgment requires a non-empty rationale",
        { detail: { reportId: record.reportId }, recoverable: false },
      );
    }
    return {
      reportId: record.reportId,
      disposition: "superseded",
      supersededByReportId: record.supersededByReportId,
      rationale: record.rationale,
    };
  }
  return {
    reportId: record.reportId,
    disposition: record.disposition,
    ...(typeof record.rationale === "string" && record.rationale !== "" ? { rationale: record.rationale } : {}),
  };
}

/**
 * Validate a raw database row into a SupervisorAssessment. Illegal disposition
 * vocabulary, an empty rationale, or broken identity is store corruption —
 * STORE_SCHEMA_INVALID, never smuggled into the core.
 */
export function parseSupervisorAssessmentRow(row: Record<string, unknown>): SupervisorAssessment {
  const problems: string[] = [];
  if (typeof row.assessmentId !== "string" || row.assessmentId === "") problems.push("assessment_id");
  if (typeof row.executionRunId !== "string" || row.executionRunId === "") problems.push("execution_run_id");
  // E10 §31 — stage_id is NULL exactly for a final-closure assessment.
  if (row.stageId !== null && typeof row.stageId !== "string") problems.push("stage_id");
  if (typeof row.stageId === "string" && row.stageId === "") problems.push("stage_id");
  if (typeof row.windowId !== "string" || row.windowId === "") problems.push("window_id");
  if (typeof row.candidateRevision !== "number" || !Number.isInteger(row.candidateRevision) || row.candidateRevision < 0) {
    problems.push("candidate_revision");
  }
  if (typeof row.disposition !== "string" || !isSupervisorAssessmentDisposition(row.disposition)) {
    problems.push("disposition");
  }
  if (typeof row.supervisorSessionId !== "string" || row.supervisorSessionId === "") problems.push("supervisor_session_id");
  if (
    typeof row.supervisorGeneration !== "number"
    || !Number.isInteger(row.supervisorGeneration)
    || row.supervisorGeneration < 1
  ) {
    problems.push("supervisor_generation");
  }
  if (typeof row.rationale !== "string" || row.rationale === "") problems.push("rationale");
  if (typeof row.createdAt !== "string" || row.createdAt === "") problems.push("created_at");
  if (!Array.isArray(row.planRefs) || !Array.isArray(row.coveredObligations)) problems.push("refs");
  if (problems.length > 0) {
    throw new RuntimeError("STORE_SCHEMA_INVALID", "supervisor_assessments row is corrupt", {
      detail: { fields: problems },
    });
  }
  return {
    assessmentId: row.assessmentId as string,
    executionRunId: row.executionRunId as string,
    stageId: (row.stageId as string | null) ?? null,
    windowId: row.windowId as string,
    candidateRevision: row.candidateRevision as number,
    disposition: row.disposition as SupervisorAssessmentDisposition,
    supervisorSessionId: row.supervisorSessionId as string,
    supervisorGeneration: row.supervisorGeneration as number,
    planRefs: row.planRefs as DirectivePlanRef[],
    coveredObligations: row.coveredObligations as CoveredObligation[],
    rationale: row.rationale as string,
    createdAt: row.createdAt as string,
  };
}

export interface AssessmentReportJudgmentRow {
  assessmentId: string;
  reportId: string;
  disposition: ReportJudgmentDisposition;
  supersededByReportId: string | null;
  rationale: string | null;
}

/**
 * Validate a raw judgment row. A `superseded` judgment must carry its
 * superseder + rationale (the DDL CHECK is the first fence; this is the parse
 * layer), and no other disposition may carry a superseder.
 */
export function parseReportJudgmentRow(row: Record<string, unknown>): AssessmentReportJudgmentRow {
  const problems: string[] = [];
  if (typeof row.assessmentId !== "string" || row.assessmentId === "") problems.push("assessment_id");
  if (typeof row.reportId !== "string" || row.reportId === "") problems.push("report_id");
  if (typeof row.disposition !== "string" || !isReportJudgmentDisposition(row.disposition)) problems.push("disposition");
  if (row.supersededByReportId !== null && typeof row.supersededByReportId !== "string") problems.push("superseded_by_report_id");
  if (row.rationale !== null && typeof row.rationale !== "string") problems.push("rationale");
  if (problems.length > 0) {
    throw new RuntimeError("STORE_SCHEMA_INVALID", "supervisor_assessment_report_judgments row is corrupt", {
      detail: { fields: problems },
    });
  }
  const disposition = row.disposition as ReportJudgmentDisposition;
  if (disposition === "superseded" && (typeof row.supersededByReportId !== "string" || !row.rationale)) {
    throw new RuntimeError("STORE_SCHEMA_INVALID", "superseded judgment row is missing its superseder or rationale", {
      detail: { fields: ["superseded_by_report_id"] },
    });
  }
  if (disposition !== "superseded" && row.supersededByReportId !== null) {
    throw new RuntimeError("STORE_SCHEMA_INVALID", "only a superseded judgment may name a superseding report", {
      detail: { fields: ["superseded_by_report_id"] },
    });
  }
  return {
    assessmentId: row.assessmentId as string,
    reportId: row.reportId as string,
    disposition,
    supersededByReportId: (row.supersededByReportId as string | null) ?? null,
    rationale: (row.rationale as string | null) ?? null,
  };
}
