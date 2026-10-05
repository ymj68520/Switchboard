/**
 * ExecutionStage & VerificationWindow persistence (v0.2.0 E3 §9/§12–§19/§26).
 *
 * Cardinality and invariance laws are DDL-enforced (migration 016), never
 * commented into existence:
 *
 *   ES-01  one stage row per (run, ordinal) and per (run, source step) —
 *          deterministic materialization idempotency at the DDL level
 *   ES-02  at most ONE ACTIVE stage per run (partial unique index) — multiple
 *          pending stages are fine, parallel execution is not (E3 §28)
 *   ES-03  stage provenance (run/ordinal/objective/step ref/dependencies/refs)
 *          is immutable after creation; only status/revision/updated_at change
 *   ES-04  no delete
 *   VW-01  at most ONE OPEN window per run (partial unique index on
 *          closed_at IS NULL)
 *   VW-02  window identity (run/stage/opened_at) immutable; no delete
 *   VW-03  candidate_revision starts at 0, is monotonic, and moves ONLY
 *          through the Core compare-and-swap primitive — never filesystem
 *          watching (E3 §17); no E3 path closes a window (E3 §18)
 *
 * The single production callers of the write primitives are the application
 * execution-structure service (bootstrap/recovery) and the handoff delivery
 * finalizer. Model code never sets stage status or window state directly
 * (E3 §26 — no setStageStatus/setWindow/setCandidateRevision exists).
 */

import {
  isSatisfyingStageStatus,
  parseExecutionStageRow,
  type ExecutionStage,
} from "../core/execution-stage.js";
import { parseVerificationWindowRow, type VerificationWindow } from "../core/verification-window.js";
import { RuntimeError } from "../runtime/errors.js";
import type { StoreTx } from "./transaction.js";

const STAGE_COLUMNS =
  "id, execution_run_id AS executionRunId, ordinal, status, objective, source_step_id AS sourceStepId, "
  + "depends_on_json AS dependsOnJson, source_refs_json AS sourceRefsJson, "
  + "completed_by_commit_id AS completedByCommitId, "
  + "revision, created_at AS createdAt, updated_at AS updatedAt";

const WINDOW_COLUMNS =
  "id, execution_run_id AS executionRunId, scope_kind AS scopeKind, stage_id AS stageId, candidate_revision AS candidateRevision, "
  + "opened_at AS openedAt, closed_at AS closedAt, base_kind AS baseKind, base_commit_id AS baseCommitId, "
  + "closure_kind AS closureKind";

function structureError(
  code:
    | "EXECUTION_STAGE_REQUIRED"
    | "EXECUTION_STAGE_NOT_ELIGIBLE"
    | "EXECUTION_STAGE_ALREADY_ACTIVE"
    | "INVALID_EXECUTION_STAGE_TRANSITION"
    | "VERIFICATION_WINDOW_REQUIRED"
    | "VERIFICATION_WINDOW_ALREADY_OPEN"
    | "WINDOW_STAGE_MISMATCH"
    | "STALE_CANDIDATE_REVISION",
  message: string,
  detail?: Record<string, unknown>,
): RuntimeError {
  return new RuntimeError(code, message, { detail, recoverable: false });
}

function mapStageRow(raw: Record<string, unknown>): ExecutionStage {
  const row: Record<string, unknown> = { ...raw };
  try {
    row.dependsOn = JSON.parse(String(raw.dependsOnJson));
    row.sourceRefs = JSON.parse(String(raw.sourceRefsJson));
  } catch {
    throw new RuntimeError("STORE_SCHEMA_INVALID", "execution_stages row is corrupt", {
      detail: { fields: ["provenance"] },
    });
  }
  return parseExecutionStageRow(row);
}

export function listExecutionStagesInTx(tx: StoreTx, executionRunId: string): ExecutionStage[] {
  return (tx
    .prepare(`SELECT ${STAGE_COLUMNS} FROM execution_stages WHERE execution_run_id = ? ORDER BY ordinal`)
    .all(executionRunId) as Record<string, unknown>[]).map(mapStageRow);
}

export function getActiveExecutionStageInTx(tx: StoreTx, executionRunId: string): ExecutionStage | null {
  const raw = tx
    .prepare(`SELECT ${STAGE_COLUMNS} FROM execution_stages WHERE execution_run_id = ? AND status = 'active'`)
    .get(executionRunId) as Record<string, unknown> | undefined;
  return raw === undefined ? null : mapStageRow(raw);
}

export function getExecutionStageInTx(tx: StoreTx, stageId: string): ExecutionStage | null {
  const raw = tx
    .prepare(`SELECT ${STAGE_COLUMNS} FROM execution_stages WHERE id = ?`)
    .get(stageId) as Record<string, unknown> | undefined;
  return raw === undefined ? null : mapStageRow(raw);
}

export function getOpenWindowInTx(tx: StoreTx, executionRunId: string): VerificationWindow | null {
  const raw = tx
    .prepare(`SELECT ${WINDOW_COLUMNS} FROM verification_windows WHERE execution_run_id = ? AND closed_at IS NULL`)
    .get(executionRunId) as Record<string, unknown> | undefined;
  return raw === undefined ? null : parseVerificationWindowRow(raw);
}

/** One window by its independent durable id (E3C §3 — never stage-derived). */
export function getWindowByIdInTx(tx: StoreTx, windowId: string): VerificationWindow | null {
  const raw = tx
    .prepare(`SELECT ${WINDOW_COLUMNS} FROM verification_windows WHERE id = ?`)
    .get(windowId) as Record<string, unknown> | undefined;
  return raw === undefined ? null : parseVerificationWindowRow(raw);
}

/**
 * The FULL window history of one stage, oldest first (E3C §2 — a Stage owns
 * 1..N sequential windows; the current OPEN window is selected per-run via
 * getOpenWindowInTx, never "the stage's window").
 */
export function listWindowsForStageInTx(tx: StoreTx, stageId: string): VerificationWindow[] {
  return (tx
    .prepare(`SELECT ${WINDOW_COLUMNS} FROM verification_windows WHERE stage_id = ? ORDER BY opened_at, id`)
    .all(stageId) as Record<string, unknown>[]).map(parseVerificationWindowRow);
}

export function insertExecutionStageInTx(
  tx: StoreTx,
  stage: Omit<ExecutionStage, "revision" | "createdAt" | "updatedAt" | "completedByCommitId">,
  now: string,
): void {
  tx.prepare(
    `INSERT INTO execution_stages (
       id, execution_run_id, ordinal, status, objective, source_step_id,
       depends_on_json, source_refs_json, revision, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(
    stage.id,
    stage.executionRunId,
    stage.ordinal,
    stage.status,
    stage.objective,
    stage.sourceStepId,
    JSON.stringify(stage.dependsOn),
    JSON.stringify(stage.sourceRefs),
    now,
    now,
  );
}

/**
 * The Core pending → active transition (E3 §19/§27). Legality is validated
 * here — run active, stage pending, mandatory predecessors satisfied — and
 * the conditional UPDATE plus the partial unique index make a second active
 * stage impossible at the DDL level. There is no generic status setter.
 */
export function activateExecutionStageInTx(tx: StoreTx, stageId: string, now: string): ExecutionStage {
  const stage = getExecutionStageInTx(tx, stageId);
  if (stage === null) {
    throw structureError("EXECUTION_STAGE_REQUIRED", `no ExecutionStage exists for '${stageId}'`, { stageId });
  }
  const run = tx
    .prepare("SELECT lifecycle FROM execution_runs WHERE execution_run_id = ?")
    .get(stage.executionRunId) as { lifecycle: string } | undefined;
  if (run === undefined || run.lifecycle !== "active") {
    throw structureError(
      "EXECUTION_STAGE_REQUIRED",
      `ExecutionRun '${stage.executionRunId}' is ${run?.lifecycle ?? "missing"}; stages activate only on an active run`,
      { executionRunId: stage.executionRunId, lifecycle: run?.lifecycle ?? null },
    );
  }
  const active = getActiveExecutionStageInTx(tx, stage.executionRunId);
  if (active !== null && active.id !== stageId) {
    throw structureError(
      "EXECUTION_STAGE_ALREADY_ACTIVE",
      `ExecutionRun '${stage.executionRunId}' already has an active stage ('${active.id}')`,
      { executionRunId: stage.executionRunId, activeStageId: active.id },
    );
  }
  // Mandatory dependencies: every explicit predecessor step's stage must hold
  // a satisfying status. Default ordinal is NOT a dependency (E3 §8).
  const stages = listExecutionStagesInTx(tx, stage.executionRunId);
  const stageByStep = new Map(stages.filter((s) => s.sourceStepId !== null).map((s) => [s.sourceStepId as string, s]));
  for (const dependency of stage.dependsOn) {
    const predecessor = stageByStep.get(dependency);
    if (predecessor === undefined || !isSatisfyingStageStatus(predecessor.status)) {
      throw structureError(
        "EXECUTION_STAGE_NOT_ELIGIBLE",
        `stage '${stage.id}' has an unsatisfied mandatory predecessor step '${dependency}'`,
        { stageId: stage.id, dependency },
      );
    }
  }
  if (stage.status !== "pending") {
    throw structureError(
      "INVALID_EXECUTION_STAGE_TRANSITION",
      `stage '${stage.id}' is ${stage.status}; only a pending stage can become active`,
      { stageId: stage.id, status: stage.status },
    );
  }
  const updated = tx
    .prepare(
      "UPDATE execution_stages SET status = 'active', revision = revision + 1, updated_at = ? "
      + "WHERE id = ? AND status = 'pending'",
    )
    .run(now, stageId) as { changes?: number | bigint };
  if (Number(updated.changes ?? 0) !== 1) {
    throw structureError(
      "INVALID_EXECUTION_STAGE_TRANSITION",
      `stage '${stage.id}' activation raced a concurrent transition`,
      { stageId: stage.id },
    );
  }
  return getExecutionStageInTx(tx, stageId) as ExecutionStage;
}

/**
 * Open the window for the ACTIVE stage (E3 §14/§15): candidateRevision 0,
 * single-open enforced by the partial unique index with a typed refusal here.
 * The stage must be the run's current active stage — WINDOW_STAGE_MISMATCH
 * otherwise (E3 §12: never STAGE-A.active with WINDOW(stage=B).open).
 *
 * E6 §29 — the window's accepted base is frozen at creation: genesis windows
 * (default) root in `execution_start`; the E6 successor primitive roots in the
 * exact acceptedHead ExecutionCommit. The base never re-binds (trigger) and is
 * never inferred from "whatever the head is now".
 */
export function insertOpenWindowInTx(
  tx: StoreTx,
  input: { executionRunId: string; stageId: string; windowId: string; base?: { kind: "execution_start" } | { kind: "execution_commit"; commitId: string } },
  now: string,
): VerificationWindow {
  const stage = getExecutionStageInTx(tx, input.stageId);
  if (stage === null || stage.executionRunId !== input.executionRunId) {
    throw structureError(
      "WINDOW_STAGE_MISMATCH",
      `stage '${input.stageId}' does not belong to run '${input.executionRunId}'`,
      { executionRunId: input.executionRunId, stageId: input.stageId },
    );
  }
  if (stage.status !== "active") {
    throw structureError(
      "WINDOW_STAGE_MISMATCH",
      `stage '${input.stageId}' is ${stage.status}; a window opens only under the active stage`,
      { executionRunId: input.executionRunId, stageId: input.stageId, status: stage.status },
    );
  }
  const existing = getOpenWindowInTx(tx, input.executionRunId);
  if (existing !== null) {
    throw structureError(
      "VERIFICATION_WINDOW_ALREADY_OPEN",
      `ExecutionRun '${input.executionRunId}' already has an open verification window ('${existing.id}')`,
      { executionRunId: input.executionRunId, windowId: existing.id },
    );
  }
  const base =
    input.base === undefined || input.base.kind === "execution_start"
      ? { kind: "execution_start" as const, commitId: null as string | null }
      : { kind: "execution_commit" as const, commitId: input.base.commitId };
  tx.prepare(
    `INSERT INTO verification_windows (
       id, execution_run_id, scope_kind, stage_id, candidate_revision, opened_at, closed_at, base_kind, base_commit_id
     ) VALUES (?, ?, 'stage', ?, 0, ?, NULL, ?, ?)`,
  ).run(input.windowId, input.executionRunId, input.stageId, now, base.kind, base.commitId);
  return {
    id: input.windowId,
    executionRunId: input.executionRunId,
    scopeKind: "stage",
    stageId: input.stageId,
    candidateRevision: 0,
    openedAt: now,
    closedAt: null,
    baseKind: base.kind,
    baseCommitId: base.commitId,
    closureKind: null,
  };
}

/**
 * E10 §9 — `insertFinalClosureWindowInTx`: the run-level Final Closure Window.
 * No Stage is involved (scope final_closure, stage_id NULL — never a synthetic
 * Stage row, E10 §4); candidateRevision 0; the base is FROZEN to the exact
 * acceptedHead at begin time (base_kind execution_commit). The store-level
 * fences mirror the stage-window primitive: run active, no open window (E10 §8
 * — one open window per run regardless of scope), acceptedHead exists.
 */
export function insertFinalClosureWindowInTx(
  tx: StoreTx,
  input: { executionRunId: string; windowId: string; baseCommitId: string },
  now: string,
): VerificationWindow {
  const run = tx
    .prepare("SELECT lifecycle FROM execution_runs WHERE execution_run_id = ?")
    .get(input.executionRunId) as { lifecycle: string } | undefined;
  if (run === undefined || run.lifecycle !== "active") {
    throw structureError(
      "VERIFICATION_WINDOW_REQUIRED",
      `ExecutionRun '${input.executionRunId}' is ${run?.lifecycle ?? "missing"}; the final closure window opens only on an active run (E10 §9)`,
      { executionRunId: input.executionRunId, lifecycle: run?.lifecycle ?? null },
    );
  }
  const existing = getOpenWindowInTx(tx, input.executionRunId);
  if (existing !== null) {
    throw structureError(
      "VERIFICATION_WINDOW_ALREADY_OPEN",
      `ExecutionRun '${input.executionRunId}' already has an open verification window ('${existing.id}')`,
      { executionRunId: input.executionRunId, windowId: existing.id },
    );
  }
  tx.prepare(
    `INSERT INTO verification_windows (
       id, execution_run_id, scope_kind, stage_id, candidate_revision, opened_at, closed_at, base_kind, base_commit_id
     ) VALUES (?, ?, 'final_closure', NULL, 0, ?, NULL, 'execution_commit', ?)`,
  ).run(input.windowId, input.executionRunId, now, input.baseCommitId);
  return {
    id: input.windowId,
    executionRunId: input.executionRunId,
    scopeKind: "final_closure",
    stageId: null,
    candidateRevision: 0,
    openedAt: now,
    closedAt: null,
    baseKind: "execution_commit",
    baseCommitId: input.baseCommitId,
    closureKind: null,
  };
}

/**
 * E6 §31 — the FIRST production-authorized window close, semantically
 * `closeWindowByExecutionCommitInTx`: only the acceptance-gate transaction may
 * call it, only the exact accepted window closes, and the conditional UPDATE
 * refuses a double close. There is deliberately no model-facing
 * close_window/accept_window/set_closed_at surface anywhere.
 */
export function closeWindowByExecutionCommitInTx(tx: StoreTx, input: { windowId: string }, now: string): void {
  const updated = tx
    .prepare("UPDATE verification_windows SET closed_at = ?, closure_kind = 'accepted' WHERE id = ? AND closed_at IS NULL")
    .run(now, input.windowId) as { changes?: number | bigint };
  if (Number(updated.changes ?? 0) !== 1) {
    throw structureError(
      "VERIFICATION_WINDOW_REQUIRED",
      `verification window '${input.windowId}' is not open; only the exact accepted window closes inside a commit`,
      { windowId: input.windowId },
    );
  }
}

/**
 * E7 §11/§14 — `completeStageByExecutionCommitInTx`: the ONLY production
 * active → completed transition. The conditional UPDATE refuses anything but
 * the exact active Stage, stamps the exact accepting Commit as provenance, and
 * any failure throws so the whole acceptance transaction rolls back (E7 §11).
 * No model-facing complete_stage / set_stage_status / force_complete_stage
 * surface exists, and the single production caller is the acceptance gate.
 */
export function completeStageByExecutionCommitInTx(
  tx: StoreTx,
  input: { stageId: string; commitId: string },
  now: string,
): void {
  const updated = tx
    .prepare(
      "UPDATE execution_stages SET status = 'completed', completed_by_commit_id = ?, "
      + "revision = revision + 1, updated_at = ? "
      + "WHERE id = ? AND status = 'active' AND completed_by_commit_id IS NULL",
    )
    .run(input.commitId, now, input.stageId) as { changes?: number | bigint };
  if (Number(updated.changes ?? 0) !== 1) {
    const stage = getExecutionStageInTx(tx, input.stageId);
    throw structureError(
      "INVALID_EXECUTION_STAGE_TRANSITION",
      `stage '${input.stageId}' could not be completed by commit '${input.commitId}'`
        + (stage === null ? " (stage missing)" : ` (status ${stage.status}, provenance ${stage.completedByCommitId ?? "none"})`),
      { stageId: input.stageId, commitId: input.commitId },
    );
  }
}

/**
 * E9 §23 — `closeWindowForReplanInTx`: the ONLY production terminal window
 * closure, callable ONLY from the replan transaction. It requires the window
 * currently open, preserves the candidateRevision, stamps
 * closure_kind='replan_required', and creates NO ExecutionCommit — the
 * candidate stays unaccepted reality. The INSERT/UPDATE closure-shape triggers
 * (migration 022) and the E6/v21 validators keep this distinguishable from an
 * accepted closure forever. There is deliberately no model-facing generic
 * window close tool anywhere.
 */
export function closeWindowForReplanInTx(tx: StoreTx, input: { windowId: string }, now: string): void {
  const updated = tx
    .prepare("UPDATE verification_windows SET closed_at = ?, closure_kind = 'replan_required' WHERE id = ? AND closed_at IS NULL")
    .run(now, input.windowId) as { changes?: number | bigint };
  if (Number(updated.changes ?? 0) !== 1) {
    throw structureError(
      "VERIFICATION_WINDOW_REQUIRED",
      `verification window '${input.windowId}' is not open; only the exact accepted-window close or the replan terminal close exists`,
      { windowId: input.windowId },
    );
  }
}

/**
 * E13 §19/§22 — `closeWindowForAbortInTx`: the terminal window closure of the
 * human-authorized abort. Callable ONLY from the abort transaction (its sole
 * production caller), it requires the window currently open, PRESERVES the
 * candidateRevision (E13 §17 — abort never advances it), stamps
 * closure_kind='aborted', and creates NO ExecutionCommit. Works for stage and
 * final_closure scopes alike (E13 §20); a run with no open window never
 * fabricates one (E13 §21). The v25 column CHECK + closure-shape triggers
 * keep this distinguishable from accepted/replan closures forever. There is
 * deliberately no model-facing generic window close tool anywhere.
 */
export function closeWindowForAbortInTx(tx: StoreTx, input: { windowId: string }, now: string): void {
  const updated = tx
    .prepare("UPDATE verification_windows SET closed_at = ?, closure_kind = 'aborted' WHERE id = ? AND closed_at IS NULL")
    .run(now, input.windowId) as { changes?: number | bigint };
  if (Number(updated.changes ?? 0) !== 1) {
    throw structureError(
      "VERIFICATION_WINDOW_REQUIRED",
      `verification window '${input.windowId}' is not open; only the accepted close, the replan terminal close, and the abort terminal close exist`,
      { windowId: input.windowId },
    );
  }
}

/**
 * THE candidate-revision compare-and-swap primitive (E3 §16): monotonic,
 * atomic, stale-guarded. expected must equal the CURRENT revision (current=4,
 * expected=4 → 5; current=5, expected=4 → STALE_CANDIDATE_REVISION). No path
 * decrements, reuses, or arbitrarily assigns a revision.
 */
export function advanceCandidateRevisionInTx(
  tx: StoreTx,
  input: { executionRunId: string; expectedRevision: number },
): VerificationWindow {
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new RuntimeError("INVALID_CANDIDATE_REVISION", "expected candidate revision must be a non-negative integer", {
      detail: { expected: input.expectedRevision },
      recoverable: false,
    });
  }
  const current = getOpenWindowInTx(tx, input.executionRunId);
  if (current === null) {
    throw structureError(
      "VERIFICATION_WINDOW_REQUIRED",
      `ExecutionRun '${input.executionRunId}' has no open verification window`,
      { executionRunId: input.executionRunId },
    );
  }
  const updated = tx
    .prepare(
      "UPDATE verification_windows SET candidate_revision = candidate_revision + 1 "
      + "WHERE id = ? AND candidate_revision = ? AND closed_at IS NULL",
    )
    .run(current.id, input.expectedRevision) as { changes?: number | bigint };
  if (Number(updated.changes ?? 0) !== 1) {
    throw structureError(
      "STALE_CANDIDATE_REVISION",
      `stale candidate revision ${input.expectedRevision}; current is ${current.candidateRevision}`,
      { executionRunId: input.executionRunId, expected: input.expectedRevision, detected: current.candidateRevision },
    );
  }
  return getOpenWindowInTx(tx, input.executionRunId) as VerificationWindow;
}

// ---------------------------------------------------------------------------
// Invariant checks (E3 §26) — the fences later execution phases will call.
// ---------------------------------------------------------------------------

export function requireActiveStageInTx(tx: StoreTx, executionRunId: string, expectedStageId?: string): ExecutionStage {
  const active = getActiveExecutionStageInTx(tx, executionRunId);
  if (active === null) {
    throw structureError("EXECUTION_STAGE_REQUIRED", `ExecutionRun '${executionRunId}' has no active stage`, { executionRunId });
  }
  if (expectedStageId !== undefined && active.id !== expectedStageId) {
    throw structureError(
      "EXECUTION_STAGE_NOT_ELIGIBLE",
      `expected active stage '${expectedStageId}' but current is '${active.id}'`,
      { executionRunId, expected: expectedStageId, detected: active.id },
    );
  }
  return active;
}

export function requireOpenWindowInTx(tx: StoreTx, executionRunId: string, expectedWindowId?: string): VerificationWindow {
  const open = getOpenWindowInTx(tx, executionRunId);
  if (open === null) {
    throw structureError("VERIFICATION_WINDOW_REQUIRED", `ExecutionRun '${executionRunId}' has no open verification window`, {
      executionRunId,
    });
  }
  if (expectedWindowId !== undefined && open.id !== expectedWindowId) {
    throw structureError(
      "VERIFICATION_WINDOW_REQUIRED",
      `expected open window '${expectedWindowId}' but current is '${open.id}'`,
      { executionRunId, expected: expectedWindowId, detected: open.id },
    );
  }
  return open;
}

/**
 * The STAGE-scoped window requirement (E6/E7 acceptance and stage-Directive
 * issuance): the open window must be a `stage` window bound to the run's
 * CURRENT active stage. The final-closure window (no Stage) fails here —
 * its authority flows through the final-closure path (E10 §31).
 */
export function requireOpenStageWindowInTx(tx: StoreTx, executionRunId: string, expectedWindowId?: string): VerificationWindow {
  const open = requireOpenWindowInTx(tx, executionRunId, expectedWindowId);
  const active = getActiveExecutionStageInTx(tx, executionRunId);
  if (open.scopeKind !== "stage" || active === null || open.stageId !== active.id) {
    throw structureError(
      "WINDOW_STAGE_MISMATCH",
      open.scopeKind === "final_closure"
        ? `open window '${open.id}' is the final-closure window; stage-scoped authority does not apply (E10 §31)`
        : `open window '${open.id}' references stage '${open.stageId ?? "none"}' which is not the active stage of run '${executionRunId}'`,
      { executionRunId, windowId: open.id, stageId: open.stageId, activeStageId: active?.id ?? null },
    );
  }
  return open;
}

export function requireCurrentCandidateRevisionInTx(
  tx: StoreTx,
  executionRunId: string,
  expectedRevision: number,
): VerificationWindow {
  const open = requireOpenWindowInTx(tx, executionRunId);
  if (open.candidateRevision !== expectedRevision) {
    throw structureError(
      "STALE_CANDIDATE_REVISION",
      `stale candidate revision ${expectedRevision}; current is ${open.candidateRevision}`,
      { executionRunId, expected: expectedRevision, detected: open.candidateRevision },
    );
  }
  return open;
}
