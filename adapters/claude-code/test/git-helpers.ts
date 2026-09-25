/**
 * Real Git test helpers (frozen plan §9/§11/§49): fixed-argv spawns, no
 * shell, bounded timeouts. Used to build actual checkouts and linked
 * worktrees for discovery tests.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function runGit(cwd: string, args: string[], timeoutMs = 15000): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`git ${args.join(" ")} timed out`));
    }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

let gitCache: boolean | null = null;

export async function gitAvailable(): Promise<boolean> {
  if (gitCache !== null) return gitCache;
  try {
    const result = await runGit(process.cwd(), ["--version"]);
    gitCache = result.code === 0;
  } catch {
    gitCache = false;
  }
  return gitCache;
}

const IDENTITY_ARGS = ["-c", "user.email=phase-plan-test@example.com", "-c", "user.name=phase-plan-test"];

/** Create a real git checkout with one commit at dir. */
export async function initGitRepo(dir: string): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
  const init = await runGit(dir, ["init"]);
  if (init.code !== 0) throw new Error(`git init failed: ${init.stderr}`);
  fs.writeFileSync(`${dir}/README.md`, "# discovery test\n");
  const add = await runGit(dir, ["add", "README.md"]);
  if (add.code !== 0) throw new Error(`git add failed: ${add.stderr}`);
  const commit = await runGit(dir, [
    ...IDENTITY_ARGS,
    "commit",
    "--no-gpg-sign",
    "-m",
    "initial",
  ]);
  if (commit.code !== 0) throw new Error(`git commit failed: ${commit.stderr}`);
}

/** Add a linked worktree with its own branch. */
export async function addWorktree(repoDir: string, worktreeDir: string, branch: string): Promise<void> {
  const result = await runGit(repoDir, ["worktree", "add", "-b", branch, worktreeDir]);
  if (result.code !== 0) throw new Error(`git worktree add failed: ${result.stderr}`);
}
