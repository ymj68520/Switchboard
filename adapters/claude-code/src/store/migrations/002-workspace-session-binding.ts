/**
 * Migration 002 — workspace-and-session-binding (frozen plan §4/§5).
 *
 * Adds ONLY the Phase 3 infrastructure tables: the persistent repository /
 * workspace catalog and session bindings with generation fencing. There is
 * deliberately NO planning_runs table — `session_bindings.run_id` is an
 * opaque future PlanningRun identifier (a writable-ownership target), not
 * PlanningRun persistence; Phase 4 decides whether to rebuild constraints
 * via migration or guarantee run existence in application transactions.
 */

import type { StoreTx } from "../transaction.js";
import type { StoreMigration } from "./index.js";

export function createWorkspaceBindingMigration(): StoreMigration {
  return {
    from: 1,
    to: 2,
    name: "workspace-and-session-binding",
    apply(tx: StoreTx): void {
      tx.exec(`
        CREATE TABLE repositories (
          repository_id TEXT PRIMARY KEY,
          kind TEXT NOT NULL CHECK (kind IN ('git', 'directory')),
          canonical_locator TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL
        )
      `);
      tx.exec(`
        CREATE TABLE workspaces (
          workspace_id TEXT PRIMARY KEY,
          repository_id TEXT NOT NULL REFERENCES repositories(repository_id),
          kind TEXT NOT NULL CHECK (kind IN ('git_worktree', 'directory')),
          canonical_root TEXT NOT NULL,
          created_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          UNIQUE (repository_id, canonical_root)
        )
      `);
      tx.exec(`
        CREATE TABLE session_bindings (
          run_id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
          session_id TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('attached', 'detached')),
          generation INTEGER NOT NULL CHECK (generation >= 1),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);
      // SB-02 backstop: a Claude session owns at most ONE attached binding.
      // Detached rows do not participate, so history is preserved.
      tx.exec(`
        CREATE UNIQUE INDEX idx_session_bindings_active_session
          ON session_bindings (session_id)
          WHERE state = 'attached'
      `);
    },
  };
}
