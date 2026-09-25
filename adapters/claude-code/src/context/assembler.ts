/**
 * Context Assembler (Phase 8 directive §3/§16/§26/§44).
 *
 * Builds the structured PhasePlanContext from the authoritative read-model
 * port — never from conversation text, compact summaries, or model input.
 * The assembler performs NO mutation (E22): every port method is read-only,
 * and the output is a fresh structured value.
 *
 * The structured context is the authority for rendering; markdown strings
 * are downstream projections only (§16).
 */

import { RuntimeError } from "../runtime/errors.js";
import { deriveContextEpoch } from "./epoch.js";
import { projectGlobalMemory } from "./projection.js";
import type {
  CommittedRevisionView,
  ContextAwaitingProposal,
  ContextOperation,
  ContextRunState,
  ContextSource,
  PhasePlanContext,
} from "./types.js";

export type { ContextSource } from "./types.js";

/** L5 — operations logically available under the current state (§27/§28). */
export function availableOperations(awaitingProposal: ContextAwaitingProposal | null): ContextOperation[] {
  // Phase 8's tool surface is fixed; approve_proposal joins only while a
  // proposal is actually awaiting approval. Unimplemented future tools are
  // never advertised (§27).
  const operations: ContextOperation[] = ["get_state", "get_context", "read_memory", "start_or_resume"];
  if (awaitingProposal !== null) {
    operations.push("approve_proposal");
  }
  return operations;
}

/**
 * Assemble the structured context for one run. Throws RUN_NOT_FOUND when the
 * run does not exist and STORE_SCHEMA_INVALID when the HEAD Snapshot
 * references a missing revision (corruption is never projected silently).
 */
export function assembleContext(source: ContextSource, runId: string): PhasePlanContext {
  const run: ContextRunState | null = source.getRun(runId);
  if (run === null) {
    throw new RuntimeError("RUN_NOT_FOUND", `no PlanningRun exists for '${runId}'`, {
      detail: { runId },
    });
  }
  const head = source.getHeadPair(runId);
  const refs = source.listHeadSnapshotRefs(runId);
  const views: CommittedRevisionView[] = [];
  for (const ref of refs) {
    const view = source.readRevision(ref);
    if (view === null) {
      throw new RuntimeError("STORE_SCHEMA_INVALID", "HEAD snapshot references a missing memory revision", {
        detail: { ref },
      });
    }
    views.push(view);
  }
  const globalMemory = projectGlobalMemory(views);
  const awaitingProposal = source.getAwaitingProposal(runId);
  const epoch = deriveContextEpoch({
    runId: run.runId,
    runRevision: run.revision,
    headCommitId: head.commitId,
    headSnapshotId: head.snapshotId,
    awaitingProposal:
      awaitingProposal === null
        ? null
        : { id: awaitingProposal.proposalId, revision: awaitingProposal.revision, hash: awaitingProposal.hash },
    activeScope: null,
  });
  return {
    version: 1,
    epoch,
    protocol: { name: "phase-plan", entry: "/phase-plan", contextModelVersion: 1 },
    run,
    head,
    globalMemory,
    // §8: intentional Phase-12 deferral — no authoritative active-scope
    // state exists; it is never inferred from HEAD or stage (§10).
    activeScope: null,
    working: { awaitingProposal },
    operations: availableOperations(awaitingProposal),
    // §44 — internal provenance (all planning-domain facts, no secrets).
    sourceTrace: {
      runRevision: run.revision,
      headCommitId: head.commitId,
      headSnapshotId: head.snapshotId,
      snapshotRefCount: refs.length,
      awaitingProposalRevision: awaitingProposal === null ? null : awaitingProposal.revision,
    },
  };
}
