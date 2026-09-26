/**
 * Proposal application service (frozen plan Phase 6 §8/§10/§12/§14/§16/
 * §26–§29/§72/§80–§83).
 *
 * prepareProposal freezes working design into an awaiting_approval Proposal:
 * a WORKING-STATE mutation that must never touch committed memory. It runs
 * the full normalization + candidate-snapshot validation pipeline so only a
 * proposal whose changes WOULD commit cleanly can freeze (§17), while the
 * proposed revisions themselves still do not exist (§15).
 *
 * Gate precedence (deterministic, mirroring the run-mutation order):
 *   run exists → workspace exact → writable binding generation →
 *   run active → expected run revision → proposal-type availability →
 *   stage/scope capability → legacy uncommitted HEAD → base world →
 *   normalization/simulation → one-awaiting-per-run → apply.
 *
 * The commit side (Approval + PlanCommit) lives in plan-commit-engine.ts;
 * this module never mutates committed memory.
 */

import { createHash } from "node:crypto";

import { canonicalJson } from "../core/canonical-json.js";
import type { MemoryRef } from "../core/memory-refs.js";
import { canonicalDependencies, canonicalImpact, normalizeProposalChanges } from "../core/proposal-normalize.js";
import {
  isProductionProposalType,
  proposalInvalid,
  type ArtifactIdentityRef,
  type ArtifactRef,
  type ProposalScope,
  type ProposalType,
  type RawProposalChange,
} from "../core/proposal.js";
import { buildProposalCanonical, canonicalProposalHash, requiredEvidenceOf, type ProposalEvidenceRef } from "../core/proposal-canonical.js";
import { parsePlanningRunRow, type PlanningRun } from "../core/planning-run.js";
import { RuntimeError } from "../runtime/errors.js";
import { evidenceNeedsValidationError } from "./evidence-gate.js";
import { evaluateCriticalEvidenceGateInTx } from "./evidence-freshness-service.js";
import { insertProposalEvidenceRefsInTx } from "../store/evidence-freshness.js";
import { getSnapshotRefsInTx } from "../store/plan-memory.js";
import { appendAuditEventInTx, getHeadPairInTx, type HeadPair } from "../store/plan-commits.js";
import { runStateError } from "../store/planning-runs.js";
import { assertWritableBindingInTx } from "../store/session-bindings.js";
import {
  findAwaitingProposalStateInTx,
  getAwaitingProposalRecord,
  getProposalRevisionInTx,
  getProposalRevisionRecord,
  getProposalStateInTx,
  insertProposalIdentityInTx,
  insertProposalRevisionInTx,
  insertProposalStateInTx,
  listProposalRevisionsRecord,
  proposalNotFoundError,
  transitionProposalStateInTx,
  type ProposalRevisionStatusView,
} from "../store/proposals.js";
import type { PlanStore } from "../store/sqlite-store.js";
import type { StoreClock } from "../store/migration-runner.js";
import type { StoreTx } from "../store/transaction.js";

export interface PrepareProposalInput {
  runId: string;
  workspaceId: string;
  sessionId: string;
  bindingGeneration: number;
  expectedRunRevision: number;
  type: ProposalType;
  scope: ProposalScope;
  title: string;
  summary: string;
  changes: RawProposalChange[];
  /** Exact base-snapshot refs this proposal depends on (§20). */
  dependencies?: ArtifactRef[];
  /**
   * Exact Evidence revisions this proposal depends on (Phase 10 §30/§31) —
   * bound into ProposalCanonicalV2 and hashed. Critical refs must be fresh
   * at prepare time (§35).
   */
  requiredEvidence?: ProposalEvidenceRef[];
  /** Planning metadata; carries no authority but joins the hash (§21). */
  impact?: { affected?: ArtifactIdentityRef[]; notes?: string[] };
  /** Caller operation identity for prepare retry idempotency (§83). */
  prepareRequestId?: string;
}

export interface ReviseProposalInput extends Omit<PrepareProposalInput, "prepareRequestId"> {
  proposalId: string;
}

export interface RejectProposalInput {
  runId: string;
  workspaceId: string;
  sessionId: string;
  bindingGeneration: number;
  proposalId: string;
  revision?: number;
}

export interface PreparedProposal {
  proposal: ProposalRevisionStatusView;
  /** What the candidate snapshot WOULD look like if approved (§17). */
  candidateRefs: MemoryRef[];
}

export interface ProposalService {
  prepareProposal(input: PrepareProposalInput): PreparedProposal;
  reviseProposal(input: ReviseProposalInput): PreparedProposal;
  /** Internal working-state rejection; no user-facing tool exists yet (§28). */
  rejectProposal(input: RejectProposalInput): ProposalRevisionStatusView;
  getProposal(proposalId: string, revision: number): ProposalRevisionStatusView | null;
  getAwaitingProposal(runId: string): ProposalRevisionStatusView | null;
  listProposalRevisions(proposalId: string): ProposalRevisionStatusView[];
}

const SELECT_RUN =
  "SELECT run_id AS runId, workspace_id AS workspaceId, lifecycle, stage, revision, goal, created_at AS createdAt, updated_at AS updatedAt FROM planning_runs";

export function createProposalService(store: PlanStore, clock: StoreClock): ProposalService {
  function loadRunInTx(tx: StoreTx, runId: string): PlanningRun {
    const row = tx.prepare(`${SELECT_RUN} WHERE run_id = ?`).get(runId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      throw runStateError("RUN_NOT_FOUND", `no PlanningRun exists for '${runId}'`, { runId });
    }
    return parsePlanningRunRow(row);
  }

  /**
   * Shared ownership/state gates (§81): stale owners can never create or
   * revise proposals. Returns the verified run.
   */
  function gateProposalMutationInTx(
    tx: StoreTx,
    input: {
      runId: string;
      workspaceId: string;
      sessionId: string;
      bindingGeneration: number;
      expectedRunRevision: number;
    },
  ): PlanningRun {
    const run = loadRunInTx(tx, input.runId);
    if (run.workspaceId !== input.workspaceId) {
      throw new RuntimeError("WORKSPACE_MISMATCH", `PlanningRun '${run.runId}' belongs to a different workspace`, {
        detail: { expected: run.workspaceId, detected: input.workspaceId },
      });
    }
    assertWritableBindingInTx(tx, {
      runId: input.runId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      generation: input.bindingGeneration,
    });
    if (run.lifecycle !== "active") {
      throw runStateError("RUN_TERMINAL", `PlanningRun '${run.runId}' is ${run.lifecycle} and can no longer mutate`, {
        runId: run.runId,
        lifecycle: run.lifecycle,
      });
    }
    if (run.revision !== input.expectedRunRevision) {
      throw runStateError(
        "STALE_RUN_REVISION",
        `stale run revision ${input.expectedRunRevision} for '${run.runId}'; current is ${run.revision}`,
        { runId: run.runId, expected: input.expectedRunRevision, detected: run.revision },
      );
    }
    return run;
  }

  /**
   * Proposal-type availability (§11/§56) and stage/scope capability (§12/§80)
   * — server-side, never delegated to future MCP tool visibility.
   */
  function gateTypeAndStage(run: PlanningRun, type: ProposalType, scope: ProposalScope): void {
    if (!isProductionProposalType(type)) {
      throw new RuntimeError("PROPOSAL_TYPE_UNAVAILABLE", `proposal type '${type}' is not available in this phase`, {
        detail: { type },
      });
    }
    if (run.stage === "architecture") {
      if (scope.kind !== "architecture") {
        throw proposalInvalid("architecture-stage proposals require architecture scope", { stage: run.stage, scope });
      }
      return;
    }
    if (run.stage === "detail") {
      if (type === "architecture_completion") {
        throw new RuntimeError("CAPABILITY_NOT_AVAILABLE", "architecture completion requires the architecture stage", {
          detail: { stage: run.stage, type },
        });
      }
      if (scope.kind !== "section") {
        throw proposalInvalid("detail-stage proposals require section scope", { stage: run.stage, scope });
      }
      return;
    }
    throw new RuntimeError("CAPABILITY_NOT_AVAILABLE", `proposal preparation is not available at stage '${run.stage}'`, {
      detail: { stage: run.stage, type },
    });
  }

  /**
   * The base world for a new frozen revision: the current HEAD pair plus its
   * refs. A legacy snapshot-only HEAD (schema-4 internal shape) fails closed
   * — it is never a legitimate commit base (§19).
   */
  function baseWorldInTx(tx: StoreTx, runId: string): { head: HeadPair | null; baseRefs: MemoryRef[] } {
    const head = getHeadPairInTx(tx, runId);
    if (head !== null && head.headCommitId === null) {
      throw new RuntimeError(
        "MEMORY_HEAD_UNCOMMITTED",
        "HEAD snapshot has no PlanCommit; it is not a legitimate commit base — replan from a committed state",
        { detail: { runId, headSnapshotId: head.headSnapshotId } },
      );
    }
    const baseRefs = head === null ? [] : (getSnapshotRefsInTx(tx, head.headSnapshotId) ?? []);
    return { head, baseRefs };
  }

  function normalizeAndValidate(input: {
    runId: string;
    baseRefs: MemoryRef[];
    changes: RawProposalChange[];
    dependencies?: ArtifactRef[];
  }): ReturnType<typeof normalizeProposalChanges> {
    const normalized = normalizeProposalChanges({
      runId: input.runId,
      baseRefs: input.baseRefs,
      changes: input.changes,
    });
    // Dependencies must exist at the BASE snapshot's exact revisions (§20) —
    // never "latest", never something this proposal itself creates.
    const baseKeys = new Set(input.baseRefs.map((ref) => `${ref.kind}:${ref.id}:${ref.revision}`));
    for (const dependency of canonicalDependencies((input.dependencies ?? []).map((ref) => ({ runId: input.runId, ...ref })))) {
      if (!baseKeys.has(`${dependency.kind}:${dependency.id}:${dependency.revision}`)) {
        throw proposalInvalid("dependencies must be exact refs present at the base snapshot", { dependency });
      }
    }
    return normalized;
  }

  /** Canonical fingerprint of the RAW request for prepare-retry comparison. */
  function rawRequestFingerprint(input: PrepareProposalInput): string {
    return canonicalJson({
      runId: input.runId,
      type: input.type,
      scope: input.scope,
      title: input.title,
      summary: input.summary,
      changes: input.changes,
      dependencies: input.dependencies ?? [],
      requiredEvidence: input.requiredEvidence ?? [],
      impact: input.impact ?? { affected: [], notes: [] },
    });
  }

  /**
   * Phase 10 §35 prepare-time Evidence gate: refs must exist, be same-run,
   * and every CRITICAL ref must currently be fresh — a proposal whose
   * critical basis is already known-unresolved never reaches formal approval.
   * Deterministic re-checks happen at commit time (§36), not here.
   */
  function gateRequiredEvidenceInTx(
    tx: StoreTx,
    input: { runId: string; workspaceId: string; requiredEvidence: ProposalEvidenceRef[] },
  ): void {
    const missing = input.requiredEvidence.find(
      (ref) =>
        tx
          .prepare("SELECT 1 AS one FROM evidence_revisions WHERE run_id = ? AND evidence_id = ? AND revision = ?")
          .get(input.runId, ref.evidenceId, ref.revision) === undefined,
    );
    if (missing !== undefined) {
      throw new RuntimeError(
        "EVIDENCE_STATE_INVALID",
        `required Evidence ${missing.evidenceId}@${missing.revision} does not exist in this run`,
        { detail: { evidenceId: missing.evidenceId, revision: missing.revision } },
      );
    }
    if (input.requiredEvidence.length === 0) return;
    const gate = evaluateCriticalEvidenceGateInTx(tx, {
      runId: input.runId,
      workspaceId: input.workspaceId,
      requiredRefs: input.requiredEvidence,
      recheck: false,
      clock,
    });
    if (!gate.ok) {
      throw evidenceNeedsValidationError(gate.failures);
    }
  }

  function freezeRevisionInTx(
    tx: StoreTx,
    input: {
      runId: string;
      proposalId: string;
      revision: number;
      run: PlanningRun;
      head: HeadPair | null;
      type: ProposalType;
      scope: ProposalScope;
      title: string;
      summary: string;
      changes: ReturnType<typeof normalizeProposalChanges>["changes"];
      dependencies: ArtifactRef[];
      requiredEvidence: ProposalEvidenceRef[];
      impact: { affected: ArtifactIdentityRef[]; notes: string[] };
    },
  ): ProposalRevisionStatusView {
    const now = clock.nowIso();
    const baseHeadSnapshotId = input.head === null ? null : input.head.headSnapshotId;
    const baseHeadCommitId = input.head === null ? null : input.head.headCommitId;
    // §33: every proposal frozen after Phase 10 is canonical V2 — even with
    // an empty requiredEvidence set. Refs are deterministically sorted by the
    // builder and mirrored into proposal_evidence_refs (§34: the relational
    // index must equal the canonical content — one authority).
    const canonical = buildProposalCanonical({
      runId: input.runId,
      proposalId: input.proposalId,
      proposalRevision: input.revision,
      type: input.type,
      scope: input.scope,
      baseRunRevision: input.run.revision,
      baseHeadSnapshotId,
      baseHeadCommitId,
      title: input.title,
      summary: input.summary,
      changes: input.changes,
      dependencies: input.dependencies,
      impact: input.impact,
      requiredEvidence: input.requiredEvidence,
    });
    const canonicalJsonText = canonicalJson(canonical);
    const hash = canonicalProposalHash(canonical);

    insertProposalRevisionInTx(
      tx,
      {
        runId: input.runId,
        proposalId: input.proposalId,
        revision: input.revision,
        type: input.type,
        scope: input.scope,
        title: input.title,
        summary: input.summary,
        changes: input.changes,
        dependencies: input.dependencies.map((ref) => ({ runId: input.runId, ...ref })),
        impact: input.impact,
        baseRunRevision: input.run.revision,
        baseHeadSnapshotId,
        baseHeadCommitId,
        canonicalJson: canonicalJsonText,
        proposalHash: hash,
      },
      now,
    );
    insertProposalEvidenceRefsInTx(tx, {
      runId: input.runId,
      proposalId: input.proposalId,
      proposalRevision: input.revision,
      requiredEvidence: requiredEvidenceOf(canonical),
    });
    insertProposalStateInTx(tx, { runId: input.runId, proposalId: input.proposalId, revision: input.revision }, now);
    return {
      runId: input.runId,
      proposalId: input.proposalId,
      revision: input.revision,
      type: input.type,
      scope: input.scope,
      title: input.title,
      summary: input.summary,
      changes: input.changes,
      dependencies: input.dependencies.map((ref) => ({ runId: input.runId, ...ref })),
      impact: input.impact,
      baseRunRevision: input.run.revision,
      baseHeadSnapshotId,
      baseHeadCommitId,
      canonicalJson: canonicalJsonText,
      proposalHash: hash,
      createdAt: now,
      status: "awaiting_approval",
    };
  }

  return {
    prepareProposal(input: PrepareProposalInput): PreparedProposal {
      const fingerprint = rawRequestFingerprint(input);
      return store.withWrite((tx) => {
        // Prepare-request idempotency (§83): same id + same raw input returns
        // the SAME proposal; same id + different input is a conflict.
        if (input.prepareRequestId !== undefined) {
          const existing = tx
            .prepare(
              "SELECT proposal_id AS proposalId, prepare_request_input_json AS inputJson FROM proposals WHERE prepare_request_id = ?",
            )
            .get(input.prepareRequestId) as { proposalId: string; inputJson: string | null } | undefined;
          if (existing !== undefined) {
            if (existing.inputJson !== fingerprint) {
              throw new RuntimeError("IDEMPOTENCY_CONFLICT", "prepare request id was already used with different input", {
                detail: { prepareRequestId: input.prepareRequestId, proposalId: existing.proposalId },
              });
            }
            const runId = (
              tx.prepare("SELECT run_id AS runId FROM proposals WHERE proposal_id = ?").get(existing.proposalId) as {
                runId: string;
              }
            ).runId;
            const awaiting = findAwaitingProposalStateInTx(tx, runId);
            const targetRevision =
              awaiting !== null && awaiting.proposalId === existing.proposalId
                ? awaiting.revision
                : (
                    tx
                      .prepare(
                        "SELECT revision AS revision FROM proposal_revisions WHERE run_id = ? AND proposal_id = ? ORDER BY revision DESC LIMIT 1",
                      )
                      .get(runId, existing.proposalId) as { revision: number } | undefined
                  )?.revision;
            if (targetRevision === undefined) {
              throw new RuntimeError("STORE_SCHEMA_INVALID", "prepare request references a missing proposal revision", {
                detail: { proposalId: existing.proposalId },
              });
            }
            const view = getProposalRevisionInTx(tx, {
              runId,
              proposalId: existing.proposalId,
              revision: targetRevision,
            });
            const status = getProposalStateInTx(tx, { runId, proposalId: existing.proposalId, revision: targetRevision });
            if (view === null || status === null) {
              throw new RuntimeError("STORE_SCHEMA_INVALID", "prepare request references a missing proposal state", {
                detail: { proposalId: existing.proposalId },
              });
            }
            return {
              proposal: { ...view, status },
              candidateRefs: candidateRefsInTx(tx, { ...view, status }),
            };
          }
        }

        const run = gateProposalMutationInTx(tx, input);
        gateTypeAndStage(run, input.type, input.scope);
        const { head, baseRefs } = baseWorldInTx(tx, input.runId);
        const normalized = normalizeAndValidate({
          runId: input.runId,
          baseRefs,
          changes: input.changes,
          dependencies: input.dependencies,
        });
        // §35: critical required Evidence must be fresh before freezing.
        gateRequiredEvidenceInTx(tx, {
          runId: input.runId,
          workspaceId: input.workspaceId,
          requiredEvidence: input.requiredEvidence ?? [],
        });
        if (findAwaitingProposalStateInTx(tx, input.runId) !== null) {
          throw new RuntimeError("PROPOSAL_ALREADY_AWAITING", `run '${input.runId}' already has an awaiting proposal`, {
            detail: { runId: input.runId },
          });
        }

        // Identity first (FK parent), then the frozen revision + state.
        const proposalId = `PROP-${clock.newId()}`;
        insertProposalIdentityInTx(
          tx,
          {
            runId: input.runId,
            proposalId,
            ...(input.prepareRequestId !== undefined
              ? { prepareRequestId: input.prepareRequestId, prepareRequestInputJson: fingerprint }
              : {}),
          },
          clock.nowIso(),
        );
        const proposal = freezeRevisionInTx(tx, {
          runId: input.runId,
          proposalId,
          revision: 1,
          run,
          head,
          type: input.type,
          scope: input.scope,
          title: input.title,
          summary: input.summary,
          changes: normalized.changes,
          dependencies: canonicalDependencies((input.dependencies ?? []).map((ref) => ({ runId: input.runId, ...ref }))),
          requiredEvidence: [...(input.requiredEvidence ?? [])].sort(
            (a, b) => a.evidenceId.localeCompare(b.evidenceId) || a.revision - b.revision,
          ),
          impact: canonicalImpact(input.impact),
        });
        appendAuditEventInTx(
          tx,
          {
            eventId: `EVT-${clock.newId()}`,
            runId: input.runId,
            eventType: "PROPOSAL_PREPARED",
            subject: { runId: input.runId, proposalId, revision: 1, type: input.type },
            payload: {
              title: input.title,
              changeCount: normalized.changes.length,
              base: canonicalBaseOf(head, input.expectedRunRevision),
            },
          },
          clock.nowIso(),
        );
        return { proposal, candidateRefs: normalized.candidateRefs };
      });
    },

    reviseProposal(input: ReviseProposalInput): PreparedProposal {
      return store.withWrite((tx) => {
        const run = gateProposalMutationInTx(tx, input);
        gateTypeAndStage(run, input.type, input.scope);
        const { head, baseRefs } = baseWorldInTx(tx, input.runId);

        const identity = tx
          .prepare("SELECT run_id AS runId FROM proposals WHERE run_id = ? AND proposal_id = ?")
          .get(input.runId, input.proposalId);
        if (identity === undefined) {
          throw proposalNotFoundError(input.proposalId);
        }
        const awaiting = tx
          .prepare(
            "SELECT revision AS revision FROM proposal_states WHERE run_id = ? AND proposal_id = ? AND status = 'awaiting_approval' LIMIT 1",
          )
          .get(input.runId, input.proposalId) as { revision: number } | undefined;
        if (awaiting === undefined) {
          throw new RuntimeError(
            "PROPOSAL_NOT_AWAITING_APPROVAL",
            `proposal '${input.proposalId}' has no awaiting revision to revise`,
            { detail: { proposalId: input.proposalId } },
          );
        }

        const normalized = normalizeAndValidate({
          runId: input.runId,
          baseRefs,
          changes: input.changes,
          dependencies: input.dependencies,
        });
        // §35: the revised proposal passes the same prepare-time Evidence gate.
        gateRequiredEvidenceInTx(tx, {
          runId: input.runId,
          workspaceId: input.workspaceId,
          requiredEvidence: input.requiredEvidence ?? [],
        });

        // ONE transaction: @N awaiting → superseded, then @N+1 frozen awaiting.
        const supersedes = transitionProposalStateInTx(
          tx,
          { runId: input.runId, proposalId: input.proposalId, revision: awaiting.revision, to: "superseded" },
          clock.nowIso(),
        );
        if (!supersedes) {
          throw new RuntimeError("PROPOSAL_NOT_AWAITING_APPROVAL", `proposal '${input.proposalId}' changed state concurrently`, {
            detail: { proposalId: input.proposalId, revision: awaiting.revision },
          });
        }
        const proposal = freezeRevisionInTx(tx, {
          runId: input.runId,
          proposalId: input.proposalId,
          revision: awaiting.revision + 1,
          run,
          head,
          type: input.type,
          scope: input.scope,
          title: input.title,
          summary: input.summary,
          changes: normalized.changes,
          dependencies: canonicalDependencies((input.dependencies ?? []).map((ref) => ({ runId: input.runId, ...ref }))),
          requiredEvidence: [...(input.requiredEvidence ?? [])].sort(
            (a, b) => a.evidenceId.localeCompare(b.evidenceId) || a.revision - b.revision,
          ),
          impact: canonicalImpact(input.impact),
        });
        appendAuditEventInTx(
          tx,
          {
            eventId: `EVT-${clock.newId()}`,
            runId: input.runId,
            eventType: "PROPOSAL_REVISED",
            subject: {
              runId: input.runId,
              proposalId: input.proposalId,
              revision: awaiting.revision + 1,
              supersedes: awaiting.revision,
            },
            payload: {
              title: input.title,
              changeCount: normalized.changes.length,
              base: canonicalBaseOf(head, input.expectedRunRevision),
            },
          },
          clock.nowIso(),
        );
        return { proposal, candidateRefs: normalized.candidateRefs };
      });
    },

    rejectProposal(input: RejectProposalInput): ProposalRevisionStatusView {
      return store.withWrite((tx) => {
        const run = loadRunInTx(tx, input.runId);
        if (run.workspaceId !== input.workspaceId) {
          throw new RuntimeError("WORKSPACE_MISMATCH", `PlanningRun '${run.runId}' belongs to a different workspace`, {
            detail: { expected: run.workspaceId, detected: input.workspaceId },
          });
        }
        assertWritableBindingInTx(tx, {
          runId: input.runId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          generation: input.bindingGeneration,
        });
        if (run.lifecycle !== "active") {
          throw runStateError("RUN_TERMINAL", `PlanningRun '${run.runId}' is ${run.lifecycle}`, {
            runId: run.runId,
            lifecycle: run.lifecycle,
          });
        }

        const identity = tx
          .prepare("SELECT run_id AS runId FROM proposals WHERE run_id = ? AND proposal_id = ?")
          .get(input.runId, input.proposalId);
        if (identity === undefined) {
          throw proposalNotFoundError(input.proposalId);
        }
        let revision = input.revision;
        if (revision === undefined) {
          const awaiting = tx
            .prepare(
              "SELECT revision AS revision FROM proposal_states WHERE run_id = ? AND proposal_id = ? AND status = 'awaiting_approval' LIMIT 1",
            )
            .get(input.runId, input.proposalId) as { revision: number } | undefined;
          if (awaiting === undefined) {
            throw new RuntimeError(
              "PROPOSAL_NOT_AWAITING_APPROVAL",
              `proposal '${input.proposalId}' has no awaiting revision to reject`,
              { detail: { proposalId: input.proposalId } },
            );
          }
          revision = awaiting.revision;
        }
        const state = getProposalStateInTx(tx, { runId: input.runId, proposalId: input.proposalId, revision });
        if (state === null) throw proposalNotFoundError(input.proposalId, revision);

        const applied = transitionProposalStateInTx(
          tx,
          { runId: input.runId, proposalId: input.proposalId, revision, to: "rejected" },
          clock.nowIso(),
        );
        if (!applied) {
          throw new RuntimeError(
            "PROPOSAL_NOT_AWAITING_APPROVAL",
            `proposal '${input.proposalId}@${revision}' changed state concurrently`,
            { detail: { proposalId: input.proposalId, revision } },
          );
        }
        appendAuditEventInTx(
          tx,
          {
            eventId: `EVT-${clock.newId()}`,
            runId: input.runId,
            eventType: "PROPOSAL_REJECTED",
            subject: { runId: input.runId, proposalId: input.proposalId, revision },
            payload: {},
          },
          clock.nowIso(),
        );
        const view = getProposalRevisionInTx(tx, { runId: input.runId, proposalId: input.proposalId, revision });
        if (view === null) throw proposalNotFoundError(input.proposalId, revision);
        return { ...view, status: "rejected" };
      });
    },

    getProposal: (proposalId, revision) => {
      const runId = store.withRead((tx) => {
        const row = tx.prepare("SELECT run_id AS runId FROM proposals WHERE proposal_id = ?").get(proposalId) as
          | { runId: string }
          | undefined;
        return row?.runId ?? null;
      });
      if (runId === null) return null;
      return getProposalRevisionRecord(store, { runId, proposalId, revision });
    },

    getAwaitingProposal: (runId) => getAwaitingProposalRecord(store, runId),
    listProposalRevisions: (proposalId) => listProposalRevisionsRecord(store, proposalId),
  };
}

function canonicalBaseOf(head: HeadPair | null, runRevision: number): {
  baseRunRevision: number;
  baseHeadSnapshotId: string | null;
  baseHeadCommitId: string | null;
} {
  return {
    baseRunRevision: runRevision,
    baseHeadSnapshotId: head === null ? null : head.headSnapshotId,
    baseHeadCommitId: head === null ? null : head.headCommitId,
  };
}

/**
 * Rebuild the candidate ref world of a STORED proposal revision: the base
 * snapshot's refs with every frozen change result applied. Used only by the
 * prepare-retry idempotent path.
 */
function candidateRefsInTx(
  tx: StoreTx,
  view: ProposalRevisionStatusView,
): MemoryRef[] {
  const world = new Map<string, MemoryRef>();
  if (view.baseHeadSnapshotId !== null) {
    for (const ref of getSnapshotRefsInTx(tx, view.baseHeadSnapshotId) ?? []) {
      world.set(`${ref.kind}:${ref.id}`, ref);
    }
  }
  for (const change of view.changes) {
    world.set(`${change.result.kind}:${change.result.id}`, {
      runId: view.runId,
      kind: change.result.kind,
      id: change.result.id,
      revision: change.result.revision,
    });
  }
  return [...world.values()].sort((a, b) =>
    a.kind === b.kind ? (a.id === b.id ? a.revision - b.revision : a.id < b.id ? -1 : 1) : a.kind < b.kind ? -1 : 1,
  );
}

/** Re-exported for the engine/test seam: sha256 hex digest of a canonical text. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
