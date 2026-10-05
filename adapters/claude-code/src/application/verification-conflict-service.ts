/**
 * Verification-conflict application service (v0.2.0 E8 §26–§43).
 *
 * Authority model: the Supervisor owns the SEMANTIC assertion — that these
 * trusted current-candidate Reports materially contradict on an acceptance-
 * relevant fact, and later, whether the dedicated resolver actually resolved
 * it. Core owns the STRUCTURE and the bounds: exact Report binding at the
 * exact current candidate, the deterministic duplicate fence, at most one
 * resolution Directive, a fresh real E5 resolver (enforced at claim time), and
 * the acceptance fence (E8 §40).
 *
 * Ordinary "executor completed / verifier found a defect" evidence is NOT a
 * conflict (E8 §27/§41) — Core never auto-declares from result vocabulary.
 */

import { parseConflictClaim, type ConflictClaim, type VerificationConflict } from "../core/verification-conflict.js";
import { RuntimeError } from "../runtime/errors.js";
import { getOpenWindowInTx } from "../store/execution-structure.js";
import { getAttemptForDirectiveInTx } from "../store/execution-attempts.js";
import { getReportForAttemptInTx } from "../store/execution-reports.js";
import { getWorkerInvocationInTx } from "../store/worker-invocations.js";
import {
  getVerificationConflictInTx,
  insertVerificationConflictInTx,
  listWindowConflictsInTx,
  settleConflictInTx,
} from "../store/verification-conflicts.js";
import { requireCurrentSupervisorAuthorityInTx } from "../store/supervisor-bindings.js";
import type { StoreClock } from "../store/migration-runner.js";
import type { StoreTx } from "../store/transaction.js";

function conflictServiceError(
  code:
    | "VERIFICATION_CONFLICT_INVALID"
    | "VERIFICATION_CONFLICT_STALE"
    | "VERIFICATION_CONFLICT_RESOLUTION_INVALID"
    | "WINDOW_BASE_MISMATCH",
  message: string,
  detail?: Record<string, unknown>,
): RuntimeError {
  return new RuntimeError(code, message, { detail, recoverable: false });
}

/** The conflict + its exact current-window context, or a typed refusal. */
function requireCurrentConflictInTx(tx: StoreTx, conflictId: string): { conflict: VerificationConflict; candidateRevision: number } {
  const conflict = getVerificationConflictInTx(tx, conflictId);
  if (conflict === null) {
    throw conflictServiceError("VERIFICATION_CONFLICT_INVALID", `no verification conflict exists for '${conflictId}'`, {
      conflictId,
    });
  }
  const window = getOpenWindowInTx(tx, conflict.executionRunId);
  if (window === null || window.id !== conflict.windowId) {
    throw conflictServiceError(
      "VERIFICATION_CONFLICT_STALE",
      `conflict '${conflictId}' binds window '${conflict.windowId}' which is no longer the open window (E8 §39)`,
      { conflictId, windowId: conflict.windowId },
    );
  }
  if (window.candidateRevision !== conflict.candidateRevision) {
    throw conflictServiceError(
      "VERIFICATION_CONFLICT_STALE",
      `conflict '${conflictId}' binds candidateRevision ${conflict.candidateRevision}; the window moved to ${window.candidateRevision} — the conflict is historical and never rewritten (E8 §39)`,
      { conflictId, boundRevision: conflict.candidateRevision, currentRevision: window.candidateRevision },
    );
  }
  return { conflict, candidateRevision: window.candidateRevision };
}

/**
 * E8 §30 — the Supervisor-only declaration. Core validates: current supervisor
 * fence, an open Window, ≥2 claims with ≥2 DISTINCT trusted current-candidate
 * source Reports (same run, same Window, exact current candidateRevision,
 * completed, non-mutating), and no identical fingerprint. The conflict is
 * created OPEN; no Worker launches automatically (E8 §30).
 */
export function declareVerificationConflictInTx(
  tx: StoreTx,
  input: {
    executionRunId: string;
    sessionId: string;
    workspaceId: string;
    generation: number;
    fact: string;
    claims: unknown[];
    rationale?: string;
  },
  clock: StoreClock,
  now: string,
): VerificationConflict {
  requireCurrentSupervisorAuthorityInTx(tx, {
    executionRunId: input.executionRunId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    generation: input.generation,
  });
  if (typeof input.fact !== "string" || input.fact.trim() === "") {
    throw conflictServiceError("VERIFICATION_CONFLICT_INVALID", "conflict fact must be a non-empty statement (E8 §27)", {});
  }
  const window = getOpenWindowInTx(tx, input.executionRunId);
  if (window === null) {
    throw conflictServiceError(
      "VERIFICATION_CONFLICT_INVALID",
      `run '${input.executionRunId}' has no open verification window; conflicts bind the exact current candidate (E8 §28/§30)`,
      { executionRunId: input.executionRunId },
    );
  }
  const claims: ConflictClaim[] = input.claims.map((raw) => parseConflictClaim(raw));
  if (claims.length < 2) {
    throw conflictServiceError(
      "VERIFICATION_CONFLICT_INVALID",
      `a conflict requires at least two mutually exclusive claim variants; got ${claims.length} (E8 §28)`,
      { claimCount: claims.length },
    );
  }
  const variants = new Set(claims.map((claim) => claim.variant));
  if (variants.size !== claims.length) {
    throw conflictServiceError("VERIFICATION_CONFLICT_INVALID", "claim variants must be distinct (E8 §28)", {
      variants: claims.map((claim) => claim.variant),
    });
  }
  // E8 §28 — every source Report: same run, same Window, exact current
  // candidateRevision (through its immutable Directive binding), durable,
  // completed and non-mutating (a "trusted" Report). At least 2 DISTINCT
  // Reports across the claims.
  const reportIds = [...new Set(claims.flatMap((claim) => claim.sourceReportIds))];
  if (reportIds.length < 2) {
    throw conflictServiceError(
      "VERIFICATION_CONFLICT_INVALID",
      `a conflict requires at least two distinct source Reports; got ${reportIds.length} (E8 §28)`,
      { reportIds },
    );
  }
  for (const reportId of reportIds) {
    const binding = tx
      .prepare(
        "SELECT r.execution_run_id AS executionRunId, d.window_id AS windowId, d.base_candidate_revision AS revision, "
        + "r.result AS result, r.candidate_mutated AS mutated FROM execution_reports r "
        + "JOIN execution_directives d ON d.directive_id = r.directive_id AND d.revision = r.directive_revision "
        + "WHERE r.report_id = ?",
      )
      .get(reportId) as
      | { executionRunId: string; windowId: string; revision: number; result: string; mutated: number }
      | undefined;
    if (binding === undefined) {
      throw conflictServiceError("VERIFICATION_CONFLICT_INVALID", `source report '${reportId}' does not exist`, { reportId });
    }
    if (binding.executionRunId !== input.executionRunId || binding.windowId !== window.id) {
      throw conflictServiceError(
        "VERIFICATION_CONFLICT_INVALID",
        `source report '${reportId}' belongs to another run/window — only current-candidate Reports of THIS window may back a conflict (E8 §28)`,
        { reportId },
      );
    }
    if (binding.revision !== window.candidateRevision) {
      throw conflictServiceError(
        "VERIFICATION_CONFLICT_INVALID",
        `source report '${reportId}' is from candidateRevision ${binding.revision}; conflicts bind the EXACT current candidate ${window.candidateRevision} (E8 §28)`,
        { reportId, boundRevision: binding.revision, currentRevision: window.candidateRevision },
      );
    }
    if (binding.result !== "completed" || binding.mutated !== 0) {
      throw conflictServiceError(
        "VERIFICATION_CONFLICT_INVALID",
        `source report '${reportId}' is not a trusted current-candidate Report (completed, non-mutating required) (E8 §26/§28)`,
        { reportId, result: binding.result, candidateMutated: binding.mutated !== 0 },
      );
    }
  }
  return insertVerificationConflictInTx(
    tx,
    {
      conflictId: `vc_${clock.newId()}`,
      executionRunId: input.executionRunId,
      windowId: window.id,
      candidateRevision: window.candidateRevision,
      fact: input.fact.trim(),
      claims,
      rationale: typeof input.rationale === "string" && input.rationale.trim() !== "" ? input.rationale.trim() : null,
    },
    now,
  );
}

/**
 * E8 §35/§36/§37 — the Supervisor settles the conflict on its ONE dedicated
 * resolver's Report: `resolved` or `verification_blocked`, with non-empty
 * rationale. Core does NOT infer the outcome from the finding prose; it
 * validates only that the exact resolution Report is a completed, non-mutating,
 * exact-candidate, real fresh resolver Report.
 */
export function resolveVerificationConflictInTx(
  tx: StoreTx,
  input: {
    executionRunId: string;
    sessionId: string;
    workspaceId: string;
    generation: number;
    conflictId: string;
    outcome: "resolved" | "verification_blocked";
    resolutionReportId: string;
    rationale: string;
  },
  clock: StoreClock,
  now: string,
): VerificationConflict {
  requireCurrentSupervisorAuthorityInTx(tx, {
    executionRunId: input.executionRunId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    generation: input.generation,
  });
  if (input.outcome !== "resolved" && input.outcome !== "verification_blocked") {
    throw conflictServiceError("VERIFICATION_CONFLICT_RESOLUTION_INVALID", "outcome must be 'resolved' or 'verification_blocked' (E8 §35)", {
      outcome: input.outcome,
    });
  }
  if (typeof input.rationale !== "string" || input.rationale.trim() === "") {
    throw conflictServiceError("VERIFICATION_CONFLICT_RESOLUTION_INVALID", "a resolution requires a non-empty rationale (E8 §35/§36)", {});
  }
  const { conflict } = requireCurrentConflictInTx(tx, input.conflictId);
  if (conflict.status !== "resolving") {
    throw conflictServiceError(
      "VERIFICATION_CONFLICT_RESOLUTION_INVALID",
      `conflict '${input.conflictId}' is ${conflict.status}; only a resolving conflict can settle (E8 §35)`,
      { conflictId: input.conflictId, status: conflict.status },
    );
  }
  // The exact resolution Report: the ONE resolver Directive's attempt report,
  // completed, non-mutating, at the conflict's exact candidate, through a real
  // finished E5 invocation (E8 §35).
  const resolverDirectiveId = conflict.resolutionDirectiveId as string;
  const resolverRevision = conflict.resolutionDirectiveRevision as number;
  const attempt = getAttemptForDirectiveInTx(tx, resolverDirectiveId, resolverRevision);
  if (attempt === null) {
    throw conflictServiceError(
      "VERIFICATION_CONFLICT_RESOLUTION_INVALID",
      `the resolution directive '${resolverDirectiveId}@${resolverRevision}' has no attempt yet; the dedicated resolver must run first (E8 §35)`,
      { conflictId: input.conflictId },
    );
  }
  const report = getReportForAttemptInTx(tx, attempt.attemptId);
  if (report === null || report.reportId !== input.resolutionReportId) {
    throw conflictServiceError(
      "VERIFICATION_CONFLICT_RESOLUTION_INVALID",
      `resolution report '${input.resolutionReportId}' is not the resolver attempt's exact report (E8 §36)`,
      { conflictId: input.conflictId, expectedReportId: report?.reportId ?? null },
    );
  }
  const invocation = getWorkerInvocationInTx(tx, attempt.attemptId);
  if (
    report.result !== "completed"
    || report.candidateMutated
    || attempt.state !== "reported"
    || invocation === null
    || invocation.state !== "finished"
  ) {
    throw conflictServiceError(
      "VERIFICATION_CONFLICT_RESOLUTION_INVALID",
      `the resolver report must be completed, non-mutating, and produced by a finished fresh resolver invocation (E8 §33/§35)`,
      { conflictId: input.conflictId, reportId: report.reportId },
    );
  }
  return settleConflictInTx(
    tx,
    {
      conflictId: input.conflictId,
      outcome: input.outcome,
      resolutionReportId: report.reportId,
      rationale: input.rationale.trim(),
    },
    now,
  );
}

/**
 * E8 §40 — enumerate the conflicts that BLOCK acceptance of the CURRENT
 * candidate: bound to the run's open Window at the exact current revision with
 * status open | resolving | verification_blocked. Only `resolved` is
 * non-blocking, and only at the CURRENT candidate (older conflicts are
 * historical by revision, E8 §39).
 */
export function listBlockingConflictsInTx(tx: StoreTx, executionRunId: string): VerificationConflict[] {
  const window = getOpenWindowInTx(tx, executionRunId);
  if (window === null) {
    return [];
  }
  return listWindowConflictsInTx(tx, window.id).filter(
    (conflict) => conflict.candidateRevision === window.candidateRevision && conflict.status !== "resolved",
  );
}

export function createVerificationConflictService(store: import("../store/sqlite-store.js").PlanStore, clock: StoreClock) {
  return {
    /** E8 §30 — declare a durable factual conflict (Supervisor-only). */
    declareVerificationConflict(input: {
      executionRunId: string;
      sessionId: string;
      workspaceId: string;
      generation: number;
      fact: string;
      claims: unknown[];
      rationale?: string;
    }): VerificationConflict {
      return store.withWrite((tx) =>
        declareVerificationConflictInTx(tx, input, clock, clock.nowIso()),
      );
    },

    /** E8 §35 — settle a resolving conflict on its exact resolver report. */
    resolveVerificationConflict(input: {
      executionRunId: string;
      sessionId: string;
      workspaceId: string;
      generation: number;
      conflictId: string;
      outcome: "resolved" | "verification_blocked";
      resolutionReportId: string;
      rationale: string;
    }): VerificationConflict {
      return store.withWrite((tx) =>
        resolveVerificationConflictInTx(tx, input, clock, clock.nowIso()),
      );
    },

    /** E8 §27 — the conflict itself (read-only). */
    getVerificationConflict(input: { conflictId: string }): VerificationConflict | null {
      return store.withRead((tx) => getVerificationConflictInTx(tx, input.conflictId));
    },
  };
}
