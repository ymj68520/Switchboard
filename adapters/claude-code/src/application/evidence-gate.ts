/**
 * Proposal Evidence gate (Phase 10 §30/§35/§36/§39–§42).
 *
 * Frozen architecture: a Proposal is blocked by the critical Evidence that is
 * REACHABLE FROM IT — never by "all critical Evidence in the run" (§30). The
 * reachable set is the proposal's exact `requiredEvidence` refs
 * (ProposalCanonicalV2), indexed immutably in proposal_evidence_refs.
 *
 * Two instants share one evaluator:
 *  - prepare-time (§35, recheck=false): a proposal whose critical required
 *    Evidence is not fresh never freezes — the user is never shown a formal
 *    approval that already rests on stale critical evidence;
 *  - post-authorization (§36/§39, recheck=true): freshness is checked AGAIN
 *    after user authorization and before PlanCommit, walking each critical
 *    ref's full provenance closure (§40) with deterministic fingerprint
 *    re-hashing and the coarse repository-revision check. Discovered system
 *    facts are persisted in-transaction (§37) even when the commit aborts.
 *
 * Supporting/informational evidence never blocks here (§41/E34) — the
 * Finalization phase owns that audit. Gate failures always use
 * EVIDENCE_NEEDS_VALIDATION with machine-readable per-ref details (§53).
 */

import { RuntimeError } from "../runtime/errors.js";
import type { StoreClock } from "../store/migration-runner.js";
import type { StoreTx } from "../store/transaction.js";
import { listProposalEvidenceRefsInTx } from "../store/evidence-freshness.js";
import { evaluateCriticalEvidenceGateInTx, type EvidenceGateFailure } from "./evidence-freshness-service.js";

export interface ProposalEvidenceGateOutcome {
  ok: boolean;
  failures: EvidenceGateFailure[];
  /** Required refs bound to the proposal (empty for V1-era revisions). */
  requiredRefs: Array<{ evidenceId: string; revision: number }>;
}

/**
 * Evaluate one proposal revision's Evidence gate. `recheck` enables the
 * commit-time deterministic re-validation (fingerprint re-hash + git coarse
 * check + provenance closure); state changes it discovers are appended
 * in-transaction regardless of the verdict (§37).
 */
export function runProposalEvidenceGateInTx(
  tx: StoreTx,
  input: {
    runId: string;
    workspaceId: string;
    proposalId: string;
    proposalRevision: number;
    recheck: boolean;
    clock: StoreClock;
  },
): ProposalEvidenceGateOutcome {
  const requiredRefs = listProposalEvidenceRefsInTx(tx, input.runId, input.proposalId, input.proposalRevision);
  if (requiredRefs.length === 0) {
    return { ok: true, failures: [], requiredRefs };
  }
  const outcome = evaluateCriticalEvidenceGateInTx(tx, {
    runId: input.runId,
    workspaceId: input.workspaceId,
    requiredRefs,
    recheck: input.recheck,
    clock: input.clock,
  });
  return { ...outcome, requiredRefs };
}

/** The uniform gate error (§53): real per-ref states in the details. */
export function evidenceNeedsValidationError(failures: EvidenceGateFailure[]): RuntimeError {
  return new RuntimeError(
    "EVIDENCE_NEEDS_VALIDATION",
    `critical required Evidence is not fresh for ${failures.length} ref(s); revalidate and freeze a new Proposal revision`,
    { detail: { failures }, recoverable: false },
  );
}

export function isEvidenceNeedsValidationError(err: unknown): err is RuntimeError {
  return err instanceof RuntimeError && err.code === "EVIDENCE_NEEDS_VALIDATION";
}
