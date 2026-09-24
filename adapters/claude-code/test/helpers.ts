/**
 * Shared test doubles for the Phase Plan runtime suite. Everything that
 * touches the host machine (spawn, filesystem, node version, node:sqlite) is
 * faked here so tests never depend on a specific Claude Code install or
 * Node build.
 */

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { SpawnOutcome, SpawnRunner } from "../src/claude/version.js";
import type { SqliteDatabaseLike, SqliteModule } from "../src/store/sqlite-capability.js";

/** Spawn runner whose outcomes are keyed by the spawned file name. */
export function fakeSpawnRunner(
  outcomes: Record<
    string,
    | SpawnOutcome
    | ((file: string, args: string[], options: { timeoutMs: number }) => SpawnOutcome)
  >,
): SpawnRunner {
  return (file, args, options) => {
    const key = outcomes[file] !== undefined ? file : "*";
    const outcome = outcomes[key];
    if (outcome === undefined) {
      return Promise.resolve({ kind: "spawn_error", errorCode: "ENOENT" });
    }
    const resolved = typeof outcome === "function" ? outcome(file, args, options) : outcome;
    return Promise.resolve(resolved);
  };
}

export function claudeVersionOutcome(version: string): SpawnOutcome {
  return { kind: "exit", exitCode: 0, stdout: `Claude Code ${version}\n`, stderr: "" };
}

/** In-memory DatabaseSync double covering the probe's SQL surface. */
export class FakeDatabaseSync implements SqliteDatabaseLike {
  private closed = false;
  private rows = new Map<string, unknown>();

  constructor(_path: string) {
    void _path;
  }

  exec(sql: string): void {
    if (this.closed) throw new Error("database is closed");
    if (sql.includes("FAILPOINT")) throw new Error(`injected failure: ${sql}`);
  }

  prepare(sql: string): { run: (...params: unknown[]) => unknown; get: (...params: unknown[]) => unknown } {
    if (this.closed) throw new Error("database is closed");
    if (sql.includes("sqlite_version")) {
      return { run: () => undefined, get: () => ({ v: "9.9.9-fake" }) };
    }
    if (sql.toUpperCase().startsWith("INSERT")) {
      return {
        run: (...params: unknown[]) => {
          const key = params[0];
          if (typeof key === "string") this.rows.set(key, params[1]);
          return { changes: 1 };
        },
        get: () => undefined,
      };
    }
    return {
      run: () => undefined,
      get: (...params: unknown[]) => {
        const key = params[0];
        if (typeof key === "string" && this.rows.has(key)) {
          return { v: this.rows.get(key) };
        }
        return undefined;
      },
    };
  }

  close(): void {
    if (this.closed) throw new Error("database already closed");
    this.closed = true;
  }
}

export function fakeSqliteModule(overrides?: {
  DatabaseSync?: new (path: string) => SqliteDatabaseLike;
}): SqliteModule {
  return { DatabaseSync: overrides?.DatabaseSync ?? FakeDatabaseSync };
}

export function fakeSqliteLoader(module: SqliteModule = fakeSqliteModule()) {
  return async () => module;
}

export function failingSqliteLoader(error: Error) {
  return async (): Promise<SqliteModule> => {
    throw error;
  };
}

/** Temp directory helper that removes the tree on cleanup. */
export async function makeTempDir(prefix = "phase-plan-test-"): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function removeTempDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

/** Path of the built runtime bundle (produced by `npm run build`). */
export function runtimeBundlePath(): string {
  return fileURLToPath(new URL("../dist/phase-plan-runtime.mjs", import.meta.url));
}

/** JSONL stdio client for the MCP bundle smoke test. */
export interface McpSmokeResult {
  exitCode: number | null;
  stdoutLines: string[];
  stderr: string;
  timedOut: boolean;
}

export function runMcpSmoke(
  nodePath: string,
  bundlePath: string,
  options: { initialize?: boolean; toolsList?: boolean; timeoutMs?: number } = {},
): Promise<McpSmokeResult> {
  const { initialize = true, toolsList = true, timeoutMs = 15000 } = options;
  return new Promise((resolve) => {
    const child = spawn(nodePath, [bundlePath, "mcp"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));

    const send = (obj: unknown): void => {
      child.stdin?.write(JSON.stringify(obj) + "\n");
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    if (initialize) {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "phase-plan-smoke", version: "0.0.0" },
        },
      });
      setTimeout(() => {
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
        if (toolsList) {
          send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
        }
        // Give the responses a moment to arrive, then close stdin so the
        // server performs its clean shutdown path.
        setTimeout(() => child.stdin?.end(), 400);
      }, 300);
    } else {
      setTimeout(() => child.stdin?.end(), 200);
    }

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exitCode: null, stdoutLines: [], stderr: String(err), timedOut });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      const lines = stdout.split("\n").filter((l) => l.trim() !== "");
      resolve({ exitCode: code, stdoutLines: lines, stderr, timedOut });
    });
  });
}
