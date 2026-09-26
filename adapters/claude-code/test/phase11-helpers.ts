/**
 * Shared Phase 11 fixtures: a run driven to the DETAIL stage through the real
 * production path (architecture checkpoint → architecture completion), a
 * detail-scope Section DAG builder, and small content factories. No test-only
 * stage mutation exists here — the run reaches detail exclusively through
 * prepare → approve cycles.
 */

import {
  commitPrepared,
  type ContextFixture,
} from "./context-helpers.js";
import { makeProposalFixture, prepareCheckpoint, type ProposalFixture } from "./proposal-helpers.js";
import { makeTempPluginDataRoot, removeTempPluginDataRoot } from "./store-helpers.js";
import { counterClock } from "./test-clocks.js";
import { createPlanCommitEngine } from "../src/application/plan-commit-engine.js";
import { createProposalService } from "../src/application/proposal-service.js";
import { createSectionWorkflowService } from "../src/application/section-workflow-service.js";
import type { RawProposalChange } from "../src/core/proposal.js";
import type { RawSectionContent } from "../src/core/proposal.js";
import { getPlanningRunRecord } from "../src/store/planning-runs.js";
import {
  getActiveSection,
  listSectionWorkflowStates,
  type SectionWorkflowStateView,
} from "../src/store/section-workflow.js";
import type { PlanningStage } from "../src/core/state-machine.js";

export interface DetailFixture extends ProposalFixture {
  /** Plugin-data root backing the fixture. */
  root: string;
  close(): void;
}

/** Swap fixed-id proposal/engine clocks for globally unique counters. */
export function withCounterServices<T extends ProposalFixture>(fixture: T): T {
  return {
    ...fixture,
    proposals: createProposalService(fixture.store, counterClock()),
    engine: createPlanCommitEngine(fixture.store, counterClock()),
  };
}

/** Drive any proposal fixture to DETAIL through the real approval path. */
export function driveToDetail(fixture: ProposalFixture): void {
  const checkpoint = prepareCheckpoint(fixture, [
    { op: "SET_ARCHITECTURE_REVISION", target: null, content: architectureContent(), compactProjection: "ARCH-1@1" },
  ]);
  commitPrepared(fixture, checkpoint.proposal.proposalId, checkpoint.proposal.revision, checkpoint.proposal.proposalHash);
  const completion = fixture.proposals.prepareProposal({
    runId: fixture.runId,
    workspaceId: fixture.workspaceId,
    sessionId: fixture.sessionId,
    bindingGeneration: fixture.generation,
    expectedRunRevision: fixture.runRevision,
    type: "architecture_completion",
    scope: { kind: "architecture" },
    title: "Architecture completion",
    summary: "architecture is stable",
    changes: [],
  });
  commitPrepared(fixture, completion.proposal.proposalId, completion.proposal.revision, completion.proposal.proposalHash);
}

/** A run at stage detail with one committed architecture (real path). */
export async function makeDetailFixture(sessionId = "S1"): Promise<DetailFixture> {
  const root = makeTempPluginDataRoot("phase-plan-section-");
  const fixture = await makeProposalFixture(root, { sessionId });
  // Phase 11 flows prepare MANY proposals in one run; swap the fixed-id
  // proposal/engine clocks for a globally unique counter so audit and
  // proposal ids never collide.
  const withCounters = withCounterServices(fixture);
  driveToDetail(withCounters);
  return wrap(withCounters, root);
}

function wrap(fixture: ProposalFixture, root: string): DetailFixture {
  return {
    ...fixture,
    root,
    close: () => {
      fixture.store.close();
      removeTempPluginDataRoot(root);
    },
  };
}

/** Raw section content; the contract is bound server-side during normalization. */
export function rawSection(
  title: string,
  options: { dependencies?: string[]; localRef?: string } = {},
): { content: RawSectionContent; localRef?: string } {
  const content: RawSectionContent = {
    title,
    objective: `${title} objective`,
    design: `${title} design`,
    interfaces: [],
    invariants: [],
    failureModes: [],
    dependencies: options.dependencies ?? [],
    decisionRefs: [],
    openQuestionRefs: [],
    impactRefs: [],
    contract: { provides: [], requires: [], invariants: [], interfaces: [], decisions: [] },
  };
  return { content, ...(options.localRef !== undefined ? { localRef: options.localRef } : {}) };
}

export function architectureContent() {
  return {
    summary: "Single-store architecture",
    components: ["PlanStore"],
    boundaries: ["plugin data dir"],
    dataFlows: [],
    principles: [],
    unresolvedQuestionRefs: [],
    decisionRefs: [],
  };
}

/** The Section DAG creation proposal (detail scope) with optional aliases. */
export function dagChanges(
  sections: Array<{ title: string; localRef?: string; dependencies?: Array<string> }>,
): RawProposalChange[] {
  return sections.map((section) => {
    const raw = rawSection(section.title, { dependencies: section.dependencies, localRef: section.localRef });
    return {
      op: "SET_SECTION_REVISION" as const,
      target: null,
      content: raw.content,
      compactProjection: `section:${section.title}`,
      ...(raw.localRef !== undefined ? { localRef: raw.localRef } : {}),
    };
  });
}

/** Create + commit a Section DAG at detail (the §26 path). */
export function commitSectionDag(fixture: DetailFixture, sections: Array<{ title: string; localRef?: string; dependencies?: Array<string> }>): { sectionIds: string[] } {
  const prepared = fixture.proposals.prepareProposal({
    runId: fixture.runId,
    workspaceId: fixture.workspaceId,
    sessionId: fixture.sessionId,
    bindingGeneration: fixture.generation,
    expectedRunRevision: fixture.runRevision,
    type: "design_checkpoint",
    scope: { kind: "detail" },
    title: "Initial section DAG",
    summary: "dynamic decomposition",
    changes: dagChanges(sections),
  });
  const result = commitPrepared(fixture, prepared.proposal.proposalId, prepared.proposal.revision, prepared.proposal.proposalHash);
  const sectionIds = [...new Set(prepared.candidateRefs.filter((ref) => ref.kind === "section").map((ref) => ref.id))].sort();
  void result;
  return { sectionIds };
}

export function workflowStatesOf(fixture: DetailFixture): SectionWorkflowStateView[] {
  return listSectionWorkflowStates(fixture.store, fixture.runId);
}

export function activeSectionOf(fixture: DetailFixture): string | null {
  return getActiveSection(fixture.store, fixture.runId);
}

/** Select through the real service and keep the fixture's fence current. */
export function selectOnFixture(fixture: DetailFixture, sectionId: string): void {
  const service = createSectionWorkflowService(fixture.store, counterClock());
  service.selectSection({
    runId: fixture.runId,
    workspaceId: fixture.workspaceId,
    sessionId: fixture.sessionId,
    bindingGeneration: fixture.generation,
    expectedRunRevision: fixture.runRevision,
    sectionId,
  });
  const run = getPlanningRunRecord(fixture.store, fixture.runId);
  if (run !== null) (fixture as { runRevision: number }).runRevision = run.revision;
}

export function runStageOf(fixture: { store: ProposalFixture["store"]; runId: string }): { stage: PlanningStage; revision: number } {
  const run = getPlanningRunRecord(fixture.store, fixture.runId);
  if (run === null) throw new Error("fixture run vanished");
  return { stage: run.stage, revision: run.revision };
}

export type { ContextFixture };
