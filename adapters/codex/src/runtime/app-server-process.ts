/**
 * Process seam between the session runtime and the spawned app-server child.
 *
 * The indirection exists so tests can inject controllable fake children
 * (Phase 1 directive §12.2) without a real Codex install. The Node
 * implementation in this module owns all platform-specific mechanics:
 *
 * - argv-array spawn, never shell string concatenation;
 * - stderr/stdout piped so the launcher can read startup output;
 * - on POSIX the child gets its own process group (detached) so termination
 *   can signal the whole shim→binary tree;
 * - on Windows there is no graceful cross-process terminate for console
 *   processes, so `requestTerminate` performs a tree kill via
 *   `taskkill /T /F` (argv array, not a shell string) — this is what makes
 *   cleanup deterministic under the npm shim→node→codex.exe process chain.
 */

import { spawn } from "node:child_process";
import type { Readable } from "node:stream";

import type { ChildExitStatus } from "./types.js";

export interface AppServerProcess {
  /** OS pid, undefined when the process could not be spawned at all. */
  readonly pid: number | undefined;
  /** Resolves with the exit status once the child is gone. */
  readonly exits: Promise<ChildExitStatus>;
  /** Decoded chunks of the child's stderr. */
  stderrStream(): AsyncIterable<string>;
  /** Decoded chunks of the child's stdout. */
  stdoutStream(): AsyncIterable<string>;
  /**
   * First-step termination request. POSIX: SIGTERM to the process group
   * (falling back to the direct child). Windows: tree kill (taskkill /T /F).
   */
  requestTerminate(): void;
  /** Force kill fallback: SIGKILL semantics, process-group wide on POSIX. */
  forceKill(): void;
  /**
   * Synchronous best-effort direct kill, only for the process-exit orphan
   * guard (async tree kills cannot complete inside an "exit" handler).
   */
  killImmediate(): void;
}

export interface SpawnRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /**
   * stdio attachment mode. "pipe" (default — app-server: the launcher reads
   * startup output) or "inherit" (Phase 5 TUI: the child must own the user
   * terminal — directive §18). Termination semantics are identical.
   */
  readonly stdio?: "pipe" | "inherit";
}

export type AppServerProcessFactory = (request: SpawnRequest) => AppServerProcess;

export class NodeAppServerProcess implements AppServerProcess {
  readonly pid: number | undefined;
  readonly exits: Promise<ChildExitStatus>;

  private readonly child: ReturnType<typeof spawn>;

  constructor(request: SpawnRequest) {
    // detached:true on POSIX puts the child in its own process group so we
    // can signal the entire shim tree; on Windows it only affects console
    // attachment and is left off. No shell, argv array only.
    this.child = spawn(request.command, [...request.args], {
      cwd: request.cwd,
      env: request.env,
      shell: false,
      detached: process.platform !== "win32",
      stdio: request.stdio === "inherit" ? ["inherit", "inherit", "inherit"] : ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.pid = this.child.pid;

    this.exits = new Promise<ChildExitStatus>((resolve, reject) => {
      this.child.once("error", (error) => {
        reject(error as NodeJS.ErrnoException);
      });
      this.child.once("exit", (exitCode, signal) => {
        resolve({ exitCode, signal });
      });
    });
  }

  async *decode(stream: Readable): AsyncGenerator<string> {
    stream.setEncoding("utf8");
    for await (const chunk of stream) {
      yield typeof chunk === "string" ? chunk : String(chunk);
    }
  }

  stderrStream(): AsyncIterable<string> {
    if (!this.child.stderr) {
      return (async function* empty() {})();
    }
    return this.decode(this.child.stderr);
  }

  stdoutStream(): AsyncIterable<string> {
    if (!this.child.stdout) {
      return (async function* empty() {})();
    }
    return this.decode(this.child.stdout);
  }

  requestTerminate(): void {
    if (this.pid === undefined) return;
    if (process.platform === "win32") {
      // No graceful remote terminate exists for Windows console processes.
      // taskkill with /T /F removes the whole shim→binary tree; spawned via
      // argv array so nothing is concatenated into a shell string.
      const taskkill = spawn("taskkill", ["/pid", String(this.pid), "/T", "/F"], {
        shell: false,
        windowsHide: true,
        stdio: "ignore",
      });
      taskkill.once("error", () => {
        // taskkill unavailable/failed — fall back to direct termination.
        this.child.kill();
      });
      return;
    }
    // Negative pid signals the whole process group (child is detached).
    try {
      process.kill(-this.pid, "SIGTERM");
    } catch {
      this.child.kill("SIGTERM");
    }
  }

  forceKill(): void {
    if (this.pid === undefined) {
      return;
    }
    if (process.platform === "win32") {
      const taskkill = spawn("taskkill", ["/pid", String(this.pid), "/T", "/F"], {
        shell: false,
        windowsHide: true,
        stdio: "ignore",
      });
      taskkill.once("error", () => {
        this.child.kill("SIGKILL");
      });
      return;
    }
    try {
      process.kill(-this.pid, "SIGKILL");
    } catch {
      this.child.kill("SIGKILL");
    }
  }

  killImmediate(): void {
    this.child.kill("SIGKILL");
  }
}

/**
 * Default factory used by the runtime unless a test injects its own.
 * Spawn errors (e.g. ENOENT) surface through `exits` rejection, never
 * synchronously, so the runtime handles every failure on one path.
 */
export const nodeAppServerProcessFactory: AppServerProcessFactory = (request) =>
  new NodeAppServerProcess(request);
