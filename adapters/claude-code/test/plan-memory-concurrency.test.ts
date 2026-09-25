import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as esbuild from "esbuild";

import { createInternalPlanMemoryWriter } from "../src/store/plan-memory.js";
import { createPlanningRunService } from "../src/application/planning-run-service.js";
import { discoverAndRegisterWorkspace } from "../src/workspace/identity.js";
import { initializePlanStore } from "../src/store/sqlite-store.js";
import { fixedClock, makeTempPluginDataRoot, removeTempPluginDataRoot } from "./store-helpers.js";

const WORKER_SOURCE = fileURLToPath(new URL("./workers/planning-worker.ts", import.meta.url));

interface WorkerResult {
  ok: boolean;
  revision?: number;
  code?: string;
  message?: string;
}

async function bundleWorker(bundledDir: string): Promise<string> {
  const outfile = path.join(bundledDir, "planning-worker.mjs");
  await esbuild.build({
    entryPoints: [WORKER_SOURCE],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    logLevel: "silent",
  });
  return outfile;
}

function runWorker(workerPath: string, args: string[]): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`memory worker timed out; stderr: ${stderr}`));
    }, 25000);
    child.on("exit", () => {
      clearTimeout(timer);
      const line = stdout.split("\n").find((l) => l.trim().startsWith("{"));
      if (!line) {
        reject(new Error(`memory worker produced no JSON; stderr: ${stderr}`));
        return;
      }
      resolve(JSON.parse(line) as WorkerResult);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function prepareRunWithDecision(root: string): Promise<{ runId: string; artifactId: string }> {
  const store = await initializePlanStore({ pluginDataRoot: root });
  try {
    const dir = path.join(root, "project");
    fs.mkdirSync(dir, { recursive: true });
    const { registration } = await discoverAndRegisterWorkspace(store, dir, fixedClock({ ids: ["r", "w"] }));
    const runs = createPlanningRunService(store, fixedClock({ ids: ["x"] }));
    const { run } = runs.createPlanningRun({
      workspaceId: registration.workspace.workspaceId,
      sessionId: "S1",
      goal: "memory race",
    });
    const memory = createInternalPlanMemoryWriter(store, clock());
    memory.insertArtifactIdentity({ runId: run.runId, kind: "decision", artifactId: "DEC-X" });
    memory.insertMemoryRevision({
      runId: run.runId,
      kind: "decision",
      artifactId: "DEC-X",
      content: decision("r1"),
      compactProjection: "DEC-X@1",
    });
    return { runId: run.runId, artifactId: "DEC-X" };
  } finally {
    store.close();
  }
}

function decision(title: string) {
  return {
    title,
    statement: "s",
    rationale: "r",
    alternatives: [],
    consequences: [],
    scope: "test",
    supportingRefs: [],
  };
}

function clock() {
  return fixedClock({ nowIso: "2026-07-07T00:00:00.000Z", ids: ["s1"] });
}

describe("Plan Memory concurrency (E33/§55/§56/§57/§81)", () => {
  it("two processes racing the same next revision let exactly one win", async () => {
    const root = makeTempPluginDataRoot();
    const bundledDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase-plan-mem-"));
    try {
      const { runId, artifactId } = await prepareRunWithDecision(root);
      const worker = await bundleWorker(bundledDir);
      const [a, b] = await Promise.all([
        runWorker(worker, ["memory-revision", root, runId, artifactId, "2", "winner A", "10000"]),
        runWorker(worker, ["memory-revision", root, runId, artifactId, "2", "winner B", "10000"]),
      ]);
      const winners = [a, b].filter((r) => r.ok);
      const losers = [a, b].filter((r) => !r.ok);
      expect(winners).toHaveLength(1);
      expect(winners[0]?.revision).toBe(2);
      expect(losers).toHaveLength(1);
      expect(losers[0]?.code).toBe("MEMORY_REVISION_CONFLICT");

      // Final max revision is exactly 2 — no duplicate revision 2 exists.
      const store = await initializePlanStore({ pluginDataRoot: root });
      try {
        const revisions = store.withRead((tx) =>
          tx.prepare("SELECT revision, content_json FROM memory_revisions WHERE artifact_id = 'DEC-X' ORDER BY revision").all(),
        ) as { revision: number; content_json: string }[];
        expect(revisions.map((r) => r.revision)).toEqual([1, 2]);
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
      fs.rmSync(bundledDir, { recursive: true, force: true });
    }
  });

  it("HEAD CAS conflict across store handles: stale expected head is refused", async () => {
    const root = makeTempPluginDataRoot();
    try {
      const { runId } = await prepareRunWithDecision(root);
      const storeA = await initializePlanStore({ pluginDataRoot: root });
      const storeB = await initializePlanStore({ pluginDataRoot: root });
      try {
        const memoryA = createInternalPlanMemoryWriter(storeA, clock());
        const memoryB = createInternalPlanMemoryWriter(storeB, fixedClock({ nowIso: "2026-07-07T01:00:00.000Z", ids: ["s2"] }));
        memoryA.insertArtifactIdentity({ runId, kind: "decision", artifactId: "DEC-Y" });
        const dec1 = memoryA.insertMemoryRevision({ runId, kind: "decision", artifactId: "DEC-Y", content: decision("v1"), compactProjection: "v1" });
        const dec2 = memoryB.insertMemoryRevision({ runId, kind: "decision", artifactId: "DEC-Y", content: decision("v2"), compactProjection: "v2" });
        const snap1 = memoryA.insertSnapshot({ runId, refs: [dec1] });
        const snap2 = memoryB.insertSnapshot({ runId, refs: [dec2] });

        // Both handles believe HEAD is absent; only the first CAS can win.
        expect(memoryA.setHeadSnapshot({ runId, expectedHeadSnapshotId: null, nextSnapshotId: snap1.snapshotId })).toEqual({
          runId,
          headSnapshotId: snap1.snapshotId,
        });
        expect(() =>
          memoryB.setHeadSnapshot({ runId, expectedHeadSnapshotId: null, nextSnapshotId: snap2.snapshotId }),
        ).toThrowError(expect.objectContaining({ code: "STALE_MEMORY_HEAD" }));
        // And the winner's CAS proceeds from the new head.
        expect(memoryB.setHeadSnapshot({ runId, expectedHeadSnapshotId: snap1.snapshotId, nextSnapshotId: snap2.snapshotId })).toEqual({
          runId,
          headSnapshotId: snap2.snapshotId,
        });
      } finally {
        storeA.close();
        storeB.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });
});
