/**
 * ExecutionRun persistence (v0.2.0 E1 §8/§12).
 *
 * Cardinality and immutability laws are DDL-enforced (migration 014), never
 * commented into existence:
 *
 *   ER-01  one ExecutionRun per PlanningRun handoff (PRIMARY KEY(run_id)) —
 *          the DDL-level idempotency guarantee behind create-or-reuse
 *   ER-02  the workspace + exact FinalPlan binding and both baselines are
 *          immutable after creation (execution_runs_binding_immutable
 *          partial-update trigger; no delete)
 *   ER-03  the lifecycle vocabulary is the full frozen v0.2.0 set
 *          (CHECK constraint); E1 exposes only ABSENT → prepared and
 *          prepared → active through Core-validated transitions
 *   ER-04  the lifecycle event log is append-only (no_update/no_delete)
 *          and every history starts at PREPARED
 *
 * The single production caller of the write primitives is the application
 * execution-run/handoff service (E1 §12: model code never mutates lifecycle
 * directly; the store persists the authoritative transition).
 */

import { parseExecutionRunRow, type ExecutionRun } from "../core/execution-run.js";
import type { RepositoryBaseline } from "../core/execution-handoff.js";
import { canonicalJson } from "../core/canonical-json.js";
import { RuntimeError } from "../runtime/errors.js";
import type { PlanStore } from "./sqlite-store.js";
import type { StoreTx } from "./transaction.js";

export type ExecutionRunEventType = "PREPARED" | "ACTIVATED" | "REPLAN_REQUIRED" | "COMPLETED" | "ABORTED";

export interface ExecutionRunEventRow {
  eventSeq: number;
  eventType: ExecutionRunEventType;
  sessionId: string | null;
  toolUseId: string | null;
  detailJson: string | null;
  createdAt: string;
}

const RUN_COLUMNS =
  "execution_run_id AS executionRunId, run_id AS runId, workspace_id AS workspaceId, "
  + "final_plan_id AS finalPlanId, final_plan_revision AS finalPlanRevision, "
  + "final_plan_hash AS finalPlanHash, lifecycle, "
  + "planning_baseline_json AS planningBaselineJson, "
  + "execution_start_baseline_json AS executionStartBaselineJson, "
  + "revision, created_at AS createdAt, updated_at AS updatedAt";

/** Map one raw execution_runs row through the validating core parser. */
function mapExecutionRunRow(raw: Record<string, unknown>): ExecutionRun {
  const row: Record<string, unknown> = {
    executionRunId: raw.executionRunId,
    runId: raw.runId,
    workspaceId: raw.workspaceId,
    lifecycle: raw.lifecycle,
    revision: raw.revision,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
  const bindingProblem = (field: string): never => {
    throw new RuntimeError("STORE_SCHEMA_INVALID", "execution_runs row is corrupt", {
      detail: { fields: [field] },
    });
  };
  if (typeof raw.finalPlanId !== "string" || raw.finalPlanId === "") bindingProblem("final_plan.id");
  if (typeof raw.finalPlanRevision !== "number" || !Number.isInteger(raw.finalPlanRevision)) {
    bindingProblem("final_plan.revision");
  }
  if (typeof raw.finalPlanHash !== "string" || raw.finalPlanHash === "") bindingProblem("final_plan.hash");
  row.finalPlan = {
    id: raw.finalPlanId,
    revision: raw.finalPlanRevision,
    hash: raw.finalPlanHash,
  };
  try {
    row.planningBaseline = JSON.parse(String(raw.planningBaselineJson));
    row.executionStartBaseline = JSON.parse(String(raw.executionStartBaselineJson));
  } catch {
    throw new RuntimeError("STORE_SCHEMA_INVALID", "execution_runs row is corrupt", {
      detail: { fields: ["baselines"] },
    });
  }
  return parseExecutionRunRow(row);
}

export function insertExecutionRunInTx(
  tx: StoreTx,
  run: ExecutionRun,
  sessionId: string | null,
  toolUseId: string | null,
  now: string,
): void {
  tx.prepare(
    `INSERT INTO execution_runs (
       execution_run_id, run_id, workspace_id, final_plan_id, final_plan_revision, final_plan_hash,
       lifecycle, planning_baseline_json, execution_start_baseline_json,
       revision, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    run.executionRunId,
    run.runId,
    run.workspaceId,
    run.finalPlan.id,
    run.finalPlan.revision,
    run.finalPlan.hash,
    run.lifecycle,
    canonicalJson(run.planningBaseline),
    canonicalJson(run.executionStartBaseline),
    run.revision,
    now,
    now,
  );
  insertExecutionRunEventInTx(tx, {
    executionRunId: run.executionRunId,
    eventType: "PREPARED",
    sessionId,
    toolUseId,
  }, now);
}

export function getExecutionRunInTx(tx: StoreTx, executionRunId: string): ExecutionRun | null {
  const raw = tx
    .prepare(`SELECT ${RUN_COLUMNS} FROM execution_runs WHERE execution_run_id = ?`)
    .get(executionRunId) as Record<string, unknown> | undefined;
  return raw === undefined ? null : mapExecutionRunRow(raw);
}

function nextExecutionRunEventSeqInTx(tx: StoreTx, executionRunId: string): number {
  const row = tx
    .prepare("SELECT COALESCE(MAX(event_seq), 0) + 1 AS seq FROM execution_run_events WHERE execution_run_id = ?")
    .get(executionRunId) as { seq: number };
  return row.seq;
}

export function insertExecutionRunEventInTx(
  tx: StoreTx,
  input: {
    executionRunId: string;
    eventType: ExecutionRunEventType;
    sessionId?: string | null;
    toolUseId?: string | null;
    detailJson?: string | null;
  },
  now: string,
): number {
  const seq = nextExecutionRunEventSeqInTx(tx, input.executionRunId);
  tx.prepare(
    `INSERT INTO execution_run_events (
       execution_run_id, event_seq, event_type, session_id, tool_use_id, detail_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.executionRunId,
    seq,
    input.eventType,
    input.sessionId ?? null,
    input.toolUseId ?? null,
    input.detailJson ?? null,
    now,
  );
  return seq;
}

export function listExecutionRunEventsInTx(tx: StoreTx, executionRunId: string): ExecutionRunEventRow[] {
  return tx
    .prepare(
      "SELECT event_seq AS eventSeq, event_type AS eventType, session_id AS sessionId, "
      + "tool_use_id AS toolUseId, detail_json AS detailJson, created_at AS createdAt "
      + "FROM execution_run_events WHERE execution_run_id = ? ORDER BY event_seq",
    )
    .all(executionRunId) as ExecutionRunEventRow[];
}

/**
 * The ONE authoritative prepared → active transition (E1 §12). The target
 * lifecycle is never caller-chosen; the conditional UPDATE legalizes exactly
 * the prepared → active step, and a non-prepared row fails closed as
 * INVALID_EXECUTION_LIFECYCLE instead of being force-mutated.
 */
export function activateExecutionRunInTx(tx: StoreTx, executionRunId: string, now: string): ExecutionRun {
  const current = getExecutionRunInTx(tx, executionRunId);
  if (current === null) {
    throw new RuntimeError("EXECUTION_HANDOFF_INVARIANT", `no ExecutionRun exists for run '${executionRunId}'`, {
      detail: { executionRunId },
      recoverable: false,
    });
  }
  if (current.lifecycle !== "prepared") {
    throw new RuntimeError(
      "INVALID_EXECUTION_LIFECYCLE",
      `ExecutionRun '${current.executionRunId}' is ${current.lifecycle}; only a prepared run can become active`,
      { detail: { executionRunId, lifecycle: current.lifecycle }, recoverable: false },
    );
  }
  tx.prepare(
    "UPDATE execution_runs SET lifecycle = 'active', revision = revision + 1, updated_at = ? "
    + "WHERE execution_run_id = ? AND lifecycle = 'prepared'",
  ).run(now, executionRunId);
  insertExecutionRunEventInTx(tx, { executionRunId, eventType: "ACTIVATED" }, now);
  const activated = getExecutionRunInTx(tx, executionRunId);
  if (activated === null || activated.lifecycle !== "active" || activated.revision !== current.revision + 1) {
    throw new RuntimeError("EXECUTION_HANDOFF_INVARIANT", `ExecutionRun '${executionRunId}' activation raced a concurrent mutation`, {
      detail: { executionRunId },
      recoverable: false,
    });
  }
  return activated;
}

/** JSON shape guard for a stored execution-start baseline (fail closed). */
/**
 * E9 §4/§26 — the ONE authoritative active → replan_required transition. The
 * conditional UPDATE legalizes exactly that step (a terminal run can never be
 * re-transitioned — replan_required is terminal, E9 §4), stamps the run
 * revision, and appends the REPLAN_REQUIRED audit event. No direct SQL
 * lifecycle mutation exists outside this Core primitive.
 */
export function replanExecutionRunInTx(tx: StoreTx, input: { executionRunId: string; issueId: string }, now: string): ExecutionRun {
  const updated = tx
    .prepare(
      "UPDATE execution_runs SET lifecycle = 'replan_required', revision = revision + 1, updated_at = ? "
      + "WHERE execution_run_id = ? AND lifecycle = 'active'",
    )
    .run(now, input.executionRunId) as { changes?: number | bigint };
  if (Number(updated.changes ?? 0) !== 1) {
    const run = getExecutionRunInTx(tx, input.executionRunId);
    throw new RuntimeError(
      "REPLAN_ALREADY_TRANSITIONED",
      run === null
        ? `no ExecutionRun exists for '${input.executionRunId}'`
        : `ExecutionRun '${input.executionRunId}' is ${run.lifecycle}; only an active run transitions to replan_required (E9 §4)`,
      { detail: { executionRunId: input.executionRunId, lifecycle: run?.lifecycle ?? null, issueId: input.issueId }, recoverable: false },
    );
  }
  insertExecutionRunEventInTx(tx, { executionRunId: input.executionRunId, eventType: "REPLAN_REQUIRED", detailJson: JSON.stringify({ issueId: input.issueId }) }, now);
  return getExecutionRunInTx(tx, input.executionRunId) as ExecutionRun;
}

/**
 * E10 §42/§43/§44 — `completeExecutionRunByFinalCommitInTx`: the ONE
 * authoritative active → completed transition, callable ONLY from the final
 * acceptance / ExecutionCompletionGate. One conditional UPDATE legalizes
 * exactly the active → completed step AND stamps the exact completion
 * provenance, and it is CAS-guarded on the acceptedHead being the Final
 * ExecutionCommit (E10 §43: completion_commit_id == accepted_head_commit_id —
 * the DDL shape trigger is the second fence). A non-active run, a stale head,
 * or any racing mutation leaves changes=0 and fails closed, rolling back the
 * entire final accept transaction. No model-facing complete_execution_run /
 * set_lifecycle_completed / force_complete tool exists anywhere (E10 §44).
 */
export function completeExecutionRunByFinalCommitInTx(
  tx: StoreTx,
  input: { executionRunId: string; finalCommitId: string },
  now: string,
): ExecutionRun {
  const updated = tx
    .prepare(
      "UPDATE execution_runs SET lifecycle = 'completed', completion_commit_id = ?, revision = revision + 1, updated_at = ? "
      + "WHERE execution_run_id = ? AND lifecycle = 'active' AND accepted_head_commit_id = ? AND completion_commit_id IS NULL",
    )
    .run(input.finalCommitId, now, input.executionRunId, input.finalCommitId) as { changes?: number | bigint };
  if (Number(updated.changes ?? 0) !== 1) {
    const run = getExecutionRunInTx(tx, input.executionRunId);
    throw new RuntimeError(
      "EXECUTION_COMPLETION_GATE_FAILED",
      run === null
        ? `no ExecutionRun exists for '${input.executionRunId}'`
        : `ExecutionRun '${input.executionRunId}' could not be completed by final commit '${input.finalCommitId}' (lifecycle ${run.lifecycle}, head moved or provenance already present)`,
      { detail: { executionRunId: input.executionRunId, lifecycle: run?.lifecycle ?? null, finalCommitId: input.finalCommitId }, recoverable: false },
    );
  }
  insertExecutionRunEventInTx(
    tx,
    { executionRunId: input.executionRunId, eventType: "COMPLETED", detailJson: JSON.stringify({ commitId: input.finalCommitId }) },
    now,
  );
  return getExecutionRunInTx(tx, input.executionRunId) as ExecutionRun;
}

/**
 * E13 §12/§40 — `abortExecutionRunInTx`: the ONE authoritative active →
 * aborted transition, callable ONLY from the human-authorized abort service
 * (E13 §40 — no raw lifecycle setter, no model-facing path). The conditional
 * UPDATE legalizes exactly that step and stamps the run revision; a
 * prepared/completed/replan_required/aborted run leaves changes=0 and fails
 * closed (E13 §12 forbidden transitions), rolling back the whole abort
 * transaction (E13 §39). acceptedHead, candidateRevision, Stage states,
 * Attempts, Reports, and every other artifact are NEVER touched here — only
 * the lifecycle column, the revision, and the ABORTED audit event (E13 §16–
 * §18/§24/§41; the terminal-lifecycle DDL trigger makes aborted permanent).
 */
export function abortExecutionRunInTx(tx: StoreTx, input: { executionRunId: string; controlId: string }, now: string): ExecutionRun {
  const updated = tx
    .prepare(
      "UPDATE execution_runs SET lifecycle = 'aborted', revision = revision + 1, updated_at = ? "
      + "WHERE execution_run_id = ? AND lifecycle = 'active'",
    )
    .run(now, input.executionRunId) as { changes?: number | bigint };
  if (Number(updated.changes ?? 0) !== 1) {
    const run = getExecutionRunInTx(tx, input.executionRunId);
    throw new RuntimeError(
      "RUN_TERMINAL",
      run === null
        ? `no ExecutionRun exists for '${input.executionRunId}'`
        : `ExecutionRun '${input.executionRunId}' is ${run.lifecycle}; only an active run aborts (E13 §12)`,
      { detail: { executionRunId: input.executionRunId, lifecycle: run?.lifecycle ?? null, controlId: input.controlId }, recoverable: false },
    );
  }
  insertExecutionRunEventInTx(
    tx,
    { executionRunId: input.executionRunId, eventType: "ABORTED", detailJson: JSON.stringify({ controlId: input.controlId }) },
    now,
  );
  return getExecutionRunInTx(tx, input.executionRunId) as ExecutionRun;
}

export function parseStoredRepositoryBaseline(raw: unknown, runId: string): RepositoryBaseline {
  if (typeof raw !== "object" || raw === null) {
    throw new RuntimeError("STORE_SCHEMA_INVALID", `execution start baseline for run '${runId}' is corrupt`);
  }
  const baseline = raw as RepositoryBaseline;
  if (
    (baseline.kind !== "git" && baseline.kind !== "directory")
    || (baseline.kind === "git" && typeof baseline.revision !== "string")
  ) {
    throw new RuntimeError("STORE_SCHEMA_INVALID", `execution start baseline for run '${runId}' is corrupt`);
  }
  return baseline;
}

// ---------------------------------------------------------------------------
// Store-transaction wrappers (single-domain reads)
// ---------------------------------------------------------------------------

/** * A1 §37 — legacy compatibility resolution: the source-planning provenance * resolves to the execution world(s) bound to it. Pre-A1 stores hold exactly * one; a store with several is structurally multi-run and the caller MUST * reject ambiguity (never guess newest). A1-I initial-handoff idempotency is * the only production writer-side user. */
export function listExecutionRunsBySourcePlanningRunInTx(tx: StoreTx, planningRunId: string): ExecutionRun[] {
  return (tx
    .prepare(`SELECT ${RUN_COLUMNS} FROM execution_runs WHERE run_id = ? ORDER BY created_at, execution_run_id`)
    .all(planningRunId) as Record<string, unknown>[]).map(mapExecutionRunRow);
}

export function getExecutionRunBySourcePlanningRunInTx(tx: StoreTx, planningRunId: string): ExecutionRun | null {
  const rows = listExecutionRunsBySourcePlanningRunInTx(tx, planningRunId);
  return rows.length === 0 ? null : (rows[0] ?? null);
}

export function getExecutionRun(store: PlanStore, executionRunId: string): ExecutionRun | null {
  return store.withRead((tx) => getExecutionRunInTx(tx, executionRunId));
}

export function listExecutionRunEvents(store: PlanStore, executionRunId: string): ExecutionRunEventRow[] {
  return store.withRead((tx) => listExecutionRunEventsInTx(tx, executionRunId));
}
