/**
 * Attempt-reconciliation domain (v0.2.0 E11 §4–§10/§15–§16).
 *
 * PURE core: vocabulary, canonical shapes, capability classification, the
 * hashed required-action encoding, row validation. No SQLite, no host, no MCP.
 *
 * An indeterminate Attempt is PERMANENT history (E11 §4): no transition out of
 * `indeterminate` exists, and no ExecutionReport is ever fabricated for it
 * (E11 §5). Recovery is expressed by two SEPARATE durable facts:
 *
 *   binding       the exact indeterminate Attempt ↔ ONE logical
 *                 reconciliation Directive id (E11 §9). Multiple revisions of
 *                 that logical id are allowed; a second unrelated logical
 *                 reconciliation Directive is forbidden.
 *   resolution    the final immutable AttemptReconciliation (E11 §8) — at most
 *                 one per Attempt, append-only.
 *
 * The reconciliation target identity is hash-covered WITHOUT a protocol v4
 * (E11 §10 preferred option 1): the reconciliation Directive carries the exact
 * structured requiredAction `reconcile_indeterminate_attempt:<attemptId>` —
 * requiredActions are part of the frozen v1/v2/v3 canonical payloads — and the
 * machine-readable binding row is persisted atomically with issuance.
 */

import { RuntimeError } from "../runtime/errors.js";
import type { ExecutionCapabilityEnvelope } from "./execution-directive.js";

/** E11 §8 — the frozen resolution vocabulary. */
export const ATTEMPT_RECONCILIATION_RESOLUTIONS = [
  "no_effect",
  "no_effect_by_capability",
  "candidate_changed",
] as const;

export type AttemptReconciliationResolution = (typeof ATTEMPT_RECONCILIATION_RESOLUTIONS)[number];

export function isAttemptReconciliationResolution(value: string): value is AttemptReconciliationResolution {
  return (ATTEMPT_RECONCILIATION_RESOLUTIONS as readonly string[]).includes(value);
}

/** The exact structured requiredAction that hash-covers the reconciliation target (E11 §10). */
export const RECONCILIATION_ACTION = "reconcile_indeterminate_attempt";

export function reconciliationRequiredAction(attemptId: string): { action: string; detail: string | null } {
  return { action: RECONCILIATION_ACTION, detail: attemptId };
}

/** True when a Directive's structured requiredActions name this exact target. */
export function directiveTargetsAttemptReconciliation(
  requiredActions: ReadonlyArray<{ action: string; detail: string | null }>,
  attemptId: string,
): boolean {
  return requiredActions.some(
    (candidate) => candidate.action === RECONCILIATION_ACTION && candidate.detail === attemptId,
  );
}

/** The reconciliation Directive a binding points at (kind is frozen to inspection, E11 §11). */
export interface AttemptReconciliationBinding {
  attemptId: string;
  executionRunId: string;
  /** The bound LOGICAL reconciliation Directive id (revisions allowed). */
  directiveId: string;
  /** The revision that existed when the binding was created (provenance only). */
  firstDirectiveRevision: number;
  createdAt: string;
}

/**
 * E11 §8 — the immutable final reconciliation. `candidateRevisionBefore ==
 * After` exactly for the two no-effect resolutions and `After == Before + 1`
 * exactly for candidate_changed (DDL CHECK); `inspectionReportId` is null ONLY
 * for the deterministic no_effect_by_capability proof (E11 §16/§54).
 */
export interface AttemptReconciliation {
  reconciliationId: string;
  attemptId: string;
  executionRunId: string;
  /** The EXACT completed reconciliation Directive revision that resolved it. */
  directiveId: string;
  directiveRevision: number;
  sourceWindowId: string;
  resolution: AttemptReconciliationResolution;
  /** The completed non-mutating inspection Report; null only by capability proof. */
  inspectionReportId: string | null;
  candidateRevisionBefore: number;
  candidateRevisionAfter: number;
  rationale: string;
  createdAt: string;
}

/**
 * E11 §15 — the side-effect-capability classification of an interrupted
 * Directive: derived ONLY from the frozen capability envelope's EFFECTIVE
 * authority (the launch gate already refused unenforceable envelopes, so the
 * persisted envelope is authoritative). Worker role is intentionally NOT the
 * criterion — role and capability are orthogonal (E11 §15).
 */
export function isSideEffectCapable(envelope: ExecutionCapabilityEnvelope): boolean {
  return (
    envelope.repositoryWrite
    || envelope.commandExecution
    || envelope.dependencyMutation
    || envelope.gitCommit
    || envelope.gitPush
    || envelope.externalServiceMutation
  );
}

/** Validate a raw binding row. Broken identity is store corruption. */
export function parseAttemptReconciliationBindingRow(row: Record<string, unknown>): AttemptReconciliationBinding {
  const problems: string[] = [];
  if (typeof row.attemptId !== "string" || row.attemptId === "") problems.push("attempt_id");
  if (typeof row.executionRunId !== "string" || row.executionRunId === "") problems.push("execution_run_id");
  if (typeof row.directiveId !== "string" || row.directiveId === "") problems.push("directive_id");
  if (
    typeof row.firstDirectiveRevision !== "number"
    || !Number.isInteger(row.firstDirectiveRevision)
    || row.firstDirectiveRevision < 1
  ) {
    problems.push("first_directive_revision");
  }
  if (typeof row.createdAt !== "string" || row.createdAt === "") problems.push("created_at");
  if (problems.length > 0) {
    throw new RuntimeError("STORE_SCHEMA_INVALID", "attempt reconciliation binding row is corrupt", {
      detail: { fields: problems },
    });
  }
  return {
    attemptId: row.attemptId as string,
    executionRunId: row.executionRunId as string,
    directiveId: row.directiveId as string,
    firstDirectiveRevision: row.firstDirectiveRevision as number,
    createdAt: row.createdAt as string,
  };
}

/** Validate a raw resolution row, including the revision-delta shape (E11 §25/§26). */
export function parseAttemptReconciliationRow(row: Record<string, unknown>): AttemptReconciliation {
  const problems: string[] = [];
  if (typeof row.reconciliationId !== "string" || row.reconciliationId === "") problems.push("reconciliation_id");
  if (typeof row.attemptId !== "string" || row.attemptId === "") problems.push("attempt_id");
  if (typeof row.executionRunId !== "string" || row.executionRunId === "") problems.push("execution_run_id");
  if (typeof row.directiveId !== "string" || row.directiveId === "") problems.push("directive_id");
  if (
    typeof row.directiveRevision !== "number" || !Number.isInteger(row.directiveRevision) || row.directiveRevision < 1
  ) {
    problems.push("directive_revision");
  }
  if (typeof row.sourceWindowId !== "string" || row.sourceWindowId === "") problems.push("source_window_id");
  if (typeof row.resolution !== "string" || !isAttemptReconciliationResolution(row.resolution)) problems.push("resolution");
  if (row.inspectionReportId !== null && typeof row.inspectionReportId !== "string") problems.push("inspection_report_id");
  if (
    typeof row.candidateRevisionBefore !== "number"
    || !Number.isInteger(row.candidateRevisionBefore)
    || row.candidateRevisionBefore < 0
  ) {
    problems.push("candidate_revision_before");
  }
  if (
    typeof row.candidateRevisionAfter !== "number"
    || !Number.isInteger(row.candidateRevisionAfter)
    || row.candidateRevisionAfter < 0
  ) {
    problems.push("candidate_revision_after");
  }
  if (typeof row.rationale !== "string" || row.rationale === "") problems.push("rationale");
  if (typeof row.createdAt !== "string" || row.createdAt === "") problems.push("created_at");
  if (problems.length === 0) {
    // The revision-delta shape is re-derived at parse (the DDL CHECK is the
    // first fence): no_effect never moves the candidate; candidate_changed
    // moves it exactly one; the capability proof never moves it and never
    // carries an inspection Report.
    const resolution = row.resolution as AttemptReconciliationResolution;
    const before = row.candidateRevisionBefore as number;
    const after = row.candidateRevisionAfter as number;
    if (resolution === "candidate_changed" && after !== before + 1) problems.push("revision_delta");
    if (resolution !== "candidate_changed" && after !== before) problems.push("revision_delta");
    if (resolution === "no_effect_by_capability") {
      if (row.inspectionReportId !== null) problems.push("inspection_report_shape");
    } else if (row.inspectionReportId === null) {
      problems.push("inspection_report_shape");
    }
  }
  if (problems.length > 0) {
    throw new RuntimeError("STORE_SCHEMA_INVALID", "attempt reconciliation row is corrupt", {
      detail: { fields: problems },
    });
  }
  return {
    reconciliationId: row.reconciliationId as string,
    attemptId: row.attemptId as string,
    executionRunId: row.executionRunId as string,
    directiveId: row.directiveId as string,
    directiveRevision: row.directiveRevision as number,
    sourceWindowId: row.sourceWindowId as string,
    resolution: row.resolution as AttemptReconciliationResolution,
    inspectionReportId: (row.inspectionReportId as string | null) ?? null,
    candidateRevisionBefore: row.candidateRevisionBefore as number,
    candidateRevisionAfter: row.candidateRevisionAfter as number,
    rationale: row.rationale as string,
    createdAt: row.createdAt as string,
  };
}
