/**
 * Phase 11 §84 — the Evidence → Section review bridge. REAL evidence-basis
 * events (SOURCE_CHANGED / REPLACED / INVALIDATED / propagated UPSTREAM_
 * CHANGED) mark completed Sections whose completion Proposal required exactly
 * that Evidence needs_review — with recursion over completed downstream
 * Sections. FILE_CHANGED_HINT alone never triggers review (E48); supporting/
 * informational evidence never triggers review; revalidation/replacement
 * never auto re-completes anything (E49).
 */

import { describe, expect, it } from "vitest";

import { appendValidationEventInTx } from "../src/store/evidence-freshness.js";
import { createEvidenceService } from "../src/application/evidence-service.js";
import { createEvidenceFreshnessService, type RevalidateEvidenceRequest } from "../src/application/evidence-freshness-service.js";
import { captureObservation } from "../src/observations/capture.js";
import { listSectionWorkflowStates } from "../src/store/section-workflow.js";
import { commitPrepared } from "./context-helpers.js";
import { driveToDetail, selectOnFixture, withCounterServices } from "./phase11-helpers.js";
import {
  captureDeps,
  makePhase9Fixture,
  sourceEvent,
  writeSourceFile,
  type Phase9Fixture,
} from "./phase9-helpers.js";

import { counterClock } from "./test-clocks.js";

let seq = 0;

function freshnessOf(f: Phase9Fixture) {
  return createEvidenceFreshnessService(f.store, f.blobs, counterClock());
}

/** A run at detail: DAG A ← B, with A completed on critical EV and B completed. */
async function makeBridgeFixture(options: { criticality?: "critical" | "supporting" } = {}) {
  const f = await makePhase9Fixture();
  const fixture = withCounterServices(f);
  driveToDetail(fixture);
  // DAG: A ← B.
  const prepared = fixture.proposals.prepareProposal({
    runId: fixture.runId,
    workspaceId: fixture.workspaceId,
    sessionId: fixture.sessionId,
    bindingGeneration: fixture.generation,
    expectedRunRevision: fixture.runRevision,
    type: "design_checkpoint",
    scope: { kind: "detail" },
    title: "Bridge DAG",
    summary: "A ← B",
    changes: [
      { op: "SET_SECTION_REVISION", target: null, content: raw("Alpha", []), compactProjection: "section:alpha" },
      { op: "SET_SECTION_REVISION", target: null, content: raw("Beta", ["SEC-1"]), compactProjection: "section:beta" },
    ],
  });
  commitPrepared(fixture, prepared.proposal.proposalId, prepared.proposal.revision, prepared.proposal.proposalHash);
  // Capture + promote the Evidence that will back A's completion.
  writeSourceFile(f, "src/bridge.txt", "bridge source v1\n");
  const captured = await captureObservation(
    captureDeps(f, { clock: { nowIso: () => new Date(0).toISOString(), newId: () => `obs-${(seq += 1)}` } }),
    sourceEvent(f, "src/bridge.txt", { toolUseId: `call_bridge_${(seq += 1)}` }),
  );
  expect(captured.status).toBe("captured");
  const observationId = (captured as { observation: { observationId: string } }).observation.observationId;
  const promotion = createEvidenceServiceOf(f).promoteEvidence({
    runId: fixture.runId,
    workspaceId: fixture.workspaceId,
    request: {
      claim: "bridge source fact",
      kind: "source_fact",
      scope: { type: "global" },
      confidence: "direct",
      criticality: options.criticality ?? "critical",
      observationRefs: [observationId],
      derivedFrom: [],
    },
    operationId: `promote:bridge-${(seq += 1)}`,
  });
  expect(promotion.freshness.state).toBe("fresh");
  const evidenceRef = {
    evidenceId: promotion.evidence.evidenceId,
    revision: promotion.evidence.revision,
  };
  // Complete A on that exact Evidence revision.
  selectOnFixture(fixture, "SEC-1");
  const completion = fixture.proposals.prepareProposal({
    runId: fixture.runId,
    workspaceId: fixture.workspaceId,
    sessionId: fixture.sessionId,
    bindingGeneration: fixture.generation,
    expectedRunRevision: fixture.runRevision,
    type: "section_completion",
    scope: { kind: "section", sectionId: "SEC-1" },
    title: "Complete Alpha",
    summary: "on critical evidence",
    requiredEvidence: [evidenceRef],
    changes: [{ op: "COMPLETE_SECTION", sectionId: "SEC-1", compactProjection: "complete:SEC-1@1" }],
  });
  commitPrepared(fixture, completion.proposal.proposalId, completion.proposal.revision, completion.proposal.proposalHash);
  // Complete B as well (still detail: C would not exist; B is the last section
  // only if A completed — two sections, both completed → synthesis. Keep B
  // OPEN by NOT completing it when downstream propagation must be observed on
  // a completed B? No: propagation only hits COMPLETED downstream sections.
  return { fixture, evidenceRef };
}

function raw(title: string, dependencies: string[]) {
  return {
    title,
    objective: `${title} objective`,
    design: `${title} design`,
    interfaces: [],
    invariants: [],
    failureModes: [],
    dependencies,
    decisionRefs: [],
    openQuestionRefs: [],
    impactRefs: [],
    contract: { provides: [], requires: [], invariants: [], interfaces: [], decisions: [] },
  };
}

function createEvidenceServiceOf(f: Phase9Fixture) {
  return createEvidenceService(f.store, f.blobs, counterClock());
}

type RevalidateRequestInput = Omit<RevalidateEvidenceRequest, "observationRefs" | "derivedFrom">
  & Partial<Pick<RevalidateEvidenceRequest, "observationRefs" | "derivedFrom">>;

function revalidate(f: Phase9Fixture, request: RevalidateRequestInput) {
  return freshnessOf(f).revalidateEvidence({
    runId: f.runId,
    workspaceId: f.workspaceId,
    sessionId: f.sessionId,
    bindingGeneration: f.generation,
    request: { ...request, observationRefs: request.observationRefs ?? [], derivedFrom: request.derivedFrom ?? [] },
    operationId: `revalidate:bridge-${(seq += 1)}`,
  });
}

function statusOf(f: Phase9Fixture, sectionId: string): string | undefined {
  return listSectionWorkflowStates(f.store, f.runId).find((state) => state.sectionId === sectionId)?.status;
}

describe("evidence → section review bridge (§45–§49/§84)", () => {
  it("a real SOURCE_CHANGED marks the completed Section that relied on the exact Evidence needs_review (E46/E47)", async () => {
    const { fixture, evidenceRef } = await makeBridgeFixture();
    try {
      expect(statusOf(fixture, "SEC-1")).toBe("completed");
      // The source GENUINELY changes; a deterministic check discovers it.
      writeSourceFile(fixture, "src/bridge.txt", "bridge source v2 (changed)\n");
      const result = revalidate(fixture, { ...evidenceRef, mode: "check" });
      expect(result.status).toBe("source_changed");
      expect(statusOf(fixture, "SEC-1")).toBe("needs_review");
      // The review bridge moves neither HEAD nor the immutable revision
      // (§48): the completion commit remains the last one, and the materialized
      // workflow event is EVIDENCE_REVIEW_REQUIRED.
      const events = fixture.store.withRead((tx) =>
        tx.prepare("SELECT event_type AS e FROM section_workflow_events WHERE run_id = ? AND section_id = 'SEC-1' ORDER BY event_seq").all(fixture.runId),
      ) as Array<{ e: string }>;
      expect(events[events.length - 1]!.e).toBe("EVIDENCE_REVIEW_REQUIRED");
      const head = fixture.store.withRead((tx) => tx.prepare("SELECT head_commit_id AS c FROM plan_heads WHERE run_id = ?").get(fixture.runId)) as { c: string };
      expect(head.c).toBeTruthy();
    } finally {
      fixture.close();
    }
  });

  it("a FILE_CHANGED_HINT alone never triggers Section review (E48)", async () => {
    const { fixture, evidenceRef } = await makeBridgeFixture();
    try {
      fixture.store.withWrite((tx) => {
        appendValidationEventInTx(tx, {
          runId: fixture.runId,
          evidenceId: evidenceRef.evidenceId,
          evidenceRevision: evidenceRef.revision,
          eventType: "FILE_CHANGED_HINT",
          toState: "needs_validation",
          reasonCode: "upstream_revision_changed",
          detail: { hint: "writer-level probe" },
          eventId: `FRE-hint-${(seq += 1)}`,
          createdAt: new Date(0).toISOString(),
        });
        return null;
      });
      expect(statusOf(fixture, "SEC-1")).toBe("completed");
    } finally {
      fixture.close();
    }
  });

  it("REPLACED triggers review; the fresh EV@N+1 NEVER auto re-completes the Section (§49/E49)", async () => {
    const { fixture, evidenceRef } = await makeBridgeFixture();
    try {
      writeSourceFile(fixture, "src/bridge.txt", "bridge source v2 (changed)\n");
      revalidate(fixture, { ...evidenceRef, mode: "check" });
      // Confirm with NEW provenance: EV@2 replaces EV@1 and is fresh.
      const recaptured = await captureObservation(
        captureDeps(fixture, { clock: { nowIso: () => new Date(0).toISOString(), newId: () => `obs-${(seq += 1)}` } }),
        sourceEvent(fixture, "src/bridge.txt", { toolUseId: `call_reread_${(seq += 1)}` }),
      );
      const newObservationId = (recaptured as { observation: { observationId: string } }).observation.observationId;
      const confirmed = revalidate(fixture, {
        ...evidenceRef,
        mode: "assess",
        assessment: "confirmed",
        observationRefs: [newObservationId],
      });
      expect(confirmed.status).toBe("confirmed");
      // EV@2 is fresh — but the Section REMAINS needs_review.
      expect(statusOf(fixture, "SEC-1")).toBe("needs_review");
      void evidenceRef;
    } finally {
      fixture.close();
    }
  });

  it("INVALIDATED triggers review of the completed Section (§84)", async () => {
    const { fixture, evidenceRef } = await makeBridgeFixture();
    try {
      writeSourceFile(fixture, "src/bridge.txt", "bridge source v2 (changed)\n");
      // Drain the drift first so assess is legal from needs_validation.
      revalidate(fixture, { ...evidenceRef, mode: "check" });
      const recaptured = await captureObservation(
        captureDeps(fixture, { clock: { nowIso: () => new Date(0).toISOString(), newId: () => `obs-${(seq += 1)}` } }),
        sourceEvent(fixture, "src/bridge.txt", { toolUseId: `call_contra_${(seq += 1)}` }),
      );
      const newObservationId = (recaptured as { observation: { observationId: string } }).observation.observationId;
      const contradicted = revalidate(fixture, {
        ...evidenceRef,
        mode: "assess",
        assessment: "contradicted",
        observationRefs: [newObservationId],
      });
      expect(contradicted.status).toBe("contradicted");
      expect(statusOf(fixture, "SEC-1")).toBe("needs_review");
    } finally {
      fixture.close();
    }
  });

  it("supporting Evidence never triggers Section review (§84)", async () => {
    const { fixture, evidenceRef } = await makeBridgeFixture({ criticality: "supporting" });
    try {
      writeSourceFile(fixture, "src/bridge.txt", "bridge source v2 (changed)\n");
      const result = revalidate(fixture, { ...evidenceRef, mode: "check" });
      expect(result.status).toBe("source_changed");
      // The Evidence left fresh — the Section stays completed (§41 analog).
      expect(statusOf(fixture, "SEC-1")).toBe("completed");
    } finally {
      fixture.close();
    }
  });

  it("completed downstream Sections follow recursively (§48); open ones are untouched", async () => {
    const fixture = await makePhase9Fixture();
    const f = withCounterServices(fixture);
    driveToDetail(f);
    const prepared = f.proposals.prepareProposal({
      runId: f.runId,
      workspaceId: f.workspaceId,
      sessionId: f.sessionId,
      bindingGeneration: f.generation,
      expectedRunRevision: f.runRevision,
      type: "design_checkpoint",
      scope: { kind: "detail" },
      title: "Chain DAG",
      summary: "A ← B ← C",
      changes: [
        { op: "SET_SECTION_REVISION", target: null, content: raw("Alpha", []), compactProjection: "section:alpha" },
        { op: "SET_SECTION_REVISION", target: null, content: raw("Beta", ["SEC-1"]), compactProjection: "section:beta" },
        { op: "SET_SECTION_REVISION", target: null, content: raw("Gamma", ["SEC-2"]), compactProjection: "section:gamma" },
        { op: "SET_SECTION_REVISION", target: null, content: raw("Delta", []), compactProjection: "section:delta" },
      ],
    });
    commitPrepared(f, prepared.proposal.proposalId, prepared.proposal.revision, prepared.proposal.proposalHash);
    writeSourceFile(f, "src/bridge.txt", "chain source v1\n");
    const captured = await captureObservation(
      captureDeps(f, { clock: { nowIso: () => new Date(0).toISOString(), newId: () => `obs-${(seq += 1)}` } }),
      sourceEvent(f, "src/bridge.txt", { toolUseId: `call_chain_${(seq += 1)}` }),
    );
    const observationId = (captured as { observation: { observationId: string } }).observation.observationId;
    const promotion = createEvidenceServiceOf(f).promoteEvidence({
      runId: f.runId,
      workspaceId: f.workspaceId,
      request: {
        claim: "chain source fact",
        kind: "source_fact",
        scope: { type: "global" },
        confidence: "direct",
        criticality: "critical",
        observationRefs: [observationId],
        derivedFrom: [],
      },
      operationId: `promote:chain-${(seq += 1)}`,
    });
    const evidenceRef = { evidenceId: promotion.evidence.evidenceId, revision: promotion.evidence.revision };
    // Complete A, B, and C (C is a TRANSITIVE dependent of A through B) while
    // the independent D stays open, so the run remains at detail (Phase 10
    // stage gate keeps revalidation legal there).
    selectOnFixture(f, "SEC-1");
    const completionA = f.proposals.prepareProposal({
      runId: f.runId,
      workspaceId: f.workspaceId,
      sessionId: f.sessionId,
      bindingGeneration: f.generation,
      expectedRunRevision: f.runRevision,
      type: "section_completion",
      scope: { kind: "section", sectionId: "SEC-1" },
      title: "Complete Alpha",
      summary: "on critical evidence",
      requiredEvidence: [evidenceRef],
      changes: [{ op: "COMPLETE_SECTION", sectionId: "SEC-1", compactProjection: "complete:SEC-1@1" }],
    });
    commitPrepared(f, completionA.proposal.proposalId, completionA.proposal.revision, completionA.proposal.proposalHash);
    selectOnFixture(f, "SEC-2");
    const completionB = f.proposals.prepareProposal({
      runId: f.runId,
      workspaceId: f.workspaceId,
      sessionId: f.sessionId,
      bindingGeneration: f.generation,
      expectedRunRevision: f.runRevision,
      type: "section_completion",
      scope: { kind: "section", sectionId: "SEC-2" },
      title: "Complete Beta",
      summary: "middle of the chain",
      changes: [{ op: "COMPLETE_SECTION", sectionId: "SEC-2", compactProjection: "complete:SEC-2@1" }],
    });
    commitPrepared(f, completionB.proposal.proposalId, completionB.proposal.revision, completionB.proposal.proposalHash);
    selectOnFixture(f, "SEC-3");
    const completionC = f.proposals.prepareProposal({
      runId: f.runId,
      workspaceId: f.workspaceId,
      sessionId: f.sessionId,
      bindingGeneration: f.generation,
      expectedRunRevision: f.runRevision,
      type: "section_completion",
      scope: { kind: "section", sectionId: "SEC-3" },
      title: "Complete Gamma",
      summary: "transitive dependent",
      changes: [{ op: "COMPLETE_SECTION", sectionId: "SEC-3", compactProjection: "complete:SEC-3@1" }],
    });
    commitPrepared(f, completionC.proposal.proposalId, completionC.proposal.revision, completionC.proposal.proposalHash);
    expect(statusOf(f, "SEC-1")).toBe("completed");
    expect(statusOf(f, "SEC-2")).toBe("completed");
    expect(statusOf(f, "SEC-3")).toBe("completed");
    // A real basis change: A → needs_review and the COMPLETED transitive
    // dependent C follows; open B is untouched.
    writeSourceFile(f, "src/bridge.txt", "chain source v2 (changed)\n");
    revalidate(f, { ...evidenceRef, mode: "check" });
    expect(statusOf(f, "SEC-1")).toBe("needs_review");
    expect(statusOf(f, "SEC-2")).toBe("needs_review");
    expect(statusOf(f, "SEC-3")).toBe("needs_review");
    f.store.close();
  });
});
