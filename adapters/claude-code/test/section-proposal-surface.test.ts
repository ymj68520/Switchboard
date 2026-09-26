/**
 * Phase 11 §82 — the production Proposal surface: Discovery→Architecture
 * atomic bridge, detail scope, request-local Section aliases, exact-ref
 * COMPLETE_SECTION/REOPEN_SECTION binding, and completed-Section mutation
 * protection. Canonical JSON only ever carries server-generated ids (§58).
 */

import { describe, expect, it } from "vitest";

import {
  commitSectionDag,
  makeDetailFixture,
  rawSection,
  runStageOf,
  selectOnFixture,
  workflowStatesOf,
  architectureContent,
} from "./phase11-helpers.js";
import { commitPrepared } from "./context-helpers.js";
import { makeProposalFixture, prepareCheckpoint } from "./proposal-helpers.js";
import { makeTempPluginDataRoot, removeTempPluginDataRoot } from "./store-helpers.js";
import { canonicalProposalHash, parseProposalCanonical } from "../src/core/proposal-canonical.js";
import { canonicalJson } from "../src/core/canonical-json.js";

describe("proposal surface (§82)", () => {
  it("the first Architecture prepare at Discovery atomically advances the run (E20)", async () => {
    const root = makeTempPluginDataRoot("phase-plan-bridge-");
    const fixture = await makeProposalFixture(root, { stage: "discovery" });
    try {
      expect(runStageOf(fixture)).toEqual({ stage: "discovery", revision: 1 });
      const prepared = prepareCheckpoint(fixture, [
        { op: "SET_ARCHITECTURE_REVISION", target: null, content: architectureContent(), compactProjection: "ARCH-1@1" },
      ]);
      // The proposal froze against the NEW run revision (§24).
      expect(prepared.proposal.baseRunRevision).toBe(2);
      expect(runStageOf(fixture)).toEqual({ stage: "architecture", revision: 2 });
      // The commit succeeds against the frozen base — no fence violation.
      commitPrepared(fixture, prepared.proposal.proposalId, prepared.proposal.revision, prepared.proposal.proposalHash);
    } finally {
      fixture.store.close();
      removeTempPluginDataRoot(root);
    }
  });

  it("a failed first prepare leaves Discovery unchanged, with no proposal (E21)", async () => {
    const root = makeTempPluginDataRoot("phase-plan-bridge-");
    const fixture = await makeProposalFixture(root, { stage: "discovery" });
    try {
      expect(() =>
        prepareCheckpoint(fixture, [
          // Invalid architecture content: empty summary fails the parser
          // AFTER the bridge would have run — the whole tx rolls back.
          { op: "SET_ARCHITECTURE_REVISION", target: null, content: { ...architectureContent(), summary: "" }, compactProjection: "ARCH" },
        ]),
      ).toThrowError();
      expect(runStageOf(fixture)).toEqual({ stage: "discovery", revision: 1 });
      expect(fixture.proposals.getAwaitingProposal(fixture.runId)).toBeNull();
    } finally {
      fixture.store.close();
      removeTempPluginDataRoot(root);
    }
  });

  it("request-local aliases resolve to server ids and never enter canonical state (§27/§58)", async () => {
    const f = await makeDetailFixture();
    try {
      const prepared = f.proposals.prepareProposal({
        runId: f.runId,
        workspaceId: f.workspaceId,
        sessionId: f.sessionId,
        bindingGeneration: f.generation,
        expectedRunRevision: f.runRevision,
        type: "design_checkpoint",
        scope: { kind: "detail" },
        title: "Aliased DAG",
        summary: "api depends on the request-local alias declared later in the array",
        changes: [
          {
            op: "SET_SECTION_REVISION",
            target: null,
            content: rawSection("API layer", { dependencies: ["persistence"] }).content,
            compactProjection: "section:api",
          },
          {
            op: "SET_SECTION_REVISION",
            target: null,
            content: rawSection("Persistence").content,
            compactProjection: "section:persistence",
            localRef: "persistence",
          },
        ],
      });
      const canonical = parseProposalCanonical(JSON.parse(prepared.proposal.canonicalJson));
      // Canonical hash re-derives (the canonical form is authoritative).
      expect(canonicalProposalHash(canonical)).toBe(prepared.proposal.proposalHash);
      // No alias survives normalization as a structural identity (§58):
      // ids and dependency edges carry server ids only.
      const identityJson = canonicalJson(
        canonical.changes.map((change) => [
          change.artifactId,
          (change as unknown as { content?: { dependencies?: string[] } }).content?.dependencies ?? [],
        ]),
      );
      expect(identityJson).not.toContain("persistence");
      const sectionChanges = canonical.changes.filter((change) => change.op === "SET_SECTION_REVISION");
      expect(sectionChanges).toHaveLength(2);
      const ids = sectionChanges.map((change) => change.artifactId).sort();
      expect(ids).toEqual(["SEC-1", "SEC-2"]);
      // The aliased section (declared with localRef) took the FIRST server id
      // (pre-pass allocation); the API section's dependency names the RESOLVED id.
      const api = sectionChanges.find(
        (change) => (change as unknown as { content: { title: string } }).content.title === "API layer",
      )!;
      expect(api.artifactId).toBe("SEC-2");
      expect((api as unknown as { content: { dependencies: string[] } }).content.dependencies).toEqual(["SEC-1"]);
      commitPrepared(f, prepared.proposal.proposalId, prepared.proposal.revision, prepared.proposal.proposalHash);
      expect(workflowStatesOf(f).map((s) => s.sectionId).sort()).toEqual(["SEC-1", "SEC-2"]);
    } finally {
      f.close();
    }
  });

  it("COMPLETE_SECTION freezes the exact candidate revision into the canonical hash (§30/§31/E30)", async () => {
    const f = await makeDetailFixture();
    try {
      const { sectionIds } = commitSectionDag(f, [{ title: "A" }]);
      const a = sectionIds[0]!;
      const prepared = f.proposals.prepareProposal({
        runId: f.runId,
        workspaceId: f.workspaceId,
        sessionId: f.sessionId,
        bindingGeneration: f.generation,
        expectedRunRevision: f.runRevision,
        type: "section_completion",
        scope: { kind: "section", sectionId: a },
        title: "Complete A",
        summary: "exact binding",
        changes: [{ op: "COMPLETE_SECTION", sectionId: a, compactProjection: `complete:${a}` }],
      });
      const canonical = parseProposalCanonical(JSON.parse(prepared.proposal.canonicalJson));
      const complete = canonical.changes.find((change) => change.op === "COMPLETE_SECTION")!;
      expect(complete.artifactId).toBe(a);
      expect(complete.result.revision).toBe(1);
      expect((complete as unknown as { target: { revision: number } }).target.revision).toBe(1);
      expect(canonicalProposalHash(canonical)).toBe(prepared.proposal.proposalHash);
    } finally {
      f.close();
    }
  });

  it("a completed Section cannot be revised without an explicit REOPEN_SECTION (§38/E41)", async () => {
    const f = await makeDetailFixture();
    try {
      // Two independent sections: completing A keeps the run at detail (B open).
      const { sectionIds } = commitSectionDag(f, [{ title: "A" }, { title: "B" }]);
      const a = sectionIds[0]!;
      selectOnFixture(f, a);
      const completion = f.proposals.prepareProposal({
        runId: f.runId,
        workspaceId: f.workspaceId,
        sessionId: f.sessionId,
        bindingGeneration: f.generation,
        expectedRunRevision: f.runRevision,
        type: "section_completion",
        scope: { kind: "section", sectionId: a },
        title: "Complete A",
        summary: "first completion",
        changes: [{ op: "COMPLETE_SECTION", sectionId: a, compactProjection: `complete:${a}` }],
      });
      commitPrepared(f, completion.proposal.proposalId, completion.proposal.revision, completion.proposal.proposalHash);
      // Plain design mutation on the completed Section → rejected at prepare.
      expect(() =>
        f.proposals.prepareProposal({
          runId: f.runId,
          workspaceId: f.workspaceId,
          sessionId: f.sessionId,
          bindingGeneration: f.generation,
          expectedRunRevision: f.runRevision,
          type: "design_checkpoint",
          scope: { kind: "section", sectionId: a },
          title: "Silent edit",
          summary: "must fail",
          changes: [
            {
              op: "SET_SECTION_REVISION",
              target: { id: a, revision: 1 },
              content: rawSection("A v2").content,
              compactProjection: "section:A@2",
            },
          ],
        }),
      ).toThrowError(expect.objectContaining({ code: "SECTION_WORKFLOW_INVALID" }));
      // REOPEN_SECTION in a plain checkpoint is also refused (§39: amendment
      // or section_completion only).
      expect(() =>
        f.proposals.prepareProposal({
          runId: f.runId,
          workspaceId: f.workspaceId,
          sessionId: f.sessionId,
          bindingGeneration: f.generation,
          expectedRunRevision: f.runRevision,
          type: "design_checkpoint",
          scope: { kind: "section", sectionId: a },
          title: "Reopen via checkpoint",
          summary: "must fail",
          changes: [{ op: "REOPEN_SECTION", sectionId: a, compactProjection: `reopen:${a}` }],
        }),
      ).toThrowError(expect.objectContaining({ code: "PROPOSAL_INVALID" }));
    } finally {
      f.close();
    }
  });

  it("atomic reopen + amend + re-complete in ONE section_completion proposal (§40)", async () => {
    const f = await makeDetailFixture();
    try {
      const { sectionIds } = commitSectionDag(f, [
        { title: "A" },
        { title: "B" },
      ]);
      const [a] = sectionIds as [string];
      selectOnFixture(f, a);
      const completion = f.proposals.prepareProposal({
        runId: f.runId,
        workspaceId: f.workspaceId,
        sessionId: f.sessionId,
        bindingGeneration: f.generation,
        expectedRunRevision: f.runRevision,
        type: "section_completion",
        scope: { kind: "section", sectionId: a },
        title: "Complete A",
        summary: "first completion",
        changes: [{ op: "COMPLETE_SECTION", sectionId: a, compactProjection: `complete:${a}` }],
      });
      commitPrepared(f, completion.proposal.proposalId, completion.proposal.revision, completion.proposal.proposalHash);
      selectOnFixture(f, a);
      // §40 — model array order (COMPLETE before SET before REOPEN) must not
      // change the normalized semantics: REOPEN → design → COMPLETE.
      const atomic = f.proposals.prepareProposal({
        runId: f.runId,
        workspaceId: f.workspaceId,
        sessionId: f.sessionId,
        bindingGeneration: f.generation,
        expectedRunRevision: f.runRevision,
        type: "section_completion",
        scope: { kind: "section", sectionId: a },
        title: "Reopen, amend, re-complete",
        summary: "atomic triple",
        changes: [
          { op: "COMPLETE_SECTION", sectionId: a, compactProjection: `complete:${a}@2` },
          {
            op: "SET_SECTION_REVISION",
            target: { id: a, revision: 1 },
            content: rawSection("A v2").content,
            compactProjection: "section:A@2",
          },
          { op: "REOPEN_SECTION", sectionId: a, compactProjection: `reopen:${a}` },
        ],
      });
      // Canonical order is fixed regardless of model array order: memory
      // mutations first, then the workflow facts REOPEN → COMPLETE (§40 —
      // deterministic semantics, model order irrelevant).
      const order = atomic.proposal.changes.map((change) => change.op);
      expect(order).toEqual(["SET_SECTION_REVISION", "REOPEN_SECTION", "COMPLETE_SECTION"]);
      // Model-order independence: normalizing the REVERSED request over the
      // same base yields the identical canonical op order (pure core check —
      // the store keeps only one awaiting proposal at a time).
      const headPair = f.store.withRead((tx) => tx.prepare("SELECT head_snapshot_id AS s FROM plan_heads WHERE run_id = ?").get(f.runId)) as { s: string };
      const baseRefs = f.store.withRead((tx) => tx.prepare("SELECT kind, artifact_id AS id, revision FROM snapshot_members WHERE snapshot_id = ?").all(headPair.s)) as Array<{ kind: string; id: string; revision: number }>;
      const { normalizeProposalChanges } = await import("../src/core/proposal-normalize.js");
      const reversed = normalizeProposalChanges({
        runId: f.runId,
        baseRefs: baseRefs.map((ref) => ({ runId: f.runId, kind: ref.kind as never, id: ref.id, revision: ref.revision })),
        changes: [
          { op: "REOPEN_SECTION", sectionId: a, compactProjection: `reopen:${a}` },
          {
            op: "SET_SECTION_REVISION",
            target: { id: a, revision: 1 },
            content: rawSection("A v2").content,
            compactProjection: "section:A@2",
          },
          { op: "COMPLETE_SECTION", sectionId: a, compactProjection: `complete:${a}@2` },
        ] as never,
      });
      expect(reversed.changes.map((change) => change.op)).toEqual(order);
      commitPrepared(f, atomic.proposal.proposalId, atomic.proposal.revision, atomic.proposal.proposalHash);
      const state = workflowStatesOf(f).find((s) => s.sectionId === a)!;
      expect(state.status).toBe("completed");
      expect(state.completedRevision).toBe(2);
    } finally {
      f.close();
    }
  });

  it("Synthesis exposes no prepare capability (§53)", async () => {
    const f = await makeDetailFixture();
    try {
      const { sectionIds } = commitSectionDag(f, [{ title: "A" }]);
      const a = sectionIds[0]!;
      selectOnFixture(f, a);
      const completion = f.proposals.prepareProposal({
        runId: f.runId,
        workspaceId: f.workspaceId,
        sessionId: f.sessionId,
        bindingGeneration: f.generation,
        expectedRunRevision: f.runRevision,
        type: "section_completion",
        scope: { kind: "section", sectionId: a },
        title: "Complete A",
        summary: "final",
        changes: [{ op: "COMPLETE_SECTION", sectionId: a, compactProjection: `complete:${a}` }],
      });
      commitPrepared(f, completion.proposal.proposalId, completion.proposal.revision, completion.proposal.proposalHash);
      expect(runStageOf(f).stage).toBe("synthesis");
      expect(() =>
        f.proposals.prepareProposal({
          runId: f.runId,
          workspaceId: f.workspaceId,
          sessionId: f.sessionId,
          bindingGeneration: f.generation,
          expectedRunRevision: f.runRevision,
          type: "design_checkpoint",
          scope: { kind: "detail" },
          title: "Late change",
          summary: "must fail",
          changes: [],
        }),
      ).toThrowError(expect.objectContaining({ code: "CAPABILITY_NOT_AVAILABLE" }));
    } finally {
      f.close();
    }
  });

  it("section removal has no capability and never silently drops from a snapshot (§57)", async () => {
    const f = await makeDetailFixture();
    try {
      const { sectionIds } = commitSectionDag(f, [{ title: "A" }]);
      expect(() =>
        f.proposals.prepareProposal({
          runId: f.runId,
          workspaceId: f.workspaceId,
          sessionId: f.sessionId,
          bindingGeneration: f.generation,
          expectedRunRevision: f.runRevision,
          type: "design_checkpoint",
          scope: { kind: "detail" },
          title: "Remove section",
          summary: "no retire semantics exist",
          changes: [{ op: "DELETE_SECTION", sectionId: sectionIds[0]!, compactProjection: "remove" } as never],
        }),
      ).toThrowError();
      // The Section is still in HEAD and its workflow state is intact.
      expect(workflowStatesOf(f)).toHaveLength(1);
    } finally {
      f.close();
    }
  });
});

