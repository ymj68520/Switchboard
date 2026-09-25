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
import { getAwaitingProposalRecord } from "../store/proposals.js";
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
  };
}
