/**
 * Migration 018 — worker-invocation-foundation (v0.2.0 E5 §45/§46/§47/§48).
 *
 * Adds the durable Claude ExecutionWorker invocation correlation:
 *
 *   execution_worker_invocations         runtime/adapter authority metadata:
 *                                        ONE invocation binding per Attempt
 *                                        (PRIMARY KEY(attempt_id)), binding the
 *                                        attempt to its exact run/role. The
 *                                        launch token is stored ONLY as a
 *                                        sha256 hash (E5 §9/§46) — the
 *                                        plaintext lives once in the launch
 *                                        result. The claimed worker session is
 *                                        set at most once (trigger); a finished
 *                                        invocation can never return to
 *                                        claimed/prepared (trigger). This is
 *                                        NOT accepted execution progress and
 *                                        NOT a SupervisorBinding.
 *   execution_worker_invocation_events   append-only runtime correlation
 *                                        audit — PREPARED, CLAIMED, FINISHED.
 *                                        Attempt remains the ONLY logical work
 *                                        lifecycle (E5 §47); these events never
 *                                        duplicate it.
 *
 * A partial unique index enforces AT MOST ONE claimed invocation per worker
 * session (E5 §46 — one claimed session owns at most its exact Attempt
 * authority; preferred v0.2.0 shape).
 *
 * Deliberately NOT created (E5 §45): supervisor_assessments, execution_commits,
 * accepted_head, verification outcome, execution_observations.
 *
 * NO backfill (E5 §48): pre-E5 running Attempts keep running WITHOUT any
 * worker session identity — no Worker is claimed retroactively; they surface
 * as legacy-unbound in the recovery projection and require explicit runtime
 * reconciliation. E1–E4 data is unchanged.
 */

import type { StoreTx } from "../transaction.js";
import type { StoreMigration } from "./index.js";

export function createWorkerInvocationMigration(): StoreMigration {
  return {
    from: 17,
    to: 18,
    name: "worker-invocation-foundation",
    apply(tx: StoreTx): void {
      tx.exec(`
        CREATE TABLE execution_worker_invocations (
          attempt_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          worker_role TEXT NOT NULL CHECK (worker_role IN ('executor', 'verifier')),
          state TEXT NOT NULL CHECK (state IN ('prepared', 'claimed', 'finished')),
          worker_session_id TEXT,
          worker_agent_id TEXT,
          launch_token_hash TEXT NOT NULL,
          created_at TEXT NOT NULL,
          claimed_at TEXT,
          finished_at TEXT,
          PRIMARY KEY (attempt_id),
          FOREIGN KEY (attempt_id) REFERENCES execution_attempts(attempt_id),
          FOREIGN KEY (run_id) REFERENCES execution_runs(run_id)
        )
      `);
      tx.exec(`
        CREATE TABLE execution_worker_invocation_events (
          attempt_id TEXT NOT NULL,
          event_seq INTEGER NOT NULL CHECK (event_seq >= 1),
          event_type TEXT NOT NULL CHECK (event_type IN ('PREPARED', 'CLAIMED', 'FINISHED')),
          worker_session_id TEXT,
          created_at TEXT NOT NULL,
          PRIMARY KEY (attempt_id, event_seq),
          FOREIGN KEY (attempt_id) REFERENCES execution_worker_invocations(attempt_id)
        )
      `);

      // Invocation identity (attempt/run/role/token hash/creation) is permanent.
      tx.exec(`
        CREATE TRIGGER execution_worker_invocations_identity_immutable BEFORE UPDATE ON execution_worker_invocations
        BEGIN
          SELECT RAISE(ABORT, 'worker invocation identity is immutable')
          WHERE OLD.attempt_id IS NOT NEW.attempt_id
             OR OLD.run_id IS NOT NEW.run_id
             OR OLD.worker_role IS NOT NEW.worker_role
             OR OLD.launch_token_hash IS NOT NEW.launch_token_hash
             OR OLD.created_at IS NOT NEW.created_at;
        END
      `);
      // E5 §46 — the claimed worker session is set AT MOST ONCE, never moved.
      tx.exec(`
        CREATE TRIGGER execution_worker_invocations_session_immutable BEFORE UPDATE ON execution_worker_invocations
        BEGIN
          SELECT RAISE(ABORT, 'claimed worker session is set at most once')
          WHERE OLD.worker_session_id IS NOT NULL AND OLD.worker_session_id IS NOT NEW.worker_session_id;
        END
      `);
      // E5 §46 — a finished invocation never returns to claimed/prepared.
      tx.exec(`
        CREATE TRIGGER execution_worker_invocations_finished_terminal BEFORE UPDATE ON execution_worker_invocations
        BEGIN
          SELECT RAISE(ABORT, 'a finished invocation is terminal')
          WHERE OLD.state = 'finished' AND NEW.state != 'finished';
        END
      `);
      tx.exec(`
        CREATE TRIGGER execution_worker_invocations_no_delete BEFORE DELETE ON execution_worker_invocations
        BEGIN SELECT RAISE(ABORT, 'execution_worker_invocations is immutable'); END
      `);
      for (const table of ["execution_worker_invocation_events"]) {
        tx.exec(
          `CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} `
          + `BEGIN SELECT RAISE(ABORT, '${table} is immutable'); END`,
        );
        tx.exec(
          `CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} `
          + `BEGIN SELECT RAISE(ABORT, '${table} is immutable'); END`,
        );
      }

      // E5 §46 — at most ONE claimed invocation per worker session.
      tx.exec(
        "CREATE UNIQUE INDEX idx_worker_invocations_claimed_session "
        + "ON execution_worker_invocations (worker_session_id) WHERE state = 'claimed'",
      );
      tx.exec("CREATE INDEX idx_worker_invocations_run ON execution_worker_invocations (run_id, state)");
      tx.exec("CREATE INDEX idx_worker_invocation_events_attempt ON execution_worker_invocation_events (attempt_id, event_seq)");
    },
  };
}
