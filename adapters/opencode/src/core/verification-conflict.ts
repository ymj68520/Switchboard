/**
 * VerificationConflict — v0.2.0 Phase 6A Part B (verification conflict
 * resolution).
 *
 * A VerificationConflict is the DURABLE record of one disputed acceptance-
 * relevant fact: two trusted execution facts give mutually exclusive
 * conclusions about the SAME fact, and the next step cannot be decided
 * before the dispute is adjudicated. Creation is Supervisor-driven ONLY
 * (§19): Core never detects semantic contradictions from natural language —
 * it binds, gates, and records.
 *
 * EVIDENCE MODEL (§20/§21): evidence is referenced EXACTLY, via
 * VerificationEvidenceRef. Reports are immutable, so a `findingIndex` into a
 * report's findings array is a stable reference (there is deliberately no
 * second finding-id vocabulary).
 *
 * BLOCKING-EVIDENCE UPGRADE (§21/§37): the acceptance gate no longer keeps a
 * boolean "negative verification exists" — it enumerates canonical
 * current-candidate blocking evidence as exact refs, subtracts the
 * neutralized evidence of protocol-valid resolved conflicts, and only then
 * decides. A conflict resolver is NOT a tool to make commits pass (§36): the
 * supported side, if itself blocking, keeps blocking.
 *
 * ONE RESOLVER (§29/§35): at most one conflict-resolution Directive per
 * conflict, and no recursion after a verification_blocked terminal state.
 * Candidate-scoped (§24): a conflict binds candidateRevision N forever; a
 * later candidate N+1 makes it history that cannot block the newer candidate.
 */
import { UltraPlanError } from "./errors.js";
import type {
  ExecutionAttemptID,
  ExecutionDirectiveID,
  ExecutionReportID,
  ExecutionRunID,
  ExecutionStageID,
  VerificationConflictID,
  VerificationWindowID,
} from "./ids.js";
import type { Timestamp } from "./refs.js";
import type { ExecutionReport } from "./execution-report.js";
import { findingAcceptanceImpact } from "./execution-report.js";
import type { WorkerRole } from "./execution-attempt.js";
import type { ExecutionDirective } from "./execution-directive.js";

/** Exact reference to one piece of canonical verification evidence (§20). */
export type VerificationEvidenceRef =
  | { kind: "report_result"; reportID: ExecutionReportID }
  | { kind: "finding"; reportID: ExecutionReportID; findingIndex: number };

/** The outcome vocabulary of a conflict-resolution report (§32). */
export const CONFLICT_RESOLUTION_OUTCOMES = ["supports_a", "supports_b", "supports_neither", "unresolved"] as const;
export type ConflictResolutionOutcome = (typeof CONFLICT_RESOLUTION_OUTCOMES)[number];

export function assertConflictResolutionOutcome(value: string): asserts value is ConflictResolutionOutcome {
  if (!(CONFLICT_RESOLUTION_OUTCOMES as readonly string[]).includes(value)) {
    throw new UltraPlanError("invalid_scope", `"${value}" is not a conflict resolution outcome`, {
      value,
      known: CONFLICT_RESOLUTION_OUTCOMES,
    });
  }
}

export const VERIFICATION_CONFLICT_STATUSES = ["open", "resolved", "verification_blocked"] as const;
export type VerificationConflictStatus = (typeof VERIFICATION_CONFLICT_STATUSES)[number];

export function assertVerificationConflictStatus(value: string): asserts value is VerificationConflictStatus {
  if (!(VERIFICATION_CONFLICT_STATUSES as readonly string[]).includes(value)) {
    throw new UltraPlanError("invalid_scope", `"${value}" is not a verification conflict status`, {
      value,
      known: VERIFICATION_CONFLICT_STATUSES,
    });
  }
}

/** The durable disputed-fact record (§22). */
export interface VerificationConflict {
  id: VerificationConflictID;

  executionRunID: ExecutionRunID;
  stageID: ExecutionStageID;
  windowID: VerificationWindowID;
  /** The EXACT candidate the disputed evidence binds — never re-scoped (§24). */
  candidateRevision: number;

  evidenceA: VerificationEvidenceRef;
  evidenceB: VerificationEvidenceRef;
  /** The mutually exclusive conclusions, Supervisor-provenance. */
  claimA: string;
  claimB: string;
  /** The neutral factual question the resolver must answer (§31). */
  resolutionQuestion: string;

  status: VerificationConflictStatus;

  /** Bound at issuance of THE one conflict-resolution Directive (§29). */
  resolutionDirectiveRef?: { id: ExecutionDirectiveID; revision: number; hash: string };
  /** Set at finalization (§34) — inside the resolution Report's transaction. */
  resolutionReportRef?: ExecutionReportID;
  resolutionOutcome?: ConflictResolutionOutcome;
  /** Deterministic deactivation set derived from the outcome (§36); empty for blocked. */
  neutralizedEvidenceRefs?: VerificationEvidenceRef[];
  /** Terminal timestamp — set when the conflict reaches resolved OR verification_blocked. */
  resolvedAt?: Timestamp;

  createdAt: Timestamp;
}

export function verificationEvidenceRefEquals(a: VerificationEvidenceRef, b: VerificationEvidenceRef): boolean {
  if (a.kind !== b.kind) return false;
  if (a.reportID !== b.reportID) return false;
  if (a.kind === "finding" && b.kind === "finding") return a.findingIndex === b.findingIndex;
  return true;
}

/** §36 — the deterministic neutralization rule. `unresolved` neutralizes nothing. */
export function neutralizedEvidenceForOutcome(
  outcome: ConflictResolutionOutcome,
  evidenceA: VerificationEvidenceRef,
  evidenceB: VerificationEvidenceRef,
): VerificationEvidenceRef[] {
  switch (outcome) {
    case "supports_a":
      return [structuredClone(evidenceB)];
    case "supports_b":
      return [structuredClone(evidenceA)];
    case "supports_neither":
      return [structuredClone(evidenceA), structuredClone(evidenceB)];
    case "unresolved":
      return [];
  }
}

/** Shape check for a stored/loaded evidence ref (fail closed, §61). */
export function assertVerificationEvidenceRef(value: unknown): asserts value is VerificationEvidenceRef {
  if (typeof value !== "object" || value === null) {
    throw new UltraPlanError("invalid_verification_evidence_ref", "A verification evidence ref must be an object");
  }
  const ref = value as Record<string, unknown>;
  if (ref["kind"] === "report_result") {
    if (typeof ref["reportID"] !== "string" || ref["reportID"].length === 0) {
      throw new UltraPlanError("invalid_verification_evidence_ref", "A report_result evidence ref requires a reportID");
    }
    return;
  }
  if (ref["kind"] === "finding") {
    if (
      typeof ref["reportID"] !== "string" ||
      ref["reportID"].length === 0 ||
      typeof ref["findingIndex"] !== "number" ||
      !Number.isInteger(ref["findingIndex"]) ||
      (ref["findingIndex"] as number) < 0
    ) {
      throw new UltraPlanError("invalid_verification_evidence_ref", "A finding evidence ref requires a reportID and a non-negative findingIndex");
    }
    return;
  }
  throw new UltraPlanError("invalid_verification_evidence_ref", `Unknown verification evidence ref kind ${String(ref["kind"])}`);
}

/** The canonical inputs the blocking-evidence enumeration scans (§21). */
export interface BlockingEvidenceInputs {
  candidateRevision: number;
  /** The window's reports with their attempts and bound directives. */
  evidence: {
    report: ExecutionReport;
    attempt: { id: ExecutionAttemptID; workerRole: WorkerRole; state: string; directive: { id: ExecutionDirectiveID; revision: number } };
    directive: ExecutionDirective | undefined;
  }[];
}

/**
 * §21 — CANONICAL current-candidate blocking evidence enumeration. A verifier
 * report bound to the exact current candidate contributes:
 * - a `report_result` ref when its result is failed/partial/blocked;
 * - a `finding` ref for every blocking OR unclassified finding (unclassified
 *   verifier findings are never safe positive evidence — Phase 5 semantics).
 * Non-verifier work and stale-candidate reports contribute nothing.
 */
export function enumerateBlockingEvidence(inputs: BlockingEvidenceInputs): VerificationEvidenceRef[] {
  const blocking: VerificationEvidenceRef[] = [];
  for (const { report, attempt, directive } of inputs.evidence) {
    if (attempt.workerRole !== "verifier" || attempt.state !== "reported") continue;
    if (!directive || directive.kind !== "verification") continue;
    if (report.baseCandidateRevision !== inputs.candidateRevision) continue;
    if (report.result !== "completed") {
      blocking.push({ kind: "report_result", reportID: report.id });
    }
    report.findings.forEach((finding, index) => {
      if (findingAcceptanceImpact(finding) !== "informational") {
        blocking.push({ kind: "finding", reportID: report.id, findingIndex: index });
      }
    });
  }
  return blocking;
}

/**
 * §37 — canonical blocking evidence MINUS protocol-valid neutralized evidence
 * of resolved current-candidate conflicts = effective blocking evidence.
 */
export function effectiveBlockingEvidence(
  blocking: readonly VerificationEvidenceRef[],
  neutralized: readonly VerificationEvidenceRef[],
): VerificationEvidenceRef[] {
  return blocking.filter((ref) => !neutralized.some((candidate) => verificationEvidenceRefEquals(candidate, ref)));
}
