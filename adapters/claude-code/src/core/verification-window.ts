/**
 * VerificationWindow domain shape (v0.2.0 architecture spec §14, E3 §12–§18,
 * E10 §7).
 *
 * PURE core: canonical shape, row validation. No SQLite, no host, no MCP.
 *
 * A VerificationWindow is the durable unaccepted candidate span under one
 * ExecutionRun. E10 §5–§7 gives every window an explicit EXECUTION SCOPE: a
 * `stage` window belongs to exactly one ExecutionStage (all pre-E10 windows),
 * while a `final_closure` window is the run-level final closure (stage_id IS
 * NULL — never a synthetic Stage, E10 §4). Exactly one open window exists per
 * run regardless of scope (E10 §8).
 *
 * Genesis semantics (E3 §13): the FIRST window is rooted conceptually in the
 * ExecutionRun's execution-start baseline — there is NO fabricated EC-000, no
 * fake genesis ExecutionCommit, and no acceptedHead. E3 has no commit
 * subsystem at all.
 *
 * `candidateRevision` is the durable identity of the mutable candidate inside
 * the window: 0 at open, monotonically increasing ONLY through the Core
 * compare-and-swap primitive (E3 §16). It is never driven by filesystem
 * watching (E3 §17), and no E3 path closes a window as "accepted" (E3 §18 —
 * acceptance later flows through Verifier → SupervisorAssessment →
 * ExecutionCommit).
 */

import { RuntimeError } from "../runtime/errors.js";

/** E10 §5 — the execution scope of one window/directive/assessment/commit. */
export type ExecutionScopeKind = "stage" | "final_closure";

export function isExecutionScopeKind(value: string): value is ExecutionScopeKind {
  return value === "stage" || value === "final_closure";
}

export interface VerificationWindow {
  id: string;
  /** The ExecutionRun this window belongs to (execution_runs.execution_run_id). */
  executionRunId: string;
  /**
   * E10 §5 — the scope. `stage` windows carry the exact ExecutionStage
   * (execution_stages.id); `final_closure` windows carry null.
   */
  scopeKind: ExecutionScopeKind;
  /** The stage-scoped ExecutionStage, or null for a final-closure window. */
  stageId: string | null;
  /** Durable candidate identity: 0 at open, monotonic, CAS-advanced only. */
  candidateRevision: number;
  openedAt: string;
  /** Frozen future-compatible field; no E3 path ever sets it. E6 §31 closes it. */
  closedAt: string | null;
  /**
   * The window's DURABLE accepted base (E6 §29). Genesis windows are rooted in
   * `execution_start` (the run's persisted baseline — no fabricated commit);
   * successor windows are rooted in the exact ExecutionCommit that was the
   * acceptedHead at window creation. Frozen at creation (migration-019
   * trigger); never inferred from "whatever the head is now".
   */
  baseKind: "execution_start" | "execution_commit";
  baseCommitId: string | null;
  /**
   * E9 §21 — WHY the window ended. null = open; "accepted" = closed by the
   * E6 commit gate (exactly one ExecutionCommit); "replan_required" = terminal
   * closure inside the E9 replan transaction (NO ExecutionCommit — the
   * candidate stays unaccepted reality). Every pre-E9 closed window backfills
   * as "accepted" because no other closure path existed (E9 §22). A final
   * closure window closes "accepted" through its Final ExecutionCommit
   * (E10 §7 — no new closure kind).
   */
  closureKind: "accepted" | "replan_required" | null;
}

/**
 * Validate a raw database row into a VerificationWindow. A negative
 * candidate revision, broken identity, or a scope/stage shape violation
 * (E10 §6: stage ↔ non-null id, final_closure ↔ null id) is store corruption —
 * surfaced as STORE_SCHEMA_INVALID, never smuggled into the core.
 */
export function parseVerificationWindowRow(row: Record<string, unknown>): VerificationWindow {
  const problems: string[] = [];
  if (typeof row.id !== "string" || row.id === "") problems.push("id");
  if (typeof row.executionRunId !== "string" || row.executionRunId === "") problems.push("execution_run_id");
  if (typeof row.scopeKind !== "string" || !isExecutionScopeKind(row.scopeKind)) problems.push("scope_kind");
  if (row.stageId !== null && typeof row.stageId !== "string") problems.push("stage_id");
  if (typeof row.stageId === "string" && row.stageId === "") problems.push("stage_id");
  if (typeof row.scopeKind === "string" && isExecutionScopeKind(row.scopeKind)) {
    // E10 §6 — the scope shape is re-derived at parse: a hand-mangled row is
    // corruption, not silence (the DDL trigger is the first fence).
    if (row.scopeKind === "stage" && typeof row.stageId !== "string") problems.push("scope_shape");
    if (row.scopeKind === "final_closure" && row.stageId !== null) problems.push("scope_shape");
  }
  if (typeof row.candidateRevision !== "number" || !Number.isInteger(row.candidateRevision) || row.candidateRevision < 0) {
    problems.push("candidate_revision");
  }
  if (typeof row.openedAt !== "string" || row.openedAt === "") problems.push("opened_at");
  if (row.closedAt !== null && typeof row.closedAt !== "string") problems.push("closed_at");
  if (
    row.baseKind !== "execution_start" && row.baseKind !== "execution_commit"
  ) {
    problems.push("base_kind");
  }
  if (row.baseCommitId !== null && typeof row.baseCommitId !== "string") problems.push("base_commit_id");
  if (row.baseKind === "execution_start" && row.baseCommitId !== null) problems.push("base_shape");
  if (
    row.closureKind !== null
    && row.closureKind !== "accepted"
    && row.closureKind !== "replan_required"
  ) {
    problems.push("closure_kind");
  }
  // The closure shape (open ↔ null kind) is DDL-enforced; the parse layer
  // re-derives it so a hand-mangled row is corruption, not silence.
  if ((row.closedAt === null) !== (row.closureKind === null)) problems.push("closure_shape");
  if (problems.length > 0) {
    throw new RuntimeError("STORE_SCHEMA_INVALID", "verification_windows row is corrupt", {
      detail: { fields: problems },
    });
  }
  return {
    id: row.id as string,
    executionRunId: row.executionRunId as string,
    scopeKind: row.scopeKind as VerificationWindow["scopeKind"],
    stageId: (row.stageId as string | null) ?? null,
    candidateRevision: row.candidateRevision as number,
    openedAt: row.openedAt as string,
    closedAt: row.closedAt as string | null,
    baseKind: row.baseKind as VerificationWindow["baseKind"],
    baseCommitId: (row.baseCommitId as string | null) ?? null,
    closureKind: (row.closureKind as "accepted" | "replan_required" | null) ?? null,
  };
}
