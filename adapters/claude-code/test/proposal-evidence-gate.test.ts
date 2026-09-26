/**
 * Proposal Evidence gates (Phase 10 §30/§35–§45/§62–§66/§70/§72).
 *
 * Covers: prepare-time critical freshness (§35/§63), reachability through the
 * proposal's exact requiredEvidence set only (§30), post-authorization
 * re-check with provenance closure (§36/§39/§40), system-fact persistence on
 * blocked commits (§37), Approval+PlanCommit atomicity (§38/§65), idempotent
 * authorized retry semantics (§66), replace-not-rewrite for frozen proposals
 * (§43/§72), the contradicted→invalidated→blocked integration (§70), and the
 * frozen Phase 6 canonical V1 hash (§62).
 */

import { describe, expect, it } from "vitest";

import { createEvidenceFreshnessService, type RevalidateEvidenceInput } from "../src/application/evidence-freshness-service.js";
import { createEvidenceService } from "../src/application/evidence-service.js";
import { createPlanCommitEngine } from "../src/application/plan-commit-engine.js";
import { listProposalEvidenceRefsInTx } from "../src/store/evidence-freshness.js";
import { getHeadPairInTx } from "../src/store/plan-commits.js";
import { captureObservation } from "../src/observations/capture.js";
import {
  captureDeps,
  executionEvent,
  makePhase9Fixture,
  sourceEvent,
  writeSourceFile,
  type Phase9Fixture,
} from "./phase9-helpers.js";
import { DECISION_1, makeTestUserAuthorization } from "./proposal-helpers.js";
import { counterClock } from "./test-clocks.js";

let gateSeq = 0;

async function makeWorld(sessionId = "S1") {
  const f = await makePhase9Fixture(sessionId);
  return { f };
}

async function captureRaw(f: Phase9Fixture, event: Parameters<typeof captureObservation>[1]) {
  const outcome = await captureObservation(captureDeps(f, { clock: counterClock() }), event);
  expect(outcome.status).toBe("captured");
  return (outcome as { status: "captured"; observation: { observationId: string } }).observation;
}

async function promoteCriticalFingerprint(f: Phase9Fixture, content = "GATE SOURCE v1\n") {
  writeSourceFile(f, "src/gate.txt", content);
  const observation = await captureRaw(f, sourceEvent(f, "src/gate.txt", { toolUseId: `call_gate_${(gateSeq += 1)}` }));
  const promotion = createEvidenceService(f.store, f.blobs, counterClock());
  return promotion.promoteEvidence({
    runId: f.runId,
    workspaceId: f.workspaceId,
    request: {
      claim: "gate source declares v1",
      kind: "source_fact",
      scope: { type: "global" },
      confidence: "direct",
      criticality: "critical",
      observationRefs: [observation.observationId],
      derivedFrom: [],
    },
    operationId: `promote:gate${(gateSeq += 1)}`,
  });
}

function freshnessOf(f: Phase9Fixture): ReturnType<typeof createEvidenceFreshnessService> {
  return createEvidenceFreshnessService(f.store, f.blobs, counterClock());
}

function revalidateInput(
  f: Phase9Fixture,
  request: { evidenceId: string; revision: number } & Partial<RevalidateEvidenceInput["request"]>,
): RevalidateEvidenceInput {
  return {
    runId: f.runId,
    workspaceId: f.workspaceId,
    sessionId: f.sessionId,
    bindingGeneration: f.generation,
    operationId: `revalidate:gate${(gateSeq += 1)}`,
    request: { observationRefs: [], derivedFrom: [], ...request } as RevalidateEvidenceInput["request"],
  };
}

function prepareWithEvidence(
  f: Phase9Fixture,
  requiredEvidence: Array<{ evidenceId: string; revision: number }>,
  overrides: Record<string, unknown> = {},
) {
  return f.proposals.prepareProposal({
    runId: f.runId,
    workspaceId: f.workspaceId,
    sessionId: f.sessionId,
    bindingGeneration: f.generation,
    expectedRunRevision: f.runRevision,
    type: "design_checkpoint",
    scope: { kind: "architecture" },
    title: "Gate checkpoint",
    summary: "proposal with required evidence",
    changes: [
      {
        op: "ADD_DECISION",
        content: { ...DECISION_1, title: "Gate decision" },
        compactProjection: "DEC-gate@1",
      },
    ],
    requiredEvidence,
    ...overrides,
  });
}

function reviseWithEvidence(
  f: Phase9Fixture,
  proposalId: string,
  requiredEvidence: Array<{ evidenceId: string; revision: number }>,
) {
  return f.proposals.reviseProposal({
    runId: f.runId,
    workspaceId: f.workspaceId,
    sessionId: f.sessionId,
    bindingGeneration: f.generation,
    expectedRunRevision: f.runRevision,
    proposalId,
    type: "design_checkpoint",
    scope: { kind: "architecture" },
    title: "Gate checkpoint",
    summary: "revised proposal with fresh evidence",
    changes: [
      {
        op: "ADD_DECISION",
        content: { ...DECISION_1, title: "Gate decision revised" },
        compactProjection: "DEC-gate@2",
      },
    ],
    requiredEvidence,
  });
}

function commitWith(
  f: Phase9Fixture,
  proposal: { proposalId: string; revision: number; proposalHash: string },
  authorizationRequestId: string,
) {
  const engine = createPlanCommitEngine(f.store, counterClock());
  return engine.commitAuthorizedProposal({
    runId: f.runId,
    workspaceId: f.workspaceId,
    sessionId: f.sessionId,
    bindingGeneration: f.generation,
    authorization: makeTestUserAuthorization({
      proposalId: proposal.proposalId,
      proposalRevision: proposal.revision,
      proposalHash: proposal.proposalHash,
      authorizationRequestId,
    }),
  });
}

function headOf(f: Phase9Fixture) {
  return f.store.withRead((tx) => getHeadPairInTx(tx, f.runId));
}

function countOf(f: Phase9Fixture, table: string): number {
  return (f.store.withRead((tx) => tx.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()) as { n: number }).n;
}

function eventsOf(f: Phase9Fixture, evidenceId: string) {
  return f.store.withRead(
    (tx) =>
      tx
        .prepare(
          "SELECT event_type AS eventType, evidence_revision AS revision, to_state AS toState FROM evidence_validation_events WHERE run_id = ? AND evidence_id = ? ORDER BY event_seq",
        )
        .all(f.runId, evidenceId),
  ) as Array<{ eventType: string; revision: number; toState: string }>;
}

// ---------------------------------------------------------------------------

describe("Phase 10 §35/§63 — prepare-time Evidence gate", () => {
  it("critical fresh evidence allows the proposal to freeze as canonical V2 with refs", async () => {
    const { f } = await makeWorld();
    try {
      const evidence = await promoteCriticalFingerprint(f);
      const ref = { evidenceId: evidence.evidence.evidenceId, revision: evidence.evidence.revision };
      const prepared = prepareWithEvidence(f, [ref]);
      expect(prepared.proposal.status).toBe("awaiting_approval");
      // §31/§33: canonical V2, refs hashed in.
      expect(prepared.proposal.canonicalJson).toContain('"version":2');
      expect(prepared.proposal.canonicalJson).toContain('"requiredEvidence"');
      // §34: the relational index equals the canonical content.
      const refs = f.store.withRead((tx) =>
        listProposalEvidenceRefsInTx(tx, f.runId, prepared.proposal.proposalId, prepared.proposal.revision),
      );
      expect(refs).toEqual([ref]);
    } finally {
      f.close();
    }
  });

  it("critical needs_validation evidence blocks the freeze with EVIDENCE_NEEDS_VALIDATION", async () => {
    const { f } = await makeWorld();
    try {
      const evidence = await promoteCriticalFingerprint(f);
      const ref = { evidenceId: evidence.evidence.evidenceId, revision: evidence.evidence.revision };
      // The source changes before anyone prepares anything.
      writeSourceFile(f, "src/gate.txt", "changed before prepare\n");
      const drift = freshnessOf(f).revalidateEvidence(revalidateInput(f, { ...ref, mode: "check" }));
      expect(drift.status).toBe("source_changed");

      expect(() => prepareWithEvidence(f, [ref])).toThrowError(
        expect.objectContaining({ code: "EVIDENCE_NEEDS_VALIDATION" }),
      );
      // No proposal was frozen.
      expect(countOf(f, "proposal_revisions")).toBe(0);
    } finally {
      f.close();
    }
  });

  it("supporting evidence never blocks preparation (§41/E34)", async () => {
    const { f } = await makeWorld();
    try {
      const promotion = createEvidenceService(f.store, f.blobs, counterClock());
      const observation = await captureRaw(
        f,
        executionEvent(f, "supporting probe", { toolUseId: `call_supp_${(gateSeq += 1)}` }),
      );
      const supporting = promotion.promoteEvidence({
        runId: f.runId,
        workspaceId: f.workspaceId,
        request: {
          claim: "supporting execution fact",
          kind: "execution_result",
          scope: { type: "global" },
          confidence: "direct",
          criticality: "supporting",
          observationRefs: [observation.observationId],
          derivedFrom: [],
        },
        operationId: `promote:supp${(gateSeq += 1)}`,
      });
      // Drive it off fresh via an uncertain assessment: supporting must not
      // block even when non-fresh (E34).
      const ambiguous = await captureRaw(
        f,
        executionEvent(f, "ambiguous probe", { toolUseId: `call_amb_${(gateSeq += 1)}` }),
      );
      freshnessOf(f).revalidateEvidence(
        revalidateInput(f, {
          evidenceId: supporting.evidence.evidenceId,
          revision: supporting.evidence.revision,
          mode: "assess",
          assessment: "uncertain",
          observationRefs: [ambiguous.observationId],
        }),
      );
      const prepared = prepareWithEvidence(f, [
        { evidenceId: supporting.evidence.evidenceId, revision: supporting.evidence.revision },
      ]);
      expect(prepared.proposal.status).toBe("awaiting_approval");
    } finally {
      f.close();
    }
  });

  it("a required ref that does not exist in the run fails closed (EVIDENCE_STATE_INVALID)", async () => {
    const { f } = await makeWorld();
    try {
      expect(() => prepareWithEvidence(f, [{ evidenceId: "ev_missing", revision: 1 }])).toThrowError(
        expect.objectContaining({ code: "EVIDENCE_STATE_INVALID" }),
      );
    } finally {
      f.close();
    }
  });
});

describe("Phase 10 §36/§37/§64/§65 — post-authorization gate", () => {
  it("a source change before approval blocks the commit but persists the system fact", async () => {
    const { f } = await makeWorld();
    try {
      const evidence = await promoteCriticalFingerprint(f);
      const ref = { evidenceId: evidence.evidence.evidenceId, revision: evidence.evidence.revision };
      const prepared = prepareWithEvidence(f, [ref]);

      // The source changes before the user approves; the gate runs at
      // approval time and must see the non-fresh evidence (§64).
      writeSourceFile(f, "src/gate.txt", "changed after prepare\n");
      freshnessOf(f).revalidateEvidence(revalidateInput(f, { ...ref, mode: "check" }));

      const headBefore = headOf(f);
      expect(() => commitWith(f, prepared.proposal, "AUTH-blocked-1")).toThrowError(
        expect.objectContaining({ code: "EVIDENCE_NEEDS_VALIDATION" }),
      );

      // §38/§64/§65: no approval, no commit, unchanged HEAD, still awaiting.
      expect(countOf(f, "approvals")).toBe(0);
      expect(countOf(f, "plan_commits")).toBe(0);
      expect(headOf(f)).toEqual(headBefore);
      const status = f.store.withRead(
        (tx) =>
          tx
            .prepare("SELECT status FROM proposal_states WHERE run_id = ? AND proposal_id = ? AND revision = ?")
            .get(f.runId, prepared.proposal.proposalId, prepared.proposal.revision),
      ) as { status: string };
      expect(status.status).toBe("awaiting_approval");
      // §37: the state change IS persisted even though the commit is blocked.
      const events = eventsOf(f, ref.evidenceId);
      expect(events.some((e) => e.eventType === "SOURCE_CHANGED" && e.revision === ref.revision)).toBe(true);
    } finally {
      f.close();
    }
  });

  it("replace-not-rewrite: a fresh replacement does not resurrect the frozen proposal (§43/§72)", async () => {
    const { f } = await makeWorld();
    try {
      const evidence = await promoteCriticalFingerprint(f);
      const ref = { evidenceId: evidence.evidence.evidenceId, revision: evidence.evidence.revision };
      const prepared = prepareWithEvidence(f, [ref]);

      writeSourceFile(f, "src/gate.txt", "changed after prepare\n");
      const freshness = freshnessOf(f);
      freshness.revalidateEvidence(revalidateInput(f, { ...ref, mode: "check" }));

      // Revalidation confirms with new provenance → EV@2 fresh, EV@1 stale.
      const reread = await captureRaw(f, sourceEvent(f, "src/gate.txt", { toolUseId: `call_reread_${(gateSeq += 1)}` }));
      const confirmed = freshness.revalidateEvidence(
        revalidateInput(f, {
          ...ref,
          mode: "assess",
          assessment: "confirmed",
          observationRefs: [reread.observationId],
        }),
      );
      expect(confirmed.status).toBe("confirmed");
      expect(confirmed.replacement?.revision).toBe(ref.revision + 1);

      // The frozen proposal still requires EV@1 (stale) → still blocked.
      expect(() => commitWith(f, prepared.proposal, "AUTH-blocked-2")).toThrowError(
        expect.objectContaining({ code: "EVIDENCE_NEEDS_VALIDATION" }),
      );

      // §43: revise/supersede with the new exact revision, then commit.
      const revised = reviseWithEvidence(f, prepared.proposal.proposalId, [
        { evidenceId: ref.evidenceId, revision: ref.revision + 1 },
      ]);
      expect(revised.proposal.revision).toBe(2);
      expect(revised.proposal.proposalHash).not.toBe(prepared.proposal.proposalHash);
      const commit = commitWith(f, revised.proposal, "AUTH-success-1");
      expect(commit.idempotent).toBe(false);
      expect(countOf(f, "approvals")).toBe(1);
      expect(countOf(f, "plan_commits")).toBe(1);
    } finally {
      f.close();
    }
  });

  it("§66: a failed authorization writes no idempotency success; a successful one replays idempotently", async () => {
    const { f } = await makeWorld();
    try {
      const evidence = await promoteCriticalFingerprint(f);
      const ref = { evidenceId: evidence.evidence.evidenceId, revision: evidence.evidence.revision };
      const prepared = prepareWithEvidence(f, [ref]);

      writeSourceFile(f, "src/gate.txt", "changed\n");
      freshnessOf(f).revalidateEvidence(revalidateInput(f, { ...ref, mode: "check" }));

      // The blocked attempt leaves no approval row for its request id.
      expect(() => commitWith(f, prepared.proposal, "AUTH-try-once")).toThrowError(
        expect.objectContaining({ code: "EVIDENCE_NEEDS_VALIDATION" }),
      );
      expect(countOf(f, "approvals")).toBe(0);

      // Revalidate confirmed + revise, then commit successfully once…
      const reread = await captureRaw(f, sourceEvent(f, "src/gate.txt", { toolUseId: `call_reread_${(gateSeq += 1)}` }));
      freshnessOf(f).revalidateEvidence(
        revalidateInput(f, {
          ...ref,
          mode: "assess",
          assessment: "confirmed",
          observationRefs: [reread.observationId],
        }),
      );
      const revised = reviseWithEvidence(f, prepared.proposal.proposalId, [
        { evidenceId: ref.evidenceId, revision: ref.revision + 1 },
      ]);
      const first = commitWith(f, revised.proposal, "AUTH-success-once");
      expect(first.idempotent).toBe(false);
      // …and the same successful authorization replayed stays idempotent.
      const replay = commitWith(f, revised.proposal, "AUTH-success-once");
      expect(replay.idempotent).toBe(true);
      expect(countOf(f, "approvals")).toBe(1);
      expect(countOf(f, "plan_commits")).toBe(1);
    } finally {
      f.close();
    }
  });
});

describe("Phase 10 §70 — contradicted → invalidated → gate blocked (integration)", () => {
  it("a contradicted critical requirement blocks the commit", async () => {
    const { f } = await makeWorld();
    try {
      const evidence = await promoteCriticalFingerprint(f);
      const ref = { evidenceId: evidence.evidence.evidenceId, revision: evidence.evidence.revision };
      const prepared = prepareWithEvidence(f, [ref]);

      const contradiction = await captureRaw(
        f,
        executionEvent(f, "contradicting probe", { toolUseId: `call_contra_${(gateSeq += 1)}` }),
      );
      freshnessOf(f).revalidateEvidence(
        revalidateInput(f, {
          ...ref,
          mode: "assess",
          assessment: "contradicted",
          observationRefs: [contradiction.observationId],
        }),
      );
      expect(() => commitWith(f, prepared.proposal, "AUTH-contradicted")).toThrowError(
        expect.objectContaining({ code: "EVIDENCE_NEEDS_VALIDATION" }),
      );
      expect(countOf(f, "approvals")).toBe(0);
      expect(countOf(f, "plan_commits")).toBe(0);
    } finally {
      f.close();
    }
  });
});

describe("Phase 10 §62 — canonical V1 historical hash compatibility", () => {
  it("the Phase 6 V1 canonical serialization is frozen (no rewrite, no rehash)", async () => {
    const { canonicalProposalHash, buildProposalCanonicalV1 } = await import("../src/core/proposal-canonical.js");
    const v1 = buildProposalCanonicalV1({
      runId: "RUN-FIXED",
      proposalId: "PROP-FIXED",
      proposalRevision: 1,
      type: "design_checkpoint",
      scope: { kind: "architecture" },
      baseRunRevision: 1,
      baseHeadSnapshotId: null,
      baseHeadCommitId: null,
      title: "t",
      summary: "s",
      changes: [],
      dependencies: [],
      impact: { affected: [], notes: [] },
    });
    // Frozen golden (sha256 over the sorted-key canonical text of this exact
    // V1 value, independently computed): must never change in any release.
    expect(canonicalProposalHash(v1)).toBe(
      "sha256:1a9d50ac00a4a597cf433f0e6e1864c44730450995c7709bedee52e7e8ba7182",
    );
  });
});
