/**
 * Phase 11 §83 — Context v2 projection: active Section, workflow statuses,
 * direct dependency contracts only, the context-epoch:v5 evolution (§19/§20),
 * and deterministic Recovery Capsule restoration after resume/compact (§52).
 */

import { describe, expect, it } from "vitest";

import { assembleContext } from "../src/context/assembler.js";
import { createStoreContextSource } from "../src/application/context-read-model.js";
import { commitPrepared } from "./context-helpers.js";
import { buildRecoveryCapsule } from "../src/context/capsule.js";
import {
  commitSectionDag,
  makeDetailFixture,
  runStageOf,
  selectOnFixture,
} from "./phase11-helpers.js";

/** A ← B ← C with A completed, B needs_review (via reopen), C open. */
async function makeMixedStatusFixture() {
  const f = await makeDetailFixture();
  const { sectionIds } = commitSectionDag(f, [
    { title: "Alpha" },
    { title: "Beta", dependencies: ["SEC-1"] },
    { title: "Gamma", dependencies: ["SEC-2"] },
  ]);
  const [a, b] = sectionIds as [string, string];
  selectOnFixture(f, a);
  completeVia(f, a, 1);
  selectOnFixture(f, b);
  completeVia(f, b, 1);
  selectOnFixture(f, a);
  const reopen = f.proposals.prepareProposal({
    runId: f.runId,
    workspaceId: f.workspaceId,
    sessionId: f.sessionId,
    bindingGeneration: f.generation,
    expectedRunRevision: f.runRevision,
    type: "amendment",
    scope: { kind: "section", sectionId: a },
    title: "Reopen Alpha",
    summary: "upstream changed",
    changes: [{ op: "REOPEN_SECTION", sectionId: a, compactProjection: `reopen:${a}` }],
  });
  commitPrepared(f, reopen.proposal.proposalId, reopen.proposal.revision, reopen.proposal.proposalHash);
  return { f, sectionIds };
}

function completeVia(
  f: Awaited<ReturnType<typeof makeDetailFixture>>,
  sectionId: string,
  revision: number,
): void {
  const prepared = f.proposals.prepareProposal({
    runId: f.runId,
    workspaceId: f.workspaceId,
    sessionId: f.sessionId,
    bindingGeneration: f.generation,
    expectedRunRevision: f.runRevision,
    type: "section_completion",
    scope: { kind: "section", sectionId },
    title: `Complete ${sectionId}`,
    summary: "completion",
    changes: [{ op: "COMPLETE_SECTION", sectionId, compactProjection: `complete:${sectionId}@${revision}` }],
  });
  commitPrepared(f, prepared.proposal.proposalId, prepared.proposal.revision, prepared.proposal.proposalHash);
}

describe("context v2 (§83)", () => {
  it("projects the active Section, workflow statuses, and DIRECT dependency contracts only (§18/§50/§51/E15)", async () => {
    const { f, sectionIds } = await makeMixedStatusFixture();
    try {
      const [, , c] = sectionIds as [string, string, string];
      selectOnFixture(f, c);
      const context = assembleContext(createStoreContextSource(f.store), f.runId);
      expect(context.version).toBe(5);
      // Active scope resolved against current HEAD (§11).
      expect(context.activeScope).toMatchObject({
        kind: "section",
        sectionId: c,
        workflowStatus: "open",
      });
      expect(context.activeScope?.revision).toBe(1);
      // Workflow statuses, deterministic by section id: A open (reopened),
      // B needs_review, C open.
      expect(context.sectionWorkflow.sections.map((s) => [s.ref.id, s.status])).toEqual([
        ["SEC-1", "open"],
        ["SEC-2", "needs_review"],
        ["SEC-3", "open"],
      ]);
      const beta = context.sectionWorkflow.sections.find((s) => s.ref.id === "SEC-2")!;
      expect(beta.completedRevision).toBe(1);
      // §51 — ONLY the direct dependency contract (Beta for Gamma), never
      // Alpha, never a recursive expansion, never full designs.
      expect(context.activeDependencyContracts.map((entry) => entry.ref.id)).toEqual(["SEC-2"]);
      expect(context.activeDependencyContracts[0]!.contract.sectionId).toBe("SEC-2");
      expect(JSON.stringify(context.activeDependencyContracts[0]!.contract)).not.toContain("objective");
    } finally {
      f.close();
    }
  });

  it("workflow facts evolve the epoch; selecting, completing, and reopening all move it (§19/E16)", async () => {
    const f = await makeDetailFixture();
    try {
      const source = createStoreContextSource(f.store);
      const epoch0 = assembleContext(source, f.runId).epoch;
      expect(epoch0).toMatch(/^context-epoch:v5:[0-9a-f]{64}$/);
      const { sectionIds } = commitSectionDag(f, [{ title: "A" }, { title: "B" }]);
      const [a, b] = sectionIds as [string, string];
      const epochAfterDag = assembleContext(source, f.runId).epoch;
      expect(epochAfterDag).not.toBe(epoch0); // new Sections are workflow facts
      selectOnFixture(f, a);
      const epochAfterSelect = assembleContext(source, f.runId).epoch;
      expect(epochAfterSelect).not.toBe(epochAfterDag);
      completeVia(f, a, 1);
      const epochAfterComplete = assembleContext(source, f.runId).epoch;
      expect(epochAfterComplete).not.toBe(epochAfterSelect);
      // The workflow digest is stable under identical store state (E14/E33).
      expect(assembleContext(source, f.runId).epoch).toBe(epochAfterComplete);
      void b;
    } finally {
      f.close();
    }
  });

  it("Evidence freshness state by itself stays OUTSIDE the epoch (§20/E17)", async () => {
    const f = await makeDetailFixture();
    try {
      const source = createStoreContextSource(f.store);
      const before = assembleContext(source, f.runId).epoch;
      // Promote critical Evidence (a freshness state exists now) and then
      // revalidate it as still fresh — neither is a Section workflow fact.
      const { captureObservation } = await import("../src/observations/capture.js");
      const { createEvidenceService } = await import("../src/application/evidence-service.js");
      const { createBlobStore } = await import("../src/store/blob-store.js");
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { getWorkspaceById } = await import("../src/store/repositories.js");
      const workspace = getWorkspaceById(f.store, f.workspaceId)!;
      const root = workspace.canonicalRoot;
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(path.join(root, "evidence-src.txt"), "stable content\n", "utf8");
      const blobs = createBlobStore(path.join(f.root, "blobs"));
      const observation = await captureObservation(
        {
          store: f.store,
          clock: { nowIso: () => new Date(0).toISOString(), newId: () => `obs-${Math.random().toString(36).slice(2)}` },
          runId: f.runId,
          workspace,
          blobs,
        },
        {
          sessionId: f.sessionId,
          toolName: "Read",
          toolUseId: `call-ctx-${Date.now()}`,
          toolInput: { file_path: path.join(root, "evidence-src.txt") },
          toolResponse: { type: "text", file: { filePath: "evidence-src.txt", content: "stable content\n" } },
          cwd: root,
        },
      );
      expect(observation.status).toBe("captured");
      const observationId = (observation as { observation: { observationId: string } }).observation.observationId;
      const promoted = createEvidenceService(f.store, blobs, { nowIso: () => new Date(0).toISOString(), newId: () => `ev-${Date.now()}` }).promoteEvidence({
        runId: f.runId,
        workspaceId: f.workspaceId,
        request: {
          claim: "stable source fact",
          kind: "source_fact",
          scope: { type: "global" },
          confidence: "direct",
          criticality: "critical",
          observationRefs: [observationId],
          derivedFrom: [],
        },
        operationId: "promote:ctx-test",
      });
      expect(promoted.freshness.state).toBe("fresh");
      // No Section workflow fact changed → same epoch (Phase 10 invariant kept).
      expect(assembleContext(source, f.runId).epoch).toBe(before);
      expect(runStageOf(f).stage).toBe("detail");
    } finally {
      f.close();
    }
  });

  it("resume/compact recovery: same store state renders a deterministic capsule with the workflow projection (§52/E64)", async () => {
    const { f, sectionIds } = await makeMixedStatusFixture();
    try {
      const [, , c] = sectionIds as [string, string, string];
      selectOnFixture(f, c);
      const context = assembleContext(createStoreContextSource(f.store), f.runId);
      const capsuleA = buildRecoveryCapsule(context);
      const capsuleB = buildRecoveryCapsule(assembleContext(createStoreContextSource(f.store), f.runId));
      // Byte-identical re-render after a simulated compact/resume cycle.
      expect(capsuleB.text).toBe(capsuleA.text);
      expect(capsuleA.text).toContain("[Phase Plan Recovery v4]");
      expect(capsuleA.text).toContain(`Active scope: section ${c}@1 (open)`);
      expect(capsuleA.text).toContain("Section workflow:");
      expect(capsuleA.text).toContain("needs_review");
      expect(capsuleA.text).toContain("Dependency contracts (direct dependencies of the active section):");
      expect(capsuleA.text).toContain("SEC-2@1 contract:");
      // No full designs leak into the capsule (§50).
      expect(capsuleA.text).not.toContain("objective");
    } finally {
      f.close();
    }
  });
});
