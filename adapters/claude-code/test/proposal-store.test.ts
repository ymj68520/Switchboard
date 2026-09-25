import { describe, expect, it } from "vitest";

import { makeTestUserAuthorization, DECISION_1, prepareCheckpoint, closeFixture, makeProposalFixture, type ProposalFixture } from "./proposal-helpers.js";
import { getCommitChainRecord, getHeadCommitRecord, listAuditEventsRecord, listPlanCommitsRecord } from "../src/store/plan-commits.js";
import { rawConnection, makeTempPluginDataRoot, removeTempPluginDataRoot, storePathsFor } from "./store-helpers.js";

async function committedFixture(root: string): Promise<{ fixture: ProposalFixture; proposalId: string; proposalHash: string }> {
  const fixture = await makeProposalFixture(root);
  const prepared = prepareCheckpoint(fixture, [{ op: "ADD_DECISION", content: DECISION_1, compactProjection: "DEC-1 add" }]);
  const result = fixture.engine.commitAuthorizedProposal({
    runId: fixture.runId,
    workspaceId: fixture.workspaceId,
    sessionId: fixture.sessionId,
    bindingGeneration: fixture.generation,
    authorization: makeTestUserAuthorization({
      proposalId: prepared.proposal.proposalId,
      proposalRevision: prepared.proposal.revision,
      proposalHash: prepared.proposal.proposalHash,
    }),
  });
  expect(result.idempotent).toBe(false);
  return { fixture, proposalId: prepared.proposal.proposalId, proposalHash: prepared.proposal.proposalHash };
}

describe("database-level immutability (§25/§66/§71/E40/E41)", () => {
  it("refuses raw UPDATE/DELETE on proposal_revisions, approvals, plan_commits, audit_events", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { fixture, proposalId } = await committedFixture(root);
      try {
        const dbPath = storePathsFor(root).databasePath;
        const raw = rawConnection(dbPath, 500);
        try {
          const revisionRow = fixture.store.withRead((tx) =>
            tx.prepare("SELECT revision FROM proposal_revisions WHERE proposal_id = ?").get(proposalId),
          ) as { revision: number };
          const approvalId = fixture.store.withRead((tx) =>
            tx.prepare("SELECT approval_id AS id FROM approvals LIMIT 1").get(),
          ) as { id: string };
          const commitId = fixture.store.withRead((tx) =>
            tx.prepare("SELECT commit_id AS id FROM plan_commits LIMIT 1").get(),
          ) as { id: string };
          const eventId = fixture.store.withRead((tx) =>
            tx.prepare("SELECT event_id AS id FROM audit_events LIMIT 1").get(),
          ) as { id: string };

          expect(() => raw.prepare("UPDATE proposal_revisions SET title = 'hacked' WHERE proposal_id = ?").run(proposalId))
            .toThrowError(/immutable/);
          expect(() => raw.prepare("DELETE FROM proposal_revisions WHERE proposal_id = ?").run(proposalId))
            .toThrowError(/immutable/);
          expect(() => raw.prepare("UPDATE approvals SET proposal_hash = 'sha256:x' WHERE approval_id = ?").run(approvalId.id))
            .toThrowError(/immutable/);
          expect(() => raw.prepare("DELETE FROM approvals WHERE approval_id = ?").run(approvalId.id))
            .toThrowError(/immutable/);
          expect(() => raw.prepare("UPDATE plan_commits SET sequence = 99 WHERE commit_id = ?").run(commitId.id))
            .toThrowError(/immutable/);
          expect(() => raw.prepare("DELETE FROM plan_commits WHERE commit_id = ?").run(commitId.id))
            .toThrowError(/immutable/);
          expect(() => raw.prepare("UPDATE audit_events SET payload_json = '{}' WHERE event_id = ?").run(eventId.id))
            .toThrowError(/immutable/);
          expect(() => raw.prepare("DELETE FROM audit_events WHERE event_id = ?").run(eventId.id))
            .toThrowError(/immutable/);
          void revisionRow;
        } finally {
          raw.close();
        }
      } finally {
        closeFixture(fixture);
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("proposal_states only walks awaiting_approval → approved/rejected/superseded via triggers", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const fixture = await makeProposalFixture(root);
      try {
        const prepared = prepareCheckpoint(fixture, [{ op: "ADD_DECISION", content: DECISION_1, compactProjection: "a" }]);
        const dbPath = storePathsFor(root).databasePath;
        const raw = rawConnection(dbPath, 500);
        try {
          const runId = fixture.runId;
          // Insert must start awaiting_approval.
          expect(() =>
            raw.prepare("INSERT INTO proposal_states (run_id, proposal_id, revision, status, created_at, updated_at) VALUES (?, ?, 2, 'approved', 'x', 'x')").run(runId, prepared.proposal.proposalId),
          ).toThrowError(/start awaiting_approval/);
          // …then identity columns are immutable even while awaiting…
          const second = fixture.proposals.reviseProposal({
            runId: fixture.runId,
            workspaceId: fixture.workspaceId,
            sessionId: fixture.sessionId,
            bindingGeneration: fixture.generation,
            expectedRunRevision: fixture.runRevision,
            type: "design_checkpoint",
            scope: { kind: "architecture" },
            title: "v2",
            summary: "s",
            changes: [{ op: "ADD_DECISION", content: DECISION_1, compactProjection: "b" }],
            proposalId: prepared.proposal.proposalId,
          });
          expect(() =>
            raw.prepare("UPDATE proposal_states SET revision = 9 WHERE run_id = ? AND proposal_id = ? AND revision = 2").run(runId, second.proposal.proposalId),
          ).toThrowError(/proposal_states: (identity columns are immutable|illegal status transition)/);
          // …and a legal transition to a terminal status can never reopen.
          raw.prepare("UPDATE proposal_states SET status = 'rejected' WHERE run_id = ? AND proposal_id = ? AND revision = 2").run(runId, second.proposal.proposalId);
          expect(() =>
            raw.prepare("UPDATE proposal_states SET status = 'awaiting_approval' WHERE run_id = ? AND proposal_id = ? AND revision = 2").run(runId, second.proposal.proposalId),
          ).toThrowError(/terminal status is immutable/);
        } finally {
          raw.close();
        }
      } finally {
        closeFixture(fixture);
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("one awaiting proposal per run — partial unique index (§10/E8)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const fixture = await makeProposalFixture(root);
      try {
        prepareCheckpoint(fixture, [{ op: "ADD_DECISION", content: DECISION_1, compactProjection: "a" }]);
        const dbPath = storePathsFor(root).databasePath;
        const raw = rawConnection(dbPath, 500);
        try {
          const runId = fixture.runId;
          expect(() =>
            raw.prepare("INSERT INTO proposal_states (run_id, proposal_id, revision, status, created_at, updated_at) VALUES (?, 'P-OTHER', 1, 'awaiting_approval', 'x', 'x')").run(runId),
          ).toThrowError(/UNIQUE constraint failed/);
        } finally {
          raw.close();
        }
      } finally {
        closeFixture(fixture);
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("approval hash-match trigger + exact composite binding (§31/E6)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const fixture = await makeProposalFixture(root);
      try {
        const prepared = prepareCheckpoint(fixture, [{ op: "ADD_DECISION", content: DECISION_1, compactProjection: "a" }]);
        const dbPath = storePathsFor(root).databasePath;
        const raw = rawConnection(dbPath, 500);
        try {
          const runId = fixture.runId;
          // Wrong hash → refused by trigger.
          expect(() =>
            raw.prepare("INSERT INTO approvals (approval_id, run_id, proposal_id, proposal_revision, proposal_hash, actor, authorization_request_id, created_at) VALUES ('APPR-x', ?, ?, ?, 'sha256:deadbeef', 'user', 'AUTH-x', 'now')").run(
              runId,
              prepared.proposal.proposalId,
              prepared.proposal.revision,
            ),
          ).toThrowError(/proposal_hash does not match/);
          // Unknown proposal revision → refused by composite FK.
          expect(() =>
            raw.prepare("INSERT INTO approvals (approval_id, run_id, proposal_id, proposal_revision, proposal_hash, actor, authorization_request_id, created_at) VALUES ('APPR-y', ?, 'NOPE', 1, 'sha256:abc', 'user', 'AUTH-y', ?)").run(runId, "now"),
          ).toThrowError(/FOREIGN KEY constraint failed/);
          // actor must be 'user' (hardcoded vocabulary).
          expect(() =>
            raw.prepare("INSERT INTO approvals (approval_id, run_id, proposal_id, proposal_revision, proposal_hash, actor, authorization_request_id, created_at) VALUES ('APPR-z', ?, ?, 1, ?, 'model', 'AUTH-z', ?)").run(
              runId,
              prepared.proposal.proposalId,
              prepared.proposal.proposalHash,
              "now",
            ),
          ).toThrowError(/CHECK constraint failed/);
        } finally {
          raw.close();
        }
      } finally {
        closeFixture(fixture);
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("commit chain constraints: one root, one child per parent, sequence uniqueness, HEAD pair (§36/§37/§38)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { fixture } = await committedFixture(root);
      try {
        const dbPath = storePathsFor(root).databasePath;
        const raw = rawConnection(dbPath, 500);
        try {
          const runId = fixture.runId;
          const rootCommit = fixture.store.withRead((tx) =>
            tx.prepare("SELECT commit_id AS id, resulting_snapshot_id AS snap, approval_id AS approval, proposal_id AS proposalId, proposal_revision AS revision FROM plan_commits WHERE run_id = ?").get(runId),
          ) as { id: string; snap: string; approval: string; proposalId: string; revision: number };

          // Second root for the run → refused.
          expect(() =>
            raw.prepare("INSERT INTO plan_commits (commit_id, run_id, sequence, proposal_id, proposal_revision, approval_id, parent_commit_id, base_snapshot_id, resulting_snapshot_id, created_at) VALUES ('CMT-x2', ?, 2, ?, 1, ?, NULL, NULL, ?, 'now')").run(
              runId,
              rootCommit.proposalId,
              rootCommit.approval,
              rootCommit.snap,
            ),
          ).toThrowError();

          // Duplicate sequence → refused.
          expect(() =>
            raw.prepare("INSERT INTO plan_commits (commit_id, run_id, sequence, proposal_id, proposal_revision, approval_id, parent_commit_id, base_snapshot_id, resulting_snapshot_id, created_at) VALUES ('CMT-x3', ?, 1, ?, 1, ?, ?, ?, ?, 'now')").run(
              runId,
              rootCommit.proposalId,
              rootCommit.approval,
              rootCommit.id,
              rootCommit.snap,
              rootCommit.snap,
            ),
          ).toThrowError();

          // Second child of the same parent → refused by the one-child index.
          expect(() =>
            raw.prepare("INSERT INTO plan_commits (commit_id, run_id, sequence, proposal_id, proposal_revision, approval_id, parent_commit_id, base_snapshot_id, resulting_snapshot_id, created_at) VALUES ('CMT-x4', ?, 2, ?, 1, ?, ?, ?, ?, 'now')").run(
              runId,
              rootCommit.proposalId,
              rootCommit.approval,
              rootCommit.id,
              rootCommit.snap,
              rootCommit.snap,
            ),
          ).toThrowError();

          // HEAD pair consistency: commit whose resulting snapshot differs → refused.
          expect(() =>
            raw.prepare("UPDATE plan_heads SET head_commit_id = 'CMT-ghost' WHERE run_id = ?").run(runId),
          ).toThrowError();
        } finally {
          raw.close();
        }

        // Reads: chain is linear and HEAD is the tip.
        const chain = getCommitChainRecord(fixture.store, fixture.runId);
        expect(chain).toHaveLength(1);
        expect(chain[0]?.sequence).toBe(1);
        expect(chain[0]?.parentCommitId).toBeNull();
        expect(getHeadCommitRecord(fixture.store, fixture.runId)?.commitId).toBe(chain[0]?.commitId);
      } finally {
        closeFixture(fixture);
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("audit events append-only with deterministic seq ordering and are not replay authority (§69/§70/E42)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { fixture } = await committedFixture(root);
      try {
        const events = listAuditEventsRecord(fixture.store, fixture.runId);
        const types = events.map((event) => event.eventType);
        expect(types[0]).toBe("PROPOSAL_PREPARED");
        expect(types[types.length - 1]).toBe("PLAN_COMMITTED");
        const seqs = events.map((event) => event.eventSeq);
        expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
        // The commit event references approval + commit + snapshot completely.
        const commitEvent = events.find((event) => event.eventType === "PLAN_COMMITTED");
        expect(commitEvent?.payload).toMatchObject({ approvalId: expect.any(String), commitId: expect.any(String), snapshotId: expect.any(String) });
      } finally {
        closeFixture(fixture);
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("commit-chain validator detects a hand-broken chain (§68)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { fixture } = await committedFixture(root);
      try {
        const dbPath = storePathsFor(root).databasePath;
        // plan_commits is trigger-immutable — simulate corruption via a second
        // commit built directly (the validator, not the writer, is under test).
        const raw = rawConnection(dbPath, 500);
        try {
          raw.exec("DROP TRIGGER plan_commits_no_update");
          raw.exec("UPDATE plan_commits SET sequence = 5");
        } finally {
          raw.close();
        }
        expect(() => getCommitChainRecord(fixture.store, fixture.runId)).toThrowError(
          expect.objectContaining({ code: "STORE_SCHEMA_INVALID" }),
        );
        expect(() => listPlanCommitsRecord(fixture.store, fixture.runId)).not.toThrowError();
      } finally {
        closeFixture(fixture);
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("proposal identity/revision/state separation with strict max+1 revisions (E2/E3)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const fixture = await makeProposalFixture(root);
      try {
        const first = prepareCheckpoint(fixture, [{ op: "ADD_DECISION", content: DECISION_1, compactProjection: "v1" }]);
        expect(first.proposal.revision).toBe(1);
        const revised = fixture.proposals.reviseProposal({
          runId: fixture.runId,
          workspaceId: fixture.workspaceId,
          sessionId: fixture.sessionId,
          bindingGeneration: fixture.generation,
          expectedRunRevision: fixture.runRevision,
          type: "design_checkpoint",
          scope: { kind: "architecture" },
          title: "Checkpoint v2",
          summary: "revised",
          changes: [{ op: "ADD_DECISION", content: DECISION_1, compactProjection: "v2" }],
          proposalId: first.proposal.proposalId,
        });
        expect(revised.proposal.revision).toBe(2);
        expect(first.proposal.proposalId).toBe(revised.proposal.proposalId);

        const dbPath = storePathsFor(root).databasePath;
        const raw = rawConnection(dbPath, 500);
        try {
          // Revision 1 content is untouched by the revision-2 freeze.
          const rows = raw.prepare("SELECT revision, title FROM proposal_revisions WHERE proposal_id = ? ORDER BY revision").all(first.proposal.proposalId) as { revision: number; title: string }[];
          expect(rows).toEqual([
            { revision: 1, title: "Checkpoint" },
            { revision: 2, title: "Checkpoint v2" },
          ]);
          // Duplicate exact revision (PK) is refused — never overwritten.
          expect(() =>
            raw.prepare("INSERT INTO proposal_revisions (run_id, proposal_id, revision, proposal_type, scope_json, title, summary, changes_json, dependencies_json, impact_json, base_run_revision, canonical_json, proposal_hash, created_at) VALUES (?, ?, 1, 'design_checkpoint', '{}', 'dup', 's', '[]', '[]', '{}', 1, '{}', 'sha256:aaa', 'now')").run(fixture.runId, first.proposal.proposalId),
          ).toThrowError();
          // Direct revision-7 insert passes the DB (max+1 is Application-enforced)
          // but gets caught by the composite-FK base snapshot gate when the
          // canonical base references snapshots; scope is unrestricted JSON here.
        } finally {
          raw.close();
        }
      } finally {
        closeFixture(fixture);
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });
});
