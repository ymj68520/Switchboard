/**
 * Real multi-process concurrency (Phase 9 §41/§69/§70, E45/E46): two actual
 * worker processes race one Observation capture / one Evidence promotion.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as esbuild from "esbuild";

import { listObservationsRecord } from "../src/store/observations.js";
import { listEvidenceRecord } from "../src/store/evidence.js";
import { payloadHashHex } from "../src/store/blob-store.js";
import { captureObservation } from "../src/observations/capture.js";
import {
  captureDeps,
  makePhase9Fixture,
  sourceEvent,
  writeSourceFile,
} from "./phase9-helpers.js";

const WORKER_SOURCE = fileURLToPath(new URL("./workers/observation-worker.ts", import.meta.url));

interface WorkerResult {
  ok: boolean;
  status?: string;
  observationId?: string;
  payloadHash?: string | null;
  evidenceId?: string;
  revision?: number;
  idempotent?: boolean;
  code?: string;
}

async function bundleWorker(bundledDir: string): Promise<string> {
  const outfile = path.join(bundledDir, "observation-worker.mjs");
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

function runWorker(workerPath: string, pluginDataRoot: string, job: unknown): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath, pluginDataRoot, JSON.stringify(job)], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`worker timed out; stderr: ${stderr}`));
    }, 20000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      const line = stdout.split("\n").find((l) => l.trim().startsWith("{"));
      if (!line) {
        reject(new Error(`worker produced no JSON (exit ${code}); stderr: ${stderr}`));
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

describe("multi-process observation capture race (§41/§69, E45)", () => {
  it("two real hook workers capture the same tool use: one Observation, one blob object", async () => {
    const f = await makePhase9Fixture();
    const bundledDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase-plan-obs-worker-"));
    try {
      writeSourceFile(f, "race.txt", "RACE PAYLOAD shared\n");
      const event = sourceEvent(f, "race.txt");
      const worker = await bundleWorker(bundledDir);
      const job = {
        mode: "capture",
        runId: f.runId,
        workspaceId: f.workspaceId,
        event,
      };
      const [a, b] = await Promise.all([
        runWorker(worker, f.root, job),
        runWorker(worker, f.root, job),
      ]);
      expect(a.ok && b.ok).toBe(true);
      expect(new Set([a.status, b.status])).toEqual(new Set(["captured", "duplicate"]));
      expect(a.observationId).toBe(b.observationId);

      const rows = listObservationsRecord(f.store, f.runId, { limit: 100 });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.observationId).toBe(a.observationId);

      // Exactly one canonical blob object for the payload.
      const hex = payloadHashHex(rows[0]!.payloadHash!);
      const blobDir = path.join(f.root, "blobs", "sha256", hex.slice(0, 2));
      const files = fs.readdirSync(blobDir).filter((name) => !name.startsWith("."));
      expect(files).toEqual([hex]);
    } finally {
      f.close();
      fs.rmSync(bundledDir, { recursive: true, force: true });
    }
  });

  it("two workers with the same tool use but different results: the loser fails closed (OBSERVATION_CONFLICT)", async () => {
    const f = await makePhase9Fixture();
    const bundledDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase-plan-obs-worker-"));
    try {
      writeSourceFile(f, "conflict.txt", "conflict\n");
      const worker = await bundleWorker(bundledDir);
      const base = { mode: "capture", runId: f.runId, workspaceId: f.workspaceId };
      const jobA = { ...base, event: sourceEvent(f, "conflict.txt") };
      const jobB = { ...base, event: sourceEvent(f, "conflict.txt", {
        toolResponse: { type: "text", file: { filePath: "conflict.txt", content: "DIFFERENT RESULT\n" } },
      }) };
      const [a, b] = await Promise.all([
        runWorker(worker, f.root, jobA),
        runWorker(worker, f.root, jobB),
      ]);
      const outcomes = [a, b];
      expect(outcomes.filter((r) => r.ok && r.status === "captured")).toHaveLength(1);
      expect(outcomes.filter((r) => !r.ok && r.code === "OBSERVATION_CONFLICT")).toHaveLength(1);
      expect(listObservationsRecord(f.store, f.runId, { limit: 100 })).toHaveLength(1);
    } finally {
      f.close();
      fs.rmSync(bundledDir, { recursive: true, force: true });
    }
  });
});

describe("multi-process promotion race (§70, E46)", () => {
  it("two workers with the same signed operation identity: one Evidence revision; different semantics → IDEMPOTENCY_CONFLICT", async () => {
    const f = await makePhase9Fixture();
    const bundledDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase-plan-obs-worker-"));
    try {
      writeSourceFile(f, "promo.txt", "promotion base\n");
      // Pre-capture in-process so both workers promote the same observation.
      const outcome = await captureObservation(captureDeps(f), sourceEvent(f, "promo.txt"));
      const observationId = (outcome as { status: "captured"; observation: { observationId: string } }).observation.observationId;

      const worker = await bundleWorker(bundledDir);
      const base = { mode: "promote", runId: f.runId, workspaceId: f.workspaceId, operationId: "promote:race" };
      const request = {
        claim: "raced claim",
        kind: "source_fact",
        scope: { type: "global" },
        confidence: "direct",
        criticality: "supporting",
        observationRefs: [observationId],
        derivedFrom: [],
      };
      const [a, b] = await Promise.all([
        runWorker(worker, f.root, { ...base, request }),
        runWorker(worker, f.root, { ...base, request }),
      ]);
      expect(a.ok && b.ok).toBe(true);
      expect(new Set([a.idempotent, b.idempotent])).toEqual(new Set([false, true]));
      expect(a.evidenceId).toBe(b.evidenceId);
      expect(a.revision).toBe(1);
      expect(listEvidenceRecord(f.store, f.runId)).toHaveLength(1);

      // Different semantics under the same operation identity fails closed.
      const drifted = await runWorker(worker, f.root, {
        ...base,
        request: { ...request, claim: "different claim" },
      });
      expect(drifted).toMatchObject({ ok: false, code: "IDEMPOTENCY_CONFLICT" });
      expect(listEvidenceRecord(f.store, f.runId)).toHaveLength(1);
    } finally {
      f.close();
      fs.rmSync(bundledDir, { recursive: true, force: true });
    }
  });
});
