/**
 * ExecutionHandoff / ExecutionBinding persistence (Phase 14 §11–§20).
 *
 * Cardinality laws are DDL-enforced, never commented into existence:
 *
 *   XH-01  one canonical ExecutionHandoff per run and per FinalPlan
 *          (UNIQUE(run_id) / UNIQUE(final_plan_id))
 *   XH-02  the handoff row and its event log are immutable (no_update/
 *          no_delete triggers); delivery state is the ONLY mutable surface
 *          and only mutates as append-event + update in ONE transaction (§17)
 *   XH-03  the event vocabulary is exactly PREPARED | DELIVERY_ATTEMPT |
 *          DELIVERED (CHECK constraint — no SET_STATUS/FORCE_DELIVERED)
 *   XB-01  one binding row per FinalPlan (PRIMARY KEY) and per run (UNIQUE)
 *   XB-02  at most one ATTACHED binding per session (partial unique index)
 *   XB-03  generation is the Build read-side fencing epoch (§20): initial
 *          attach = 1; detach and exact-session reattach each bump +1
 *
 * The single production callers of the write primitives are the application
 * handoff service and the trusted PostToolUse delivery finalizer (§95).
 */

import { RuntimeError } from "../runtime/errors.js";
import type { PlanStore } from "./sqlite-store.js";
import type { StoreTx } from "./transaction.js";

// ---------------------------------------------------------------------------
// ExecutionHandoff
// ---------------------------------------------------------------------------

export type ExecutionHandoffEventType = "PREPARED" | "DELIVERY_ATTEMPT" | "DELIVERED";

export type ExecutionHandoffStatus = "prepared" | "delivered";

export interface ExecutionHandoffRow {
  runId: string;
  handoffId: string;
  finalPlanId: string;
  finalPlanHash: string;
  canonicalJson: string;
  handoffHash: string;
  createdAt: string;
}

export interface ExecutionHandoffEventRow {
  eventSeq: number;
  eventType: ExecutionHandoffEventType;
  sessionId: string | null;
  toolUseId: string | null;
  detailJson: string | null;
  createdAt: string;
}

export interface ExecutionHandoffStateRow {
  status: ExecutionHandoffStatus;
  lastEventSeq: number;
  currentAttemptToolUseId: string | null;
  deliveredAt: string | null;
  updatedAt: string;
}

const HANDOFF_COLUMNS =
  "run_id AS runId, handoff_id AS handoffId, final_plan_id AS finalPlanId, "
  + "final_plan_hash AS finalPlanHash, canonical_json AS canonicalJson, "
  + "handoff_hash AS handoffHash, created_at AS createdAt";

const STATE_COLUMNS =
  "status, last_event_seq AS lastEventSeq, current_attempt_tool_use_id AS currentAttemptToolUseId, "
  + "delivered_at AS deliveredAt, updated_at AS updatedAt";

export function insertExecutionHandoffInTx(
  tx: StoreTx,
  handoff: Omit<ExecutionHandoffRow, "createdAt">,
  now: string,
): void {
  tx.prepare(
    `INSERT INTO execution_handoffs (
       run_id, handoff_id, final_plan_id, final_plan_hash, canonical_json, handoff_hash, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    handoff.runId,
    handoff.handoffId,
    handoff.finalPlanId,
    handoff.finalPlanHash,
    handoff.canonicalJson,
    handoff.handoffHash,
    now,
  );
}

export function getExecutionHandoffInTx(tx: StoreTx, runId: string): ExecutionHandoffRow | null {
  const row = tx
    .prepare(`SELECT ${HANDOFF_COLUMNS} FROM execution_handoffs WHERE run_id = ?`)
    .get(runId) as ExecutionHandoffRow | undefined;
  return row ?? null;
}

export function nextExecutionHandoffEventSeqInTx(tx: StoreTx, runId: string, handoffId: string): number {
  const row = tx
    .prepare(
      "SELECT COALESCE(MAX(event_seq), 0) + 1 AS seq FROM execution_handoff_events "
      + "WHERE run_id = ? AND handoff_id = ?",
    )
    .get(runId, handoffId) as { seq: number };
  return row.seq;
}

export function insertExecutionHandoffEventInTx(
  tx: StoreTx,
  input: {
    runId: string;
    handoffId: string;
    eventType: ExecutionHandoffEventType;
    sessionId?: string | null;
    toolUseId?: string | null;
    detailJson?: string | null;
  },
  now: string,
): number {
  const seq = nextExecutionHandoffEventSeqInTx(tx, input.runId, input.handoffId);
  tx.prepare(
    `INSERT INTO execution_handoff_events (
       run_id, handoff_id, event_seq, event_type, session_id, tool_use_id, detail_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.runId,
    input.handoffId,
    seq,
    input.eventType,
    input.sessionId ?? null,
    input.toolUseId ?? null,
    input.detailJson ?? null,
    now,
  );
  return seq;
}

export function listExecutionHandoffEventsInTx(
  tx: StoreTx,
  runId: string,
  handoffId: string,
): ExecutionHandoffEventRow[] {
  return tx
    .prepare(
      "SELECT event_seq AS eventSeq, event_type AS eventType, session_id AS sessionId, "
      + "tool_use_id AS toolUseId, detail_json AS detailJson, created_at AS createdAt "
      + "FROM execution_handoff_events WHERE run_id = ? AND handoff_id = ? ORDER BY event_seq",
    )
    .all(runId, handoffId) as ExecutionHandoffEventRow[];
}

export function insertExecutionHandoffStateInTx(
  tx: StoreTx,
  input: { runId: string; handoffId: string; status: ExecutionHandoffStatus; lastEventSeq: number },
  now: string,
): void {
  tx.prepare(
    `INSERT INTO execution_handoff_states (
       run_id, handoff_id, status, last_event_seq, current_attempt_tool_use_id, delivered_at, updated_at
     ) VALUES (?, ?, ?, ?, NULL, NULL, ?)`,
  ).run(input.runId, input.handoffId, input.status, input.lastEventSeq, now);
}

/** The ONLY operational-state mutation: append event + update state, same tx (§17). */
export function updateExecutionHandoffStateInTx(
  tx: StoreTx,
  input: {
    runId: string;
    handoffId: string;
    status: ExecutionHandoffStatus;
    lastEventSeq: number;
    currentAttemptToolUseId?: string | null;
    deliveredAt?: string | null;
  },
  now: string,
): void {
  tx.prepare(
    "UPDATE execution_handoff_states SET status = ?, last_event_seq = ?, "
    + "current_attempt_tool_use_id = ?, delivered_at = ?, updated_at = ? "
    + "WHERE run_id = ? AND handoff_id = ?",
  ).run(
    input.status,
    input.lastEventSeq,
    input.currentAttemptToolUseId ?? null,
    input.deliveredAt ?? null,
    now,
    input.runId,
    input.handoffId,
  );
}

export function getExecutionHandoffStateInTx(
  tx: StoreTx,
  runId: string,
): ExecutionHandoffStateRow | null {
  const row = tx
    .prepare(`SELECT ${STATE_COLUMNS} FROM execution_handoff_states WHERE run_id = ?`)
    .get(runId) as ExecutionHandoffStateRow | undefined;
  return row ?? null;
}

/** §93 — the exact delivery attempt lookup by run + session + tool_use_id. */
export function findDeliveryAttemptInTx(
  tx: StoreTx,
  input: { runId: string; sessionId: string; toolUseId: string },
): ExecutionHandoffEventRow | null {
  const row = tx
    .prepare(
      "SELECT event_seq AS eventSeq, event_type AS eventType, session_id AS sessionId, "
      + "tool_use_id AS toolUseId, detail_json AS detailJson, created_at AS createdAt "
      + "FROM execution_handoff_events WHERE run_id = ? AND session_id = ? AND tool_use_id = ? "
      + "AND event_type = 'DELIVERY_ATTEMPT' ORDER BY event_seq DESC LIMIT 1",
    )
    .get(input.runId, input.sessionId, input.toolUseId) as ExecutionHandoffEventRow | undefined;
  return row ?? null;
}

/**
 * §93 — PostToolUse attribution fallback: the run a (session, toolUseId)
 * delivery identity belongs to, regardless of outcome — used when the
 * planning binding is already gone (crash-recovery replay after completion).
 */
export function findRunIdByDeliveryIdentityInTx(
  tx: StoreTx,
  input: { sessionId: string; toolUseId: string },
): string | null {
  const row = tx
    .prepare(
      "SELECT run_id AS runId FROM execution_handoff_events "
      + "WHERE session_id = ? AND tool_use_id = ? AND event_type IN ('DELIVERY_ATTEMPT', 'DELIVERED') "
      + "ORDER BY event_seq DESC LIMIT 1",
    )
    .get(input.sessionId, input.toolUseId) as { runId: string } | undefined;
  return row?.runId ?? null;
}

/**
 * §134 — the delivered-handoff replay seam: the exact (session, toolUseId)
 * delivery identity with its attached binding, used by the PreToolUse hook to
 * re-sign an execution context for an idempotent same-invocation replay after
 * completion. Null when this invocation never delivered (fail closed).
 */
export function findDeliveredHandoffForSessionToolUseInTx(
  tx: StoreTx,
  input: { sessionId: string; toolUseId: string },
): { runId: string; workspaceId: string; finalPlanId: string; generation: number } | null {
  const row = tx
    .prepare(
      "SELECT e.run_id AS runId, b.workspace_id AS workspaceId, b.final_plan_id AS finalPlanId, b.generation AS generation "
      + "FROM execution_handoff_events e "
      + "JOIN execution_handoff_states s ON s.run_id = e.run_id AND s.handoff_id = e.handoff_id AND s.status = 'delivered' "
      + "JOIN execution_bindings b ON b.run_id = e.run_id AND b.state = 'attached' AND b.session_id = e.session_id "
      + "WHERE e.session_id = ? AND e.tool_use_id = ? AND e.event_type = 'DELIVERED' "
      + "ORDER BY e.event_seq DESC LIMIT 1",
    )
    .get(input.sessionId, input.toolUseId) as
    | { runId: string; workspaceId: string; finalPlanId: string; generation: number }
    | undefined;
  return row ?? null;
}

// ---------------------------------------------------------------------------
// ExecutionBinding
// ---------------------------------------------------------------------------

export interface ExecutionBindingRow {
  runId: string;
  workspaceId: string;
  finalPlanId: string;
  sessionId: string;
  state: "attached" | "detached";
  generation: number;
  createdAt: string;
  updatedAt: string;
}

const BINDING_COLUMNS =
  "run_id AS runId, workspace_id AS workspaceId, final_plan_id AS finalPlanId, "
  + "session_id AS sessionId, state, generation, created_at AS createdAt, updated_at AS updatedAt";

function executionBindingError(
  code: "EXECUTION_BINDING_REQUIRED" | "STALE_EXECUTION_BINDING",
  message: string,
  detail?: Record<string, unknown>,
): RuntimeError {
  return new RuntimeError(code, message, { detail, recoverable: false });
}

export function getExecutionBindingInTx(tx: StoreTx, runId: string): ExecutionBindingRow | null {
  const row = tx
    .prepare(`SELECT ${BINDING_COLUMNS} FROM execution_bindings WHERE run_id = ?`)
    .get(runId) as ExecutionBindingRow | undefined;
  return row ?? null;
}

export function findAttachedExecutionBindingForSessionInTx(
  tx: StoreTx,
  sessionId: string,
): ExecutionBindingRow | null {
  const row = tx
    .prepare(`SELECT ${BINDING_COLUMNS} FROM execution_bindings WHERE session_id = ? AND state = 'attached'`)
    .all(sessionId) as ExecutionBindingRow[];
  return row[0] ?? null;
}

export function listExecutionBindingsForSessionInTx(
  tx: StoreTx,
  sessionId: string,
): ExecutionBindingRow[] {
  return tx
    .prepare(`SELECT ${BINDING_COLUMNS} FROM execution_bindings WHERE session_id = ? ORDER BY created_at, run_id`)
    .all(sessionId) as ExecutionBindingRow[];
}

/**
 * Initial attach — generation exactly 1 (§20). Enforces XB-02 at insert time
 * so a racing second attach fails on the same law the partial index enforces.
 */
export function insertAttachedExecutionBindingInTx(
  tx: StoreTx,
  input: { runId: string; workspaceId: string; finalPlanId: string; sessionId: string },
  now: string,
): ExecutionBindingRow {
  const activeForSession = findAttachedExecutionBindingForSessionInTx(tx, input.sessionId);
  if (activeForSession !== null && activeForSession.finalPlanId !== input.finalPlanId) {
    throw executionBindingError(
      "EXECUTION_BINDING_REQUIRED",
      `session '${input.sessionId}' already holds an execution binding for FinalPlan '${activeForSession.finalPlanId}'`,
      { sessionId: input.sessionId, boundFinalPlanId: activeForSession.finalPlanId },
    );
  }
  tx.prepare(
    `INSERT INTO execution_bindings (
       run_id, workspace_id, final_plan_id, session_id, state, generation, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'attached', 1, ?, ?)`,
  ).run(input.runId, input.workspaceId, input.finalPlanId, input.sessionId, now, now);
  return {
    runId: input.runId,
    workspaceId: input.workspaceId,
    finalPlanId: input.finalPlanId,
    sessionId: input.sessionId,
    state: "attached",
    generation: 1,
    createdAt: now,
    updatedAt: now,
  };
}

/** The ONLY binding generation mutation: epoch change + generation+1 (§20). */
function applyExecutionBindingEpochInTx(
  tx: StoreTx,
  row: ExecutionBindingRow,
  next: { state: "attached" | "detached" },
  now: string,
): ExecutionBindingRow {
  tx.prepare(
    "UPDATE execution_bindings SET state = ?, generation = generation + 1, updated_at = ? "
    + "WHERE final_plan_id = ? AND generation = ?",
  ).run(next.state, now, row.finalPlanId, row.generation);
  return { ...row, state: next.state, generation: row.generation + 1, updatedAt: now };
}

/**
 * Detach on session end (§79) — bumps the generation so every outstanding
 * signed execution context fences. Only the owning session may detach.
 */
export function detachExecutionBindingInTx(
  tx: StoreTx,
  input: { runId: string; sessionId: string },
  now: string,
): ExecutionBindingRow | null {
  const row = getExecutionBindingInTx(tx, input.runId);
  if (row === null || row.sessionId !== input.sessionId) {
    return null;
  }
  if (row.state !== "attached") {
    return row;
  }
  return applyExecutionBindingEpochInTx(tx, row, { state: "detached" }, now);
}

/**
 * Exact-session reattach (§79/§82) — no takeover exists; a different session
 * can never reattach (EXECUTION_BINDING_REQUIRED).
 */
export function reattachExecutionBindingInTx(
  tx: StoreTx,
  input: { runId: string; sessionId: string; workspaceId: string },
  now: string,
): ExecutionBindingRow {
  const row = getExecutionBindingInTx(tx, input.runId);
  if (row === null) {
    throw executionBindingError("EXECUTION_BINDING_REQUIRED", "no execution binding exists for this run", {
      runId: input.runId,
    });
  }
  if (row.workspaceId !== input.workspaceId) {
    throw executionBindingError(
      "EXECUTION_BINDING_REQUIRED",
      "execution binding belongs to a different workspace; it is never rebound automatically",
      { runId: input.runId, expected: row.workspaceId, detected: input.workspaceId },
    );
  }
  if (row.sessionId !== input.sessionId) {
    throw executionBindingError(
      "EXECUTION_BINDING_REQUIRED",
      "only the exact original Build session can reattach an execution binding",
      { runId: input.runId, ownerSession: row.sessionId },
    );
  }
  if (row.state === "attached") {
    return row;
  }
  return applyExecutionBindingEpochInTx(tx, row, { state: "attached" }, now);
}

// ---------------------------------------------------------------------------
// Store-transaction wrappers (single-domain reads)
// ---------------------------------------------------------------------------

export function getExecutionHandoff(store: PlanStore, runId: string): ExecutionHandoffRow | null {
  return store.withRead((tx) => getExecutionHandoffInTx(tx, runId));
}

export function getExecutionHandoffState(store: PlanStore, runId: string): ExecutionHandoffStateRow | null {
  return store.withRead((tx) => getExecutionHandoffStateInTx(tx, runId));
}

export function getExecutionBinding(store: PlanStore, runId: string): ExecutionBindingRow | null {
  return store.withRead((tx) => getExecutionBindingInTx(tx, runId));
}

export function listExecutionBindingsForSession(
  store: PlanStore,
  sessionId: string,
): ExecutionBindingRow[] {
  return store.withRead((tx) => listExecutionBindingsForSessionInTx(tx, sessionId));
}
