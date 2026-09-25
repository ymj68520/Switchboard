import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as esbuild from "esbuild";

import { sqliteBackupAvailable } from "../src/store/connection.js";
import { initializePlanStore } from "../src/store/sqlite-store.js";
import {
  createSchema0Database,
  ensureStoreDir,
  makeTempPluginDataRoot,
  pendingBackups,
  publishedBackups,
  rawConnection,
  rawSetSchemaVersion,
  removeTempPluginDataRoot,
  storePathsFor,
  tableNames,
} from "./store-helpers.js";

const backupSupported = sqliteBackupAvailable();
const WORKER_SOURCE = fileURLToPath(new URL("./workers/store-init-worker.ts", import.meta.url));

interface WorkerResult {
  ok: boolean;
  storeId?: string;
  schemaVersion?: number;
  code?: string;
  message?: string;
}

async function bundleWorker(bundledDir: string): Promise<string> {
  const outfile = path.join(bundledDir, "store-init-worker.mjs");
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

function runWorker(
  workerPath: string,
  pluginDataRoot: string,
  busyTimeoutMs: number,
): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath, pluginDataRoot, String(busyTimeoutMs)], {
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

describe.skipIf(!backupSupported)("real multi-process initialization (E24/§36/E9/E10)", () => {
  it("serializes concurrent initializers of one schema-0 database into one valid store", async () => {
    const root = makeTempPluginDataRoot();
    const bundledDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase-plan-worker-"));
    try {
      const { databasePath, backupsDir } = storePathsFor(root);
      // Pre-existing schema-0 database with sentinel data: every process will
      // see "migration needed" on its fast path and must fight for the
      // writer reservation.
      ensureStoreDir(root);
      createSchema0Database(databasePath, "concurrency-sentinel");

      const worker = await bundleWorker(bundledDir);
      const results = await Promise.all([
        runWorker(worker, root, 10000),
        runWorker(worker, root, 10000),
        runWorker(worker, root, 10000),
      ]);

      // Every caller ends in a valid state reporting the SAME store identity.
      for (const result of results) {
        expect(result.ok, JSON.stringify(result)).toBe(true);
        expect(result.schemaVersion).toBe(3);
      }
      const storeIds = new Set(results.map((r) => r.storeId));
      expect(storeIds.size).toBe(1);

      // Exactly one valid store: schema 1, exactly one migration row,
      // sentinel preserved, integrity clean, exactly one published backup.
      const store = await initializePlanStore({ pluginDataRoot: root });
      try {
        expect(store.getSchemaVersion()).toBe(3);
        expect(store.getStoreMetadata().storeId).toBe(results[0]?.storeId);
        const history = store.withRead((tx) =>
          tx.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all(),
        ) as { version: number; name: string }[];
        expect(history).toEqual([
          { version: 1, name: "initialize-plan-store" },
          { version: 2, name: "workspace-and-session-binding" },
          { version: 3, name: "planning-run-foundation" },
        ]);
        const sentinel = store.withRead((tx) =>
          tx.prepare("SELECT note FROM legacy_marker").all(),
        ) as { note: string }[];
        expect(sentinel[0]?.note).toBe("concurrency-sentinel");
        const integrity = store.withRead((tx) =>
          tx.prepare("PRAGMA integrity_check").get(),
        ) as Record<string, unknown>;
        expect(Object.values(integrity)[0]).toBe("ok");
      } finally {
        store.close();
      }
      expect(publishedBackups(backupsDir), JSON.stringify({ published: publishedBackups(backupsDir), pending: pendingBackups(backupsDir) })).toHaveLength(1);
      expect(pendingBackups(backupsDir), JSON.stringify({ published: publishedBackups(backupsDir), pending: pendingBackups(backupsDir) })).toEqual([]);
      expect(tableNames(databasePath).sort()).toEqual([
        "legacy_marker",
        "planning_runs",
        "repositories",
        "schema_migrations",
        "session_bindings",
        "store_metadata",
        "workspaces",
      ]);
    } finally {
      removeTempPluginDataRoot(root);
      fs.rmSync(bundledDir, { recursive: true, force: true });
    }
  });

  it("a real worker process fails closed on a too-new store", async () => {
    const root = makeTempPluginDataRoot();
    const bundledDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase-plan-worker-"));
    try {
      const store = await initializePlanStore({ pluginDataRoot: root });
      store.close();
      rawSetSchemaVersion(storePathsFor(root).databasePath, 4);

      const worker = await bundleWorker(bundledDir);
      const result = await runWorker(worker, root, 2000);
      expect(result).toMatchObject({ ok: false, code: "STORE_SCHEMA_TOO_NEW" });
      // Untouched.
      expect(rawConnectionQueried(storePathsFor(root).databasePath)).toBe(4);
    } finally {
      removeTempPluginDataRoot(root);
      fs.rmSync(bundledDir, { recursive: true, force: true });
    }
  });
});

function rawConnectionQueried(databasePath: string): number {
  const db = rawConnection(databasePath, 500);
  try {
    const row = db.prepare("PRAGMA user_version").get() as Record<string, unknown>;
    return Object.values(row)[0] as number;
  } finally {
    db.close();
  }
}
