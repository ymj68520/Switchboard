/**
 * SupervisorAssessment — v0.2.0 Phase 5 (verification acceptance layer).
 *
 * The frontier Supervisor's IMMUTABLE semantic judgment over ONE exact
 * Window candidate (exact window + exact candidateRevision). It is a
 * PROPOSAL, never accepted progress by itself: only `disposition = accept`
 * requests Core to run the acceptance gate, and only Core's ExecutionCommit
 * transaction creates accepted truth.
 *
 * Dispositions (directive §25): accept → the Core acceptance request;
 * rework / need_more_verification / blocked → durable judgments that change
 * NOTHING (no window close, no candidate move, no lifecycle change);
 * request_replan → records "the current FinalPlan may be insufficient" — it
 * deliberately does NOT transition the ExecutionRun (that belongs to the
 * Phase 6 ExecutionIssue transaction).
 *
 * EXACT BINDING (§22): an assessment binds one candidateRevision forever;
 * after the candidate advances it remains immutable history that can never
 * accept the newer candidate. IDEMPOTENCY (§27/§49): the Harness-supplied
 * assessment id is the stable retry identity — same id + same content
 * returns the existing record; same id + different content is
 * `assessment_conflict` (never "latest wins").
 */
import { createHash } from "node:crypto";

import { UltraPlanError } from "./errors.js";
import type {
  ExecutionReportID,
  ExecutionRunID,
  ExecutionStageID,
  SupervisorAssessmentID,
  VerificationWindowID,
} from "./ids.js";
import type { Timestamp } from "./refs.js";
import { stableStringify } from "./invariants.js";
import type { AcceptedExecutionStateRef } from "./execution-run.js";
import type { ExecutionPlanRef } from "./execution-stage.js";
import type { StageCompletionObligationID } from "./ids.js";

export const ASSESSMENT_DISPOSITIONS = [
  "accept",
  "rework",
  "need_more_verification",
  "blocked",
  "request_replan",
] as const;
export type SupervisorAssessmentDisposition = (typeof ASSESSMENT_DISPOSITIONS)[number];

export function assertAssessmentDisposition(value: string): asserts value is SupervisorAssessmentDisposition {
  if (!(ASSESSMENT_DISPOSITIONS as readonly string[]).includes(value)) {
    throw new UltraPlanError("invalid_scope", `"${value}" is not an assessment disposition`, {
      value,
      known: ASSESSMENT_DISPOSITIONS,
    });
  }
}

/** window → accept the current window candidate; stage → additionally request Stage closure. */
export const ASSESSMENT_ACCEPTANCE_SCOPES = ["window", "stage"] as const;
export type AssessmentAcceptanceScope = (typeof ASSESSMENT_ACCEPTANCE_SCOPES)[number];

export function assertAssessmentAcceptanceScope(value: string): asserts value is AssessmentAcceptanceScope {
  if (!(ASSESSMENT_ACCEPTANCE_SCOPES as readonly string[]).includes(value)) {
    throw new UltraPlanError("invalid_scope", `"${value}" is not an assessment acceptance scope`, {
      value,
      known: ASSESSMENT_ACCEPTANCE_SCOPES,
    });
  }
}

/** The immutable Supervisor semantic judgment. */
export interface SupervisorAssessment {
  id: SupervisorAssessmentID;

  executionRunID: ExecutionRunID;
  stageID: ExecutionStageID;
  windowID: VerificationWindowID;
  /** The EXACT candidate this judgment binds — never updated, never re-binding. */
  candidateRevision: number;

  /** The evaluated Window workset (§23): unified report refs, ALL bound to this window. */
  reportRefs: ExecutionReportID[];
  planRefs: ExecutionPlanRef[];
  /** Claimed satisfied Stage obligations — must be exact Stage obligations, each verifier-covered to count. */
  coveredObligations: StageCompletionObligationID[];

  acceptanceScope: AssessmentAcceptanceScope;
  disposition: SupervisorAssessmentDisposition;
  rationale: string;

  /** Canonical content hash (idempotency identity) — excludes createdAt. */
  hash: string;
  createdAt: Timestamp;
}

export type SupervisorAssessmentHashPayload = Omit<SupervisorAssessment, "createdAt" | "hash">;

export function supervisorAssessmentHashPayload(assessment: SupervisorAssessment): SupervisorAssessmentHashPayload {
  const { createdAt: _createdAt, hash: _hash, ...payload } = assessment;
  void _createdAt;
  void _hash;
  return payload;
}

export function computeSupervisorAssessmentHash(payload: SupervisorAssessmentHashPayload): string {
  const digest = createHash("sha256");
  digest.update(stableStringify(payload));
  return digest.digest("hex");
}

export function computeSupervisorAssessmentHashFromRecord(record: SupervisorAssessment): string {
  return computeSupervisorAssessmentHash(supervisorAssessmentHashPayload(record));
}

/** Deep content equality for the idempotent-retry check (§27). */
export function supervisorAssessmentContentEquals(a: SupervisorAssessment, b: SupervisorAssessment): boolean {
  return stableStringify(supervisorAssessmentHashPayload(a)) === stableStringify(supervisorAssessmentHashPayload(b));
}

export type { AcceptedExecutionStateRef };
