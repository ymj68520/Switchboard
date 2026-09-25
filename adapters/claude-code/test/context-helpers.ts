/**
 * Shared Phase 8 fixtures: committed-memory builders over the sanctioned
 * test-only writer seam, engine-based commit helper, and host-token factory
 * for the Phase 8 read tools.
 */

import { createInternalPlanMemoryWriter } from "../src/store/plan-memory.js";
import type { PlanCommitEngine } from "../src/application/plan-commit-engine.js";
import type { MemoryArtifactKind, MemoryRef } from "../src/core/memory-refs.js";
import type { MemoryRevisionContent } from "../src/core/memory-artifacts.js";
import type { RawProposalChange } from "../src/core/proposal.js";
import {
  closeFixture,
  makeProposalFixture,
  makeTestUserAuthorization,
  prepareCheckpoint,
  type ProposalFixture,
} from "./proposal-helpers.js";
import { fixedClock, makeTempPluginDataRoot, removeTempPluginDataRoot } from "./store-helpers.js";
import { buildHostContextEnvelope, businessInputHashOf, encodeHostContextToken } from "../src/host/host-context.js";

export interface ContextFixture extends ProposalFixture {
  /** Plugin-data root backing the fixture (secret/store paths). */
  root: string;
  /** Test-only committed-memory writer seam (plan-memory.ts header). */
  memory: ReturnType<typeof createInternalPlanMemoryWriter>;
  close(): void;
}

export async function makeContextFixture(sessionId = "S1"): Promise<ContextFixture> {
  const root = makeTempPluginDataRoot("phase-plan-context-");
  const fixture = await makeProposalFixture(root, { sessionId });
  return {
    ...fixture,
    root,
    memory: createInternalPlanMemoryWriter(fixture.store, fixedClock({ ids: ["snap", "snap2"] })),
    close: () => {
      closeFixture(fixture);
      removeTempPluginDataRoot(root);
    },
  };
}

/** Register + append one revision, returning its exact ref. */
export function addRevision(
  fixture: ContextFixture,
  input: { kind: MemoryArtifactKind; artifactId: string; content: MemoryRevisionContent; compactProjection: string },
): MemoryRef {
  fixture.memory.insertArtifactIdentity({ runId: fixture.runId, kind: input.kind, artifactId: input.artifactId });
  return fixture.memory.insertMemoryRevision({
    runId: fixture.runId,
    kind: input.kind,
    artifactId: input.artifactId,
    content: input.content,
    compactProjection: input.compactProjection,
  });
}

/** Publish a HEAD snapshot over the given refs (test-only writer seam). */
export function publishHead(fixture: ContextFixture, refs: MemoryRef[]): string {
  const snapshot = fixture.memory.insertSnapshot({ runId: fixture.runId, refs });
  fixture.memory.setHeadSnapshot({ runId: fixture.runId, expectedHeadSnapshotId: null, nextSnapshotId: snapshot.snapshotId });
  return snapshot.snapshotId;
}

export function sectionContent(artifactId: string, revision: number, title = `Section ${artifactId}`): MemoryRevisionContent {
  return {
    title,
    objective: "objective",
    design: "design",
    interfaces: [],
    invariants: [],
    failureModes: [],
    dependencies: [],
    decisionRefs: [],
    openQuestionRefs: [],
    impactRefs: [],
    contract: {
      sectionId: artifactId,
      revision,
      provides: [`provides:${artifactId}`],
      requires: [],
      invariants: [],
      interfaces: [],
      decisions: [],
    },
  };
}

/**
 * Prepare a checkpoint through the service and commit it through the Phase 6
 * engine — the real production path from awaiting proposal to HEAD commit.
 * Keeps the fixture's runRevision current for chained commits.
 */
export function commitCheckpoint(
  fixture: ContextFixture,
  changes: RawProposalChange[],
): { approvalId: string; commitId: string; snapshotId: string; runRevision: number | null } {
  const prepared = prepareCheckpoint(fixture, changes);
  return commitPrepared(fixture, prepared.proposal.proposalId, prepared.proposal.revision, prepared.proposal.proposalHash);
}

export function commitPrepared(
  fixture: ContextFixture,
  proposalId: string,
  proposalRevision: number,
  proposalHash: string,
): { approvalId: string; commitId: string; snapshotId: string; runRevision: number | null } {
  const engine: PlanCommitEngine = fixture.engine;
  const result = engine.commitAuthorizedProposal({
    runId: fixture.runId,
    workspaceId: fixture.workspaceId,
    sessionId: fixture.sessionId,
    bindingGeneration: fixture.generation,
    authorization: makeTestUserAuthorization({ proposalId, proposalRevision, proposalHash }),
  });
  // Keep chained prepareCheckpoint calls valid (run revision moved). An
  // idempotent replay reports null and leaves the fixture revision as-is.
  if (result.runRevision !== null) {
    (fixture as { runRevision: number }).runRevision = result.runRevision;
  }
  return { approvalId: result.approvalId, commitId: result.commitId, snapshotId: result.snapshotId, runRevision: result.runRevision };
}

export function hostToken(
  secret: Buffer,
  logical: string,
  businessInput: Record<string, unknown>,
  ids: { sessionId: string; workspaceId: string; runId?: string; generation?: number },
  options: { permissionMode?: string; toolUseId?: string } = {},
): string {
  return encodeHostContextToken(
    secret,
    buildHostContextEnvelope({
      sessionId: ids.sessionId,
      promptId: "PROMPT-1",
      workspaceId: ids.workspaceId,
      ...(ids.runId === undefined ? {} : { runId: ids.runId }),
      ...(ids.generation === undefined ? {} : { bindingGeneration: ids.generation }),
      permissionMode: options.permissionMode ?? "plan",
      toolUseId: options.toolUseId ?? "TU-CTX",
      toolName: `mcp__plugin_phase-plan_phase-plan__${logical}`,
      businessInputHash: businessInputHashOf(businessInput),
    }),
  );
}
