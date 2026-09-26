/**
 * Migration 007 — evidence-freshness-foundation (Phase 10 directive §4–§9).
 *
 * Adds the freshness domain over the frozen Phase 9 Evidence revisions:
 *
 *   evidence_validation_events  append-only freshness history (§5/§6) — the
 *                               AUTHORITY together with the immutable revision
 *   evidence_current_states     materialized exact-revision state (§7) — a
 *                               projection, never a second authority
 *   proposal_evidence_refs      relational index of ProposalCanonicalV2's
 *                               exact requiredEvidence set (§34)
 *
 * Freshness belongs to the EXACT revision EV-X@N (§2), never to the identity.
 * stale/invalidated are terminal for an exact revision (§8) — a DB trigger
 * rejects any further validation event targeting such a revision, so a
 * terminal revision can never be revived through any writer.
 *
 * Migration initialization (§9 — the correctness keystone): every EXISTING
 * evidence revision was created before any freshness engine existed, so it is
 * initialized to `needs_validation` with an INITIALIZED event — never `fresh`.
 * created_at, observation presence, or recorded fingerprints are never used to
 * guess freshness (fail-closed migration).
 *
 * audit_events is deliberately NOT extended: evidence_validation_events is the
 * freshness authority and a second audit stream would create double authority
 * (§74). EVIDENCE_PROMOTED stays as recorded in Phase 9.
 */

import type { StoreTx } from "../transaction.js";
import type { StoreMigration } from "./index.js";

export function createEvidenceFreshnessMigration(): StoreMigration {
  return {
    from: 6,
    to: 7,
    name: "evidence-freshness-foundation",
    apply(tx: StoreTx): void {
      // -- Append-only validation events (§5/§6) --------------------------------
      tx.exec(`
        CREATE TABLE evidence_validation_events (
          run_id TEXT NOT NULL,
          event_seq INTEGER NOT NULL CHECK (event_seq >= 1),
          event_id TEXT NOT NULL,
          evidence_id TEXT NOT NULL,
          evidence_revision INTEGER NOT NULL CHECK (evidence_revision >= 1),
          event_type TEXT NOT NULL CHECK (event_type IN
            ('INITIALIZED','FILE_CHANGED_HINT','SOURCE_CHANGED','FINGERPRINT_VALIDATED',
             'REVALIDATION_UNCERTAIN','REPLACED','INVALIDATED','UPSTREAM_CHANGED')),
          from_state TEXT CHECK (from_state IS NULL OR from_state IN
            ('fresh','needs_validation','stale','invalidated')),
          to_state TEXT NOT NULL CHECK (to_state IN ('fresh','needs_validation','stale','invalidated')),
          reason_code TEXT NOT NULL,
          detail_json TEXT NOT NULL,
          request_id TEXT,
          created_at TEXT NOT NULL,
          PRIMARY KEY (run_id, event_seq),
          UNIQUE (run_id, event_id),
          FOREIGN KEY (run_id, evidence_id, evidence_revision)
            REFERENCES evidence_revisions(run_id, evidence_id, revision)
        )
      `);
      tx.exec(`
        CREATE INDEX idx_evidence_validation_events_revision
          ON evidence_validation_events (run_id, evidence_id, evidence_revision, event_seq)
      `);

      // -- Materialized exact-revision state (§7) --------------------------------
      tx.exec(`
        CREATE TABLE evidence_current_states (
          run_id TEXT NOT NULL,
          evidence_id TEXT NOT NULL,
          evidence_revision INTEGER NOT NULL CHECK (evidence_revision >= 1),
          state TEXT NOT NULL CHECK (state IN ('fresh','needs_validation','stale','invalidated')),
          last_event_seq INTEGER NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (run_id, evidence_id, evidence_revision),
          FOREIGN KEY (run_id, evidence_id, evidence_revision)
            REFERENCES evidence_revisions(run_id, evidence_id, revision),
          FOREIGN KEY (run_id, last_event_seq)
            REFERENCES evidence_validation_events(run_id, event_seq)
        )
      `);

      // -- Terminal-state guard (§8): stale/invalidated exact revisions can
      // never receive another validation event, through ANY writer.
      tx.exec(`
        CREATE TRIGGER evidence_validation_events_no_revival
        BEFORE INSERT ON evidence_validation_events
        WHEN EXISTS (
          SELECT 1 FROM evidence_current_states s
          WHERE s.run_id = NEW.run_id
            AND s.evidence_id = NEW.evidence_id
            AND s.evidence_revision = NEW.evidence_revision
            AND s.state IN ('stale','invalidated')
        )
        BEGIN
          SELECT RAISE(ABORT, 'evidence revision is terminal (stale/invalidated) and cannot change freshness state');
        END
      `);

      // -- ProposalCanonicalV2 requiredEvidence relational index (§34) ----------
      tx.exec(`
        CREATE TABLE proposal_evidence_refs (
          run_id TEXT NOT NULL,
          proposal_id TEXT NOT NULL,
          proposal_revision INTEGER NOT NULL CHECK (proposal_revision >= 1),
          position INTEGER NOT NULL CHECK (position >= 1),
          evidence_id TEXT NOT NULL,
          evidence_revision INTEGER NOT NULL CHECK (evidence_revision >= 1),
          PRIMARY KEY (run_id, proposal_id, proposal_revision, position),
          UNIQUE (run_id, proposal_id, proposal_revision, evidence_id, evidence_revision),
          FOREIGN KEY (run_id, proposal_id, proposal_revision)
            REFERENCES proposal_revisions(run_id, proposal_id, revision),
          FOREIGN KEY (run_id, evidence_id, evidence_revision)
            REFERENCES evidence_revisions(run_id, evidence_id, revision)
        )
      `);

      // Upstream-lookup index for deterministic derived propagation (§16).
      tx.exec(`
        CREATE INDEX idx_evidence_derived_refs_upstream
          ON evidence_derived_refs (run_id, derived_from_evidence_id, derived_from_revision)
      `);

      // -- §9 fail-closed backfill: every pre-existing revision is
      // needs_validation, with its INITIALIZED event. Deterministic order and
      // per-run event_seq numbering keep the replay exact.
      const revisions = tx
        .prepare(
          "SELECT run_id AS runId, evidence_id AS evidenceId, revision AS revision FROM evidence_revisions ORDER BY run_id, evidence_id, revision",
        )
        .all() as Array<{ runId: string; evidenceId: string; revision: number }>;
      const nextSeqByRun = new Map<string, number>();
      for (const row of revisions) {
        const seq = (nextSeqByRun.get(row.runId) ?? 0) + 1;
        nextSeqByRun.set(row.runId, seq);
        tx.prepare(
          `INSERT INTO evidence_validation_events (
             run_id, event_seq, event_id, evidence_id, evidence_revision,
             event_type, from_state, to_state, reason_code, detail_json, request_id, created_at
           ) VALUES (?, ?, ?, ?, ?, 'INITIALIZED', NULL, 'needs_validation', 'schema7_failclosed_initialization', ?, NULL, ?)`,
        ).run(
          row.runId,
          seq,
          `initialized:${row.evidenceId}:${row.revision}`,
          row.evidenceId,
          row.revision,
          JSON.stringify({
            policy:
              "pre-freshness evidence revisions are never assumed fresh; created_at, observation presence, and recorded fingerprints are not freshness evidence",
          }),
          "migration",
        );
        tx.prepare(
          `INSERT INTO evidence_current_states (run_id, evidence_id, evidence_revision, state, last_event_seq, updated_at)
           VALUES (?, ?, ?, 'needs_validation', ?, 'migration')`,
        ).run(row.runId, row.evidenceId, row.revision, seq);
      }

      // -- Immutability triggers (§3/§5/§34). evidence_current_states is the
      // materialized projection: its rows are UPDATED on every event (§7) —
      // only deletion is fenced there; events and proposal refs are fully
      // append-only.
      const immutableTables = [
        "evidence_validation_events",
        "proposal_evidence_refs",
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
      tx.exec(`
        CREATE TRIGGER evidence_current_states_no_delete BEFORE DELETE ON evidence_current_states
        BEGIN
          SELECT RAISE(ABORT, 'evidence_current_states is immutable');
        END
      `);
    },
  };
}
