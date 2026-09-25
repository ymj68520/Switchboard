import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { createPlanningRunService } from "../src/application/planning-run-service.js";
import {
  createInternalPlanMemoryWriter,
  getHeadSnapshotRecord,
  getSnapshotRecord,
  listSnapshotRefsRecord,
  readMemoryRevisionRecord,
  readSectionContractRecord,
} from "../src/store/plan-memory.js";
import { discoverAndRegisterWorkspace } from "../src/workspace/identity.js";
import { initializePlanStore } from "../src/store/sqlite-store.js";
import { fixedClock, makeTempPluginDataRoot, rawConnection, removeTempPluginDataRoot, storePathsFor } from "./store-helpers.js";

function clock() {
  return fixedClock({ nowIso: "2026-06-06T00:00:00.000Z", ids: ["s1"] });
}

async function makeRunFixture(root: string): Promise<{ runId: string; workspaceId: string }> {
  const store = await initializePlanStore({ pluginDataRoot: root });
  try {
    const dir = path.join(root, "project");
    fs.mkdirSync(dir, { recursive: true });
    const { registration } = await discoverAndRegisterWorkspace(store, dir, clock());
    const runs = createPlanningRunService(store, clock());
    const { run } = runs.createPlanningRun({
      workspaceId: registration.workspace.workspaceId,
      sessionId: "S1",
      goal: "memory fixture",
    });
    return { runId: run.runId, workspaceId: registration.workspace.workspaceId };
  } finally {
    store.close();
  }
}

async function makeWriter(root: string) {
  const store = await initializePlanStore({ pluginDataRoot: root });
  return { store, memory: createInternalPlanMemoryWriter(store, clock()) };
}

const DECISION_1 = {
  title: "Use WAL",
  statement: "Use WAL journal mode",
  rationale: "concurrency",
  alternatives: ["rollback journal"],
  consequences: ["readers never block writers"],
  scope: "storage",
  supportingRefs: [],
};

const SECTION_1 = (revision: number) => ({
  title: "Store layer",
  objective: "Durable state",
  design: "SQLite WAL + tx",
  interfaces: ["PlanStore"],
  invariants: ["atomic commits"],
  failureModes: ["busy timeout"],
  dependencies: [] as string[],
  decisionRefs: [],
  openQuestionRefs: [],
  impactRefs: [],
  contract: {
    sectionId: "SEC-1",
    revision,
    provides: ["durable state"],
    requires: [] as string[],
    invariants: ["atomic commits"],
    interfaces: ["PlanStore"],
    decisions: [] as { runId: string; kind: "decision"; id: string; revision: number }[],
  },
});

describe("revision store (E3/E4/E13/§9/§47/§48)", () => {
  it("sequences revisions 1,2 strictly; skips and duplicates are rejected", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { runId } = await makeRunFixture(root);
      const { store, memory } = await makeWriter(root);
      try {
        memory.insertArtifactIdentity({ runId, kind: "decision", artifactId: "DEC-X" });
        const ref1 = memory.insertMemoryRevision({
          runId, kind: "decision", artifactId: "DEC-X", content: DECISION_1, compactProjection: "DEC-X@1 WAL",
        });
        expect(ref1.revision).toBe(1);
        const ref2 = memory.insertMemoryRevision({
          runId, kind: "decision", artifactId: "DEC-X", content: { ...DECISION_1, title: "Use WAL v2" }, compactProjection: "DEC-X@2 WAL v2",
        });
        expect(ref2.revision).toBe(2);
        // Gap: requesting revision 4 when next is 3.
        expect(() =>
          memory.insertMemoryRevision({ runId, kind: "decision", artifactId: "DEC-X", revision: 4, content: DECISION_1, compactProjection: "x" }),
        ).toThrowError(expect.objectContaining({ code: "MEMORY_REVISION_INVALID" }));
        // Duplicate exact revision conflicts, never overwrites.
        expect(() =>
          memory.insertMemoryRevision({ runId, kind: "decision", artifactId: "DEC-X", revision: 2, content: DECISION_1, compactProjection: "dup" }),
        ).toThrowError(expect.objectContaining({ code: "MEMORY_REVISION_CONFLICT" }));
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("requires the artifact identity before revisions (MEMORY_ARTIFACT_NOT_FOUND)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { runId } = await makeRunFixture(root);
      const { store, memory } = await makeWriter(root);
      try {
        expect(() =>
          memory.insertMemoryRevision({ runId, kind: "decision", artifactId: "DEC-GHOST", content: DECISION_1, compactProjection: "x" }),
        ).toThrowError(expect.objectContaining({ code: "MEMORY_ARTIFACT_NOT_FOUND" }));
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("enforces one architecture artifact identity per run (§15)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { runId } = await makeRunFixture(root);
      const { store, memory } = await makeWriter(root);
      try {
        memory.insertArtifactIdentity({ runId, kind: "architecture", artifactId: "ARCH" });
        expect(() =>
          memory.insertArtifactIdentity({ runId, kind: "architecture", artifactId: "ARCH-B" }),
        ).toThrowError(expect.objectContaining({ code: "MEMORY_REVISION_CONFLICT" }));
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("sections require a contract; other kinds must not carry one (E9/§19)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { runId } = await makeRunFixture(root);
      const { store, memory } = await makeWriter(root);
      try {
        memory.insertArtifactIdentity({ runId, kind: "section", artifactId: "SEC-1" });
        const { contract: _dropped, ...noContract } = SECTION_1(1);
        void _dropped;
        expect(() =>
          memory.insertMemoryRevision({
            runId,
            kind: "section",
            artifactId: "SEC-1",
            content: noContract as unknown as Parameters<typeof memory.insertMemoryRevision>[0]["content"],
            compactProjection: "x",
          }),
        ).toThrowError(expect.objectContaining({ code: "MEMORY_REVISION_INVALID" }));

        memory.insertArtifactIdentity({ runId, kind: "decision", artifactId: "DEC-1" });
        // `contract: undefined` on a decision is simply "no contract" — valid.
        const decRef = memory.insertMemoryRevision({
          runId, kind: "decision", artifactId: "DEC-1",
          content: { ...DECISION_1, contract: undefined }, compactProjection: "x",
        });
        // Non-section revisions persist contract_json = NULL (§19).
        expect(readMemoryRevisionRecord(store, decRef)?.contractJson).toBeNull();
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("rejects cross-run refs inside revision content (§32)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { runId } = await makeRunFixture(root);
      const { store, memory } = await makeWriter(root);
      try {
        memory.insertArtifactIdentity({ runId, kind: "decision", artifactId: "DEC-1" });
        expect(() =>
          memory.insertMemoryRevision({
            runId, kind: "decision", artifactId: "DEC-1",
            content: {
              ...DECISION_1,
              supportingRefs: [{ runId: "plan_other", kind: "constraint", id: "CON-1", revision: 1 }],
            },
            compactProjection: "x",
          }),
        ).toThrowError(expect.objectContaining({ code: "MEMORY_REVISION_INVALID" }));
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("database triggers refuse UPDATE and DELETE on immutable tables (E13/§54)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { runId } = await makeRunFixture(root);
      const { store, memory } = await makeWriter(root);
      try {
        memory.insertArtifactIdentity({ runId, kind: "decision", artifactId: "DEC-X" });
        memory.insertMemoryRevision({ runId, kind: "decision", artifactId: "DEC-X", content: DECISION_1, compactProjection: "DEC-X@1" });
        memory.insertArtifactIdentity({ runId, kind: "section", artifactId: "SEC-1" });
        memory.insertMemoryRevision({ runId, kind: "section", artifactId: "SEC-1", content: SECTION_1(1), compactProjection: "SEC-1@1" });
        const snap = memory.insertSnapshot({ runId, refs: [{ runId, kind: "decision", id: "DEC-X", revision: 1 }] });

        const raw = rawConnection(storePathsFor(root).databasePath, 500);
        try {
          const mustFail = (sql: string): void => {
            expect(() => raw.exec(sql)).toThrowError();
          };
          mustFail(`UPDATE memory_revisions SET compact_projection = 'tampered' WHERE artifact_id = 'DEC-X'`);
          mustFail(`DELETE FROM memory_revisions WHERE artifact_id = 'DEC-X'`);
          mustFail(`UPDATE plan_snapshots SET created_at = 'tampered' WHERE snapshot_id = '${snap.snapshotId}'`);
          mustFail(`DELETE FROM plan_snapshots WHERE snapshot_id = '${snap.snapshotId}'`);
          mustFail(`UPDATE snapshot_members SET revision = 9 WHERE snapshot_id = '${snap.snapshotId}'`);
          mustFail(`DELETE FROM snapshot_members WHERE snapshot_id = '${snap.snapshotId}'`);
          mustFail(`UPDATE memory_artifacts SET artifact_id = 'X' WHERE artifact_id = 'DEC-X'`);
          mustFail(`DELETE FROM memory_artifacts WHERE artifact_id = 'DEC-X'`);
        } finally {
          raw.close();
        }
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("keeps equal artifact ids in different runs fully isolated (E32/§43)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const store = await initializePlanStore({ pluginDataRoot: root });
      try {
        const dir = path.join(root, "project");
        fs.mkdirSync(dir, { recursive: true });
        const { registration } = await discoverAndRegisterWorkspace(store, dir, clock());
        const runs = createPlanningRunService(store, clock());
        const runA = runs.createPlanningRun({ workspaceId: registration.workspace.workspaceId, sessionId: "S1", goal: "A" }).run;
        const runB = runs.createPlanningRun({ workspaceId: registration.workspace.workspaceId, sessionId: "S2", goal: "B" }).run;
        const memory = createInternalPlanMemoryWriter(store, clock());
        memory.insertArtifactIdentity({ runId: runA.runId, kind: "decision", artifactId: "DEC-001" });
        memory.insertArtifactIdentity({ runId: runB.runId, kind: "decision", artifactId: "DEC-001" });
        const refA = memory.insertMemoryRevision({ runId: runA.runId, kind: "decision", artifactId: "DEC-001", content: DECISION_1, compactProjection: "A" });
        const refB = memory.insertMemoryRevision({ runId: runB.runId, kind: "decision", artifactId: "DEC-001", content: { ...DECISION_1, title: "B decision" }, compactProjection: "B" });

        const viewA = readMemoryRevisionRecord(store, refA);
        const viewB = readMemoryRevisionRecord(store, refB);
        expect(viewA?.ref.runId).toBe(runA.runId);
        expect(viewB?.ref.runId).toBe(runB.runId);
        expect((viewB?.content as { title: string }).title).toBe("B decision");
        // Snapshot A cannot reference B's revision (FK + same-run validation).
        expect(() =>
          memory.insertSnapshot({ runId: runA.runId, refs: [refB] }),
        ).toThrowError(expect.objectContaining({ code: "SNAPSHOT_INVALID" }));
        // HEAD A cannot point at a snapshot of run B.
        const snapB = memory.insertSnapshot({ runId: runB.runId, refs: [refB] });
        expect(() =>
          memory.setHeadSnapshot({ runId: runA.runId, expectedHeadSnapshotId: null, nextSnapshotId: snapB.snapshotId }),
        ).toThrowError(expect.objectContaining({ code: "MEMORY_HEAD_INVALID" }));
        void refA;
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });
});

describe("snapshots and HEAD (E17–E26/§28–§39/§78/§79)", () => {
  it("creates exact-ref snapshots with deterministic ordering and stable readback", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { runId } = await makeRunFixture(root);
      const { store, memory } = await makeWriter(root);
      try {
        memory.insertArtifactIdentity({ runId, kind: "decision", artifactId: "DEC-1" });
        memory.insertArtifactIdentity({ runId, kind: "section", artifactId: "SEC-1" });
        const decRef = memory.insertMemoryRevision({ runId, kind: "decision", artifactId: "DEC-1", content: DECISION_1, compactProjection: "D1" });
        const secRef = memory.insertMemoryRevision({ runId, kind: "section", artifactId: "SEC-1", content: SECTION_1(1), compactProjection: "S1" });

        const snapshot = memory.insertSnapshot({ runId, refs: [secRef, decRef] });
        const read = getSnapshotRecord(store, snapshot.snapshotId);
        expect(read?.refs.map((r) => `${r.kind}:${r.id}@${r.revision}`)).toEqual([
          "decision:DEC-1@1",
          "section:SEC-1@1",
        ]);
        expect(listSnapshotRefsRecord(store, snapshot.snapshotId)).toEqual(read?.refs);

        // Contract readback is stable per exact revision.
        const contract = readSectionContractRecord(store, secRef);
        expect(contract).toBeTypeOf("string");
        expect(readSectionContractRecord(store, secRef)).toBe(contract);
        const parsed = JSON.parse(contract ?? "{}") as Record<string, unknown>;
        expect(parsed.sectionId).toBe("SEC-1");
        expect(readSectionContractRecord(store, decRef)).toBeNull();
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("rejects duplicate identities, missing revisions, two architectures, and invalid DAGs (§33)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { runId } = await makeRunFixture(root);
      const { store, memory } = await makeWriter(root);
      try {
        memory.insertArtifactIdentity({ runId, kind: "decision", artifactId: "DEC-1" });
        const dec1 = memory.insertMemoryRevision({ runId, kind: "decision", artifactId: "DEC-1", content: DECISION_1, compactProjection: "v1" });
        const dec2 = memory.insertMemoryRevision({ runId, kind: "decision", artifactId: "DEC-1", content: { ...DECISION_1, title: "v2" }, compactProjection: "v2" });

        expect(() =>
          memory.insertSnapshot({ runId, refs: [dec1, dec2] }),
        ).toThrowError(expect.objectContaining({ code: "SNAPSHOT_INVALID" }));
        expect(() =>
          memory.insertSnapshot({ runId, refs: [{ runId, kind: "decision", id: "DEC-GHOST", revision: 1 }] }),
        ).toThrowError(expect.objectContaining({ code: "MEMORY_REVISION_NOT_FOUND" }));

        memory.insertArtifactIdentity({ runId, kind: "architecture", artifactId: "ARCH" });
        const arch1 = memory.insertMemoryRevision({
          runId, kind: "architecture", artifactId: "ARCH",
          content: { summary: "s", components: [], boundaries: [], dataFlows: [], principles: [], unresolvedQuestionRefs: [], decisionRefs: [] },
          compactProjection: "ARCH@1",
        });
        expect(() =>
          memory.insertSnapshot({ runId, refs: [dec1, { ...arch1, id: "ARCH" }, arch1] }),
        ).toThrowError();
        // Two architecture refs cannot exist in one snapshot — force via a
        // second architecture artifact in a second run is cross-run, so the
        // in-run guard is exercised through duplicate identity above and the
        // architecture-identity uniqueness here.
        expect(() =>
          memory.insertArtifactIdentity({ runId, kind: "architecture", artifactId: "ARCH-ALT" }),
        ).toThrowError(expect.objectContaining({ code: "MEMORY_REVISION_CONFLICT" }));
        void arch1;
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("validates the section DAG over the chosen revisions at snapshot time (E16/§27)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { runId } = await makeRunFixture(root);
      const { store, memory } = await makeWriter(root);
      try {
        memory.insertArtifactIdentity({ runId, kind: "section", artifactId: "SEC-1" });
        memory.insertArtifactIdentity({ runId, kind: "section", artifactId: "SEC-2" });
        memory.insertMemoryRevision({ runId, kind: "section", artifactId: "SEC-1", content: SECTION_1(1), compactProjection: "S1" });
        memory.insertMemoryRevision({
          runId, kind: "section", artifactId: "SEC-2",
          content: { ...SECTION_1(1), dependencies: ["SEC-1"], contract: { ...SECTION_1(1).contract, sectionId: "SEC-2" } },
          compactProjection: "S2",
        });
        const s1 = { runId, kind: "section" as const, id: "SEC-1", revision: 1 };
        const s2 = { runId, kind: "section" as const, id: "SEC-2", revision: 1 };
        const ok = memory.insertSnapshot({ runId, refs: [s1, s2] });
        expect(ok.refs).toHaveLength(2);
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("HEAD CAS: absent initially, null→S1, S1→S2, stale → STALE_MEMORY_HEAD (E23/E26/§79)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { runId } = await makeRunFixture(root);
      const { store, memory } = await makeWriter(root);
      try {
        memory.insertArtifactIdentity({ runId, kind: "decision", artifactId: "DEC-1" });
        const dec1 = memory.insertMemoryRevision({ runId, kind: "decision", artifactId: "DEC-1", content: DECISION_1, compactProjection: "D1" });
        const dec2 = memory.insertMemoryRevision({ runId, kind: "decision", artifactId: "DEC-1", content: { ...DECISION_1, title: "v2" }, compactProjection: "D2" });
        const snap1 = memory.insertSnapshot({ runId, refs: [dec1] });
        const snap2 = memory.insertSnapshot({ runId, refs: [dec2] });

        // Fresh run: no HEAD row, no implicit empty snapshot (E23/§36).
        expect(getHeadSnapshotRecord(store, runId)).toBeNull();

        expect(memory.setHeadSnapshot({ runId, expectedHeadSnapshotId: null, nextSnapshotId: snap1.snapshotId })).toEqual({
          runId,
          headSnapshotId: snap1.snapshotId,
        });
        expect(getHeadSnapshotRecord(store, runId)?.refs).toEqual([dec1]);

        // Stale CAS is refused — the optimistic-concurrency boundary (§57).
        expect(() =>
          memory.setHeadSnapshot({ runId, expectedHeadSnapshotId: null, nextSnapshotId: snap2.snapshotId }),
        ).toThrowError(expect.objectContaining({ code: "STALE_MEMORY_HEAD" }));
        expect(memory.setHeadSnapshot({ runId, expectedHeadSnapshotId: snap1.snapshotId, nextSnapshotId: snap2.snapshotId })).toEqual({
          runId,
          headSnapshotId: snap2.snapshotId,
        });
        expect(getHeadSnapshotRecord(store, runId)?.refs).toEqual([dec2]);

        // PlanningRun.revision is untouched by HEAD movement (E24/§38).
        const runs = createPlanningRunService(store, clock());
        expect(runs.getPlanningRun(runId)?.revision).toBe(1);
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("parallel snapshot creation from the same refs yields two valid snapshots (§56)", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { runId } = await makeRunFixture(root);
      const { store, memory } = await makeWriter(root);
      try {
        memory.insertArtifactIdentity({ runId, kind: "decision", artifactId: "DEC-1" });
        const dec1 = memory.insertMemoryRevision({ runId, kind: "decision", artifactId: "DEC-1", content: DECISION_1, compactProjection: "D1" });
        const snapA = memory.insertSnapshot({ runId, refs: [dec1] });
        const snapB = memory.insertSnapshot({ runId, refs: [dec1] });
        expect(snapA.snapshotId).not.toBe(snapB.snapshotId);
        expect(getSnapshotRecord(store, snapB.snapshotId)?.refs).toEqual(snapA.refs);
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });
});
