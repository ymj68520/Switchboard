/**
 * Session-scoped run lookup shared by hook handlers and MCP handlers:
 * binds SessionBinding rows to PlanningRun business state. Read-only.
 */

import { getPlanningRunRecord } from "../store/planning-runs.js";
import { listBindingsForSessionRecord, type BindingSnapshot } from "../store/session-bindings.js";
import type { PlanningRun } from "../core/planning-run.js";
import type { PlanStore } from "../store/sqlite-store.js";

export interface SessionRunEntry {
  binding: BindingSnapshot;
  run: PlanningRun | null;
}

/** Every binding row for one session, joined with its run (null if missing). */
export function listSessionRuns(store: PlanStore, sessionId: string): SessionRunEntry[] {
  return listBindingsForSessionRecord(store, sessionId).map((binding) => ({
    binding,
    run: getPlanningRunRecord(store, binding.runId),
  }));
}

/** The session's attached binding on an ACTIVE run, if any. */
export function findAttachedActiveRun(store: PlanStore, sessionId: string): SessionRunEntry | null {
  return (
    listSessionRuns(store, sessionId).find(
      (entry) => entry.binding.state === "attached" && entry.run?.lifecycle === "active",
    ) ?? null
  );
}

/** The session's detached binding on an ACTIVE run in one workspace, if any. */
export function findDetachedActiveRun(
  store: PlanStore,
  sessionId: string,
  workspaceId: string,
): SessionRunEntry | null {
  return (
    listSessionRuns(store, sessionId).find(
      (entry) =>
        entry.binding.state === "detached" &&
        entry.binding.workspaceId === workspaceId &&
        entry.run?.lifecycle === "active",
    ) ?? null
  );
}
