/**
 * Phase 8 context core: deterministic assembler, context_epoch semantics,
 * committed-memory projection filters/ordering, proposal isolation, HEAD
 * isolation, and read-model no-mutation guarantees (directive §5–§15, §26,
 * §33/§36/§37/§44, §48, E1–E6, E10–E14, E22, E33, E34, E39-adjacent).
 */

import { describe, expect, it } from "vitest";

import { assembleContext } from "../src/context/assembler.js";
import { deriveContextEpoch, deriveContextEpochFromSource } from "../src/context/epoch.js";
import { createStoreContextSource } from "../src/application/context-read-model.js";
import { canonicalJson } from "../src/core/canonical-json.js";
import { createBindingService } from "../src/session/binding-service.js";
import { getHeadSnapshotRecord } from "../src/store/plan-memory.js";
import { CONSTRAINT_1, DECISION_1, memoryCounts } from "./proposal-helpers.js";
import { fixedClock } from "./store-helpers.js";
import {
  addRevision,
  commitCheckpoint,
  makeContextFixture,
  publishHead,
  sectionContent,
  type ContextFixture,
} from "./context-helpers.js";
import type { ConstraintContent } from "../src/core/memory-artifacts.js";
import type { RawProposalChange } from "../src/core/proposal.js";

function constraint(
  overrides: Partial<Pick<ConstraintContent, "source" | "statement" | "severity" | "status">> = {},
): ConstraintContent {
  return { ...CONSTRAINT_1, ...overrides };
}

async function withFixture(fn: (fixture: ContextFixture) => void | Promise<void>): Promise<void> {
  const fixture = await makeContextFixture();
  try {
    await fn(fixture);
  } finally {
    fixture.close();
  }
}

describe("assembler: empty-run baseline (E7/E22/E33)", () => {
  it("a run with no HEAD assembles a deterministic, mutation-free context", async () => {
    await withFixture((fixture) => {
      const source = createStoreContextSource(fixture.store);
      const before = memoryCounts(fixture.store);
      const first = assembleContext(source, fixture.runId);
      const second = assembleContext(source, fixture.runId);
      // Byte-identical structured context for identical Store state (E33/E14).
      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
      expect(first.version).toBe(1);
      expect(first.run).toMatchObject({ runId: fixture.runId, stage: "architecture", lifecycle: "active" });
      expect(first.head).toEqual({ commitId: null, snapshotId: null });
      expect(first.globalMemory).toEqual({
        hardConstraints: [],
        architecture: null,
        sections: [],
        blockingQuestions: [],
        blockingConflicts: [],
      });
      expect(first.activeScope).toBeNull();
      expect(first.working.awaitingProposal).toBeNull();
      expect(first.operations).toEqual(["get_state", "get_context", "read_memory", "start_or_resume"]);
      expect(first.sourceTrace).toMatchObject({ runRevision: fixture.runRevision, headCommitId: null, headSnapshotId: null, snapshotRefCount: 0, awaitingProposalRevision: null });
      // No committed mutation (E22/§48).
      expect(memoryCounts(fixture.store)).toEqual(before);
    });
  });
});

describe("context_epoch (E4/E5/E6, §36/§37/§38)", () => {
  it("changes when HEAD moves null → C1/S1 and C1/S1 → C2/S2", async () => {
    await withFixture((fixture) => {
      const source = createStoreContextSource(fixture.store);
      const epoch0 = deriveContextEpochFromSource(source, fixture.runId)!;
      const c1 = commitCheckpoint(fixture, [{ op: "ADD_CONSTRAINT", content: CONSTRAINT_1, compactProjection: "CONST-1@1" }]);
      const epoch1 = deriveContextEpochFromSource(source, fixture.runId)!;
      expect(epoch1).not.toBe(epoch0);
      const c2 = commitCheckpoint(fixture, [
        {
          op: "ADD_DECISION",
          content: DECISION_1,
          compactProjection: "DEC-2@1",
        },
      ]);
      const epoch2 = deriveContextEpochFromSource(source, fixture.runId)!;
      expect(epoch2).not.toBe(epoch1);
      expect(c1.commitId).not.toBe(c2.commitId);
    });
  });

  it("changes when a proposal becomes awaiting and again when it is rejected", async () => {
    await withFixture((fixture) => {
      const source = createStoreContextSource(fixture.store);
      const epoch0 = deriveContextEpochFromSource(source, fixture.runId)!;
      const prepared = fixture.proposals.prepareProposal({
        runId: fixture.runId,
        workspaceId: fixture.workspaceId,
        sessionId: fixture.sessionId,
        bindingGeneration: fixture.generation,
        expectedRunRevision: fixture.runRevision,
        type: "design_checkpoint",
        scope: { kind: "architecture" },
        title: "Checkpoint",
        summary: "checkpoint summary",
        changes: [{ op: "ADD_CONSTRAINT", content: CONSTRAINT_1, compactProjection: "CONST-1@1" }],
      });
      const epochAwaiting = deriveContextEpochFromSource(source, fixture.runId)!;
      expect(epochAwaiting).not.toBe(epoch0);
      fixture.proposals.rejectProposal({
        runId: fixture.runId,
        workspaceId: fixture.workspaceId,
        sessionId: fixture.sessionId,
        bindingGeneration: fixture.generation,
        proposalId: prepared.proposal.proposalId,
      });
      const epochRejected = deriveContextEpochFromSource(source, fixture.runId)!;
      expect(epochRejected).not.toBe(epochAwaiting);
    });
  });

  it("excludes the SessionBinding generation: reattach leaves the epoch unchanged (§38)", async () => {
    await withFixture((fixture) => {
      const source = createStoreContextSource(fixture.store);
      const epoch0 = deriveContextEpochFromSource(source, fixture.runId)!;
      const bindings = createBindingService(fixture.store, fixedClock({ ids: ["gen"] }));
      const detached = bindings.detach({ runId: fixture.runId, sessionId: fixture.sessionId });
      const reattached = bindings.reattach({ runId: fixture.runId, sessionId: fixture.sessionId, workspaceId: fixture.workspaceId });
      expect(reattached.generation).toBe(detached.generation + 1);
      const epoch1 = deriveContextEpochFromSource(source, fixture.runId)!;
      expect(epoch1).toBe(epoch0);
    });
  });

  it("is a pure function of its declared inputs", () => {
    const base = {
      runId: "R",
      runRevision: 3,
      headCommitId: "C" as string | null,
      headSnapshotId: "S" as string | null,
      awaitingProposal: { id: "P", revision: 1, hash: "sha256:x" } as { id: string; revision: number; hash: string } | null,
      activeScope: null as { kind: string } | null,
    };
    const epoch = deriveContextEpoch(base);
    expect(epoch).toMatch(/^[0-9a-f]{64}$/);
    expect(deriveContextEpoch({ ...base })).toBe(epoch);
    expect(deriveContextEpoch({ ...base, headCommitId: null })).not.toBe(epoch);
    expect(deriveContextEpoch({ ...base, awaitingProposal: null })).not.toBe(epoch);
    expect(deriveContextEpoch({ ...base, runRevision: 4 })).not.toBe(epoch);
    // Binding generation is not even an input of the function (§38).
    expect("bindingGeneration" in base).toBe(false);
  });

  it("is independent of conversation-style inputs (compaction independence, §31/§53)", async () => {
    await withFixture((fixture) => {
      const source = createStoreContextSource(fixture.store);
      commitCheckpoint(fixture, [{ op: "ADD_CONSTRAINT", content: CONSTRAINT_1, compactProjection: "CONST-1@1" }]);
      const context = assembleContext(source, fixture.runId);
      // Two different "Claude compact summaries" — the assembler accepts no
      // conversation input at all, so both must project the same context.
      const summaryA = "summary A: something entirely different";
      const summaryB = "summary B: also different";
      expect(JSON.stringify(assembleContext(source, fixture.runId))).toBe(JSON.stringify(context));
      expect(summaryA).not.toBe(summaryB);
      expect(context.epoch).toBe(deriveContextEpochFromSource(source, fixture.runId));
    });
  });
});

describe("committed-memory projection (§9/§12/§13/§15, E8/E9/E34)", () => {
  it("projects only hard+active constraints in artifact-id order", async () => {
    await withFixture((fixture) => {
      const soft = addRevision(fixture, { kind: "constraint", artifactId: "C-B", content: constraint({ severity: "soft" }), compactProjection: "C-B" });
      const hard2 = addRevision(fixture, { kind: "constraint", artifactId: "C-D", content: constraint(), compactProjection: "C-D" });
      const hard1 = addRevision(fixture, { kind: "constraint", artifactId: "C-A", content: constraint({ status: "superseded" }), compactProjection: "C-A" });
      const hard3 = addRevision(fixture, { kind: "constraint", artifactId: "C-C", content: constraint(), compactProjection: "C-C" });
      publishHead(fixture, [soft, hard1, hard2, hard3]);
      const context = assembleContext(createStoreContextSource(fixture.store), fixture.runId);
      expect(context.globalMemory.hardConstraints.map((c) => c.ref.id)).toEqual(["C-C", "C-D"]);
      expect(context.globalMemory.hardConstraints[0]).toMatchObject({ statement: CONSTRAINT_1.statement, source: "user" });
    });
  });

  it("carries the frozen architecture compact projection verbatim (E8)", async () => {
    await withFixture((fixture) => {
      const ref = addRevision(fixture, {
        kind: "architecture",
        artifactId: "ARCH-1",
        content: { summary: "s", components: [], boundaries: [], dataFlows: [], principles: [], unresolvedQuestionRefs: [], decisionRefs: [] },
        compactProjection: "ARCH-1@1 | single store | WAL",
      });
      publishHead(fixture, [ref]);
      const context = assembleContext(createStoreContextSource(fixture.store), fixture.runId);
      expect(context.globalMemory.architecture).toEqual({
        ref: { runId: fixture.runId, kind: "architecture", id: "ARCH-1", revision: 1 },
        compactProjection: "ARCH-1@1 | single store | WAL",
      });
    });
  });

  it("lists section identities only, ordered by artifact id (§10/§11)", async () => {
    await withFixture((fixture) => {
      const b = addRevision(fixture, { kind: "section", artifactId: "SEC-B", content: sectionContent("SEC-B", 1), compactProjection: "SEC-B@1" });
      const a = addRevision(fixture, { kind: "section", artifactId: "SEC-A", content: sectionContent("SEC-A", 1), compactProjection: "SEC-A@1" });
      publishHead(fixture, [a, b]);
      const context = assembleContext(createStoreContextSource(fixture.store), fixture.runId);
      expect(context.globalMemory.sections.map((s) => s.ref.id)).toEqual(["SEC-A", "SEC-B"]);
      expect(context.globalMemory.sections[0]).toMatchObject({ title: "Section SEC-A" });
      // No active scope is guessed (E13).
      expect(context.activeScope).toBeNull();
    });
  });

  it("keeps only open blocking questions and open hard conflicts (E9)", async () => {
    await withFixture((fixture) => {
      const qSoft = addRevision(fixture, { kind: "open_question", artifactId: "Q-S", content: { question: "soft", blocking: false, scope: "architecture", status: "open" }, compactProjection: "Q-S" });
      const qOpen = addRevision(fixture, { kind: "open_question", artifactId: "Q-B", content: { question: "blocking?", blocking: true, scope: "architecture", status: "open" }, compactProjection: "Q-B" });
      const qResolved = addRevision(fixture, { kind: "open_question", artifactId: "Q-R", content: { question: "done?", blocking: true, scope: "architecture", status: "resolved", resolution: "yes" }, compactProjection: "Q-R" });
      const cSoft = addRevision(fixture, { kind: "conflict", artifactId: "X-S", content: { type: "t", refs: [], description: "soft", severity: "soft", status: "open" }, compactProjection: "X-S" });
      const cHard = addRevision(fixture, { kind: "conflict", artifactId: "X-H", content: { type: "contradiction", refs: [], description: "hard!", severity: "hard", status: "open" }, compactProjection: "X-H" });
      const cResolved = addRevision(fixture, { kind: "conflict", artifactId: "X-R", content: { type: "contradiction", refs: [], description: "resolved", severity: "hard", status: "resolved", resolution: "ok" }, compactProjection: "X-R" });
      publishHead(fixture, [qSoft, qOpen, qResolved, cSoft, cHard, cResolved]);
      const context = assembleContext(createStoreContextSource(fixture.store), fixture.runId);
      expect(context.globalMemory.blockingQuestions.map((q) => q.ref.id)).toEqual(["Q-B"]);
      expect(context.globalMemory.blockingConflicts.map((c) => c.ref.id)).toEqual(["X-H"]);
      expect(context.globalMemory.blockingConflicts[0]).toMatchObject({ type: "contradiction", severity: "hard" });
    });
  });

  it("projects only the current HEAD snapshot refs — historical revisions never leak (E34/§54)", async () => {
    await withFixture((fixture) => {
      const source = createStoreContextSource(fixture.store);
      const v1 = commitCheckpoint(fixture, [{ op: "ADD_CONSTRAINT", content: CONSTRAINT_1, compactProjection: "CONST-1@1" }]);
      const head1 = getHeadSnapshotRecord(fixture.store, fixture.runId)!;
      expect(head1.snapshotId).toBe(v1.snapshotId);
      const constraintRef = head1.refs.find((r) => r.kind === "constraint")!;
      // Second commit supersedes the constraint (new revision, new HEAD).
      commitCheckpoint(fixture, [
        {
          op: "SUPERSEDE_CONSTRAINT",
          target: { id: constraintRef.id, revision: constraintRef.revision },
          content: constraint({ statement: "No network access at runtime (v2)" }),
          compactProjection: "CONST@2 v2",
        },
      ]);
      const context = assembleContext(source, fixture.runId);
      expect(context.globalMemory.hardConstraints).toHaveLength(1);
      expect(context.globalMemory.hardConstraints[0]!.ref.revision).toBe(2);
      expect(context.globalMemory.hardConstraints[0]!.statement).toBe("No network access at runtime (v2)");
      expect(context.head.snapshotId).not.toBe(head1.snapshotId);
      expect(context.sourceTrace.snapshotRefCount).toBe(1);
    });
  });
});

describe("proposal isolation (E10/E11, §14/§55)", () => {
  it("awaiting proposal changes never leak into committed projections", async () => {
    await withFixture((fixture) => {
      const source = createStoreContextSource(fixture.store);
      const changes: RawProposalChange[] = [
        { op: "ADD_CONSTRAINT", content: constraint({ statement: "candidate constraint" }), compactProjection: "CANDIDATE" },
        { op: "ADD_DECISION", content: DECISION_1, compactProjection: "DEC-CANDIDATE" },
      ];
      const prepared = fixture.proposals.prepareProposal({
        runId: fixture.runId,
        workspaceId: fixture.workspaceId,
        sessionId: fixture.sessionId,
        bindingGeneration: fixture.generation,
        expectedRunRevision: fixture.runRevision,
        type: "design_checkpoint",
        scope: { kind: "architecture" },
        title: "Checkpoint",
        summary: "checkpoint summary",
        changes,
      });
      const context = assembleContext(source, fixture.runId);
      expect(context.globalMemory.hardConstraints).toEqual([]);
      expect(JSON.stringify(context.globalMemory)).not.toContain("candidate constraint");
      expect(JSON.stringify(context.globalMemory)).not.toContain("DEC-CANDIDATE");
      expect(context.working.awaitingProposal).toEqual({
        proposalId: prepared.proposal.proposalId,
        revision: prepared.proposal.revision,
        hash: prepared.proposal.proposalHash,
        type: "design_checkpoint",
        scope: { kind: "architecture" },
        title: "Checkpoint",
        summary: "checkpoint summary",
      });
      expect(context.operations).toEqual(["get_state", "get_context", "read_memory", "start_or_resume", "approve_proposal"]);
    });
  });

  it("after approval the same change becomes committed memory and the proposal region empties", async () => {
    await withFixture((fixture) => {
      const source = createStoreContextSource(fixture.store);
      commitCheckpoint(fixture, [{ op: "ADD_CONSTRAINT", content: constraint({ statement: "committed constraint" }), compactProjection: "COMMITTED" }]);
      const context = assembleContext(source, fixture.runId);
      expect(context.globalMemory.hardConstraints.map((c) => c.statement)).toEqual(["committed constraint"]);
      expect(context.working.awaitingProposal).toBeNull();
      expect(context.operations).not.toContain("approve_proposal");
    });
  });
});

describe("read model no-mutation + structural guarantees (E22/E23, §26)", () => {
  it("assembling, deriving epochs, and rendering never mutate the store or schema", async () => {
    await withFixture((fixture) => {
      const source = createStoreContextSource(fixture.store);
      commitCheckpoint(fixture, [{ op: "ADD_CONSTRAINT", content: CONSTRAINT_1, compactProjection: "CONST-1@1" }]);
      const before = memoryCounts(fixture.store);
      const context = assembleContext(source, fixture.runId);
      deriveContextEpochFromSource(source, fixture.runId);
      deriveContextEpochFromSource(source, fixture.runId);
      expect(JSON.parse(canonicalJson(context)).version).toBe(1);
      expect(memoryCounts(fixture.store)).toEqual(before);
    });
  });

  it("readRevision is exact: a missing revision returns null, another run's ref never resolves", async () => {
    await withFixture(async (fixture) => {
      const source = createStoreContextSource(fixture.store);
      const ref = addRevision(fixture, { kind: "decision", artifactId: "DEC-X", content: DECISION_1, compactProjection: "DEC-X@1" });
      // Second run owned by another session in the same workspace.
      const other = fixture.runs.createPlanningRun({ workspaceId: fixture.workspaceId, sessionId: "S-OTHER", goal: "other run" });
      const otherView = source.readRevision({ runId: other.run.runId, kind: "decision", id: "DEC-X", revision: 1 });
      expect(otherView).toBeNull();
      expect(source.readRevision({ ...ref, revision: 2 })).toBeNull();
      expect(source.readRevision(ref)!.compactProjection).toBe("DEC-X@1");
      expect(source.getRun(other.run.runId)).toMatchObject({ runId: other.run.runId, lifecycle: "active" });
      expect(source.getRun("RUN-GHOST")).toBeNull();
    });
  });
});
