import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as esbuild from "esbuild";

import { createBindingService } from "../src/session/binding-service.js";
import { initializePlanStore } from "../src/store/sqlite-store.js";
import { discoverAndRegisterWorkspace } from "../src/workspace/identity.js";
import { fixedClock, makeTempPluginDataRoot, removeTempPluginDataRoot } from "./store-helpers.js";

const WORKER_SOURCE = fileURLToPath(new URL("./workers/binding-worker.ts", import.meta.url));

interface WorkerResult {
  ok: boolean;
  repositoryId?: string;
  workspaceId?: string;
  generation?: number;
  sessionId?: string;
  code?: string;
  message?: string;
}

async function bundleWorker(bundledDir: string): Promise<string> {
  const outfile = path.join(bundledDir, "binding-worker.mjs");
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
      reject(new Error(`binding worker timed out; stderr: ${stderr}`));
    }, 25000);
    child.on("exit", () => {
      clearTimeout(timer);
      const line = stdout.split("\n").find((l) => l.trim().startsWith("{"));
      if (!line) {
        reject(new Error(`binding worker produced no JSON; stderr: ${stderr}`));
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

async function prepareWorkspace(root: string): Promise<string> {
  const store = await initializePlanStore({ pluginDataRoot: root });
  try {
    const projectDir = path.join(root, "project");
    fs.mkdirSync(projectDir, { recursive: true });
    const { registration } = await discoverAndRegisterWorkspace(store, projectDir, fixedClock({ ids: ["r0", "w0"] }));
    return registration.workspace.workspaceId;
  } finally {
    store.close();
  }
}

describe("real multi-process concurrency (E8/E18/§15/§27)", () => {
  it("concurrent first registration converges on one repository/workspace identity", async () => {
    const root = makeTempPluginDataRoot();
    const bundledDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase-plan-bind-"));
    try {
      const projectDir = path.join(root, "shared project", "ünïcode");
      fs.mkdirSync(projectDir, { recursive: true });
      const worker = await bundleWorker(bundledDir);
      const results = await Promise.all([
        runWorker(worker, ["register", root, projectDir, "10000"]),
        runWorker(worker, ["register", root, projectDir, "10000"]),
        runWorker(worker, ["register", root, projectDir, "10000"]),
      ]);
      for (const result of results) {
        expect(result.ok, JSON.stringify(result)).toBe(true);
      }
      const workspaceIds = new Set(results.map((r) => r.workspaceId));
      const repositoryIds = new Set(results.map((r) => r.repositoryId));
      expect(workspaceIds.size).toBe(1);
      expect(repositoryIds.size).toBe(1);

      // Exactly one catalog row each — no duplicates.
      const store = await initializePlanStore({ pluginDataRoot: root });
      try {
        const repos = store.withRead((tx) => tx.prepare("SELECT count(*) AS n FROM repositories").get()) as { n: number };
        const workspaces = store.withRead((tx) => tx.prepare("SELECT count(*) AS n FROM workspaces").get()) as { n: number };
        expect(repos.n).toBe(1);
        expect(workspaces.n).toBe(1);
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
      fs.rmSync(bundledDir, { recursive: true, force: true });
    }
  });

  it("two processes competing to bind one run let exactly one win", async () => {
    const root = makeTempPluginDataRoot();
    const bundledDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase-plan-bind-"));
    try {
      const workspaceId = await prepareWorkspace(root);
      const worker = await bundleWorker(bundledDir);
      const [a, b] = await Promise.all([
        runWorker(worker, ["bind", root, "RUN-X", workspaceId, "S1", "10000"]),
        runWorker(worker, ["bind", root, "RUN-X", workspaceId, "S2", "10000"]),
      ]);
      const winners = [a, b].filter((r) => r.ok);
      const losers = [a, b].filter((r) => !r.ok);
      expect(winners).toHaveLength(1);
      expect(winners[0]?.generation).toBe(1);
      expect(losers).toHaveLength(1);
      expect(losers[0]?.code).toBe("RUN_ALREADY_BOUND");
    } finally {
      removeTempPluginDataRoot(root);
      fs.rmSync(bundledDir, { recursive: true, force: true });
    }
  });

  it("concurrent takeovers from the same expected generation produce exactly one winner at generation+1 (§26/§27)", async () => {
    const root = makeTempPluginDataRoot();
    const bundledDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase-plan-bind-"));
    try {
      const workspaceId = await prepareWorkspace(root);
      const store = await initializePlanStore({ pluginDataRoot: root });
      const bindings = createBindingService(store, fixedClock({ ids: ["x"] }));
      bindings.bind({ runId: "RUN-X", workspaceId, sessionId: "S1" });
      store.close();

      const worker = await bundleWorker(bundledDir);
      const [a, b] = await Promise.all([
        runWorker(worker, ["takeover", root, "RUN-X", workspaceId, "S2", "1", "10000"]),
        runWorker(worker, ["takeover", root, "RUN-X", workspaceId, "S3", "1", "10000"]),
      ]);
      const winners = [a, b].filter((r) => r.ok);
      const losers = [a, b].filter((r) => !r.ok);
      expect(winners).toHaveLength(1);
      expect(winners[0]?.generation).toBe(2); // NOT 3 — the loser never double-increments
      expect(losers).toHaveLength(1);
      expect(losers[0]?.code).toBe("STALE_SESSION_BINDING");

      // The stale owner (generation 1) can no longer write (§26).
      const reopened = await initializePlanStore({ pluginDataRoot: root });
      try {
        const final = createBindingService(reopened, fixedClock({ ids: ["x"] }));
        expect(final.getBinding("RUN-X")).toMatchObject({ generation: 2 });
        expect(() =>
          final.assertWritable({ runId: "RUN-X", workspaceId, sessionId: "S1", generation: 1 }),
        ).toThrowError(expect.objectContaining({ code: "STALE_SESSION_BINDING" }));
      } finally {
        reopened.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
      fs.rmSync(bundledDir, { recursive: true, force: true });
    }
  });
});
