/**
 * Workspace discovery (frozen plan §9–§12/§37/§38).
 *
 * Git workspaces are identified through Git's own facts — `git rev-parse
 * --show-toplevel` (worktree root) and `--git-common-dir` (shared repository
 * directory) — spawned with a fixed argv, no shell, and a bounded timeout.
 * A missing git executable or "not a git repository" is NOT fatal: the
 * discovery falls back to a plain directory workspace. Real failures
 * (invalid path, canonicalization errors, permission) surface as
 * WORKSPACE_UNAVAILABLE.
 *
 * Locators: repository locator = canonicalized git COMMON directory (stable
 * across linked worktrees of one local clone); workspace locator =
 * canonicalized worktree root. Branch/HEAD/remote URL/name are NEVER
 * identity inputs. For non-Git directories the canonical directory serves as
 * both locators.
 */

import * as path from "node:path";
import { spawn } from "node:child_process";

import { canonicalizeExistingPath, type CanonicalPath } from "./canonical-path.js";
import type { RepositoryKind, WorkspaceKind } from "../store/repositories.js";

export interface WorkspaceObservation {
  repositoryKind: RepositoryKind;
  /** Canonical repository locator (git common dir, or the directory itself). */
  repositoryLocator: string;
  workspaceKind: WorkspaceKind;
  /** Canonical worktree/workspace root. */
  workspaceRoot: string;
  /** Canonical form of the discovery input (diagnostics/tests). */
  projectDir: string;
}

export interface DiscoveryOptions {
  timeoutMs?: number;
  /** Test seam replacing the git runner. */
  gitRunner?: (cwd: string, args: string[]) => Promise<GitProbeOutcome>;
}

export type GitProbeOutcome =
  | { kind: "exit"; exitCode: number; stdout: string }
  | { kind: "unavailable" };

const GIT_TIMEOUT_MS = 5000;

/** Real git runner: spawn + fixed argv, no shell, captured stdout, bounded. */
export const nodeGitRunner = async (cwd: string, args: string[]): Promise<GitProbeOutcome> =>
  new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let settled = false;
    const finish = (outcome: GitProbeOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ kind: "unavailable" });
    }, GIT_TIMEOUT_MS);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < 32 * 1024) stdout += chunk.toString("utf8");
    });
    child.on("error", () => finish({ kind: "unavailable" }));
    child.on("close", (code) => finish({ kind: "exit", exitCode: code ?? -1, stdout }));
  });

async function gitRevParse(
  cwd: string,
  arg: string,
  runner: (cwd: string, args: string[]) => Promise<GitProbeOutcome>,
): Promise<string | null> {
  const outcome = await runner(cwd, ["rev-parse", arg]);
  if (outcome.kind !== "exit" || outcome.exitCode !== 0) {
    return null;
  }
  const value = outcome.stdout.trim();
  return value === "" ? null : value;
}

/**
 * Discover the workspace observation for a project directory. Accepts the
 * explicit project directory (future: CLAUDE_PROJECT_DIR) — never the
 * process cwd implicitly.
 */
export async function discoverWorkspace(
  projectDir: string,
  options: DiscoveryOptions = {},
): Promise<WorkspaceObservation> {
  const dir = canonicalizeExistingPath(projectDir);
  const runner = options.gitRunner ?? nodeGitRunner;

  const toplevel = await gitRevParse(dir.value, "--show-toplevel", runner);
  const commonDir = toplevel === null ? null : await gitRevParse(dir.value, "--git-common-dir", runner);

  if (toplevel === null || commonDir === null) {
    // Not a git repository (or git unavailable): plain directory workspace.
    return {
      repositoryKind: "directory",
      repositoryLocator: dir.value,
      workspaceKind: "directory",
      workspaceRoot: dir.value,
      projectDir: dir.value,
    };
  }

  // Git paths print with native separators on POSIX and forward slashes on
  // Windows; both canonicalize through the filesystem below.
  const commonDirAbsolute = path.isAbsolute(commonDir)
    ? commonDir
    : path.resolve(dir.value, commonDir);
  const repositoryLocator = canonicalizeGitPath(commonDirAbsolute);
  const workspaceRoot = canonicalizeGitPath(toplevel);

  return {
    repositoryKind: "git",
    repositoryLocator,
    workspaceKind: "git_worktree",
    workspaceRoot,
    projectDir: dir.value,
  };
}

/**
 * Canonicalize a git-reported path. The target must exist (git just reported
 * it), but fall back to string resolution if the filesystem disagrees in a
 * race — never silently inventing a different workspace.
 */
function canonicalizeGitPath(raw: string): string {
  try {
    return canonicalizeExistingPath(raw).value;
  } catch {
    return normalizeSeparators(raw);
  }
}

function normalizeSeparators(raw: string): string {
  const resolved = path.resolve(raw.trim());
  const normalized = process.platform === "win32" ? resolved.replace(/\//g, "\\") : resolved;
  return normalized.replace(/[\\/]+$/, "") || normalized;
}

export type { CanonicalPath };
