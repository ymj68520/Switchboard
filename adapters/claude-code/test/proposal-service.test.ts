import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
  closeFixture,
  DECISION_1,
  makeProposalFixture,
  makeTestUserAuthorization,
  memoryCounts,
  prepareCheckpoint,
 
} from "./proposal-helpers.js";
import { createInternalPlanMemoryWriter } from "../src/store/plan-memory.js";
import { initializePlanStore } from "../src/store/sqlite-store.js";
import { removeTempPluginDataRoot, makeTempPluginDataRoot, fixedClock } from "./store-helpers.js";


describe("prepareProposal (§8/§16/§17/§80–§83)", () => {
  it("freezes an awaiting proposal, generates server ids, binds exact base — and writes NO committed memory", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const fixture = await makeProposalFixture(root);
      try {
        const before = memoryCounts(fixture.store);
        expect(before).toEqual({ artifacts: 0, revisions: 0, snapshots: 0, heads: 0, commits: 0, approvals: 0 });

        const prepared = prepareCheckpoint(fixture, [{ op: "ADD_DECISION", content: DECISION_1, compactProjection: "DEC-1" }]);
        expect(prepared.proposal.status).toBe("awaiting_approval");
        expect(prepared.proposal.proposalId).toMatch(/^PROP-/);
        expect(prepared.proposal.proposalHash).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(prepared.proposal.baseHeadSnapshotId).toBeNull();
        expect(prepared.proposal.baseHeadCommitId).toBeNull();
        expect(prepared.proposal.baseRunRevision).toBe(fixture.runRevision);
        // Server-derived id/revision: the model never chose them.
        expect(prepared.proposal.changes[0]).toMatchObject({ artifactId: "DEC-1", result: { revision: 1 } });
        // Candidate simulation is returned for presentation (§17).
        expect(prepared.candidateRefs).toEqual([
          { runId: fixture.runId, kind: "decision", id: "DEC-1", revision: 1 },
        ]);

        const after = memoryCounts(fixture.store);
        expect(after).toEqual(before); // E9: zero committed mutation
        const audit = fixture.store.withRead((tx) =>
          tx.prepare("SELECT count(*) AS n FROM audit_events WHERE event_type = 'PROPOSAL_PREPARED'").get(),
        ) as { n: number };
        expect(audit.n).toBe(1);
      } finally {
        closeFixture(fixture);
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("requires exact ownership fencing and run revision (§81), and never increments it (§82)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const fixture = await makeProposalFixture(root);
      try {
        expect(() =>
          prepareCheckpoint(fixture, [{ op: "ADD_DECISION", content: DECISION_1, compactProjection: "a" }], { bindingGeneration: fixture.generation + 5 }),
        ).toThrowError(expect.objectContaining({ code: "STALE_SESSION_BINDING" }));
        expect(() =>
          prepareCheckpoint(fixture, [{ op: "ADD_DECISION", content: DECISION_1, compactProjection: "a" }], { expectedRunRevision: fixture.runRevision - 1 }),
        ).toThrowError(expect.objectContaining({ code: "STALE_RUN_REVISION" }));
        expect(() =>
          prepareCheckpoint(fixture, [{ op: "ADD_DECISION", content: DECISION_1, compactProjection: "a" }], { sessionId: "S2" }),
        ).toThrowError(expect.objectContaining({ code: "STALE_SESSION_BINDING" }));
        expect(fixture.runs.getPlanningRun(fixture.runId)?.revision).toBe(fixture.runRevision);
      } finally {
        closeFixture(fixture);
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("enforces proposal-type availability and stage/scope capability (§11/§56/§80)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const fixture = await makeProposalFixture(root);
      try {
        expect(() =>
          prepareCheckpoint(fixture, [], { type: "section_completion" }),
        ).toThrowError(expect.objectContaining({ code: "PROPOSAL_TYPE_UNAVAILABLE" }));
        expect(() =>
          prepareCheckpoint(fixture, [], { type: "final_plan" }),
        ).toThrowError(expect.objectContaining({ code: "PROPOSAL_TYPE_UNAVAILABLE" }));
        expect(() =>
          prepareCheckpoint(fixture, [], { scope: { kind: "section", sectionId: "SEC-1" } }),
        ).toThrowError(expect.objectContaining({ code: "PROPOSAL_INVALID" }));
        expect(() =>
          prepareCheckpoint(fixture, [], { type: "architecture_completion" }),
        ).not.toThrow();
        // E29: the engine also refuses unavailable types outright.
        expect(() =>
          fixture.engine.commitAuthorizedProposal({
            runId: fixture.runId,
            workspaceId: fixture.workspaceId,
            sessionId: fixture.sessionId,
            bindingGeneration: fixture.generation,
            authorization: makeTestUserAuthorization({ proposalId: "PROP-ghost", proposalRevision: 1, proposalHash: "sha256:0" }),
          }),
        ).toThrowError(expect.objectContaining({ code: "PROPOSAL_NOT_FOUND" }));
      } finally {
        closeFixture(fixture);
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("one awaiting proposal per run; retry with the same prepareRequestId returns the same proposal (§10/§83)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const fixture = await makeProposalFixture(root);
      try {
        prepareCheckpoint(fixture, [{ op: "ADD_DECISION", content: DECISION_1, compactProjection: "a" }]);
        expect(() =>
          prepareCheckpoint(fixture, [{ op: "ADD_DECISION", content: DECISION_1, compactProjection: "b" }]),
        ).toThrowError(expect.objectContaining({ code: "PROPOSAL_ALREADY_AWAITING" }));

        // One-awaiting-per-run on a second run of the same store fixture.
        const secondRun = fixture.runs.createPlanningRun({
          workspaceId: fixture.workspaceId,
          sessionId: "S2",
          goal: "second run",
        });
        const transitioned = fixture.runs.transitionRun({
          runId: secondRun.run.runId,
          workspaceId: fixture.workspaceId,
          sessionId: "S2",
          bindingGeneration: secondRun.binding.generation,
          expectedRevision: secondRun.run.revision,
          event: "DISCOVERY_COMPLETE",
        });
        const input = {
          runId: secondRun.run.runId,
          workspaceId: fixture.workspaceId,
          sessionId: "S2",
          bindingGeneration: secondRun.binding.generation,
          expectedRunRevision: transitioned.revision,
          type: "design_checkpoint" as const,
          scope: { kind: "architecture" as const },
          title: "Retry",
          summary: "same",
          changes: [
            {
              op: "ADD_DECISION" as const,
              content: DECISION_1,
              compactProjection: "a",
            },
          ],
        };
        const first = fixture.proposals.prepareProposal({ ...input, prepareRequestId: "PREP-1" });
        const retry = fixture.proposals.prepareProposal({ ...input, prepareRequestId: "PREP-1" });
        expect(retry.proposal.proposalId).toBe(first.proposal.proposalId);
        expect(retry.proposal.revision).toBe(first.proposal.revision);
        expect(retry.proposal.proposalHash).toBe(first.proposal.proposalHash);
        expect(() =>
          fixture.proposals.prepareProposal({ ...input, title: "Different", prepareRequestId: "PREP-1" }),
        ).toThrowError(expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }));
      } finally {
        closeFixture(fixture);
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("rejectProposal flips state only; legacy uncommitted HEAD fails closed (§19/§28)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const fixture = await makeProposalFixture(root);
      try {
        const prepared = prepareCheckpoint(fixture, [{ op: "ADD_DECISION", content: DECISION_1, compactProjection: "a" }]);
        const before = memoryCounts(fixture.store);
        const rejected = fixture.proposals.rejectProposal({
          runId: fixture.runId,
          workspaceId: fixture.workspaceId,
          sessionId: fixture.sessionId,
          bindingGeneration: fixture.generation,
          proposalId: prepared.proposal.proposalId,
        });
        expect(rejected.status).toBe("rejected");
        expect(memoryCounts(fixture.store)).toEqual(before);
        // No production reject tool exists; the future MCP layer calls this.
        expect(() =>
          fixture.proposals.rejectProposal({
            runId: fixture.runId,
            workspaceId: fixture.workspaceId,
            sessionId: fixture.sessionId,
            bindingGeneration: fixture.generation,
            proposalId: prepared.proposal.proposalId,
          }),
        ).toThrowError(expect.objectContaining({ code: "PROPOSAL_NOT_AWAITING_APPROVAL" }));
      } finally {
        closeFixture(fixture);
      }

      // Legacy snapshot-only HEAD (Phase 5 internal shape): fail closed on
      // prepare (MEMORY_HEAD_UNCOMMITTED, §19).
      const root2 = makeTempPluginDataRoot();
      try {
        const fixture2 = await makeProposalFixture(root2);
        try {
          const memory = createInternalPlanMemoryWriter(fixture2.store, fixedClock({ ids: ["snap0"] }));
          memory.insertArtifactIdentity({ runId: fixture2.runId, kind: "decision", artifactId: "DEC-1" });
          memory.insertMemoryRevision({
            runId: fixture2.runId,
            kind: "decision",
            artifactId: "DEC-1",
            content: DECISION_1,
            compactProjection: "DEC-1",
          });
          const snapshot = memory.insertSnapshot({
            runId: fixture2.runId,
            refs: [{ runId: fixture2.runId, kind: "decision", id: "DEC-1", revision: 1 }],
          });
          memory.setHeadSnapshot({ runId: fixture2.runId, expectedHeadSnapshotId: null, nextSnapshotId: snapshot.snapshotId });
          // The Phase 5 primitive leaves head_commit_id NULL — the legacy shape.
          expect(() =>
            prepareCheckpoint(fixture2, [{ op: "ADD_DECISION", content: DECISION_1, compactProjection: "a" }]),
          ).toThrowError(expect.objectContaining({ code: "MEMORY_HEAD_UNCOMMITTED" }));
        } finally {
          closeFixture(fixture2);
        }
      } finally {
        removeTempPluginDataRoot(root2);
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("reviseProposal supersedes @N and freezes @N+1 in one transaction; old approval is refused (§26/§27/§94)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const fixture = await makeProposalFixture(root);
      try {
        const first = prepareCheckpoint(fixture, [{ op: "ADD_DECISION", content: DECISION_1, compactProjection: "v1" }]);
        const second = fixture.proposals.reviseProposal({
          runId: fixture.runId,
          workspaceId: fixture.workspaceId,
          sessionId: fixture.sessionId,
          bindingGeneration: fixture.generation,
          expectedRunRevision: fixture.runRevision,
          type: "design_checkpoint",
          scope: { kind: "architecture" },
          title: "v2",
          summary: "revised",
          changes: [{ op: "ADD_DECISION", content: { ...DECISION_1, title: "Use SQLite WAL v2" }, compactProjection: "v2" }],
          proposalId: first.proposal.proposalId,
        });
        expect(second.proposal.revision).toBe(2);
        expect(second.proposal.status).toBe("awaiting_approval");
        const firstStatus = fixture.proposals.getProposal(first.proposal.proposalId, 1)?.status;
        expect(firstStatus).toBe("superseded");
        expect(fixture.proposals.getAwaitingProposal(fixture.runId)?.revision).toBe(2);

        // Authorizing the superseded @1 fails even with the correct hash (§27).
        expect(() =>
          fixture.engine.commitAuthorizedProposal({
            runId: fixture.runId,
            workspaceId: fixture.workspaceId,
            sessionId: fixture.sessionId,
            bindingGeneration: fixture.generation,
            authorization: makeTestUserAuthorization({
              proposalId: first.proposal.proposalId,
              proposalRevision: 1,
              proposalHash: first.proposal.proposalHash,
            }),
          }),
        ).toThrowError(expect.objectContaining({ code: "PROPOSAL_SUPERSEDED" }));

        // @2 commits the @2 bytes.
        const result = fixture.engine.commitAuthorizedProposal({
          runId: fixture.runId,
          workspaceId: fixture.workspaceId,
          sessionId: fixture.sessionId,
          bindingGeneration: fixture.generation,
          authorization: makeTestUserAuthorization({
            proposalId: second.proposal.proposalId,
            proposalRevision: 2,
            proposalHash: second.proposal.proposalHash,
          }),
        });
        expect(result.idempotent).toBe(false);
        const committed = fixture.store.withRead((tx) =>
          tx.prepare("SELECT json_extract(content_json, '$.title') AS title FROM memory_revisions WHERE kind = 'decision' AND artifact_id = 'DEC-1' AND revision = 1").get(),
        ) as { title: string };
        expect(committed.title).toBe("Use SQLite WAL v2");
      } finally {
        closeFixture(fixture);
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });
});

describe("proposal read API (§72/§73)", () => {
  it("getProposal/getAwaitingProposal/listProposalRevisions return frozen content + hash + status", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const fixture = await makeProposalFixture(root);
      try {
        const first = prepareCheckpoint(fixture, [{ op: "ADD_DECISION", content: DECISION_1, compactProjection: "v1" }]);
        fixture.proposals.reviseProposal({
          runId: fixture.runId,
          workspaceId: fixture.workspaceId,
          sessionId: fixture.sessionId,
          bindingGeneration: fixture.generation,
          expectedRunRevision: fixture.runRevision,
          type: "design_checkpoint",
          scope: { kind: "architecture" },
          title: "v2",
          summary: "revised",
          changes: [{ op: "ADD_DECISION", content: DECISION_1, compactProjection: "v2" }],
          proposalId: first.proposal.proposalId,
        });

        const view = fixture.proposals.getProposal(first.proposal.proposalId, 2);
        expect(view?.status).toBe("awaiting_approval");
        expect(view?.type).toBe("design_checkpoint");
        expect(view?.changes).toHaveLength(1);
        expect(view?.canonicalJson).toContain('"schema":"phase-plan.proposal"');

        expect(fixture.proposals.getProposal(first.proposal.proposalId, 9)).toBeNull();
        expect(fixture.proposals.getAwaitingProposal(fixture.runId)?.revision).toBe(2);
        const revisions = fixture.proposals.listProposalRevisions(first.proposal.proposalId);
        expect(revisions.map((r) => [r.revision, r.status])).toEqual([
          [1, "superseded"],
          [2, "awaiting_approval"],
        ]);
      } finally {
        closeFixture(fixture);
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });
});

void fs;
void path;
void initializePlanStore;
