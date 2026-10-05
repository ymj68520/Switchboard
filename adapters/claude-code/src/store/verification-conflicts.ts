/**
 * VerificationConflict persistence (v0.2.0 E8 §27–§43).
 *
 * A conflict row is durable Execution Memory with a Core-owned BOUNDED
 * lifecycle (migration 021): the binding (run/window/revision/fact/claims/
 * fingerprint) is trigger-immutable, the fingerprint is UNIQUE (deterministic
 * duplicate fence, E8 §29), transitions are trigger-legal only
 * (open → resolving → resolved | verification_blocked), resolution provenance
 * is immutable once bound/settled, and delete is impossible.
 *
 * Staleness is NEVER written: a conflict stays bound to its exact candidate
 * revision and becomes historical by derivation when the Window moves on
 * (E8 §39).
 */

import { parseVerificationConflictRow, verificationConflictFingerprint, type ConflictClaim, type VerificationConflict, type VerificationConflictStatus } from "../core/verification-conflict.js";
import { RuntimeError } from "../runtime/errors.js";
import type { StoreTx } from "./transaction.js";

const CONFLICT_COLUMNS =
  "conflict_id AS conflictId, execution_run_id AS executionRunId, window_id AS windowId, "
  + "candidate_revision AS candidateRevision, fact, claims_json AS claimsJson, status, "
  + "resolution_directive_id AS resolutionDirectiveId, resolution_directive_revision AS resolutionDirectiveRevision, "
  + "resolution_report_id AS resolutionReportId, fingerprint, rationale, created_at AS createdAt, resolved_at AS resolvedAt";

function mapConflictRow(raw: Record<string, unknown>): VerificationConflict {
  const row: Record<string, unknown> = { ...raw };
  try {
    row.claims = JSON.parse(String(raw.claimsJson));
  } catch {
    throw new RuntimeError("STORE_SCHEMA_INVALID", "verification_conflicts row is corrupt", {
      detail: { fields: ["claims_json"] },
    });
  }
  return parseVerificationConflictRow(row);
}

function conflictError(
  code:
    | "VERIFICATION_CONFLICT_INVALID"
    | "VERIFICATION_CONFLICT_ALREADY_EXISTS"
    | "VERIFICATION_CONFLICT_STALE"
    | "VERIFICATION_CONFLICT_RESOLVER_EXISTS"
    | "VERIFICATION_CONFLICT_RESOLUTION_INVALID",
  message: string,
  detail?: Record<string, unknown>,
): RuntimeError {
  return new RuntimeError(code, message, { detail, recoverable: false });
}

export function getVerificationConflictInTx(tx: StoreTx, conflictId: string): VerificationConflict | null {
  const raw = tx
    .prepare(`SELECT ${CONFLICT_COLUMNS} FROM verification_conflicts WHERE conflict_id = ?`)
    .get(conflictId) as Record<string, unknown> | undefined;
  return raw === undefined ? null : mapConflictRow(raw);
}

/** Every conflict of one Window, oldest first (complete audit history). */
export function listWindowConflictsInTx(tx: StoreTx, windowId: string): VerificationConflict[] {
  return (tx
    .prepare(`SELECT ${CONFLICT_COLUMNS} FROM verification_conflicts WHERE window_id = ? ORDER BY created_at, conflict_id`)
    .all(windowId) as Record<string, unknown>[]).map(mapConflictRow);
}

export function listRunConflictsInTx(tx: StoreTx, executionRunId: string): VerificationConflict[] {
  return (tx
    .prepare(`SELECT ${CONFLICT_COLUMNS} FROM verification_conflicts WHERE execution_run_id = ? ORDER BY created_at, conflict_id`)
    .all(executionRunId) as Record<string, unknown>[]).map(mapConflictRow);
}

/**
 * E8 §29/§30 — persist a NEW open conflict; the UNIQUE fingerprint rejects an
 * identical declaration as VERIFICATION_CONFLICT_ALREADY_EXISTS.
 */
export function insertVerificationConflictInTx(
  tx: StoreTx,
  input: {
    conflictId: string;
    executionRunId: string;
    windowId: string;
    candidateRevision: number;
    fact: string;
    claims: ConflictClaim[];
    rationale: string | null;
  },
  now: string,
): VerificationConflict {
  const fingerprint = verificationConflictFingerprint({
    executionRunId: input.executionRunId,
    windowId: input.windowId,
    candidateRevision: input.candidateRevision,
    fact: input.fact,
    claims: input.claims,
  });
  try {
    tx.prepare(
      `INSERT INTO verification_conflicts (
         conflict_id, execution_run_id, window_id, candidate_revision, fact, claims_json, status,
         resolution_directive_id, resolution_directive_revision, resolution_report_id,
         fingerprint, rationale, created_at, resolved_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'open', NULL, NULL, NULL, ?, ?, ?, NULL)`,
    ).run(
      input.conflictId,
      input.executionRunId,
      input.windowId,
      input.candidateRevision,
      input.fact,
      JSON.stringify(input.claims),
      fingerprint,
      input.rationale,
      now,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("UNIQUE constraint failed: verification_conflicts.fingerprint")) {
      throw conflictError(
        "VERIFICATION_CONFLICT_ALREADY_EXISTS",
        "an identical verification conflict (same fact, claims, and source reports at this exact candidate) is already declared (E8 §29)",
        { fingerprint },
      );
    }
    throw err;
  }
  return getVerificationConflictInTx(tx, input.conflictId) as VerificationConflict;
}

/**
 * E8 §31/§38 — atomically bind THE one resolution Directive: the conditional
 * UPDATE admits only an OPEN conflict (changes=0 otherwise), stamps the exact
 * resolver, and moves open → resolving. A second resolver therefore can never
 * bind — no recursion, no majority vote.
 */
export function bindConflictResolverInTx(
  tx: StoreTx,
  input: { conflictId: string; directiveId: string; directiveRevision: number },
  now: string,
): VerificationConflict {
  const updated = tx
    .prepare(
      "UPDATE verification_conflicts SET status = 'resolving', resolution_directive_id = ?, "
      + "resolution_directive_revision = ? WHERE conflict_id = ? AND status = 'open' AND resolution_directive_id IS NULL",
    )
    .run(input.directiveId, input.directiveRevision, input.conflictId) as { changes?: number | bigint };
  if (Number(updated.changes ?? 0) !== 1) {
    const conflict = getVerificationConflictInTx(tx, input.conflictId);
    if (conflict === null) {
      throw conflictError("VERIFICATION_CONFLICT_INVALID", `no verification conflict exists for '${input.conflictId}'`, {
        conflictId: input.conflictId,
      });
    }
    throw conflictError(
      "VERIFICATION_CONFLICT_RESOLVER_EXISTS",
      `verification conflict '${input.conflictId}' is ${conflict.status} with resolver '${conflict.resolutionDirectiveId ?? "none"}'; exactly one resolution directive is permitted (E8 §31/§38)`,
      { conflictId: input.conflictId, status: conflict.status, resolver: conflict.resolutionDirectiveId },
    );
  }
  void now;
  return getVerificationConflictInTx(tx, input.conflictId) as VerificationConflict;
}

/**
 * E8 §35/§36/§37 — settle a RESOLVING conflict on its exact resolution Report:
 * resolved | verification_blocked, with non-empty rationale and timestamp.
 * The conditional UPDATE refuses anything but a resolving conflict.
 */
export function settleConflictInTx(
  tx: StoreTx,
  input: {
    conflictId: string;
    outcome: Exclude<VerificationConflictStatus, "open" | "resolving">;
    resolutionReportId: string;
    rationale: string;
  },
  now: string,
): VerificationConflict {
  const updated = tx
    .prepare(
      "UPDATE verification_conflicts SET status = ?, resolution_report_id = ?, rationale = ?, resolved_at = ? "
      + "WHERE conflict_id = ? AND status = 'resolving'",
    )
    .run(input.outcome, input.resolutionReportId, input.rationale, now, input.conflictId) as { changes?: number | bigint };
  if (Number(updated.changes ?? 0) !== 1) {
    const conflict = getVerificationConflictInTx(tx, input.conflictId);
    throw conflictError(
      "VERIFICATION_CONFLICT_RESOLUTION_INVALID",
      conflict === null
        ? `no verification conflict exists for '${input.conflictId}'`
        : `verification conflict '${input.conflictId}' is ${conflict.status}; only a resolving conflict can settle on its exact resolution report (E8 §35)`,
      { conflictId: input.conflictId, status: conflict?.status ?? null },
    );
  }
  return getVerificationConflictInTx(tx, input.conflictId) as VerificationConflict;
}
