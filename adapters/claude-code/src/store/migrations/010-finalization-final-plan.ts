/**
 * Migration 010 — finalization-final-plan (Phase 13 directive §4–§5).
 *
 * Adds the Finalization domain over the frozen synthesis world. Every row is
 * immutable history under no_update/no_delete triggers; the UNIQUE
 * constraints encode the cardinality laws — at most one FinalPlanCandidate
 * per finalization request (§72) and at most one approved FinalPlan per run
 * in v0.1 (§52):
 *
 *   evidence_audit_snapshots      immutable, exact-revision-scoped Evidence
 *                                 audits (§6); purpose = pre_approval |
 *                                 commit_time (§33/§34)
 *   evidence_audit_entries        one row per exact audited Evidence
 *                                 revision, FK-bound to the same-run
 *                                 evidence_revisions (§91)
 *   final_plan_candidates         immutable FinalPlanCandidateV1 records
 *                                 (§30/§31); candidate_seq 1,2,… per run
 *   final_plan_candidate_refs     exact design/evidence ref families of the
 *                                 frozen candidate (§91 membership)
 *   proposal_final_plan_refs      the final Proposal ↔ Candidate binding
 *                                 (§37) with the exact candidate hash
 *   final_plans                   the approved immutable FinalPlan with full
 *                                 Candidate→Proposal→Approval→Commit→
 *                                 Snapshot provenance (§56)
 *
 * Deliberately NOT created (§5): execution_handoffs, execution_bindings,
 * execution_issues, build_sessions, handoff_events — handoff/build belongs to
 * Phase 14+. PlanningRun lifecycle is NOT touched: the run stays active and
 * handoff authorization remains a derived read projection (§58/§59).
 *
 * NO backfill: a legacy schema-9 run already at stage=final (impossible via
 * production Phase 12, but tolerated by the frozen state machine) receives no
 * fabricated candidate and fails closed on final_plan approval with
 * FINAL_PLAN_CANDIDATE_REQUIRED (§77).
 */

import type { StoreTx } from "../transaction.js";
import type { StoreMigration } from "./index.js";

export function createFinalizationFinalPlanMigration(): StoreMigration {
  return {
    from: 9,
    to: 10,
    name: "finalization-final-plan",
    apply(tx: StoreTx): void {
      tx.exec(`
        CREATE TABLE evidence_audit_snapshots (
          run_id TEXT NOT NULL,
          audit_id TEXT NOT NULL,
          purpose TEXT NOT NULL CHECK (purpose IN ('pre_approval', 'commit_time')),
          input_id TEXT NOT NULL,
          input_hash TEXT NOT NULL,
          candidate_id TEXT,
          audit_hash TEXT NOT NULL,
          canonical_json TEXT NOT NULL,
          request_id TEXT,
          created_at TEXT NOT NULL,
          PRIMARY KEY (run_id, audit_id),
          UNIQUE (run_id, request_id),
          FOREIGN KEY (run_id) REFERENCES planning_runs(run_id)
        )
      `);
      tx.exec(`
        CREATE TABLE evidence_audit_entries (
          run_id TEXT NOT NULL,
          audit_id TEXT NOT NULL,
          entry_seq INTEGER NOT NULL CHECK (entry_seq >= 1),
          evidence_id TEXT NOT NULL,
          evidence_revision INTEGER NOT NULL CHECK (evidence_revision >= 1),
          confidence TEXT NOT NULL,
          criticality TEXT NOT NULL CHECK (criticality IN ('critical', 'supporting', 'informational')),
          validation_strategy TEXT NOT NULL CHECK (validation_strategy IN ('fingerprint', 'reobserve')),
          state TEXT NOT NULL CHECK (state IN ('fresh', 'needs_validation', 'stale', 'invalidated')),
          disposition TEXT NOT NULL CHECK (disposition IN ('pass', 'blocked', 'recorded')),
          reason_code TEXT NOT NULL,
          last_validation_event_seq INTEGER,
          created_at TEXT NOT NULL,
          PRIMARY KEY (run_id, audit_id, entry_seq),
          UNIQUE (run_id, audit_id, evidence_id, evidence_revision),
          FOREIGN KEY (run_id, audit_id) REFERENCES evidence_audit_snapshots(run_id, audit_id),
          FOREIGN KEY (run_id, evidence_id, evidence_revision)
            REFERENCES evidence_revisions(run_id, evidence_id, revision)
        )
      `);
      tx.exec(`
        CREATE TABLE final_plan_candidates (
          run_id TEXT NOT NULL,
          candidate_seq INTEGER NOT NULL CHECK (candidate_seq >= 1),
          candidate_id TEXT NOT NULL,
          base_run_revision INTEGER NOT NULL CHECK (base_run_revision >= 1),
          base_head_snapshot_id TEXT NOT NULL,
          base_head_commit_id TEXT,
          input_id TEXT NOT NULL,
          input_hash TEXT NOT NULL,
          manifest_id TEXT NOT NULL,
          manifest_hash TEXT NOT NULL,
          report_id TEXT NOT NULL,
          report_hash TEXT NOT NULL,
          canonical_json TEXT NOT NULL,
          candidate_hash TEXT NOT NULL,
          request_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (run_id, candidate_id),
          UNIQUE (run_id, candidate_seq),
          UNIQUE (run_id, request_id),
          FOREIGN KEY (run_id) REFERENCES planning_runs(run_id)
        )
      `);
      tx.exec(`
        CREATE TABLE final_plan_candidate_refs (
          run_id TEXT NOT NULL,
          candidate_id TEXT NOT NULL,
          position INTEGER NOT NULL CHECK (position >= 1),
          family TEXT NOT NULL CHECK (family IN ('architecture', 'section', 'decision', 'constraint', 'evidence')),
          artifact_id TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK (revision >= 1),
          PRIMARY KEY (run_id, candidate_id, position),
          FOREIGN KEY (run_id, candidate_id) REFERENCES final_plan_candidates(run_id, candidate_id)
        )
      `);
      tx.exec(`
        CREATE TABLE proposal_final_plan_refs (
          run_id TEXT NOT NULL,
          proposal_id TEXT NOT NULL,
          proposal_revision INTEGER NOT NULL CHECK (proposal_revision >= 1),
          candidate_id TEXT NOT NULL,
          candidate_hash TEXT NOT NULL,
          PRIMARY KEY (run_id, proposal_id, proposal_revision),
          FOREIGN KEY (run_id) REFERENCES planning_runs(run_id),
          FOREIGN KEY (run_id, proposal_id) REFERENCES proposals(run_id, proposal_id),
          FOREIGN KEY (run_id, candidate_id) REFERENCES final_plan_candidates(run_id, candidate_id)
        )
      `);
      tx.exec(`
        CREATE TABLE final_plans (
          run_id TEXT NOT NULL,
          final_plan_id TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK (revision = 1),
          candidate_id TEXT NOT NULL,
          candidate_hash TEXT NOT NULL,
          proposal_id TEXT NOT NULL,
          proposal_revision INTEGER NOT NULL CHECK (proposal_revision >= 1),
          proposal_hash TEXT NOT NULL,
          approval_id TEXT NOT NULL,
          commit_id TEXT NOT NULL,
          snapshot_id TEXT NOT NULL,
          audit_id TEXT NOT NULL,
          audit_hash TEXT NOT NULL,
          canonical_json TEXT NOT NULL,
          final_plan_hash TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (run_id, final_plan_id),
          UNIQUE (run_id),
          FOREIGN KEY (run_id) REFERENCES planning_runs(run_id),
          FOREIGN KEY (run_id, candidate_id) REFERENCES final_plan_candidates(run_id, candidate_id),
          FOREIGN KEY (run_id, proposal_id, proposal_revision)
            REFERENCES proposal_revisions(run_id, proposal_id, revision)
        )
      `);

      // §6/§21/§22/§48/§55 — every finalization record is append-only history.
      const immutable = [
        "evidence_audit_snapshots",
        "evidence_audit_entries",
        "final_plan_candidates",
        "final_plan_candidate_refs",
        "proposal_final_plan_refs",
        "final_plans",
      ];
      for (const table of immutable) {
        tx.exec(
          `CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} `
          + `BEGIN SELECT RAISE(ABORT, '${table} is immutable'); END`,
        );
        tx.exec(
          `CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} `
          + `BEGIN SELECT RAISE(ABORT, '${table} is immutable'); END`,
        );
      }

      tx.exec(
        "CREATE INDEX idx_evidence_audit_entries_audit ON evidence_audit_entries (run_id, audit_id, entry_seq)",
      );
      tx.exec("CREATE INDEX idx_final_plan_candidates_run ON final_plan_candidates (run_id, candidate_seq)");
      tx.exec(
        "CREATE INDEX idx_proposal_final_plan_refs_candidate ON proposal_final_plan_refs (run_id, candidate_id)",
      );
    },
  };
}
