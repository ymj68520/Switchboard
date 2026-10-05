/**
 * VerificationConflict domain shape (v0.2.0 E8 §26–§43).
 *
 * PURE core: vocabulary, canonical shape, deterministic fingerprint, row
 * validation. No SQLite, no host, no MCP.
 *
 * A VerificationConflict exists ONLY when the Supervisor semantically asserts
 * that two or more trusted current-candidate Reports make materially mutually
 * exclusive claims about an acceptance-relevant fact (E8 §26). Core validates
 * STRUCTURE — exact Report binding, distinct claims, exact Window/revision —
 * never the semantic contradiction itself; ordinary "executor completed /
 * verifier found a defect" evidence is NOT a conflict (E8 §27/§41).
 *
 * Status lifecycle is Core-owned and bounded (E8 §30/§31/§36/§37/§38):
 *   open → resolving (exactly one resolution Directive, atomically bound)
 *        → resolved | verification_blocked (exactly one resolution Report).
 * A conflict binds its exact Window + candidateRevision; a candidate mutation
 * deterministically stales it — the row is never rewritten (E8 §39).
 *
 * This is Execution Memory: it never touches ExecutionRun lifecycle or Plan
 * Memory (E8 §27), and verification_blocked is an execution condition, not a
 * lifecycle (E8 §37).
 */

import { createHash } from "node:crypto";

import { canonicalJson } from "./canonical-json.js";
import { RuntimeError } from "../runtime/errors.js";

export const VERIFICATION_CONFLICT_STATUSES = ["open", "resolving", "resolved", "verification_blocked"] as const;

export type VerificationConflictStatus = (typeof VERIFICATION_CONFLICT_STATUSES)[number];

export function isVerificationConflictStatus(value: string): value is VerificationConflictStatus {
  return (VERIFICATION_CONFLICT_STATUSES as readonly string[]).includes(value);
}

/** One mutually-exclusive claim variant, bound to its exact trusted source Reports. */
export interface ConflictClaim {
  /** Stable Supervisor-authored variant label, e.g. "A" / "B". */
  variant: string;
  /** The Supervisor's neutral statement of this side's claim. */
  statement: string;
  /** The exact durable Report ids backing this claim variant (≥1). */
  sourceReportIds: string[];
}

export interface VerificationConflict {
  conflictId: string;
  /** A1 §6 — the exact ExecutionRun this conflict binds. */
  executionRunId: string;
  windowId: string;
  /** The EXACT candidate revision the conflict binds — never rewritten (E8 §39). */
  candidateRevision: number;
  /** The Supervisor's neutral statement of the disputed acceptance-relevant fact. */
  fact: string;
  claims: ConflictClaim[];
  status: VerificationConflictStatus;
  /** Exactly one resolution Directive once a resolver is bound (E8 §31/§38). */
  resolutionDirectiveId: string | null;
  resolutionDirectiveRevision: number | null;
  /** Exactly one resolution Report once the Supervisor resolves (E8 §36). */
  resolutionReportId: string | null;
  /** Deterministic duplicate fence (E8 §29) — UNIQUE in the Store. */
  fingerprint: string;
  rationale: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

/**
 * E8 §29 — the deterministic conflict fingerprint: run, window, exact
 * candidate revision, normalized fact, SORTED source report ids, canonical
 * claim variants. Worker identity is deliberately NEVER part of the
 * fingerprint (a re-declaration naming the same reports/fact is the same
 * conflict regardless of who produced them).
 */
export function verificationConflictFingerprint(input: {
  executionRunId: string;
  windowId: string;
  candidateRevision: number;
  fact: string;
  claims: ConflictClaim[];
}): string {
  const sourceReportIds = [...new Set(input.claims.flatMap((claim) => claim.sourceReportIds))].sort();
  const variants = input.claims
    .map((claim) => ({ variant: claim.variant, statement: claim.statement }))
    .sort((a, b) => (a.variant < b.variant ? -1 : a.variant > b.variant ? 1 : 0));
  return `sha256:${createHash("sha256")
    .update(
      canonicalJson({
        kind: "verification_conflict",
        executionRunId: input.executionRunId,
        windowId: input.windowId,
        candidateRevision: input.candidateRevision,
        fact: input.fact.trim(),
        sourceReportIds,
        claimVariants: variants,
      }),
      "utf8",
    )
    .digest("hex")}`;
}

/** Validate model-supplied claim input against the canonical shape (E8 §28). */
export function parseConflictClaim(raw: unknown): ConflictClaim {
  if (typeof raw !== "object" || raw === null) {
    throw new RuntimeError("VERIFICATION_CONFLICT_INVALID", "conflict claim is not an object", { recoverable: false });
  }
  const record = raw as Record<string, unknown>;
  // The model boundary may speak snake_case; normalize before validation.
  const sourceReportIds = (record.sourceReportIds ?? record.source_report_ids) as unknown;
  const problems: string[] = [];
  if (typeof record.variant !== "string" || record.variant.trim() === "") problems.push("variant");
  if (typeof record.statement !== "string" || record.statement.trim() === "") problems.push("statement");
  if (
    !Array.isArray(sourceReportIds)
    || sourceReportIds.length === 0
    || sourceReportIds.some((id) => typeof id !== "string" || id === "")
  ) {
    problems.push("sourceReportIds");
  }
  if (problems.length > 0) {
    throw new RuntimeError(
      "VERIFICATION_CONFLICT_INVALID",
      `conflict claim is malformed: ${problems.join(", ")}`,
      { detail: { problems }, recoverable: false },
    );
  }
  return {
    variant: (record.variant as string).trim(),
    statement: (record.statement as string).trim(),
    sourceReportIds: sourceReportIds as string[],
  };
}

/**
 * Validate a raw database row into a VerificationConflict. Illegal status
 * vocabulary, a broken claim shape, or lifecycle-shape violations (resolved
 * without a resolution Report; a resolution Directive without resolving-or-
 * later) is store corruption — STORE_SCHEMA_INVALID, never smuggled into core.
 */
export function parseVerificationConflictRow(row: Record<string, unknown>): VerificationConflict {
  const problems: string[] = [];
  if (typeof row.conflictId !== "string" || row.conflictId === "") problems.push("conflict_id");
  if (typeof row.executionRunId !== "string" || row.executionRunId === "") problems.push("execution_run_id");
  if (typeof row.windowId !== "string" || row.windowId === "") problems.push("window_id");
  if (typeof row.candidateRevision !== "number" || !Number.isInteger(row.candidateRevision) || row.candidateRevision < 0) {
    problems.push("candidate_revision");
  }
  if (typeof row.fact !== "string" || row.fact === "") problems.push("fact");
  if (!Array.isArray(row.claims) || row.claims.length < 2) problems.push("claims");
  if (typeof row.fingerprint !== "string" || row.fingerprint === "") problems.push("fingerprint");
  if (typeof row.status !== "string" || !isVerificationConflictStatus(row.status)) problems.push("status");
  if (row.resolutionDirectiveId !== null && typeof row.resolutionDirectiveId !== "string") problems.push("resolution_directive_id");
  if (row.resolutionDirectiveRevision !== null && (typeof row.resolutionDirectiveRevision !== "number" || !Number.isInteger(row.resolutionDirectiveRevision))) {
    problems.push("resolution_directive_revision");
  }
  if (row.resolutionReportId !== null && typeof row.resolutionReportId !== "string") problems.push("resolution_report_id");
  if (row.rationale !== null && typeof row.rationale !== "string") problems.push("rationale");
  if (typeof row.createdAt !== "string" || row.createdAt === "") problems.push("created_at");
  if (row.resolvedAt !== null && typeof row.resolvedAt !== "string") problems.push("resolved_at");
  if (problems.length > 0) {
    throw new RuntimeError("STORE_SCHEMA_INVALID", "verification_conflicts row is corrupt", {
      detail: { fields: problems },
    });
  }
  const status = row.status as VerificationConflictStatus;
  if ((status === "resolved" || status === "verification_blocked") && (typeof row.resolutionReportId !== "string" || row.resolvedAt === null)) {
    throw new RuntimeError("STORE_SCHEMA_INVALID", "a settled conflict requires its exact resolution report and timestamp", {
      detail: { fields: ["resolution_report_id"] },
    });
  }
  if (row.resolutionDirectiveId !== null && status === "open") {
    throw new RuntimeError("STORE_SCHEMA_INVALID", "an open conflict cannot already carry a resolution directive", {
      detail: { fields: ["status"] },
    });
  }
  if (row.resolutionDirectiveId === null && status !== "open") {
    throw new RuntimeError("STORE_SCHEMA_INVALID", "a non-open conflict must carry its resolution directive", {
      detail: { fields: ["resolution_directive_id"] },
    });
  }
  return {
    conflictId: row.conflictId as string,
    executionRunId: row.executionRunId as string,
    windowId: row.windowId as string,
    candidateRevision: row.candidateRevision as number,
    fact: row.fact as string,
    claims: row.claims as ConflictClaim[],
    status,
    resolutionDirectiveId: (row.resolutionDirectiveId as string | null) ?? null,
    resolutionDirectiveRevision: (row.resolutionDirectiveRevision as number | null) ?? null,
    resolutionReportId: (row.resolutionReportId as string | null) ?? null,
    fingerprint: row.fingerprint as string,
    rationale: (row.rationale as string | null) ?? null,
    createdAt: row.createdAt as string,
    resolvedAt: (row.resolvedAt as string | null) ?? null,
  };
}

/** The neutral, identity-blinded context a resolver may see (E8 §32). */
export interface BlindedConflictContext {
  conflictId: string;
  fact: string;
  claims: Array<{ variant: string; statement: string }>;
  candidateRevision: number;
}

export function blindedConflictContext(conflict: VerificationConflict): BlindedConflictContext {
  return {
    conflictId: conflict.conflictId,
    fact: conflict.fact,
    claims: conflict.claims.map((claim) => ({ variant: claim.variant, statement: claim.statement })),
    candidateRevision: conflict.candidateRevision,
  };
}
