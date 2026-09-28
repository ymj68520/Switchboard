/**
 * Migration 013 — run-control-authorizations (Phase 16 directive §4).
 *
 * Adds the control-plane authority record for the two v0.1 run-control
 * operations (`takeover_run`, `abort_run`). Control operations are NOT design
 * facts (§1/§3): they never ride Proposal → Approval → PlanCommit — each is
 * its own explicit human authorization, and the authorization must be DURABLE
 * (§6): crash/retry arbitration needs the persisted
 * authorization_request_id + request_hash, not a memory of a host dialog.
 *
 *   run_control_authorizations   one immutable row per authorized control
 *                                operation (§4/§5); UNIQUE(operation_id) is
 *                                the idempotency fence for
 *                                `takeover:<toolUseId>` / `abort:<toolUseId}`
 *                                (§25)
 *
 * Deliberately NOT created (§4 — no control state machine, §禁令): no
 * takeover_requests, no abort_markers, no owner_heartbeats, no run_deletions.
 * Session identities may be persisted internally (previous/new binding
 * identity) but are never exposed to the model (§4/§13). NO backfill (§52):
 * historical takeovers/aborts never happened, so the table starts empty.
 */

import type { StoreTx } from "../transaction.js";
import type { StoreMigration } from "./index.js";

export function createRunControlAuthorizationsMigration(): StoreMigration {
  return {
    from: 12,
    to: 13,
    name: "run-control-authorizations",
    apply(tx: StoreTx): void {
      tx.exec(`
        CREATE TABLE run_control_authorizations (
          control_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          operation TEXT NOT NULL CHECK (operation IN ('takeover', 'abort')),
          authorization_request_id TEXT NOT NULL,
          operation_id TEXT NOT NULL,
          request_hash TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          expected_binding_generation INTEGER NOT NULL CHECK (expected_binding_generation >= 1),
          resulting_binding_generation INTEGER CHECK (resulting_binding_generation >= 1),
          previous_binding_identity TEXT,
          new_binding_identity TEXT,
          resulting_run_revision INTEGER CHECK (resulting_run_revision >= 1),
          reason TEXT,
          created_at TEXT NOT NULL,
          UNIQUE (operation_id),
          UNIQUE (authorization_request_id),
          FOREIGN KEY (run_id) REFERENCES planning_runs(run_id)
        )
      `);

      // §5 — the durable authority is append-only: NO UPDATE, NO DELETE.
      tx.exec(
        "CREATE TRIGGER run_control_authorizations_no_update BEFORE UPDATE ON run_control_authorizations "
        + "BEGIN SELECT RAISE(ABORT, 'run_control_authorizations is immutable'); END",
      );
      tx.exec(
        "CREATE TRIGGER run_control_authorizations_no_delete BEFORE DELETE ON run_control_authorizations "
        + "BEGIN SELECT RAISE(ABORT, 'run_control_authorizations is immutable'); END",
      );

      tx.exec(
        "CREATE INDEX idx_run_control_authorizations_run ON run_control_authorizations (run_id, operation)",
      );
    },
  };
}
