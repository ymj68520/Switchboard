/**
 * Migration 020 — stage-completion-provenance (v0.2.0 E7 §42/§43).
 *
 * The minimal durable addition Stage progression requires:
 *
 *   execution_stages.completed_by_commit_id  the EXACT ExecutionCommit whose
 *                                            satisfied obligations completed
 *                                            the Stage (E7 §12). Nullable;
 *                                            NULL for every non-completed
 *                                            status (pending/active/superseded)
 *                                            and immutable once set. FK to
 *                                            execution_commits.
 *
 *   execution_stages_completion_insert_shape  a Stage can never be CREATED
 *                                            completed or carrying completion
 *                                            provenance — completion is only
 *                                            ever derived inside an acceptance
 *                                            transaction (E7 §7/§14).
 *   execution_stages_completion_consistent    the status↔provenance coupling
 *                                            (E7 §12): status = completed ↔
 *                                            completed_by_commit_id non-null;
 *                                            a completed Stage is terminal
 *                                            (E7 §13 — completed → active /
 *                                            completed → pending are
 *                                            impossible); provenance never
 *                                            changes once set.
 *
 * Deliberately NOT created (E7 §42): no new tables. The CoveredObligation
 * JSON (E7 §5 `stage_objective`) persists inside the EXISTING
 * satisfied_obligations_json / covered_obligations_json columns, so no DDL is
 * needed for it. No finalization tables, no replan transition tables, no
 * verification scheduler tables, no ExecutionObservation, no
 * ExecutionRun-completion artifact (E7 §28/§57).
 *
 * E7 §43 — preservation: no existing Stage state changes. Because no pre-E7
 * path could complete a Stage, every migrated row keeps its status and gains
 * completed_by_commit_id = NULL. No completion provenance is fabricated.
 * acceptedHead / Commit / Window-base state remains byte-identical.
 */

import type { StoreTx } from "../transaction.js";
import type { StoreMigration } from "./index.js";

export function createStageCompletionProvenanceMigration(): StoreMigration {
  return {
    from: 19,
    to: 20,
    name: "stage-completion-provenance",
    apply(tx: StoreTx): void {
      // E7 §12 — the exact accepted Commit that completed the Stage.
      tx.exec(
        "ALTER TABLE execution_stages ADD COLUMN completed_by_commit_id TEXT "
        + "REFERENCES execution_commits(commit_id)",
      );

      // E7 §7/§14 — completion never originates at creation time.
      tx.exec(`
        CREATE TRIGGER execution_stages_completion_insert_shape BEFORE INSERT ON execution_stages
        BEGIN
          SELECT RAISE(ABORT, 'a stage cannot be created completed or with completion provenance')
          WHERE NEW.status = 'completed' OR NEW.completed_by_commit_id IS NOT NULL;
        END
      `);

      // E7 §12/§13 — status = completed ↔ provenance non-null; completed is
      // terminal; provenance is immutable once set.
      tx.exec(`
        CREATE TRIGGER execution_stages_completion_consistent BEFORE UPDATE ON execution_stages
        BEGIN
          SELECT RAISE(ABORT, 'stage completion provenance is immutable once set')
          WHERE OLD.completed_by_commit_id IS NOT NULL
            AND NEW.completed_by_commit_id IS NOT OLD.completed_by_commit_id;
          SELECT RAISE(ABORT, 'a completed stage is terminal')
          WHERE OLD.status = 'completed' AND NEW.status != 'completed';
          SELECT RAISE(ABORT, 'a completed stage requires its completion commit provenance')
          WHERE NEW.status = 'completed' AND NEW.completed_by_commit_id IS NULL;
          SELECT RAISE(ABORT, 'completion provenance requires the completed status')
          WHERE NEW.status != 'completed' AND NEW.completed_by_commit_id IS NOT NULL;
        END
      `);
    },
  };
}
