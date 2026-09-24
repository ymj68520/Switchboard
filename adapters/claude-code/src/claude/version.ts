/**
 * Claude Code CLI detection (frozen plan §7.3). Detection uses the Node
 * process API only — never `which`/`where`/shell scripts. Results are
 * structured so the doctor can distinguish "not installed", "present but
 * unreadable", and "readable version".
 *
 * Windows notes: `spawn(shell: false)` resolves `.exe` (and extensionless)
 * candidates from PATH, but Node refuses to execute npm `.cmd` shims
 * directly. The shim is therefore launched through `cmd.exe /d /s /c` with a
 * fixed argument vector — no shell parsing, no user input in the command.
 */

import { spawn } from "node:child_process";

export interface ClaudeVersionInfo {
  version: string;
  raw: string;
  binPath: string;
}

export type ClaudeVersionResult =
  | ({ status: "ok" } & ClaudeVersionInfo)
  | { status: "not_found"; attempted: string[] }
  | {
      status: "unreadable";
      reason: string;
      raw?: string;
      binPath?: string;
      exitCode?: number | null;
    };

export interface SpawnOutcome {
  kind: "exit" | "spawn_error" | "timeout";
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  errorCode?: string;
}

export type SpawnRunner = (
  file: string,
  args: string[],
  options: { timeoutMs: number },
) => Promise<SpawnOutcome>;

export interface ClaudeProbeOptions {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

/**
 * Ordered CLI candidates. `PHASE_PLAN_CLAUDE_BIN` is an explicit override
 * (single candidate — its failure is the reported failure, no silent
 * fallback).
 */
export function claudeCandidates(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): { file: string; viaCmdShim: boolean }[] {
  const override = env.PHASE_PLAN_CLAUDE_BIN?.trim();
  if (override) {
    return [{ file: override, viaCmdShim: false }];
  }
  const base = [{ file: "claude", viaCmdShim: false }];
  if (platform === "win32") {
    base.push({ file: "claude.cmd", viaCmdShim: true });
  }
  return base;
}

/** Extract the first semver token from `claude --version` output. */
export function parseClaudeVersion(raw: string): string | null {
  const match = raw.match(/(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)/);
  return match?.[1] ?? null;
}

/** Real process-level runner used in production (doctor default deps). */
export const nodeSpawnRunner: SpawnRunner = (file, args, { timeoutMs }) =>
  new Promise((resolve) => {
    const child = spawn(file, args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    let stdout = "";
    let stderr = "";
    const finish = (outcome: SpawnOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ kind: "timeout" });
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < 64 * 1024) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 16 * 1024) stderr += chunk.toString("utf8");
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      finish({ kind: "spawn_error", errorCode: err.code ?? "UNKNOWN" });
    });
    child.on("close", (code) => {
      finish({ kind: "exit", exitCode: code, stdout, stderr });
    });
  });

function spawnArgsFor(candidate: { file: string; viaCmdShim: boolean }): {
  file: string;
  args: string[];
} {
  if (candidate.viaCmdShim) {
    // Fixed argv through cmd.exe; the shim path is resolved by Node's spawn
    // PATH search, so no shell string interpolation ever happens.
    return { file: "cmd.exe", args: ["/d", "/s", "/c", candidate.file, "--version"] };
  }
  return { file: candidate.file, args: ["--version"] };
}

/**
 * Probe `claude --version` across candidates. Tries each candidate in order;
 * the first readable semver wins. All-attempted-ENOENT → not_found; anything
 * else that prevents a readable version → unreadable (fail-closed upstream).
 */
export async function probeClaudeVersion(
  runner: SpawnRunner = nodeSpawnRunner,
  options: ClaudeProbeOptions = {},
): Promise<ClaudeVersionResult> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;

  const attempted: string[] = [];
  let firstUnreadable: Extract<ClaudeVersionResult, { status: "unreadable" }> | null = null;

  for (const candidate of claudeCandidates(env, platform)) {
    attempted.push(candidate.file);
    const { file, args } = spawnArgsFor(candidate);
    const outcome = await runner(file, args, { timeoutMs });

    if (outcome.kind === "spawn_error") {
      if (outcome.errorCode === "ENOENT") continue;
      firstUnreadable ??= {
        status: "unreadable",
        reason: `failed to launch ${candidate.file}: ${outcome.errorCode}`,
        binPath: candidate.file,
      };
      continue;
    }
    if (outcome.kind === "timeout") {
      firstUnreadable ??= {
        status: "unreadable",
        reason: `claude --version timed out after ${timeoutMs}ms`,
        binPath: candidate.file,
      };
      break;
    }
    const raw = (outcome.stdout ?? "").trim();
    if (outcome.exitCode !== 0) {
      firstUnreadable ??= {
        status: "unreadable",
        reason: `claude --version exited with code ${outcome.exitCode ?? "null"}`,
        raw: raw || outcome.stderr?.trim(),
        binPath: candidate.file,
        exitCode: outcome.exitCode ?? null,
      };
      continue;
    }
    const version = parseClaudeVersion(raw);
    if (version === null) {
      firstUnreadable ??= {
        status: "unreadable",
        reason: "could not parse a semver from claude --version output",
        raw,
        binPath: candidate.file,
        exitCode: outcome.exitCode ?? null,
      };
      continue;
    }
    return { status: "ok", version, raw, binPath: candidate.file };
  }

  if (firstUnreadable !== null) {
    return firstUnreadable;
  }
  return { status: "not_found", attempted };
}
