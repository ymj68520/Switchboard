/**
 * Migration 006 — observation-evidence-foundation (Phase 9 directive §3/§4).
 *
 * Adds the Observation Ledger (automatic, temporary, non-authoritative host
 * tool-result provenance) and the Evidence foundation (explicit promotion of
 * ledger entries into durable, immutable planning-relevant claims):
 *
 *   observations                immutable per-event records; UNIQUE(run_id,
 *                               tool_use_id) is the DB-enforced capture
 *                               idempotency boundary (§40/§41); per-run
 *                               observation_seq gives the deterministic
 *                               ledger order (§20)
 *   evidence_artifacts          evidence identity (ev_…), stable metadata
 *   evidence_revisions          immutable claims (§52: no UPDATE/DELETE);
 *                               UNIQUE(run_id, request_id) is the DB-enforced
 *                               promotion idempotency boundary (§44)
 *   evidence_observation_refs   immutable Observation provenance links (§30)
 *   evidence_derived_refs       immutable exact upstream-revision links (§31)
 *
 * Deliberately NOT created (Phase 10 owns freshness — §4/E38/E39):
 *   evidence_current_state, evidence_validation_events,
 *   evidence_invalidation_events, file_change_events.
 *
 * The audit log's event_type CHECK gains EVIDENCE_PROMOTED (§72). SQLite
 * cannot ALTER a CHECK, so audit_events is rebuilt in-place inside this same
 * transaction: rows are copied verbatim (event_seq preserved), the immutability
 * triggers are recreated. Append-only semantics are never relaxed.
 */

import type { StoreTx } from "../transaction.js";
import type { StoreMigration } from "./index.js";

export function createObservationEvidenceMigration(): StoreMigration {
  return {
    from: 5,
    to: 6,
    name: "observation-evidence-foundation",
    apply(tx: StoreTx): void {
      // -- Observation Ledger ----------------------------------------------------
      tx.exec(`
        CREATE TABLE observations (
          run_id TEXT NOT NULL REFERENCES planning_runs(run_id),
          observation_id TEXT NOT NULL,
          observation_seq INTEGER NOT NULL CHECK (observation_seq >= 1),
          workspace_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          tool_use_id TEXT NOT NULL,
          observation_class TEXT NOT NULL CHECK (observation_class IN ('source','locator','execution')),
          input_projection_json TEXT NOT NULL,
          payload_hash TEXT CHECK (payload_hash IS NULL OR payload_hash LIKE 'sha256:%'),
          payload_size INTEGER CHECK (payload_size IS NULL OR payload_size >= 0),
          content_type TEXT NOT NULL CHECK (content_type IN
            ('text/plain; charset=utf-8','application/octet-stream','application/x-phase-plan-omitted')),
          source_fingerprint_json TEXT,
          repository_revision TEXT,
          promotable INTEGER NOT NULL CHECK (promotable IN (0,1)),
          sanitized TEXT,
          captured_at TEXT NOT NULL,
          PRIMARY KEY (run_id, observation_id),
          UNIQUE (run_id, tool_use_id),
          CHECK (
            (content_type = 'text/plain; charset=utf-8' AND payload_hash IS NOT NULL AND payload_size IS NOT NULL)
            OR (content_type != 'text/plain; charset=utf-8' AND payload_hash IS NULL AND payload_size IS NULL)
          ),
          CHECK (promotable = 0 OR (content_type = 'text/plain; charset=utf-8' AND sanitized IS NULL))
        )
      `);
      tx.exec(`
        CREATE INDEX idx_observations_run_seq ON observations (run_id, observation_seq)
      `);

      // -- Evidence identity + immutable revisions -------------------------------
      tx.exec(`
        CREATE TABLE evidence_artifacts (
          run_id TEXT NOT NULL REFERENCES planning_runs(run_id),
          evidence_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (run_id, evidence_id),
          UNIQUE (evidence_id)
        )
      `);
      tx.exec(`
        CREATE TABLE evidence_revisions (
          run_id TEXT NOT NULL,
          evidence_id TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK (revision >= 1),
          claim TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('source_fact','locator_fact','execution_result','derived_claim')),
          scope_json TEXT NOT NULL,
          confidence TEXT NOT NULL CHECK (confidence IN ('direct','derived','uncertain')),
          criticality TEXT NOT NULL CHECK (criticality IN ('critical','supporting','informational')),
          validation_strategy TEXT NOT NULL CHECK (validation_strategy IN ('fingerprint','reobserve')),
          repository_context_json TEXT NOT NULL,
          workspace_context_json TEXT NOT NULL,
          source_fingerprints_json TEXT NOT NULL,
          request_id TEXT NOT NULL,
          request_hash TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (run_id, evidence_id, revision),
          UNIQUE (run_id, request_id),
          FOREIGN KEY (run_id, evidence_id) REFERENCES evidence_artifacts(run_id, evidence_id)
        )
      `);

      // -- Immutable provenance links -------------------------------------------
      tx.exec(`
        CREATE TABLE evidence_observation_refs (
          run_id TEXT NOT NULL,
          evidence_id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          observation_id TEXT NOT NULL,
          ref_position INTEGER NOT NULL CHECK (ref_position >= 1),
          PRIMARY KEY (run_id, evidence_id, revision, observation_id),
          FOREIGN KEY (run_id, evidence_id, revision)
            REFERENCES evidence_revisions(run_id, evidence_id, revision),
          FOREIGN KEY (run_id, observation_id)
            REFERENCES observations(run_id, observation_id)
        )
      `);
      tx.exec(`
        CREATE TABLE evidence_derived_refs (
          run_id TEXT NOT NULL,
          evidence_id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          derived_from_evidence_id TEXT NOT NULL,
          derived_from_revision INTEGER NOT NULL CHECK (derived_from_revision >= 1),
          ref_position INTEGER NOT NULL CHECK (ref_position >= 1),
          PRIMARY KEY (run_id, evidence_id, revision, derived_from_evidence_id),
          FOREIGN KEY (run_id, evidence_id, revision)
            REFERENCES evidence_revisions(run_id, evidence_id, revision),
          FOREIGN KEY (run_id, derived_from_evidence_id, derived_from_revision)
            REFERENCES evidence_revisions(run_id, evidence_id, revision)
        )
      `);

      // -- audit_events CHECK extension: verbatim in-transaction rebuild (§72) ---
      tx.exec("ALTER TABLE audit_events RENAME TO audit_events_v5_legacy");
      tx.exec(`
        CREATE TABLE audit_events (
          event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id TEXT NOT NULL UNIQUE,
          run_id TEXT NOT NULL REFERENCES planning_runs(run_id),
          event_type TEXT NOT NULL CHECK (event_type IN
            ('PROPOSAL_PREPARED','PROPOSAL_REVISED','PROPOSAL_REJECTED','PLAN_COMMITTED','EVIDENCE_PROMOTED')),
          subject_json TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        )
      `);
      tx.exec(`
        INSERT INTO audit_events (event_seq, event_id, run_id, event_type, subject_json, payload_json, created_at)
          SELECT event_seq, event_id, run_id, event_type, subject_json, payload_json, created_at
          FROM audit_events_v5_legacy
      `);
      tx.exec("DROP TABLE audit_events_v5_legacy");

      // -- Immutability triggers (§6/§52/§53): no UPDATE, no DELETE --------------
      const immutableTables = [
        "observations",
        "evidence_artifacts",
        "evidence_revisions",
        "evidence_observation_refs",
        "evidence_derived_refs",
        "audit_events",
      ];
      for (const table of immutableTables) {
        tx.exec(`
          CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table}
          BEGIN
            SELECT RAISE(ABORT, '${table} is immutable');
          END
        `);
        tx.exec(`
          CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table}
          BEGIN
            SELECT RAISE(ABORT, '${table} is immutable');
          END
        `);
      }
    },
  };
}
