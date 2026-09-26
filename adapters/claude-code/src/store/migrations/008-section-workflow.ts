/**
 * Migration 008 — section-workflow (Phase 11 directive §3–§9).
 *
 * Adds the operational workflow domain over the frozen immutable Section
 * revisions:
 *
 *   section_workflow_events   append-only workflow history (§7) — together
 *                             with the immutable revisions, the AUTHORITY
 *   section_workflow_states   materialized per-Section state (§8) — a
 *                             projection carrying the exact completion
 *                             provenance (completed revision/proposal/commit)
 *   planning_active_work      the durable active Section per run (§10) —
 *                             one PlanningRun has at most one active Section
 *
 * The completion invariants are DDL-enforced (§8): completed and needs_review
 * rows carry ALL completion fields; open rows carry NONE. needs_review keeps
 * its prior completion provenance (§6) so the store can always answer "which
 * completion claim is now under review".
 *
 * Migration initialization (§9 — fail-closed, mirroring Phase 10 §9): every
 * EXISTING Section identity is initialized to `open` with a REGISTERED event
 * — never guessed completed from stage, created_at, revision count, or
 * contract presence.
 *
 * Deliberately NOT created (§3): synthesis_manifests, validation_reports,
 * final_plans, execution_bindings — Synthesis/Validator/Finalization belongs
 * to a later phase and must not leak in early.
 */

import type { StoreTx } from "../transaction.js";
import type { StoreMigration } from "./index.js";

export function createSectionWorkflowMigration(): StoreMigration {
  return {
    from: 7,
    to: 8,
    name: "section-workflow",
    apply(tx: StoreTx): void {
      // -- Append-only workflow events (§7) -------------------------------------
      tx.exec(`
        CREATE TABLE section_workflow_events (
          run_id TEXT NOT NULL,
          event_seq INTEGER NOT NULL CHECK (event_seq >= 1),
          event_id TEXT NOT NULL,
          section_id TEXT NOT NULL,
          event_type TEXT NOT NULL CHECK (event_type IN
            ('REGISTERED','COMPLETED','REOPENED','DEPENDENCY_REVIEW_REQUIRED','EVIDENCE_REVIEW_REQUIRED')),
          from_state TEXT CHECK (from_state IS NULL OR from_state IN
            ('open','completed','needs_review')),
          to_state TEXT NOT NULL CHECK (to_state IN ('open','completed','needs_review')),
          reason_code TEXT NOT NULL,
          detail_json TEXT NOT NULL,
          request_id TEXT,
          created_at TEXT NOT NULL,
          PRIMARY KEY (run_id, event_seq),
          UNIQUE (run_id, event_id),
          FOREIGN KEY (run_id) REFERENCES planning_runs(run_id)
        )
      `);
      tx.exec(`
        CREATE INDEX idx_section_workflow_events_section
          ON section_workflow_events (run_id, section_id, event_seq)
      `);

      // -- Materialized per-Section workflow state (§8) --------------------------
      // The CHECK encodes the §8 invariant directly: completed/needs_review
      // carry the full completion provenance; open carries none of it.
      tx.exec(`
        CREATE TABLE section_workflow_states (
          run_id TEXT NOT NULL,
          section_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('open','completed','needs_review')),
          completed_revision INTEGER CHECK (completed_revision IS NULL OR completed_revision >= 1),
          completed_proposal_id TEXT,
          completed_proposal_revision INTEGER CHECK (completed_proposal_revision IS NULL OR completed_proposal_revision >= 1),
          completion_commit_id TEXT,
          last_event_seq INTEGER NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (run_id, section_id),
          FOREIGN KEY (run_id) REFERENCES planning_runs(run_id),
          FOREIGN KEY (run_id, last_event_seq)
            REFERENCES section_workflow_events(run_id, event_seq),
          CHECK (
            (
              status IN ('completed','needs_review')
              AND completed_revision IS NOT NULL
              AND completed_proposal_id IS NOT NULL
              AND completed_proposal_revision IS NOT NULL
              AND completion_commit_id IS NOT NULL
            )
            OR
            (
              status = 'open'
              AND completed_revision IS NULL
              AND completed_proposal_id IS NULL
              AND completed_proposal_revision IS NULL
              AND completion_commit_id IS NULL
            )
          )
        )
      `);

      // -- Durable active Section (§10): at most one per run (PK on run_id) ------
      tx.exec(`
        CREATE TABLE planning_active_work (
          run_id TEXT NOT NULL PRIMARY KEY,
          section_id TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (run_id) REFERENCES planning_runs(run_id)
        )
      `);

      // -- §9 fail-closed backfill: every pre-existing Section identity is
      // open, with its REGISTERED event. Stage/created_at/revision count/
      // contract presence are never used to guess completion.
      const sections = tx
        .prepare(
          "SELECT run_id AS runId, artifact_id AS sectionId FROM memory_artifacts WHERE kind = 'section' ORDER BY run_id, artifact_id",
        )
        .all() as Array<{ runId: string; sectionId: string }>;
      const nextSeqByRun = new Map<string, number>();
      for (const row of sections) {
        const seq = (nextSeqByRun.get(row.runId) ?? 0) + 1;
        nextSeqByRun.set(row.runId, seq);
        tx.prepare(
          `INSERT INTO section_workflow_events (
             run_id, event_seq, event_id, section_id,
             event_type, from_state, to_state, reason_code, detail_json, request_id, created_at
           ) VALUES (?, ?, ?, ?, 'REGISTERED', NULL, 'open', 'schema8_failclosed_initialization', ?, NULL, ?)`,
        ).run(
          row.runId,
          seq,
          `registered:${row.sectionId}`,
          row.sectionId,
          JSON.stringify({
            policy:
              "pre-workflow Section identities are never assumed completed; stage, created_at, revision count, and contract presence are not completion evidence",
          }),
          "migration",
        );
        tx.prepare(
          `INSERT INTO section_workflow_states (run_id, section_id, status, completed_revision, completed_proposal_id, completed_proposal_revision, completion_commit_id, last_event_seq, updated_at)
           VALUES (?, ?, 'open', NULL, NULL, NULL, NULL, ?, 'migration')`,
        ).run(row.runId, row.sectionId, seq);
      }

      // -- Immutability triggers (§7): events are append-only; the materialized
      // state is a projection whose rows UPDATE on every event — only its
      // deletion is fenced. planning_active_work is ordinary mutable workflow
      // state: select/clear/switch are its normal operations.
      tx.exec(`
        CREATE TRIGGER section_workflow_events_no_update BEFORE UPDATE ON section_workflow_events
        BEGIN
          SELECT RAISE(ABORT, 'section_workflow_events is immutable');
        END
      `);
      tx.exec(`
        CREATE TRIGGER section_workflow_events_no_delete BEFORE DELETE ON section_workflow_events
        BEGIN
          SELECT RAISE(ABORT, 'section_workflow_events is immutable');
        END
      `);
      tx.exec(`
        CREATE TRIGGER section_workflow_states_no_delete BEFORE DELETE ON section_workflow_states
        BEGIN
          SELECT RAISE(ABORT, 'section_workflow_states is immutable');
        END
      `);
    },
  };
}
