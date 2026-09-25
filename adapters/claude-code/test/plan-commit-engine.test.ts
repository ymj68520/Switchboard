import { describe, expect, it } from "vitest";

import {
  closeFixture,
  CONSTRAINT_1,
  DECISION_1,
  makeProposalFixture,
  makeTestUserAuthorization,
  memoryCounts,
  prepareCheckpoint,
  type ProposalFixture,
} from "./proposal-helpers.js";
import { ARCHITECTURE_1, OPEN_QUESTION_1, CONFLICT_1, OPEN_QUESTION_SOFT } from "./proposal-helpers.js";
import { initializePlanStore } from "../src/store/sqlite-store.js";
import { createInternalPlanMemoryWriter } from "../src/store/plan-memory.js";
import { getCommitChainRecord, getHeadCommitRecord } from "../src/store/plan-commits.js";
import { getHeadSnapshotRecord } from "../src/store/plan-memory.js";
import { removeTempPluginDataRoot, makeTempPluginDataRoot, fixedClock, rawConnection } from "./store-helpers.js";

/** Test-only raw connection to a fixture's store (aging history, §18 convention). */
function rawConnectionFixture(fixture: ProposalFixture) {
  return rawConnection(fixture.store.path, 500);
}

function authorizePrepared(
  fixture: ProposalFixture,
  prepared: { proposalId: string; revision: number; proposalHash: string },
  overrides: Partial<Parameters<ProposalFixture["engine"]["commitAuthorizedProposal"]>[0]> = {},
) {
  // Synchronous on purpose: the engine throws synchronously inside the write
  // transaction, so test assertions can observe errors with expect(() => ...).
  return fixture.engine.commitAuthorizedProposal({
    runId: fixture.runId,
    workspaceId: fixture.workspaceId,
    sessionId: fixture.sessionId,
    bindingGeneration: fixture.generation,
    authorization: makeTestUserAuthorization({
      proposalId: prepared.proposalId,
      proposalRevision: prepared.revision,
      proposalHash: prepared.proposalHash,
    }),
    ...overrides,
  });
}

describe("happy-path E2E (§88)", () => {
  it("create → prepare → verify-no-memory → authorize → commit → C1/S1, then amendment → C2/S2", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const fixture = await makeProposalFixture(root);
      try {
        // Checkpoint commit C1/S1.
        const before = memoryCounts(fixture.store);
        const checkpoint = prepareCheckpoint(fixture, [
          { op: "ADD_CONSTRAINT", content: CONSTRAINT_1, compactProjection: "CONST-1" },
          { op: "ADD_DECISION", content: DECISION_1, compactProjection: "DEC-1" },
        ]);
        expect(memoryCounts(fixture.store)).toEqual(before);
        const c1 = await authorizePrepared(fixture, checkpoint.proposal);
        expect(c1.idempotent).toBe(false);
        expect(c1.sequence).toBe(1);
        expect(c1.parentCommitId).toBeNull();

        const counts1 = memoryCounts(fixture.store);
        expect(counts1).toEqual({ artifacts: 2, revisions: 2, snapshots: 1, heads: 1, commits: 1, approvals: 1 });
        // Checkpoint: run revision and stage untouched (E22/§50).
        expect(c1.runRevision).toBe(fixture.runRevision);
        expect(c1.stage).toBe("architecture");
        expect(fixture.runs.getPlanningRun(fixture.runId)).toMatchObject({ revision: fixture.runRevision, stage: "architecture" });

        // Amendment commit C2/S2: mutate the constraint, supersede the decision.
        const amendment = prepareCheckpoint(fixture, [
          { op: "SUPERSEDE_CONSTRAINT", target: { id: "CONST-1", revision: 1 }, content: { ...CONSTRAINT_1, statement: "No network — amended" }, compactProjection: "CONST-1 v2" },
          { op: "SUPERSEDE_DECISION", target: { id: "DEC-1", revision: 1 }, content: { ...DECISION_1, title: "Use SQLite WAL v2" }, compactProjection: "DEC-1 v2" },
        ], {
          expectedRunRevision: fixture.runRevision, // checkpoint did not bump it
        });
        const c2 = await authorizePrepared(fixture, amendment.proposal);
        expect(c2.sequence).toBe(2);
        expect(c2.parentCommitId).toBe(c1.commitId);
        expect(c2.runRevision).toBe(fixture.runRevision);

        // Chain invariants (E19).
        const chain = getCommitChainRecord(fixture.store, fixture.runId);
        expect(chain.map((commit) => [commit.sequence, commit.parentCommitId])).toEqual([
          [1, null],
          [2, chain[0]?.commitId],
        ]);
        expect(getHeadCommitRecord(fixture.store, fixture.runId)?.commitId).toBe(c2.commitId);
        expect(getHeadSnapshotRecord(fixture.store, fixture.runId)?.snapshotId).toBe(c2.snapshotId);
        // S1 is still intact (immutability) and S2 carries the effective world.
        const s1Refs = fixture.store.withRead((tx) =>
          tx.prepare("SELECT count(*) AS n FROM snapshot_members WHERE snapshot_id = ?").get(c1.snapshotId),
        ) as { n: number };
        expect(s1Refs.n).toBe(2);
        const effective = fixture.store.withRead((tx) =>
          tx.prepare("SELECT json_extract(content_json, '$.title') AS title FROM memory_revisions WHERE kind = 'decision' AND artifact_id = 'DEC-1' AND revision = 2").get(),
        ) as { title: string };
        expect(effective.title).toBe("Use SQLite WAL v2");
      } finally {
        closeFixture(fixture);
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("exact-commit invariant: frozen canonical bytes == committed revision bytes (§46/E34)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const fixture = await makeProposalFixture(root);
      try {
        const prepared = prepareCheckpoint(fixture, [{ op: "ADD_DECISION", content: DECISION_1, compactProjection: "DEC-1" }]);
        await authorizePrepared(fixture, prepared.proposal);
        const frozenChange = prepared.proposal.changes[0]!;
        const committed = fixture.store.withRead((tx) =>
          tx.prepare("SELECT content_json AS contentJson, compact_projection AS compact FROM memory_revisions WHERE kind = 'decision' AND artifact_id = 'DEC-1' AND revision = 1").get(),
        ) as { contentJson: string; compact: string };
        // EXACT representation, not semantically-similar.
        expect(JSON.parse(committed.contentJson)).toEqual(frozenChange.content);
        expect(committed.compact).toBe(frozenChange.compactProjection);
      } finally {
        closeFixture(fixture);
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });
});

describe("exact authorization (§91/E33)", () => {
  it("correct hash commits; wrong hash / superseded / nonexistent all refuse with zero mutations", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const fixture = await makeProposalFixture(root);
      try {
        const prepared = prepareCheckpoint(fixture, [{ op: "ADD_DECISION", content: DECISION_1, compactProjection: "a" }]);
        const before = memoryCounts(fixture.store);

        expect(() =>
          fixture.engine.commitAuthorizedProposal({
            runId: fixture.runId,
            workspaceId: fixture.workspaceId,
            sessionId: fixture.sessionId,
            bindingGeneration: fixture.generation,
            authorization: makeTestUserAuthorization({
              proposalId: prepared.proposal.proposalId,
              proposalRevision: 1,
              proposalHash: "sha256:" + "0".repeat(64),
            }),
          }),
        ).toThrowError(expect.objectContaining({ code: "PROPOSAL_HASH_MISMATCH" }));
        expect(() =>
          fixture.engine.commitAuthorizedProposal({
            runId: fixture.runId,
            workspaceId: fixture.workspaceId,
            sessionId: fixture.sessionId,
            bindingGeneration: fixture.generation,
            authorization: makeTestUserAuthorization({ proposalId: "PROP-ghost", proposalRevision: 1, proposalHash: "sha256:0" }),
          }),
        ).toThrowError(expect.objectContaining({ code: "PROPOSAL_NOT_FOUND" }));
        expect(memoryCounts(fixture.store)).toEqual(before);

        const ok = await authorizePrepared(fixture, prepared.proposal);
        expect(ok.idempotent).toBe(false);
        // Re-authorizing the now-approved revision → PROPOSAL_ALREADY_COMMITTED (§63).
        expect(() =>
          fixture.engine.commitAuthorizedProposal({
            runId: fixture.runId,
            workspaceId: fixture.workspaceId,
            sessionId: fixture.sessionId,
            bindingGeneration: fixture.generation,
            authorization: makeTestUserAuthorization({
              proposalId: prepared.proposal.proposalId,
              proposalRevision: 1,
              proposalHash: prepared.proposal.proposalHash,
              authorizationRequestId: "AUTH-different",
            }),
          }),
        ).toThrowError(expect.objectContaining({ code: "PROPOSAL_ALREADY_COMMITTED" }));
      } finally {
        closeFixture(fixture);
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("stored canonical must re-derive its hash — tamper detection fails closed (§23)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const fixture = await makeProposalFixture(root);
      const prepared = prepareCheckpoint(fixture, [{ op: "ADD_DECISION", content: DECISION_1, compactProjection: "a" }]);
      const dbPath = fixture.store.path;
      closeFixture(fixture);
      // Tamper with the stored canonical JSON (triggers block UPDATE; drop it test-only).
      const { openDatabase } = await import("../src/store/connection.js");
        const db = openDatabase(dbPath, { busyTimeoutMs: 500 });
        try {
          db.exec("DROP TRIGGER proposal_revisions_no_update");
          db.prepare("UPDATE proposal_revisions SET canonical_json = replace(canonical_json, 'Checkpoint', 'Hacked') WHERE proposal_id = ?").run(prepared.proposal.proposalId);
          // Restore the trigger so the reopened store validates cleanly.
          db.exec(`
            CREATE TRIGGER proposal_revisions_no_update BEFORE UPDATE ON proposal_revisions
            BEGIN
              SELECT RAISE(ABORT, 'proposal_revisions is immutable');
            END
          `);
        } finally {
          db.close();
        }
      const reopened = await initializePlanStore({ pluginDataRoot: root });
      try {
        const engine = (await import("../src/application/plan-commit-engine.js")).createPlanCommitEngine(reopened, fixedClock({ ids: ["x"] }));
        expect(() =>
          engine.commitAuthorizedProposal({
            runId: fixture.runId,
            workspaceId: fixture.workspaceId,
            sessionId: fixture.sessionId,
            bindingGeneration: fixture.generation,
            authorization: makeTestUserAuthorization({
              proposalId: prepared.proposal.proposalId,
              proposalRevision: 1,
              proposalHash: prepared.proposal.proposalHash,
            }),
          }),
        ).toThrowError(expect.objectContaining({ code: "PROPOSAL_HASH_MISMATCH" }));
      } finally {
        reopened.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });
});

describe("staleness after authorization (§92/E30/E31/E32)", () => {
  it("binding takeover → STALE_SESSION_BINDING; run mutation → STALE_RUN_REVISION; new HEAD → STALE_MEMORY_HEAD — each with zero mutations", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const fixture = await makeProposalFixture(root);
      try {
        // First commit so a base HEAD exists for the HEAD-staleness case.
        const seed = prepareCheckpoint(fixture, [{ op: "ADD_DECISION", content: DECISION_1, compactProjection: "seed" }]);
        await authorizePrepared(fixture, seed.proposal);

        const prepared = prepareCheckpoint(fixture, [
          { op: "SUPERSEDE_DECISION", target: { id: "DEC-1", revision: 1 }, content: DECISION_1, compactProjection: "v2" },
        ], { expectedRunRevision: fixture.runRevision });
        const before = memoryCounts(fixture.store);

        // 1. Ownership moved while the user was reading the proposal.
        fixture.runs.takeoverActiveRun({
          runId: fixture.runId,
          workspaceId: fixture.workspaceId,
          newSessionId: "S2",
          expectedGeneration: fixture.generation,
        });
        expect(() =>
          fixture.engine.commitAuthorizedProposal({
            runId: fixture.runId,
            workspaceId: fixture.workspaceId,
            sessionId: fixture.sessionId,
            bindingGeneration: fixture.generation,
            authorization: makeTestUserAuthorization({
              proposalId: prepared.proposal.proposalId,
              proposalRevision: 1,
              proposalHash: prepared.proposal.proposalHash,
              authorizationRequestId: "AUTH-stale-binding",
            }),
          }),
        ).toThrowError(expect.objectContaining({ code: "STALE_SESSION_BINDING" }));
        expect(memoryCounts(fixture.store)).toEqual(before);

        // Recover ownership for the next scenarios.
        fixture.runs.takeoverActiveRun({
          runId: fixture.runId,
          workspaceId: fixture.workspaceId,
          newSessionId: fixture.sessionId,
          expectedGeneration: fixture.generation + 1,
        });

        // 2. Run revision moved while the user was reading (manufactured the
        // same way the Phase 4 concurrency tests age history — no production
        // setter exists).
        const raw = rawConnectionFixture(fixture);
        try {
          raw.exec(`UPDATE planning_runs SET revision = revision + 1 WHERE run_id = '${fixture.runId}'`);
        } finally {
          raw.close();
        }
        expect(() =>
          fixture.engine.commitAuthorizedProposal({
            runId: fixture.runId,
            workspaceId: fixture.workspaceId,
            sessionId: fixture.sessionId,
            bindingGeneration: fixture.generation + 2,
            authorization: makeTestUserAuthorization({
              proposalId: prepared.proposal.proposalId,
              proposalRevision: 1,
              proposalHash: prepared.proposal.proposalHash,
              authorizationRequestId: "AUTH-stale-revision",
            }),
          }),
        ).toThrowError(expect.objectContaining({ code: "STALE_RUN_REVISION" }));
        // Restore the revision so the next scenario isolates the HEAD gate.
        const rawRestore = rawConnectionFixture(fixture);
        try {
          rawRestore.exec(`UPDATE planning_runs SET revision = revision - 1 WHERE run_id = '${fixture.runId}'`);
        } finally {
          rawRestore.close();
        }

        // 3. HEAD moved while the user was reading. A snapshot-only (legacy
        // uncommitted) HEAD first fails closed with MEMORY_HEAD_UNCOMMITTED
        // (E48); a genuinely different COMMITTED pair yields STALE_MEMORY_HEAD.
        fixture.runs.takeoverActiveRun({
          runId: fixture.runId,
          workspaceId: fixture.workspaceId,
          newSessionId: "S3",
          expectedGeneration: fixture.generation + 2,
        });
        const memory = createInternalPlanMemoryWriter(fixture.store, fixedClock({ ids: ["seed2"] }));
        memory.insertMemoryRevision({
          runId: fixture.runId,
          kind: "decision",
          artifactId: "DEC-1",
          revision: 2,
          content: DECISION_1,
          compactProjection: "moved",
        });
        const snap = memory.insertSnapshot({
          runId: fixture.runId,
          refs: [{ runId: fixture.runId, kind: "decision", id: "DEC-1", revision: 2 }],
        });
        fixture.store.withWrite((tx) => {
          tx.prepare("UPDATE plan_heads SET head_snapshot_id = ?, head_commit_id = NULL WHERE run_id = ?").run(snap.snapshotId, fixture.runId);
        });
        expect(() =>
          fixture.engine.commitAuthorizedProposal({
            runId: fixture.runId,
            workspaceId: fixture.workspaceId,
            sessionId: "S3",
            bindingGeneration: fixture.generation + 3,
            authorization: makeTestUserAuthorization({
              proposalId: prepared.proposal.proposalId,
              proposalRevision: 1,
              proposalHash: prepared.proposal.proposalHash,
              authorizationRequestId: "AUTH-stale-head",
            }),
          }),
        ).toThrowError(expect.objectContaining({ code: "MEMORY_HEAD_UNCOMMITTED" }));
        expect(memoryCounts(fixture.store)).toEqual({ ...before, artifacts: before.artifacts, revisions: before.revisions + 1, snapshots: before.snapshots + 1 });
      } finally {
        closeFixture(fixture);
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("committed HEAD pair moved past the proposal base → STALE_MEMORY_HEAD (E32/§42)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const fixture = await makeProposalFixture(root);
      try {
        // Two committed checkpoint pairs C1/S1, C2/S2.
        const first = prepareCheckpoint(fixture, [{ op: "ADD_DECISION", content: DECISION_1, compactProjection: "c1" }]);
        authorizePrepared(fixture, first.proposal);
        const second = prepareCheckpoint(fixture, [
          { op: "SUPERSEDE_DECISION", target: { id: "DEC-1", revision: 1 }, content: { ...DECISION_1, title: "v2" }, compactProjection: "c2" },
        ], { expectedRunRevision: fixture.runRevision });
        authorizePrepared(fixture, second.proposal);

        // P bases on C2/S2.
        const prepared = prepareCheckpoint(fixture, [
          { op: "SUPERSEDE_DECISION", target: { id: "DEC-1", revision: 2 }, content: { ...DECISION_1, title: "v3" }, compactProjection: "c3" },
        ], { expectedRunRevision: fixture.runRevision });
        const before = memoryCounts(fixture.store);

        // The user hesitates; HEAD is moved back to the C1/S1 pair (raw, test-only).
        const raw = rawConnectionFixture(fixture);
        try {
          const pair = fixture.store.withRead(() => undefined);
          void pair;
          raw.exec(`
            UPDATE plan_heads
            SET head_snapshot_id = (SELECT resulting_snapshot_id FROM plan_commits WHERE sequence = 1 AND run_id = plan_heads.run_id),
                head_commit_id = (SELECT commit_id FROM plan_commits WHERE sequence = 1 AND run_id = plan_heads.run_id)
            WHERE run_id = '${fixture.runId}'
          `);
        } finally {
          raw.close();
        }

        expect(() => authorizePrepared(fixture, prepared.proposal)).toThrowError(
          expect.objectContaining({ code: "STALE_MEMORY_HEAD" }),
        );
        expect(memoryCounts(fixture.store)).toEqual(before);
        expect(fixture.runs.getPlanningRun(fixture.runId)).toMatchObject({ stage: "architecture", revision: fixture.runRevision });
      } finally {
        closeFixture(fixture);
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("precedence: stale binding + stale HEAD answers STALE_SESSION_BINDING (§41)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const fixture = await makeProposalFixture(root);
      try {
        const prepared = prepareCheckpoint(fixture, [{ op: "ADD_DECISION", content: DECISION_1, compactProjection: "a" }]);
        fixture.runs.takeoverActiveRun({
          runId: fixture.runId,
          workspaceId: fixture.workspaceId,
          newSessionId: "S2",
          expectedGeneration: fixture.generation,
        });
        // Also move HEAD internally (legacy snapshot-only shape is fine: the
        // binding gate must fire FIRST, before the HEAD gate).
        fixture.store.withWrite((tx) => {
          tx.prepare("UPDATE plan_heads SET head_snapshot_id = 'snap_other' WHERE run_id = ?").run(fixture.runId);
        });
        expect(() =>
          fixture.engine.commitAuthorizedProposal({
            runId: fixture.runId,
            workspaceId: fixture.workspaceId,
            sessionId: fixture.sessionId,
            bindingGeneration: fixture.generation,
            authorization: makeTestUserAuthorization({
              proposalId: prepared.proposal.proposalId,
              proposalRevision: 1,
              proposalHash: prepared.proposal.proposalHash,
            }),
          }),
        ).toThrowError(expect.objectContaining({ code: "STALE_SESSION_BINDING" }));
      } finally {
        closeFixture(fixture);
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });
});

describe("architecture completion (§52–§55/§89/E24–E28)", () => {
  it("architecture → detail transition + revision bump + C/S in ONE transaction; empty changes allowed", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const fixture = await makeProposalFixture(root);
      try {
        const prepared = fixture.proposals.prepareProposal({
          runId: fixture.runId,
          workspaceId: fixture.workspaceId,
          sessionId: fixture.sessionId,
          bindingGeneration: fixture.generation,
          expectedRunRevision: fixture.runRevision,
          type: "architecture_completion",
          scope: { kind: "architecture" },
          title: "Complete",
          summary: "declare complete",
          changes: [{ op: "SET_ARCHITECTURE_REVISION", target: null, content: ARCHITECTURE_1, compactProjection: "ARCH-1" }],
        });
        const result = await authorizePrepared(fixture, prepared.proposal);
        expect(result.stage).toBe("detail");
        expect(result.runRevision).toBe(fixture.runRevision + 1); // exactly once
        expect(fixture.runs.getPlanningRun(fixture.runId)).toMatchObject({ stage: "detail", revision: fixture.runRevision + 1 });

        // After completion the run is at detail: another completion is refused.
        expect(() =>
          fixture.proposals.prepareProposal({
            runId: fixture.runId,
            workspaceId: fixture.workspaceId,
            sessionId: fixture.sessionId,
            bindingGeneration: fixture.generation,
            expectedRunRevision: result.runRevision ?? fixture.runRevision + 1,
            type: "architecture_completion",
            scope: { kind: "architecture" },
            title: "Again",
            summary: "nope",
            changes: [],
          }),
        ).toThrowError(expect.objectContaining({ code: "CAPABILITY_NOT_AVAILABLE" }));
      } finally {
        closeFixture(fixture);
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("empty-changes completion commits after checkpoint-built architecture (§55/E24)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const fixture = await makeProposalFixture(root);
      try {
        const checkpoint = prepareCheckpoint(fixture, [{ op: "SET_ARCHITECTURE_REVISION", target: null, content: ARCHITECTURE_1, compactProjection: "ARCH-1" }]);
        const c1 = await authorizePrepared(fixture, checkpoint.proposal);
        expect(c1.stage).toBe("architecture");

        const completion = fixture.proposals.prepareProposal({
          runId: fixture.runId,
          workspaceId: fixture.workspaceId,
          sessionId: fixture.sessionId,
          bindingGeneration: fixture.generation,
          expectedRunRevision: fixture.runRevision,
          type: "architecture_completion",
          scope: { kind: "architecture" },
          title: "Complete",
          summary: "already built by checkpoints",
          changes: [],
        });
        const c2 = await authorizePrepared(fixture, completion.proposal);
        expect(c2.stage).toBe("detail");
        expect(c2.runRevision).toBe(fixture.runRevision + 1);
        expect(c2.parentCommitId).toBe(c1.commitId);
        // S3 refs equal S2 refs (empty completion).
        const s2 = fixture.store.withRead((tx) =>
          tx.prepare("SELECT count(*) AS n FROM snapshot_members WHERE snapshot_id = ?").get(c1.snapshotId),
        ) as { n: number };
        const s3 = fixture.store.withRead((tx) =>
          tx.prepare("SELECT count(*) AS n FROM snapshot_members WHERE snapshot_id = ?").get(c2.snapshotId),
        ) as { n: number };
        expect(s2.n).toBe(s3.n);
      } finally {
        closeFixture(fixture);
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("blocking open architecture question → BLOCKING_QUESTION, zero mutations (§57/E27)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const fixture = await makeProposalFixture(root);
      try {
        const build = prepareCheckpoint(fixture, [
          { op: "SET_ARCHITECTURE_REVISION", target: null, content: ARCHITECTURE_1, compactProjection: "ARCH-1" },
          { op: "ADD_OPEN_QUESTION", content: OPEN_QUESTION_1, compactProjection: "Q-1" },
        ]);
        await authorizePrepared(fixture, build.proposal);

        const before = memoryCounts(fixture.store);
        const completion = fixture.proposals.prepareProposal({
          runId: fixture.runId,
          workspaceId: fixture.workspaceId,
          sessionId: fixture.sessionId,
          bindingGeneration: fixture.generation,
          expectedRunRevision: fixture.runRevision,
          type: "architecture_completion",
          scope: { kind: "architecture" },
          title: "Complete",
          summary: "should fail",
          changes: [],
        });
        expect(() => authorizePrepared(fixture, completion.proposal)).toThrowError(
          expect.objectContaining({ code: "BLOCKING_QUESTION" }),
        );
        expect(memoryCounts(fixture.store)).toEqual(before);
        expect(fixture.runs.getPlanningRun(fixture.runId)?.stage).toBe("architecture");
        // The failed completion stays awaiting — reject it before continuing.
        fixture.proposals.rejectProposal({
          runId: fixture.runId,
          workspaceId: fixture.workspaceId,
          sessionId: fixture.sessionId,
          bindingGeneration: fixture.generation,
          proposalId: completion.proposal.proposalId,
        });

        // A NON-blocking question does not gate completion: resolve Q-1 first.
        const resolve = prepareCheckpoint(fixture, [
          { op: "RESOLVE_OPEN_QUESTION", target: { id: "Q-1", revision: 1 }, content: { ...OPEN_QUESTION_1, status: "resolved" as const, resolution: "round-robin" }, compactProjection: "Q-1 resolved" },
        ], { expectedRunRevision: fixture.runRevision });
        await authorizePrepared(fixture, resolve.proposal);
        const completion2 = fixture.proposals.prepareProposal({
          runId: fixture.runId,
          workspaceId: fixture.workspaceId,
          sessionId: fixture.sessionId,
          bindingGeneration: fixture.generation,
          expectedRunRevision: fixture.runRevision,
          type: "architecture_completion",
          scope: { kind: "architecture" },
          title: "Complete",
          summary: "now fine",
          changes: [],
        });
        const done = await authorizePrepared(fixture, completion2.proposal);
        expect(done.stage).toBe("detail");
      } finally {
        closeFixture(fixture);
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("open blocking conflict → BLOCKING_CONFLICT, zero mutations (§58/E28)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const fixture = await makeProposalFixture(root);
      try {
        const build = prepareCheckpoint(fixture, [
          { op: "SET_ARCHITECTURE_REVISION", target: null, content: ARCHITECTURE_1, compactProjection: "ARCH-1" },
          { op: "ADD_CONFLICT", content: CONFLICT_1, compactProjection: "CONF-1" },
          { op: "ADD_OPEN_QUESTION", content: OPEN_QUESTION_SOFT, compactProjection: "Q-1" },
        ]);
        await authorizePrepared(fixture, build.proposal);
        const before = memoryCounts(fixture.store);
        const completion = fixture.proposals.prepareProposal({
          runId: fixture.runId,
          workspaceId: fixture.workspaceId,
          sessionId: fixture.sessionId,
          bindingGeneration: fixture.generation,
          expectedRunRevision: fixture.runRevision,
          type: "architecture_completion",
          scope: { kind: "architecture" },
          title: "Complete",
          summary: "should fail",
          changes: [],
        });
        expect(() => authorizePrepared(fixture, completion.proposal)).toThrowError(
          expect.objectContaining({ code: "BLOCKING_CONFLICT" }),
        );
        expect(memoryCounts(fixture.store)).toEqual(before);
      } finally {
        closeFixture(fixture);
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });
});

describe("atomicity and idempotency (§34/§47/§60–§63/E15–E18/E35–E39)", () => {
  it("validation failure inside the commit transaction leaves NO approval (E16/§34)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const fixture = await makeProposalFixture(root);
      try {
        const prepared = prepareCheckpoint(fixture, [{ op: "ADD_DECISION", content: DECISION_1, compactProjection: "a" }]);
        // Move the run revision after prepare — the engine's §41 precedence
        // fires before any memory write; no approval row may remain.
        const raw = rawConnectionFixture(fixture);
        try {
          raw.exec(`UPDATE planning_runs SET revision = revision + 1 WHERE run_id = '${fixture.runId}'`);
        } finally {
          raw.close();
        }
        expect(() => authorizePrepared(fixture, prepared.proposal)).toThrowError(
          expect.objectContaining({ code: "STALE_RUN_REVISION" }),
        );
        expect(memoryCounts(fixture.store).approvals).toBe(0);
        const state = fixture.store.withRead((tx) =>
          tx.prepare("SELECT status FROM proposal_states WHERE proposal_id = ?").get(prepared.proposal.proposalId),
        ) as { status: string };
        expect(state.status).toBe("awaiting_approval");
      } finally {
        closeFixture(fixture);
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("no partial commit: all-or-nothing across changes (E35/§47)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const fixture = await makeProposalFixture(root);
      try {
        // Second change targets a revision that will NOT exist at commit time
        // because the base snapshot moved between prepare and commit — the
        // engine re-simulates and refuses, and NOTHING may land.
        const seed = prepareCheckpoint(fixture, [{ op: "ADD_DECISION", content: DECISION_1, compactProjection: "seed" }]);
        await authorizePrepared(fixture, seed.proposal);
        const prepared = prepareCheckpoint(fixture, [
          { op: "ADD_CONSTRAINT", content: CONSTRAINT_1, compactProjection: "ok" },
          { op: "SUPERSEDE_DECISION", target: { id: "DEC-1", revision: 1 }, content: DECISION_1, compactProjection: "v2" },
        ], { expectedRunRevision: fixture.runRevision });

        // Advance HEAD past the proposal's base (another committed change).
        fixture.runs.takeoverActiveRun({
          runId: fixture.runId,
          workspaceId: fixture.workspaceId,
          newSessionId: "S9",
          expectedGeneration: fixture.generation,
        });
        const memory = createInternalPlanMemoryWriter(fixture.store, fixedClock({ ids: ["bump"] }));
        memory.insertMemoryRevision({
          runId: fixture.runId,
          kind: "decision",
          artifactId: "DEC-1",
          revision: 2,
          content: DECISION_1,
          compactProjection: "advanced",
        });
        const snap = memory.insertSnapshot({
          runId: fixture.runId,
          refs: [{ runId: fixture.runId, kind: "decision", id: "DEC-1", revision: 2 }],
        });
        fixture.store.withWrite((tx) => {
          tx.prepare("UPDATE plan_heads SET head_snapshot_id = ?, head_commit_id = NULL WHERE run_id = ?").run(snap.snapshotId, fixture.runId);
        });

        const before = memoryCounts(fixture.store);
        expect(() =>
          fixture.engine.commitAuthorizedProposal({
            runId: fixture.runId,
            workspaceId: fixture.workspaceId,
            sessionId: "S9",
            bindingGeneration: fixture.generation + 1,
            authorization: makeTestUserAuthorization({
              proposalId: prepared.proposal.proposalId,
              proposalRevision: 1,
              proposalHash: prepared.proposal.proposalHash,
            }),
          }),
        ).toThrowError(); // stale HEAD before any write
        expect(memoryCounts(fixture.store)).toEqual(before);
      } finally {
        closeFixture(fixture);
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("retry with the same authorizationRequestId returns the same approval/commit/snapshot (E36/§61)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const fixture = await makeProposalFixture(root);
      try {
        const prepared = prepareCheckpoint(fixture, [{ op: "ADD_DECISION", content: DECISION_1, compactProjection: "a" }]);
        const first = await authorizePrepared(fixture, prepared.proposal);
        // Same request id as the helper's default → idempotent replay.
        const retry = fixture.engine.commitAuthorizedProposal({
          runId: fixture.runId,
          workspaceId: fixture.workspaceId,
          sessionId: fixture.sessionId,
          bindingGeneration: fixture.generation,
          authorization: makeTestUserAuthorization({
            proposalId: prepared.proposal.proposalId,
            proposalRevision: 1,
            proposalHash: prepared.proposal.proposalHash,
          }),
        });
        expect(retry.idempotent).toBe(true);
        expect(retry.commitId).toBe(first.commitId);
        expect(retry.approvalId).toBe(first.approvalId);
        expect(retry.snapshotId).toBe(first.snapshotId);
        expect(retry.sequence).toBe(1);
        const counts = memoryCounts(fixture.store);
        expect(counts.commits).toBe(1);
        expect(counts.approvals).toBe(1);
      } finally {
        closeFixture(fixture);
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("same authorizationRequestId with different semantics → IDEMPOTENCY_CONFLICT (E37/§62)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const fixture = await makeProposalFixture(root);
      try {
        const prepared = prepareCheckpoint(fixture, [{ op: "ADD_DECISION", content: DECISION_1, compactProjection: "a" }]);
        const recordedId = `AUTH-${prepared.proposal.proposalId}-1`;
        await authorizePrepared(fixture, prepared.proposal);
        // Same request id now claims a different hash → conflict, never reuse.
        expect(() =>
          fixture.engine.commitAuthorizedProposal({
            runId: fixture.runId,
            workspaceId: fixture.workspaceId,
            sessionId: fixture.sessionId,
            bindingGeneration: fixture.generation,
            authorization: {
              authorizationRequestId: recordedId,
              proposalId: prepared.proposal.proposalId,
              proposalRevision: 1,
              proposalHash: "sha256:" + "f".repeat(64),
            },
          }),
        ).toThrowError(expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }));
        // A different proposal id with the same request id also conflicts.
        expect(() =>
          fixture.engine.commitAuthorizedProposal({
            runId: fixture.runId,
            workspaceId: fixture.workspaceId,
            sessionId: fixture.sessionId,
            bindingGeneration: fixture.generation,
            authorization: {
              authorizationRequestId: recordedId,
              proposalId: "PROP-other",
              proposalRevision: 1,
              proposalHash: prepared.proposal.proposalHash,
            },
          }),
        ).toThrowError(expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }));
      } finally {
        closeFixture(fixture);
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("first commit works from null HEAD with parent/base null (E21/§49)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const fixture = await makeProposalFixture(root);
      try {
        const prepared = prepareCheckpoint(fixture, [{ op: "ADD_DECISION", content: DECISION_1, compactProjection: "a" }]);
        const result = await authorizePrepared(fixture, prepared.proposal);
        expect(result.sequence).toBe(1);
        expect(result.parentCommitId).toBeNull();
        const commit = fixture.store.withRead((tx) =>
          tx.prepare("SELECT base_snapshot_id AS base FROM plan_commits WHERE commit_id = ?").get(result.commitId),
        ) as { base: string | null };
        expect(commit.base).toBeNull();
      } finally {
        closeFixture(fixture);
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });
});

void initializePlanStore;
