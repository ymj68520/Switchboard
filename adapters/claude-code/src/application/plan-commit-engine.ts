/**
 * PlanCommit Transaction Engine (frozen plan Phase 6 §30–§65/§76–§79).
 *
 * The FIRST authorized committed-memory writer: after a human authorization
 * has happened OUTSIDE this runtime (Claude Code's approval UI — future
 * phases bridge it via requiresUserInteraction; today there is NO production
 * caller), commitAuthorizedProposal persists Approval + PlanCommit + the
 * exact frozen memory revisions + a new Snapshot + the moved HEAD pair in
 * ONE SQLite transaction. Any failure rolls the whole thing back — a failed
 * commit leaves no approval row, because the proposal must be re-authorized
 * against the new state (§34).
 *
 * Transaction order (§40) with frozen validation precedence (§41):
 *   [fence] → idempotency lookup → run exists → workspace exact →
 *   binding generation → lifecycle active → run revision vs base →
 *   proposal identity/state → proposal hash → HEAD/base (incl. legacy
 *   uncommitted HEAD) → dependencies → re-simulation → proposal-type gates →
 *   Section completion prerequisites (§32) → apply revisions → snapshot →
 *   approval → commit → HEAD → proposal state → Section workflow mutations
 *   (registration §28, reopen §39, dependency review §42, completion §33,
 *   active clear + Detail→Synthesis §34/§35) → state-machine side effect →
 *   audit.
 *
 * Two concurrency domains stay separate: design_checkpoint/amendment NEVER
 * touch PlanningRun.revision/stage (§50/§51/§77); architecture_completion
 * advances stage architecture→detail via ARCHITECTURE_APPROVED, and a Section
 * completion clears the active Section (and may advance detail→synthesis) —
 * each bumps the run revision exactly once, in the same transaction
 * (§54/§78/§34/§35).
 */

import { createHash } from "node:crypto";

import { canonicalJson as planCanonicalJson } from "../core/canonical-json.js";
import {
  nextStage,
  type PlanningRunEvent,
  type PlanningStage,
} from "../core/state-machine.js";
import type { MemoryArtifactKind, MemoryRef } from "../core/memory-refs.js";
import { simulateCandidateSnapshot, assertFrozenResultsMatchSimulation } from "../core/proposal-simulate.js";
import type { NormalizedProposalChange, ProposalType } from "../core/proposal.js";
import { changeTarget } from "../core/proposal.js";
import { parsePlanningRunRow } from "../core/planning-run.js";
import { RuntimeError } from "../runtime/errors.js";
import { evidenceNeedsValidationError, isEvidenceNeedsValidationError, runProposalEvidenceGateInTx } from "./evidence-gate.js";
import {
  insertArtifactIdentityInTx,
  insertMemoryRevisionInTx,
  insertSnapshotInTx,
  getSnapshotRefsInTx,
  type MemorySnapshot,
} from "../store/plan-memory.js";
import {
  appendAuditEventInTx,
  findApprovalByRequestInTx,
  getHeadPairInTx,
  getPlanCommitInTx,
  insertApprovalInTx,
  insertPlanCommitInTx,
  nextCommitSequenceInTx,
  setHeadPairInTx,
} from "../store/plan-commits.js";
import { runStateError } from "../store/planning-runs.js";
import { getActiveSectionInTx, getSectionWorkflowStateInTx } from "../store/section-workflow.js";
import {
  clearActiveSectionAfterCompletionInTx,
  propagateDependencyReviewInTx,
  registerSectionWorkflowInTx,
  sectionWorkflowError,
  transitionSectionWorkflowInTx,
  evaluateDetailCompletionInTx,
} from "./section-workflow-service.js";
import { createSynthesisInputAtDetailCompletionInTx } from "./synthesis-service.js";
import {
  finalPlanHash,
  type FinalPlanV1,
} from "../core/finalization.js";
import {
  runCommitTimeFinalizationInTx,
  createFinalizationService,
} from "./finalization-service.js";
import { getFinalPlanInTx, insertFinalPlanInTx } from "../store/finalization.js";
import {
  getProposalRevisionInTx,
  getProposalStateInTx,
  transitionProposalStateInTx,
} from "../store/proposals.js";
import { assertWritableBindingInTx } from "../store/session-bindings.js";
import type { PlanStore } from "../store/sqlite-store.js";
import type { StoreClock } from "../store/migration-runner.js";
import type { StoreTx } from "../store/transaction.js";

/**
 * The formal authorization seam (§32). Phase 6 defines the shape only: the
 * production bridge that PROVES Claude Code obtained real user authorization
 * arrives with the future requiresUserInteraction MCP handler. There is
 * deliberately no `approved: boolean` / `force` / `trusted` parameter
 * anywhere in this engine.
 */
export interface UserApprovalAuthorization {
  /** Caller operation identity — idempotent retry key (§60). */
  authorizationRequestId: string;
  proposalId: string;
  proposalRevision: number;
  proposalHash: string;
}

export interface CommitAuthorizedProposalInput {
  runId: string;
  workspaceId: string;
  sessionId: string;
  bindingGeneration: number;
  authorization: UserApprovalAuthorization;
}

export interface PlanCommitResult {
  idempotent: boolean;
  approvalId: string;
  commitId: string;
  sequence: number;
  snapshotId: string;
  parentCommitId: string | null;
  headSnapshotId: string;
  headCommitId: string;
  /**
   * Post-commit run revision/stage (bumped only by architecture completion).
   * Null on idempotent replay: the recorded commit, not live run state, is
   * the answer to a retry.
   */
  runRevision: number | null;
  stage: string | null;
}

export interface PlanCommitEngine {
  commitAuthorizedProposal(input: CommitAuthorizedProposalInput): PlanCommitResult;
}

const SELECT_RUN =
  "SELECT run_id AS runId, workspace_id AS workspaceId, lifecycle, stage, revision, goal, created_at AS createdAt, updated_at AS updatedAt FROM planning_runs";

/** Questions block architecture completion while open + blocking + arch-scoped (§57). */
function isArchitectureBlockingQuestion(content: { status: string; blocking: boolean; scope: string }): boolean {
  return content.status === "open" && content.blocking === true && content.scope === "architecture";
}

/** Conflicts block via severity hard ⟷ spec vocabulary "blocking" (§58). */
function isBlockingConflict(content: { status: string; severity: string }): boolean {
  return content.status === "open" && content.severity === "hard";
}

export function createPlanCommitEngine(store: PlanStore, clock: StoreClock): PlanCommitEngine {
  function requireMemoryRevisionContentInTx(
    tx: StoreTx,
    ref: MemoryRef,
  ): Record<string, unknown> {
    const row = tx
      .prepare(
        "SELECT content_json AS contentJson FROM memory_revisions WHERE run_id = ? AND kind = ? AND artifact_id = ? AND revision = ?",
      )
      .get(ref.runId, ref.kind, ref.id, ref.revision) as { contentJson: string } | undefined;
    if (row === undefined) {
      throw new RuntimeError("MEMORY_REVISION_NOT_FOUND", "candidate artifact revision is missing", {
        detail: { ref },
      });
    }
    return JSON.parse(row.contentJson) as Record<string, unknown>;
  }

  /**
   * The whole authorized commit inside ONE store transaction (§34). The
   * Phase 10 Evidence gate (step 12.5) throws EVIDENCE_NEEDS_VALIDATION from
   * inside this transaction when critical required Evidence is not fresh —
   * the caller persists the gate's discovered facts separately (§37).
   */
  function commitAuthorizedInTx(tx: StoreTx, input: CommitAuthorizedProposalInput): PlanCommitResult {
        // [fence] withWrite re-read PRAGMA user_version happened before this
        // operation — schema compatibility is already enforced in-tx.

        // 2. Idempotency lookup (§61/§62): the recorded outcome of this
        // authorization request IS the result, regardless of how much state
        // moved on since — a retry after response loss must never re-commit.
        const prior = findApprovalByRequestInTx(tx, input.authorization.authorizationRequestId);
        if (prior !== null) {
          const matches =
            prior.proposalId === input.authorization.proposalId &&
            prior.proposalRevision === input.authorization.proposalRevision &&
            prior.proposalHash === input.authorization.proposalHash;
          if (!matches) {
            throw new RuntimeError(
              "IDEMPOTENCY_CONFLICT",
              "authorization request id was already used for a different proposal/revision/hash",
              {
                detail: {
                  authorizationRequestId: input.authorization.authorizationRequestId,
                  recorded: {
                    proposalId: prior.proposalId,
                    proposalRevision: prior.proposalRevision,
                  },
                  requested: {
                    proposalId: input.authorization.proposalId,
                    proposalRevision: input.authorization.proposalRevision,
                  },
                },
              },
            );
          }
          const stored = tx
            .prepare("SELECT commit_id AS commitId FROM plan_commits WHERE approval_id = ?")
            .get(prior.approvalId) as { commitId: string } | undefined;
          if (stored === undefined) {
            throw new RuntimeError("STORE_SCHEMA_INVALID", "approval has no plan commit", {
              detail: { approvalId: prior.approvalId },
            });
          }
          const commitView = getPlanCommitInTx(tx, stored.commitId);
          if (commitView === null) {
            throw new RuntimeError("STORE_SCHEMA_INVALID", "approval's plan commit is missing", {
              detail: { commitId: stored.commitId },
            });
          }
          return {
            idempotent: true,
            approvalId: prior.approvalId,
            commitId: commitView.commitId,
            sequence: commitView.sequence,
            snapshotId: commitView.resultingSnapshotId,
            parentCommitId: commitView.parentCommitId,
            headSnapshotId: commitView.resultingSnapshotId,
            headCommitId: commitView.commitId,
            runRevision: null,
            stage: null,
          };
        }

        // 3. Run exists.
        const runRow = tx.prepare(`${SELECT_RUN} WHERE run_id = ?`).get(input.runId) as
          | Record<string, unknown>
          | undefined;
        if (runRow === undefined) {
          throw runStateError("RUN_NOT_FOUND", `no PlanningRun exists for '${input.runId}'`, { runId: input.runId });
        }
        const run = parsePlanningRunRow(runRow);

        // 4. Exact workspace.
        if (run.workspaceId !== input.workspaceId) {
          throw new RuntimeError("WORKSPACE_MISMATCH", `PlanningRun '${run.runId}' belongs to a different workspace`, {
            detail: { expected: run.workspaceId, detected: input.workspaceId },
          });
        }

        // 5. Exact writable SessionBinding generation (§44) — a fresh user
        // approval never bypasses ownership fencing.
        assertWritableBindingInTx(tx, {
          runId: input.runId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          generation: input.bindingGeneration,
        });

        // 6. Lifecycle active.
        if (run.lifecycle !== "active") {
          throw runStateError("RUN_TERMINAL", `PlanningRun '${run.runId}' is ${run.lifecycle} and can no longer commit`, {
            runId: run.runId,
            lifecycle: run.lifecycle,
          });
        }

        // 7/8. Proposal identity + revision; the run-revision check compares
        // against the frozen base (§43) BEFORE state/hash per §41.
        const proposal = getProposalRevisionInTx(tx, {
          runId: input.runId,
          proposalId: input.authorization.proposalId,
          revision: input.authorization.proposalRevision,
        });
        if (proposal !== null && run.revision !== proposal.baseRunRevision) {
          throw runStateError(
            "STALE_RUN_REVISION",
            `run revision moved from ${proposal.baseRunRevision} to ${run.revision} while the proposal awaited approval`,
            { runId: input.runId, expected: proposal.baseRunRevision, detected: run.revision },
          );
        }
        if (proposal === null) {
          throw new RuntimeError(
            "PROPOSAL_NOT_FOUND",
            `no proposal revision exists for '${input.authorization.proposalId}'@${input.authorization.proposalRevision}`,
            {
              detail: {
                proposalId: input.authorization.proposalId,
                revision: input.authorization.proposalRevision,
              },
            },
          );
        }

        // 9. State: awaiting_approval only. Superseded history answers
        // PROPOSAL_SUPERSEDED even when the old hash is perfectly correct (§27);
        // an approved proposal answers PROPOSAL_ALREADY_COMMITTED (§63).
        const status = getProposalStateInTx(tx, {
          runId: input.runId,
          proposalId: proposal.proposalId,
          revision: proposal.revision,
        });
        if (status !== "awaiting_approval") {
          if (status === "superseded") {
            throw new RuntimeError(
              "PROPOSAL_SUPERSEDED",
              `proposal '${proposal.proposalId}'@${proposal.revision} was superseded by a newer revision`,
              { detail: { proposalId: proposal.proposalId, revision: proposal.revision, status } },
            );
          }
          if (status === "approved") {
            throw new RuntimeError(
              "PROPOSAL_ALREADY_COMMITTED",
              `proposal '${proposal.proposalId}'@${proposal.revision} is already approved and committed`,
              { detail: { proposalId: proposal.proposalId, revision: proposal.revision, status } },
            );
          }
          throw new RuntimeError(
            "PROPOSAL_NOT_AWAITING_APPROVAL",
            `proposal '${proposal.proposalId}'@${proposal.revision} is ${status ?? "unknown"}, not awaiting_approval`,
            { detail: { proposalId: proposal.proposalId, revision: proposal.revision, status } },
          );
        }

        // 10. Hash: the caller's echoed hash must match the reloaded
        // authoritative proposal, and the stored canonical must re-derive the
        // stored hash (§23/§33) — nobody can present body+hash and be believed.
        if (input.authorization.proposalHash !== proposal.proposalHash) {
          throw new RuntimeError(
            "PROPOSAL_HASH_MISMATCH",
            "authorization hash does not match the frozen proposal revision",
            {
              detail: {
                proposalId: proposal.proposalId,
                revision: proposal.revision,
                expected: proposal.proposalHash,
              },
            },
          );
        }
        const recomputed = sha256OfCanonical(proposal.canonicalJson);
        if (recomputed !== proposal.proposalHash) {
          throw new RuntimeError("PROPOSAL_HASH_MISMATCH", "stored canonical proposal does not match its hash", {
            detail: { proposalId: proposal.proposalId, revision: proposal.revision },
          });
        }

        // 11. HEAD revalidation (§19/§42): a legacy snapshot-only HEAD fails
        // closed; otherwise the current pair must equal the frozen base.
        const head = getHeadPairInTx(tx, input.runId);
        const headSnapshotId = head?.headSnapshotId ?? null;
        const headCommitId = head?.headCommitId ?? null;
        if (headSnapshotId !== null && headCommitId === null) {
          throw new RuntimeError(
            "MEMORY_HEAD_UNCOMMITTED",
            "HEAD snapshot has no PlanCommit; it is not a legitimate commit base",
            { detail: { runId: input.runId, headSnapshotId } },
          );
        }
        if (headSnapshotId !== proposal.baseHeadSnapshotId || headCommitId !== proposal.baseHeadCommitId) {
          throw new RuntimeError(
            "STALE_MEMORY_HEAD",
            `committed HEAD moved while the proposal awaited approval (proposal base ${proposal.baseHeadSnapshotId ?? "null"}/${proposal.baseHeadCommitId ?? "null"}, current ${headSnapshotId ?? "null"}/${headCommitId ?? "null"})`,
            {
              detail: {
                runId: input.runId,
                baseHeadSnapshotId: proposal.baseHeadSnapshotId,
                baseHeadCommitId: proposal.baseHeadCommitId,
                detectedHeadSnapshotId: headSnapshotId,
                detectedHeadCommitId: headCommitId,
              },
            },
          );
        }

        // 12. Dependencies revalidated against the CURRENT head world (§20).
        const baseRefs: MemoryRef[] = headSnapshotId === null ? [] : (getSnapshotRefsInTx(tx, headSnapshotId) ?? []);
        const baseKeys = new Set(baseRefs.map((ref) => `${ref.kind}:${ref.id}:${ref.revision}`));
        for (const dependency of proposal.dependencies) {
          if (!baseKeys.has(`${dependency.kind}:${dependency.id}:${dependency.revision}`)) {
            throw new RuntimeError("PROPOSAL_INVALID", "proposal dependency is no longer present at the committed base", {
              detail: { dependency },
            });
          }
        }

        // 12.5 Phase 10 §36/§39 — post-authorization Evidence freshness gate:
        // freshness is checked AGAIN after user authorization and BEFORE
        // PlanCommit, with deterministic re-checks over each critical ref's
        // provenance closure (§40). Precedence is preserved: ownership/
        // hash/HEAD failures above already threw, so stale bindings still
        // answer STALE_SESSION_BINDING, never an Evidence error.
        // final_plan proposals skip this gate — their authorization runs the
        // FULL Phase 13 FinalizationGate rerun below (§47), which subsumes it.
        const isFinalPlanAuthorization = proposal.type === "final_plan";
        if (!isFinalPlanAuthorization) {
          const evidenceGate = runProposalEvidenceGateInTx(tx, {
            runId: input.runId,
            workspaceId: run.workspaceId,
            proposalId: proposal.proposalId,
            proposalRevision: proposal.revision,
            recheck: true,
            clock,
          });
          if (!evidenceGate.ok) {
            throw evidenceNeedsValidationError(evidenceGate.failures);
          }
        }

        // 13/14. Re-simulate + revalidate the candidate snapshot.
        const simulation = simulateCandidateSnapshot({
          runId: input.runId,
          baseRefs,
          changes: proposal.changes,
        });
        assertFrozenResultsMatchSimulation(proposal.changes, simulation.candidateRefs);

        // 15. Proposal-type gates.
        gateProposalType(input.runId, proposal.type, proposal.changes, simulation.candidateRefs, (ref) =>
          requireMemoryRevisionContentInTx(tx, ref),
        );

        // 15.F Phase 13 §47/§48 — the commit-time FinalizationGate rerun for a
        // final_plan authorization. Phase 6 ordering above already held
        // (idempotency → run → workspace → binding → lifecycle → run revision
        // → proposal identity/state/hash → HEAD/base); now the ENTIRE world is
        // reloaded and the gate re-evaluated — the second run never trusts the
        // first (§3). The commit-time EvidenceAuditSnapshot (§34) is frozen
        // here, BEFORE any Approval/PlanCommit/FinalPlan row is written; any
        // deny rolls the whole authorization back (§68/§100).
        const finalization =
          proposal.type === "final_plan"
            ? runCommitTimeFinalizationInTx(tx, {
                runId: input.runId,
                workspaceId: input.workspaceId,
                proposalId: proposal.proposalId,
                proposalRevision: proposal.revision,
                clock,
              })
            : null;

        // 15.5 Phase 11 — collect the frozen Section workflow facts (§31).
        // The completion prerequisite gate itself runs after the candidate
        // revisions are applied (single transaction — order only affects
        // where the content reads come from, never atomicity).
        const reopenOps = proposal.changes.filter(
          (change): change is Extract<NormalizedProposalChange, { op: "REOPEN_SECTION" }> => change.op === "REOPEN_SECTION",
        );
        const completeOps = proposal.changes.filter(
          (change): change is Extract<NormalizedProposalChange, { op: "COMPLETE_SECTION" }> => change.op === "COMPLETE_SECTION",
        );

        // 16. Apply the exact frozen changes through the Phase 5 internal
        // writer (§45) — the engine is its only production caller (§75).
        // Workflow facts (§31) write no memory revision; brand-new Section
        // identities are registered into the workflow layer in this same
        // transaction after the commit lands (§28).
        const createdRefs: MemoryRef[] = [];
        const createdSectionIds: string[] = [];
        for (const change of proposal.changes) {
          if (change.op === "COMPLETE_SECTION" || change.op === "REOPEN_SECTION") continue;
          const kind = change.result.kind as MemoryArtifactKind;
          if (changeTarget(change) === null) {
            insertArtifactIdentityInTx(tx, { runId: input.runId, kind, artifactId: change.artifactId }, clock.nowIso());
            if (kind === "section") createdSectionIds.push(change.artifactId);
          }
          const ref = insertMemoryRevisionInTx(tx, {
            runId: input.runId,
            kind,
            artifactId: change.artifactId,
            revision: change.result.revision,
            content: change.content,
            compactProjection: change.compactProjection,
            ...(change.fullProjection !== undefined ? { fullProjection: change.fullProjection } : {}),
          });
          createdRefs.push(ref);
        }

        // 17. The new immutable Snapshot (exactly one per commit, §48).
        const snapshot: MemorySnapshot = insertSnapshotInTx(tx, { runId: input.runId, refs: simulation.candidateRefs }, clock);

        // 17.5 Phase 11 §32 — Section completion prerequisites, evaluated
        // against the candidate snapshot now materialized in this transaction
        // (the whole commit still rolls back on any violation). Critical
        // required Evidence freshness was already gated at step 12.5.
        if (completeOps.length > 0) {
          gateSectionCompletionInTx(tx, {
            runId: input.runId,
            stage: run.stage,
            reopenIds: new Set(reopenOps.map((op) => op.artifactId)),
            completeOps: completeOps.map((op) => ({ artifactId: op.artifactId, revision: op.result.revision })),
            candidateRefs: simulation.candidateRefs,
            readContent: (ref) => requireMemoryRevisionContentInTx(tx, ref),
          });
        }

        // 18. Approval — same transaction as everything else (§34).
        const approvalId = `APPR-${clock.newId()}`;
        insertApprovalInTx(
          tx,
          {
            approvalId,
            runId: input.runId,
            proposalId: proposal.proposalId,
            proposalRevision: proposal.revision,
            proposalHash: proposal.proposalHash,
            authorizationRequestId: input.authorization.authorizationRequestId,
          },
          clock.nowIso(),
        );

        // 19. PlanCommit: linear chain anchored at the current HEAD.
        const commitId = `CMT-${clock.newId()}`;
        const sequence = nextCommitSequenceInTx(tx, headCommitId);
        const commit = insertPlanCommitInTx(
          tx,
          {
            commitId,
            runId: input.runId,
            sequence,
            proposalId: proposal.proposalId,
            proposalRevision: proposal.revision,
            approvalId,
            parentCommitId: headCommitId,
            baseSnapshotId: headSnapshotId,
            resultingSnapshotId: snapshot.snapshotId,
          },
          clock.nowIso(),
        );

        // 20. HEAD moves atomically to the new pair (pair triggers enforce
        // resulting-snapshot consistency).
        setHeadPairInTx(tx, { runId: input.runId, headSnapshotId: snapshot.snapshotId, headCommitId: commitId }, clock);

        // 21. Proposal state → approved.
        const approved = transitionProposalStateInTx(
          tx,
          { runId: input.runId, proposalId: proposal.proposalId, revision: proposal.revision, to: "approved" },
          clock.nowIso(),
        );
        if (!approved) {
          throw new RuntimeError("STORE_SCHEMA_INVALID", "awaiting proposal vanished before approval", {
            detail: { proposalId: proposal.proposalId, revision: proposal.revision },
          });
        }

        // 21.F Phase 13 §50–§56 — the immutable FinalPlan, created in the SAME
        // authorization transaction as the Approval/PlanCommit (§81/§82: there
        // is never a FinalPlan without its commit, nor a Final PlanCommit
        // without its FinalPlan). The FinalPlan references the COMMIT-TIME
        // EvidenceAuditSnapshot (§34), not the pre-approval one, and carries
        // the full Candidate→Proposal→Approval→Commit→Snapshot provenance
        // (§56). One approved FinalPlan per run in v0.1 (§52).
        let finalPlan: { finalPlanId: string; finalPlanHash: string; candidateId: string } | null = null;
        if (finalization !== null) {
          if (getFinalPlanInTx(tx, input.runId) !== null) {
            throw new RuntimeError("FINAL_PLAN_ALREADY_APPROVED", "this run already has an approved FinalPlan", {
              detail: { runId: input.runId },
            });
          }
          if (headSnapshotId !== finalization.candidate.baseHeadSnapshot || headCommitId !== finalization.candidate.baseHeadCommit) {
            throw new RuntimeError("FINAL_PLAN_CANDIDATE_STALE", "the candidate base no longer matches the committing HEAD", {
              detail: { runId: input.runId },
            });
          }
          const plan: FinalPlanV1 = {
            version: 1,
            candidateHash: finalization.candidateHash,
            architecture: finalization.candidate.architecture,
            sections: finalization.candidate.sections,
            decisions: finalization.candidate.decisions,
            constraints: finalization.candidate.constraints,
            synthesisManifest: finalization.candidate.synthesisManifest,
            implementationOrder: finalization.candidate.implementationOrder,
            limitations: finalization.candidate.limitations,
            validation: {
              blockingQuestions: 0,
              blockingConflicts: 0,
              invalidSections: 0,
              semanticValidation: "clean",
            },
            evidenceAudit: { auditId: finalization.auditId, auditHash: finalization.auditHash },
          };
          const finalPlanId = `fplan_${clock.newId()}`;
          const planHash = finalPlanHash(plan);
          insertFinalPlanInTx(tx, {
            runId: input.runId,
            finalPlanId,
            revision: 1,
            candidateId: finalization.candidateId,
            candidateHash: finalization.candidateHash,
            proposalId: proposal.proposalId,
            proposalRevision: proposal.revision,
            proposalHash: proposal.proposalHash,
            approvalId,
            commitId,
            snapshotId: snapshot.snapshotId,
            auditId: finalization.auditId,
            auditHash: finalization.auditHash,
            canonicalJson: planCanonicalJson(plan),
            finalPlanHash: planHash,
            createdAt: clock.nowIso(),
          });
          finalPlan = { finalPlanId, finalPlanHash: planHash, candidateId: finalization.candidateId };
        }

        // 22. Workflow mutations — Phase 11, same transaction as everything
        // else. Order inside the block is the §40 canonical order: register →
        // reopen (§39) → downstream dependency review (§42) → complete
        // (§33) → active clear / Detail→Synthesis (§34/§35). Design
        // checkpoints and plain amendments leave the run revision untouched
        // (§29/§41); architecture completion keeps its Phase 6 semantics.
        // final_plan authorization (Phase 13) performs NO workflow mutation
        // and does NOT bump the run revision (§52/§84) — the stage already
        // moved to final at request_finalization and stays there (§58).
        let finalRun = run;
        if (proposal.type === "architecture_completion") {
          const event: PlanningRunEvent = "ARCHITECTURE_APPROVED";
          let targetStage: PlanningStage;
          try {
            targetStage = nextStage(run.stage, event);
          } catch (err) {
            throw runStateError(
              "INVALID_RUN_TRANSITION",
              err instanceof Error ? err.message.replace("INVALID_RUN_TRANSITION:", "") : "invalid run transition",
              { runId: input.runId, stage: run.stage, event },
            );
          }
          const now = clock.nowIso();
          const result = tx
            .prepare(
              "UPDATE planning_runs SET stage = ?, revision = revision + 1, updated_at = ? WHERE run_id = ? AND revision = ?",
            )
            .run(targetStage, now, input.runId, run.revision) as { changes?: number };
          if ((result.changes ?? 0) !== 1) {
            throw runStateError("STALE_RUN_REVISION", `run revision changed during the commit transaction`, {
              runId: input.runId,
              expected: run.revision,
            });
          }
          finalRun = { ...run, stage: targetStage, revision: run.revision + 1, updatedAt: now };
        }

        const workflowAudit: Record<string, unknown> = {};
        if (createdSectionIds.length > 0 || reopenOps.length > 0 || completeOps.length > 0) {
          const now = clock.nowIso();
          const requestRef = input.authorization.authorizationRequestId;
          // (a) §28 — first commit of a Section identity registers it open
          // atomically; Plan Memory and workflow state are never split.
          for (const sectionId of createdSectionIds) {
            registerSectionWorkflowInTx(
              tx,
              {
                runId: input.runId,
                sectionId,
                reasonCode: "section_created_by_commit",
                detail: { proposalId: proposal.proposalId, proposalRevision: proposal.revision, commitId },
                ...(requestRef !== undefined ? { requestId: requestRef } : {}),
              },
              clock,
            );
          }
          workflowAudit.registered = [...createdSectionIds].sort();
          // (b) §39/§41 — explicit reopens first; a completed or needs_review
          // Section goes open with its completion provenance cleared.
          const reopenedIds: string[] = [];
          for (const op of reopenOps) {
            transitionSectionWorkflowInTx(
              tx,
              {
                runId: input.runId,
                sectionId: op.artifactId,
                eventType: "REOPENED",
                reasonCode: "explicit_reopen_proposal",
                detail: { proposalId: proposal.proposalId, proposalRevision: proposal.revision, commitId },
                ...(requestRef !== undefined ? { requestId: requestRef } : {}),
              },
              clock,
            );
            reopenedIds.push(op.artifactId);
          }
          workflowAudit.reopened = [...reopenedIds].sort();
          // (c) §42 — completed downstream Sections become needs_review,
          // recursively over the NEW HEAD's Section DAG; their immutable
          // revisions are untouched. Sections this same commit completes are
          // excluded — their fate is decided after the reopens.
          if (reopenedIds.length > 0) {
            const reviewAffected = propagateDependencyReviewInTx(
              tx,
              {
                runId: input.runId,
                headSectionRefs: simulation.candidateRefs,
                reopenedIds,
                exclude: completeOps.map((op) => op.artifactId),
                ...(requestRef !== undefined ? { requestId: requestRef } : {}),
              },
              clock,
            );
            if (reviewAffected.length > 0) workflowAudit.reviewRequired = reviewAffected;
          }
          // (d) §30/§33 — completions bind the exact candidate revision and
          // this proposal/commit as provenance, in the same transaction.
          const completedIds: string[] = [];
          for (const op of completeOps) {
            transitionSectionWorkflowInTx(
              tx,
              {
                runId: input.runId,
                sectionId: op.artifactId,
                eventType: "COMPLETED",
                reasonCode: "section_completion_committed",
                detail: { proposalId: proposal.proposalId, proposalRevision: proposal.revision, commitId },
                completion: {
                  completedRevision: op.result.revision,
                  completedProposalId: proposal.proposalId,
                  completedProposalRevision: proposal.revision,
                  completionCommitId: commitId,
                },
                ...(requestRef !== undefined ? { requestId: requestRef } : {}),
              },
              clock,
            );
            completedIds.push(op.artifactId);
          }
          workflowAudit.completed = [...completedIds].sort();
          // (e) §34/§35 — completing the active Section clears the active
          // work and bumps the run revision exactly once; if this was the
          // last Section at its exact HEAD revision with nothing in
          // needs_review, the SAME bump advances Detail → Synthesis via
          // DETAIL_COMPLETE. An empty Section set never passes the gate (§36).
          if (completedIds.length > 0) {
            const evaluation = evaluateDetailCompletionInTx(tx, input.runId, simulation.candidateRefs);
            let next: PlanningStage | undefined;
            if (evaluation.ready) {
              const event: PlanningRunEvent = "DETAIL_COMPLETE";
              try {
                next = nextStage(run.stage, event);
              } catch (err) {
                throw runStateError(
                  "INVALID_RUN_TRANSITION",
                  err instanceof Error ? err.message.replace("INVALID_RUN_TRANSITION:", "") : "invalid run transition",
                  { runId: input.runId, stage: run.stage, event },
                );
              }
            }
            const bumped = clearActiveSectionAfterCompletionInTx(
              tx,
              { runId: input.runId, expectedRevision: run.revision, ...(next !== undefined ? { nextStage: next } : {}) },
              clock,
            );
            finalRun = { ...finalRun, revision: bumped.revision, stage: bumped.stage, updatedAt: now };
            workflowAudit.activeCleared = true;
            if (next !== undefined) {
              workflowAudit.detailComplete = true;
              // Phase 12 §18 — the LAST legal Section completion that reaches
              // DETAIL_COMPLETE freezes the SynthesisInput in the SAME
              // transaction, anchored to the resulting HEAD. Any construction
              // failure (including the §24 critical-Evidence gate) rolls the
              // entire completion back: stage synthesis never lacks an input.
              const synthesis = createSynthesisInputAtDetailCompletionInTx(
                tx,
                {
                  runId: input.runId,
                  workspaceId: input.workspaceId,
                  snapshotId: snapshot.snapshotId,
                  commitId,
                  baseRunRevision: bumped.revision,
                },
                clock,
              );
              workflowAudit.synthesisInput = {
                inputId: synthesis.inputId,
                inputHash: synthesis.inputHash,
                relevantEvidence: synthesis.relevantEvidence,
              };
            }
          }
        }

        // 23. Audit — provenance, never authority (§70).
        appendAuditEventInTx(
          tx,
          {
            eventId: `EVT-${clock.newId()}`,
            runId: input.runId,
            eventType: "PLAN_COMMITTED",
            subject: {
              runId: input.runId,
              proposalId: proposal.proposalId,
              proposalRevision: proposal.revision,
              proposalHash: proposal.proposalHash,
            },
            payload: {
              approvalId,
              commitId,
              sequence,
              snapshotId: snapshot.snapshotId,
              committedRefs: createdRefs.map((ref) => ({ kind: ref.kind, id: ref.id, revision: ref.revision })),
              resultingSnapshotId: snapshot.snapshotId,
              runRevisionAfter: finalRun.revision,
              stageAfter: finalRun.stage,
              // §79 — the Final PlanCommit audit extends the existing
              // PLAN_COMMITTED payload; no second commit-event authority.
              ...(finalPlan !== null
                ? {
                    finalPlanId: finalPlan.finalPlanId,
                    finalPlanHash: finalPlan.finalPlanHash,
                    candidateId: finalPlan.candidateId,
                  }
                : {}),
              ...(Object.keys(workflowAudit).length > 0 ? { sectionWorkflow: workflowAudit } : {}),
            },
          },
          clock.nowIso(),
        );

        return {
          idempotent: false,
          approvalId,
          commitId,
          sequence,
          snapshotId: snapshot.snapshotId,
          parentCommitId: commit.parentCommitId,
          headSnapshotId: snapshot.snapshotId,
          headCommitId: commitId,
          runRevision: finalRun.revision,
          stage: finalRun.stage,
        };
  }

  return {
    commitAuthorizedProposal(input: CommitAuthorizedProposalInput): PlanCommitResult {
      try {
        return store.withWrite((tx) => commitAuthorizedInTx(tx, input));
      } catch (err) {
        if (isEvidenceNeedsValidationError(err)) {
          // §37: Evidence system facts discovered at commit time are an
          // independent, durable record — they persist even though this
          // commit is blocked. The blocked attempt itself leaves NO Approval,
          // NO PlanCommit, and an unchanged HEAD (the failed transaction
          // rolled everything back); only the Evidence state events are
          // re-discovered and appended here.
          try {
            store.withWrite((tx) => {
              runProposalEvidenceGateInTx(tx, {
                runId: input.runId,
                workspaceId: input.workspaceId,
                proposalId: input.authorization.proposalId,
                proposalRevision: input.authorization.proposalRevision,
                recheck: true,
                clock,
              });
              return null;
            });
          } catch {
            // Concurrent drift re-failing the re-check is acceptable — the
            // blocking error below is the authoritative answer either way.
          }
        }
        if (err instanceof RuntimeError && err.code === "FINALIZATION_DENIED") {
          // Phase 13 §49 — a denied commit-time gate may have discovered real
          // source changes before the rollback; re-run ONLY the Evidence audit
          // in a fresh transaction so those system facts persist. No approval/
          // commit/FinalPlan row is ever written on this path.
          try {
            createFinalizationService(store, clock).persistDiscoveredEvidenceFacts({
              runId: input.runId,
              workspaceId: input.workspaceId,
            });
          } catch {
            // The denied authorization below stays authoritative either way.
          }
        }
        throw err;
      }
    },
  };
}

function gateProposalType(
  runId: string,
  type: ProposalType,
  changes: NormalizedProposalChange[],
  candidateRefs: MemoryRef[],
  readContent: (ref: MemoryRef) => Record<string, unknown>,
): void {
  if (type === "design_checkpoint" || type === "amendment") {
    if (changes.length === 0) {
      throw new RuntimeError("PROPOSAL_INVALID", `${type} proposals require at least one change`, {
        detail: { runId, type },
      });
    }
    return;
  }
  if (type === "architecture_completion") {
    const architectureRefs = candidateRefs.filter((ref) => ref.kind === "architecture");
    if (architectureRefs.length !== 1) {
      throw new RuntimeError("PROPOSAL_INVALID", "architecture completion requires exactly one committed architecture", {
        detail: { runId, architectureCount: architectureRefs.length },
      });
    }
    for (const ref of candidateRefs) {
      if (ref.kind === "open_question") {
        const content = readContent(ref) as unknown as { status: string; blocking: boolean; scope: string };
        if (isArchitectureBlockingQuestion(content)) {
          throw new RuntimeError(
            "BLOCKING_QUESTION",
            `open blocking architecture question '${ref.id}@${ref.revision}' prevents architecture completion`,
            { detail: { runId, questionRef: { id: ref.id, revision: ref.revision } } },
          );
        }
      }
      if (ref.kind === "conflict") {
        const content = readContent(ref) as unknown as { status: string; severity: string };
        if (isBlockingConflict(content)) {
          throw new RuntimeError(
            "BLOCKING_CONFLICT",
            `open blocking conflict '${ref.id}@${ref.revision}' prevents architecture completion`,
            { detail: { runId, conflictRef: { id: ref.id, revision: ref.revision } } },
          );
        }
      }
    }
    return;
  }
  if (type === "section_completion") {
    // §30/§44 — a section_completion asserts completion; the design changes
    // themselves are optional (a needs_review re-completion may carry only
    // COMPLETE_SECTION at the unchanged exact revision).
    if (!changes.some((change) => change.op === "COMPLETE_SECTION")) {
      throw new RuntimeError("PROPOSAL_INVALID", "section_completion proposals require at least one COMPLETE_SECTION change", {
        detail: { runId, type },
      });
    }
    return;
  }
  if (type === "final_plan") {
    // Phase 13 §40 — FinalPlan approval is NOT a design mutation; the only
    // legal final_plan Proposal is the server-frozen one with zero changes.
    if (changes.length !== 0) {
      throw new RuntimeError("FINAL_PLAN_PROPOSAL_INVALID", "a final_plan proposal carries no design changes", {
        detail: { runId, type, changeCount: changes.length },
      });
    }
    return;
  }
  // Unknown proposal types are refused outright rather than approximated.
  throw new RuntimeError("PROPOSAL_TYPE_UNAVAILABLE", `proposal type '${type}' is not available in this phase`, {
    detail: { runId, type },
  });
}

/**
 * Phase 11 §32 — Section completion prerequisites, all evaluated inside the
 * commit transaction against the CANDIDATE snapshot:
 * run at detail → target is the ACTIVE section → candidate contains the
 * target at the bound exact revision → frozen SectionContract present → all
 * direct dependencies exist AND are completed at exactly their candidate
 * revisions → no target-scoped blocking Question / target-relevant blocking
 * Conflict (typed scope fields, never substring heuristics). DAG validity and
 * critical required Evidence freshness are enforced by the re-simulation and
 * the step-12.5 gate respectively. Re-completion of a needs_review Section is
 * legal (§44); completing an already-completed exact revision is not — unless
 * the same proposal explicitly reopens it first (§40).
 */
function gateSectionCompletionInTx(
  tx: StoreTx,
  input: {
    runId: string;
    stage: PlanningStage;
    reopenIds: Set<string>;
    completeOps: Array<{ artifactId: string; revision: number }>;
    candidateRefs: MemoryRef[];
    readContent: (ref: MemoryRef) => Record<string, unknown>;
  },
): void {
  if (input.stage !== "detail") {
    throw sectionWorkflowError("SECTION_WORKFLOW_INVALID", "section completion requires the detail stage", {
      runId: input.runId,
      stage: input.stage,
    });
  }
  const candidateSections = new Map<string, number>();
  for (const ref of input.candidateRefs) {
    if (ref.kind === "section") candidateSections.set(ref.id, ref.revision);
  }
  for (const op of input.completeOps) {
    const candidateRevision = candidateSections.get(op.artifactId);
    if (candidateRevision !== op.revision) {
      throw sectionWorkflowError(
        "SECTION_WORKFLOW_INVALID",
        `COMPLETE_SECTION binds section '${op.artifactId}'@${op.revision} but the candidate snapshot contains @${String(candidateRevision)}`,
        { runId: input.runId, sectionId: op.artifactId },
      );
    }
    // target == active Section (§32).
    const active = getActiveSectionInTx(tx, input.runId);
    if (active !== op.artifactId) {
      throw sectionWorkflowError(
        "SECTION_NOT_ACTIVE",
        `section '${op.artifactId}' is not the active section${active === null ? " (no active section)" : ` ('${active}' is)`}; select it before completion`,
        { runId: input.runId, sectionId: op.artifactId, active },
      );
    }
    const state = getSectionWorkflowStateInTx(tx, input.runId, op.artifactId);
    if (state === null) {
      throw sectionWorkflowError("SECTION_NOT_FOUND", `section '${op.artifactId}' has no workflow state`, {
        runId: input.runId,
        sectionId: op.artifactId,
      });
    }
    if (state.status === "completed" && !input.reopenIds.has(op.artifactId)) {
      throw sectionWorkflowError(
        "SECTION_ALREADY_COMPLETED",
        `section '${op.artifactId}' is already completed at revision ${String(state.completedRevision)}`,
        { runId: input.runId, sectionId: op.artifactId, completedRevision: state.completedRevision },
      );
    }
    // Frozen SectionContract present for the candidate revision (§32).
    const candidateRef: MemoryRef = { runId: input.runId, kind: "section", id: op.artifactId, revision: op.revision };
    const content = input.readContent(candidateRef) as unknown as {
      contract?: unknown;
      dependencies?: unknown;
    };
    if (content.contract === undefined || content.contract === null || typeof content.contract !== "object") {
      throw sectionWorkflowError(
        "SECTION_WORKFLOW_INVALID",
        `section '${op.artifactId}'@${op.revision} has no frozen SectionContract`,
        { runId: input.runId, sectionId: op.artifactId, revision: op.revision },
      );
    }
    // Direct dependencies: exist and completed at exactly their candidate
    // revisions (§32 — DAG legality itself was re-validated by simulation).
    const dependencies = Array.isArray(content.dependencies) ? (content.dependencies as string[]) : [];
    for (const dependencyId of dependencies) {
      const dependencyRevision = candidateSections.get(dependencyId);
      if (dependencyRevision === undefined) {
        throw sectionWorkflowError(
          "SECTION_DEPENDENCY_INCOMPLETE",
          `dependency '${dependencyId}' of section '${op.artifactId}' does not exist in the candidate snapshot`,
          { runId: input.runId, sectionId: op.artifactId, dependencyId },
        );
      }
      const dependencyState = getSectionWorkflowStateInTx(tx, input.runId, dependencyId);
      if (
        dependencyState === null ||
        dependencyState.status !== "completed" ||
        dependencyState.completedRevision !== dependencyRevision
      ) {
        throw sectionWorkflowError(
          "SECTION_DEPENDENCY_INCOMPLETE",
          `dependency '${dependencyId}' of section '${op.artifactId}' is ${dependencyState?.status ?? "unregistered"} at ${String(dependencyState?.completedRevision)}, but the candidate snapshot contains @${dependencyRevision}`,
          {
            runId: input.runId,
            sectionId: op.artifactId,
            dependencyId,
            dependencyRevision,
            dependencyStatus: dependencyState?.status ?? null,
          },
        );
      }
    }
    // Target-scoped blocking conditions (§32) — typed scope fields only.
    for (const ref of input.candidateRefs) {
      if (ref.kind === "open_question") {
        const question = input.readContent(ref) as unknown as { status: string; blocking: boolean; scope: string };
        if (question.status === "open" && question.blocking === true && question.scope === op.artifactId) {
          throw new RuntimeError(
            "BLOCKING_QUESTION",
            `open blocking question '${ref.id}@${ref.revision}' scoped to section '${op.artifactId}' prevents completion`,
            { detail: { runId: input.runId, sectionId: op.artifactId, questionRef: { id: ref.id, revision: ref.revision } } },
          );
        }
      }
      if (ref.kind === "conflict") {
        const conflict = input.readContent(ref) as unknown as { status: string; severity: string; refs?: unknown };
        const refsSection =
          Array.isArray(conflict.refs) &&
          (conflict.refs as Array<{ kind?: string; id?: string }>).some((entry) => entry.kind === "section" && entry.id === op.artifactId);
        if (conflict.status === "open" && conflict.severity === "hard" && refsSection) {
          throw new RuntimeError(
            "BLOCKING_CONFLICT",
            `open hard conflict '${ref.id}@${ref.revision}' referencing section '${op.artifactId}' prevents completion`,
            { detail: { runId: input.runId, sectionId: op.artifactId, conflictRef: { id: ref.id, revision: ref.revision } } },
          );
        }
      }
    }
  }
}

/** Re-derive the sha256 hash over stored canonical text (§23). */
function sha256OfCanonical(canonicalJsonText: string): string {
  return `sha256:${createHash("sha256").update(canonicalJsonText, "utf8").digest("hex")}`;
}
