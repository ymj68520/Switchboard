/**
 * ExecutionReport — v0.2.0 Phase 4 (worker transaction protocol).
 *
 * The UNIFIED report schema: Executor and Verifier report through the exact
 * same object model — there is deliberately no second VerifierReport/
 * VerifierStore/VerifierAttempt family (SPEC v0.2.0 §18).
 *
 * TRUST MODEL (SPEC §18.2 / directive §28-§29): in v0.2.0 the Report is
 * trusted factual input from the Worker. `candidateMutation` is an EXPLICIT
 * field — never inferred from filesChanged — and is fully ORTHOGONAL to
 * `result`: completed+none, completed+changed, partial+changed, blocked+none,
 * blocked+changed, failed+none, and failed+changed are ALL legal (a command
 * can mutate generated state, partial work mutates before blocking, failures
 * can leave changes behind). The transaction never rewrites reality to match
 * policy expectations.
 *
 * IMMUTABILITY (directive §33): a submitted Report is immutable — no edit,
 * no amendment protocol. Additional facts require a new Directive → new
 * Attempt → new Report, keeping history uncrossable.
 *
 * `blocked` is a NORMAL execution result (directive §35) — never an Attempt
 * indeterminate, never a Run/Stage/Window failure. The Supervisor decides
 * the follow-up (new Directive revision, inspection, rework, or eventually
 * REPLAN_REQUIRED) in later phases.
 */
import { UltraPlanError } from "./errors.js";
import type { ExecutionAttemptID, ExecutionDirectiveID, ExecutionReportID } from "./ids.js";
import type { Timestamp } from "./refs.js";
import type { WorkerRole } from "./execution-attempt.js";
import type { ConflictResolutionOutcome } from "./verification-conflict.js";
import { CONFLICT_RESOLUTION_OUTCOMES } from "./verification-conflict.js";
import type { ReconciliationObservation } from "./attempt-reconciliation.js";
import { RECONCILIATION_OBSERVATIONS } from "./attempt-reconciliation.js";

export const EXECUTION_REPORT_RESULTS = ["completed", "partial", "blocked", "failed"] as const;
export type ExecutionReportResult = (typeof EXECUTION_REPORT_RESULTS)[number];

export function assertExecutionReportResult(value: string): asserts value is ExecutionReportResult {
  if (!(EXECUTION_REPORT_RESULTS as readonly string[]).includes(value)) {
    throw new UltraPlanError("invalid_scope", `"${value}" is not an execution report result`, {
      value,
      known: EXECUTION_REPORT_RESULTS,
    });
  }
}

/** Whether the Attempt changed candidate workspace state — explicit, never inferred. */
export const CANDIDATE_MUTATIONS = ["none", "changed"] as const;
export type CandidateMutation = (typeof CANDIDATE_MUTATIONS)[number];

/**
 * Structured blockers (directive §34) — a closed class vocabulary, not a
 * free-form string. Non-blocking concerns belong in `findings`, never here.
 */
export const EXECUTION_BLOCKER_KINDS = [
  "missing_context",
  "ambiguous_directive",
  "repository_mismatch",
  "unexpected_scope",
  "conflicting_requirements",
  "missing_prerequisite",
  "execution_environment_blocker",
] as const;
export type ExecutionBlockerKind = (typeof EXECUTION_BLOCKER_KINDS)[number];

export interface ExecutionBlocker {
  kind: ExecutionBlockerKind;
  summary: string;
  detail?: string;
  /** What the Worker needs to proceed, when expressible. */
  needed?: string;
  relatedPlanRefs?: unknown[];
}

export function assertExecutionBlocker(value: unknown): asserts value is ExecutionBlocker {
  if (typeof value !== "object" || value === null) {
    throw new UltraPlanError("invalid_scope", "A blocker must be an object");
  }
  const blocker = value as Record<string, unknown>;
  if (!(EXECUTION_BLOCKER_KINDS as readonly string[]).includes(blocker["kind"] as string)) {
    throw new UltraPlanError("invalid_scope", `Unknown blocker kind ${String(blocker["kind"])}`, {
      known: EXECUTION_BLOCKER_KINDS,
    });
  }
  if (typeof blocker["summary"] !== "string" || blocker["summary"].length === 0) {
    throw new UltraPlanError("invalid_scope", "A blocker requires a non-empty summary");
  }
}

/**
 * Semantic-preserving correction reporting (directive §36): the Worker's
 * sanctioned channel for "Supervisor expected X, repository reality is Y".
 * A scope deviation is REPORTED — never automatically a failure.
 */
export interface ExecutionDeviation {
  kind: "path" | "symbol" | "additional_requirement" | "other";
  expected?: string;
  actual?: string;
  note: string;
}

export function assertExecutionDeviation(value: unknown): asserts value is ExecutionDeviation {
  if (typeof value !== "object" || value === null) {
    throw new UltraPlanError("invalid_scope", "A deviation must be an object");
  }
  const deviation = value as Record<string, unknown>;
  if (!["path", "symbol", "additional_requirement", "other"].includes(deviation["kind"] as string)) {
    throw new UltraPlanError("invalid_scope", `Unknown deviation kind ${String(deviation["kind"])}`);
  }
  if (typeof deviation["note"] !== "string" || deviation["note"].length === 0) {
    throw new UltraPlanError("invalid_scope", "A deviation requires a non-empty note");
  }
}

/**
 * A report finding. Phase 5 acceptance classification: findings MAY carry an
 * explicit `acceptanceImpact` ("informational" | "blocking"). LEGACY plain
 * strings (pre-Phase-5 reports) remain loadable, but in the acceptance gate
 * an UNCLASSIFIED verifier finding is NEVER safe positive evidence — it
 * fails closed (never defaulted to informational).
 */
export type ExecutionReportFinding =
  | string
  | { statement: string; acceptanceImpact: "informational" | "blocking" };

export function findingAcceptanceImpact(
  finding: ExecutionReportFinding,
): "informational" | "blocking" | "unclassified" {
  if (typeof finding === "string") return "unclassified";
  return finding.acceptanceImpact ?? "unclassified";
}

/** The unified Worker report (Executor and Verifier alike). */
export interface ExecutionReport {
  id: ExecutionReportID;
  attemptID: ExecutionAttemptID;

  /** The EXACT Directive revision this report answers — id + revision + hash. */
  directive: { id: ExecutionDirectiveID; revision: number; hash: string };

  workerRole: WorkerRole;

  result: ExecutionReportResult;

  actionsPerformed: string[];
  filesExamined: string[];
  filesChanged: string[];
  commandsRun: string[];
  testsRun: string[];

  /** Non-blocking observations/concerns (never a substitute for blockers). Phase 5: findings MAY carry explicit acceptance classification. */
  findings: ExecutionReportFinding[];
  /** Semantic-preserving corrections the Worker made or observed (§36). */
  deviations: ExecutionDeviation[];
  /** Structured blockers — REQUIRED non-empty for result=blocked, forbidden otherwise. */
  blockers: ExecutionBlocker[];

  deliverables: string[];

  /** EXPLICIT candidate-workspace mutation fact — orthogonal to result (§28/§29). */
  candidateMutation: CandidateMutation;
  /** Provenance: the window's candidateRevision the Attempt executed against. */
  baseCandidateRevision: number;
  /** Provenance: the revision after this report's transaction (base or base+1). */
  resultingCandidateRevision: number;

  /**
   * Phase 6A §32 — the adjudication answer of a conflict-resolution report.
   * ONLY legal on a Directive whose verificationPurpose is
   * conflict_resolution; on any ordinary report its presence is a hard
   * validation failure (still ONE unified report schema — no second type).
   */
  conflictResolutionOutcome?: ConflictResolutionOutcome;
  /**
   * Phase 6A §47 — the observation of a reconciliation inspection report:
   * unchanged (candidate matches known revision) / changed (interrupted work
   * moved candidate reality) / unresolved (state could not be established
   * safely). ONLY legal on a reconciliation inspection Directive (one with
   * reconciliationTargets).
   */
  reconciliationObservation?: ReconciliationObservation;

  createdAt: Timestamp;
}

/**
 * Report-level semantic checks shared by the submission transaction and the
 * durable load validation: result vocabulary, blocker class vocabulary,
 * blocked ⇒ ≥1 blocker, non-blocked ⇒ no blockers, mutation provenance
 * shape (changed ⇒ base+1; none ⇒ base).
 */
export function assertExecutionReportInternallyConsistent(
  report: Pick<
    ExecutionReport,
    "result" | "blockers" | "candidateMutation" | "baseCandidateRevision" | "resultingCandidateRevision"
  >,
): void {
  assertExecutionReportResult(report.result);
  for (const blocker of report.blockers) assertExecutionBlocker(blocker);
  if (report.result === "blocked" && report.blockers.length === 0) {
    throw new UltraPlanError("invalid_scope", "A blocked report requires at least one structured blocker");
  }
  if (report.result !== "blocked" && report.blockers.length > 0) {
    throw new UltraPlanError(
      "invalid_scope",
      `Only a blocked report may carry blockers (result ${report.result}); use findings for non-blocking concerns`,
    );
  }
  if (report.candidateMutation === "changed" && report.resultingCandidateRevision !== report.baseCandidateRevision + 1) {
    throw new UltraPlanError(
      "invalid_scope",
      `A candidate-mutating report must record resultingCandidateRevision = base + 1 (${report.baseCandidateRevision} → ${report.resultingCandidateRevision})`,
    );
  }
  if (report.candidateMutation === "none" && report.resultingCandidateRevision !== report.baseCandidateRevision) {
    throw new UltraPlanError(
      "invalid_scope",
      `A non-mutating report must record resultingCandidateRevision = base (${report.resultingCandidateRevision} ≠ ${report.baseCandidateRevision})`,
    );
  }
}

/** Phase 6A §32 — vocabulary check for the optional conflict-resolution outcome. */
export function assertConflictResolutionOutcomeVocabulary(value: string): asserts value is ConflictResolutionOutcome {
  if (!(CONFLICT_RESOLUTION_OUTCOMES as readonly string[]).includes(value)) {
    throw new UltraPlanError("invalid_scope", `"${value}" is not a conflict resolution outcome`, {
      value,
      known: CONFLICT_RESOLUTION_OUTCOMES,
    });
  }
}

/** Phase 6A §47 — vocabulary check for the optional reconciliation observation. */
export function assertReconciliationObservationVocabulary(value: string): asserts value is ReconciliationObservation {
  if (!(RECONCILIATION_OBSERVATIONS as readonly string[]).includes(value)) {
    throw new UltraPlanError("invalid_scope", `"${value}" is not a reconciliation observation`, {
      value,
      known: RECONCILIATION_OBSERVATIONS,
    });
  }
}
