/**
 * Section workflow persistence (Phase 11 §7/§8/§10).
 *
 * Authority = the immutable Section revisions + the append-only
 * section_workflow_events. section_workflow_states is a MATERIALIZED
 * projection updated in the SAME transaction as its event — never a second
 * authority. The DDL CHECK pins the completion-provenance invariants
 * (completed/needs_review carry the full provenance; open carries none), so a
 * divergent row fails the write at the database level.
 *
 * planning_active_work is ordinary mutable workflow state (§10): select
 * inserts/repoints it, completion clears it. It is NOT Plan Memory — it never
 * creates a Snapshot or moves HEAD by itself.
 *
 * The single production callers of the write primitives are the application
 * section-workflow service and the Phase 6 commit engine.
 */

import { canonicalJson } from "../core/canonical-json.js";
import { RuntimeError } from "../runtime/errors.js";
import type {
  SectionWorkflowEventType,
  SectionWorkflowState,
} from "../core/section-workflow.js";
import type { PlanStore } from "./sqlite-store.js";
import type { StoreTx } from "./transaction.js";

/** Exact completion provenance bound into completed/needs_review states (§5/§6). */
export interface SectionCompletionProvenance {
  completedRevision: number;
  completedProposalId: string;
  completedProposalRevision: number;
  completionCommitId: string;
}

export interface AppendWorkflowEventInput extends Partial<SectionCompletionProvenance> {
  runId: string;
  sectionId: string;
  eventType: SectionWorkflowEventType;
  toState: SectionWorkflowState;
  reasonCode: string;
  detail: Record<string, unknown>;
  eventId: string;
  /** Previous materialized state; null only for REGISTERED. */
  fromState?: SectionWorkflowState | null;
  requestId?: string | null;
  createdAt: string;
}

export interface SectionWorkflowStateView extends Partial<SectionCompletionProvenance> {
  runId: string;
  sectionId: string;
  status: SectionWorkflowState;
  lastEventSeq: number;
  updatedAt: string;
}

const STATE_COLUMNS = [
  "run_id AS runId",
  "section_id AS sectionId",
  "status AS status",
  "completed_revision AS completedRevision",
  "completed_proposal_id AS completedProposalId",
  "completed_proposal_revision AS completedProposalRevision",
  "completion_commit_id AS completionCommitId",
  "last_event_seq AS lastEventSeq",
  "updated_at AS updatedAt",
].join(", ");

interface StateRow {
  runId: string;
  sectionId: string;
  status: SectionWorkflowState;
  completedRevision: number | null;
  completedProposalId: string | null;
  completedProposalRevision: number | null;
  completionCommitId: string | null;
  lastEventSeq: number;
  updatedAt: string;
}

function rowToState(row: StateRow): SectionWorkflowStateView {
  return {
    runId: row.runId,
    sectionId: row.sectionId,
    status: row.status,
    ...(row.completedRevision !== null && row.completedProposalId !== null && row.completedProposalRevision !== null && row.completionCommitId !== null
      ? {
          completedRevision: row.completedRevision,
          completedProposalId: row.completedProposalId,
          completedProposalRevision: row.completedProposalRevision,
          completionCommitId: row.completionCommitId,
        }
      : {}),
    lastEventSeq: row.lastEventSeq,
    updatedAt: row.updatedAt,
  };
}

/**
 * Append one workflow event and move the materialized state in the SAME
 * transaction (§7). `fromState` must equal the current materialized state
 * (null only for REGISTERED); a mismatch fails the transaction closed rather
 * than writing a divergent projection.
 */
export function appendSectionWorkflowEventInTx(
  tx: StoreTx,
  input: AppendWorkflowEventInput,
): SectionWorkflowStateView {
  const current = tx
    .prepare("SELECT status AS status FROM section_workflow_states WHERE run_id = ? AND section_id = ?")
    .get(input.runId, input.sectionId) as { status: SectionWorkflowState } | undefined;
  const fromState = current?.status ?? null;
  if (input.fromState !== undefined && input.fromState !== fromState) {
    throw new RuntimeError(
      "SECTION_WORKFLOW_INVALID",
      `workflow event ${input.eventType} for section '${input.sectionId}' expected from-state ${String(input.fromState)} but the materialized state is ${String(fromState)}`,
      { detail: { runId: input.runId, sectionId: input.sectionId, eventType: input.eventType, fromState } },
    );
  }
  const seqRow = tx
    .prepare("SELECT COALESCE(MAX(event_seq), 0) + 1 AS seq FROM section_workflow_events WHERE run_id = ?")
    .get(input.runId) as { seq: number };
  tx.prepare(
    `INSERT INTO section_workflow_events (
       run_id, event_seq, event_id, section_id, event_type, from_state, to_state,
       reason_code, detail_json, request_id, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.runId,
    seqRow.seq,
    input.eventId,
    input.sectionId,
    input.eventType,
    fromState,
    input.toState,
    input.reasonCode,
    canonicalJson(input.detail),
    input.requestId ?? null,
    input.createdAt,
  );

  // §8: completed/needs_review carry the full provenance; open carries none.
  // The columns are driven by the target state so a caller cannot leave a
  // half-filled provenance behind (the CHECK would reject it anyway).
  const completedColumns =
    input.toState === "open"
      ? [null, null, null, null]
      : [
          input.completedRevision ?? null,
          input.completedProposalId ?? null,
          input.completedProposalRevision ?? null,
          input.completionCommitId ?? null,
        ];
  if (input.toState !== "open" && completedColumns.some((value) => value === null)) {
    throw new RuntimeError(
      "SECTION_WORKFLOW_INVALID",
      `${input.eventType} to ${input.toState} requires the full completion provenance`,
      { detail: { runId: input.runId, sectionId: input.sectionId, eventType: input.eventType } },
    );
  }
  if (current === undefined) {
    tx.prepare(
      `INSERT INTO section_workflow_states (
         run_id, section_id, status, completed_revision, completed_proposal_id,
         completed_proposal_revision, completion_commit_id, last_event_seq, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(input.runId, input.sectionId, input.toState, ...completedColumns, seqRow.seq, input.createdAt);
  } else {
    tx.prepare(
      `UPDATE section_workflow_states SET status = ?, completed_revision = ?, completed_proposal_id = ?,
         completed_proposal_revision = ?, completion_commit_id = ?, last_event_seq = ?, updated_at = ?
       WHERE run_id = ? AND section_id = ?`,
    ).run(input.toState, ...completedColumns, seqRow.seq, input.createdAt, input.runId, input.sectionId);
  }
  return getSectionWorkflowStateInTx(tx, input.runId, input.sectionId) as SectionWorkflowStateView;
}

/** Materialized workflow state of one Section, or null when never registered. */
export function getSectionWorkflowStateInTx(tx: StoreTx, runId: string, sectionId: string): SectionWorkflowStateView | null {
  const row = tx
    .prepare(`SELECT ${STATE_COLUMNS} FROM section_workflow_states WHERE run_id = ? AND section_id = ?`)
    .get(runId, sectionId) as StateRow | undefined;
  return row === undefined ? null : rowToState(row);
}

export function getSectionWorkflowState(store: PlanStore, runId: string, sectionId: string): SectionWorkflowStateView | null {
  return store.withRead((tx) => getSectionWorkflowStateInTx(tx, runId, sectionId));
}

/** All workflow states of a run, deterministically ordered by section id. */
export function listSectionWorkflowStatesInTx(tx: StoreTx, runId: string): SectionWorkflowStateView[] {
  const rows = tx
    .prepare(`SELECT ${STATE_COLUMNS} FROM section_workflow_states WHERE run_id = ? ORDER BY section_id`)
    .all(runId) as StateRow[];
  return rows.map(rowToState);
}

export function listSectionWorkflowStates(store: PlanStore, runId: string): SectionWorkflowStateView[] {
  return store.withRead((tx) => listSectionWorkflowStatesInTx(tx, runId));
}

/** The run's durable active Section, or null (§10: at most one exists). */
export function getActiveSectionInTx(tx: StoreTx, runId: string): string | null {
  const row = tx.prepare("SELECT section_id AS sectionId FROM planning_active_work WHERE run_id = ?").get(runId) as
    | { sectionId: string }
    | undefined;
  return row?.sectionId ?? null;
}

export function setActiveSectionInTx(tx: StoreTx, runId: string, sectionId: string, now: string): void {
  tx.prepare(
    "INSERT INTO planning_active_work (run_id, section_id, updated_at) VALUES (?, ?, ?) "
    + "ON CONFLICT(run_id) DO UPDATE SET section_id = excluded.section_id, updated_at = excluded.updated_at",
  ).run(runId, sectionId, now);
}

export function clearActiveSectionInTx(tx: StoreTx, runId: string): void {
  tx.prepare("DELETE FROM planning_active_work WHERE run_id = ?").run(runId);
}

export function getActiveSection(store: PlanStore, runId: string): string | null {
  return store.withRead((tx) => getActiveSectionInTx(tx, runId));
}
