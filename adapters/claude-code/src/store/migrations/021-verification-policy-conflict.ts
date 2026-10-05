/**
 * Migration 021 — verification-policy-conflict-foundation (v0.2.0 E8 §45/§46).
 *
 * Adds the two E8 persistence families:
 *
 *   execution_directives.protocol_version        NOT NULL DEFAULT 1 — historical
 *                                                rows are v1 BY DEFINITION and
 *                                                their directive_hash values are
 *                                                NEVER re-hashed or reinterpreted
 *                                                (E8 §4/§5/§46). New rows are v2.
 *   execution_directives.verification_*          the structured verification-
 *                                                policy fields (NULL for every
 *                                                v1 row — historical policy
 *                                                stays explicitly unknown, never
 *                                                backfilled; E8 §46). Part of the
 *                                                v2 canonical hash (E8 §6).
 *
 *   verification_conflicts        the durable Supervisor-declared factual
 *                                 conflict (E8 §27): bound to the EXACT
 *                                 window + candidateRevision (never rewritten,
 *                                 E8 §39); deterministic UNIQUE fingerprint
 *                                 (E8 §29); Core-owned bounded lifecycle
 *                                 open → resolving (exactly one resolution
 *                                 Directive) → resolved |
 *                                 verification_blocked (exactly one resolution
 *                                 Report), all DDL-checked.
 *
 * Claims persist STRUCTURALLY inside claims_json (variant/statement/
 * sourceReportIds per claim — E8 §28 permits "separately or structurally");
 * the schema validator proves every source Report is a real same-run/window/
 * revision durable Report.
 *
 * Deliberately NOT created (E8 §2/§45): no replan-transition or ExecutionIssue
 * replanning tables, no ExecutionRun-completion artifacts, no final-verification
 * artifacts, no ExecutionObservation, no policy state machine table (E8 §10 —
 * verification pressure is DERIVED, never persisted), no conflict event ledger
 * (the canonical conflict row carries the full bounded lifecycle).
 */

import type { StoreTx } from "../transaction.js";
import type { StoreMigration } from "./index.js";

export function createVerificationPolicyConflictMigration(): StoreMigration {
  return {
    from: 20,
    to: 21,
    name: "verification-policy-conflict-foundation",
    apply(tx: StoreTx): void {
      // E8 §5/§46 — additive, defaulting, never rewriting historical hashes.
      tx.exec("ALTER TABLE execution_directives ADD COLUMN protocol_version INTEGER NOT NULL DEFAULT 1 CHECK (protocol_version IN (1, 2))");
      tx.exec(
        "ALTER TABLE execution_directives ADD COLUMN verification_requirement TEXT "
        + "CHECK (verification_requirement IS NULL OR verification_requirement IN ('batchable', 'immediate'))",
      );
      tx.exec(
        "ALTER TABLE execution_directives ADD COLUMN verification_purpose TEXT "
        + "CHECK (verification_purpose IS NULL OR verification_purpose IN ('normal', 'conflict_resolution'))",
      );
      tx.exec("ALTER TABLE execution_directives ADD COLUMN verification_conflict_id TEXT");

      tx.exec(`
        CREATE TABLE verification_conflicts (
          conflict_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          window_id TEXT NOT NULL,
          candidate_revision INTEGER NOT NULL CHECK (candidate_revision >= 0),
          fact TEXT NOT NULL CHECK (fact != ''),
          claims_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('open', 'resolving', 'resolved', 'verification_blocked')),
          resolution_directive_id TEXT,
          resolution_directive_revision INTEGER,
          resolution_report_id TEXT,
          fingerprint TEXT NOT NULL UNIQUE,
          rationale TEXT,
          created_at TEXT NOT NULL,
          resolved_at TEXT,
          PRIMARY KEY (conflict_id),
          FOREIGN KEY (run_id) REFERENCES execution_runs(run_id),
          FOREIGN KEY (window_id) REFERENCES verification_windows(id),
          FOREIGN KEY (resolution_directive_id, resolution_directive_revision)
            REFERENCES execution_directives(directive_id, revision),
          FOREIGN KEY (resolution_report_id) REFERENCES execution_reports(report_id),
          CHECK (
            (status = 'open'
              AND resolution_directive_id IS NULL AND resolution_report_id IS NULL AND resolved_at IS NULL)
            OR (status = 'resolving'
              AND resolution_directive_id IS NOT NULL AND resolution_report_id IS NULL AND resolved_at IS NULL)
            OR (status = 'resolved'
              AND resolution_directive_id IS NOT NULL AND resolution_report_id IS NOT NULL
              AND resolved_at IS NOT NULL AND rationale IS NOT NULL AND rationale != '')
            OR (status = 'verification_blocked'
              AND resolution_directive_id IS NOT NULL AND resolution_report_id IS NOT NULL
              AND resolved_at IS NOT NULL AND rationale IS NOT NULL AND rationale != '')
          )
        )
      `);

      // E8 §27/§39 — a conflict's binding (run/window/revision/fact/claims/
      // fingerprint) is immutable; only the Core-owned lifecycle columns move.
      tx.exec(`
        CREATE TRIGGER verification_conflicts_identity_immutable BEFORE UPDATE ON verification_conflicts
        BEGIN
          SELECT RAISE(ABORT, 'verification conflict binding is immutable')
          WHERE OLD.run_id IS NOT NEW.run_id
             OR OLD.window_id IS NOT NEW.window_id
             OR OLD.candidate_revision IS NOT NEW.candidate_revision
             OR OLD.fact IS NOT NEW.fact
             OR OLD.claims_json IS NOT NEW.claims_json
             OR OLD.fingerprint IS NOT NEW.fingerprint
             OR OLD.created_at IS NOT NEW.created_at;
          SELECT RAISE(ABORT, 'verification conflict resolution is immutable once settled')
          WHERE OLD.status IN ('resolved', 'verification_blocked')
            AND NEW.status IS NOT OLD.status;
          SELECT RAISE(ABORT, 'verification conflict resolution directive is immutable once bound')
          WHERE OLD.resolution_directive_id IS NOT NULL
            AND (NEW.resolution_directive_id IS NOT OLD.resolution_directive_id
              OR NEW.resolution_directive_revision IS NOT OLD.resolution_directive_revision);
          SELECT RAISE(ABORT, 'illegal verification conflict status transition')
          WHERE NOT (
            (OLD.status = 'open' AND NEW.status IN ('open', 'resolving'))
            OR (OLD.status = 'resolving' AND NEW.status IN ('resolving', 'resolved', 'verification_blocked'))
            OR (OLD.status = NEW.status)
          );
        END
      `);
      tx.exec(`
        CREATE TRIGGER verification_conflicts_no_delete BEFORE DELETE ON verification_conflicts
        BEGIN SELECT RAISE(ABORT, 'verification_conflicts is immutable'); END
      `);

      tx.exec("CREATE INDEX idx_verification_conflicts_window ON verification_conflicts (window_id, candidate_revision, status)");
    },
  };
}
