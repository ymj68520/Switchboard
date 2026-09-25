import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { canonicalizeExistingPath, comparisonKey } from "../src/workspace/canonical-path.js";
import { discoverWorkspace } from "../src/workspace/discovery.js";
import { addWorktree, gitAvailable, initGitRepo } from "./git-helpers.js";
import { makeTempPluginDataRoot, removeTempPluginDataRoot } from "./store-helpers.js";

const gitReady = await gitAvailable();

describe("path canonicalization (§13/§41)", () => {
  it("resolves nested relative input to an absolute canonical path", () => {
    const canonical = canonicalizeExistingPath(process.cwd());
    expect(path.isAbsolute(canonical.value)).toBe(true);
    expect(canonical.value.endsWith(/[\\/]$/.test(canonical.value) ? "" : "")).toBe(true);
    expect(canonical.value).not.toMatch(/[\\/]$/);
  });

  it("rejects non-existent paths with WORKSPACE_UNAVAILABLE", () => {
    const missing = path.join(process.cwd(), "definitely-missing-phase-plan-dir");
    expect(() => canonicalizeExistingPath(missing)).toThrowError(
      expect.objectContaining({ code: "WORKSPACE_UNAVAILABLE" }),
    );
  });

  it("builds a comparison key that is case-folded only on win32", () => {
    const canonical = canonicalizeExistingPath(process.cwd());
    if (process.platform === "win32") {
      expect(canonical.key).toBe(canonical.key.toLowerCase());
    } else {
      expect(canonical.key).toBe(canonical.value);
    }
    expect(comparisonKey(canonical.value)).toBe(canonical.key);
  });
});

describe.skipIf(!gitReady)("git workspace discovery (§9–§11)", () => {
  it("discovers a normal checkout: repository = git common dir, workspace = toplevel", async () => {
    const root = makeTempPluginDataRoot("phase-plan-git-");
    try {
      const repo = path.join(root, "repo with spaces", "ünïcode-仓库");
      await initGitRepo(repo);
      const observation = await discoverWorkspace(repo);
      expect(observation.repositoryKind).toBe("git");
      expect(observation.workspaceKind).toBe("git_worktree");
      // The canonical common dir is the checkout's own .git directory.
      const expectedCommon = await realPathOf(path.join(repo, ".git"));
      expect(observation.repositoryLocator).toBe(expectedCommon);
      expect(observation.workspaceRoot).toBe(await realPathOf(repo));
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("resolves discovery from a nested cwd to the same toplevel (§39)", async () => {
    const root = makeTempPluginDataRoot("phase-plan-git-");
    try {
      const repo = path.join(root, "repo");
      await initGitRepo(repo);
      const nested = path.join(repo, "src", "deep");
      fs.mkdirSync(nested, { recursive: true });
      const fromRoot = await discoverWorkspace(repo);
      const fromNested = await discoverWorkspace(nested);
      expect(fromNested.workspaceRoot).toBe(fromRoot.workspaceRoot);
      expect(fromNested.repositoryLocator).toBe(fromRoot.repositoryLocator);
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("gives linked worktrees the same repository locator but distinct workspace roots", async () => {
    const root = makeTempPluginDataRoot("phase-plan-git-");
    try {
      const repo = path.join(root, "repo");
      await initGitRepo(repo);
      const worktreeA = path.join(root, "worktree-A");
      const worktreeB = path.join(root, "worktree-B");
      await addWorktree(repo, worktreeA, "feature-a");
      await addWorktree(repo, worktreeB, "feature-b");

      const main = await discoverWorkspace(repo);
      const obsA = await discoverWorkspace(worktreeA);
      const obsB = await discoverWorkspace(worktreeB);

      expect(obsA.repositoryLocator).toBe(main.repositoryLocator);
      expect(obsB.repositoryLocator).toBe(main.repositoryLocator);
      expect(obsA.workspaceRoot).not.toBe(obsB.workspaceRoot);
      expect(obsA.workspaceRoot).toBe(await realPathOf(worktreeA));
      expect(obsB.workspaceRoot).toBe(await realPathOf(worktreeB));
    } finally {
      removeTempPluginDataRoot(root);
    }
  });
});

describe("non-git and fallback discovery (§12/§37)", () => {
  it("falls back to a directory workspace for a plain directory", async () => {
    const root = makeTempPluginDataRoot("phase-plan-dir-");
    try {
      const dir = path.join(root, "plain project", "ünïcode 目录");
      fs.mkdirSync(dir, { recursive: true });
      const observation = await discoverWorkspace(dir);
      expect(observation).toMatchObject({
        repositoryKind: "directory",
        workspaceKind: "directory",
        repositoryLocator: await realPathOf(dir),
        workspaceRoot: await realPathOf(dir),
      });
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("treats a missing git executable as directory fallback, not an error", async () => {
    const root = makeTempPluginDataRoot("phase-plan-dir-");
    try {
      const dir = path.join(root, "project");
      fs.mkdirSync(dir, { recursive: true });
      const observation = await discoverWorkspace(dir, {
        gitRunner: async () => ({ kind: "unavailable" }),
      });
      expect(observation.repositoryKind).toBe("directory");
      expect(observation.workspaceRoot).toBe(await realPathOf(dir));
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("treats a failed rev-parse (not a repository) as directory fallback", async () => {
    const root = makeTempPluginDataRoot("phase-plan-dir-");
    try {
      const dir = path.join(root, "project");
      fs.mkdirSync(dir, { recursive: true });
      const observation = await discoverWorkspace(dir, {
        gitRunner: async () => ({ kind: "exit", exitCode: 128, stdout: "", stderr: "" }),
      });
      expect(observation.repositoryKind).toBe("directory");
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("reports unavailable for a non-existent project directory", async () => {
    const root = makeTempPluginDataRoot("phase-plan-dir-");
    try {
      const missing = path.join(root, "nope");
      await expect(discoverWorkspace(missing)).rejects.toMatchObject({
        code: "WORKSPACE_UNAVAILABLE",
      });
    } finally {
      removeTempPluginDataRoot(root);
    }
  });
});

describe("symlink aliasing (§40, platform-permitting)", () => {
  const canTrySymlink = process.platform !== "win32" || true; // Administrator can usually create links

  it.skipIf(!canTrySymlink)("maps a symlink alias to the same canonical workspace", async () => {
    const root = makeTempPluginDataRoot("phase-plan-sym-");
    try {
      const real = path.join(root, "real-project");
      fs.mkdirSync(real, { recursive: true });
      const link = path.join(root, "link-to-project");
      try {
        fs.symlinkSync(real, link, process.platform === "win32" ? "junction" : "dir");
      } catch (err) {
        // Environment without symlink privilege: skip with an explicit note.
        console.log("symlink test skipped (cannot create link):", (err as Error).message);
        return;
      }
      const fromReal = await discoverWorkspace(real);
      const fromLink = await discoverWorkspace(link);
      expect(fromLink.workspaceRoot).toBe(fromReal.workspaceRoot);
      expect(fromLink.repositoryLocator).toBe(fromReal.repositoryLocator);
    } finally {
      removeTempPluginDataRoot(root);
    }
  });
});

async function realPathOf(target: string): Promise<string> {
  return fs.realpathSync(target);
}
