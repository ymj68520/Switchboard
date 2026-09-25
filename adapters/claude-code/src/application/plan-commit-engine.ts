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
 *   apply revisions → snapshot → approval → commit → HEAD → proposal state →
 *   state-machine side effect → audit.
 *
 * Two concurrency domains stay separate: design_checkpoint/amendment NEVER
 * touch PlanningRun.revision/stage (§50/§51/§77); architecture_completion
 * advances stage architecture→detail via ARCHITECTURE_APPROVED and bumps the
 * run revision exactly once, in the same transaction (§54/§78).
 */

import { createHash } from "node:crypto";

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

  return {
    commitAuthorizedProposal(input: CommitAuthorizedProposalInput): PlanCommitResult {
      return store.withWrite((tx) => {
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

        // 16. Apply the exact frozen changes through the Phase 5 internal
        // writer (§45) — the engine is its only production caller (§75).
        const createdRefs: MemoryRef[] = [];
        for (const change of proposal.changes) {
          const kind = change.result.kind as MemoryArtifactKind;
          if (changeTarget(change) === null) {
            insertArtifactIdentityInTx(tx, { runId: input.runId, kind, artifactId: change.artifactId }, clock.nowIso());
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

        // 22. Allowed State Machine side effect — architecture completion only.
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
      });
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
  // section_completion / final_plan never reach the engine through prepare,
  // and the engine refuses them outright rather than approximating (§56).
  throw new RuntimeError("PROPOSAL_TYPE_UNAVAILABLE", `proposal type '${type}' is not available in this phase`, {
    detail: { runId, type },
  });
}

/** Re-derive the sha256 hash over stored canonical text (§23). */
function sha256OfCanonical(canonicalJsonText: string): string {
  return `sha256:${createHash("sha256").update(canonicalJsonText, "utf8").digest("hex")}`;
}
