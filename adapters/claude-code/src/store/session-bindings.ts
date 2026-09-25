/**
 * SessionBinding ownership core (frozen plan §16–§32, spec §23.8/§38).
 *
 * Invariants enforced by DDL + transactional compare/update — not comments:
 *
 *   SB-01  one run_id → at most one binding row (PRIMARY KEY on run_id)
 *   SB-02  one session → at most one ATTACHED binding (partial unique index)
 *   SB-03  bindings are exact-workspace scoped (workspace_id column + checks)
 *   SB-04  generation is a monotonically increasing writable-ownership epoch
 *          (CHECK generation >= 1; every epoch change does generation = generation + 1)
 *   SB-05  all ownership changes run inside one store write transaction
 *   SB-06  a stale generation can never assert or write (STALE_SESSION_BINDING)
 *
 * There is deliberately NO liveness detection: takeover is an explicit,
 * expected-generation-gated ownership change; fencing provides correctness.
 * run_id is an opaque future PlanningRun identifier — this module knows no
 * PlanningRun business state.
 */

import { RuntimeError } from "../runtime/errors.js";
import type { StoreClock } from "./migration-runner.js";
import type { PlanStore } from "./sqlite-store.js";

export type BindingState = "attached" | "detached";

export interface BindingSnapshot {
  runId: string;
  workspaceId: string;
  sessionId: string;
  state: BindingState;
  generation: number;
  createdAt: string;
  updatedAt: string;
}

export type BindingErrorCode =
  | "WORKSPACE_NOT_FOUND"
  | "WORKSPACE_MISMATCH"
  | "SESSION_ALREADY_BOUND"
  | "RUN_ALREADY_BOUND"
  | "BINDING_NOT_FOUND"
  | "BINDING_DETACHED"
  | "BINDING_CONFLICT"
  | "STALE_SESSION_BINDING";

export function bindingError(
  code: BindingErrorCode,
  message: string,
  detail?: Record<string, unknown>,
): RuntimeError {
  return new RuntimeError(code, message, { detail, recoverable: false });
}

interface BindingRow {
  runId: string;
  workspaceId: string;
  sessionId: string;
  state: BindingState;
  generation: number;
  createdAt: string;
  updatedAt: string;
}

const SELECT_BINDING =
  "SELECT run_id AS runId, workspace_id AS workspaceId, session_id AS sessionId, state, generation, created_at AS createdAt, updated_at AS updatedAt FROM session_bindings";

export interface BindInput {
  runId: string;
  workspaceId: string;
  sessionId: string;
}

export interface OwnershipInput {
  runId: string;
  sessionId: string;
}

export interface ReattachInput {
  runId: string;
  sessionId: string;
  workspaceId: string;
}

export interface TakeoverInput {
  runId: string;
  newSessionId: string;
  workspaceId: string;
  expectedGeneration: number;
}

export interface WritableBindingInput {
  runId: string;
  workspaceId: string;
  sessionId: string;
  generation: number;
}

/** The single writable-ownership boundary every future mutation must pass. */
export function assertWritableBinding(
  store: PlanStore,
  input: WritableBindingInput,
): BindingSnapshot {
  return store.withRead((tx) => {
    const row = tx.prepare(`${SELECT_BINDING} WHERE run_id = ?`).get(input.runId) as
      | BindingRow
      | undefined;
    if (row === undefined) {
      throw bindingError("BINDING_NOT_FOUND", `no binding exists for run '${input.runId}'`, {
        runId: input.runId,
      });
    }
    if (row.workspaceId !== input.workspaceId) {
      throw bindingError(
        "WORKSPACE_MISMATCH",
        `binding for run '${input.runId}' is scoped to a different workspace`,
        { runId: input.runId, expected: row.workspaceId, detected: input.workspaceId },
      );
    }
    if (row.state !== "attached") {
      throw bindingError("BINDING_DETACHED", `binding for run '${input.runId}' is detached`, {
        runId: input.runId,
      });
    }
    if (row.sessionId !== input.sessionId) {
      throw bindingError(
        "STALE_SESSION_BINDING",
        `session '${input.sessionId}' does not own the writable binding for run '${input.runId}'`,
        { runId: input.runId, ownerSession: row.sessionId },
      );
    }
    if (row.generation !== input.generation) {
      throw bindingError(
        "STALE_SESSION_BINDING",
        `stale binding generation ${input.generation} for run '${input.runId}'; current is ${row.generation}`,
        { runId: input.runId, expected: input.generation, detected: row.generation },
      );
    }
    return row;
  });
}

/** Initial attach: generation is deterministically 1 (frozen plan §19). */
export function bindSession(
  store: PlanStore,
  input: BindInput,
  clock: StoreClock,
): BindingSnapshot {
  return store.withWrite((tx) => {
    const workspace = tx
      .prepare("SELECT workspace_id FROM workspaces WHERE workspace_id = ?")
      .get(input.workspaceId);
    if (workspace === undefined) {
      throw bindingError("WORKSPACE_NOT_FOUND", `workspace '${input.workspaceId}' is not registered`, {
        workspaceId: input.workspaceId,
      });
    }
    const existing = tx.prepare(`${SELECT_BINDING} WHERE run_id = ?`).get(input.runId) as
      | BindingRow
      | undefined;
    if (existing !== undefined) {
      throw bindingError("RUN_ALREADY_BOUND", `run '${input.runId}' already has a binding`, {
        runId: input.runId,
        ownerSession: existing.sessionId,
        state: existing.state,
      });
    }
    const activeForSession = tx
      .prepare(`${SELECT_BINDING} WHERE session_id = ? AND state = 'attached'`)
      .get(input.sessionId) as BindingRow | undefined;
    if (activeForSession !== undefined) {
      throw bindingError(
        "SESSION_ALREADY_BOUND",
        `session '${input.sessionId}' already owns run '${activeForSession.runId}'`,
        { sessionId: input.sessionId, runId: activeForSession.runId },
      );
    }
    const now = clock.nowIso();
    tx.prepare(
      "INSERT INTO session_bindings (run_id, workspace_id, session_id, state, generation, created_at, updated_at) VALUES (?, ?, ?, 'attached', 1, ?, ?)",
    ).run(input.runId, input.workspaceId, input.sessionId, now, now);
    return {
      runId: input.runId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      state: "attached",
      generation: 1,
      createdAt: now,
      updatedAt: now,
    };
  });
}

/**
 * Detach keeps run/workspace/session rows (so an exact-session /resume can
 * find the run later) and bumps the generation, invalidating every authority
 * handed out under the previous epoch. Never deletes.
 */
export function detachBinding(
  store: PlanStore,
  input: OwnershipInput,
  clock: StoreClock,
): BindingSnapshot {
  return store.withWrite((tx) => {
    const row = requireBinding(tx, input.runId);
    requireOwner(row, input.sessionId, input.runId);
    if (row.state !== "attached") {
      throw bindingError("BINDING_DETACHED", `binding for run '${input.runId}' is already detached`, {
        runId: input.runId,
      });
    }
    const now = clock.nowIso();
    return applyEpochChange(tx, row, { state: "detached", sessionId: row.sessionId }, now);
  });
}

/**
 * Exact-session reattach: only the SAME session, on the SAME workspace, in
 * detached state may reattach — and it receives a new writable generation.
 * A workspace mismatch is WORKSPACE_MISMATCH, never an automatic rebind.
 */
export function reattachBinding(
  store: PlanStore,
  input: ReattachInput,
  clock: StoreClock,
): BindingSnapshot {
  return store.withWrite((tx) => {
    const row = requireBinding(tx, input.runId);
    if (row.workspaceId !== input.workspaceId) {
      throw bindingError(
        "WORKSPACE_MISMATCH",
        `binding for run '${input.runId}' belongs to a different workspace; it is never rebound automatically`,
        { runId: input.runId, expected: row.workspaceId, detected: input.workspaceId },
      );
    }
    requireOwner(row, input.sessionId, input.runId);
    if (row.state === "attached") {
      throw bindingError("BINDING_CONFLICT", `binding for run '${input.runId}' is already attached`, {
        runId: input.runId,
      });
    }
    const now = clock.nowIso();
    return applyEpochChange(tx, row, { state: "attached", sessionId: row.sessionId }, now);
  });
}

/**
 * Explicit ownership takeover (internal primitive; a future
 * phase_plan.takeover_run tool calls this only after formal human
 * authorization). expectedGeneration is compared INSIDE the write
 * transaction, so concurrent takeovers from the same epoch let exactly one
 * win — the loser deterministically gets STALE_SESSION_BINDING.
 */
export function takeoverBinding(
  store: PlanStore,
  input: TakeoverInput,
  clock: StoreClock,
): BindingSnapshot {
  return store.withWrite((tx) => {
    const row = requireBinding(tx, input.runId);
    if (row.workspaceId !== input.workspaceId) {
      throw bindingError(
        "WORKSPACE_MISMATCH",
        `binding for run '${input.runId}' belongs to a different workspace`,
        { runId: input.runId, expected: row.workspaceId, detected: input.workspaceId },
      );
    }
    if (row.generation !== input.expectedGeneration) {
      throw bindingError(
        "STALE_SESSION_BINDING",
        `takeover expected generation ${input.expectedGeneration} but current is ${row.generation}`,
        { runId: input.runId, expected: input.expectedGeneration, detected: row.generation },
      );
    }
    if (input.newSessionId !== row.sessionId) {
      const activeForSession = tx
        .prepare(`${SELECT_BINDING} WHERE session_id = ? AND state = 'attached'`)
        .get(input.newSessionId) as BindingRow | undefined;
      if (activeForSession !== undefined && activeForSession.runId !== row.runId) {
        throw bindingError(
          "SESSION_ALREADY_BOUND",
          `session '${input.newSessionId}' already owns run '${activeForSession.runId}'`,
          { sessionId: input.newSessionId, runId: activeForSession.runId },
        );
      }
    }
    const now = clock.nowIso();
    return applyEpochChange(tx, row, { state: "attached", sessionId: input.newSessionId }, now);
  });
}

export function getBinding(
  store: PlanStore,
  runId: string,
): BindingSnapshot | null {
  return store.withRead((tx) => {
    const row = tx.prepare(`${SELECT_BINDING} WHERE run_id = ?`).get(runId) as
      | BindingRow
      | undefined;
    return row ?? null;
  });
}

/** Internal discovery query for a future /phase-plan run selector. */
export function listBindingsForWorkspace(
  store: PlanStore,
  workspaceId: string,
): BindingSnapshot[] {
  return store.withRead((tx) =>
    tx
      .prepare(`${SELECT_BINDING} WHERE workspace_id = ? ORDER BY created_at, run_id`)
      .all(workspaceId) as BindingRow[],
  );
}

function requireBinding(tx: {
  prepare(sql: string): { get(...params: unknown[]): unknown };
}, runId: string): BindingRow {
  const row = tx.prepare(`${SELECT_BINDING} WHERE run_id = ?`).get(runId) as
    | BindingRow
    | undefined;
  if (row === undefined) {
    throw bindingError("BINDING_NOT_FOUND", `no binding exists for run '${runId}'`, { runId });
  }
  return row;
}

function requireOwner(row: BindingRow, sessionId: string, runId: string): void {
  if (row.sessionId !== sessionId) {
    throw bindingError(
      "STALE_SESSION_BINDING",
      `session '${sessionId}' does not own the writable binding for run '${runId}'`,
      { runId, ownerSession: row.sessionId },
    );
  }
}

/** The ONLY generation mutation path: epoch change = state/session swap + generation+1. */
function applyEpochChange(
  tx: { prepare(sql: string): { run(...params: unknown[]): unknown } },
  row: BindingRow,
  next: { state: BindingState; sessionId: string },
  now: string,
): BindingSnapshot {
  const generation = row.generation + 1;
  tx.prepare(
    "UPDATE session_bindings SET state = ?, session_id = ?, generation = generation + 1, updated_at = ? WHERE run_id = ? AND generation = ?",
  ).run(next.state, next.sessionId, now, row.runId, row.generation);
  return {
    runId: row.runId,
    workspaceId: row.workspaceId,
    sessionId: next.sessionId,
    state: next.state,
    generation,
    createdAt: row.createdAt,
    updatedAt: now,
  };
}
