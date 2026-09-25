import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { discoverWorkspace, registerWorkspace } from "../src/workspace/identity.js";
import { initializePlanStore } from "../src/store/sqlite-store.js";
import { addWorktree, gitAvailable, initGitRepo } from "./git-helpers.js";
import { fixedClock, makeTempPluginDataRoot, removeTempPluginDataRoot } from "./store-helpers.js";

const gitReady = await gitAvailable();

describe("workspace registration (E3/E4/E7/§14)", () => {
  it("assigns opaque persistent IDs distinct from locators, idempotently", async () => {
    const root = makeTempPluginDataRoot("phase-plan-reg-");
    try {
      const dir = path.join(root, "project");
      fs.mkdirSync(dir, { recursive: true });
      const store = await initializePlanStore({ pluginDataRoot: root });
      try {
        const observation = await discoverWorkspace(dir);
        const first = registerWorkspace(store, observation, fixedClock({ nowIso: "2026-01-01T00:00:00.000Z", ids: ["r1", "w1"] }));
        expect(first.repository.repositoryId).toBe("repo_r1");
        expect(first.workspace.workspaceId).toBe("ws_w1");
        expect(first.repository.repositoryId).not.toContain(dir.replace(/\\/g, "/"));
        expect(first.workspace.workspaceId).not.toContain("project");

        // Re-registration with the same locators: same IDs, refreshed last_seen.
        const second = registerWorkspace(store, observation, fixedClock({ nowIso: "2026-02-02T00:00:00.000Z", ids: ["r2", "w2"] }));
        expect(second.repository.repositoryId).toBe(first.repository.repositoryId);
        expect(second.workspace.workspaceId).toBe(first.workspace.workspaceId);
        expect(second.workspace.lastSeenAt).toBe("2026-02-02T00:00:00.000Z");
        expect(second.repository.lastSeenAt).toBe("2026-02-02T00:00:00.000Z");
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });

  it("does not create duplicate rows for repeat registration", async () => {
    const root = makeTempPluginDataRoot("phase-plan-reg-");
    try {
      const dir = path.join(root, "project");
      fs.mkdirSync(dir, { recursive: true });
      const store = await initializePlanStore({ pluginDataRoot: root });
      try {
        const observation = await discoverWorkspace(dir);
        registerWorkspace(store, observation, fixedClock({ ids: ["a"] }));
        registerWorkspace(store, observation, fixedClock({ ids: ["b"] }));
        const repos = store.withRead((tx) => tx.prepare("SELECT count(*) AS n FROM repositories").get()) as { n: number };
        const workspaces = store.withRead((tx) => tx.prepare("SELECT count(*) AS n FROM workspaces").get()) as { n: number };
        expect(repos.n).toBe(1);
        expect(workspaces.n).toBe(1);
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });
});

describe.skipIf(!gitReady)("worktree catalog semantics (E5/§11/§30)", () => {
  it("linked worktrees share repository identity and hold distinct workspace identities", async () => {
    const root = makeTempPluginDataRoot("phase-plan-reg-");
    try {
      const repo = path.join(root, "repo");
      await initGitRepo(repo);
      const worktreeA = path.join(root, "worktree-A");
      const worktreeB = path.join(root, "worktree-B");
      await addWorktree(repo, worktreeA, "feature-a");
      await addWorktree(repo, worktreeB, "feature-b");

      const store = await initializePlanStore({ pluginDataRoot: root });
      try {
        const clock = fixedClock({ ids: Array.from({ length: 8 }, (_, i) => `id${i}`) });
        const main = registerWorkspace(store, await discoverWorkspace(repo), clock);
        const regA = registerWorkspace(store, await discoverWorkspace(worktreeA), clock);
        const regB = registerWorkspace(store, await discoverWorkspace(worktreeB), clock);

        expect(regA.repository.repositoryId).toBe(main.repository.repositoryId);
        expect(regB.repository.repositoryId).toBe(main.repository.repositoryId);
        expect(regA.workspace.workspaceId).not.toBe(main.workspace.workspaceId);
        expect(regB.workspace.workspaceId).not.toBe(main.workspace.workspaceId);
        expect(regA.workspace.kind).toBe("git_worktree");
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });
});

describe("directory workspaces (E6)", () => {
  it("registers a plain directory as both repository and workspace (kind directory)", async () => {
    const root = makeTempPluginDataRoot("phase-plan-reg-");
    try {
      const dir = path.join(root, "plain");
      fs.mkdirSync(dir, { recursive: true });
      const store = await initializePlanStore({ pluginDataRoot: root });
      try {
        const registration = registerWorkspace(store, await discoverWorkspace(dir), fixedClock({ ids: ["d1", "d2"] }));
        expect(registration.repository.kind).toBe("directory");
        expect(registration.workspace.kind).toBe("directory");
        expect(registration.repository.canonicalLocator).toBe(registration.workspace.canonicalRoot);
      } finally {
        store.close();
      }
    } finally {
      removeTempPluginDataRoot(root);
    }
  });
});
