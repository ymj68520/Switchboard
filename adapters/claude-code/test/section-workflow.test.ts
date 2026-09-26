/**
 * Phase 11 §80/§81 — Section workflow core + DAG behavior, driven through
 * the real production path (prepare → authorize → PlanCommit → workflow
 * mutations in one transaction): registration, selection, selection fences,
 * checkpoints, completion + prerequisites, active clear, final-section →
 * synthesis, reopen, dependency propagation, needs_review re-completion, and
 * no automatic restoration.
 */

import { describe, expect, it } from "vitest";

import { createSectionWorkflowService, evaluateDetailCompletionInTx } from "../src/application/section-workflow-service.js";
import { counterClock } from "./test-clocks.js";
import { commitPrepared } from "./context-helpers.js";
import {
  commitSectionDag,
  makeDetailFixture,
  rawSection,
  runStageOf,
  activeSectionOf,
  workflowStatesOf,
  type DetailFixture,
} from "./phase11-helpers.js";

function select(fixture: DetailFixture, sectionId: string, expectedRevision?: number) {
  const service = createSectionWorkflowService(fixture.store, counterClock());
  const result = service.selectSection({
    runId: fixture.runId,
    workspaceId: fixture.workspaceId,
    sessionId: fixture.sessionId,
    bindingGeneration: fixture.generation,
    expectedRunRevision: expectedRevision ?? fixture.runRevision,
    sectionId,
  });
  // Keep the fixture's fencing input current for chained calls.
  (fixture as { runRevision: number }).runRevision = result.run.revision;
  return result;
}

describe("section workflow core (§80)", () => {
  it("registers a first committed Section open, atomically with its PlanCommit (§28)", async () => {
    const f = await makeDetailFixture();
    try {
      const before = runStageOf(f);
      const { sectionIds } = commitSectionDag(f, [{ title: "Storage" }]);
      expect(sectionIds).toHaveLength(1);
      const states = workflowStatesOf(f);
      expect(states).toHaveLength(1);
      expect(states[0]).toMatchObject({ sectionId: sectionIds[0], status: "open" });
      expect(states[0]?.completedRevision).toBeUndefined();
      // Registration itself never mutates the run (§29/§65).
      expect(runStageOf(f)).toEqual(before);
      // REGISTERED is the only workflow event so far.
      const events = f.store.withRead((tx) =>
        tx.prepare("SELECT event_type AS e, from_state AS fromState, to_state AS toState FROM section_workflow_events WHERE run_id = ? ORDER BY event_seq").all(f.runId),
      ) as Array<{ e: string; fromState: null; toState: string }>;
      expect(events).toEqual([{ e: "REGISTERED", fromState: null, toState: "open" }]);
    } finally {
      f.close();
    }
  });

  it("selection requires stage detail, an existing HEAD section, and is idempotent on re-select (§12–§14)", async () => {
    const f = await makeDetailFixture();
    try {
      const { sectionIds } = commitSectionDag(f, [{ title: "A" }, { title: "B" }]);
      const [a, b] = sectionIds as [string, string];
      // No selection before Detail: architecture-stage run cannot select.
      // (makeDetailFixture is already at detail; assert the fence via a fresh
      // architecture fixture is covered by the proposal-surface suite.)
      expect(runStageOf(f).stage).toBe("detail");

      const result = select(f, a);
      expect(result.idempotent).toBe(false);
      expect(activeSectionOf(f)).toBe(a);
      const revisionBeforeSelect = runStageOf(f).revision;
      expect(revisionBeforeSelect).toBeGreaterThan(result.run.revision - 1);

      // Idempotent re-select: same active Section, revision untouched (§14).
      const again = select(f, a);
      expect(again.idempotent).toBe(true);
      expect(runStageOf(f).revision).toBe(revisionBeforeSelect);

      // Switching sections bumps exactly once more (§14).
      select(f, b);
      expect(activeSectionOf(f)).toBe(b);
      expect(runStageOf(f).revision).toBe(revisionBeforeSelect + 1);

      // Unknown section id → SECTION_NOT_FOUND.
      expect(() => select(f, "SEC-999")).toThrowError(expect.objectContaining({ code: "SECTION_NOT_FOUND" }));
    } finally {
      f.close();
    }
  });

  it("a stale expected run revision fences concurrent selection (§66)", async () => {
    const f = await makeDetailFixture();
    try {
      const { sectionIds } = commitSectionDag(f, [{ title: "A" }, { title: "B" }]);
      const revision = f.runRevision;
      select(f, sectionIds[0]!); // revision becomes N+1
      expect(() => select(f, sectionIds[1]!, revision)).toThrowError(
        expect.objectContaining({ code: "STALE_RUN_REVISION" }),
      );
      // The winner's state stands; the loser wrote nothing.
      expect(runStageOf(f).revision).toBe(revision + 1);
      expect(activeSectionOf(f)).toBe(sectionIds[0]);
    } finally {
      f.close();
    }
  });

  it("an awaiting proposal fences selection outside its scope (§13)", async () => {
    const f = await makeDetailFixture();
    try {
      const { sectionIds } = commitSectionDag(f, [{ title: "A" }, { title: "B" }]);
      const [a, b] = sectionIds as [string, string];
      select(f, a);
      const prepared = f.proposals.prepareProposal({
        runId: f.runId,
        workspaceId: f.workspaceId,
        sessionId: f.sessionId,
        bindingGeneration: f.generation,
        expectedRunRevision: f.runRevision,
        type: "design_checkpoint",
        scope: { kind: "section", sectionId: a },
        title: "A checkpoint",
        summary: "scope conflict probe",
        changes: [
          {
            op: "SET_SECTION_REVISION",
            target: { id: a, revision: 1 },
            content: rawSection("Storage v2").content,
            compactProjection: "section:A@2",
          },
        ],
      });
      // Same-scope selection is allowed (§13).
      const same = select(f, a);
      expect(same.idempotent).toBe(true);
      // A different section → ACTIVE_PROPOSAL_SCOPE_CONFLICT. The select also
      // does not disturb the awaiting proposal's fence.
      expect(() => select(f, b)).toThrowError(expect.objectContaining({ code: "ACTIVE_PROPOSAL_SCOPE_CONFLICT" }));
      const awaiting = f.proposals.getAwaitingProposal(f.runId);
      expect(awaiting?.proposalId).toBe(prepared.proposal.proposalId);
    } finally {
      f.close();
    }
  });

  it("a section checkpoint leaves status open, active selected, and the run revision unchanged (§29)", async () => {
    const f = await makeDetailFixture();
    try {
      const { sectionIds } = commitSectionDag(f, [{ title: "A" }]);
      const a = sectionIds[0]!;
      select(f, a);
      const revisionBefore = runStageOf(f).revision;
      const prepared = f.proposals.prepareProposal({
        runId: f.runId,
        workspaceId: f.workspaceId,
        sessionId: f.sessionId,
        bindingGeneration: f.generation,
        expectedRunRevision: f.runRevision,
        type: "design_checkpoint",
        scope: { kind: "section", sectionId: a },
        title: "A checkpoint",
        summary: "design refinement",
        changes: [
          {
            op: "SET_SECTION_REVISION",
            target: { id: a, revision: 1 },
            content: rawSection("Storage v2").content,
            compactProjection: "section:A@2",
          },
        ],
      });
      f.engine.commitAuthorizedProposal(fixtureAuth(f, prepared.proposal));
      expect(workflowStatesOf(f)[0]).toMatchObject({ sectionId: a, status: "open" });
      expect(activeSectionOf(f)).toBe(a);
      expect(runStageOf(f).revision).toBe(revisionBefore);
      expect(runStageOf(f).stage).toBe("detail");
    } finally {
      f.close();
    }
  });
});

function fixtureAuth(f: DetailFixture, proposal: { proposalId: string; revision: number; proposalHash: string }) {
  return {
    runId: f.runId,
    workspaceId: f.workspaceId,
    sessionId: f.sessionId,
    bindingGeneration: f.generation,
    authorization: {
      authorizationRequestId: `AUTH-${proposal.proposalId}-${proposal.revision}`,
      proposalId: proposal.proposalId,
      proposalRevision: proposal.revision,
      proposalHash: proposal.proposalHash,
    },
  };
}

/** Prepare + authorize a section_completion for the given section revision. */
export function completeSectionVia(
  f: DetailFixture,
  sectionId: string,
  revision: number,
  options: { dependencies?: string[]; expectError?: string } = {},
): void {
  const changes: unknown[] = [];
  if (options.dependencies === undefined) {
    changes.push({ op: "COMPLETE_SECTION", sectionId, compactProjection: `complete:${sectionId}@${revision}` });
  } else {
    changes.push({
      op: "SET_SECTION_REVISION",
      target: { id: sectionId, revision },
      content: rawSection(`Section ${sectionId}`, { dependencies: options.dependencies }).content,
      compactProjection: `section:${sectionId}@${revision + 1}`,
    });
    changes.push({ op: "COMPLETE_SECTION", sectionId, compactProjection: `complete:${sectionId}@${revision + 1}` });
  }
  const prepared = f.proposals.prepareProposal({
    runId: f.runId,
    workspaceId: f.workspaceId,
    sessionId: f.sessionId,
    bindingGeneration: f.generation,
    expectedRunRevision: f.runRevision,
    type: "section_completion",
    scope: { kind: "section", sectionId },
    title: `Complete ${sectionId}`,
    summary: "formal completion",
    changes: changes as never,
  });
  if (options.expectError !== undefined) {
    expect(() =>
      commitPrepared(f, prepared.proposal.proposalId, prepared.proposal.revision, prepared.proposal.proposalHash),
    ).toThrowError(expect.objectContaining({ code: options.expectError }));
    // A blocked commit leaves the proposal awaiting — clear it for chained calls.
    rejectAwaiting(f);
    return;
  }
  commitPrepared(f, prepared.proposal.proposalId, prepared.proposal.revision, prepared.proposal.proposalHash);
}

/** Working-state rejection of the run's awaiting proposal (§28 service API). */
export function rejectAwaiting(f: DetailFixture): void {
  const awaiting = f.proposals.getAwaitingProposal(f.runId);
  if (awaiting !== null) {
    f.proposals.rejectProposal({
      runId: f.runId,
      workspaceId: f.workspaceId,
      sessionId: f.sessionId,
      bindingGeneration: f.generation,
      proposalId: awaiting.proposalId,
    });
  }
}

export { fixtureAuth };

describe("section completion + invalidation (§30–§44/§80/§81)", () => {
  it("completes the active section: provenance bound, active cleared, run +1 exactly once (§33/§34)", async () => {
    const f = await makeDetailFixture();
    try {
      const { sectionIds } = commitSectionDag(f, [{ title: "A" }]);
      const a = sectionIds[0]!;
      select(f, a);
      const revisionBefore = runStageOf(f).revision;
      const headBefore = f.store.withRead((tx) => tx.prepare("SELECT head_commit_id AS c FROM plan_heads WHERE run_id = ?").get(f.runId)) as { c: string };
      completeSectionVia(f, a, 1);
      const state = workflowStatesOf(f)[0]!;
      expect(state.status).toBe("completed");
      expect(state.completedRevision).toBe(1);
      expect(state.completedProposalId).toMatch(/^PROP-/);
      expect(state.completionCommitId).not.toBe(headBefore.c);
      expect(activeSectionOf(f)).toBeNull();
      // The single Section was the last one: Detail → Synthesis in the SAME
      // transaction, one revision bump total (§34/§35).
      expect(runStageOf(f)).toEqual({ stage: "synthesis", revision: revisionBefore + 1 });
      const events = f.store.withRead((tx) =>
        tx.prepare("SELECT event_type AS e FROM section_workflow_events WHERE run_id = ? AND section_id = ? ORDER BY event_seq").all(f.runId, a),
      ) as Array<{ e: string }>;
      expect(events.map((row) => row.e)).toEqual(["REGISTERED", "COMPLETED"]);
    } finally {
      f.close();
    }
  });

  it("completion requires the target to be the active section (§32)", async () => {
    const f = await makeDetailFixture();
    try {
      const { sectionIds } = commitSectionDag(f, [{ title: "A" }, { title: "B" }]);
      select(f, sectionIds[0]!);
      completeSectionVia(f, sectionIds[1]!, 1, { expectError: "SECTION_NOT_ACTIVE" });
      expect(workflowStatesOf(f).find((s) => s.sectionId === sectionIds[1])?.status).toBe("open");
    } finally {
      f.close();
    }
  });

  it("completion requires direct dependencies completed at the candidate revisions (§32/§81)", async () => {
    const f = await makeDetailFixture();
    try {
      const { sectionIds } = commitSectionDag(f, [
        { title: "A" },
        { title: "B", dependencies: ["SEC-1"] },
      ]);
      const [a, b] = sectionIds as [string, string];
      select(f, b);
      completeSectionVia(f, b, 1, { expectError: "SECTION_DEPENDENCY_INCOMPLETE" });
      select(f, a);
      completeSectionVia(f, a, 1);
      select(f, b);
      completeSectionVia(f, b, 1);
      expect(workflowStatesOf(f).map((s) => s.status)).toEqual(["completed", "completed"]);
    } finally {
      f.close();
    }
  });

  it("the last completion transitions Detail → Synthesis atomically with one revision bump (§35)", async () => {
    const f = await makeDetailFixture();
    try {
      const { sectionIds } = commitSectionDag(f, [{ title: "A" }]);
      const a = sectionIds[0]!;
      select(f, a);
      const revisionBefore = runStageOf(f).revision;
      completeSectionVia(f, a, 1);
      expect(runStageOf(f)).toEqual({ stage: "synthesis", revision: revisionBefore + 1 });
    } finally {
      f.close();
    }
  });

  it("empty Section set can never satisfy Detail completion (§36/E38)", async () => {
    const f = await makeDetailFixture();
    try {
      const decision = f.store.withRead((tx) => evaluateDetailCompletionInTx(tx, f.runId, []));
      expect(decision.ready).toBe(false);
      expect(decision.blockers[0]).toContain("no sections exist");
    } finally {
      f.close();
    }
  });

  it("reopen: completed → open cleared; downstream completed → needs_review retaining provenance (§6/§39/§41/§42)", async () => {
    const f = await makeDetailFixture();
    try {
      // A ← B ← C. Completing A and B leaves C open, so the run is still at
      // detail when the reopen happens.
      const { sectionIds } = commitSectionDag(f, [
        { title: "A" },
        { title: "B", dependencies: ["SEC-1"] },
        { title: "C", dependencies: ["SEC-2"] },
      ]);
      const [a, b] = sectionIds as [string, string];
      select(f, a);
      completeSectionVia(f, a, 1);
      select(f, b);
      completeSectionVia(f, b, 1);
      const bProvenance = workflowStatesOf(f).find((s) => s.sectionId === b)!;
      select(f, a);
      const reopen = f.proposals.prepareProposal({
        runId: f.runId,
        workspaceId: f.workspaceId,
        sessionId: f.sessionId,
        bindingGeneration: f.generation,
        expectedRunRevision: f.runRevision,
        type: "amendment",
        scope: { kind: "section", sectionId: a },
        title: "Reopen A",
        summary: "upstream basis changed",
        changes: [{ op: "REOPEN_SECTION", sectionId: a, compactProjection: `reopen:${a}` }],
      });
      commitPrepared(f, reopen.proposal.proposalId, reopen.proposal.revision, reopen.proposal.proposalHash);
      const aState = workflowStatesOf(f).find((s) => s.sectionId === a)!;
      const bState = workflowStatesOf(f).find((s) => s.sectionId === b)!;
      expect(aState.status).toBe("open");
      expect(aState.completedRevision).toBeUndefined();
      expect(bState.status).toBe("needs_review");
      expect(bState.completedRevision).toBe(bProvenance.completedRevision);
      expect(bState.completedProposalId).toBe(bProvenance.completedProposalId);
      expect(bState.completionCommitId).toBe(bProvenance.completionCommitId);
      expect(runStageOf(f).stage).toBe("detail");
      const revisionA = f.store.withRead((tx) =>
        tx.prepare("SELECT MAX(revision) AS r FROM memory_revisions WHERE run_id = ? AND kind = 'section' AND artifact_id = ?").get(f.runId, a),
      ) as { r: number };
      expect(revisionA.r).toBe(1);
    } finally {
      f.close();
    }
  });

  it("re-completing the upstream does NOT restore downstream (§43/§44); formal re-completion records new provenance", async () => {
    const f = await makeDetailFixture();
    try {
      const { sectionIds } = commitSectionDag(f, [
        { title: "A" },
        { title: "B", dependencies: ["SEC-1"] },
        { title: "C", dependencies: ["SEC-2"] },
      ]);
      const [a, b] = sectionIds as [string, string];
      select(f, a);
      completeSectionVia(f, a, 1);
      select(f, b);
      completeSectionVia(f, b, 1);
      const bFirstProvenance = workflowStatesOf(f).find((s) => s.sectionId === b)!;
      select(f, a);
      const reopen = f.proposals.prepareProposal({
        runId: f.runId,
        workspaceId: f.workspaceId,
        sessionId: f.sessionId,
        bindingGeneration: f.generation,
        expectedRunRevision: f.runRevision,
        type: "amendment",
        scope: { kind: "section", sectionId: a },
        title: "Reopen A",
        summary: "basis changed",
        changes: [{ op: "REOPEN_SECTION", sectionId: a, compactProjection: `reopen:${a}` }],
      });
      commitPrepared(f, reopen.proposal.proposalId, reopen.proposal.revision, reopen.proposal.proposalHash);
      completeSectionVia(f, a, 1);
      expect(workflowStatesOf(f).find((s) => s.sectionId === a)?.status).toBe("completed");
      expect(workflowStatesOf(f).find((s) => s.sectionId === b)?.status).toBe("needs_review");
      expect(runStageOf(f).stage).toBe("detail");
      // §44 — B is formally re-completed at its UNCHANGED exact revision.
      select(f, b);
      completeSectionVia(f, b, 1);
      const bState = workflowStatesOf(f).find((s) => s.sectionId === b)!;
      expect(bState.status).toBe("completed");
      expect(bState.completedRevision).toBe(bFirstProvenance.completedRevision);
      // New completion provenance: a fresh proposal/commit, not the old one.
      expect(bState.completedProposalId).not.toBe(bFirstProvenance.completedProposalId);
      // C is still open — Detail persists until every Section completes.
      expect(runStageOf(f).stage).toBe("detail");
    } finally {
      f.close();
    }
  });

  it("a diamond DAG completes through every downstream path and reaches Synthesis (§81)", async () => {
    const f = await makeDetailFixture();
    try {
      const { sectionIds } = commitSectionDag(f, [
        { title: "Root" },
        { title: "Left", dependencies: ["SEC-1"] },
        { title: "Right", dependencies: ["SEC-1"] },
        { title: "Join", dependencies: ["SEC-2", "SEC-3"] },
      ]);
      for (const id of sectionIds) {
        select(f, id);
        completeSectionVia(f, id, 1);
      }
      expect(runStageOf(f).stage).toBe("synthesis");
      expect(workflowStatesOf(f).every((s) => s.status === "completed")).toBe(true);
    } finally {
      f.close();
    }
  });
});
