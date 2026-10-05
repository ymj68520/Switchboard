/**
 * ExecutionReport domain shape (v0.2.0 architecture spec, E4 §23–§33).
 *
 * PURE core: vocabulary, canonical shape, row validation, deterministic
 * contract validation. No SQLite, no host, no MCP.
 *
 * ONE immutable report schema serves BOTH worker roles (E4 §23) — executor and
 * verifier reports are the same artifact, the same table, the same parser.
 * There is no VerificationReport artifact.
 *
 * Result vocabulary (E4 §26): completed / partial / blocked / failed. NONE of
 * these means accepted, committed, Stage completed, or Window closed — a
 * Report is factual execution input and NEVER creates accepted execution
 * progress (E4 §1/§26).
 *
 * `candidateMutated` (E4 §29) is the explicit factual record of whether this
 * attempt changed the current execution candidate — the E4 source of truth for
 * candidateRevision advancement, for ANY directive kind. An implementation
 * directive may legitimately report no mutation (blocked/failed before
 * editing); a verification directive may legitimately report mutation.
 *
 * Blockers (E4 §27) are STRUCTURED (kind/summary/details/refs), never one
 * prose string. Deviations (E4 §28) are structured separately from blockers
 * and are expected protocol output, not violations.
 */

import { RuntimeError } from "../runtime/errors.js";
import type { DirectivePlanRef } from "./execution-directive.js";

export const EXECUTION_REPORT_RESULTS = ["completed", "partial", "blocked", "failed"] as const;

export type ExecutionReportResult = (typeof EXECUTION_REPORT_RESULTS)[number];

export function isExecutionReportResult(value: string): value is ExecutionReportResult {
  return (EXECUTION_REPORT_RESULTS as readonly string[]).includes(value);
}

/** The frozen structured blocker taxonomy (E4 §27). */
export const EXECUTION_BLOCKER_KINDS = [
  "MISSING_CONTEXT",
  "AMBIGUOUS_DIRECTIVE",
  "REPOSITORY_MISMATCH",
  "UNEXPECTED_SCOPE",
  "CONFLICTING_REQUIREMENTS",
  "MISSING_PREREQUISITE",
  "EXECUTION_ENVIRONMENT_BLOCKER",
] as const;

export type ExecutionBlockerKind = (typeof EXECUTION_BLOCKER_KINDS)[number];

export function isExecutionBlockerKind(value: string): value is ExecutionBlockerKind {
  return (EXECUTION_BLOCKER_KINDS as readonly string[]).includes(value);
}

export interface ExecutionBlocker {
  kind: ExecutionBlockerKind;
  summary: string;
  details: string | null;
  relevantRefs: DirectivePlanRef[];
}

export interface ExecutionDeviation {
  summary: string;
  details: string | null;
}

export interface ExecutionFinding {
  summary: string;
  details: string | null;
}

export interface ActionSummary {
  action: string;
  detail: string | null;
}

export interface CommandSummary {
  command: string;
  detail: string | null;
}

export interface TestSummary {
  name: string;
  outcome: string;
  detail: string | null;
}

export interface DeliverableRef {
  name: string;
  ref: DirectivePlanRef | null;
  detail: string | null;
}

export interface ExecutionReport {
  reportId: string;
  executionRunId: string;
  attemptId: string;
  /** Derived from and verified against the Attempt (E4 §25) — never trusted input. */
  directiveId: string;
  directiveRevision: number;
  directiveHash: string;
  workerRole: "executor" | "verifier";
  result: ExecutionReportResult;
  candidateMutated: boolean;
  actionPerformed: ActionSummary[];
  filesExamined: string[];
  filesChanged: string[];
  commandsRun: CommandSummary[];
  testsRun: TestSummary[];
  findings: ExecutionFinding[];
  deviations: ExecutionDeviation[];
  blockers: ExecutionBlocker[];
  deliverables: DeliverableRef[];
  createdAt: string;
}

function isStringOrNull(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function validateRefLike(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const ref = value as Record<string, unknown>;
  return typeof ref.kind === "string" && typeof ref.id === "string" && typeof ref.revision === "number";
}

/**
 * Validate a raw database row into an ExecutionReport. Illegal result/blocker
 * vocabulary or unparsable/broken payload shapes is store corruption —
 * STORE_SCHEMA_INVALID.
 */
export function parseExecutionReportRow(row: Record<string, unknown>): ExecutionReport {
  const problems: string[] = [];
  if (typeof row.reportId !== "string" || row.reportId === "") problems.push("report_id");
  if (typeof row.executionRunId !== "string" || row.executionRunId === "") problems.push("execution_run_id");
  if (typeof row.attemptId !== "string" || row.attemptId === "") problems.push("attempt_id");
  if (typeof row.directiveId !== "string" || row.directiveId === "") problems.push("directive_id");
  if (
    typeof row.directiveRevision !== "number" || !Number.isInteger(row.directiveRevision) || row.directiveRevision < 1
  ) {
    problems.push("directive_revision");
  }
  if (typeof row.directiveHash !== "string" || row.directiveHash === "") problems.push("directive_hash");
  if (typeof row.workerRole !== "string" || (row.workerRole !== "executor" && row.workerRole !== "verifier")) {
    problems.push("worker_role");
  }
  if (typeof row.result !== "string" || !isExecutionReportResult(row.result)) problems.push("result");
  if (typeof row.candidateMutated !== "boolean") problems.push("candidate_mutated");
  if (typeof row.createdAt !== "string" || row.createdAt === "") problems.push("created_at");

  if (!Array.isArray(row.actionPerformed) || row.actionPerformed.some((entry) => typeof (entry as ActionSummary)?.action !== "string")) {
    problems.push("actions_performed");
  }
  for (const field of ["filesExamined", "filesChanged"] as const) {
    if (!Array.isArray(row[field]) || (row[field] as unknown[]).some((entry) => typeof entry !== "string")) {
      problems.push(field);
    }
  }
  if (!Array.isArray(row.commandsRun) || row.commandsRun.some((entry) => typeof (entry as CommandSummary)?.command !== "string")) {
    problems.push("commands_run");
  }
  if (
    !Array.isArray(row.testsRun)
    || row.testsRun.some((entry) => typeof (entry as TestSummary)?.name !== "string" || typeof (entry as TestSummary)?.outcome !== "string")
  ) {
    problems.push("tests_run");
  }
  if (!Array.isArray(row.findings) || row.findings.some((entry) => typeof (entry as ExecutionFinding)?.summary !== "string")) {
    problems.push("findings");
  }
  if (!Array.isArray(row.deviations) || row.deviations.some((entry) => typeof (entry as ExecutionDeviation)?.summary !== "string")) {
    problems.push("deviations");
  }
  if (
    !Array.isArray(row.blockers)
    || row.blockers.some(
      (entry) =>
        typeof (entry as ExecutionBlocker)?.kind !== "string"
        || !isExecutionBlockerKind((entry as ExecutionBlocker)?.kind ?? "")
        || typeof (entry as ExecutionBlocker)?.summary !== "string"
        || !isStringOrNull((entry as ExecutionBlocker)?.details)
        || !Array.isArray((entry as ExecutionBlocker)?.relevantRefs)
        || !(entry as ExecutionBlocker).relevantRefs.every(validateRefLike),
    )
  ) {
    problems.push("blockers");
  }
  if (
    !Array.isArray(row.deliverables)
    || row.deliverables.some(
      (entry) =>
        typeof (entry as DeliverableRef)?.name !== "string"
        || !isStringOrNull((entry as DeliverableRef)?.detail)
        || ((entry as DeliverableRef)?.ref !== null && !validateRefLike((entry as DeliverableRef)?.ref)),
    )
  ) {
    problems.push("deliverables");
  }
  if (problems.length > 0) {
    throw new RuntimeError("STORE_SCHEMA_INVALID", "execution_reports row is corrupt", {
      detail: { fields: problems },
    });
  }
  return {
    reportId: row.reportId as string,
    executionRunId: row.executionRunId as string,
    attemptId: row.attemptId as string,
    directiveId: row.directiveId as string,
    directiveRevision: row.directiveRevision as number,
    directiveHash: row.directiveHash as string,
    workerRole: row.workerRole as ExecutionReport["workerRole"],
    result: row.result as ExecutionReportResult,
    candidateMutated: row.candidateMutated as boolean,
    actionPerformed: row.actionPerformed as ActionSummary[],
    filesExamined: row.filesExamined as string[],
    filesChanged: row.filesChanged as string[],
    commandsRun: row.commandsRun as CommandSummary[],
    testsRun: row.testsRun as TestSummary[],
    findings: row.findings as ExecutionFinding[],
    deviations: row.deviations as ExecutionDeviation[],
    blockers: row.blockers as ExecutionBlocker[],
    deliverables: row.deliverables as DeliverableRef[],
    createdAt: row.createdAt as string,
  };
}

/**
 * Deterministic structural contract validation (E4 §34): every mandatory
 * section of the Directive's persisted report contract must be non-empty, and
 * result=blocked requires at least one structured blocker. Chosen strict
 * invariant (E4 §27): non-blocked results may NOT carry blockers — a blocker
 * is a cannot-continue fact, and a Worker that continued does not have one.
 * Violations are REPORT_CONTRACT_VIOLATION, deterministically.
 */
export function validateReportAgainstContract(
  report: Pick<
    ExecutionReport,
    | "result"
    | "blockers"
    | "actionPerformed"
    | "filesExamined"
    | "filesChanged"
    | "commandsRun"
    | "testsRun"
    | "findings"
    | "deviations"
    | "deliverables"
  >,
  contract: {
    requireActionsPerformed: boolean;
    requireFilesExamined: boolean;
    requireFilesChanged: boolean;
    requireCommandsRun: boolean;
    requireTestsRun: boolean;
    requireFindings: boolean;
    requireDeviations: boolean;
    requireBlockers: boolean;
    requireDeliverables: boolean;
  },
): void {
  const violations: string[] = [];
  const requirements: Array<[boolean, string, unknown[]]> = [
    [contract.requireActionsPerformed, "actionsPerformed", report.actionPerformed],
    [contract.requireFilesExamined, "filesExamined", report.filesExamined],
    [contract.requireFilesChanged, "filesChanged", report.filesChanged],
    [contract.requireCommandsRun, "commandsRun", report.commandsRun],
    [contract.requireTestsRun, "testsRun", report.testsRun],
    [contract.requireFindings, "findings", report.findings],
    [contract.requireDeviations, "deviations", report.deviations],
    [contract.requireBlockers, "blockers", report.blockers],
    [contract.requireDeliverables, "deliverables", report.deliverables],
  ];
  for (const [required, field, value] of requirements) {
    if (required && (!Array.isArray(value) || value.length === 0)) {
      violations.push(`${field} is required by the directive report contract but empty`);
    }
  }
  if (report.result === "blocked" && report.blockers.length === 0) {
    violations.push("result=blocked requires at least one structured blocker");
  }
  if (report.result !== "blocked" && report.blockers.length > 0) {
    violations.push(`blockers are only valid for result=blocked (got ${report.result})`);
  }
  if (violations.length > 0) {
    throw new RuntimeError("REPORT_CONTRACT_VIOLATION", "execution report violates the directive report contract", {
      detail: { violations },
      recoverable: false,
    });
  }
}
