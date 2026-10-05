/**
 * SupervisorBinding persistence (v0.2.0 architecture spec §43, E2 §5–§8/§20).
 *
 * Cardinality and fencing laws are DDL-enforced (migration 015), never
 * commented into existence:
 *
 *   SB-01  ONE canonical current-owner row per ExecutionRun
 *          (PRIMARY KEY(execution_run_id)) — the 0..1 writable-Supervisor law
 *   SB-02  at most one ATTACHED supervision binding per session
 *          (partial unique index)
 *   SB-03  the binding identity (run + workspace) is immutable after
 *          creation (identity partial-update trigger; no delete)
 *   SB-04  generation is the supervision fencing epoch: initial attach = 1;
 *          different-session takeover = +1; same-session detach/reattach
 *          NEVER changes it (E2 §7 — reattachment is not takeover)
 *   SB-05  the ownership event log is append-only (no_update/no_delete) and
 *          every history starts at ATTACHED
 *
 * Detachment NEVER mutates ExecutionRun lifecycle (E2 §8) and NEVER bumps the
 * generation — a crashed session may leave the stored binding attached, and
 * explicit takeover plus generation fencing supersedes it without any
 * liveness signal (E2 §6).
 *
 * The single production callers of the write primitives are the application
 * supervisor-binding service (session lifecycle integration) and the
 * run-control service (explicit takeover). Model code never mutates binding
 * state directly (E2 §21 — no set_supervisor_session/force_attach exists).
 */

import { parseSupervisorBindingRow, type SupervisorBinding } from "../core/supervisor-binding.js";
import { RuntimeError } from "../runtime/errors.js";
import type { PlanStore } from "./sqlite-store.js";
import type { StoreTx } from "./transaction.js";

export type SupervisorBindingEventType = "ATTACHED" | "DETACHED" | "TAKEOVER";

export interface SupervisorBindingEventRow {
  eventSeq: number;
  eventType: SupervisorBindingEventType;
  sessionId: string | null;
  detailJson: string | null;
  createdAt: string;
}

const BINDING_COLUMNS =
  "execution_run_id AS executionRunId, workspace_id AS workspaceId, session_id AS sessionId, state, "
  + "generation, created_at AS createdAt, updated_at AS updatedAt";

function supervisorBindingError(
  code:
    | "SUPERVISOR_BINDING_REQUIRED"
    | "STALE_SUPERVISOR_BINDING"
    | "WORKSPACE_MISMATCH"
    | "SESSION_ALREADY_BOUND"
    | "INVALID_EXECUTION_LIFECYCLE",
  message: string,
  detail?: Record<string, unknown>,
): RuntimeError {
  return new RuntimeError(code, message, { detail, recoverable: false });
}

export function getSupervisorBindingInTx(tx: StoreTx, executionRunId: string): SupervisorBinding | null {
  const raw = tx
    .prepare(`SELECT ${BINDING_COLUMNS} FROM supervisor_bindings WHERE execution_run_id = ?`)
    .get(executionRunId) as Record<string, unknown> | undefined;
  return raw === undefined ? null : parseSupervisorBindingRow(raw);
}

export function findAttachedSupervisorBindingForSessionInTx(
  tx: StoreTx,
  sessionId: string,
): SupervisorBinding | null {
  const raw = tx
    .prepare(`SELECT ${BINDING_COLUMNS} FROM supervisor_bindings WHERE session_id = ? AND state = 'attached'`)
    .get(sessionId) as Record<string, unknown> | undefined;
  return raw === undefined ? null : parseSupervisorBindingRow(raw);
}

export function listSupervisorBindingsForSessionInTx(
  tx: StoreTx,
  sessionId: string,
): SupervisorBinding[] {
  return (tx
    .prepare(
      `SELECT ${BINDING_COLUMNS} FROM supervisor_bindings WHERE session_id = ? ORDER BY created_at, execution_run_id`,
    )
    .all(sessionId) as Record<string, unknown>[]).map(parseSupervisorBindingRow);
}

/**
 * The active ExecutionRun of one workspace — the supervision-recovery
 * discovery seam for SessionStart (E2 §18). Most recent first; a workspace
 * with several active execution runs surfaces the newest (bounded probe).
 *
 * E12 §29 — this newest-one probe is NEVER an implicit selection: recovery
 * paths that cannot name an exact run must consult
 * listActiveExecutionRunsForWorkspaceInTx and fail closed with
 * EXECUTION_RUN_AMBIGUOUS when more than one run is visible.
 */
export function findActiveExecutionRunForWorkspaceInTx(
  tx: StoreTx,
  workspaceId: string,
): { executionRunId: string; lifecycle: string } | null {
  const row = tx
    .prepare(
      "SELECT execution_run_id AS executionRunId, lifecycle FROM execution_runs "
      + "WHERE workspace_id = ? AND lifecycle = 'active' ORDER BY created_at DESC, execution_run_id DESC LIMIT 1",
    )
    .get(workspaceId) as { executionRunId: string; lifecycle: string } | undefined;
  return row ?? null;
}

/** E12 §29 — EVERY active ExecutionRun of one workspace, newest first. */
export function listActiveExecutionRunsForWorkspaceInTx(
  tx: StoreTx,
  workspaceId: string,
): Array<{ executionRunId: string; lifecycle: string }> {
  return tx
    .prepare(
      "SELECT execution_run_id AS executionRunId, lifecycle FROM execution_runs "
      + "WHERE workspace_id = ? AND lifecycle = 'active' ORDER BY created_at DESC, execution_run_id DESC",
    )
    .all(workspaceId) as Array<{ executionRunId: string; lifecycle: string }>;
}

function nextSupervisorBindingEventSeqInTx(tx: StoreTx, executionRunId: string): number {
  const row = tx
    .prepare("SELECT COALESCE(MAX(event_seq), 0) + 1 AS seq FROM supervisor_binding_events WHERE execution_run_id = ?")
    .get(executionRunId) as { seq: number };
  return row.seq;
}

export function insertSupervisorBindingEventInTx(
  tx: StoreTx,
  input: {
    executionRunId: string;
    eventType: SupervisorBindingEventType;
    sessionId?: string | null;
    detailJson?: string | null;
  },
  now: string,
): number {
  const seq = nextSupervisorBindingEventSeqInTx(tx, input.executionRunId);
  tx.prepare(
    `INSERT INTO supervisor_binding_events (
       execution_run_id, event_seq, event_type, session_id, detail_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(input.executionRunId, seq, input.eventType, input.sessionId ?? null, input.detailJson ?? null, now);
  return seq;
}

export function listSupervisorBindingEventsInTx(tx: StoreTx, executionRunId: string): SupervisorBindingEventRow[] {
  return tx
    .prepare(
      "SELECT event_seq AS eventSeq, event_type AS eventType, session_id AS sessionId, "
      + "detail_json AS detailJson, created_at AS createdAt "
      + "FROM supervisor_binding_events WHERE execution_run_id = ? ORDER BY event_seq",
    )
    .all(executionRunId) as SupervisorBindingEventRow[];
}

/**
 * Initial attach (E2 §7) — generation exactly 1, created in the SAME
 * transaction as ExecutionRun activation so a newly active run can never be
 * reported as handed off while having lost its ownership identity.
 */
export function insertAttachedSupervisorBindingInTx(
  tx: StoreTx,
  input: { executionRunId: string; workspaceId: string; sessionId: string },
  now: string,
): SupervisorBinding {
  const existing = getSupervisorBindingInTx(tx, input.executionRunId);
  if (existing !== null) {
    throw supervisorBindingError(
      "SUPERVISOR_BINDING_REQUIRED",
      `ExecutionRun '${input.executionRunId}' already carries a SupervisorBinding`,
      { executionRunId: input.executionRunId, state: existing.state, generation: existing.generation },
    );
  }
  // A1 §16 — the legacy run_id column carries the source-planning provenance.
  const provenance = tx
    .prepare("SELECT run_id AS runId FROM execution_runs WHERE execution_run_id = ?")
    .get(input.executionRunId) as { runId: string } | undefined;
  tx.prepare(
    `INSERT INTO supervisor_bindings (
       execution_run_id, run_id, workspace_id, session_id, state, generation, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'attached', 1, ?, ?)`,
  ).run(input.executionRunId, provenance?.runId ?? null, input.workspaceId, input.sessionId, now, now);
  insertSupervisorBindingEventInTx(tx, { executionRunId: input.executionRunId, eventType: "ATTACHED", sessionId: input.sessionId }, now);
  return {
    executionRunId: input.executionRunId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    state: "attached",
    generation: 1,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Detach (E2 §8) — best-effort session-lifecycle hygiene: state → detached
 * with the generation UNCHANGED and ExecutionRun lifecycle untouched.
 * Idempotent; only the owning session may detach.
 */
export function detachSupervisorBindingInTx(
  tx: StoreTx,
  input: { executionRunId: string; sessionId: string },
  now: string,
): SupervisorBinding | null {
  const row = getSupervisorBindingInTx(tx, input.executionRunId);
  if (row === null || row.sessionId !== input.sessionId) {
    return row;
  }
  if (row.state !== "attached") {
    return row;
  }
  tx.prepare(
    "UPDATE supervisor_bindings SET state = 'detached', updated_at = ? "
    + "WHERE execution_run_id = ? AND session_id = ? AND state = 'attached'",
  ).run(now, input.executionRunId, input.sessionId);
  insertSupervisorBindingEventInTx(tx, { executionRunId: input.executionRunId, eventType: "DETACHED", sessionId: input.sessionId }, now);
  return { ...row, state: "detached", updatedAt: now };
}

/**
 * Same-session reattach (E2 §7/§13) — reattachment, not takeover: the exact
 * owner session returns with the generation UNCHANGED. Workspace fencing is
 * exact (E2 §19); a different session can never reattach.
 *
 * E12 §8 — the same-session reattach fence: the ExecutionRun must still be
 * ACTIVE (a detached binding on a terminal run is dead history that can never
 * reattach), the WorkspaceIdentity must match exactly, the binding session
 * must match exactly, and no later generation may exist. The last property is
 * structural: takeover is the only operation that moves the row's session_id,
 * so a row still carrying this session's id is necessarily at the generation
 * this session left it at.
 */
export function reattachSupervisorBindingInTx(
  tx: StoreTx,
  input: { executionRunId: string; workspaceId: string; sessionId: string },
  now: string,
): SupervisorBinding {
  const runLifecycle = tx
    .prepare("SELECT lifecycle FROM execution_runs WHERE execution_run_id = ?")
    .get(input.executionRunId) as { lifecycle: string } | undefined;
  if (runLifecycle === undefined) {
    throw supervisorBindingError(
      "INVALID_EXECUTION_LIFECYCLE",
      `no ExecutionRun exists for '${input.executionRunId}'`,
      { detail: { executionRunId: input.executionRunId } },
    );
  }
  if (runLifecycle.lifecycle !== "active") {
    throw supervisorBindingError(
      "INVALID_EXECUTION_LIFECYCLE",
      `ExecutionRun '${input.executionRunId}' is ${runLifecycle.lifecycle}; only an active run can reattach supervision (E12 §8)`,
      { detail: { executionRunId: input.executionRunId, lifecycle: runLifecycle.lifecycle } },
    );
  }
  const row = getSupervisorBindingInTx(tx, input.executionRunId);
  if (row === null) {
    throw supervisorBindingError(
      "SUPERVISOR_BINDING_REQUIRED",
      `no SupervisorBinding exists for ExecutionRun '${input.executionRunId}'; explicit takeover is required`,
      { executionRunId: input.executionRunId },
    );
  }
  if (row.workspaceId !== input.workspaceId) {
    throw supervisorBindingError(
      "WORKSPACE_MISMATCH",
      `the supervision binding for ExecutionRun '${input.executionRunId}' belongs to a different workspace`,
      { executionRunId: input.executionRunId, expected: row.workspaceId, detected: input.workspaceId },
    );
  }
  if (row.sessionId !== input.sessionId) {
    throw supervisorBindingError(
      "STALE_SUPERVISOR_BINDING",
      `the supervision binding for ExecutionRun '${input.executionRunId}' is owned by another session; explicit takeover is required`,
      { executionRunId: input.executionRunId },
    );
  }
  if (row.state === "attached") {
    return row;
  }
  tx.prepare(
    "UPDATE supervisor_bindings SET state = 'attached', updated_at = ? "
    + "WHERE execution_run_id = ? AND session_id = ? AND state = 'detached'",
  ).run(now, input.executionRunId, input.sessionId);
  insertSupervisorBindingEventInTx(tx, { executionRunId: input.executionRunId, eventType: "ATTACHED", sessionId: input.sessionId }, now);
  return { ...row, state: "attached", updatedAt: now };
}

/**
 * Explicit different-session takeover (E2 §12) — the ONLY generation bump:
 * expected generation must equal the current one (stale callers fail closed),
 * the new session is bound attached at generation + 1, and the previous
 * generation is permanently fenced. For an UNBOUND run (migrated v14, E2
 * §16) there is no owner to fence: the first takeover establishes the
 * binding at generation 1 and the null previousBindingIdentity on the
 * control record marks it. Workspace fencing is exact.
 */
export function takeoverSupervisorBindingInTx(
  tx: StoreTx,
  input: { executionRunId: string; workspaceId: string; newSessionId: string; expectedGeneration: number },
  now: string,
): SupervisorBinding {
  // E9 §27 — no execution takeover is legal for a TERMINAL run: a detached
  // binding on replan_required/completed/aborted runs stays detached forever.
  const runLifecycle = tx
    .prepare("SELECT lifecycle FROM execution_runs WHERE execution_run_id = ?")
    .get(input.executionRunId) as { lifecycle: string } | undefined;
  if (runLifecycle === undefined) {
    throw supervisorBindingError(
      "INVALID_EXECUTION_LIFECYCLE",
      `no ExecutionRun exists for '${input.executionRunId}'`,
      { detail: { executionRunId: input.executionRunId } },
    );
  }
  if (runLifecycle.lifecycle !== "active" && runLifecycle.lifecycle !== "prepared") {
    throw supervisorBindingError(
      "INVALID_EXECUTION_LIFECYCLE",
      `ExecutionRun '${input.executionRunId}' is ${runLifecycle.lifecycle}; terminal runs can never reacquire supervision (E9 §27)`,
      { detail: { executionRunId: input.executionRunId, lifecycle: runLifecycle.lifecycle } },
    );
  }
  const row = getSupervisorBindingInTx(tx, input.executionRunId);
  if (row === null) {
    const conflicting = findAttachedSupervisorBindingForSessionInTx(tx, input.newSessionId);
    if (conflicting !== null) {
      throw supervisorBindingError(
        "SESSION_ALREADY_BOUND",
        `session already supervises ExecutionRun '${conflicting.executionRunId}'`,
        { sessionId: input.newSessionId, executionRunId: conflicting.executionRunId },
      );
    }
    const provenance = tx
      .prepare("SELECT run_id AS runId FROM execution_runs WHERE execution_run_id = ?")
      .get(input.executionRunId) as { runId: string } | undefined;
    tx.prepare(
      `INSERT INTO supervisor_bindings (
         execution_run_id, run_id, workspace_id, session_id, state, generation, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'attached', 1, ?, ?)`,
    ).run(input.executionRunId, provenance?.runId ?? null, input.workspaceId, input.newSessionId, now, now);
    insertSupervisorBindingEventInTx(
      tx,
      { executionRunId: input.executionRunId, eventType: "TAKEOVER", sessionId: input.newSessionId, detailJson: '{"unboundAttach":true}' },
      now,
    );
    return {
      executionRunId: input.executionRunId,
      workspaceId: input.workspaceId,
      sessionId: input.newSessionId,
      state: "attached",
      generation: 1,
      createdAt: now,
      updatedAt: now,
    };
  }
  if (row.workspaceId !== input.workspaceId) {
    throw supervisorBindingError(
      "WORKSPACE_MISMATCH",
      `the supervision binding for ExecutionRun '${input.executionRunId}' belongs to a different workspace`,
      { executionRunId: input.executionRunId, expected: row.workspaceId, detected: input.workspaceId },
    );
  }
  if (row.generation !== input.expectedGeneration) {
    throw supervisorBindingError(
      "STALE_SUPERVISOR_BINDING",
      `takeover expected supervision generation ${input.expectedGeneration} but current is ${row.generation}`,
      { executionRunId: input.executionRunId, expected: input.expectedGeneration, detected: row.generation },
    );
  }
  if (input.newSessionId !== row.sessionId) {
    const conflicting = findAttachedSupervisorBindingForSessionInTx(tx, input.newSessionId);
    if (conflicting !== null && conflicting.executionRunId !== row.executionRunId) {
      throw supervisorBindingError(
        "SESSION_ALREADY_BOUND",
        `session already supervises ExecutionRun '${conflicting.executionRunId}'`,
        { sessionId: input.newSessionId, executionRunId: conflicting.executionRunId },
      );
    }
  }
  tx.prepare(
    "UPDATE supervisor_bindings SET session_id = ?, state = 'attached', generation = generation + 1, updated_at = ? "
    + "WHERE execution_run_id = ? AND generation = ?",
  ).run(input.newSessionId, now, input.executionRunId, row.generation);
  insertSupervisorBindingEventInTx(
    tx,
    {
      executionRunId: input.executionRunId,
      eventType: "TAKEOVER",
      sessionId: input.newSessionId,
      detailJson: JSON.stringify({ previousGeneration: row.generation, previousSessionId: row.sessionId }),
    },
    now,
  );
  const taken = getSupervisorBindingInTx(tx, input.executionRunId);
  if (
    taken === null
    || taken.sessionId !== input.newSessionId
    || taken.generation !== row.generation + 1
    || taken.state !== "attached"
  ) {
    throw supervisorBindingError(
      "STALE_SUPERVISOR_BINDING",
      `supervision takeover of ExecutionRun '${input.executionRunId}' raced a concurrent ownership change`,
      { executionRunId: input.executionRunId },
    );
  }
  return taken;
}

/**
 * THE authoritative writable-supervision authority check (E2 §20) — semantic
 * equivalent of requireCurrentExecutionSupervisorAuthority. Verifies: the
 * ExecutionRun exists and is active, the WorkspaceIdentity matches, the
 * binding exists and is attached, the session identity matches, and the
 * generation equals the current fencing epoch. Later execution mutations call
 * this check; stale owners fail closed here.
 */
export function requireCurrentSupervisorAuthorityInTx(
  tx: StoreTx,
  input: { executionRunId: string; workspaceId: string; sessionId: string; generation: number },
): { binding: SupervisorBinding } {
  const run = tx
    .prepare("SELECT workspace_id AS workspaceId, lifecycle FROM execution_runs WHERE execution_run_id = ?")
    .get(input.executionRunId) as { workspaceId: string; lifecycle: string } | undefined;
  if (run === undefined) {
    throw supervisorBindingError(
      "SUPERVISOR_BINDING_REQUIRED",
      `no ExecutionRun exists for '${input.executionRunId}'`,
      { executionRunId: input.executionRunId },
    );
  }
  if (run.workspaceId !== input.workspaceId) {
    throw supervisorBindingError(
      "WORKSPACE_MISMATCH",
      `ExecutionRun '${input.executionRunId}' belongs to a different workspace`,
      { expected: run.workspaceId, detected: input.workspaceId },
    );
  }
  if (run.lifecycle !== "active") {
    throw supervisorBindingError(
      "SUPERVISOR_BINDING_REQUIRED",
      `ExecutionRun '${input.executionRunId}' is ${run.lifecycle}; writable supervision requires an active run`,
      { executionRunId: input.executionRunId, lifecycle: run.lifecycle },
    );
  }
  const binding = getSupervisorBindingInTx(tx, input.executionRunId);
  if (binding === null) {
    throw supervisorBindingError(
      "SUPERVISOR_BINDING_REQUIRED",
      `ExecutionRun '${input.executionRunId}' has no SupervisorBinding; explicit takeover is required`,
      { executionRunId: input.executionRunId },
    );
  }
  if (binding.workspaceId !== input.workspaceId) {
    throw supervisorBindingError(
      "WORKSPACE_MISMATCH",
      `the supervision binding for ExecutionRun '${input.executionRunId}' belongs to a different workspace`,
      { expected: binding.workspaceId, detected: input.workspaceId },
    );
  }
  if (binding.state !== "attached") {
    throw supervisorBindingError(
      "SUPERVISOR_BINDING_REQUIRED",
      `the supervision binding for ExecutionRun '${input.executionRunId}' is detached; same-session reattach or explicit takeover is required`,
      { executionRunId: input.executionRunId, generation: binding.generation },
    );
  }
  if (binding.sessionId !== input.sessionId) {
    throw supervisorBindingError(
      "STALE_SUPERVISOR_BINDING",
      `ExecutionRun '${input.executionRunId}' is supervised by another session; explicit takeover is required`,
      { executionRunId: input.executionRunId, generation: binding.generation },
    );
  }
  if (binding.generation !== input.generation) {
    throw supervisorBindingError(
      "STALE_SUPERVISOR_BINDING",
      `stale supervision generation ${input.generation}; current is ${binding.generation}`,
      { executionRunId: input.executionRunId, expected: input.generation, detected: binding.generation },
    );
  }
  return { binding };
}

// ---------------------------------------------------------------------------
// Store-transaction wrappers (single-domain reads)
// ---------------------------------------------------------------------------

export function getSupervisorBinding(store: PlanStore, executionRunId: string): SupervisorBinding | null {
  return store.withRead((tx) => getSupervisorBindingInTx(tx, executionRunId));
}

export function listSupervisorBindingEvents(store: PlanStore, executionRunId: string): SupervisorBindingEventRow[] {
  return store.withRead((tx) => listSupervisorBindingEventsInTx(tx, executionRunId));
}
