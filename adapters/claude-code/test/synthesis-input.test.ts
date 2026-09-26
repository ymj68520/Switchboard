/**
 * Phase 12 — frozen SynthesisInput (§13–§27, §68, §106) and the legacy
 * synthesis migration semantics (§19/§70/§110).
 *
 * E2–E11: the input is immutable, anchored to exact HEAD, carries exact
 * current design refs, derives Evidence from exact committed provenance,
 * freezes Evidence state, gates critical freshness at entry, never fabricates
 * inputs for legacy runs, and canonical determinism holds.
 */

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as nodePath from "node:path";

import { canonicalJson } from "../src/core/canonical-json.js";
import { synthesisInputHash } from "../src/core/synthesis.js";
import { getPlanningRunRecord } from "../src/store/planning-runs.js";
import { getHeadCommitRecord } from "../src/store/plan-commits.js";
import { getHeadSnapshotRecord } from "../src/store/plan-memory.js";
import {
  getLatestSynthesisInputInTx,
  listSynthesisInputEvidenceInTx,
  listSynthesisInputRefsInTx,
} from "../src/store/synthesis.js";
import { commitPrepared } from "./context-helpers.js";
import { dagChanges, driveToDetail, withCounterServices, rawSection } from "./phase11-helpers.js";
import { completeSectionVia } from "./section-workflow.test.js";
import { selectSection } from "./phase12-helpers.js";
import {
  inputOf,
  makeSynthesisFixture,
  promoteCriticalSource,
  type SynthesisFixture,
} from "./phase12-helpers.js";
import { makeProposalFixture } from "./proposal-helpers.js";
import { makeTempPluginDataRoot, rawConnection, removeTempPluginDataRoot, storePathsFor } from "./store-helpers.js";

type AnyFixture = SynthesisFixture;

function attachRoot<T extends ReturnType<typeof withCounterServices>>(fixture: T, root: string): T & { root: string; close(): void } {
  return { ...fixture, root, close: () => { fixture.store.close(); removeTempPluginDataRoot(root); } };
}

function inputRow(f: AnyFixture) {
  return f.store.withRead((tx) => getLatestSynthesisInputInTx(tx, f.runId));
}

describe("SynthesisInput creation at DETAIL_COMPLETE (§17/§18)", () => {
  it("freezes the input in the SAME transaction that advances Detail → Synthesis, anchored to the resulting HEAD (E2/E3/E4)", async () => {
    const f = await makeSynthesisFixture();
    try {
      const input = inputRow(f);
      expect(input).not.toBeNull();
      expect(input!.inputId).toMatch(/^synin_/);
      expect(input!.inputHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(input!.inputSeq).toBe(1);
      const snapshot = getHeadSnapshotRecord(f.store, f.runId);
      const commit = getHeadCommitRecord(f.store, f.runId);
      expect(input!.baseHeadSnapshotId).toBe(snapshot?.snapshotId ?? null);
      expect(input!.baseHeadCommitId).toBe(commit?.commitId ?? null);
      expect(input!.baseRunRevision).toBeGreaterThan(1);
      // The tables are database-level immutable (§14).
      const writes = f.store.withWrite((tx) => {
        let failed = false;
        try {
          tx.prepare("UPDATE synthesis_inputs SET input_hash = 'sha256:deadbeef' WHERE run_id = ?").run(f.runId);
        } catch {
          failed = true;
        }
        return failed;
      });
      expect(writes).toBe(true);
    } finally {
      f.close();
    }
  });

  it("carries exact current design refs at their HEAD revisions (§16/E5)", async () => {
    const f = await makeSynthesisFixture();
    try {
      const refs = f.store.withRead((tx) => listSynthesisInputRefsInTx(tx, f.runId, f.inputId));
      expect(refs.filter((ref) => ref.kind === "section").map((ref) => ref.artifactId).sort()).toEqual([...f.sectionIds].sort());
      expect(refs.some((ref) => ref.kind === "architecture")).toBe(true);
      const head = getHeadSnapshotRecord(f.store, f.runId);
      for (const ref of refs) {
        const member = head!.refs.find((candidate) => candidate.kind === ref.kind && candidate.id === ref.artifactId);
        expect(member?.revision).toBe(ref.revision);
      }
      // The canonical payload embeds the section contracts (§16).
      const canonical = JSON.parse(inputRow(f)!.canonicalJson) as { sectionContracts: unknown[] };
      expect(canonical.sectionContracts).toHaveLength(f.sectionIds.length);
    } finally {
      f.close();
    }
  });
});

describe("§21/§23 — deterministic Evidence reachability and freezing", () => {
  it("Evidence required by the introducing proposal is frozen with its exact state (E7/E8)", async () => {
    const root = makeTempPluginDataRoot("phase-plan-reach-");
    const base = await makeProposalFixture(root, { sessionId: "S1" });
    const f = attachRoot(withCounterServices(base), root) as never as SynthesisFixture;
    try {
      driveToDetail(f);
      const promoted = await promoteCriticalSource(f, "src/frozen.txt", "FROZEN SOURCE v1\n", "promote:frozen-1");
      const dagPrepared = f.proposals.prepareProposal({
        runId: f.runId,
        workspaceId: f.workspaceId,
        sessionId: f.sessionId,
        bindingGeneration: f.generation,
        expectedRunRevision: f.runRevision,
        type: "design_checkpoint",
        scope: { kind: "detail" },
        title: "DAG with evidence",
        summary: "two sections",
        changes: dagChanges([{ title: "Alpha" }, { title: "Beta" }]),
        requiredEvidence: [{ evidenceId: promoted.evidenceId, revision: promoted.revision }],
      });
      commitPrepared(f, dagPrepared.proposal.proposalId, dagPrepared.proposal.revision, dagPrepared.proposal.proposalHash);
      const sectionIds = [...new Set(dagPrepared.candidateRefs.filter((ref) => ref.kind === "section").map((ref) => ref.id))].sort();
      for (const sectionId of sectionIds) {
        selectSection(f, sectionId);
        completeSectionVia(f, sectionId, 1);
      }
      const input = inputOf(f);
      const evidence = f.store.withRead((tx) => listSynthesisInputEvidenceInTx(tx, f.runId, input.inputId));
      expect(evidence).toHaveLength(1);
      expect(evidence[0]).toMatchObject({
        evidenceId: promoted.evidenceId,
        evidenceRevision: promoted.revision,
        criticality: "critical",
        frozenState: "fresh",
      });
      // The canonical payload freezes the evidence state too (§23).
      const canonical = JSON.parse(inputRow(f)!.canonicalJson) as { relevantEvidence: Array<{ evidenceId: string; state: string }> };
      expect(canonical.relevantEvidence[0]).toMatchObject({ evidenceId: promoted.evidenceId, state: "fresh" });
    } finally {
      f.store.close();
      removeTempPluginDataRoot(root);
    }
  });

  it("§24 — stale critical Evidence fails the LAST completion closed; stage stays detail (E9)", async () => {
    const root = makeTempPluginDataRoot("phase-plan-gate24-");
    const base = await makeProposalFixture(root, { sessionId: "S1" });
    const f = attachRoot(withCounterServices(base), root) as never as SynthesisFixture;
    try {
      driveToDetail(f);
      const promoted = await promoteCriticalSource(f, "src/gate24.txt", "GATE24 SOURCE v1\n", "promote:gate24-1");
      const dagPrepared = f.proposals.prepareProposal({
        runId: f.runId,
        workspaceId: f.workspaceId,
        sessionId: f.sessionId,
        bindingGeneration: f.generation,
        expectedRunRevision: f.runRevision,
        type: "design_checkpoint",
        scope: { kind: "detail" },
        title: "DAG with evidence",
        summary: "two sections",
        changes: dagChanges([{ title: "Alpha" }, { title: "Beta" }]),
        requiredEvidence: [{ evidenceId: promoted.evidenceId, revision: promoted.revision }],
      });
      commitPrepared(f, dagPrepared.proposal.proposalId, dagPrepared.proposal.revision, dagPrepared.proposal.proposalHash);
      const sectionIds = [...new Set(dagPrepared.candidateRefs.filter((ref) => ref.kind === "section").map((ref) => ref.id))].sort();
      for (const sectionId of sectionIds.slice(0, -1)) {
        selectSection(f, sectionId);
        completeSectionVia(f, sectionId, 1);
      }
      // Real drift AFTER the introducing commit, BEFORE the last completion
      // (written under the registered workspace root, §13).
      const { getWorkspaceById } = await import("../src/store/repositories.js");
      const workspaceRoot = getWorkspaceById(f.store, f.workspaceId)!.canonicalRoot;
      fs.writeFileSync(nodePath.join(workspaceRoot, "src/gate24.txt"), "GATE24 SOURCE v2 DRIFTED\n");
      const last = sectionIds[sectionIds.length - 1]!;
      selectSection(f, last);
      expect(() => completeSectionVia(f, last, 1)).toThrowError(expect.objectContaining({ code: "EVIDENCE_NEEDS_VALIDATION" }));
      // The proposal stays awaiting — reject it, then assert the fail-closed state.
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
      expect(getPlanningRunRecord(f.store, f.runId)?.stage).toBe("detail");
    } finally {
      f.store.close();
      removeTempPluginDataRoot(root);
    }
  });
});

describe("§106 — canonical input determinism", () => {
  it("ordering changes never change the hash; content changes do", async () => {
    const f = await makeSynthesisFixture();
    try {
      const canonicalJsonText = inputRow(f)!.canonicalJson;
      const canonical = JSON.parse(canonicalJsonText) as Record<string, unknown>;
      expect(canonicalJson(canonical)).toBe(canonicalJsonText);
      expect(synthesisInputHash(canonical as never)).toBe(f.inputHash);
      // Permuting array order never changes the hash.
      const permuted = {
        ...canonical,
        sections: [...(canonical.sections as unknown[])].reverse(),
        relevantEvidence: [...(canonical.relevantEvidence as unknown[])].reverse(),
      };
      expect(synthesisInputHash(permuted as never)).toBe(f.inputHash);
      // Changing a section revision changes the hash.
      const bumped = JSON.parse(canonicalJsonText) as { sections: Array<{ revision: number }> };
      bumped.sections = bumped.sections.map((section, index) => (index === 0 ? { ...section, revision: section.revision + 1 } : section));
      expect(synthesisInputHash(bumped as never)).not.toBe(f.inputHash);
      // Changing the anchored HEAD identity changes the hash.
      const headBumped = JSON.parse(canonicalJsonText) as { baseRunRevision: number };
      headBumped.baseRunRevision += 1;
      expect(synthesisInputHash(headBumped as never)).not.toBe(f.inputHash);
      // The server-generated input id is NOT part of the payload (§106).
      expect(canonicalJsonText).not.toContain(f.inputId);
    } finally {
      f.close();
    }
  });
});

describe("§19/§70/§110 — legacy schema-8 synthesis runs", () => {
  it("migration creates NO fabricated input; the legacy run stays at synthesis and fails closed", async () => {
    const f = await makeSynthesisFixture();
    try {
      expect(getPlanningRunRecord(f.store, f.runId)?.stage).toBe("synthesis");
      // Force the store back to schema 8 (drop the synthesis tables) WITHOUT
      // touching the run row: stage synthesis, no input possible.
      const db = rawConnection(storePathsFor(f.root).databasePath, 5000);
      try {
        for (const table of ["synthesis_manifest_refs", "synthesis_manifests", "semantic_validation_findings", "semantic_validation_reports", "synthesis_input_refs", "synthesis_input_evidence", "synthesis_inputs"]) {
          db.exec(`DROP TABLE IF EXISTS ${table}`);
        }
        db.exec("DELETE FROM schema_migrations WHERE version = 9");
        db.exec("PRAGMA user_version = 8");
      } finally {
        db.close();
      }
      f.store.close();
      // Re-open migrates 8 → 9 again; the run keeps stage synthesis and the
      // input row stays absent (migration never fabricates one).
      const { initializePlanStore } = await import("../src/store/sqlite-store.js");
      const reopened = await initializePlanStore({ pluginDataRoot: f.root });
      try {
        expect(getPlanningRunRecord(reopened, f.runId)?.stage).toBe("synthesis");
        reopened.withRead((tx) => {
          expect(getLatestSynthesisInputInTx(tx, f.runId)).toBeNull();
        });
      } finally {
        reopened.close();
      }
    } finally {
      f.close();
    }
  });
});

describe("§68 — every synthesis cycle is a distinct audit unit", () => {
  it("re-completing after reopen creates a NEW input with input_seq 2", async () => {
    const f = await makeSynthesisFixture();
    try {
      // Reopen → detail (fail-closed full review), then re-complete both.
      const { createSynthesisService } = await import("../src/application/synthesis-service.js");
      const service = createSynthesisService(f.store, {
        nowIso: () => new Date().toISOString(),
        newId: (() => {
          let n = 0;
          return () => `reo-${(n += 1)}`;
        })(),
      });
      service.requestReopen({
        runId: f.runId,
        workspaceId: f.workspaceId,
        sessionId: f.sessionId,
        bindingGeneration: f.generation,
        target: "detail",
        reason: "cycle test",
        findingIds: [],
        requestId: "reopen:cycle-test",
        callerAgent: null,
      });
      // needs_review sections re-complete at their exact revisions (§66).
      const run = () => getPlanningRunRecord(f.store, f.runId)!;
      for (const sectionId of f.sectionIds) {
        selectSection(f, sectionId);
        const state = sectionRevisionOf(f, sectionId);
        completeSectionVia(f, sectionId, state);
      }
      expect(run().stage).toBe("synthesis");
      const input = inputRow(f)!;
      expect(input.inputSeq).toBe(2);
      expect(input.inputId).not.toBe(f.inputId);
      // A distinct audit unit even though the design content is identical:
      // only the baseRunRevision moved (§84 — reopen bumped it once).
      expect(input.inputHash).not.toBe(f.inputHash);
    } finally {
      f.close();
    }
  });
});

function sectionRevisionOf(f: SynthesisFixture, sectionId: string): number {
  const head = getHeadSnapshotRecord(f.store, f.runId);
  const ref = head!.refs.find((candidate) => candidate.kind === "section" && candidate.id === sectionId);
  return ref!.revision;
}

void rawSection;
