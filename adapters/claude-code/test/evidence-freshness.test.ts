/**
 * Evidence freshness semantics (Phase 10 §9–§17/§20–§29/§57–§61/§71).
 *
 * Covers: promotion-time initialization (§10), the transition matrix (§57),
 * deterministic fingerprint checks (§58), reobserve semantics (§59/§14/§46),
 * invalidation (§60/§24), derived propagation (§61/§16), revalidation
 * idempotency (§27), current-revision fencing (§26), confirmed-revalidation
 * failure semantics (§23), and the absence of any bypass flag (§71).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
  createEvidenceFreshnessService,
  type RevalidateEvidenceInput,
  type RevalidateEvidenceResult,
} from "../src/application/evidence-freshness-service.js";
import { createEvidenceService } from "../src/application/evidence-service.js";
import { isTransitionAllowed } from "../src/evidence/freshness.js";
import { appendValidationEventInTx, getCurrentState } from "../src/store/evidence-freshness.js";
import { captureObservation } from "../src/observations/capture.js";
import {
  captureDeps,
  executionEvent,
  makePhase9Fixture,
  sourceEvent,
  writeSourceFile,
  type Phase9Fixture,
} from "./phase9-helpers.js";
import type { StoreClock } from "../src/store/migration-runner.js";

let clockCounter = 0;
let uniqueIds = 0;

/** Globally-unique ids: evidence ids are UNIQUE across the whole store. */
function counterClock(): StoreClock {
  return {
    nowIso: () => new Date(0).toISOString(),
    newId: () => `u${(uniqueIds += 1)}`,
  };
}

function services(f: Phase9Fixture) {
  const promotion = createEvidenceService(f.store, f.blobs, counterClock());
  const freshness = createEvidenceFreshnessService(f.store, f.blobs, counterClock());
  return { promotion, freshness };
}

let revalidateSeq = 0;

type Revalidate = (
  f: Phase9Fixture,
  freshness: ReturnType<typeof createEvidenceFreshnessService>,
  request: { evidenceId: string; revision: number } & Partial<RevalidateEvidenceInput["request"]>,
  operationId?: string,
) => RevalidateEvidenceResult;

const revalidate: Revalidate = (f, freshness, request, operationId) => {
  const input: RevalidateEvidenceInput = {
    runId: f.runId,
    workspaceId: f.workspaceId,
    sessionId: f.sessionId,
    bindingGeneration: f.generation,
    operationId: operationId ?? `revalidate:op${(revalidateSeq += 1)}`,
    request: {
      mode: "check",
      observationRefs: [],
      derivedFrom: [],
      ...request,
    },
  };
  return freshness.revalidateEvidence(input);
};

/** Capture one source observation and promote it as critical source_fact. */
async function promoteSourceEvidence(
  f: Phase9Fixture,
  options: { relative?: string; content?: string } = {},
) {
  const relative = options.relative ?? "src/claim.txt";
  const content = options.content ?? "PHASE10 CLAIM SOURCE alpha\n";
  writeSourceFile(f, relative, content);
  const outcome = await captureObservation(
    captureDeps(f, { clock: { nowIso: () => new Date(0).toISOString(), newId: () => `obs${(clockCounter += 100)}` } }),
    sourceEvent(f, relative),
  );
  expect(outcome.status).toBe("captured");
  const observation = (outcome as { status: "captured"; observation: { observationId: string } }).observation;
  const { promotion } = services(f);
  const result = promotion.promoteEvidence({
    runId: f.runId,
    workspaceId: f.workspaceId,
    request: {
      claim: "the source file declares alpha",
      kind: "source_fact",
      scope: { type: "global" },
      confidence: "direct",
      criticality: "critical",
      observationRefs: [observation.observationId],
      derivedFrom: [],
    },
    operationId: `promote:${(clockCounter += 10)}`,
  });
  return { observation, result };
}

async function promoteExecutionEvidence(f: Phase9Fixture) {
  const outcome = await captureObservation(
    captureDeps(f, { clock: { nowIso: () => new Date(0).toISOString(), newId: () => `obs${(clockCounter += 100)}` } }),
    executionEvent(f, "Get-Process -Name idle"),
  );
  expect(outcome.status).toBe("captured");
  const observation = (outcome as { status: "captured"; observation: { observationId: string } }).observation;
  const { promotion } = services(f);
  return promotion.promoteEvidence({
    runId: f.runId,
    workspaceId: f.workspaceId,
    request: {
      claim: "the idle process exists",
      kind: "execution_result",
      scope: { type: "global" },
      confidence: "direct",
      criticality: "supporting",
      observationRefs: [observation.observationId],
      derivedFrom: [],
    },
    operationId: `promote:${(clockCounter += 10)}`,
  });
}

async function captureRaw(f: Phase9Fixture, event: Parameters<typeof captureObservation>[1]) {
  const outcome = await captureObservation(
    captureDeps(f, { clock: { nowIso: () => new Date(0).toISOString(), newId: () => `obs${(clockCounter += 100)}` } }),
    event,
  );
  expect(outcome.status).toBe("captured");
  return (outcome as { status: "captured"; observation: { observationId: string } }).observation;
}

// ---------------------------------------------------------------------------

describe("Phase 10 §10 — promotion initializes freshness", () => {
  it("fingerprint Evidence whose source is unchanged promotes fresh", async () => {
    const f = await makePhase9Fixture();
    try {
      const { result } = await promoteSourceEvidence(f);
      expect(result.freshness.state).toBe("fresh");
      expect(result.freshness.reasonCode).toBe("promotion_fingerprint_match");
      expect(getCurrentState(f.store, f.runId, result.evidence.evidenceId, result.evidence.revision)).toBe("fresh");
    } finally {
      f.close();
    }
  });

  it("fingerprint Evidence whose source changed before promotion promotes needs_validation", async () => {
    const f = await makePhase9Fixture();
    try {
      writeSourceFile(f, "src/claim.txt", "original\n");
      const observation = await captureRaw(f, sourceEvent(f, "src/claim.txt"));
      // The file changes AFTER the observation but BEFORE the promotion —
      // the §10 re-comparison catches it at promotion time.
      writeSourceFile(f, "src/claim.txt", "changed before promotion\n");
      const { promotion } = services(f);
      const result = promotion.promoteEvidence({
        runId: f.runId,
        workspaceId: f.workspaceId,
        request: {
          claim: "stale at birth",
          kind: "source_fact",
          scope: { type: "global" },
          confidence: "direct",
          criticality: "critical",
          observationRefs: [observation.observationId],
          derivedFrom: [],
        },
        operationId: `promote:${(clockCounter += 10)}`,
      });
      expect(result.freshness.state).toBe("needs_validation");
      expect(result.freshness.reasonCode).toBe("promotion_fingerprint_mismatch");
    } finally {
      f.close();
    }
  });

  it("fingerprint Evidence with a deleted source promotes needs_validation (unreadable, §10)", async () => {
    const f = await makePhase9Fixture();
    try {
      const { observation } = await promoteSourceEvidence(f);
      fs.unlinkSync(path.join(f.workspaceRoot, "src/claim.txt"));
      const { promotion } = services(f);
      const result = promotion.promoteEvidence({
        runId: f.runId,
        workspaceId: f.workspaceId,
        request: {
          claim: "source vanished",
          kind: "source_fact",
          scope: { type: "global" },
          confidence: "direct",
          criticality: "critical",
          observationRefs: [observation.observationId],
          derivedFrom: [],
        },
        operationId: `promote:${(clockCounter += 10)}`,
      });
      expect(result.freshness.state).toBe("needs_validation");
      expect(result.freshness.reasonCode).toBe("promotion_source_unreadable");
    } finally {
      f.close();
    }
  });

  it("reobserve (execution) Evidence promotes fresh as last-known observation state", async () => {
    const f = await makePhase9Fixture();
    try {
      const result = await promoteExecutionEvidence(f);
      expect(result.evidence.validationStrategy).toBe("reobserve");
      expect(result.freshness.state).toBe("fresh");
      expect(result.freshness.reasonCode).toBe("promotion_reobserve_last_known");
    } finally {
      f.close();
    }
  });

  it("derived Evidence starts fresh only when every exact upstream revision is fresh", async () => {
    const f = await makePhase9Fixture();
    try {
      const upstream = await promoteSourceEvidence(f);
      const upstreamRef = {
        evidenceId: upstream.result.evidence.evidenceId,
        revision: upstream.result.evidence.revision,
      };
      // Force the upstream out of fresh.
      writeSourceFile(f, "src/claim.txt", "upstream changed\n");
      const freshness = services(f).freshness;
      const drift = revalidate(f, freshness, { ...upstreamRef, mode: "check" });
      expect(drift.status).toBe("source_changed");

      const { promotion } = services(f);
      const derived = promotion.promoteEvidence({
        runId: f.runId,
        workspaceId: f.workspaceId,
        request: {
          claim: "derived from a non-fresh upstream",
          kind: "derived_claim",
          scope: { type: "global" },
          confidence: "derived",
          criticality: "critical",
          observationRefs: [],
          derivedFrom: [upstreamRef],
        },
        operationId: `promote:${(clockCounter += 10)}`,
      });
      expect(derived.freshness.state).toBe("needs_validation");
      expect(derived.freshness.reasonCode).toBe("promotion_upstream_not_fresh");
    } finally {
      f.close();
    }
  });
});

describe("Phase 10 §57/§58 — deterministic fingerprint transitions", () => {
  it("fresh → needs_validation → fresh (change, then revert + check)", async () => {
    const f = await makePhase9Fixture();
    try {
      const { result } = await promoteSourceEvidence(f);
      const ref = { evidenceId: result.evidence.evidenceId, revision: result.evidence.revision };
      const freshness = services(f).freshness;

      writeSourceFile(f, "src/claim.txt", "changed\n");
      const changed = revalidate(f, freshness, { ...ref, mode: "check" });
      expect(changed.status).toBe("source_changed");
      expect(changed.target.current_state).toBe("needs_validation");

      writeSourceFile(f, "src/claim.txt", "PHASE10 CLAIM SOURCE alpha\n");
      const restored = revalidate(f, freshness, { ...ref, mode: "check" });
      expect(restored.status).toBe("validated");
      expect(restored.target.current_state).toBe("fresh");
    } finally {
      f.close();
    }
  });

  it("deleted source → needs_validation; recreated source → fresh again (false-hint restore path, §44/§58)", async () => {
    const f = await makePhase9Fixture();
    try {
      const { result } = await promoteSourceEvidence(f);
      const ref = { evidenceId: result.evidence.evidenceId, revision: result.evidence.revision };
      const freshness = services(f).freshness;

      fs.unlinkSync(path.join(f.workspaceRoot, "src/claim.txt"));
      const gone = revalidate(f, freshness, { ...ref, mode: "check" });
      expect(gone.status).toBe("source_changed");
      expect(gone.reason).toBe("revalidation_check_source_unreadable");

      // The "false positive" resolution: the exact source bytes return, the
      // deterministic check restores fresh (needs_validation → fresh).
      writeSourceFile(f, "src/claim.txt", "PHASE10 CLAIM SOURCE alpha\n");
      const back = revalidate(f, freshness, { ...ref, mode: "check" });
      expect(back.status).toBe("validated");
    } finally {
      f.close();
    }
  });

  it("a source path resolving outside the workspace fails closed (§13)", async () => {
    const f = await makePhase9Fixture();
    try {
      // An observation captured with an ABSOLUTE path outside the workspace
      // records that path verbatim (§74: exact provenance); the fingerprint
      // check must refuse to resolve it and treat it as unreadable.
      const outside = path.resolve(f.workspaceRoot, "../outside-workspace.txt");
      fs.writeFileSync(outside, "outside content\n", "utf8");
      try {
        const observation = await captureRaw(
          f,
          sourceEvent(f, outside, { toolUseId: "call_outside1" }),
        );
        const { promotion } = services(f);
        const result = promotion.promoteEvidence({
          runId: f.runId,
          workspaceId: f.workspaceId,
          request: {
            claim: "outside path claim",
            kind: "source_fact",
            scope: { type: "global" },
            confidence: "direct",
            criticality: "critical",
            observationRefs: [observation.observationId],
            derivedFrom: [],
          },
          operationId: `promote:${(clockCounter += 10)}`,
        });
        // The recorded path is exact (normalized separators); it must NOT be workspace-relative.
        expect(result.evidence.sourceFingerprints[0]?.path).toContain("outside-workspace.txt");
        expect(result.evidence.sourceFingerprints[0]?.path).not.toBe("outside-workspace.txt");
        const freshness = services(f).freshness;
        const check = revalidate(f, freshness, {
          evidenceId: result.evidence.evidenceId,
          revision: result.evidence.revision,
          mode: "check",
        });
        expect(check.status).toBe("source_changed");
        expect(check.reason).toBe("revalidation_check_source_unreadable");
      } finally {
        fs.rmSync(outside, { force: true });
      }
    } finally {
      f.close();
    }
  });

  it("mode=check applies only to fingerprint-validated Evidence (§21)", async () => {
    const f = await makePhase9Fixture();
    try {
      const result = await promoteExecutionEvidence(f);
      const freshness = services(f).freshness;
      expect(() =>
        revalidate(f, freshness, { evidenceId: result.evidence.evidenceId, revision: result.evidence.revision, mode: "check" }),
      ).toThrowError(expect.objectContaining({ code: "EVIDENCE_REVALIDATION_INVALID" }));
    } finally {
      f.close();
    }
  });

  it("FILE_CHANGED_HINT moves fresh → needs_validation only, and a subsequent unchanged check restores fresh", async () => {
    const f = await makePhase9Fixture();
    try {
      const { result } = await promoteSourceEvidence(f);
      const ref = { evidenceId: result.evidence.evidenceId, revision: result.evidence.revision };
      // The hint event type has no producer on the probed host (§18) — its
      // transition semantics are pinned at the writer level.
      expect(isTransitionAllowed("FILE_CHANGED_HINT", "fresh")).toBe(true);
      expect(isTransitionAllowed("FILE_CHANGED_HINT", "needs_validation")).toBe(false);
      expect(isTransitionAllowed("FILE_CHANGED_HINT", "stale")).toBe(false);
      f.store.withWrite((tx) => {
        appendValidationEventInTx(tx, {
          runId: f.runId,
          evidenceId: ref.evidenceId,
          evidenceRevision: ref.revision,
          eventType: "FILE_CHANGED_HINT",
          toState: "needs_validation",
          reasonCode: "upstream_revision_changed",
          detail: { hint: "test" },
          eventId: "FRE-hint-1",
          createdAt: new Date(0).toISOString(),
        });
        return null;
      });
      expect(getCurrentState(f.store, f.runId, ref.evidenceId, ref.revision)).toBe("needs_validation");

      // Hash unchanged → deterministic check restores fresh (§17/§44).
      const freshness = services(f).freshness;
      const restored = revalidate(f, freshness, { ...ref, mode: "check" });
      expect(restored.status).toBe("validated");
      expect(getCurrentState(f.store, f.runId, ref.evidenceId, ref.revision)).toBe("fresh");
    } finally {
      f.close();
    }
  });
});

describe("Phase 10 §23/§24/§26 — semantic revalidation", () => {
  async function confirmedFlow(f: Phase9Fixture) {
    const first = await promoteSourceEvidence(f, { content: "claim source v1\n" });
    const ref = { evidenceId: first.result.evidence.evidenceId, revision: first.result.evidence.revision };
    // Source genuinely changes → needs_validation.
    writeSourceFile(f, "src/claim.txt", "claim source v2 (changed)\n");
    const freshness = services(f).freshness;
    const drifted = revalidate(f, freshness, { ...ref, mode: "check" });
    expect(drifted.status).toBe("source_changed");
    // The model reads the changed source again (new Observation) and confirms.
    const newObservation = await captureRaw(
      f,
      sourceEvent(f, "src/claim.txt", { toolUseId: `call_reread_${(clockCounter += 1)}` }),
    );
    return { first, ref, freshness, newObservation };
  }

  it("confirmed creates a fresh replacement and stales the old exact revision", async () => {
    const f = await makePhase9Fixture();
    try {
      const { first, ref, freshness, newObservation } = await confirmedFlow(f);
      const confirmed = revalidate(f, freshness, {
        ...ref,
        mode: "assess",
        assessment: "confirmed",
        observationRefs: [newObservation.observationId],
      });
      expect(confirmed.status).toBe("confirmed");
      expect(confirmed.target.current_state).toBe("stale");
      expect(confirmed.replacement?.evidence_id).toBe(ref.evidenceId);
      expect(confirmed.replacement?.revision).toBe(ref.revision + 1);
      expect(confirmed.replacement?.state).toBe("fresh");
      // Same claim semantics; new provenance.
      const replacement = f.store.withRead((tx) =>
        tx
          .prepare("SELECT claim FROM evidence_revisions WHERE run_id = ? AND evidence_id = ? AND revision = ?")
          .get(f.runId, ref.evidenceId, ref.revision + 1),
      ) as { claim: string };
      expect(replacement.claim).toBe(first.result.evidence.claim);
      const refs = f.store.withRead((tx) =>
        tx
          .prepare(
            "SELECT observation_id AS observationId FROM evidence_observation_refs WHERE run_id = ? AND evidence_id = ? AND revision = ?",
          )
          .all(f.runId, ref.evidenceId, ref.revision + 1),
      ) as Array<{ observationId: string }>;
      expect(refs.map((r) => r.observationId)).toEqual([newObservation.observationId]);
    } finally {
      f.close();
    }
  });

  it("confirmed with provenance that cannot validate fresh fails WITHOUT creating a revision (§23)", async () => {
    const f = await makePhase9Fixture();
    try {
      const upstream = await promoteSourceEvidence(f);
      const upstreamRef = {
        evidenceId: upstream.result.evidence.evidenceId,
        revision: upstream.result.evidence.revision,
      };
      const { promotion } = services(f);
      // B derived from A; then A drifts out of fresh.
      const derived = promotion.promoteEvidence({
        runId: f.runId,
        workspaceId: f.workspaceId,
        request: {
          claim: "derived claim",
          kind: "derived_claim",
          scope: { type: "global" },
          confidence: "derived",
          criticality: "critical",
          observationRefs: [],
          derivedFrom: [upstreamRef],
        },
        operationId: `promote:${(clockCounter += 10)}`,
      });
      writeSourceFile(f, "src/claim.txt", "upstream changed\n");
      const freshness = services(f).freshness;
      expect(revalidate(f, freshness, { ...upstreamRef, mode: "check" }).status).toBe("source_changed");

      // Confirmed revalidation of B, citing the still-not-fresh A@1: the new
      // revision could not validate fresh → the WHOLE revalidation fails.
      expect(() =>
        revalidate(f, freshness, {
          evidenceId: derived.evidence.evidenceId,
          revision: derived.evidence.revision,
          mode: "assess",
          assessment: "confirmed",
          derivedFrom: [upstreamRef],
        }),
      ).toThrowError(expect.objectContaining({ code: "EVIDENCE_PROVENANCE_STALE" }));
      const count = f.store.withRead(
        (tx) =>
          tx
            .prepare("SELECT COUNT(*) AS n FROM evidence_revisions WHERE run_id = ? AND evidence_id = ?")
            .get(f.runId, derived.evidence.evidenceId),
      ) as { n: number };
      expect(count.n).toBe(1);
    } finally {
      f.close();
    }
  });

  it("contradicted invalidates the exact revision, creates no replacement (§24/§60)", async () => {
    const f = await makePhase9Fixture();
    try {
      const { result } = await promoteSourceEvidence(f);
      const ref = { evidenceId: result.evidence.evidenceId, revision: result.evidence.revision };
      const contradiction = await captureRaw(f, executionEvent(f, "contradicting probe"));
      const freshness = services(f).freshness;
      const contradicted = revalidate(f, freshness, {
        ...ref,
        mode: "assess",
        assessment: "contradicted",
        observationRefs: [contradiction.observationId],
      });
      expect(contradicted.status).toBe("contradicted");
      expect(contradicted.target.current_state).toBe("invalidated");
      expect(contradicted.replacement).toBeUndefined();
      // Terminal: no further revalidation of any kind.
      expect(() =>
        revalidate(f, freshness, {
          ...ref,
          mode: "assess",
          assessment: "uncertain",
          observationRefs: ["obs_another"],
        }),
      ).toThrowError(expect.objectContaining({ code: "EVIDENCE_STATE_INVALID" }));
      expect(getCurrentState(f.store, f.runId, ref.evidenceId, ref.revision)).toBe("invalidated");
    } finally {
      f.close();
    }
  });

  it("uncertain keeps needs_validation and records REVALIDATION_UNCERTAIN (§25)", async () => {
    const f = await makePhase9Fixture();
    try {
      const { result } = await promoteSourceEvidence(f);
      const ref = { evidenceId: result.evidence.evidenceId, revision: result.evidence.revision };
      writeSourceFile(f, "src/claim.txt", "changed\n");
      const freshness = services(f).freshness;
      revalidate(f, freshness, { ...ref, mode: "check" });
      const ambiguous = await captureRaw(f, executionEvent(f, "ambiguous probe"));
      const uncertain = revalidate(f, freshness, {
        ...ref,
        mode: "assess",
        assessment: "uncertain",
        observationRefs: [ambiguous.observationId],
      });
      expect(uncertain.status).toBe("uncertain");
      expect(uncertain.target.current_state).toBe("needs_validation");
      expect(uncertain.replacement).toBeUndefined();
    } finally {
      f.close();
    }
  });

  it("assess without new provenance fails (§22)", async () => {
    const f = await makePhase9Fixture();
    try {
      const { result } = await promoteSourceEvidence(f);
      const freshness = services(f).freshness;
      expect(() =>
        revalidate(f, freshness, {
          evidenceId: result.evidence.evidenceId,
          revision: result.evidence.revision,
          mode: "assess",
          assessment: "confirmed",
        }),
      ).toThrowError(expect.objectContaining({ code: "EVIDENCE_REVALIDATION_INVALID" }));
    } finally {
      f.close();
    }
  });

  it("only the lineage-current revision can be revalidated (§26)", async () => {
    const f = await makePhase9Fixture();
    try {
      const { first, ref, freshness, newObservation } = await confirmedFlow(f);
      const confirmed = revalidate(f, freshness, {
        ...ref,
        mode: "assess",
        assessment: "confirmed",
        observationRefs: [newObservation.observationId],
      });
      expect(confirmed.status).toBe("confirmed");
      // The superseded @1 is historical now.
      expect(() =>
        revalidate(f, freshness, { evidenceId: ref.evidenceId, revision: 1, mode: "check" }),
      ).toThrowError(expect.objectContaining({ code: "EVIDENCE_REVISION_NOT_CURRENT" }));
      // Historical revisions stay readable.
      const old = f.store.withRead(
        (tx) =>
          tx
            .prepare("SELECT claim FROM evidence_revisions WHERE run_id = ? AND evidence_id = ? AND revision = 1")
            .get(f.runId, ref.evidenceId),
      ) as { claim: string };
      expect(old.claim).toBe(first.result.evidence.claim);
    } finally {
      f.close();
    }
  });
});

describe("Phase 10 §61/§16 — derived propagation", () => {
  it("A→B→C: a genuine A source change marks all three needs_validation; A@2 fresh does NOT restore B/C", async () => {
    const f = await makePhase9Fixture();
    try {
      const a = await promoteSourceEvidence(f);
      const aRef = { evidenceId: a.result.evidence.evidenceId, revision: a.result.evidence.revision };
      const { promotion } = services(f);
      const b = promotion.promoteEvidence({
        runId: f.runId,
        workspaceId: f.workspaceId,
        request: {
          claim: "B derived from A",
          kind: "derived_claim",
          scope: { type: "global" },
          confidence: "derived",
          criticality: "critical",
          observationRefs: [],
          derivedFrom: [aRef],
        },
        operationId: `promote:${(clockCounter += 10)}`,
      });
      const bRef = { evidenceId: b.evidence.evidenceId, revision: b.evidence.revision };
      const c = promotion.promoteEvidence({
        runId: f.runId,
        workspaceId: f.workspaceId,
        request: {
          claim: "C derived from B",
          kind: "derived_claim",
          scope: { type: "global" },
          confidence: "derived",
          criticality: "supporting",
          observationRefs: [],
          derivedFrom: [bRef],
        },
        operationId: `promote:${(clockCounter += 10)}`,
      });
      const cRef = { evidenceId: c.evidence.evidenceId, revision: c.evidence.revision };
      expect(getCurrentState(f.store, f.runId, bRef.evidenceId, bRef.revision)).toBe("fresh");
      expect(getCurrentState(f.store, f.runId, cRef.evidenceId, cRef.revision)).toBe("fresh");

      // A's source genuinely changes.
      writeSourceFile(f, "src/claim.txt", "A changed\n");
      const freshness = services(f).freshness;
      const drift = revalidate(f, freshness, { ...aRef, mode: "check" });
      expect(drift.status).toBe("source_changed");
      expect(drift.affected_derived).toEqual([
        { evidenceId: bRef.evidenceId, revision: bRef.revision },
        { evidenceId: cRef.evidenceId, revision: cRef.revision },
      ]);
      expect(getCurrentState(f.store, f.runId, aRef.evidenceId, aRef.revision)).toBe("needs_validation");
      expect(getCurrentState(f.store, f.runId, bRef.evidenceId, bRef.revision)).toBe("needs_validation");
      expect(getCurrentState(f.store, f.runId, cRef.evidenceId, cRef.revision)).toBe("needs_validation");

      // A's replacement becomes fresh; B/C remain needs_validation —
      // derived evidence is NEVER automatically restored (E19).
      const newObservation = await captureRaw(
        f,
        sourceEvent(f, "src/claim.txt", { toolUseId: `call_reread_${(clockCounter += 1)}` }),
      );
      const confirmed = revalidate(f, freshness, {
        ...aRef,
        mode: "assess",
        assessment: "confirmed",
        observationRefs: [newObservation.observationId],
      });
      expect(confirmed.status).toBe("confirmed");
      expect(confirmed.replacement?.state).toBe("fresh");
      expect(getCurrentState(f.store, f.runId, bRef.evidenceId, bRef.revision)).toBe("needs_validation");
      expect(getCurrentState(f.store, f.runId, cRef.evidenceId, cRef.revision)).toBe("needs_validation");
    } finally {
      f.close();
    }
  });
});

describe("Phase 10 §27 — revalidation idempotency", () => {
  it("same operation + same semantics replays the recorded result; different semantics conflict", async () => {
    const f = await makePhase9Fixture();
    try {
      const { result } = await promoteSourceEvidence(f);
      const ref = { evidenceId: result.evidence.evidenceId, revision: result.evidence.revision };
      writeSourceFile(f, "src/claim.txt", "changed\n");
      const freshness = services(f).freshness;
      const historyBefore = historyLength(f, ref);

      const first = revalidate(f, freshness, { ...ref, mode: "check" }, "revalidate:TU-fixed");
      expect(first.idempotent).toBe(false);
      expect(historyLength(f, ref)).toBe(historyBefore + 1);

      const replay = revalidate(f, freshness, { ...ref, mode: "check" }, "revalidate:TU-fixed");
      expect(replay).toMatchObject({ idempotent: true, status: "source_changed" });
      expect(historyLength(f, ref)).toBe(historyBefore + 1); // no new events

      expect(() =>
        revalidate(
          f,
          freshness,
          {
            evidenceId: result.evidence.evidenceId,
            revision: result.evidence.revision,
            mode: "assess",
            assessment: "uncertain",
            observationRefs: ["obs_x"],
          },
          "revalidate:TU-fixed",
        ),
      ).toThrowError(expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }));
    } finally {
      f.close();
    }
  });
});

describe("Phase 10 §71 — no freshness bypass", () => {
  it("the revalidation request vocabulary carries no state/force/assume fields", async () => {
    const f = await makePhase9Fixture();
    try {
      const { result } = await promoteSourceEvidence(f);
      const freshness = services(f).freshness;
      const input = {
        runId: f.runId,
        workspaceId: f.workspaceId,
        sessionId: f.sessionId,
        bindingGeneration: f.generation,
        operationId: `revalidate:${(revalidateSeq += 1)}`,
        request: {
          evidenceId: result.evidence.evidenceId,
          revision: result.evidence.revision,
          mode: "check",
          observationRefs: [],
          derivedFrom: [],
          // No state/force/assume_fresh/allow_stale fields exist on the type;
          // a hostile payload is rejected by exact-field validation upstream.
          state: "fresh",
          force: true,
        } as unknown as RevalidateEvidenceInput["request"],
      };
      // Unknown fields are inert here (the MCP layer rejects them via exact
      // business-field validation); no bypass is even representable.
      const outcome = freshness.revalidateEvidence(input);
      expect(outcome.status).toBe("validated");
      expect(getCurrentState(f.store, f.runId, result.evidence.evidenceId, result.evidence.revision)).toBe("fresh");
    } finally {
      f.close();
    }
  });
});

function historyLength(f: Phase9Fixture, ref: { evidenceId: string; revision: number }): number {
  return (
    f.store.withRead(
      (tx) =>
        tx
          .prepare(
            "SELECT COUNT(*) AS n FROM evidence_validation_events WHERE run_id = ? AND evidence_id = ? AND evidence_revision = ?",
          )
          .get(f.runId, ref.evidenceId, ref.revision),
    ) as { n: number }
  ).n;
}
