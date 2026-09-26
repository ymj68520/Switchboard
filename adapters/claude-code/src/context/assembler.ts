/**
 * Context Assembler (Phase 8 directive §3/§16/§26/§44; Phase 11 §17/§18/§50).
 *
 * Builds the structured PhasePlanContext from the authoritative read-model
 * port — never from conversation text, compact summaries, or model input.
 * The assembler performs NO mutation (E22): every port method is read-only,
 * and the output is a fresh structured value.
 *
 * Phase 11 projection rules:
 *   - every committed Section is shown with its workflow status at its exact
 *     HEAD revision (§18), deterministically ordered by section id;
 *   - the active Section is resolved against the CURRENT HEAD snapshot (§11);
 *   - only the DIRECT dependency contracts of the active Section are loaded
 *     — never full designs, never a recursive expansion (§51).
 *
 * The structured context is the authority for rendering; markdown strings
 * are downstream projections only (§16).
 */

import { RuntimeError } from "../runtime/errors.js";
import type { SectionContent } from "../core/memory-artifacts.js";
import { deriveContextEpoch } from "./epoch.js";
import { projectGlobalMemory } from "./projection.js";
import type {
  CommittedRevisionView,
  ContextActiveScope,
  ContextAwaitingProposal,
  ContextDependencyContract,
  ContextOperation,
  ContextRunState,
  ContextSource,
  ContextWorkflowSection,
  PhasePlanContext,
} from "./types.js";

export type { ContextSource } from "./types.js";

/** L5 — operations logically available under the current state (§27/§53). */
export function availableOperations(
  run: ContextRunState,
  awaitingProposal: ContextAwaitingProposal | null,
): ContextOperation[] {
  // The tool surface is fixed per phase; approve_proposal joins only while a
  // proposal is actually awaiting approval, select_section only exists in the
  // Detail workflow, prepare_proposal only where preparation is a legal
  // capability. Unimplemented future tools are never advertised (§27).
  const operations: ContextOperation[] = ["get_state", "get_context", "read_memory", "start_or_resume"];
  if (run.stage === "discovery" || run.stage === "architecture" || run.stage === "detail") {
    operations.push("prepare_proposal");
  }
  if (run.stage === "detail") {
    operations.push("select_section");
  }
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

  // §18 — Section workflow projection, deterministic by section id.
  const workflowStates = new Map(source.listSectionWorkflowStates(runId).map((state) => [state.sectionId, state]));
  const sectionViews = views.filter((view) => view.ref.kind === "section");
  const sections: ContextWorkflowSection[] = sectionViews
    .map((view) => {
      const content = view.content as SectionContent;
      const state = workflowStates.get(view.ref.id);
      return {
        ref: view.ref,
        title: content.title,
        status: state?.status ?? "open",
        ...(state?.completedRevision != null ? { completedRevision: state.completedRevision } : {}),
        dependencies: Array.isArray(content.dependencies) ? [...content.dependencies] : [],
      };
    })
    .sort((a, b) => (a.ref.id < b.ref.id ? -1 : a.ref.id > b.ref.id ? 1 : 0));

  // §11 — the active Section identity is durable state; its exact revision,
  // title, and status resolve against the CURRENT HEAD snapshot.
  const activeSectionId = source.getActiveSection(runId);
  let activeScope: ContextActiveScope | null = null;
  if (activeSectionId !== null) {
    const activeView = sectionViews.find((view) => view.ref.id === activeSectionId);
    if (activeView !== undefined) {
      const activeState = workflowStates.get(activeSectionId);
      activeScope = {
        kind: "section",
        sectionId: activeSectionId,
        revision: activeView.ref.revision,
        title: (activeView.content as SectionContent).title,
        workflowStatus: activeState?.status ?? "open",
      };
    }
    // A stale active-work row pointing outside HEAD is store corruption the
    // v8 validator fences; here it simply projects as no active scope —
    // context is a projection and never repairs authority (§1).
  }

  // §51 — DIRECT dependency contracts of the active Section only.
  const activeDependencyContracts: ContextDependencyContract[] = [];
  if (activeScope !== null) {
    const activeEntry = sections.find((section) => section.ref.id === activeSectionId);
    for (const dependencyId of activeEntry?.dependencies ?? []) {
      const dependencyRef = sectionViews.find((view) => view.ref.id === dependencyId)?.ref;
      if (dependencyRef === undefined) continue;
      const dependencyView = sectionViews.find((view) => view.ref.id === dependencyId);
      const contract = dependencyView?.contractJson;
      if (contract === undefined || contract === null) continue;
      activeDependencyContracts.push({
        ref: dependencyRef,
        contract: JSON.parse(contract) as import("../core/memory-artifacts.js").SectionContract,
      });
    }
    activeDependencyContracts.sort((a, b) => (a.ref.id < b.ref.id ? -1 : a.ref.id > b.ref.id ? 1 : 0));
  }

  const epoch = deriveContextEpoch({
    runId: run.runId,
    runRevision: run.revision,
    headCommitId: head.commitId,
    headSnapshotId: head.snapshotId,
    awaitingProposal:
      awaitingProposal === null
        ? null
        : { id: awaitingProposal.proposalId, revision: awaitingProposal.revision, hash: awaitingProposal.hash },
    activeSection: activeScope === null ? null : { sectionId: activeScope.sectionId },
    sectionWorkflow: sections.map((section) => ({
      sectionId: section.ref.id,
      status: section.status,
      completedRevision: section.completedRevision ?? null,
    })),
  });
  return {
    version: 2,
    epoch,
    protocol: { name: "phase-plan", entry: "/phase-plan", contextModelVersion: 2 },
    run,
    head,
    globalMemory,
    activeScope,
    sectionWorkflow: { sections },
    activeDependencyContracts,
    working: { awaitingProposal },
    operations: availableOperations(run, awaitingProposal),
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
