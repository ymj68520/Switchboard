/**
 * Persistent repository/workspace catalog (frozen plan §6/§7/§14/§15).
 *
 * Identity semantics: RepositoryIdentity and WorkspaceIdentity are opaque,
 * persistent Phase-Plan-assigned IDs — the canonical locator/root is only
 * HOW the local storage domain currently identifies them, never the ID
 * itself. Registration is idempotent (same locators → same IDs) and
 * serialized through the store's write transaction, so two processes that
 * discover the same workspace concurrently converge on one registration via
 * SQLite uniqueness + BEGIN IMMEDIATE — no process mutex.
 *
 * Availability is NOT a persisted lifecycle: a deleted workspace keeps its
 * catalog rows; recovery decides availability at use time.
 */

import type { PlanStore } from "./sqlite-store.js";
import type { StoreClock } from "./migration-runner.js";

export type RepositoryKind = "git" | "directory";
export type WorkspaceKind = "git_worktree" | "directory";

export interface RepositoryRecord {
  repositoryId: string;
  kind: RepositoryKind;
  canonicalLocator: string;
  createdAt: string;
  lastSeenAt: string;
}

export interface WorkspaceRecord {
  workspaceId: string;
  repositoryId: string;
  kind: WorkspaceKind;
  canonicalRoot: string;
  createdAt: string;
  lastSeenAt: string;
}

export interface WorkspaceRegistrationInput {
  repositoryKind: RepositoryKind;
  repositoryLocator: string;
  workspaceKind: WorkspaceKind;
  workspaceRoot: string;
}

export interface WorkspaceRegistration {
  repository: RepositoryRecord;
  workspace: WorkspaceRecord;
}

interface RepositoryRow {
  repositoryId: string;
  kind: RepositoryKind;
  canonicalLocator: string;
  createdAt: string;
  lastSeenAt: string;
}

interface WorkspaceRow {
  workspaceId: string;
  repositoryId: string;
  kind: WorkspaceKind;
  canonicalRoot: string;
  createdAt: string;
  lastSeenAt: string;
}

/**
 * Register (or re-observe) a repository/workspace pair inside ONE write
 * transaction: look up by unique locator, insert on miss, refresh
 * last_seen_at on repeat observations. Never generates new identities for
 * known locators.
 */
export function registerWorkspaceRecord(
  store: PlanStore,
  input: WorkspaceRegistrationInput,
  clock: StoreClock,
): WorkspaceRegistration {
  return store.withWrite((tx) => {
    const now = clock.nowIso();
    let repository = tx
      .prepare("SELECT repository_id AS repositoryId, kind, canonical_locator AS canonicalLocator, created_at AS createdAt, last_seen_at AS lastSeenAt FROM repositories WHERE canonical_locator = ?")
      .get(input.repositoryLocator) as RepositoryRow | undefined;

    if (repository === undefined) {
      const repositoryId = `repo_${clock.newId()}`;
      tx.prepare(
        "INSERT INTO repositories (repository_id, kind, canonical_locator, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)",
      ).run(repositoryId, input.repositoryKind, input.repositoryLocator, now, now);
      repository = {
        repositoryId,
        kind: input.repositoryKind,
        canonicalLocator: input.repositoryLocator,
        createdAt: now,
        lastSeenAt: now,
      };
    } else if (repository.lastSeenAt !== now) {
      tx.prepare("UPDATE repositories SET last_seen_at = ? WHERE repository_id = ?").run(
        now,
        repository.repositoryId,
      );
      repository = { ...repository, lastSeenAt: now };
    }

    let workspace = tx
      .prepare("SELECT workspace_id AS workspaceId, repository_id AS repositoryId, kind, canonical_root AS canonicalRoot, created_at AS createdAt, last_seen_at AS lastSeenAt FROM workspaces WHERE repository_id = ? AND canonical_root = ?")
      .get(repository.repositoryId, input.workspaceRoot) as WorkspaceRow | undefined;

    if (workspace === undefined) {
      const workspaceId = `ws_${clock.newId()}`;
      tx.prepare(
        "INSERT INTO workspaces (workspace_id, repository_id, kind, canonical_root, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(workspaceId, repository.repositoryId, input.workspaceKind, input.workspaceRoot, now, now);
      workspace = {
        workspaceId,
        repositoryId: repository.repositoryId,
        kind: input.workspaceKind,
        canonicalRoot: input.workspaceRoot,
        createdAt: now,
        lastSeenAt: now,
      };
    } else if (workspace.lastSeenAt !== now) {
      tx.prepare("UPDATE workspaces SET last_seen_at = ? WHERE workspace_id = ?").run(
        now,
        workspace.workspaceId,
      );
      workspace = { ...workspace, lastSeenAt: now };
    }

    return { repository, workspace };
  });
}

export function getWorkspaceById(store: PlanStore, workspaceId: string): WorkspaceRecord | null {
  return store.withRead((tx) => {
    const row = tx
      .prepare("SELECT workspace_id AS workspaceId, repository_id AS repositoryId, kind, canonical_root AS canonicalRoot, created_at AS createdAt, last_seen_at AS lastSeenAt FROM workspaces WHERE workspace_id = ?")
      .get(workspaceId) as WorkspaceRow | undefined;
    return row ?? null;
  });
}
