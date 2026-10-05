/**
 * Migration 016 — execution-structure-foundation (v0.2.0 architecture spec
 * §13/§14, E3 §4–§22).
 *
 * Adds the durable execution-progress structure under the active ExecutionRun:
 *
 *   execution_stages      the ExecutionStage set deterministically
 *                         materialized from the approved FinalPlan
 *                         implementation order (E3 §6): UNIQUE(run_id,
 *                         ordinal) pins the default sequence, UNIQUE(run_id,
 *                         source_step_id) makes per-step materialization
 *                         idempotent at the DDL level, and the partial unique
 *                         index enforces AT MOST ONE ACTIVE stage per run
 *                         (E3 §9/§28) — multiple pending stages are fine.
 *                         depends_on_json carries the EXPLICIT mandatory
 *                         predecessor step ids approved in the FinalPlan;
 *                         default order is never promoted into a fake hard
 *                         dependency (E3 §8).
 *   verification_windows  the VerificationWindows of one ExecutionRun: each
 *                         window has INDEPENDENT durable identity
 *                         (PRIMARY KEY(id)) and belongs to exactly one run
 *                         and one stage of that run. Cardinality (E3C):
 *                         one ExecutionRun owns 1..N windows, one
 *                         ExecutionStage owns 1..N sequential windows, and
 *                         AT MOST ONE window is OPEN per run — the partial
 *                         unique index on closed_at IS NULL is the only
 *                         uniqueness. Each window's candidate_revision
 *                         starts at 0 and lives entirely inside that window;
 *                         only the Core compare-and-swap primitive moves it.
 *                         The genesis window is rooted conceptually in the
 *                         ExecutionRun execution-start baseline — NO
 *                         fabricated EC-000, no acceptedHead, no commit
 *                         foreign key (E3 §13/§17).
 *
 * Deliberately NOT created (E3 §2/§22): execution_directives,
 * execution_attempts, execution_reports, supervisor_assessments,
 * execution_commits, accepted_head.
 *
 * NO backfill (E3 §22): a v15 active ExecutionRun keeps its state unchanged
 * and may temporarily have no structure; deterministic
 * ensureExecutionStructure materializes it from the exact FinalPlan at
 * recovery time. Planning lifecycle is NOT touched.
 */

import type { StoreTx } from "../transaction.js";
import type { StoreMigration } from "./index.js";

export function createExecutionStructureMigration(): StoreMigration {
  return {
    from: 15,
    to: 16,
    name: "execution-structure-foundation",
    apply(tx: StoreTx): void {
      tx.exec(`
        CREATE TABLE execution_stages (
          id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
          status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'completed', 'superseded')),
          objective TEXT NOT NULL,
          source_step_id TEXT,
          depends_on_json TEXT NOT NULL,
          source_refs_json TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK (revision >= 1),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (id),
          UNIQUE (run_id, ordinal),
          UNIQUE (run_id, source_step_id),
          FOREIGN KEY (run_id) REFERENCES execution_runs(run_id)
        )
      `);
      tx.exec(`
        CREATE TABLE verification_windows (
          id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          stage_id TEXT NOT NULL,
          candidate_revision INTEGER NOT NULL CHECK (candidate_revision >= 0),
          opened_at TEXT NOT NULL,
          closed_at TEXT,
          PRIMARY KEY (id),
          FOREIGN KEY (run_id) REFERENCES execution_runs(run_id),
          FOREIGN KEY (stage_id) REFERENCES execution_stages(id)
        )
      `);

      // The stage provenance (run, ordinal, objective, step ref, dependencies,
      // refs) is permanent; only status/revision/updated_at may change.
      tx.exec(`
        CREATE TRIGGER execution_stages_provenance_immutable BEFORE UPDATE ON execution_stages
        BEGIN
          SELECT RAISE(ABORT, 'execution stage provenance is immutable')
          WHERE OLD.run_id IS NOT NEW.run_id
             OR OLD.ordinal IS NOT NEW.ordinal
             OR OLD.objective IS NOT NEW.objective
             OR OLD.source_step_id IS NOT NEW.source_step_id
             OR OLD.depends_on_json IS NOT NEW.depends_on_json
             OR OLD.source_refs_json IS NOT NEW.source_refs_json
             OR OLD.created_at IS NOT NEW.created_at;
        END
      `);
      tx.exec(`
        CREATE TRIGGER verification_windows_identity_immutable BEFORE UPDATE ON verification_windows
        BEGIN
          SELECT RAISE(ABORT, 'verification window identity is immutable')
          WHERE OLD.run_id IS NOT NEW.run_id
             OR OLD.stage_id IS NOT NEW.stage_id
             OR OLD.opened_at IS NOT NEW.opened_at;
        END
      `);
      tx.exec(`
        CREATE TRIGGER execution_stages_no_delete BEFORE DELETE ON execution_stages
        BEGIN SELECT RAISE(ABORT, 'execution_stages is immutable'); END
      `);
      tx.exec(`
        CREATE TRIGGER verification_windows_no_delete BEFORE DELETE ON verification_windows
        BEGIN SELECT RAISE(ABORT, 'verification_windows is immutable'); END
      `);

      // E3 §9/§28 — at most ONE active stage per ExecutionRun (DDL-enforced).
      tx.exec(
        "CREATE UNIQUE INDEX idx_execution_stages_active_run "
        + "ON execution_stages (run_id) WHERE status = 'active'",
      );
      // E3 §14/§28 — at most ONE open window per ExecutionRun (DDL-enforced).
      tx.exec(
        "CREATE UNIQUE INDEX idx_verification_windows_open_run "
        + "ON verification_windows (run_id) WHERE closed_at IS NULL",
      );
      tx.exec("CREATE INDEX idx_execution_stages_run ON execution_stages (run_id, ordinal)");
      tx.exec("CREATE INDEX idx_verification_windows_run ON verification_windows (run_id, stage_id)");
    },
  };
}
