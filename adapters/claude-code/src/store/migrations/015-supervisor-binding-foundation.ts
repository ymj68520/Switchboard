/**
 * Migration 015 — supervisor-binding-foundation (v0.2.0 architecture spec §43,
 * E2 directive §5/§6/§16).
 *
 * Adds the durable supervision-ownership domain over the active ExecutionRun:
 *
 *   supervisor_bindings        the ONE canonical current-owner row per
 *                              ExecutionRun (PRIMARY KEY(run_id)) — the 0..1
 *                              writable-Supervisor law is DDL-enforced, never
 *                              commented into existence (E2 §5). The partial
 *                              unique index additionally caps a session at one
 *                              ATTACHED supervision binding.
 *   supervisor_binding_events  append-only ownership audit — ATTACHED
 *                              (initial attach + same-session reattach),
 *                              DETACHED, TAKEOVER (different-session
 *                              generation bump) only.
 *
 * Generation semantics (E2 §6/§7): initial attach = 1; different-session
 * takeover = +1; same-session detach/reattach NEVER changes the generation.
 * Detachment does not mutate ExecutionRun lifecycle (E2 §8).
 *
 * Deliberately NOT created (E2 §2/§16): ExecutionStage, VerificationWindow,
 * ExecutionDirective, ExecutionAttempt/Report, ExecutionCommit tables.
 *
 * NO backfill (E2 §16): a v14 active ExecutionRun receives NO fabricated
 * owner — supervision is unbound until the first legitimate reattach/takeover
 * establishes authority. Newly activated runs create the initial binding
 * normally in the activation transaction.
 */

import type { StoreTx } from "../transaction.js";
import type { StoreMigration } from "./index.js";

export function createSupervisorBindingMigration(): StoreMigration {
  return {
    from: 14,
    to: 15,
    name: "supervisor-binding-foundation",
    apply(tx: StoreTx): void {
      tx.exec(`
        CREATE TABLE supervisor_bindings (
          run_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('attached', 'detached')),
          generation INTEGER NOT NULL CHECK (generation >= 1),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (run_id),
          FOREIGN KEY (run_id) REFERENCES execution_runs(run_id),
          FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id)
        )
      `);
      tx.exec(`
        CREATE TABLE supervisor_binding_events (
          run_id TEXT NOT NULL,
          event_seq INTEGER NOT NULL CHECK (event_seq >= 1),
          event_type TEXT NOT NULL CHECK (event_type IN ('ATTACHED', 'DETACHED', 'TAKEOVER')),
          session_id TEXT,
          detail_json TEXT,
          created_at TEXT NOT NULL,
          PRIMARY KEY (run_id, event_seq),
          FOREIGN KEY (run_id) REFERENCES supervisor_bindings(run_id)
        )
      `);

      // The binding identity (run + workspace) is permanent; only ownership
      // (session), state, generation, and updated_at may change.
      tx.exec(`
        CREATE TRIGGER supervisor_bindings_identity_immutable BEFORE UPDATE ON supervisor_bindings
        BEGIN
          SELECT RAISE(ABORT, 'supervisor binding identity is immutable')
          WHERE OLD.run_id IS NOT NEW.run_id
             OR OLD.workspace_id IS NOT NEW.workspace_id
             OR OLD.created_at IS NOT NEW.created_at;
        END
      `);
      for (const table of ["supervisor_bindings", "supervisor_binding_events"]) {
        tx.exec(
          `CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} `
          + `BEGIN SELECT RAISE(ABORT, '${table} is immutable'); END`,
        );
      }
      for (const table of ["supervisor_binding_events"]) {
        tx.exec(
          `CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} `
          + `BEGIN SELECT RAISE(ABORT, '${table} is immutable'); END`,
        );
      }

      tx.exec(
        "CREATE UNIQUE INDEX idx_supervisor_bindings_active_session "
        + "ON supervisor_bindings (session_id) WHERE state = 'attached'",
      );
      tx.exec("CREATE INDEX idx_supervisor_bindings_session ON supervisor_bindings (session_id)");
      tx.exec(
        "CREATE INDEX idx_supervisor_binding_events_run ON supervisor_binding_events (run_id, event_seq)",
      );
    },
  };
}
