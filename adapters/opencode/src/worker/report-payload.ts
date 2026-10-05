/**
 * WorkerReportPayload — v0.2.0 Phase 4.
 *
 * What a Worker returns through the ExecutionWorker port: the UNIFIED report
 * content for both roles (executor and verifier), with NO store-stamped
 * identity — the control plane stamps attemptID, resultingCandidateRevision,
 * id, and createdAt inside the durable submission transaction. The payload
 * MUST bind the exact Directive revision/hash it answers, and
 * `candidateMutation` is an explicit factual declaration (§28), never
 * inferred from `filesChanged`.
 */
import type {
  CandidateMutation,
  ExecutionBlocker,
  ExecutionDeviation,
  ExecutionReportFinding,
  ExecutionReportResult,
} from "../core/execution-report.js";
import type { WorkerRole } from "../core/execution-attempt.js";
import type { ExecutionDirectiveID } from "../core/ids.js";

export interface WorkerReportPayload {
  /** The EXACT Directive revision this payload answers. */
  directive: { id: ExecutionDirectiveID; revision: number; hash: string };
  workerRole: WorkerRole;

  result: ExecutionReportResult;

  actionsPerformed: string[];
  filesExamined: string[];
  filesChanged: string[];
  commandsRun: string[];
  testsRun: string[];

  /** Non-blocking observations — Phase 5: findings MAY carry explicit acceptance classification. */
  findings: ExecutionReportFinding[];
  deviations: ExecutionDeviation[];
  blockers: ExecutionBlocker[];

  deliverables: string[];

  /** EXPLICIT factual declaration — orthogonal to result (§28/§29). */
  candidateMutation: CandidateMutation;
  /** The candidateRevision the Attempt executed against (= directive.baseCandidateRevision). */
  baseCandidateRevision: number;
  /** Phase 6A §32 — only legal on a conflict_resolution Directive (validated at submission). */
  conflictResolutionOutcome?: import("../core/verification-conflict.js").ConflictResolutionOutcome;
  /** Phase 6A §47 — only legal on a reconciliation inspection Directive (validated at submission). */
  reconciliationObservation?: import("../core/attempt-reconciliation.js").ReconciliationObservation;
}
