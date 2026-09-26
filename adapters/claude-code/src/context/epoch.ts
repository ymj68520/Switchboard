/**
 * context_epoch — deterministic projection epoch (Phase 8 directive §5/§6;
 * Phase 11 §19/§20).
 *
 * The epoch is an OPTIMIZATION / stale-context hint only. It is never a
 * mutation gate: real correctness is enforced by SessionBinding generation,
 * PlanningRun revision, HEAD/base Snapshot, and Proposal hash (§6). A stale
 * epoch supplied by the model can therefore never override any fence — the
 * read tools simply return the CURRENT epoch.
 *
 * Inputs (Phase 8 §5 + Phase 11 §19): run identity/revision, HEAD commit/
 * snapshot pair, the awaiting proposal identity/revision/hash, the active
 * Section, and the deterministic Section workflow digest. The digest makes
 * select/complete/needs_review/reopen transitions visible in the epoch even
 * when the run revision and HEAD are untouched (e.g. the Evidence review
 * bridge deliberately bumps neither).
 *
 * Deliberately EXCLUDED (Phase 8 §5/§38 + Phase 11 §20):
 *   - wall clock / random UUIDs / conversation turn numbers / Claude compact
 *     counts (non-deterministic or conversation-derived);
 *   - SessionBinding generation (an authorization fence, not planning
 *     knowledge);
 *   - Evidence freshness state AS SUCH (Phase 10 invariant, kept): Evidence
 *     only reaches the epoch through the real Section workflow facts the
 *     bridge derives from it.
 */

import { createHash } from "node:crypto";

import { canonicalJson } from "../core/canonical-json.js";
import { CONTEXT_EPOCH_VERSION, type ContextSource } from "./types.js";

export interface ContextEpochInputs {
  epochVersion: typeof CONTEXT_EPOCH_VERSION;
  runId: string;
  runRevision: number;
  headCommitId: string | null;
  headSnapshotId: string | null;
  awaitingProposal: { id: string; revision: number; hash: string } | null;
  activeSection: { sectionId: string } | null;
  /** Deterministic [{sectionId, status, completedRevision}] digest input (§19). */
  sectionWorkflow: Array<{ sectionId: string; status: string; completedRevision: number | null }>;
  /** §30 — Phase 12: synthesis/validation identity joined the inputs. */
  synthesis: { inputId: string; inputHash: string } | null;
  synthesisManifest: { manifestId: string; manifestHash: string } | null;
  semanticValidation: { reportId: string; reportHash: string } | null;
  /** §63 — Phase 13: finalization identity joined the inputs (no raw event seq). */
  finalization: {
    candidate: { candidateId: string; candidateHash: string } | null;
    finalProposal: { id: string; revision: number; hash: string } | null;
    finalPlan: { finalPlanId: string; hash: string } | null;
  };
}

/**
 * The workflow digest: canonical JSON over the sorted workflow-state list.
 * Sorted by section id so the same store state always yields the same bytes.
 */
export function sectionWorkflowDigest(
  sections: ContextEpochInputs["sectionWorkflow"],
): string {
  const sorted = [...sections].sort((a, b) => (a.sectionId < b.sectionId ? -1 : a.sectionId > b.sectionId ? 1 : 0));
  return createHash("sha256").update(canonicalJson(sorted), "utf8").digest("hex");
}

/** `context-epoch:v3:<hex>` over the canonical form of the epoch inputs. */
export function deriveContextEpoch(inputs: Omit<ContextEpochInputs, "epochVersion">): string {
  const payload = {
    epochVersion: CONTEXT_EPOCH_VERSION,
    runId: inputs.runId,
    runRevision: inputs.runRevision,
    headCommitId: inputs.headCommitId,
    headSnapshotId: inputs.headSnapshotId,
    awaitingProposal:
      inputs.awaitingProposal === null
        ? null
        : {
            id: inputs.awaitingProposal.id,
            revision: inputs.awaitingProposal.revision,
            hash: inputs.awaitingProposal.hash,
          },
    activeSection: inputs.activeSection,
    sectionWorkflowDigest: sectionWorkflowDigest(inputs.sectionWorkflow),
    // §30 — submit_synthesis / submit_validation / request_reopen are all
    // visible in the epoch through these identity pairs.
    synthesis: inputs.synthesis,
    synthesisManifest: inputs.synthesisManifest,
    semanticValidation: inputs.semanticValidation,
    // §63 — request_finalization / Final Approval are visible through the
    // finalization identity pairs; raw Evidence validation event seqs never
    // enter the epoch, and the Final PlanCommit itself moves HEAD.
    finalization: inputs.finalization,
  };
  const hex = createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
  return `${CONTEXT_EPOCH_VERSION}:${hex}`;
}

/**
 * Epoch derivation that reads ONLY the cheap authoritative inputs (run row,
 * HEAD pair, awaiting proposal, active section, workflow states) — no
 * snapshot-member expansion. This is the form used on the normal-turn delta
 * path (Phase 8 directive §34), which must stay a fast read (§40). Returns
 * null when the run does not exist.
 */
export function deriveContextEpochFromSource(source: ContextSource, runId: string): string | null {
  const run = source.getRun(runId);
  if (run === null) return null;
  const head = source.getHeadPair(runId);
  const awaiting = source.getAwaitingProposal(runId);
  const activeSectionId = source.getActiveSection(runId);
  const workflow = source.listSectionWorkflowStates(runId);
  // §30 — cheap identity reads only; null outside synthesis/validation.
  const synthesis =
    run.stage === "synthesis" || run.stage === "validation" || run.stage === "final"
      ? source.getLatestSynthesisInput(runId)
      : null;
  const manifest =
    synthesis === null ? null : source.getSynthesisManifestForInput(runId, synthesis.inputId);
  const report = manifest === null ? null : source.getValidationReportForManifest(runId, manifest.manifestId);
  // §63 — finalization identity, read only at stage final.
  const finalizationWorld =
    run.stage === "final" ? source.getFinalizationForRun(runId) : null;
  return deriveContextEpoch({
    runId: run.runId,
    runRevision: run.revision,
    headCommitId: head.commitId,
    headSnapshotId: head.snapshotId,
    awaitingProposal:
      awaiting === null
        ? null
        : { id: awaiting.proposalId, revision: awaiting.revision, hash: awaiting.hash },
    activeSection: activeSectionId === null ? null : { sectionId: activeSectionId },
    sectionWorkflow: workflow.map((state) => ({
      sectionId: state.sectionId,
      status: state.status,
      completedRevision: state.completedRevision,
    })),
    synthesis: synthesis === null ? null : { inputId: synthesis.inputId, inputHash: synthesis.inputHash },
    synthesisManifest: manifest,
    semanticValidation: report === null ? null : { reportId: report.reportId, reportHash: report.reportHash },
    finalization: {
      candidate:
        finalizationWorld === null || finalizationWorld.candidate === null
          ? null
          : {
              candidateId: finalizationWorld.candidate.candidateId,
              candidateHash: finalizationWorld.candidate.candidateHash,
            },
      finalProposal:
        awaiting === null
          ? null
          : { id: awaiting.proposalId, revision: awaiting.revision, hash: awaiting.hash },
      finalPlan: finalizationWorld === null ? null : finalizationWorld.finalPlan,
    },
  });
}