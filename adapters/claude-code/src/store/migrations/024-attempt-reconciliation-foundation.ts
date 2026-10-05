/**
 * Migration 024 — attempt-reconciliation-foundation (v0.2.0 E11 §8/§9/§41/
 * §51/§52).
 *
 * Two immutable facts, both ADDITIVE (E11 §51/§52 — nothing existing changes
 * meaning; no reconciliation rows are fabricated for historical indeterminate
 * Attempts, which remain unresolved until explicitly recovered):
 *
 *   execution_attempt_reconciliation_bindings  the exact indeterminate
 *                              Attempt ↔ ONE logical reconciliation Directive
 *                              id (E11 §9). UNIQUE(attempt_id) is the DDL
 *                              fence for the one-logical-binding rule;
 *                              revisions of the same logical id stay allowed.
 *
 *   execution_attempt_reconciliations  the final immutable resolution (E11 §8):
 *                              at most one per Attempt (UNIQUE(attempt_id));
 *                              the revision-delta shape is CHECK-enforced —
 *                              no_effect never moves the candidate,
 *                              candidate_changed moves it exactly one; the
 *                              inspection Report is null ONLY for the
 *                              deterministic no_effect_by_capability proof.
 *
 *   execution_worker_invocation_events  the frozen event CHECK gains
 *                              'ROTATED' (E11 §41 — launch-credential rotation
 *                              on the SAME prepared binding is a durable
 *                              runtime fact). The table has no children; it
 *                              rebuilds with the extended vocabulary.
 *
 * Deliberately NOT added (E11 §2/§51): ExecutionObservation, abort state, new
 * Attempt lifecycle values.
 */

import type { StoreTx } from "../transaction.js";
import type { StoreMigration } from "./index.js";

export function createAttemptReconciliationFoundationMigration(): StoreMigration {
  return {
    from: 23,
    to: 24,
    name: "attempt-reconciliation-foundation",
    apply(tx: StoreTx): void {
      const tableExists = (name: string): boolean =>
        tx.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;

      // E11 §9 — the immutable binding. The target Attempt and the bound
      // Directive are FK-enforced; the one-logical-binding-per-attempt rule is
      // the UNIQUE attempt_id.
      tx.exec(`
        CREATE TABLE execution_attempt_reconciliation_bindings (
          attempt_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          directive_id TEXT NOT NULL,
          first_directive_revision INTEGER NOT NULL CHECK (first_directive_revision >= 1),
          created_at TEXT NOT NULL,
          PRIMARY KEY (attempt_id),
          FOREIGN KEY (attempt_id) REFERENCES execution_attempts(attempt_id),
          FOREIGN KEY (run_id) REFERENCES execution_runs(run_id),
          FOREIGN KEY (directive_id, first_directive_revision)
            REFERENCES execution_directives(directive_id, revision),
          UNIQUE (attempt_id)
        )
      `);
      tx.exec(`
        CREATE TRIGGER execution_attempt_reconciliation_bindings_no_update
        BEFORE UPDATE ON execution_attempt_reconciliation_bindings
        BEGIN SELECT RAISE(ABORT, 'execution_attempt_reconciliation_bindings is immutable'); END
      `);
      tx.exec(`
        CREATE TRIGGER execution_attempt_reconciliation_bindings_no_delete
        BEFORE DELETE ON execution_attempt_reconciliation_bindings
        BEGIN SELECT RAISE(ABORT, 'execution_attempt_reconciliation_bindings is immutable'); END
      `);
      tx.exec(
        "CREATE INDEX idx_attempt_reconciliation_bindings_directive "
        + "ON execution_attempt_reconciliation_bindings (directive_id)",
      );

      // E11 §8 — the immutable final resolution. UNIQUE(attempt_id) makes a
      // second resolution impossible at the DDL level; the resolution/
      // report/revision-delta shapes are CHECK-enforced.
      tx.exec(`
        CREATE TABLE execution_attempt_reconciliations (
          reconciliation_id TEXT NOT NULL,
          attempt_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          directive_id TEXT NOT NULL,
          directive_revision INTEGER NOT NULL CHECK (directive_revision >= 1),
          source_window_id TEXT NOT NULL,
          resolution TEXT NOT NULL CHECK (
            resolution IN ('no_effect', 'no_effect_by_capability', 'candidate_changed')
          ),
          inspection_report_id TEXT,
          candidate_revision_before INTEGER NOT NULL CHECK (candidate_revision_before >= 0),
          candidate_revision_after INTEGER NOT NULL CHECK (candidate_revision_after >= 0),
          rationale TEXT NOT NULL CHECK (rationale != ''),
          created_at TEXT NOT NULL,
          PRIMARY KEY (reconciliation_id),
          FOREIGN KEY (attempt_id) REFERENCES execution_attempts(attempt_id),
          FOREIGN KEY (run_id) REFERENCES execution_runs(run_id),
          FOREIGN KEY (directive_id, directive_revision)
            REFERENCES execution_directives(directive_id, revision),
          FOREIGN KEY (inspection_report_id) REFERENCES execution_reports(report_id),
          UNIQUE (attempt_id),
          CHECK (
            (resolution = 'candidate_changed'
              AND candidate_revision_after = candidate_revision_before + 1
              AND inspection_report_id IS NOT NULL)
            OR (resolution != 'candidate_changed'
              AND candidate_revision_after = candidate_revision_before)
          ),
          CHECK (
            resolution != 'no_effect_by_capability' OR inspection_report_id IS NULL
          )
        )
      `);
      tx.exec(`
        CREATE TRIGGER execution_attempt_reconciliations_no_update
        BEFORE UPDATE ON execution_attempt_reconciliations
        BEGIN SELECT RAISE(ABORT, 'execution_attempt_reconciliations is immutable'); END
      `);
      tx.exec(`
        CREATE TRIGGER execution_attempt_reconciliations_no_delete
        BEFORE DELETE ON execution_attempt_reconciliations
        BEGIN SELECT RAISE(ABORT, 'execution_attempt_reconciliations is immutable'); END
      `);
      tx.exec(
        "CREATE INDEX idx_attempt_reconciliations_run "
        + "ON execution_attempt_reconciliations (run_id, resolution)",
      );

      // E11 §41 — launch-credential rotation: the E5 identity trigger froze
      // launch_token_hash outright; rotation on a PREPARED, UNCLAIMED binding
      // is now the ONE legal hash movement (still prepared, still unclaimed —
      // a claimed/finished binding can never move its credential).
      tx.exec("DROP TRIGGER IF EXISTS execution_worker_invocations_identity_immutable");
      tx.exec(`
        CREATE TRIGGER execution_worker_invocations_identity_immutable BEFORE UPDATE ON execution_worker_invocations
        BEGIN
          SELECT RAISE(ABORT, 'worker invocation identity is immutable')
          WHERE OLD.attempt_id IS NOT NEW.attempt_id
             OR OLD.run_id IS NOT NEW.run_id
             OR OLD.worker_role IS NOT NEW.worker_role
             OR OLD.created_at IS NOT NEW.created_at
             OR (OLD.launch_token_hash IS NOT NEW.launch_token_hash
               AND NOT (OLD.state = 'prepared' AND NEW.state = 'prepared'
                 AND OLD.worker_session_id IS NULL AND NEW.worker_session_id IS NULL));
        END
      `);

      // E11 §41 — ROTATED joins the invocation-event vocabulary. No table
      // references this one; rows copy byte-identically.
      tx.exec(`
        CREATE TABLE execution_worker_invocation_events_new (
          attempt_id TEXT NOT NULL,
          event_seq INTEGER NOT NULL CHECK (event_seq >= 1),
          event_type TEXT NOT NULL CHECK (event_type IN ('PREPARED', 'CLAIMED', 'FINISHED', 'ROTATED')),
          worker_session_id TEXT,
          created_at TEXT NOT NULL,
          PRIMARY KEY (attempt_id, event_seq),
          FOREIGN KEY (attempt_id) REFERENCES execution_worker_invocations(attempt_id)
        )
      `);
      tx.exec(
        "INSERT INTO execution_worker_invocation_events_new "
        + "SELECT attempt_id, event_seq, event_type, worker_session_id, created_at "
        + "FROM execution_worker_invocation_events",
      );
      tx.exec("DROP TABLE execution_worker_invocation_events");
      tx.exec("ALTER TABLE execution_worker_invocation_events_new RENAME TO execution_worker_invocation_events");
      tx.exec(`
        CREATE TRIGGER execution_worker_invocation_events_no_update
        BEFORE UPDATE ON execution_worker_invocation_events
        BEGIN SELECT RAISE(ABORT, 'execution_worker_invocation_events is immutable'); END
      `);
      tx.exec(`
        CREATE TRIGGER execution_worker_invocation_events_no_delete
        BEFORE DELETE ON execution_worker_invocation_events
        BEGIN SELECT RAISE(ABORT, 'execution_worker_invocation_events is immutable'); END
      `);
      tx.exec(
        "CREATE INDEX idx_worker_invocation_events_attempt "
        + "ON execution_worker_invocation_events (attempt_id, event_seq)",
      );

      // Deep-rewind self-sufficiency: the chain always runs 017/018/019/022
      // before 024 on real stores; missing parents are rewind artifacts that
      // the re-run chain recreates in order.
      void tableExists;
    },
  };
}
