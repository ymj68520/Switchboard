/**
 * Execution-start workspace observation — v0.2.0 Phase 7B (§12).
 *
 * The host-side, MECHANICAL observation of the workspace state at execution
 * start. It reads ONLY the project worktree's git identity files (HEAD →
 * ref → commit, with a packed-refs fallback) — no subprocess, no repository
 * content hashing, no new repository-tool runtime (all §2 non-goals). The
 * result is the honest `executionStartBaseline` recorded on the initial
 * ExecutionRun: the observed git identity at the moment the supervised
 * handoff materialized.
 *
 * When the worktree is not readable as a git repository, the baseline
 * HONESTLY records that fact (`unobserved:<worktree>` with no vcs claim)
 * rather than fabricating a revision.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { RepositoryRevision } from "../repository/evidence.js";

export async function observeGitWorkspaceBaseline(worktree: string): Promise<RepositoryRevision> {
  try {
    const gitDir = path.join(worktree, ".git");
    const head = (await readFile(path.join(gitDir, "HEAD"), "utf8")).trim();
    if (head.startsWith("ref:")) {
      const ref = head.slice(4).trim();
      const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
      let commit: string | undefined;
      try {
        commit = (await readFile(path.join(gitDir, ref), "utf8")).trim() || undefined;
      } catch {
        // Loose ref absent — try packed-refs (the common worktree case early in a repo's life).
        try {
          const packed = await readFile(path.join(gitDir, "packed-refs"), "utf8");
          commit = packed
            .split("\n")
            .find((line) => line.endsWith(` ${ref}`))
            ?.split(" ")[0];
        } catch {
          commit = undefined;
        }
      }
      return {
        workspaceFingerprint: `git:${branch}@${commit ?? "unresolved"}`,
        ...(commit ? { vcs: { type: "git" as const, commit, branch } } : {}),
      };
    }
    // Detached HEAD — the hash IS the observable state.
    return { workspaceFingerprint: `git:detached@${head}`, vcs: { type: "git" as const, commit: head } };
  } catch {
    // Honest unobserved marker — never a fabricated revision.
    return { workspaceFingerprint: `unobserved:${worktree}` };
  }
}
