/**
 * Authoritative context read model (Phase 8 directive §3/§26).
 *
 * The Application layer's store-backed implementation of the ContextSource
 * port. Every method delegates to the frozen Phase 5/6 READ APIs —
 * getPlanningRunRecord, getHeadCommitRecord, getHeadSnapshotRecord,
 * listSnapshotRefsRecord/readMemoryRevisionRecord, getAwaitingProposalRecord
 * — so the context layer never grows a second raw-SQL Plan Memory reader.
 *
 * Read-only by construction: no writable binding is required, nothing here
 * mutates the Store, and reads are always bound to an exact runId chosen by
 * the CALLER's session-scoped resolution (the MCP layer resolves the current
 * session's run first — model input can never name a run).
 */

import { getPlanningRunRecord } from "../store/planning-runs.js";
import { getHeadCommitRecord } from "../store/plan-commits.js";
import { getHeadSnapshotRecord, readMemoryRevisionRecord } from "../store/plan-memory.js";
import {
  findAwaitingProposalStateInTx,
  getAwaitingProposalRecord,
  getProposalRevisionInTx,
} from "../store/proposals.js";
import {
  getFinalPlanInTx,
  getLatestEvidenceAuditInTx,
  getLatestFinalPlanCandidateInTx,
  listEvidenceAuditEntriesInTx,
} from "../store/finalization.js";
import { getActiveSection, listSectionWorkflowStates } from "../store/section-workflow.js";
import {
  getLatestValidationReportInTx,
  getLatestSynthesisInputInTx,
  getSynthesisManifestByInputInTx,
  listSynthesisInputEvidenceInTx,
  listSynthesisInputRefsInTx,
  listValidationFindingsInTx,
} from "../store/synthesis.js";
import type { PlanStore } from "../store/sqlite-store.js";
import type {
  CommittedRevisionView,
  ContextAwaitingProposal,
  ContextHead,
  ContextRunState,
  ContextSource,
} from "../context/types.js";

export function createStoreContextSource(store: PlanStore): ContextSource {
  return {
    getRun(runId: string): ContextRunState | null {
      const run = getPlanningRunRecord(store, runId);
      return run === null
        ? null
        : { runId: run.runId, lifecycle: run.lifecycle, stage: run.stage, revision: run.revision, goal: run.goal };
    },

    getActiveSection(runId: string): string | null {
      return getActiveSection(store, runId);
    },

    listSectionWorkflowStates(runId) {
      return listSectionWorkflowStates(store, runId).map((state) => ({
        sectionId: state.sectionId,
        status: state.status,
        completedRevision: state.completedRevision ?? null,
      }));
    },

    getHeadPair(runId: string): ContextHead {
      // The HEAD pair is one Store state (plan_heads); the snapshot side is
      // authoritative for committed memory, the commit side for provenance.
      // The engine writes both in one transaction; a present snapshot with a
      // missing commit is defensively reported as commitId=null.
      const snapshot = getHeadSnapshotRecord(store, runId);
      if (snapshot === null) return { commitId: null, snapshotId: null };
      const commit = getHeadCommitRecord(store, runId);
      return {
        snapshotId: snapshot.snapshotId,
        commitId: commit === null ? null : commit.commitId,
      };
    },

    listHeadSnapshotRefs(runId: string) {
      const snapshot = getHeadSnapshotRecord(store, runId);
      return snapshot === null ? [] : snapshot.refs;
    },

    readRevision(ref): CommittedRevisionView | null {
      const view = readMemoryRevisionRecord(store, ref);
      return view === null
        ? null
        : {
            ref: view.ref,
            content: view.content,
            compactProjection: view.compactProjection,
            contractJson: view.contractJson,
          };
    },

    getAwaitingProposal(runId: string): ContextAwaitingProposal | null {
      const awaiting = getAwaitingProposalRecord(store, runId);
      return awaiting === null
        ? null
        : {
            proposalId: awaiting.proposalId,
            revision: awaiting.revision,
            hash: awaiting.proposalHash,
            type: awaiting.type,
            scope: awaiting.scope,
            title: awaiting.title,
            summary: awaiting.summary,
          };
    },

    getLatestSynthesisInput(runId) {
      return store.withRead((tx) => {
        const input = getLatestSynthesisInputInTx(tx, runId);
        if (input === null) return null;
        return {
          inputId: input.inputId,
          inputHash: input.inputHash,
          baseHeadSnapshotId: input.baseHeadSnapshotId,
          baseHeadCommitId: input.baseHeadCommitId,
          designRefCount: listSynthesisInputRefsInTx(tx, runId, input.inputId).length,
          evidenceCount: listSynthesisInputEvidenceInTx(tx, runId, input.inputId).length,
        };
      });
    },

    getSynthesisManifestForInput(runId, inputId) {
      return store.withRead((tx) => {
        const manifest = getSynthesisManifestByInputInTx(tx, runId, inputId);
        return manifest === null ? null : { manifestId: manifest.manifestId, manifestHash: manifest.manifestHash };
      });
    },

    getValidationReportForManifest(runId, manifestId) {
      return store.withRead((tx) => {
        const report = getLatestValidationReportInTx(tx, runId);
        if (report === null || report.manifestId !== manifestId) return null;
        const counts = new Map<string, number>();
        for (const finding of listValidationFindingsInTx(tx, runId, report.reportId)) {
          counts.set(finding.kind, (counts.get(finding.kind) ?? 0) + 1);
        }
        return {
          reportId: report.reportId,
          reportHash: report.reportHash,
          isClean: report.isClean,
          findingCounts: [...counts.entries()]
            .map(([kind, count]) => ({ kind, count }))
            .sort((a, b) => (a.kind < b.kind ? -1 : 1)),
        };
      });
    },

    // §62 — the finalization world: newest candidate, newest audit, the exact
    // final Proposal (awaiting, or approved via the FinalPlan row), and the
    // approved FinalPlan. All values are plain read projections.
    getFinalizationForRun(runId) {
      return store.withRead((tx) => {
        const candidateRow = getLatestFinalPlanCandidateInTx(tx, runId);
        const latestAudit = getLatestEvidenceAuditInTx(tx, runId);
        const planRow = getFinalPlanInTx(tx, runId);
        const awaitingFinal = findAwaitingProposalStateInTx(tx, runId);
        let finalProposal: {
          proposalId: string;
          revision: number;
          hash: string;
          status: "awaiting_approval" | "approved";
        } | null = null;
        if (awaitingFinal !== null) {
          const revision = getProposalRevisionInTx(tx, { runId, proposalId: awaitingFinal.proposalId, revision: awaitingFinal.revision });
          if (revision !== null && revision.type === "final_plan") {
            finalProposal = {
              proposalId: revision.proposalId,
              revision: revision.revision,
              hash: revision.proposalHash,
              status: "awaiting_approval",
            };
          }
        } else if (planRow !== null) {
          finalProposal = {
            proposalId: planRow.proposalId,
            revision: planRow.proposalRevision,
            hash: planRow.proposalHash,
            status: "approved",
          };
        }
        return {
          candidate:
            candidateRow === null
              ? null
              : {
                  candidateId: candidateRow.candidateId,
                  candidateSeq: candidateRow.candidateSeq,
                  candidateHash: candidateRow.candidateHash,
                },
          evidenceAudit:
            latestAudit === null
              ? null
              : {
                  auditId: latestAudit.auditId,
                  auditHash: latestAudit.auditHash,
                  purpose: latestAudit.purpose,
                  entryCount: listEvidenceAuditEntriesInTx(tx, runId, latestAudit.auditId).length,
                },
          finalProposal,
          finalPlan: planRow === null ? null : { finalPlanId: planRow.finalPlanId, hash: planRow.finalPlanHash },
        };
      });
    },
  };
}
