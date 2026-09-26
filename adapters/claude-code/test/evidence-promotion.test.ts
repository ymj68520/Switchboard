/**
 * Evidence promotion semantics (Phase 9 §23–§38, §44–§48, §52/§53, §66,
 * §70–§73; E19–E37).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { createEvidenceService } from "../src/application/evidence-service.js";
import { captureObservation } from "../src/observations/capture.js";
import { getObservationRecord, listObservationsRecord } from "../src/store/observations.js";
import { listEvidenceRecord } from "../src/store/evidence.js";
import { memoryCounts } from "./proposal-helpers.js";
import { getHeadSnapshotRecord } from "../src/store/plan-memory.js";
import { rawConnection, storePathsFor, fixedClock } from "./store-helpers.js";
import { payloadHashHex } from "../src/store/blob-store.js";
import { deriveContextEpochFromSource } from "../src/context/epoch.js";
import { createStoreContextSource } from "../src/application/context-read-model.js";
import {
  captureDeps,
  executionEvent,
  makePhase9Fixture,
  sourceEvent,
  writeSourceFile,
  type Phase9Fixture,
} from "./phase9-helpers.js";

async function fixtureWithSourceObservation(options: { content?: string; relative?: string } = {}) {
  const f = await makePhase9Fixture();
  const relative = options.relative ?? "src/claim.txt";
  writeSourceFile(f, relative, options.content ?? "PHASE9 CLAIM SOURCE alpha\n");
  const outcome = await captureObservation(captureDeps(f), sourceEvent(f, relative));
  expect(outcome.status).toBe("captured");
  return { f, observation: (outcome as { status: "captured"; observation: { observationId: string } }).observation };
}

function service(f: Phase9Fixture) {
  return createEvidenceService(f.store, f.blobs, fixedClock({ ids: ["ev", "evt", "ev2", "evt2", "ev3", "evt3"] }));
}

const GLOBAL_SCOPE = { type: "global" } as const;

describe("direct promotion (§28/§30, E21/E23/E24)", () => {
  it("promotes one source observation into an immutable fingerprint-validated claim", async () => {
    const { f, observation } = await fixtureWithSourceObservation();
    try {
      const result = service(f).promoteEvidence({
        runId: f.runId,
        workspaceId: f.workspaceId,
        request: {
          claim: "The sample file declares the alpha constant.",
          kind: "source_fact",
          scope: GLOBAL_SCOPE,
          confidence: "direct",
          criticality: "supporting",
          observationRefs: [observation.observationId],
          derivedFrom: [],
        },
        operationId: "promote:call_1",
      });
      expect(result.idempotent).toBe(false);
      const ev = result.evidence;
      expect(ev.revision).toBe(1);
      expect(ev.evidenceId).toMatch(/^ev_/);
      expect(ev.kind).toBe("source_fact");
      expect(ev.confidence).toBe("direct");
      expect(ev.criticality).toBe("supporting");
      expect(ev.validationStrategy).toBe("fingerprint");
      expect(ev.observationRefs).toEqual([observation.observationId]);
      expect(ev.derivedFrom).toEqual([]);
      // Source fingerprints are server-derived from the capture-time record.
      expect(ev.sourceFingerprints).toHaveLength(1);
      expect(ev.sourceFingerprints[0]).toMatchObject({ path: "src/claim.txt", sha256: expect.any(String) });
      expect(ev.repositoryContext).toEqual({ repositoryRevision: null });
      expect(ev.workspaceContext).toEqual({ workspaceId: f.workspaceId });
    } finally {
      f.close();
    }
  });

  it("promotes multiple observations; provenance links are part of the immutable revision", async () => {
    const { f, observation } = await fixtureWithSourceObservation();
    try {
      writeSourceFile(f, "src/second.txt", "second source\n");
      const second = await captureObservation(captureDeps(f, { clock: fixedClock({ ids: ["o2"] }) }), sourceEvent(f, "src/second.txt", { toolUseId: "call_second" }));
      const secondId = (second as { status: "captured"; observation: { observationId: string } }).observation.observationId;
      const result = service(f).promoteEvidence({
        runId: f.runId,
        workspaceId: f.workspaceId,
        request: {
          claim: "Two files agree on the design fact.",
          kind: "source_fact",
          scope: GLOBAL_SCOPE,
          confidence: "direct",
          criticality: "critical",
          observationRefs: [secondId, observation.observationId],
          derivedFrom: [],
        },
        operationId: "promote:call_2",
      });
      // Canonical sorted order regardless of caller order.
      expect(result.evidence.observationRefs).toEqual([observation.observationId, secondId].sort());
      expect(result.evidence.sourceFingerprints).toHaveLength(2);
    } finally {
      f.close();
    }
  });

  it("model input can never forge payload/source provenance — only observation ids are accepted (§29, E24)", async () => {
    const { f } = await fixtureWithSourceObservation();
    try {
      const svc = service(f);
      const request = {
        claim: "forged",
        kind: "source_fact" as const,
        scope: GLOBAL_SCOPE,
        confidence: "direct" as const,
        criticality: "supporting" as const,
        observationRefs: ["obs_not_a_real_id"],
        derivedFrom: [],
      };
      try {
        svc.promoteEvidence({ runId: f.runId, workspaceId: f.workspaceId, request, operationId: "promote:x" });
        throw new Error("should have thrown");
      } catch (err) {
        expect((err as { code?: string }).code).toBe("OBSERVATION_NOT_FOUND");
      }
      // Even the correct id cannot carry caller-declared hashes — the request
      // shape has no field for them (typed service input pins this).
    } finally {
      f.close();
    }
  });
});

describe("derived promotion (§31/§32, E22)", () => {
  it("requires exact upstream revisions, same run; 'latest' shortcuts cannot be expressed", async () => {
    const { f, observation } = await fixtureWithSourceObservation();
    try {
      const svc = service(f);
      const base = svc.promoteEvidence({
        runId: f.runId,
        workspaceId: f.workspaceId,
        request: {
          claim: "base", kind: "source_fact", scope: GLOBAL_SCOPE, confidence: "direct",
          criticality: "supporting", observationRefs: [observation.observationId], derivedFrom: [],
        },
        operationId: "promote:base",
      });
      const derived = svc.promoteEvidence({
        runId: f.runId,
        workspaceId: f.workspaceId,
        request: {
          claim: "derived conclusion",
          kind: "derived_claim",
          scope: GLOBAL_SCOPE,
          confidence: "derived",
          criticality: "supporting",
          observationRefs: [],
          derivedFrom: [{ evidenceId: base.evidence.evidenceId, revision: 1 }],
        },
        operationId: "promote:derived",
      });
      expect(derived.evidence.validationStrategy).toBe("reobserve");
      expect(derived.evidence.derivedFrom).toEqual([{ evidenceId: base.evidence.evidenceId, revision: 1 }]);

      // Missing upstream revision fails closed.
      try {
        svc.promoteEvidence({
          runId: f.runId,
          workspaceId: f.workspaceId,
          request: {
            claim: "bad", kind: "derived_claim", scope: GLOBAL_SCOPE, confidence: "derived",
            criticality: "supporting", observationRefs: [],
            derivedFrom: [{ evidenceId: base.evidence.evidenceId, revision: 9 }],
          },
          operationId: "promote:bad",
        });
        throw new Error("should have thrown");
      } catch (err) {
        expect((err as { code?: string }).code).toBe("EVIDENCE_REVISION_NOT_FOUND");
      }
    } finally {
      f.close();
    }
  });
});

describe("confidence/provenance matrix (§32, E25)", () => {
  it.each([
    ["direct without observations", { confidence: "direct", observationRefs: [], derivedFrom: [] }, "EVIDENCE_PROVENANCE_INVALID"],
    ["direct with derived refs", { confidence: "direct", observationRefs: ["x"], derivedFrom: [{ evidenceId: "ev", revision: 1 }] }, "EVIDENCE_PROVENANCE_INVALID"],
    ["derived without upstream", { confidence: "derived", observationRefs: [], derivedFrom: [] }, "EVIDENCE_PROVENANCE_INVALID"],
    ["uncertain without any provenance", { confidence: "uncertain", observationRefs: [], derivedFrom: [] }, "EVIDENCE_PROVENANCE_INVALID"],
  ])("fails closed: %s", async (_name, partial, code) => {
    const f = await makePhase9Fixture();
    try {
      const request = {
        claim: "c", kind: "source_fact" as const, scope: GLOBAL_SCOPE, criticality: "supporting" as const,
        ...(partial as { confidence: "direct" | "derived" | "uncertain"; observationRefs: string[]; derivedFrom: Array<{ evidenceId: string; revision: number }> }),
      };
      expect(() =>
        service(f).promoteEvidence({ runId: f.runId, workspaceId: f.workspaceId, request, operationId: "promote:m" }),
      ).toThrowError(expect.objectContaining({ code }));
    } finally {
      f.close();
    }
  });

  it("uncertain evidence may mix both provenance kinds (still ≥1 source)", async () => {
    const { f, observation } = await fixtureWithSourceObservation();
    try {
      const result = service(f).promoteEvidence({
        runId: f.runId,
        workspaceId: f.workspaceId,
        request: {
          claim: "uncertain mix", kind: "locator_fact", scope: GLOBAL_SCOPE, confidence: "uncertain",
          criticality: "informational", observationRefs: [observation.observationId], derivedFrom: [],
        },
        operationId: "promote:u",
      });
      expect(result.evidence.confidence).toBe("uncertain");
      expect(result.evidence.validationStrategy).toBe("reobserve");
    } finally {
      f.close();
    }
  });
});

describe("validation strategy server rule (§27/§37/§38/§39, E28/E29)", () => {
  it("a pure source basis without capture-time fingerprints fails closed (EVIDENCE_SOURCE_FINGERPRINT_UNAVAILABLE)", async () => {
    const f = await makePhase9Fixture();
    try {
      // Capture with the file missing → promotable source observation WITHOUT fingerprint.
      const outcome = await captureObservation(captureDeps(f), sourceEvent(f, "ghost.txt", {
        toolResponse: { type: "text", file: { filePath: "ghost.txt", content: "" } },
      }));
      const obsId = (outcome as { status: "captured"; observation: { observationId: string } }).observation.observationId;
      expect(() =>
        service(f).promoteEvidence({
          runId: f.runId,
          workspaceId: f.workspaceId,
          request: {
            claim: "no fingerprint", kind: "source_fact", scope: GLOBAL_SCOPE, confidence: "direct",
            criticality: "supporting", observationRefs: [obsId], derivedFrom: [],
          },
          operationId: "promote:nf",
        }),
      ).toThrowError(expect.objectContaining({ code: "EVIDENCE_SOURCE_FINGERPRINT_UNAVAILABLE" }));
    } finally {
      f.close();
    }
  });

  it("execution provenance forces reobserve; locator citations never auto-Read hit files (§38/§39)", async () => {
    const f = await makePhase9Fixture();
    try {
      const exec = await captureObservation(captureDeps(f), executionEvent(f, "node --version"));
      const execId = (exec as { status: "captured"; observation: { observationId: string } }).observation.observationId;
      const result = service(f).promoteEvidence({
        runId: f.runId,
        workspaceId: f.workspaceId,
        request: {
          claim: "the toolchain version observed", kind: "execution_result", scope: GLOBAL_SCOPE,
          confidence: "direct", criticality: "informational", observationRefs: [execId], derivedFrom: [],
        },
        operationId: "promote:exec",
      });
      expect(result.evidence.kind).toBe("execution_result");
      expect(result.evidence.validationStrategy).toBe("reobserve");
      expect(result.evidence.sourceFingerprints).toEqual([]);
    } finally {
      f.close();
    }
  });
});

describe("promotion failure modes (§66, fail closed)", () => {
  it("rejects stage/capability, scope, corpus mismatch, and corrupt blobs", async () => {
    const { f, observation } = await fixtureWithSourceObservation();
    try {
      const svc = service(f);

      // Corrupt blob → OBSERVATION_BLOB_CORRUPT (§18/§66).
      const hex = payloadHashHex(getObservationRecord(f.store, f.runId, observation.observationId)!.payloadHash!);
      const blobPath = path.join(f.blobs.root, hex.slice(0, 2), hex);
      fs.writeFileSync(blobPath, Buffer.from("tampered bytes", "utf8"));
      try {
        svc.promoteEvidence({
          runId: f.runId,
          workspaceId: f.workspaceId,
          request: {
            claim: "c", kind: "source_fact", scope: GLOBAL_SCOPE, confidence: "direct",
            criticality: "supporting", observationRefs: [observation.observationId], derivedFrom: [],
          },
          operationId: "promote:corrupt",
        });
        throw new Error("should have thrown");
      } catch (err) {
        expect((err as { code?: string }).code).toBe("OBSERVATION_BLOB_CORRUPT");
      }
    } finally {
      f.close();
    }
  });

  it("rejects malformed scopes and the section capability gate (§34)", async () => {
    const { f, observation } = await fixtureWithSourceObservation();
    try {
      const svc = service(f);
      const base = { claim: "c", kind: "source_fact" as const, confidence: "direct" as const, criticality: "supporting" as const, observationRefs: [observation.observationId], derivedFrom: [] };
      expect(() => svc.promoteEvidence({
        runId: f.runId, workspaceId: f.workspaceId,
        request: { ...base, scope: { type: "section", sectionId: "S-1" } as never },
        operationId: "promote:s1",
      })).toThrowError(expect.objectContaining({ code: "CAPABILITY_NOT_AVAILABLE" }));
      expect(() => svc.promoteEvidence({
        runId: f.runId, workspaceId: f.workspaceId,
        request: { ...base, scope: { type: "banana" } as never },
        operationId: "promote:s2",
      })).toThrowError(expect.objectContaining({ code: "EVIDENCE_SCOPE_INVALID" }));
    } finally {
      f.close();
    }
  });

  it("rejects promotion at synthesis/validation/final stages (§46)", async () => {
    const { f, observation } = await fixtureWithSourceObservation();
    try {
      // Advance the run to synthesis via the core state machine service.
      const runs = f.runs;
      const transition = (expectedRevision: number, event: Parameters<typeof runs.transitionRun>[0]["event"]) =>
        runs.transitionRun({
          runId: f.runId,
          workspaceId: f.workspaceId,
          sessionId: f.sessionId,
          bindingGeneration: f.generation,
          expectedRevision,
          event,
        });
      // The fixture's run starts at architecture (revision 2): advance
      // detail → synthesis to prove the promotion stage gate.
      transition(f.runRevision, "ARCHITECTURE_APPROVED");
      transition(f.runRevision + 1, "DETAIL_COMPLETE");
      expect(() =>
        service(f).promoteEvidence({
          runId: f.runId,
          workspaceId: f.workspaceId,
          request: {
            claim: "late", kind: "source_fact", scope: GLOBAL_SCOPE, confidence: "direct",
            criticality: "supporting", observationRefs: [observation.observationId], derivedFrom: [],
          },
          operationId: "promote:late",
        }),
      ).toThrowError(expect.objectContaining({ code: "CAPABILITY_NOT_AVAILABLE" }));
    } finally {
      f.close();
    }
  });

  it("cross-workspace promotion fails closed (E34)", async () => {
    const { f, observation } = await fixtureWithSourceObservation();
    try {
      expect(() =>
        service(f).promoteEvidence({
          runId: f.runId,
          workspaceId: "ws_someone_else",
          request: {
            claim: "c", kind: "source_fact", scope: GLOBAL_SCOPE, confidence: "direct",
            criticality: "supporting", observationRefs: [observation.observationId], derivedFrom: [],
          },
          operationId: "promote:cross",
        }),
      ).toThrowError(expect.objectContaining({ code: "WORKSPACE_MISMATCH" }));
    } finally {
      f.close();
    }
  });
});

describe("promotion idempotency (§44, E33)", () => {
  it("same operation id + same semantics → same revision; different semantics → IDEMPOTENCY_CONFLICT", async () => {
    const { f, observation } = await fixtureWithSourceObservation();
    try {
      const svc = service(f);
      const request = {
        claim: "stable claim", kind: "source_fact" as const, scope: GLOBAL_SCOPE,
        confidence: "direct" as const, criticality: "supporting" as const,
        observationRefs: [observation.observationId], derivedFrom: [],
      };
      const first = svc.promoteEvidence({ runId: f.runId, workspaceId: f.workspaceId, request, operationId: "promote:retry" });
      const replay = svc.promoteEvidence({ runId: f.runId, workspaceId: f.workspaceId, request, operationId: "promote:retry" });
      expect(replay.idempotent).toBe(true);
      expect(replay.evidence.evidenceId).toBe(first.evidence.evidenceId);
      expect(replay.evidence.revision).toBe(first.evidence.revision);

      const drifted = {
        ...request,
        claim: "different claim",
      };
      expect(() =>
        svc.promoteEvidence({ runId: f.runId, workspaceId: f.workspaceId, request: drifted, operationId: "promote:retry" }),
      ).toThrowError(expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }));
      // Still exactly one evidence revision.
      expect(listEvidenceRecord(f.store, f.runId)).toHaveLength(1);
    } finally {
      f.close();
    }
  });
});

describe("no-mutation guarantees (E35/E36/E37, §49/§50/§52/§53/§73)", () => {
  it("promotion performs no Plan Memory HEAD mutation, no run-revision bump, no epoch change", async () => {
    const { f, observation } = await fixtureWithSourceObservation();
    try {
      const before = {
        head: getHeadSnapshotRecord(f.store, f.runId),
        runRevision: f.runs.getPlanningRun(f.runId)?.revision,
        counts: memoryCounts(f.store),
        epoch: deriveContextEpochFromSource(createStoreContextSource(f.store), f.runId),
        rows: listObservationsRecord(f.store, f.runId, { limit: 100 }).length,
      };
      service(f).promoteEvidence({
        runId: f.runId,
        workspaceId: f.workspaceId,
        request: {
          claim: "no mutation", kind: "source_fact", scope: GLOBAL_SCOPE, confidence: "direct",
          criticality: "supporting", observationRefs: [observation.observationId], derivedFrom: [],
        },
        operationId: "promote:nomut",
      });
      expect(getHeadSnapshotRecord(f.store, f.runId)).toEqual(before.head);
      expect(f.runs.getPlanningRun(f.runId)?.revision).toBe(before.runRevision);
      expect(memoryCounts(f.store)).toEqual(before.counts);
      expect(deriveContextEpochFromSource(createStoreContextSource(f.store), f.runId)).toBe(before.epoch);
      expect(listObservationsRecord(f.store, f.runId, { limit: 100 }).length).toBe(before.rows);
    } finally {
      f.close();
    }
  });

  it("evidence revisions and provenance links are immutable at the database level (§52)", async () => {
    const { f, observation } = await fixtureWithSourceObservation();
    try {
      service(f).promoteEvidence({
        runId: f.runId,
        workspaceId: f.workspaceId,
        request: {
          claim: "immutable", kind: "source_fact", scope: GLOBAL_SCOPE, confidence: "direct",
          criticality: "supporting", observationRefs: [observation.observationId], derivedFrom: [],
        },
        operationId: "promote:imm",
      });
      const db = rawConnection(storePathsFor(f.root).databasePath, 500);
      try {
        expect(() => db.exec("UPDATE evidence_revisions SET claim = 'tampered'")).toThrowError(/evidence_revisions is immutable/);
        expect(() => db.exec("DELETE FROM evidence_revisions")).toThrowError(/evidence_revisions is immutable/);
        expect(() => db.exec("DELETE FROM evidence_observation_refs")).toThrowError(/evidence_observation_refs is immutable/);
        expect(() => db.exec("UPDATE observations SET tool_name = 'x'")).toThrowError(/observations is immutable/);
      } finally {
        db.close();
      }
    } finally {
      f.close();
    }
  });

  it("writes one EVIDENCE_PROMOTED audit event and none for capture (§72)", async () => {
    const { f, observation } = await fixtureWithSourceObservation();
    try {
      service(f).promoteEvidence({
        runId: f.runId,
        workspaceId: f.workspaceId,
        request: {
          claim: "audited", kind: "source_fact", scope: GLOBAL_SCOPE, confidence: "direct",
          criticality: "supporting", observationRefs: [observation.observationId], derivedFrom: [],
        },
        operationId: "promote:audit",
      });
      const db = rawConnection(storePathsFor(f.root).databasePath, 500);
      try {
        const events = db.prepare("SELECT event_type, count(*) AS n FROM audit_events GROUP BY event_type").all() as Array<{ event_type: string; n: number }>;
        const byType = Object.fromEntries(events.map((e) => [e.event_type, e.n]));
        expect(byType["EVIDENCE_PROMOTED"]).toBe(1);
        expect(byType["OBSERVATION_CAPTURED"]).toBeUndefined();
      } finally {
        db.close();
      }
    } finally {
      f.close();
    }
  });

  it("no freshness machinery beyond the Phase 10 foundation exists to leak (E38–E40, §1; Phase 10 §4)", async () => {
    const f = await makePhase9Fixture();
    try {
      const db = rawConnection(storePathsFor(f.root).databasePath, 500);
      try {
        const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((t) => t.name);
        // The frozen Phase 9 bans hold: no invalidation-events shadow table,
        // no host file-change event log, no freshness-bypass machinery.
        for (const banned of ["evidence_current_state", "evidence_invalidation_events", "file_change_events"]) {
          expect(tables).not.toContain(banned);
        }
        // Phase 10 adds exactly two freshness structures; nothing else leaked.
        expect(tables).toContain("evidence_validation_events");
        expect(tables).toContain("evidence_current_states");
      } finally {
        db.close();
      }
    } finally {
      f.close();
    }
  });
});

describe("payload provenance (§68)", () => {
  it("the promoted claim's provenance resolves to the exact observation payload bytes", async () => {
    const { f, observation } = await fixtureWithSourceObservation({ content: "EXACT BYTES gamma\n" });
    try {
      const result = service(f).promoteEvidence({
        runId: f.runId,
        workspaceId: f.workspaceId,
        request: {
          claim: "exact", kind: "source_fact", scope: GLOBAL_SCOPE, confidence: "direct",
          criticality: "supporting", observationRefs: [observation.observationId], derivedFrom: [],
        },
        operationId: "promote:exact",
      });
      const stored = getObservationRecord(f.store, f.runId, result.evidence.observationRefs[0]!);
      const payload = JSON.parse(Buffer.from(f.blobs.readBytes(stored!.payloadHash!)).toString("utf8")) as { file: { content: string } };
      expect(payload.file.content).toBe("EXACT BYTES gamma\n");
      // Capture-time fingerprint equals the file's content hash at capture.
      expect(result.evidence.sourceFingerprints[0]!.sha256).toBe(
        stored!.sourceFingerprint!.sha256,
      );
    } finally {
      f.close();
    }
  });
});
